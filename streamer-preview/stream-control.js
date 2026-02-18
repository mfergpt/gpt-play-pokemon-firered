#!/usr/bin/env node
/**
 * mferGPT Stream Controller
 * 
 * Manages dual streaming to Twitch (primary via OBS) + X (via ffmpeg re-stream).
 * 
 * Usage:
 *   node stream-control.js start    - Start streaming to both
 *   node stream-control.js stop     - Stop all streams
 *   node stream-control.js status   - Check stream status
 *   node stream-control.js twitch   - Start Twitch only
 *   node stream-control.js x        - Start X only
 */

const OBSWebSocket = require('obs-websocket-js').default;
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const obs = new OBSWebSocket();

// Load stream keys
const keysPath = path.join(__dirname, '.stream-keys');
const keys = {};
if (fs.existsSync(keysPath)) {
  fs.readFileSync(keysPath, 'utf8').split('\n').forEach(line => {
    const [k, v] = line.split('=');
    if (k && v) keys[k.trim()] = v.trim();
  });
}

let xStreamProcess = null;

async function connectOBS() {
  try {
    await obs.connect('ws://localhost:4455');
    return true;
  } catch (e) {
    console.error('Cannot connect to OBS. Is it running?');
    return false;
  }
}

async function startTwitch() {
  if (!await connectOBS()) return false;
  
  // Ensure Twitch is configured
  await obs.call('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: {
      server: keys.TWITCH_RTMP || 'rtmp://live.twitch.tv/app',
      key: keys.TWITCH_KEY,
    },
  });
  
  // Start streaming
  try {
    await obs.call('StartStream');
    console.log('✅ Twitch stream started');
  } catch (e) {
    if (e.message?.includes('already active')) {
      console.log('✅ Twitch stream already running');
    } else {
      console.error('❌ Twitch start failed:', e.message);
      return false;
    }
  }
  
  await obs.disconnect();
  return true;
}

async function startX() {
  // X streaming via ffmpeg — capture OBS virtual camera or use a relay
  // Simplest: use ffmpeg to re-stream from a local FLV recording
  // Better: OBS records to pipe, ffmpeg sends to X
  // Cleanest for now: ffmpeg screen capture of OBS preview → X RTMP
  
  if (xStreamProcess) {
    console.log('✅ X stream already running');
    return true;
  }

  const xUrl = `${keys.X_RTMP}/${keys.X_KEY}`;
  
  // Use ffmpeg to capture the screen and stream to X
  // On macOS, use avfoundation to capture the OBS output window
  // Alternative: OBS Start Recording to a pipe, then ffmpeg to X
  
  // Cleanest approach: use OBS's "Start Recording" to output FLV to stdout,
  // pipe to ffmpeg which sends to X RTMP
  
  // Actually simplest: just use ffmpeg to read from screen capture
  console.log('Starting X stream via ffmpeg...');
  
  xStreamProcess = spawn('ffmpeg', [
    '-f', 'avfoundation',
    '-framerate', '30',
    '-capture_cursor', '0',
    '-i', '1:0',  // Screen 1, audio device 0 (may need adjustment)
    '-vf', 'scale=1920:1080',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '3000k',
    '-maxrate', '3000k',
    '-bufsize', '6000k',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    xUrl,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  xStreamProcess.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line.includes('frame=') || line.includes('speed=')) {
      // Normal progress, ignore
    } else {
      console.log('[X ffmpeg]', line);
    }
  });

  xStreamProcess.on('exit', (code) => {
    console.log(`[X stream] exited with code ${code}`);
    xStreamProcess = null;
  });

  // Save PID for later cleanup
  fs.writeFileSync('/tmp/x-stream.pid', String(xStreamProcess.pid));
  console.log(`✅ X stream started (pid: ${xStreamProcess.pid})`);
  return true;
}

async function stopTwitch() {
  if (!await connectOBS()) return;
  try {
    await obs.call('StopStream');
    console.log('⏹ Twitch stream stopped');
  } catch (e) {
    console.log('Twitch stream was not active');
  }
  await obs.disconnect();
}

async function stopX() {
  // Kill ffmpeg process
  if (xStreamProcess) {
    xStreamProcess.kill('SIGTERM');
    xStreamProcess = null;
    console.log('⏹ X stream stopped');
  } else {
    // Try killing by PID file
    try {
      const pid = fs.readFileSync('/tmp/x-stream.pid', 'utf8').trim();
      process.kill(Number(pid), 'SIGTERM');
      console.log('⏹ X stream stopped (from pid file)');
    } catch (e) {
      console.log('X stream was not active');
    }
  }
}

async function status() {
  if (!await connectOBS()) return;
  
  const streamStatus = await obs.call('GetStreamStatus');
  console.log('Twitch:', streamStatus.outputActive ? '🟢 LIVE' : '⚪ offline');
  console.log('  Duration:', streamStatus.outputTimecode || 'n/a');
  
  const xPid = (() => {
    try { return fs.readFileSync('/tmp/x-stream.pid', 'utf8').trim(); } catch { return null; }
  })();
  
  if (xPid) {
    try {
      process.kill(Number(xPid), 0); // Check if alive
      console.log('X:      🟢 LIVE (pid:', xPid + ')');
    } catch {
      console.log('X:      ⚪ offline');
    }
  } else {
    console.log('X:      ⚪ offline');
  }
  
  await obs.disconnect();
}

async function main() {
  const cmd = process.argv[2] || 'status';
  
  switch (cmd) {
    case 'start':
      console.log('🎬 Starting dual stream...\n');
      await startTwitch();
      await startX();
      console.log('\n🔴 LIVE on Twitch + X');
      break;
    case 'stop':
      console.log('Stopping streams...\n');
      await stopTwitch();
      await stopX();
      console.log('\n⏹ All streams stopped');
      break;
    case 'twitch':
      await startTwitch();
      break;
    case 'x':
      await startX();
      break;
    case 'status':
      await status();
      break;
    default:
      console.log('Usage: node stream-control.js [start|stop|status|twitch|x]');
  }
}

main().catch(console.error);
