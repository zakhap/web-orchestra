# the server orchestra — walking skeleton

One container, one performance. Every browser connection is a voice: joining
spawns a sustained synth on a just-intonation ladder over a shared scsynth
instance; leaving gate-releases it; a brightness slider drives its filter
cutoff live. Two permanent fixtures (a low anchor drone and The Pulse) keep
the stream sounding at population zero. Everyone hears the same HLS stream.

This is deliberately the *dumbest possible version* of the piece — no cells,
no agents, no orchestration curves — so that each part can now be replaced
independently: the synthdefs are the instrument workshop, the conductor is
where the score/agent logic will live, the frontend grows into the
constellation.

## Layout

```
Dockerfile            one image: node + scsynth + jackd + ffmpeg
audio/synthdefs.scd   instruments, compiled to .scsyndef at build time
audio/start.sh        boot order: jackd → ffmpeg(HLS) → scsynth → conductor
conductor/server.js   OSC to scsynth, WS to browsers, serves frontend + /stream
frontend/             Vite + React; harmonic-ladder visualization, hls.js player
```

## Signal path

```
browser WS ──▶ conductor ──OSC/UDP──▶ scsynth ──JACK──▶ ffmpeg ──HLS──▶ /stream/live.m3u8 ──▶ every browser
```

Control is instant-ish; audio arrives ~6–12 s later. That asymmetry is by
design — the piece's decisions live on phrase timescales.

## Run locally

Frontend/conductor only (no SuperCollider needed — OSC goes to dry-run logs):

```bash
cd conductor && npm install && node server.js     # :8080
cd frontend  && npm install && npm run dev        # :5173, proxies /ws + /stream
```

With sound (SuperCollider installed, macOS/Linux, no jack/ffmpeg needed —
scsynth plays your speakers directly):

```bash
export SC_SYNTHDEF_PATH=$PWD/synthdefs && mkdir -p synthdefs
sclang audio/synthdefs.scd            # compile instruments
scsynth -u 57110 -i 0 -o 2 &          # local server, hardware out
node conductor/server.js              # conductor finds it via /status ping
```

Open a few browser tabs against :5173 — each tab is a voice. (Locally you
hear scsynth directly; the HLS player has nothing to play, which is fine.)

Full container, exactly what Railway runs:

```bash
docker build -t orchestra . && docker run -p 8080:8080 orchestra
```

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from repo. Railway sees the Dockerfile and
   uses it (no config needed). Everything else on the project stays
   Dockerless — this image is the one native-dependency package.
3. Settings → Networking → Generate Domain. `PORT` is already respected.
4. Open the URL on two devices. Watch the ladder; wait out the HLS delay;
   hear the second device arrive.

`/healthz` reports `{ ok, scReady, population }` — if `scReady` is false in
production, check deploy logs for the sclang compile or jack/ffmpeg lines.

## Notes & known edges

- **sclang headless compile**: the Dockerfile compiles synthdefs with
  `QT_QPA_PLATFORM=offscreen`. If that ever fails on a base-image bump,
  `start.sh` retries at runtime; ultimate fallback is compiling locally and
  committing the `.scsyndef` files.
- **HLS latency** is ~3× segment length. `hls_time 2` ≈ 6–8 s glass-to-glass.
  Don't chase this number — the design doesn't need it lower.
- **State is in-memory** — a redeploy drops all voices. Correct behavior for
  now: listeners reconnect, the orchestra re-forms. Lap logging comes later.
- **Scaling listeners**: when the day comes, put a CDN in front of `/stream`
  and the audio side scales itself; the WS side is a few KB/s per listener.

## Where each part goes next

- `synthdefs.scd` → the real instrument pool + timbre macro params.
- `server.js` → split into score loader, agent simulation, and transport;
  the `voice` map becomes the voice table; add the NRT render path.
- `frontend` → ladder becomes the ring constellation; join flow gains
  instrument choice + audition; add the LFO controls.
