// The agent simulation and the pulse clock.
//
// Every voice is performed by an agent (PRD §2). Listeners attach to one and
// override a few of its parameters; the orchestra performs with nobody
// present, which is what makes the piece work at 4am (D1).
//
// Two seams matter here and are deliberate:
//   * `clock` is injected, never read from Date directly, so the same
//     sequencer can be driven by a virtual clock faster than real time for
//     offline rendering (T3).
//   * `sink` is injected, so the same sequencer can emit UDP to a live
//     scsynth or an OSC file for an NRT render (T2).
// Reaching for Date.now() or the udp port inside this file breaks both.

const VOICE_GROUP = 1;

class Agent {
  constructor(rng, id, human) {
    this.id = id;
    this.human = !!human;
    this.rng = rng;
    this.pos = 0;             // ABSOLUTE cell index; the ring is pos % nCells
    this.nextBeat = 0;        // beat at which its current cell next starts
    this.entered = 0;         // repetitions since arriving on this cell
    this.leaving = false;
    this.bright = 0.5;        // the listener's one live control
    this.nextDecision = 0;

    // Personality, rolled once from this agent's own substream.
    this.patienceMul = rng.range(0.7, 1.45);
    this.herding = rng.next();
    this.detune = rng.gauss(0, 0.0016);   // a few cents, fixed for life
    this.pan = rng.range(-0.75, 0.75);
    this.offset = rng.range(0, 0.015);    // fixed 0-15ms pulse offset
  }
}

class Sequencer {
  constructor({ score, rng, sink, clock, log = () => {}, core = 5,
                baseDwell = 16, voiceAmp = 0.5, lookaheadSeconds = 0.35 }) {
    this.score = score;
    this.rng = rng;
    this.sink = sink;
    this.clock = clock;
    this.log = log;
    this.baseDwell = baseDwell;
    this.voiceAmp = voiceAmp;
    this.lookaheadBeats = lookaheadSeconds / score.secondsPerBeat;
    this.agents = [];
    this.nextIndex = 0;
    this.started = false;
    this.coreCount = core;
  }

  start() {
    this.t0 = this.clock.nowSeconds();
    this.started = true;
    // The core group: agents that perform regardless of who is listening.
    for (let i = 0; i < this.coreCount; i++) this.addAgent(false);
    this.log(`[seq] started · ${this.coreCount} core agents · seed ${this.rng.seed}`);
  }

  nowBeat() {
    return (this.clock.nowSeconds() - this.t0) / this.score.secondsPerBeat;
  }

  leader() {
    let m = 0;
    for (const a of this.agents) if (a.pos > m) m = a.pos;
    return m;
  }

  // Bigger orchestras dwell longer on each cell, on a saturating curve, so a
  // dense texture is actually heard rather than flickering past.
  dwell() {
    return this.baseDwell * (1 + 0.55 * Math.log2(1 + this.agents.length / 4));
  }

  addAgent(human) {
    const idx = this.nextIndex++;
    const ag = new Agent(this.rng.fork(idx), idx, human);
    // Arrive where the ensemble actually is, not at cell 1. Starting a
    // newcomer at the beginning strands it far outside the legality window
    // and takes a whole lap to resolve — audible as one voice playing
    // unrelated material underneath everyone else.
    ag.pos = Math.max(0, this.leader() - 1);
    ag.nextBeat = Math.ceil(this.nowBeat()) + 1;
    ag.nextDecision = ag.nextBeat;
    this.agents.push(ag);
    return ag;
  }

  // Departures are performed, not switched: the voice finishes the repetition
  // it is in, then goes.
  releaseAgent(ag) {
    if (ag) ag.leaving = true;
  }

  cellFor(ag) {
    const n = this.score.nCells;
    return this.score.cells[((ag.pos % n) + n) % n];
  }

  maybeAdvance(ag, beat) {
    const leader = this.leader();
    if (ag.pos < leader - 3) {          // hard trailing bound: forced catch-up
      ag.pos++; ag.entered = 0; return;
    }
    if (beat < ag.nextDecision) return;
    if (ag.pos + 1 > leader + 1) return; // hard leading bound
    const drift = ag.pos - leader;
    const eager = 0.5 + 0.5 * ag.herding * (-drift / 3);
    if (ag.rng.next() < Math.max(0.12, Math.min(0.95, eager))) {
      ag.pos++; ag.entered = 0;
      ag.nextDecision = beat + this.dwell() * ag.patienceMul;
    } else {
      ag.nextDecision = beat + this.dwell() * ag.patienceMul * 0.4;
    }
  }

  scheduleCell(ag, startBeat) {
    const s = this.score;
    const cell = this.cellFor(ag);
    ag.entered++;
    const fade = Math.min(1, ag.entered / 3);          // entrances crescendo
    const exit = ag.leaving ? 0.45 : 1;                 // departures decrescendo
    const gain = s.arcAt((ag.pos % s.nCells) / s.nCells);
    const amp =
      (this.voiceAmp * gain * fade * exit) / Math.sqrt(Math.max(1, this.agents.length));

    const nb = this.nowBeat();
    for (const ev of cell.events) {
      const dt = (startBeat + ev.at - nb) * s.secondsPerBeat + ag.offset;
      if (dt < 0) continue;
      this.sink.bundle(dt, [
        ["/s_new", "tone", -1, 0, VOICE_GROUP,
         "freq", s.hz(ev.partial) * (1 + ag.detune),
         "amp", amp,
         "dur", ev.dur * s.secondsPerBeat,
         "pan", ag.pan,
         "bright", ag.bright],
      ]);
    }
    return cell;
  }

  tick() {
    if (!this.started) return;
    const horizon = this.nowBeat() + this.lookaheadBeats;
    for (const ag of [...this.agents]) {
      let guard = 0;
      while (ag.nextBeat < horizon && guard++ < 32) {
        const cell = this.scheduleCell(ag, ag.nextBeat);
        ag.nextBeat += cell.beats;
        if (ag.leaving) {
          this.agents = this.agents.filter((x) => x !== ag);
          this.log(`[seq] agent ${ag.id} left the ensemble`);
          break;
        }
        this.maybeAdvance(ag, ag.nextBeat);
      }
    }
  }

  snapshot() {
    const s = this.score;
    return this.agents.map((ag) => {
      const cell = this.cellFor(ag);
      const partial = cell.events.length ? cell.events[0].partial : 8;
      const freq = s.hz(partial);
      return {
        id: ag.id,
        human: ag.human,
        cell: (ag.pos % s.nCells) + 1,
        phase: cell.phase,
        partial,
        freq: Math.round(freq * 10) / 10,
        hue: Math.round(((((Math.log2(freq) % 1) + 1) % 1) * 360)),
        bright: ag.bright,
        leaving: ag.leaving,
      };
    });
  }

  lapInfo() {
    const s = this.score;
    const lead = this.leader();
    return {
      cells: s.nCells,
      lap: Math.floor(lead / s.nCells) + 1,
      leadCell: (lead % s.nCells) + 1,
      phase: s.cells[lead % s.nCells].phase,
      bpm: s.pulse.bpm,
      seed: this.rng.seed,
    };
  }
}

module.exports = { Sequencer, VOICE_GROUP };
