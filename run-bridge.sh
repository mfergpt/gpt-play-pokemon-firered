#!/bin/bash
cd "$(dirname "$0")"
source .venv/bin/activate

while true; do
  echo "[$(date)] Starting bridge..."
  python firered_mgba_bridge.py
  echo "[$(date)] Bridge exited. Restarting in 3s..."
  sleep 3
done
