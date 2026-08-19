# TODO

Working backlog for the walking skeleton → M2. Items carry file:line where they
exist today. Ordered by "how much more expensive does this get if we defer it,"
not by size.

Companion to the PRD (v0.1). Where this doc and the PRD disagree, see
"Decisions since PRD v0.1" — those supersede.

---

## Decisions since PRD v0.1

Recorded 2026-08-19. These change §2/§4 of the PRD and should be folded in on
the next revision.

**D1 — Population zero is not just anchors.** A core group of instruments plays
always, independent of attendance. The piece is literally always playing; a
human joining is *entering an ensemble in progress*, not starting one. Exact
membership of the core group TBD. Supersedes the reading of §6 where anchors
are the floor.

**D2 — scsynth holds the piece, not just the notes.** Reverses PRD §4's
"scsynth is deliberately dumb — all musical intelligence lives upstream."
The synthesis engine carries enough of the score and sequencing to keep
performing on its own: it receives update messages and plays out accordingly,
and if updates stop it continues along as a zombie on its own track. The
conductor steers; it is not a life-support system.

**D3 — Voices are not persistent identities.** A returning listener picks a new
voice. Optionally: remember the last voice in localStorage and offer it back at
the join screen ("welcome back — same vibraphone?") before entering. No
server-side identity, no accounts. Open sub-question in T12.

---

## P0 — Before M2 starts

Structural seams. All are small today and all get expensive once the sequencer
and agent sim are built on top of them.

### T1 — Seeded randomness everywhere *(the one that prompted this doc)*

PRD §5 requires one seed to govern all randomness, so score v13 can be rendered
against identical agent behavior as v12, and so any logged lap can be
re-rendered from `{score, scenario, seed}`. We currently violate this.

- `conductor/server.js:168` — `pan: Math.random() * 1.6 - 0.8`
- `conductor/server.js:169` — `seed: Math.floor(Math.random() * 1e6)`

Work:
- Add one seeded PRNG to the conductor (mulberry32 / xoshiro128**, ~10 lines).
  Root seed comes from config/scenario, is logged with every lap, and is the
  only entropy source in the process.
- Thread `rng` through voice creation; replace both call sites above.
- Ban bare `Math.random()` in `conductor/` via lint rule or a grep in CI. This
  is the part that actually holds the line — M2 adds patience distributions,
  herding coefficients, micro-drift and entrance jitter, and every one of them
  will reach for a random number.
- Per-voice quantities (detune, drift rate, phase offset, envelope jitter,
  pulse offset) are *derived arithmetically* from the conductor-supplied seed,
  not rolled independently. See T5 — this also fixes the synthdef bug.
- Under D2, scsynth's autonomous behavior is part of the piece, so anything it
  decides on its own must also derive from conductor-supplied seeds, or zombie
  passages are unreproducible and the A/B render is a lie.

### T2 — OSC sink becomes an interface

`conductor/server.js:35` — `send()` closes over the module-level `udp` and a
global `scReady`. M3's NRT path needs the same conductor to emit an OSC *file*
instead of UDP datagrams.

Split into `RealtimeSink` / `NrtFileSink` / `DryRunSink` behind one interface,
injected at startup. One call site today; forty once the sequencer lands.

### T3 — Clock is injectable from the first line of the sequencer

There is no clock yet, which is the good news — this is still greenfield.

M2 will want a pulse clock and the obvious implementation is `setInterval`,
which makes NRT structurally impossible: "renders faster than real time" means
the clock is a parameter, not wall time. Build the sequencer against an
injectable `now()` + scheduler.

Related: schedule notes as OSC bundles with timetags at a fixed lookahead ahead
of the audio clock (scsynth honors these sample-accurately) rather than firing
messages at the moment of the event. PRD §3.2 wants a 0–15ms random pulse
offset as deliberate humanization — the underlying grid has to be tighter than
that for the jitter to read as intentional rather than as slop.

Under D2 this partly moves into scsynth; see T4.

### T4 — Design the conductor/scsynth split for D2

Decide how much of the piece lives in the synthesis engine. Sketch of the
question, not the answer:

- Minimum: pulse clock + current-cell playback lives in scsynth, so silence
  never happens if the conductor stalls.
- Maximum: cell data in buffers, advancement via demand-rate UGens
  (`Dseq`/`Dswitch` + `Demand`), agents' cell position as a per-voice control.
  Conductor sends "you're on cell 17 now" and nothing else.

Consequences to think through before committing:
- Zombie mode must be *musical*, not merely non-silent. A zombie orchestra that
  never advances cells is a stuck record; one that advances on its own needs
  legality-window logic in scsynth, which is the thing we said would live
  upstream.
- Hot-reloading the score at the seam (PRD §2) gets harder when the score is
  resident in scsynth buffers. Needs a buffer-swap-at-seam plan.
- NRT actually gets *better* under D2 — the render exercises the same
  autonomous behavior production runs, rather than a conductor-driven
  approximation of it.
- Reconcile with PRD §4 wording when this is settled.

### T5 — Per-voice decorrelation is currently broken

`audio/synthdefs.scd:16-17`. `RandID.ir(seed)` is passed a seed up to 1e6, but
scsynth allocates 64 RNGs by default (`-r`) — the ID is out of range.
`RandSeed.ir(1, seed + 1)` passes a constant where a trigger is expected.

Net effect: identical-frequency voices likely phase-lock — exactly what the
code comment says it prevents, and exactly what PRD §3.2 depends on to make
twenty people on the same marimba a shimmering chorus instead of one loud
marimba. This is load-bearing for the mass tier.

Fix: drop `RandID`/`RandSeed` entirely. Derive detune, drift LFO *rate*
(e.g. `0.07 * (1 + seedFrac * 0.3)` decorrelates without touching RNG
allocation), phase offset and envelope jitter arithmetically from the
conductor-supplied seed. Reproducible in NRT by construction, which `RandID`
never would be, and it sidesteps 64 RNGs not covering a 60+ voice tier.
If any RNG use survives, raise scsynth's `-r` above the population ceiling.

### T6 — Re-key the voice table

`conductor/server.js:107` is `Map<WebSocket, voice>` (`voices.set(ws, …)` at
:171). PRD §2: every voice is driven by an agent, humans attach to and override
agents, and the system must be performable with zero humans present — which D1
makes the *normal* case, not an edge case.

Agents outlive sockets and mostly have none. Key by voice id; the voice owns an
optional `attachedSocket`; keep a socket→voiceId secondary index.

### T7 — Timestamps in the state protocol

`stateSnapshot()` (`conductor/server.js:109`) emits no timestamp and no audio
clock reference. PRD §3.5 requires state timestamped against the audio timeline
so the visualization syncs to what the listener is *hearing*; PRD §2 makes the
timestamped state contract the hedge that keeps the transport swappable.

Add both fields to the v0 contract now, even unused. Versioning a live protocol
later is the expensive version of this.

Also decide now: broadcast the **upcoming schedule** (note events with
audio-timeline timestamps) rather than current state, so the client can
interpolate at 60fps against the audio clock. PRD §3.5 wants nodes "glowing
with note activity" and 2 Hz snapshots cannot render note onsets. Easier to
adopt before the frontend has a renderer built on snapshots.

---

## P0-DEPLOY — Blocks the first Railway deploy

Found while reading `Dockerfile`/`start.sh` with "will this boot" eyes.
These are not in the general backlog because they only matter until the
container is proven once.

**Verified OK (do not re-investigate):**
- `supercollider-server` + `supercollider-language` exist in Debian bookworm
  (3.13.0). Package names in the Dockerfile are correct.
- Debian's `libavdevice59` links `libjack-jackd2-0`, so `ffmpeg -f jack` is
  compiled in and the egress design works on this base image.
- `jackd -r -d dummy -r 48000` is right: first `-r` is --no-realtime (correct,
  containers lack RTPRIO), second is the dummy driver's sample rate.
- `SC_JACK_DEFAULT_OUTPUTS="ffin:input_1,ffin:input_2"` is the correct format.
- `jack_lsp`, `jack_connect`, `jack_wait` all ship in the `jackd2` package.

### T23 — scsynth reserves 256 MB of RT memory at startup — ✅ DONE

`audio/start.sh:37` — `-m 262144` is 262144 **kilobytes** = 256 MB, allocated
as one block at boot (default is 8 MB). Plus node, ffmpeg and jackd, that will
OOM on a small Railway plan, and an OOM-kill mid-boot looks like a mysterious
crash loop rather than a memory problem.

`-m 65536` (64 MB) is far more than this piece needs. Check the plan's memory
limit before deploying either way.

### T24 — The jack connection race is silent — ✅ DONE

`audio/start.sh` starts ffmpeg, sleeps 1s, then starts scsynth, which
auto-connects to `ffin:*` via `SC_JACK_DEFAULT_OUTPUTS`. If ffmpeg's JACK
client hasn't registered its ports within that second, scsynth connects to
**nothing** — and nothing reports an error.

Why this is the worst possible first-deploy failure: the jack indev delivers
zeros when no ports are connected, so ffmpeg cheerfully encodes *silence* and
writes a valid, continuously-updating playlist. `scReady` is true. Segments are
fresh. The T17 stream-freshness healthcheck goes green. Every diagnostic says
healthy and the stream is silent.

Fix, in `start.sh`:
- Poll `jack_lsp` until `ffin:input_1` exists before launching scsynth
  (bounded retry, then fail loudly).
- After scsynth boots, log `jack_lsp -c` so the deploy log *proves* the graph
  is wired.
- Belt-and-braces: explicit `jack_connect SuperCollider:out_1 ffin:input_1`
  (and `out_2`/`input_2`) as a fallback if the env-var auto-connect missed.

### T25 — A failed synthdef compile is invisible in the build log — ✅ DONE

`Dockerfile:31-32` ends in `|| echo "..."`, so the build cannot fail and a
broken compile is only discovered at runtime. Append `&& ls -la /app/synthdefs`
so the build log shows whether `.scsyndef` files actually exist.

### T26 — /dev/shm sizing for jackd *(watch, don't pre-fix)*

JACK uses shared memory; Docker's default `/dev/shm` is 64 MB. Almost certainly
fine for the dummy driver, but it is a known container-JACK failure mode.
If jackd dies at boot, look for shm registry errors before looking anywhere
else.

---

## P1 — "The piece never stops" violations

PRD §2 states this as a principle. Four separate paths currently break it.

### T8 — Frontend never reconnects, and nothing keeps the socket alive

`frontend/src/App.jsx:28` — `onclose` sets `"closed"` and stops. No ping/pong on
either side, and the conductor only sends on join/leave/brightness, so a quiet
room is a silent connection that Railway's proxy will idle-timeout.

PRD §2 names listener reconnection as the reason redeploys are safe. It isn't
implemented.

- `ws.ping()` on ~30s interval server-side, `terminate()` on missed pong.
- Client reconnect with backoff + jitter.
- See T12 for whether a reconnect within a grace window reattaches the same
  voice.

### T9 — Missing HLS files return `200 text/html` — ✅ DONE

`conductor/server.js:153` — `app.get("*")` serves `index.html` for anything the
static middleware missed, including `/stream/live.m3u8` before ffmpeg has
written it. Verified: returns `200`, `Content-Type: text/html`, HTML body.
hls.js treats that as a fatal `manifestParsingError` and does **not** retry
(it retries network errors, not parse errors), so the player is dead until
reload.

Anyone arriving during the boot window after a deploy gets a permanently silent
page. Exclude `/stream` from the catch-all, and add an `hls.on(ERROR)` handler
that retries manifest load.

(Also: `app.get("*")` breaks outright on Express 5 — path-to-regexp v8 wants
`*splat`. Pinned to `^4.21.0` so it's a landmine, not a bug.)

### T10 — `scReady` is a one-way latch

`conductor/server.js:26,54`. If scsynth restarts, `scReady` stays true,
`spawnAnchors()` never re-runs, and every subsequent `/s_new` goes nowhere. The
anchors are the PRD's stated restart-resilience guarantee and they don't
survive the restart they exist for.

Use `/notify` and re-run spawn + replay the full voice table on the
scsynth-up transition.

### T11 — Voices spawned during dry-run become permanent ghosts

If a connection lands before the `/status` ping succeeds
(`conductor/server.js:64-71`, up to a 1s window at boot), its `/s_new` is
logged instead of sent, but the voice stays in the map forever: visible on the
ladder, counted in population, silent, un-releasable.

Queue pending spawns until `scReady`, or just replay the whole voice table on
the up-transition (same mechanism as T10).

### T12 — Reconnect grace window *(open question)*

D3 settles *return visits*: new voice each time, optionally offered the previous
one from localStorage at the join screen.

Still undecided: a **dropped socket mid-session**. Without a grace window, a
30-second subway tunnel currently kills a voice and returns a stranger — with a
fresh personality roll and a fresh instrument. A short server-side grace window
(~60–90s) holding the voice for a matching reconnect token would make network
blips musically invisible. Decide alongside T8; the two ship together.

---

## P2 — Audio integrity at scale

### T13 — Master limiter and group structure

Nothing exists downstream of the voices. Everything is `addToHead` of group 0
(`conductor/server.js:102-103,176`), summing into `Out.ar(0)`. Sixty voices at
`amp 0.13` is ~7.8 into a bus that clips at ±1 — and 60+ is the explicitly
targeted mass tier.

Needs a `\master` synth (limiter / soft clip) on a tail group, which means
introducing group structure first: `voiceGroup` (head) → `masterGroup` (tail).

### T14 — Soft cap and chorus-doubling threshold

Listed as open in PRD §8. Worth pulling forward: it's also the answer to T15,
and T13's headroom budget can't be set without it.

### T15 — Abuse limits — ⚠️ PARTLY DONE

PRD §2 promises "no way for one participant to disrupt the ensemble." True of
the UI, false of the system: unbounded WebSocket connections, no per-IP cap, no
message rate limit, `ws` default `maxPayload` of 100MB feeding `JSON.parse`
(`conductor/server.js:190`).

- Population cap (T14) + per-IP connection cap.
- ~~`maxPayload: 4096`~~ — done.
- ~~Population cap + per-IP cap~~ — done, env-configurable
  (`MAX_VOICES`=48, `MAX_PER_IP`=12). Generous on purpose; the real soft cap
  is T14, a composition decision.
- **Still open:** server-side brightness/param throttle (~20 Hz). Folds into T16.

### T16 — Broadcast coalescing

`broadcast()` fires on every brightness message and re-serializes per recipient
(`conductor/server.js:122-127`). PRD §4 already specifies ~2 Hz snapshots — this
is a known design that's merely unimplemented. Fold into the T3 clock tick.

---

## P3 — Ops and hygiene

### T17 — Nothing supervises the audio chain — ⚠️ PARTLY DONE

`audio/start.sh` backgrounds jackd, ffmpeg and scsynth with `sleep 2`/`sleep 1`
as the only synchronization, then `exec node`. If ffmpeg loses the race or dies
later, node keeps serving, the container stays up, `/healthz` returns
`{ok: true}` (`conductor/server.js:148`), and the stream is dead forever.

Done: `/healthz` now reports `{ok, booting, scReady, jack, stream:{playlist,
ageMs, fresh, segments}, population}`, returns 503 once unhealthy past a
`BOOT_GRACE_MS` window, and reads the JACK verdict start.sh writes. One curl
now localizes any failure in the chain.

**Still open:** nothing *restarts* a dead jackd/ffmpeg/scsynth. Point Railway's
healthcheck at `/healthz` so the platform recycles the container, and later
supervise the three processes properly.

### T18 — Repo hygiene, blocking first push — ⚠️ PARTLY DONE

Not a git repo yet, and PRD/README step 1 is "push to GitHub."

- ~~`.gitignore`~~ — done.
- **Still open:** `git init` + first commit + push.
- ~~`.dockerignore`~~ — done. Now load-bearing: `frontend/node_modules` exists
  locally as of this session, so without it `COPY frontend frontend`
  (Dockerfile:24) would carry a darwin-arm64 esbuild into the linux image and
  break `vite build`.
- **Still open:** lockfiles aren't `COPY`'d and the Dockerfile uses
  `npm install`, not `npm ci` — builds aren't reproducible, which sits badly
  next to T1.
- Note: `conductor/node_modules` was installed locally during review.

### T19 — SQLite lap logs need a Railway volume

PRD §4 persists lap logs to SQLite; §3.5 calls each lap "a documented,
unrepeatable event." Railway filesystems are ephemeral — without an attached
volume they're deleted on every deploy. Decide the volume + DB path before laps
we care about start accumulating.

### T20 — Pin replicas to 1

PRD §2: "one performance in the world." Railway replicas > 1 silently forks the
piece into two unrelated orchestras behind one domain. Pin in config, state in
README.

### T21 — SIGTERM releases gates then exits after 2s

`conductor/server.js:211-216`. The release tail is 10s (`synthdefs.scd:23`), so
the dissolve never happens — voices are cut off mid-fade. Either wait out the
tail or accept and document it.

### T22 — `audio.play()` failure is swallowed — ✅ DONE

`frontend/src/App.jsx:53` — `.catch(() => {})`. Button does nothing, says
nothing. Surface the failure.

---

## Deferred — placeholder surface, deleted by M2/M5

Logged so nobody "fixes" them:

- Ladder wraps every 15 voices (`RATIOS.length × 3`); rungs stack with
  overlapping labels. M5 replaces with the ring constellation.
- Octave multiplier is `1, 2, 3` — the `3×` is an octave-and-a-fifth, not an
  octave, and the ladder's top ~27% is dead space (max 550 Hz against a scale
  to 1000 Hz). Placeholder pitch material; M1/M2 replace it.
- `hueForFreq` (`conductor/server.js:91`) is **correct** and matches PRD §3.5
  exactly. Keep it.
