// conductor/server.js — transport.
//
// Owns the sockets and the process, not the music. The score lives in
// score/*.json, the performance lives in sequencer.js, randomness lives in
// rng.js. This file wires them to scsynth, to browsers, and to HTTP.
//
// Degrades gracefully: with no scsynth reachable the orchestra still runs,
// agents still advance, state still broadcasts — the notes just go nowhere.
// That is the local frontend-dev mode.

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const osc = require("osc");

const { makeRng } = require("./rng");
const { loadScore } = require("./score");
const { Sequencer, VOICE_GROUP } = require("./sequencer");

const PORT = process.env.PORT || 8080;
const HLS_DIR = process.env.HLS_DIR || "/tmp/hls";
const SC_HOST = process.env.SC_HOST || "127.0.0.1";
const SC_PORT = parseInt(process.env.SC_PORT || "57110", 10);
const DIST_DIR = path.join(__dirname, "..", "frontend", "dist");
const JACK_STATUS_FILE = process.env.JACK_STATUS_FILE || "/tmp/jack-status";

const MAX_VOICES = parseInt(process.env.MAX_VOICES || "48", 10);
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || "12", 10);
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || "30000", 10);
const STATE_HZ = parseInt(process.env.STATE_HZ || "2", 10);
const BOOT_GRACE_MS = parseInt(process.env.BOOT_GRACE_MS || "30000", 10);
const CORE_AGENTS = parseInt(process.env.CORE_AGENTS || "5", 10);
const SEED = parseInt(process.env.SEED || "22", 10);

const BOOT_AT = Date.now();

// ---------------------------------------------------------------- OSC layer

let scReady = false;
let scFailCount = 0;
let scLastFail = null;
let synthDefsMissing = false;
let dryRunNotes = 0;

const udp = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort: 0,
  remoteAddress: SC_HOST,
  remotePort: SC_PORT,
  metadata: true,
});

const oscArgs = (args) =>
  args.map((v) =>
    typeof v === "number"
      ? Number.isInteger(v)
        ? { type: "i", value: v }
        : { type: "f", value: v }
      : { type: "s", value: v }
  );

// The sequencer only ever talks to this object, so the same performance can
// be pointed at a live server or at an OSC file for offline rendering (T2).
const sink = {
  msg(address, ...args) {
    if (!scReady) return console.log(`[osc:dry-run] ${address} ${args.join(" ")}`);
    udp.send({ address, args: oscArgs(args) });
  },
  // Notes are sent as bundles with time tags a short lookahead ahead of now.
  // scsynth honours those sample-accurately, so the pulse does not inherit
  // Node's timer jitter — which matters because the score's 0-15ms per-voice
  // offsets are supposed to read as humanity, not as slop.
  bundle(dtSeconds, messages) {
    if (!scReady) return void dryRunNotes++;
    udp.send({
      timeTag: osc.timeTag(Math.max(0, dtSeconds)),
      packets: messages.map((m) => ({ address: m[0], args: oscArgs(m.slice(1)) })),
    });
  },
};

udp.on("message", (msg) => {
  if (msg.address === "/status.reply" && !scReady) {
    scReady = true;
    console.log("[osc] scsynth is up");
    setupOrchestra();
  }
  if (msg.address === "/fail") {
    const detail = (msg.args || []).map((a) => a.value).join(" ");
    scFailCount++;
    scLastFail = detail;
    if (/SynthDef not found/i.test(detail)) synthDefsMissing = true;
    if (scFailCount < 20) console.log("[osc] scsynth /fail:", detail);
  }
});
udp.on("error", (e) => console.log("[osc] error:", e.message));
udp.open();

udp.on("ready", () => {
  const ping = setInterval(() => {
    if (scReady) return clearInterval(ping);
    try {
      udp.send({ address: "/status", args: [] });
    } catch (_) {}
  }, 1000);
});

// ------------------------------------------------------------ the orchestra

const MASTER_GROUP = 2;
const MASTER_NODE = 1000;
const ANCHOR_NODE = 1001;
const PULSE_NODE = 1002;

const score = loadScore(process.env.SCORE_PATH);
const rng = makeRng(SEED);
const clock = { nowSeconds: () => Date.now() / 1000 };
const seq = new Sequencer({
  score,
  rng,
  sink,
  clock,
  core: CORE_AGENTS,
  log: console.log,
});

function setupOrchestra() {
  // Node order is the whole point: voices in a head group, the master
  // limiter in a tail group so it sees the summed orchestra. Without that
  // ceiling the piece has no dynamic range — the anchors must stay
  // inaudibly quiet so that a crowd does not clip.
  sink.msg("/g_new", VOICE_GROUP, 0, 0);
  sink.msg("/g_new", MASTER_GROUP, 1, 0);
  sink.msg("/s_new", "master", MASTER_NODE, 1, MASTER_GROUP, "amp", 1.0);
  sink.msg("/s_new", "anchor", ANCHOR_NODE, 0, VOICE_GROUP, "freq",
           score.tuning.fundamental_hz, "amp", 0.22);
  sink.msg("/s_new", "pulse", PULSE_NODE, 0, VOICE_GROUP,
           "freq", score.tuning.fundamental_hz * 16,
           "tempo", (score.pulse.bpm / 60) * score.pulse.subdivision,
           "amp", 0.09);
  console.log("[orchestra] groups, master limiter, anchors up");
}

seq.start();
setInterval(() => seq.tick(), 60);

// ws -> listener record
const voices = new Map();

let stateSeq = 0;
function stateSnapshot() {
  return {
    type: "state",
    t: Date.now(),
    seq: stateSeq,
    population: voices.size,
    lap: seq.lapInfo(),
    voices: seq.snapshot(),
  };
}

function broadcast() {
  stateSeq++;
  const payload = JSON.stringify(stateSnapshot());
  for (const ws of voices.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

setInterval(() => {
  if (voices.size === 0) return;
  broadcast();
}, Math.round(1000 / STATE_HZ));

// ------------------------------------------------------------------ HTTP/WS

const app = express();

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
  const ok = scReady && stream.fresh && jack === "connected" && !synthDefsMissing;
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
    orchestra: { agents: seq.agents.length, ...seq.lapInfo(), dryRunNotes },
  });
});

// A miss under /stream is a real 404, never the SPA shell: hls.js treats an
// HTML body where a playlist should be as a fatal, non-retried parse error.
app.use("/stream", (_req, res) => res.status(404).type("text/plain").send("not found"));

app.use(express.static(DIST_DIR));
app.get("*", (_req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

const heartbeat = setInterval(() => {
  for (const ws of voices.keys()) {
    if (ws.isAlive === false) {
      const v = voices.get(ws);
      console.log(`[reap] listener ${v && v.joinNumber} stopped answering`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

let joinCounter = 0;

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
    console.log(`[refuse] ${MAX_PER_IP} listeners already from ${ip}`);
    return ws.close(1013, "too many voices from one place");
  }

  // A listener does not replace an agent, they attach to one. The ensemble
  // was already playing before they arrived and keeps playing after.
  const agent = seq.addAgent(true);
  const joinNumber = ++joinCounter;
  voices.set(ws, { joinNumber, agentId: agent.id, agent, ip });
  console.log(`[join] listener #${joinNumber} -> agent ${agent.id} at cell ${(agent.pos % score.nCells) + 1}`);

  // Static score shape goes out once, not on every tick.
  ws.send(
    JSON.stringify({
      ...stateSnapshot(),
      type: "welcome",
      youAre: agent.id,
      score: {
        id: score.id,
        title: score.title,
        cells: score.nCells,
        cellPhases: score.cells.map((c) => c.phase),
        phases: score.phases.map((p) => ({ id: p.id, name: p.name, note: p.note })),
      },
    })
  );
  broadcast();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "brightness" && typeof msg.value === "number") {
      agent.bright = Math.min(1, Math.max(0, msg.value));
    }
  });

  ws.on("close", () => {
    voices.delete(ws);
    console.log(`[leave] listener #${joinNumber}`);
    seq.releaseAgent(agent); // finishes its repetition, decrescendos, goes
    broadcast();
  });
});

process.on("SIGTERM", () => {
  console.log("[shutdown]");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

server.listen(PORT, () =>
  console.log(
    `[http] conductor on :${PORT} · score "${score.id}" · ${score.nCells} cells · seed ${SEED}`
  )
);
