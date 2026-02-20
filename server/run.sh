#!/bin/bash
# Auto-restart wrapper for the game agent
cd "$(dirname "$0")"

while true; do
  echo "[$(date)] Starting agent..."
  node index.js
  EXIT_CODE=$?
  echo "[$(date)] Agent exited with code $EXIT_CODE. Restarting in 3s..."
  # Kill stale process on port if needed
  /usr/sbin/lsof -ti :9885 | xargs kill -9 2>/dev/null
  sleep 3
done
