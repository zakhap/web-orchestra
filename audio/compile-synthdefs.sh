#!/usr/bin/env bash
# Compile the synthdefs headlessly.
#
# Debian's sclang links QtWebEngine, whose embedded Chromium refuses to start
# as root without --no-sandbox. A naive `sclang synthdefs.scd` therefore aborts
# mid class-library compile inside a container, writes nothing, and leaves
# scsynth with an empty instrument pool — which sounds exactly like a broken
# audio chain while every other indicator stays green.
#
# Two attempts, then fail loudly. A scsynth with no defs is guaranteed silence,
# so this must never be a warning that the boot continues past.
set -u

OUT="${SC_SYNTHDEF_PATH:-/app/synthdefs}"
SRC="${1:-/app/audio/synthdefs.scd}"
SC_LIB="${SC_CLASS_LIBRARY:-/usr/share/SuperCollider}"
mkdir -p "$OUT"

have_defs() { ls "$OUT"/*.scsyndef >/dev/null 2>&1; }
say() { echo "[synthdefs] $*"; }

# 1. Let Chromium run as root. Least invasive: the full class library still
#    compiles, so nothing in the language is missing.
say "attempt 1 — sclang with --no-sandbox"
QT_QPA_PLATFORM=offscreen \
QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-gpu" \
HOME=/tmp \
  timeout 180 sclang "$SRC" 2>&1 | sed 's/^/[synthdefs]   /'

if have_defs; then
  say "OK after attempt 1"
  ls -la "$OUT"
  exit 0
fi

# 2. Drop QtCollider from the class library entirely, so QtWebEngine is never
#    constructed. We only need SynthDef and the UGens; the GUI classes are
#    dead weight in a server image.
say "attempt 1 produced nothing — attempt 2 with QtCollider excluded"
CONF=/tmp/sclang_headless.yaml
cat > "$CONF" <<YAML
excludePaths:
  - $SC_LIB/SCClassLibrary/QtCollider
  - $SC_LIB/SCClassLibrary/deprecated
  - $SC_LIB/HelpSource
postInlineWarnings: false
YAML
QT_QPA_PLATFORM=offscreen \
QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-gpu" \
HOME=/tmp \
  timeout 180 sclang -l "$CONF" "$SRC" 2>&1 | sed 's/^/[synthdefs]   /'

if have_defs; then
  say "OK after attempt 2"
  ls -la "$OUT"
  exit 0
fi

say "FAILED — no .scsyndef files produced."
say "scsynth with no defs is guaranteed silence, so this is fatal."
say "Fallback: compile locally (sclang audio/synthdefs.scd), commit the"
say ".scsyndef files, and un-ignore synthdefs/ in .gitignore."
exit 1
