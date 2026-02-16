/**
 * Local pathfinding — runs the existing Python A* pathfinder directly
 * instead of using OpenAI Code Interpreter containers.
 * Used when USE_ANTHROPIC=1 (or as fallback).
 */

const { execFile } = require("child_process");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { config } = require("../config");
const { fetchGameData } = require("../services/pythonService");
const { broadcast } = require("../core/socketHub");
const { setIsThinking } = require("../state/stateManager");

const PYTHON_SCRIPT = path.join(__dirname, "..", "..", "tmp", "temp_full_working_code.py");
const TEMP_DIR = path.join(__dirname, "..", "..", "tmp");

/**
 * Run pathfinding locally using the existing Python A* code.
 * @param {number} targetX - Target X coordinate
 * @param {number} targetY - Target Y coordinate
 * @param {string} mapId - Target map ID
 * @param {string} explanation - Movement explanation
 * @returns {Promise<{keys: string[], explanation: string}>}
 */
async function findPathLocal(targetX, targetY, mapId, explanation) {
  const gameDataJson = await fetchGameData();
  const { current_trainer_data } = gameDataJson;
  const { position } = current_trainer_data;

  if (position.map_id !== mapId) {
    throw new Error(`Player is not on map ${mapId}. Current map: ${position.map_id}`);
  }
  if (gameDataJson.is_talking_to_npc) {
    throw new Error("Player is in a dialogue. Cannot find path.");
  }

  // Check if python pathfinder exists
  if (!fsSync.existsSync(PYTHON_SCRIPT)) {
    throw new Error("Local pathfinding script not found. Falling back to simple movement.");
  }

  // Write grid to temp file
  const gridPath = path.join(TEMP_DIR, "temp_map_grid.json");
  await fs.writeFile(gridPath, JSON.stringify(gameDataJson.minimap_data.grid, null, 2));

  const startX = position.x;
  const startY = position.y;
  const strength = gameDataJson.strength_enabled ? "True" : "False";
  const movementMode = gameDataJson.player_movement_mode || "WALK";

  // Create a runner script that imports and calls plan_path
  const runnerScript = `
import json, sys, importlib.util

spec = importlib.util.spec_from_file_location("pf", ${JSON.stringify(PYTHON_SCRIPT)})
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)

keys, meta = pf.plan_path(
    grid_path=${JSON.stringify(gridPath)},
    start=(${startX}, ${startY}),
    goal=(${targetX}, ${targetY}),
    strength=${strength},
    movement_mode="${movementMode}",
)

result = {
    "keys": keys if keys else [],
    "explanation": f"Path from ({${startX}},{${startY}}) to ({${targetX}},{${targetY}}). {meta.get('note', '') if isinstance(meta, dict) else ''}",
    "updated_code_path": ""
}
print(json.dumps(result))
`;

  const runnerPath = path.join(TEMP_DIR, "temp_pathfind_runner.py");
  await fs.writeFile(runnerPath, runnerScript);

  setIsThinking(true);
  broadcast({ type: "reasoning_chunk", payload: "\n[Local pathfinding...]\n" });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Local pathfinding timed out (30s)"));
    }, 30000);

    execFile("python3", [runnerPath], { timeout: 30000 }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      setIsThinking(false);

      if (error) {
        console.error("[LocalPathfinding] Error:", error.message);
        console.error("[LocalPathfinding] Stderr:", stderr);
        reject(new Error(`Local pathfinding failed: ${error.message}`));
        return;
      }

      try {
        // Find the last line that looks like JSON
        const lines = stdout.trim().split("\n");
        let result = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            result = JSON.parse(lines[i]);
            break;
          } catch (_) {}
        }
        if (!result) throw new Error("No JSON output from pathfinder");

        console.log(`[LocalPathfinding] Found path with ${result.keys?.length || 0} steps`);
        broadcast({
          type: "reasoning_chunk",
          payload: `[Path found: ${result.keys?.length || 0} steps]\n`,
        });
        resolve(result);
      } catch (parseErr) {
        console.error("[LocalPathfinding] Parse error:", parseErr.message);
        console.error("[LocalPathfinding] Stdout:", stdout);
        reject(new Error(`Failed to parse pathfinding result: ${parseErr.message}`));
      }
    });
  });
}

module.exports = { findPathLocal };
