#!/bin/bash
cd "$(dirname "$0")/streamer"
export OPENAI_API_KEY=$(grep OPENAI_API_KEY "$(dirname "$0")/server/.env" | cut -d= -f2)

while true; do
  echo "[$(date)] Starting streamer..."
  node server.js
  echo "[$(date)] Streamer exited. Restarting in 3s..."
  sleep 3
done
