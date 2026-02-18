#!/bin/bash
# Dual stream: OBS outputs to local relay, ffmpeg splits to Twitch + X
#
# Option 1: Use OBS "Start Streaming" for Twitch (primary)
#            Then ffmpeg re-streams to X from a local relay
#
# Option 2: OBS streams to local RTMP, ffmpeg fans out to both
#
# We'll use Option 1 since it's simpler:
# - OBS → Twitch (built-in)
# - ffmpeg grabs OBS output and re-streams to X

# Load keys
source "$(dirname "$0")/.stream-keys"

echo "=== mferGPT Dual Stream ==="
echo "Twitch: configured in OBS (primary)"
echo "X: will re-stream via ffmpeg"
echo ""
echo "Starting X re-stream from OBS virtual output..."
echo "Make sure OBS is streaming to Twitch first!"
echo ""

# Use OBS's "Start Recording" output or a custom RTMP relay
# Simpler: just run a second ffmpeg that reads the same sources

# Actually, the cleanest approach for macOS:
# OBS streams to Twitch, and we use ffmpeg to capture screen region and send to X
# But that's wasteful. Better: use OBS custom output.

# Best approach: configure OBS to output to a local RTMP relay,
# then ffmpeg splits to both destinations.

# Install nginx-rtmp or use a simple relay? Too complex.
# Simplest: just start two OBS stream outputs using obs-websocket hack.

echo "Use the OBS multi-output approach instead. Run:"
echo "  node dual-stream-obs.js start   # starts both streams"  
echo "  node dual-stream-obs.js stop    # stops both streams"
