// Deterministic pseudo-random number generation.
//
// Nothing inside the simulation may call Math.random(), Date.now() or any
// other source of ambient entropy: a seed string must always reproduce the
// same planet, on any machine, at any display refresh rate.

/** FNV-1a over a string -> unsigned 32 bit. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** sfc32 — small, fast, well distributed, trivially serialisable. */
export class Rng {
  constructor(seed) {
    if (seed && typeof seed === 'object') {
      this.a = seed.a >>> 0; this.b = seed.b >>> 0;
      this.c = seed.c >>> 0; this.d = seed.d >>> 0;
      return;
    }
    const s = String(seed);
    this.a = hashString('a|' + s);
    this.b = hashString('b|' + s);
    this.c = hashString('c|' + s);
    this.d = hashString('d|' + s);
    // Discard early output so that similar seeds diverge immediately.
    for (let i = 0; i < 16; i++) this.next();
  }

  /** Uniform in [0,1). */
  next() {
    let t = (this.a + this.b) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    this.d = (this.d + 0x9e3779b9) >>> 0;
    t = (t + this.d) >>> 0;
    return t / 4294967296;
  }

  /** Uniform in [lo,hi). */
  range(lo, hi) { return lo + (hi - lo) * this.next(); }

  /** Integer in [0,n). */
  int(n) { return Math.min(n - 1, Math.floor(this.next() * n)); }

  /** Standard normal (Box-Muller, uncached: a cached spare would survive
   *  into a snapshot and break replay). */
  normal(mean = 0, sd = 1) {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  chance(p) { return this.next() < p; }

  pick(arr) { return arr[this.int(arr.length)]; }

  /** An independent stream derived deterministically from this one. */
  fork(tag) {
    return new Rng({
      a: (this.a ^ hashString('f|' + tag)) >>> 0,
      b: (this.b + hashString('o|' + tag)) >>> 0,
      c: (this.c ^ hashString('r|' + tag)) >>> 0,
      d: (this.d + hashString('k|' + tag)) >>> 0,
    });
  }

  save() { return { a: this.a, b: this.b, c: this.c, d: this.d }; }
  static load(s) { return new Rng({ a: s.a, b: s.b, c: s.c, d: s.d }); }
}

/** State fingerprint used by the determinism tests and by the
 *  "same seed, same planet" guarantee shown in the UI.
 *  Values are quantised: float noise below 1e-6 is not meaningful and
 *  would make the fingerprint useless for comparing runs. */
export function hashNumbers(values, seed = 0x2545f491) {
  let h = seed >>> 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const q = Number.isFinite(v) ? Math.round(v * 1e6) : 0;
    h = (h ^ (q >>> 0)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (((h << 13) | (h >>> 19)) >>> 0);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
