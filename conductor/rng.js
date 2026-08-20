// Seeded randomness. THE ONLY source of entropy in the conductor (T1).
//
// Every render and every production lap logs its seed, so a lap worth
// studying can be re-rendered exactly, and score v2 can be A/B'd against v1
// with agent behaviour held constant. Bare Math.random() anywhere in this
// process breaks that guarantee silently — there is no test that catches it,
// only the day you cannot reproduce something you needed.

function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    gauss(mu, sd) {
      const u = Math.max(next(), 1e-9);
      return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    // A stable substream per index. An agent's personality then depends only
    // on its own index, not on how many agents were created before it — so
    // one extra listener does not reshuffle everybody else's character.
    fork: (n) => makeRng((seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0),
  };
}

module.exports = { makeRng };
