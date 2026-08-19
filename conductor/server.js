// conductor/server.js
//
// The single brain of the prototype:
//   - talks OSC (UDP) to scsynth on localhost
//   - serves the built React frontend and the HLS stream over one HTTP port
//   - one WebSocket per listener; each connection = one voice in the orchestra
//
// Degrades gracefully: if scsynth isn't reachable (e.g. local frontend dev
// without SuperCollider), it still assigns voice numbers and broadcasts state,
// and just logs the OSC it would have sent.

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const osc = require("osc");

const PORT = process.env.PORT || 8080;
const HLS_DIR = process.env.HLS_DIR || "/tmp/hls";
const SC_HOST = process.env.SC_HOST || "127.0.0.1";
const SC_PORT = parseInt(process.env.SC_PORT || "57110", 10);
const DIST_DIR = path.join(__dirname, "..", "frontend", "dist");
// start.sh writes "connected"/"disconnected" here after proving the JACK graph.
const JACK_STATUS_FILE = process.env.JACK_STATUS_FILE || "/tmp/jack-status";

// Generous caps: insurance against a public URL, not an artistic statement.
// The real soft cap / chorus-doubling threshold is a composition decision.
const MAX_VOICES = parseInt(process.env.MAX_VOICES || "48", 10);
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || "12", 10);

// Without a heartbeat, a client that dies uncleanly (sleep, dropped network,
// killed tab) never fires 'close'. The socket sits half-open and its voice
// sounds forever, counted in the population and impossible to release. The
// same mechanism also keeps live connections alive through proxies that cut
// idle sockets, so listeners are not silently ejected mid-performance.
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || "30000", 10);

const BOOT_AT = Date.now();
const BOOT_GRACE_MS = parseInt(process.env.BOOT_GRACE_MS || "30000", 10);

// ---------------------------------------------------------------- OSC layer

let scReady = false;
// scsynth answers failed commands with /fail. Ignoring those is how an image
// with no compiled synthdefs ships a flawless, fully-connected, silent stream:
// every /s_new fails, nothing upstream notices. Track them.
let scFailCount = 0;
let scLastFail = null;
let synthDefsMissing = false;
const udp = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 0,
  remoteAddress: SC_HOST,
  remotePort: SC_PORT,
  metadata: true,
});

function send(address, ...args) {
  const msg = {
    address,
    args: args.map((v) =>
      typeof v === "number"
        ? Number.isInteger(v)
          ? { type: "i", value: v }
          : { type: "f", value: v }
        : { type: "s", value: v }
    ),
  };
  if (scReady) {
    udp.send(msg);
  } else {
    console.log(`[osc:dry-run] ${address} ${args.join(" ")}`);
  }
}

udp.on("message", (msg) => {
  if (msg.address === "/status.reply" && !scReady) {
    scReady = true;
    console.log("[osc] scsynth is up");
    spawnAnchors();
  }
  if (msg.address === "/fail") {
    const detail = (msg.args || []).map((a) => a.value).join(" ");
    scFailCount++;
    scLastFail = detail;
    // A missing SynthDef is unrecoverable and silent; a missing node is
    // usually just a benign race against a voice that already left.
    if (/SynthDef not found/i.test(detail)) synthDefsMissing = true;
    console.log("[osc] scsynth /fail:", detail);
  }
});
udp.on("error", (e) => console.log("[osc] error:", e.message));
udp.open();

// Ping scsynth until it answers. If it never does, we stay in dry-run mode.
udp.on("ready", () => {
  const ping = setInterval(() => {
    if (scReady) return clearInterval(ping);
    try {
      udp.send({ address: "/status", args: [] });
    } catch (_) {}
  }, 1000);
});

// ------------------------------------------------------------ the orchestra

// Node id allocation: 1000s for permanent fixtures, 2000+ for listener voices.
const ANCHOR_NODE = 1001;
const PULSE_NODE = 1002;
let nextNode = 2000;
let joinCounter = 0;

// Just-intonation ladder over a low fundamental. Any subset of these
// frequencies is consonant, so the orchestra sounds intentional at any
// population. Voice n climbs the ladder and wraps through octaves.
const BASE = 110;
const RATIOS = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
function freqForJoin(n) {
  const step = RATIOS[n % RATIOS.length];
  const octave = 1 + (Math.floor(n / RATIOS.length) % 3);
  return BASE * step * octave;
}
function hueForFreq(freq) {
  // pitch class -> hue: the UI's color literally is the harmony
  return Math.round(((Math.log2(freq) % 1) + 1) % 1 * 360);
}
function cutoffFor(brightness) {
  // 0..1 -> ~250..6000 Hz, exponential
  return 250 * Math.pow(24, Math.min(1, Math.max(0, brightness)));
}

function spawnAnchors() {
  // The stream is never silent: a low drone and the pulse, from boot, forever.
  send("/s_new", "anchor", ANCHOR_NODE, 0, 0, "freq", 55, "amp", 0.09);
  send("/s_new", "pulse", PULSE_NODE, 0, 0, "freq", 880, "tempo", 1.8, "amp", 0.045);
}

// ws -> voice record
const voices = new Map();

let stateSeq = 0;

function stateSnapshot() {
  return {
    type: "state",
    // Timestamped so the visualization can eventually sync to the audio
    // timeline rather than to wall clock (PRD 3.5). Unused by the client
    // today; adding the field now is free, versioning a live protocol later
    // is not.
    t: Date.now(),
    seq: stateSeq,
    population: voices.size,
    voices: [...voices.values()].map((v) => ({
      n: v.joinNumber,
      freq: Math.round(v.freq * 10) / 10,
      brightness: v.brightness,
      hue: v.hue,
    })),
  };
}

function broadcast() {
  stateSeq++; // every emitted snapshot is uniquely ordered, tick or event
  const payload = JSON.stringify(stateSnapshot());
  for (const ws of voices.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// State goes out on a fixed tick rather than only on events. Event-driven
// broadcasts mean one dropped message leaves a client stale forever with
// nothing to correct it — which looks like "the audio knows someone joined
// but my screen doesn't," since HLS keeps playing over plain HTTP whether or
// not the WebSocket is healthy. A steady tick is self-healing, coalesces
// brightness spam into one message per frame, and is where the orchestration
// clock will eventually live.
const STATE_HZ = parseInt(process.env.STATE_HZ || "2", 10);
setInterval(() => {
  if (voices.size === 0) return;
  broadcast();
}, Math.round(1000 / STATE_HZ));

// ------------------------------------------------------------------ HTTP/WS

const app = express();

// HLS: playlist must never be cached; segments are immutable.
app.use(
  "/stream",
  express.static(HLS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".m3u8")) {
        res.setHeader("Cache-Control", "no-cache, no-store");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      } else {
        res.setHeader("Cache-Control", "max-age=60");
      }
    },
  })
);

// Is audio actually leaving the building? A fresh playlist means jackd and
// ffmpeg are alive and clocking. It does NOT mean there is sound in it — the
// JACK input device encodes zeros when nothing is connected, which is why
// start.sh proves the graph separately and records the verdict.
function streamHealth() {
  try {
    const st = fs.statSync(path.join(HLS_DIR, "live.m3u8"));
    const ageMs = Date.now() - st.mtimeMs;
    let segments = 0;
    try {
      segments = fs.readdirSync(HLS_DIR).filter((f) => f.endsWith(".ts")).length;
    } catch {}
    return { playlist: true, ageMs, fresh: ageMs < 10000, segments };
  } catch {
    return { playlist: false, ageMs: null, fresh: false, segments: 0 };
  }
}

function jackStatus() {
  try {
    return fs.readFileSync(JACK_STATUS_FILE, "utf8").trim();
  } catch {
    return "unknown";
  }
}

app.get("/healthz", (_req, res) => {
  const stream = streamHealth();
  const jack = jackStatus();
  const ok =
    scReady && stream.fresh && jack === "connected" && !synthDefsMissing;
  // Green during the boot window so a slow cold start does not look like a
  // crash to the platform's healthcheck; honest after that.
  const booting = Date.now() - BOOT_AT < BOOT_GRACE_MS;
  res.status(ok || booting ? 200 : 503).json({
    ok,
    booting,
    scReady,
    jack,
    synthDefsMissing,
    scFails: { count: scFailCount, last: scLastFail },
    stream,
    population: voices.size,
  });
});

// Anything missing under /stream is a real 404, never the SPA shell. hls.js
// treats an HTML body where a playlist should be as a fatal, non-retried parse
// error, so serving index.html here turns "the stream isn't up yet" into "this
// listener's player is permanently dead until they reload."
app.use("/stream", (_req, res) =>
  res.status(404).type("text/plain").send("not found")
);

app.use(express.static(DIST_DIR));
app.get("*", (_req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

const heartbeat = setInterval(() => {
  for (const ws of voices.keys()) {
    if (ws.isAlive === false) {
      const v = voices.get(ws);
      console.log(`[reap] voice #${v && v.joinNumber} stopped answering`);
      ws.terminate(); // fires 'close', which releases the voice properly
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  if (voices.size >= MAX_VOICES) {
    console.log(`[refuse] orchestra full (${voices.size}) from ${ip}`);
    return ws.close(1013, "orchestra full");
  }
  let fromThisIp = 0;
  for (const v of voices.values()) if (v.ip === ip) fromThisIp++;
  if (fromThisIp >= MAX_PER_IP) {
    console.log(`[refuse] ${MAX_PER_IP} voices already from ${ip}`);
    return ws.close(1013, "too many voices from one place");
  }

  const joinNumber = ++joinCounter;
  const nodeId = nextNode++;
  const freq = freqForJoin(joinNumber - 1);
  const voice = {
    joinNumber,
    nodeId,
    freq,
    brightness: 0.5,
    hue: hueForFreq(freq),
    pan: Math.random() * 1.6 - 0.8,
    seed: Math.floor(Math.random() * 1e6),
    ip, // for the per-IP cap only; stateSnapshot never exposes it
  };
  voices.set(ws, voice);

  console.log(
    `[join] voice #${joinNumber} node ${nodeId} freq ${freq.toFixed(1)}`
  );
  send(
    "/s_new", "voice", nodeId, 0, 0,
    "freq", freq,
    "amp", 0.13,
    "cutoff", cutoffFor(voice.brightness),
    "pan", voice.pan,
    "seed", voice.seed
  );

  ws.send(JSON.stringify({ ...stateSnapshot(), type: "welcome", youAre: joinNumber }));
  broadcast();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "brightness" && typeof msg.value === "number") {
      voice.brightness = Math.min(1, Math.max(0, msg.value));
      send("/n_set", voice.nodeId, "cutoff", cutoffFor(voice.brightness));
      broadcast();
    }
  });

  ws.on("close", () => {
    voices.delete(ws);
    console.log(`[leave] voice #${voice.joinNumber}`);
    // gate release: the envelope's 10s tail lets the voice dissolve
    send("/n_set", voice.nodeId, "gate", 0);
    broadcast();
  });
});

process.on("SIGTERM", () => {
  console.log("[shutdown] releasing all voices");
  for (const v of voices.values()) send("/n_set", v.nodeId, "gate", 0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

server.listen(PORT, () =>
  console.log(`[http] conductor listening on :${PORT}`)
);
