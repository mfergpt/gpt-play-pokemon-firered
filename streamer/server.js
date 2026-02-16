#!/usr/bin/env node
/**
 * mferGPT Streamer Webcam Server
 * 
 * Serves the 3D webcam scene, proxies streamer state from the game agent,
 * and runs TTS on chat messages.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 9886;
const STREAMER_STATE_PATH = path.join(__dirname, '..', 'server', 'streamer_state.json');
const MODELS_DIR = '/Users/mfergpt/.openclaw/workspace/builds/mfer-scenes/models';
const ANIMATIONS_DIR = path.join(MODELS_DIR, 'animations');
const TTS_OUTPUT_DIR = path.join(__dirname, 'tts_output');
const STATIC_DIR = __dirname;

// Ensure TTS output dir exists
if (!fs.existsSync(TTS_OUTPUT_DIR)) fs.mkdirSync(TTS_OUTPUT_DIR, { recursive: true });

// TTS queue
let ttsQueue = [];
let ttsProcessing = false;
let lastTTSStep = -1;
let currentAudioFile = null;

// Twitch IRC chat listener
let twitchChatMessages = [];
const MAX_TWITCH_MSGS = 20;
const TWITCH_CHANNEL = 'mfergpt'; // change to your twitch username

function connectTwitch() {
  const net = require('net');
  const client = new net.Socket();
  client.connect(6667, 'irc.chat.twitch.tv', () => {
    client.write('PASS SCHMOOPIIE\r\n'); // anonymous read-only
    client.write('NICK justinfan12345\r\n'); // anonymous username
    client.write(`JOIN #${TWITCH_CHANNEL}\r\n`);
    console.log(`[Twitch] Connected to #${TWITCH_CHANNEL} (read-only)`);
  });
  client.on('data', (data) => {
    const lines = data.toString().split('\r\n');
    for (const line of lines) {
      if (line.startsWith('PING')) {
        client.write('PONG :tmi.twitch.tv\r\n');
        continue;
      }
      const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)/);
      if (match) {
        twitchChatMessages.push({ username: match[1], text: match[2], time: new Date().toISOString() });
        if (twitchChatMessages.length > MAX_TWITCH_MSGS) twitchChatMessages.shift();
      }
    }
  });
  client.on('error', (e) => console.log('[Twitch] Error:', e.message));
  client.on('close', () => { console.log('[Twitch] Disconnected, reconnecting in 5s...'); setTimeout(connectTwitch, 5000); });
}
connectTwitch();

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

async function processTTS(text, step) {
  if (!text || text.length < 5) return null;
  
  const outFile = path.join(TTS_OUTPUT_DIR, `step_${step}.mp3`);
  
  // Use OpenAI TTS
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('[TTS] No OPENAI_API_KEY, skipping TTS');
    return null;
  }
  
  try {
    const body = JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: 'ash',
      instructions: 'Speak like a laid-back gamer streaming. Casual, energetic when excited, chill otherwise. Slightly fast pace.',
      response_format: 'mp3',
    });
    
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    
    if (!res.ok) {
      console.error('[TTS] API error:', res.status, await res.text());
      return null;
    }
    
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(outFile, buffer);
    console.log(`[TTS] Generated: ${outFile} (${buffer.length} bytes)`);
    currentAudioFile = `step_${step}.mp3`;
    return outFile;
  } catch (e) {
    console.error('[TTS] Error:', e.message);
    return null;
  }
}

// Watch streamer state and queue TTS
let lastMtime = 0;
setInterval(() => {
  try {
    const stat = fs.statSync(STREAMER_STATE_PATH);
    if (stat.mtimeMs <= lastMtime) return;
    lastMtime = stat.mtimeMs;
    
    const data = JSON.parse(fs.readFileSync(STREAMER_STATE_PATH, 'utf8'));
    if (data.step > lastTTSStep && data.chat_message) {
      lastTTSStep = data.step;
      processTTS(data.chat_message, data.step);
    }
  } catch (_) {}
}, 1500);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  
  // API: streamer state
  if (pathname === '/api/streamer-state') {
    try {
      const data = fs.readFileSync(STREAMER_STATE_PATH, 'utf8');
      const state = JSON.parse(data);
      state.current_audio = currentAudioFile;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(state));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ emotion: 'thinking', chat_message: '', step: 0 }));
    }
    return;
  }
  
  // API: current TTS audio
  if (pathname === '/api/current-audio') {
    if (!currentAudioFile) {
      res.writeHead(404);
      res.end();
      return;
    }
    const audioPath = path.join(TTS_OUTPUT_DIR, currentAudioFile);
    if (!fs.existsSync(audioPath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const audioData = fs.readFileSync(audioPath);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audioData.length });
    res.end(audioData);
    return;
  }
  
  // Serve TTS audio files
  if (pathname.startsWith('/tts/')) {
    const filePath = path.join(TTS_OUTPUT_DIR, pathname.slice(5));
    return serveFile(filePath, res);
  }
  
  // Serve animations
  if (pathname.startsWith('/animations/')) {
    const filePath = path.join(ANIMATIONS_DIR, decodeURIComponent(pathname.slice(12)));
    return serveFile(filePath, res);
  }
  
  // Serve model
  if (pathname.startsWith('/models/')) {
    const filePath = path.join(MODELS_DIR, decodeURIComponent(pathname.slice(8)));
    return serveFile(filePath, res);
  }
  
    // API: recent twitter mentions
  if (pathname === '/api/mentions') {
    try {
      const mentionsDir = '/Users/mfergpt/.openclaw/workspace/data/x-stream-processed';
      const files = fs.readdirSync(mentionsDir)
        .filter(f => f.endsWith('.json'))
        .sort().reverse().slice(0, 10);
      const mentions = files.map(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(mentionsDir, f), 'utf8'));
          return {
            username: d.author?.username || 'anon',
            text: (d.text || '').replace(/@mferGPT\s*/gi, '').trim().slice(0, 120),
            time: d.created_at
          };
        } catch { return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(mentions));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // API: twitch chat messages
  if (pathname === '/api/twitch-chat') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(twitchChatMessages));
    return;
  }

  // Webcam route (for iframe embed)
  if (pathname === '/webcam') {
    const data = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
    return;
  }

  // Serve static files
  let filePath = pathname === '/' ? '/stream.html' : pathname;
  filePath = path.join(STATIC_DIR, filePath);
  serveFile(filePath, res);
});

function serveFile(filePath, res) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
  res.end(data);
}

server.listen(PORT, () => {
  console.log(`[Streamer] mferGPT webcam server running on http://localhost:${PORT}`);
  console.log(`[Streamer] Watching: ${STREAMER_STATE_PATH}`);
  console.log(`[Streamer] TTS output: ${TTS_OUTPUT_DIR}`);
});
