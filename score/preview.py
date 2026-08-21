#!/usr/bin/env python3
"""
Offline preview renderer — the seed of the NRT path (roadmap M3).

Simulates N agents performing the score and renders straight to WAV, far
faster than real time, with no SuperCollider and no deploy. This is the loop
the composition gets good inside.

Everything random derives from ONE seed (T1). Two runs with the same seed and
score produce bit-identical audio, so score v2 can be A/B'd against v1 with
agent behaviour held constant. Do not introduce unseeded randomness here.

  python3 preview.py --seed 22 --seconds 100 --scenario ramp -o take.wav
"""
import argparse, json, pathlib
import numpy as np

SR = 44100


# ----------------------------------------------------------------- synthesis
def _place(buf, i0, sig, pan):
    n = len(sig)
    if i0 + n > buf.shape[0]:
        n = buf.shape[0] - i0
        if n < 8:
            return
        sig = sig[:n]
    l, r = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
    buf[i0:i0 + n, 0] += sig * l
    buf[i0:i0 + n, 1] += sig * r


def render_bowed(buf, start_s, freq, dur_s, amp, pan, detune, bright=0.5):
    """Sustaining voice: swells in, holds, releases. The struck tone decays,
    so the score's long held notes died away under it. Must track \\bowed in
    audio/synthdefs.scd, or an offline audition stops predicting the stream."""
    d = max(dur_s, 0.2)
    n = int(d * SR)
    if n < 8:
        return
    t = np.arange(n) / SR
    f = freq * (1.0 + detune)
    vib = 1.0 + 0.0022 * np.sin(2 * np.pi * 4.6 * t)

    sig = np.zeros(n)
    for det in (0.999, 1.0, 1.0035):
        for h in range(1, 9):
            hf = f * det * h
            if hf > 15000:
                break
            sig += (0.30 / h) * np.sin(2 * np.pi * hf * vib * t)
    sig += 0.16 * np.sin(2 * np.pi * f * 0.5 * vib * t)

    a = max(int(n * 0.38), 1)
    hold = max(int(n * 0.34), 1)
    rel = max(n - a - hold, 1)
    env = np.concatenate([
        np.linspace(0, 1, a) ** 2, np.ones(hold), np.linspace(1, 0, rel) ** 2,
    ])
    env = env[:n] if len(env) >= n else np.pad(env, (0, n - len(env)))
    _place(buf, int(start_s * SR), sig * env * amp * 0.85, pan)


def render_note(buf, start_s, freq, dur_s, amp, pan, detune):
    """Mallet-ish tone: a few partials, fast attack, exponential decay."""
    n = int(dur_s * SR)
    if n < 8:
        return
    i0 = int(start_s * SR)
    if i0 + n > buf.shape[0]:
        n = buf.shape[0] - i0
        if n < 8:
            return
    t = np.arange(n) / SR
    f = freq * (1.0 + detune)

    sig = np.zeros(n)
    for h, ha in ((1, 1.0), (2, 0.32), (3, 0.14), (4, 0.07), (5, 0.035)):
        if f * h > 16000:
            break
        sig += ha * np.sin(2 * np.pi * f * h * t)

    atk = max(1, min(n // 4, int(0.012 * SR)))
    env = np.exp(-t * (2.2 / max(dur_s, 0.25)))
    env[:atk] *= np.linspace(0.0, 1.0, atk)
    rel = max(1, min(n // 2, int(0.05 * SR)))
    env[-rel:] *= np.linspace(1.0, 0.0, rel)

    sig *= env * amp
    l, r = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
    buf[i0:i0 + n, 0] += sig * l
    buf[i0:i0 + n, 1] += sig * r


# -------------------------------------------------------------------- agents
class Agent:
    """One performer. Personality rolled once, from the shared seed."""
    def __init__(self, rng, idx, n_cells, patience_beats, born_beat):
        self.idx = idx
        self.n_cells = n_cells
        self.pos = 0                      # ABSOLUTE cell index; ring = pos % n
        self.patience = patience_beats * rng.uniform(0.7, 1.45)
        self.herding = rng.uniform(0.0, 1.0)
        self.detune = rng.normal(0.0, 0.0016)     # a few cents, fixed per voice
        self.pan = rng.uniform(-0.75, 0.75)
        self.offset = rng.uniform(0.0, 0.015)     # 0-15ms fixed pulse offset
        self.instrument = "tone"
        self.born_beat = born_beat
        self.next_decision = born_beat
        self.rng = rng

    def maybe_advance(self, beat, leader):
        """Advance within the legality window: never >1 ahead of the leader,
        never >3 behind it. Personality decides where inside that window the
        voice lives; the window itself is not negotiable."""
        if self.pos < leader - 3:
            self.pos += 1                          # forced catch-up
            return True
        if beat < self.next_decision:
            return False
        if self.pos + 1 > leader + 1:
            return False                           # would break the front bound
        drift = self.pos - leader
        eager = 0.5 + 0.5 * self.herding * (-drift / 3.0)
        if self.rng.random() < max(0.12, min(0.95, eager)):
            self.pos += 1
            return True
        self.next_decision = beat + self.patience * 0.4
        return False


def population_at(scenario, frac, n_max):
    if scenario == "ramp":
        return max(2, int(round(2 + (n_max - 2) * frac)))
    if scenario == "surge":
        return max(2, int(round(2 + (n_max - 2) * (np.sin(frac * np.pi) ** 1.5))))
    return n_max


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--score", default=str(pathlib.Path(__file__).parent / "demo-v1.json"))
    ap.add_argument("--seed", type=int, default=22)
    ap.add_argument("--seconds", type=float, default=100.0)
    ap.add_argument("--voices", type=int, default=12)
    ap.add_argument("--patience", type=float, default=18.0,
                    help="mean beats a voice dwells on a cell. Lower = the pack\n"
                         "moves around the ring faster. Use a low value to\n"
                         "audition the whole harmonic arc in one short take.")
    ap.add_argument("--scenario", default="ramp", choices=["ramp", "surge", "hold"])
    ap.add_argument("-o", "--out", default="take.wav")
    a = ap.parse_args()

    score = json.loads(pathlib.Path(a.score).read_text())
    rng = np.random.default_rng(a.seed)

    bpm = score["pulse"]["bpm"]
    spb = 60.0 / bpm
    fund = score["tuning"]["fundamental_hz"]
    cells = score["cells"]
    n_cells = len(cells)
    arc = np.array(score["arc"]["dynamics"])

    total = int(a.seconds * SR)
    buf = np.zeros((total, 2))
    total_beats = a.seconds / spb

    # agents are born across the render according to the scenario
    agents = []
    for i in range(a.voices):
        born_frac = 0.0 if i < 2 else (i / a.voices) * 0.72
        ag = Agent(rng, i, n_cells, patience_beats=a.patience,
                   born_beat=born_frac * total_beats)
        # Enter on a staggered beat, or voices sharing a cell play in unison
        # and the coprime cell lengths buy nothing.
        ag.born_beat += float(rng.integers(0, 7))
        ag.next_decision = ag.born_beat
        # Weighted draw from the score's instrument pool, same shape as the
        # conductor's, so an offline audition predicts the live stream.
        pool = score.get("instruments") or [{"id": "tone", "weight": 1}]
        r = rng.random() * sum(i.get("weight", 1) for i in pool)
        for inst in pool:
            r -= inst.get("weight", 1)
            if r <= 0:
                ag.instrument = inst["id"]
                break
        agents.append(ag)

    # --- the drone and the pulse: present from before anyone arrives --------
    t = np.arange(total) / SR
    drone = (0.055 * np.sin(2 * np.pi * fund * t)
             + 0.030 * np.sin(2 * np.pi * fund * 2 * t)
             + 0.014 * np.sin(2 * np.pi * fund * 3 * t))
    drone *= 0.75 + 0.25 * np.sin(2 * np.pi * 0.045 * t)
    buf[:, 0] += drone
    buf[:, 1] += drone

    pulse_hz = bpm / 60.0 * score["pulse"]["subdivision"]
    for k in range(int(a.seconds * pulse_hz)):
        render_note(buf, k / pulse_hz, fund * 16, 0.10, 0.030, 0.0, 0.0)

    # --- perform ------------------------------------------------------------
    # Time-ordered discrete-event simulation. Every agent must be advanced in
    # step with the others, otherwise "the leader" is read from a future the
    # other voices have not reached yet and the legality window means nothing.
    import heapq
    for ag in agents:
        ag.entered = 0
    heap = [(ag.born_beat, ag.idx) for ag in agents]
    heapq.heapify(heap)

    events = 0
    while heap:
        beat, idx = heapq.heappop(heap)
        if beat >= total_beats:
            continue
        ag = agents[idx]
        active = [o for o in agents if o.born_beat <= beat]
        leader = max(o.pos for o in active) if active else 0

        # A listener arriving mid-performance joins the ensemble where it
        # actually is, not at cell 1. Starting newcomers at the beginning
        # drags a straggler far outside the legality window and takes an
        # entire lap to resolve — audible as one voice playing unrelated
        # material under everyone else.
        if ag.entered == 0 and ag.born_beat > 0:
            ag.pos = max(0, leader - 1)

        cell = cells[ag.pos % n_cells]
        lap_frac = (ag.pos % n_cells) / n_cells
        gain = float(np.interp(lap_frac, arc[:, 0], arc[:, 1]))
        ag.entered += 1
        fade = min(1.0, ag.entered / 3.0)   # entrances crescendo over 3 reps

        for ev in cell["events"]:
            start = (beat + ev["at"]) * spb + ag.offset
            if start >= a.seconds:
                break
            amp = 0.30 * gain * fade / np.sqrt(max(1, len(agents)))
            renderer = render_bowed if ag.instrument == "bowed" else render_note
            renderer(buf, start, fund * ev["partial"], ev["dur"] * spb,
                     amp, ag.pan, ag.detune)
            events += 1

        nxt = beat + cell["beats"]
        ag.maybe_advance(nxt, leader)
        heapq.heappush(heap, (nxt, idx))

    peak = np.max(np.abs(buf))
    buf = np.tanh(buf * 1.35) * 0.92           # the master stage this needs anyway
    buf = buf / max(np.max(np.abs(buf)), 1e-9) * 0.89

    import wave
    with wave.open(a.out, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((buf * 32767).astype("<i2").tobytes())

    spread = sorted(set(ag.pos % n_cells for ag in agents))
    print(f"seed {a.seed} · {a.voices} voices · {events} notes · pre-limiter peak {peak:.2f}")
    print(f"final pack spread across cells: {spread}")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
