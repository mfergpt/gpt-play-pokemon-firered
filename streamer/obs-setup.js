#!/usr/bin/env node
/**
 * OBS Scene Setup for mferGPT Plays Pokemon
 * 
 * Creates the streaming scene layout via obs-websocket.
 * OBS must be running with websocket enabled (port 4455).
 * 
 * Layout (1920x1080):
 * - Browser source: stream dashboard (http://localhost:9886) — full screen
 *   The dashboard already has all panels laid out:
 *   - Emulator placeholder (left) — we overlay the actual mGBA window capture
 *   - Stats (center)
 *   - 3D webcam (right, embedded iframe)
 *   - Charts (bottom left/center)
 *   - Log (bottom right)
 * 
 * - Window capture: mGBA emulator — positioned over the emulator placeholder area
 * - Audio: desktop audio for TTS from the browser source
 */

const OBSWebSocket = require('obs-websocket-js').default;

const obs = new OBSWebSocket();

const OBS_WS = 'ws://localhost:4455';
const OBS_PASSWORD = '';

async function setup() {
  try {
    await obs.connect(OBS_WS, OBS_PASSWORD || undefined);
    console.log('Connected to OBS WebSocket');
  } catch (e) {
    console.error('Failed to connect to OBS. Make sure OBS is running.');
    console.error('Enable WebSocket: Tools → WebSocket Server Settings → Enable');
    console.error('Error:', e.message);
    process.exit(1);
  }

  const SCENE_NAME = 'mferGPT Plays Pokemon';

  // Create scene
  try {
    await obs.call('CreateScene', { sceneName: SCENE_NAME });
    console.log(`Created scene: ${SCENE_NAME}`);
  } catch (e) {
    if (e.message?.includes('already exists') || e.code === 601) {
      console.log(`Scene "${SCENE_NAME}" already exists, updating...`);
    } else {
      console.log('Scene may already exist:', e.message);
    }
  }

  // Set as current scene
  await obs.call('SetCurrentProgramScene', { sceneName: SCENE_NAME });

  // 1. Browser source — full dashboard (background layer)
  try {
    await obs.call('CreateInput', {
      sceneName: SCENE_NAME,
      inputName: 'Stream Dashboard',
      inputKind: 'browser_source',
      inputSettings: {
        url: 'http://localhost:9886',
        width: 1920,
        height: 1080,
        fps: 30,
        reroute_audio: true, // Route audio through OBS for TTS
      },
    });
    console.log('Added: Stream Dashboard (browser source)');
  } catch (e) {
    console.log('Stream Dashboard source may already exist:', e.message);
  }

  // 2. Window capture — mGBA emulator (overlay on left panel)
  try {
    await obs.call('CreateInput', {
      sceneName: SCENE_NAME,
      inputName: 'mGBA Game',
      inputKind: 'window_capture',
      inputSettings: {
        owner_name: 'mGBA',
        window_name: '', // Will capture any mGBA window
      },
    });
    console.log('Added: mGBA Game (window capture)');
  } catch (e) {
    console.log('mGBA source may already exist:', e.message);
  }

  // Position mGBA window capture over the emulator placeholder (left panel: 0,70 to 640,690)
  // The game is 240x160, we want to scale it to fill 640x620 area
  try {
    const sceneItemId = await getSceneItemId(SCENE_NAME, 'mGBA Game');
    if (sceneItemId !== null) {
      await obs.call('SetSceneItemTransform', {
        sceneName: SCENE_NAME,
        sceneItemId,
        sceneItemTransform: {
          positionX: 0,
          positionY: 70,
          boundsType: 'OBS_BOUNDS_SCALE_INNER',
          boundsWidth: 640,
          boundsHeight: 620,
          boundsAlignment: 0,
        },
      });
      console.log('Positioned mGBA capture over emulator panel');
    }
  } catch (e) {
    console.log('Failed to position mGBA:', e.message);
  }

  // 3. Audio output capture for system audio (TTS plays through browser)
  try {
    await obs.call('CreateInput', {
      sceneName: SCENE_NAME,
      inputName: 'TTS Audio',
      inputKind: 'coreaudio_output_capture',
      inputSettings: {},
    });
    console.log('Added: TTS Audio (desktop audio capture)');
  } catch (e) {
    console.log('TTS Audio source may already exist:', e.message);
  }

  console.log('\n=== Setup Complete ===');
  console.log('Scene: ' + SCENE_NAME);
  console.log('');
  console.log('Manual steps:');
  console.log('1. Check mGBA window capture is picking up the right window');
  console.log('2. If not, right-click "mGBA Game" source → Properties → select mGBA window');
  console.log('3. Adjust mGBA position/size if needed (should be left panel, 640x620)');
  console.log('4. Test TTS audio levels');
  console.log('5. Set up stream keys: Settings → Stream');
  console.log('');
  console.log('For dual streaming (X + Twitch):');
  console.log('  - Install "Multiple RTMP Outputs" plugin or use Aitum Multistream');
  console.log('  - Add both RTMP URLs in the plugin settings');

  await obs.disconnect();
}

async function getSceneItemId(sceneName, sourceName) {
  try {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
    const item = sceneItems.find(i => i.sourceName === sourceName);
    return item ? item.sceneItemId : null;
  } catch (e) {
    return null;
  }
}

setup().catch(e => {
  console.error('Setup failed:', e);
  process.exit(1);
});
