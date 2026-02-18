#!/bin/bash
# Pokemon game watchdog - checks every 60s if the game is stalled
# If game_data.json hasn't been updated in 5 minutes, restart the server
# If streamer isn't running, restart it

GAME_DATA="/Users/mfergpt/dev/gpt-play-pokemon-firered/server/gpt_data/game_data.json"
SERVER_DIR="/Users/mfergpt/dev/gpt-play-pokemon-firered/server"
STREAMER_DIR="/Users/mfergpt/dev/gpt-play-pokemon-firered/streamer"
STALE_SECONDS=600  # 10 minutes (summaries can take 5-8 min)

while true; do
    # --- Check game server ---
    if [ -f "$GAME_DATA" ]; then
        LAST_MOD=$(stat -f "%m" "$GAME_DATA" 2>/dev/null)
        NOW=$(date +%s)
        AGE=$(( NOW - LAST_MOD ))

        if [ "$AGE" -gt "$STALE_SECONDS" ]; then
            echo "[$(date)] WATCHDOG: game_data.json is ${AGE}s old (>${STALE_SECONDS}s). Restarting server..."
            
            # Kill existing server
            SERVER_PID=$(/usr/sbin/lsof -ti :9885 2>/dev/null | head -1)
            if [ -n "$SERVER_PID" ]; then
                # Kill the run.sh parent too
                PARENT=$(ps -o ppid= -p "$SERVER_PID" 2>/dev/null | tr -d ' ')
                kill "$SERVER_PID" 2>/dev/null
                [ -n "$PARENT" ] && [ "$PARENT" != "1" ] && kill "$PARENT" 2>/dev/null
                sleep 2
            fi
            
            # Clear history to prevent immediate re-stall
            echo '[]' > "$SERVER_DIR/gpt_data/history.json"
            python3 -c "
import json
c = json.load(open('$SERVER_DIR/gpt_data/counters.json'))
c['lastSummaryStep'] = c['currentStep']  # Don't force summary on restart
json.dump(c, open('$SERVER_DIR/gpt_data/counters.json','w'), indent=2)
"
            echo "[$(date)] WATCHDOG: History cleared, counters reset."
            
            # Wait for port to free
            sleep 3
            
            # Restart
            cd "$SERVER_DIR" && nohup bash run.sh > /tmp/pokemon-server.log 2>&1 &
            echo "[$(date)] WATCHDOG: Server restarted (PID $!)"
        fi
    fi

    # --- Check streamer overlay ---
    STREAMER_UP=$(/usr/sbin/lsof -ti :9886 2>/dev/null | head -1)
    if [ -z "$STREAMER_UP" ]; then
        echo "[$(date)] WATCHDOG: Streamer not running. Starting..."
        source /Users/mfergpt/.openclaw/workspace/.env.local
        cd "$STREAMER_DIR" && nohup node server.js > /tmp/streamer.log 2>&1 &
        echo "[$(date)] WATCHDOG: Streamer started (PID $!)"
    fi

    sleep 60
done
