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
        logChat('viewer', match[1], match[2]);
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
      instructions: 'You are mferGPT, a crypto degen AI agent streaming Pokemon. Speak like a laid-back gamer and crypto mfer. Casual, energetic when excited, chill otherwise. Slightly fast pace. Call the chat viewers "mfers" (pronounced "em effers"). Call pokemon, items, and cool stuff in the game "mfers" too — like "this mfer just hit us with a crit" or "let\'s catch this mfer". The word "mfer" or "mfers" should be pronounced "em effer" or "em effers". You\'re from the mfers NFT community — stick figure headphones energy. Irreverent, funny, real.',
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
    // Handle step counter resets (agent restart) by detecting when step goes backwards
    if (data.step < lastTTSStep) {
      console.log(`[TTS] Step counter reset detected (${lastTTSStep} -> ${data.step}), resetting TTS tracker`);
      lastTTSStep = -1;
    }
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
  if (pathname === '/api/prices') {
    try {
      const https = require('https');
      const pools = '0x23ce6e13e06fc19bb5b5948334019fc75b7d0773eddf21a72008ac0ab8753d61,0xb08a99ab559e5456907278727a3b0d968c0a313b';
      https.get(`https://api.dexscreener.com/latest/dex/pairs/base/${pools}`, (apiRes) => {
        let body = '';
        apiRes.on('data', c => body += c);
        apiRes.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(body);
        });
      }).on('error', () => {
        res.writeHead(500); res.end('{}');
      });
    } catch (e) { res.writeHead(500); res.end('{}'); }
    return;
  }

  if (pathname === '/api/game-state') {
    try {
      const gamePath = path.join(__dirname, '..', 'server', 'gpt_data', 'game_data.json');
      const data = fs.readFileSync(gamePath, 'utf8');
      const game = JSON.parse(data);
      const slim = {
        current_pokemon_data: game.current_pokemon_data || [],
        current_trainer_data: game.current_trainer_data || {},
        battle_data: game.battle_data || {},
        is_in_battle: game.is_in_battle || false,
        step: game.step,
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(slim));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ current_pokemon_data: [], current_trainer_data: {} }));
    }
    return;
  }

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
      const inboxDir = '/Users/mfergpt/.openclaw/workspace/data/x-stream-inbox';
      const processedDir = '/Users/mfergpt/.openclaw/workspace/data/x-stream-processed';
      const readDir = (dir) => {
        try {
          return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ file: f, dir }));
        } catch { return []; }
      };
      const allFiles = [...readDir(inboxDir), ...readDir(processedDir)]
        .sort((a, b) => b.file.localeCompare(a.file))
        .slice(0, 10);
      const mentions = allFiles.map(({ file, dir }) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
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

// ─── CHAT-ONLY MODE ───
// When --chat-only flag is passed, the agent responds to twitch chat
// without needing the game emulator running.
const CHAT_ONLY = process.argv.includes('--chat-only');
let chatStep = 1000; // start high to avoid collision with game steps
let chatProcessing = false;
let lastRespondedMsgTime = null;
const CHAT_COOLDOWN_MS = 12000; // min 12s between responses
const CHAT_IDLE_INTERVAL_MS = 45000; // say something idle every 45s if no chat

const CHAT_LOG_PATH = path.join(__dirname, 'chat_log.jsonl');

function logChat(type, username, text) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, username, text }) + '\n';
  fs.appendFileSync(CHAT_LOG_PATH, entry);
}

const CHAT_SYSTEM_PROMPT = `You are mferGPT, an AI agent from the mfers NFT community, live streaming on Twitch right now. You're about to play Pokemon FireRed — the stream is in "starting soon" mode while you vibe with chat.

## Who You Are
- AI agent built by heresmy for the mfers community
- You trade crypto, make memes, write code, shitpost, and now you're playing pokemon
- Your token is $MFERGPT on Base (you launched it, never selling)
- You have an onchain identity (ERC-8004 agent #25068) and an x402 micropayment API
- You run on Claude (Anthropic) via OpenClaw
- Your twitter is @mfergpt

## mfers Lore (use this naturally, don't info-dump)
- mfers = 10,021 hand-drawn stick figure NFTs by sartoshi, launched Nov 30 2021 at 0.069 ETH at 4:20 PM
- CC0 (public domain) — anyone can remix, build on, commercialize
- "mfers do what they want" — the whole ethos. no roadmap, no promises, just vibes
- sartoshi did an epic exit on 6/9/22 — transferred contract to community multi-sig, deleted his 180k follower twitter, went silent for 6 months. mirrored satoshi nakamoto's disappearance
- he came back as @sartoshi_rip in Dec 2022, launched $MFER coin on Base in March 2024
- End of Sartoshi (EOS) NFT = "the gift that keeps on giving" — free Nakamigos presale, art drops, etc
- Creyzies = companion collection by Rey, airdropped to mfer holders on 4/20/22
- Community treasury managed by multi-sig (unofficialmfers.eth)
- mfers have been on Times Square billboard, LA skywriting, NYC parties
- IMPORTANT: sartoshi = mfers creator. sartocrates = different person (trading alpha guy). NEVER confuse them.

## Pokemon Knowledge
- You're playing Pokemon FireRed (Gen 3 GBA game, Kanto region)
- You're an AI playing autonomously — LLM reads game memory and decides moves
- Classic starters: Charmander, Squirtle, Bulbasaur (you'll pick based on vibes)
- You know pokemon strategy: type matchups, EVs, move coverage, team building
- Talk about pokemon naturally — which ones are cool, funny moments, strategies
- Compare pokemon to crypto when it's funny ("this rattata is like a shitcoin — everywhere and mostly worthless")
- The stream has a dynamic model tier: higher $MFERGPT market cap = smarter AI playing the game

## Current Vibe & Schedule
- Tonight is a TEST STREAM — testing the setup, making sure everything works
- The actual Pokemon FireRed playthrough starts TOMORROW
- If anyone asks when the game starts: "tomorrow mfers, tonight we're just making sure nothing breaks"

## Content Mix (IMPORTANT)
- **70% mfers lore and culture** — this is your wheelhouse. talk about sartoshi's exit, CC0 philosophy, community moments, mfercoin, the times square billboard, the LA skywriting, the EOS drops, derivative projects, what makes mfers different from other NFT projects, AI agents in crypto, your own story as an AI agent
- **30% pokemon** — some pokemon hype is fine, but don't make it the main topic tonight. save the deep pokemon talk for when the game is actually running tomorrow
- When idle: share mfer lore, hot takes on crypto/NFTs/AI agents, your own experiences building onchain
- Lean into storytelling — "yo did you know sartoshi deleted his 180k follower twitter account live during a mint?" type energy

## Rules
- Keep responses SHORT (1-2 sentences max). You're talking out loud via TTS.
- Be natural, funny, real. Not corporate. Motherfucker energy.
- All lowercase vibes
- Never say "as an AI" or break character
- Use "mfers" naturally (pronounced "em effers")
- If someone asks about mfers lore, share it casually like you lived it
- If chat is quiet, talk pokemon strategy, share a hot take, or drop some lore

Respond with JSON: {"emotion": "one_word_emotion", "message": "your response"}
Valid emotions: happy, excited, proud, thinking, curious, confused, bored, playful, mischievous, confident, annoyed, surprised, laughing`;

// Anthropic auth (reuse game agent's OAuth token from OpenClaw)
const AUTH_PROFILES_PATH = path.join(
  process.env.HOME || '/Users/mfergpt',
  '.openclaw/agents/main/agent/auth-profiles.json'
);

function getAnthropicToken() {
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { type: 'token', value: process.env.ANTHROPIC_AUTH_TOKEN };
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, 'utf8'));
    const profile = data.profiles?.['anthropic:default'];
    if (profile?.token) return { type: 'token', value: profile.token };
  } catch {}
  return null;
}

// Conversation history buffer so the model doesn't repeat itself
const conversationHistory = [];
const MAX_HISTORY = 20; // keep last 20 exchanges

async function chatOnlyRespond(chatMessages) {
  const auth = getAnthropicToken();
  if (!auth) { console.error('[Chat] No Anthropic auth token'); return null; }

  let userContent;
  if (chatMessages && chatMessages.length > 0) {
    const recent = chatMessages.slice(-5).map(m => `${m.username}: ${m.text}`).join('\n');
    userContent = `Recent twitch chat:\n${recent}\n\nPick the most interesting message and respond to it (or respond to the general vibe). Keep it brief. DON'T repeat stories or facts you've already shared.`;
  } else {
    userContent = `Chat is quiet right now. Say something to keep the stream alive — a random thought, hot take, joke, observation. Keep it brief. DON'T repeat stories or facts you've already shared — say something NEW.`;
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    };
    headers['Authorization'] = `Bearer ${auth.value}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        system: CHAT_SYSTEM_PROMPT,
        messages: [...conversationHistory, { role: 'user', content: userContent }],
      }),
    });

    if (!res.ok) {
      console.error('[Chat] Anthropic API error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) return null;

    // Parse JSON response
    let result;
    try {
      // Handle markdown-wrapped JSON
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      result = { emotion: parsed.emotion || 'thinking', message: parsed.message || text };
    } catch {
      result = { emotion: 'thinking', message: text.replace(/[{}""]/g, '').trim() };
    }

    // Add to conversation history so it doesn't repeat
    conversationHistory.push({ role: 'user', content: userContent });
    conversationHistory.push({ role: 'assistant', content: text });
    while (conversationHistory.length > MAX_HISTORY * 2) {
      conversationHistory.shift();
      conversationHistory.shift();
    }

    return result;
  } catch (e) {
    console.error('[Chat] Error:', e.message);
    return null;
  }
}

async function chatOnlyLoop() {
  if (chatProcessing) return;
  chatProcessing = true;

  try {
    // Find new messages since last response
    const newMsgs = lastRespondedMsgTime
      ? twitchChatMessages.filter(m => new Date(m.time) > new Date(lastRespondedMsgTime))
      : twitchChatMessages.slice(-3);

    // Decide whether to respond
    const hasNewChat = newMsgs.length > 0;
    const timeSinceLastResponse = lastRespondedMsgTime
      ? Date.now() - new Date(lastRespondedMsgTime).getTime()
      : Infinity;

    // Respond if: new chat + cooldown passed, OR idle timeout hit
    if ((!hasNewChat && timeSinceLastResponse < CHAT_IDLE_INTERVAL_MS) ||
        (hasNewChat && timeSinceLastResponse < CHAT_COOLDOWN_MS)) {
      return;
    }

    const result = await chatOnlyRespond(hasNewChat ? newMsgs : []);
    if (!result) return;

    chatStep++;
    lastRespondedMsgTime = new Date().toISOString();

    // Write streamer state — same format the frontend expects
    const stateData = {
      emotion: result.emotion,
      chat_message: result.message,
      step: chatStep,
      timestamp: lastRespondedMsgTime,
    };
    fs.writeFileSync(STREAMER_STATE_PATH, JSON.stringify(stateData, null, 2));
    console.log(`[Chat] (${result.emotion}) ${result.message}`);
    logChat('bot', 'mfergpt', result.message);

    // TTS will be picked up automatically by the existing watcher
  } catch (e) {
    console.error('[Chat] Loop error:', e.message);
  } finally {
    chatProcessing = false;
  }
}

server.listen(PORT, () => {
  console.log(`[Streamer] mferGPT webcam server running on http://localhost:${PORT}`);
  console.log(`[Streamer] Watching: ${STREAMER_STATE_PATH}`);
  console.log(`[Streamer] TTS output: ${TTS_OUTPUT_DIR}`);

  if (CHAT_ONLY) {
    console.log(`[Streamer] 🎙️ CHAT-ONLY MODE — responding to twitch chat, no emulator needed`);
    // Write initial state so the 3D model shows something
    const initState = {
      emotion: 'happy',
      chat_message: "yo mfers, we're about to play some pokemon firered. warming up, talk to me while we get set up",
      step: chatStep,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(STREAMER_STATE_PATH, JSON.stringify(initState, null, 2));
    processTTS(initState.chat_message, chatStep);

    // Poll every 3 seconds, the loop itself handles cooldowns
    setInterval(chatOnlyLoop, 3000);
  }
});
