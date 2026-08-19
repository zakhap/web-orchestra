#!/usr/bin/env bash
# Boot order matters:
#   1. jackd (dummy backend — no sound card on a server, jack is just plumbing)
#   2. ffmpeg as a jack client named "ffin", encoding whatever arrives to HLS
#   3. scsynth, auto-connecting its outputs to ffin via SC_JACK_DEFAULT_OUTPUTS
#   4. the conductor (node), which owns scsynth via OSC and serves the site
#
# The waits below are not politeness, they are correctness. The JACK input
# device hands ffmpeg zeros when nothing is connected to it, so a graph that
# failed to wire produces a valid, continuously-updating, completely silent
# stream — with every health indicator green. Every step that can fail quietly
# is therefore checked and logged loudly.
set -u

export HLS_DIR="${HLS_DIR:-/tmp/hls}"
export SC_SYNTHDEF_PATH="${SC_SYNTHDEF_PATH:-/app/synthdefs}"
export JACK_STATUS_FILE="${JACK_STATUS_FILE:-/tmp/jack-status}"
mkdir -p "$HLS_DIR"
echo "unknown" > "$JACK_STATUS_FILE"

log() { echo "[start] $*"; }
indent() { sed 's/^/[start]   /'; }

# 1. jackd ------------------------------------------------------------------
log "launching jackd (dummy driver)"
jackd -r -d dummy -r 48000 -p 2048 &

if ! jack_wait -w -t 15 >/dev/null 2>&1; then
  log "FATAL: jack server never came up (check /dev/shm size and jackd output above)"
  exit 1
fi
log "jack server is up"

# 2. ffmpeg -----------------------------------------------------------------
log "launching ffmpeg -> HLS at $HLS_DIR"
ffmpeg -nostdin -hide_banner -loglevel warning \
  -f jack -i ffin -ac 2 \
  -c:a aac -b:a 160k \
  -f hls -hls_time 2 -hls_list_size 10 \
  -hls_flags delete_segments \
  -hls_segment_filename "$HLS_DIR/seg_%06d.ts" \
  "$HLS_DIR/live.m3u8" &

# Wait for ffmpeg's jack client to actually register. Without this, scsynth's
# auto-connect can find no ports, connect nothing, and report no error.
log "waiting for ffmpeg's jack ports (ffin:input_1)"
for _ in $(seq 1 30); do
  jack_lsp 2>/dev/null | grep -qx 'ffin:input_1' && break
  sleep 1
done
if ! jack_lsp 2>/dev/null | grep -qx 'ffin:input_1'; then
  log "FATAL: ffmpeg never registered its jack ports; the stream would be silent"
  log "ports currently visible:"
  jack_lsp 2>&1 | indent
  exit 1
fi
log "ffin ports registered"

# 3. synthdefs + scsynth ----------------------------------------------------
# Fallback: compile synthdefs at runtime if the build step didn't produce them.
# The image build should already guarantee these exist; this covers a volume
# mount or a base-image bump that invalidated them.
if ! ls "$SC_SYNTHDEF_PATH"/*.scsyndef >/dev/null 2>&1; then
  log "no compiled synthdefs found, compiling now"
  bash /app/audio/compile-synthdefs.sh /app/audio/synthdefs.scd 2>&1 | indent
fi

if ! ls "$SC_SYNTHDEF_PATH"/*.scsyndef >/dev/null 2>&1; then
  log "FATAL: no synthdefs. scsynth would boot with an empty instrument pool"
  log "and stream flawless silence. Refusing to start."
  exit 1
fi
log "synthdefs present:"
ls -la "$SC_SYNTHDEF_PATH" 2>&1 | indent

log "launching scsynth"
# -m is KILOBYTES of realtime memory. 65536 = 64 MB, generous for this piece;
# the old 262144 (256 MB) is allocated up front and OOM-kills small instances.
SC_JACK_DEFAULT_OUTPUTS="ffin:input_1,ffin:input_2" \
  scsynth -u 57110 -i 0 -o 2 -a 1024 -m 65536 -D 1 &

log "waiting for scsynth's jack ports"
for _ in $(seq 1 20); do
  jack_lsp 2>/dev/null | grep -qE ':out_1$' && break
  sleep 1
done

# 4. prove the graph is wired ----------------------------------------------
# SC_JACK_DEFAULT_OUTPUTS should already have done this. The explicit connect
# is harmless if it did and saves the performance if it didn't. Discover the
# client name rather than assuming "SuperCollider".
SC_OUT1="$(jack_lsp 2>/dev/null | grep -E ':out_1$' | grep -v '^ffin:' | head -1 || true)"
if [ -n "$SC_OUT1" ]; then
  SC_OUT2="${SC_OUT1%out_1}out_2"
  jack_connect "$SC_OUT1" ffin:input_1 >/dev/null 2>&1 || true
  jack_connect "$SC_OUT2" ffin:input_2 >/dev/null 2>&1 || true
else
  log "WARNING: no scsynth output ports found"
fi

CONNS="$(jack_lsp -c 2>/dev/null || true)"
log "jack graph:"
echo "$CONNS" | indent
# A connection shows as an INDENTED line under a port; matching the bare port
# name would be a false positive against ffin's own listing.
if echo "$CONNS" | grep -qE '^[[:space:]]+ffin:input_1'; then
  log "scsynth -> ffmpeg: CONNECTED"
  echo "connected" > "$JACK_STATUS_FILE"
else
  log "WARNING: scsynth is NOT connected to ffmpeg — the stream will be silent"
  echo "disconnected" > "$JACK_STATUS_FILE"
fi

# 5. conductor --------------------------------------------------------------
log "launching conductor"
exec node /app/conductor/server.js
