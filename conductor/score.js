// Score loading. The composition is data; changing the music never means
// touching the engine.
const fs = require("fs");
const path = require("path");

function loadScore(file) {
  const p = file || path.join(__dirname, "..", "score", "demo-v1.json");
  const s = JSON.parse(fs.readFileSync(p, "utf8"));

  if (!Array.isArray(s.cells) || !s.cells.length) throw new Error("score has no cells");
  if (!s.tuning || !s.tuning.fundamental_hz) throw new Error("score has no fundamental");

  s.nCells = s.cells.length;
  s.secondsPerBeat = 60 / s.pulse.bpm;
  s.arcPoints = (s.arc && s.arc.dynamics) || [[0, 1], [1, 1]];
  // pitch_hz = fundamental * partial. Every simultaneity is a subset of one
  // harmonic series, which is what makes adjacency compatibility automatic.
  s.hz = (partial) => s.tuning.fundamental_hz * partial;
  s.phaseOf = (pos) => s.cells[pos % s.nCells].phase;
  s.arcAt = (frac) => {
    const pts = s.arcPoints;
    for (let i = 1; i < pts.length; i++) {
      if (frac <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const t = x1 === x0 ? 0 : (frac - x0) / (x1 - x0);
        return y0 + (y1 - y0) * t;
      }
    }
    return pts[pts.length - 1][1];
  };
  return s;
}

module.exports = { loadScore };
