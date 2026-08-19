import React, { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";

const STREAM_URL = "/stream/live.m3u8";

// Map a frequency onto the ladder: log-pitch position within the range
// the conductor actually uses (110 Hz fundamental, three octaves).
const FMIN = Math.log2(100);
const FMAX = Math.log2(1000);
const pitchPos = (f) => (Math.log2(f) - FMIN) / (FMAX - FMIN);

export default function App() {
  const [conn, setConn] = useState("connecting"); // connecting | open | closed
  const [youAre, setYouAre] = useState(null);
  const [population, setPopulation] = useState(0);
  const [voices, setVoices] = useState([]);
  const [brightness, setBrightness] = useState(0.5);
  const [listening, setListening] = useState(false);
  const [audioNote, setAudioNote] = useState(null);
  const [arrivals, setArrivals] = useState([]);
  const prevVoicesRef = useRef(null);
  const toastIdRef = useRef(0);
  const wsRef = useRef(null);
  const audioRef = useRef(null);
  const hlsRef = useRef(null);
  const retriesRef = useRef(0);

  // ---- websocket: joining IS the instrument -------------------------------
  useEffect(() => {
    let ws;
    let attempt = 0;
    let timer;
    let unmounted = false;

    // The server reaps connections that stop answering its heartbeat, so a
    // sleeping laptop or a dropped network releases its voice instead of
    // leaving it sounding forever. The other half of that bargain is here:
    // when we are the one who got dropped, come back. Rejoining is a new
    // voice by design — see D3.
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConn("open");
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "welcome") setYouAre(msg.youAre);
        if (msg.type === "welcome" || msg.type === "state") {
          setPopulation(msg.population);
          setVoices(msg.voices);

          // Announce who came and went. Skipped on the first snapshot after
          // (re)connecting, so arriving into a full room does not fire a
          // toast per person already sounding.
          const prev = prevVoicesRef.current;
          if (prev) {
            const before = new Set(prev.map((v) => v.n));
            const after = new Set(msg.voices.map((v) => v.n));
            const events = [
              ...msg.voices
                .filter((v) => !before.has(v.n))
                .map((v) => ({ kind: "in", v })),
              ...prev
                .filter((v) => !after.has(v.n))
                .map((v) => ({ kind: "out", v })),
            ];
            if (events.length) {
              const toasts = events.map((e2) => ({
                id: ++toastIdRef.current,
                hue: e2.v.hue,
                text:
                  e2.kind === "in"
                    ? `voice №${e2.v.n} joined · ${e2.v.freq} Hz`
                    : `voice №${e2.v.n} left`,
              }));
              setArrivals((cur) => [...cur, ...toasts].slice(-4));
              const ids = new Set(toasts.map((t) => t.id));
              setTimeout(
                () => setArrivals((cur) => cur.filter((t) => !ids.has(t.id))),
                5000
              );
            }
          }
          prevVoicesRef.current = msg.voices;
        }
      };
      ws.onclose = () => {
        if (unmounted) return;
        setConn("rejoining");
        setYouAre(null);
        prevVoicesRef.current = null; // resync silently, don't toast the room
        const delay = Math.min(20000, 1000 * 2 ** attempt) + Math.random() * 500;
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      unmounted = true;
      clearTimeout(timer);
      if (ws) ws.close();
    };
  }, []);

  // ---- audio --------------------------------------------------------------
  const startListening = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = STREAM_URL; // Safari
    } else if (Hls.isSupported() && !hlsRef.current) {
      const hls = new Hls({ liveSyncDurationCount: 3 });

      // The stream may not exist yet — the container takes a few seconds to
      // start writing segments after a deploy. Without this, one early fatal
      // error leaves the player dead until the listener reloads.
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        if (retriesRef.current >= 12) {
          setAudioNote("the stream is not reachable — try reloading");
          return;
        }
        retriesRef.current += 1;
        setAudioNote("waiting for the hall to open…");
        setTimeout(() => hls.startLoad(), 2000);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        retriesRef.current = 0;
        setAudioNote(null);
      });

      hls.loadSource(STREAM_URL);
      hls.attachMedia(audio);
      hlsRef.current = hls;
    }
    audio
      .play()
      .then(() => {
        setListening(true);
        setAudioNote(null);
      })
      .catch((err) =>
        setAudioNote(
          err && err.name === "NotAllowedError"
            ? "your browser blocked playback — tap again"
            : "could not start playback"
        )
      );
  }, []);

  // ---- brightness ---------------------------------------------------------
  const sendBrightness = useCallback((v) => {
    setBrightness(v);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "brightness", value: v }));
    }
  }, []);

  const me = voices.find((v) => v.n === youAre);

  return (
    <main className="stage">
      <header className="masthead">
        <span className="mast-line" />
        <span className="mast-text">the server orchestra</span>
        <span className={`mast-conn mast-conn--${conn}`}>
          {conn === "open" ? "connected" : conn}
        </span>
      </header>

      <section className="arrival">
        {youAre === null ? (
          <h1 className="arrival-title arrival-title--waiting">
            taking your seat…
          </h1>
        ) : (
          <h1 className="arrival-title">
            you are voice{" "}
            <span
              className="arrival-number"
              style={me ? { color: `hsl(${me.hue} 75% 65%)` } : undefined}
            >
              №{youAre}
            </span>
          </h1>
        )}
        <p className="arrival-sub">
          {population} voice{population === 1 ? "" : "s"} sounding — each one a
          person who is here right now
        </p>
      </section>

      <div className="arrivals" aria-live="polite">
        {arrivals.map((t) => (
          <span
            key={t.id}
            className="arrival-toast"
            style={{ "--toast-color": `hsl(${t.hue} 70% 62%)` }}
          >
            {t.text}
          </span>
        ))}
      </div>

      {/* signature: the harmonic ladder. vertical position = pitch,
          hue = pitch class. the interface's color is the harmony. */}
      <section className="ladder" aria-label="voices by pitch">
        {voices.map((v) => {
          const mine = v.n === youAre;
          return (
            <div
              key={v.n}
              className={`rung ${mine ? "rung--mine" : ""}`}
              style={{
                bottom: `${pitchPos(v.freq) * 100}%`,
                "--rung-color": `hsl(${v.hue} 75% ${mine ? 70 : 55}%)`,
                "--rung-glow": 0.35 + v.brightness * 0.65,
              }}
            >
              <span className="rung-label">
                №{v.n} · {v.freq} Hz
              </span>
            </div>
          );
        })}
        {voices.length === 0 && (
          <p className="ladder-empty">the anchors are holding the room</p>
        )}
      </section>

      <section className="console">
        {!listening ? (
          <button className="listen" onClick={startListening}>
            open your ears
          </button>
        ) : (
          <span className="listening-note">
            live · the stream runs a few seconds behind your touch
          </span>
        )}
        {audioNote && <span className="audio-note">{audioNote}</span>}
        <label className="knob">
          <span className="knob-name">brightness of your voice</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={brightness}
            disabled={youAre === null}
            onChange={(e) => sendBrightness(parseFloat(e.target.value))}
            style={
              me
                ? { accentColor: `hsl(${me.hue} 75% 60%)` }
                : undefined
            }
          />
        </label>
      </section>

      <audio ref={audioRef} />
    </main>
  );
}
