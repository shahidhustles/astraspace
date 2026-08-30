// Seedable PRNG + the distributions the planners sample from.
//
// Everything humanized is randomized, but randomness is only useful here if it
// has the RIGHT SHAPE. Human timings are right-skewed (a floor, a long tail),
// not uniform: sampling uniformly is its own tell. So the planners never call
// a bare random() for a duration — they draw from logNormal/gamma, and from
// gauss for spatial jitter.
//
// Seedable so tests are deterministic (and so a session can carry one
// consistent "hand"); seeded from entropy in normal use, so no two sessions
// share a trajectory signature.

/** mulberry32 — small, fast, good enough for behavioral jitter (not crypto). */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const r = {
    next,
    /** Uniform in [lo, hi). */
    uniform: (lo, hi) => lo + next() * (hi - lo),
    /** Uniform integer in [lo, hi]. */
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    /** True with probability p. */
    chance: (p) => next() < p,
    /** One element of arr. */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Gaussian via Box-Muller. Used for spatial jitter. */
    gauss(mean = 0, sd = 1) {
      let u = 0, v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /**
     * Log-normal, parameterised by the median and a spread factor — the
     * natural shape for human inter-event delays: a hard floor, a fat tail.
     * `spread` ~1.2 is tight, ~1.6 is loose.
     */
    logNormal(median, spread = 1.35) {
      return median * Math.exp(r.gauss(0, Math.log(spread)));
    },
    /** Log-normal clamped to [lo, hi] — a delay that must stay in a band. */
    delay(median, spread, lo, hi) {
      return clamp(r.logNormal(median, spread), lo, hi);
    }
  };
  return r;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fresh entropy — a new "hand" per session. */
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * A per-session persona: humans are not i.i.d. across a session, they have a
 * consistent tempo and heaviness. Every planner scales its samples by these,
 * so one session runs slightly quicker/twitchier than another while each stays
 * internally consistent. This is what keeps the variance human-shaped rather
 * than just noisy.
 */
export function makePersona(rng) {
  return {
    speed: rng.uniform(0.82, 1.25),      // < 1 = faster mover
    steadiness: rng.uniform(0.7, 1.35),  // < 1 = less spatial jitter
    overshoot: rng.uniform(0.55, 1.45),  // propensity to overshoot + correct
    typeTempo: rng.uniform(0.8, 1.3)     // < 1 = faster typist
  };
}
