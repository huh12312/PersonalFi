// SPDX-License-Identifier: MIT
/**
 * xoshiro256++ seeded by SplitMix64 — the Monte Carlo's only source of
 * randomness, **written here and not imported** (dispatch §3 WP 4.5, §4 item 10).
 *
 * `packages/seed/src/prng.ts` explains why a PRNG is written in-repo: "identical
 * seed, identical bytes" is the property this engine is graded on (the §5 exit
 * criterion and the v0.6 rung), and a generator from npm would make the
 * definition of correctness a third party's. The dispatch rejects
 * `seedrandom`/`d3-random`/`random-js` by name for exactly that reason.
 *
 * ## The algorithms, verbatim from the reference C
 *
 * Blackman & Vigna, "Scrambled Linear Pseudorandom Number Generators" (2019),
 * `xoshiro256plusplus.c` and `splitmix64.c` from prng.di.unimi.it (public
 * domain, CC0):
 *
 * ```c
 * uint64_t next(void) {                       // xoshiro256++
 *   const uint64_t result = rotl(s[0] + s[3], 23) + s[0];
 *   const uint64_t t = s[1] << 17;
 *   s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
 *   s[2] ^= t;
 *   s[3] = rotl(s[3], 45);
 *   return result;
 * }
 * uint64_t next(void) {                       // splitmix64
 *   uint64_t z = (x += 0x9e3779b97f4a7c15);
 *   z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9;
 *   z = (z ^ (z >> 27)) * 0x94d049bb133111eb;
 *   return z ^ (z >> 31);
 * }
 * ```
 *
 * A double in `[0, 1)` is `(next() >> 11) × 2^−53` — Vigna's recommended
 * conversion. The committed vectors in `test/engine/fixtures/xoshiro-vectors.json`
 * were produced by compiling that C (`xoshiro-reference.c`, beside them), and
 * `reproducible.test.ts` asserts this implementation reproduces them word for
 * word.
 *
 * ## 64-bit arithmetic in 32-bit halves
 *
 * JavaScript has no `uint64` except `bigint`, and `bigint` in the inner loop is
 * two orders of magnitude too slow for 08 §7.2's 800 ms. Each 64-bit word is
 * therefore a (high, low) pair of `uint32` in a `Uint32Array`, and the
 * rotations, shifts, adds and the SplitMix64 multiply are written out on the
 * halves. Every intermediate stays below 2^53, so the `number` arithmetic is
 * exact; `>>> 0` truncates to 32 bits.
 *
 * ## Streams: why each path seeds its own generator
 *
 * Common random numbers (07 §5.4 detail 1) require that path *i*'s draws depend
 * on the seed and on *i* — never on how many paths ran before it, on the plan's
 * levers, or on whether crypto is present. So each path gets its own
 * xoshiro256++ state, seeded from four consecutive SplitMix64 outputs at a
 * position fixed by `(path, stream)`:
 *
 *     word k of the SplitMix64 sequence = mix(seed + (k + 1) × γ)
 *     path i, stream j  →  words 4 × (STREAMS × i + j) … + 3
 *
 * SplitMix64's state is a Weyl sequence, so word k is computed directly, in
 * O(1), without generating the words before it. Stream 0 is the market; stream
 * 1 is crypto — which is why a crypto draw can never shift an equity draw
 * (`crypto.test.ts`).
 */

/** Streams per path: 0 = market (equity, bonds, inflation), 1 = crypto. */
export const STREAMS_PER_PATH = 2;
export const MARKET_STREAM = 0;
export const CRYPTO_STREAM = 1;

/** SplitMix64's increment γ = 0x9e3779b97f4a7c15 (the golden ratio), as halves. */
const GAMMA_HI = 0x9e3779b9;
const GAMMA_LO = 0x7f4a7c15;
const MIX1_HI = 0xbf58476d;
const MIX1_LO = 0x1ce4e5b9;
const MIX2_HI = 0x94d049bb;
const MIX2_LO = 0x133111eb;

const TWO_POW_32 = 4_294_967_296;
const TWO_POW_21 = 2_097_152;
/** 2^−53: the spacing of doubles in [0.5, 1), and the unit of `nextDouble`. */
const TWO_POW_MINUS_53 = 1.1102230246251565e-16;
const TWO_PI = 2 * Math.PI;

/**
 * Doubles are produced `POOL_SIZE` at a time, with the state in local
 * variables, and handed out one by one: the *sequence* is exactly the
 * one-at-a-time sequence (the vectors test checks the doubles too), but the
 * state is loaded and stored once per 64 outputs instead of once per output —
 * a 4–5× difference that 08 §7.2's 800 ms budget needs.
 */
export const POOL_SIZE = 64;

/**
 * One generator. `s` holds the four 64-bit words as eight uint32 halves,
 * `s[2k]` high and `s[2k + 1]` low. `spare` caches Box-Muller's second normal
 * (08 §7.2: "cached Box-Muller pairs").
 */
export interface Xoshiro {
  readonly s: Uint32Array;
  /** Scratch for SplitMix64 and the multiply: never escapes. */
  readonly scratch: Uint32Array;
  /** Pre-generated doubles in `[0, 1)`, next at `poolAt`; `poolAt === POOL_SIZE` means empty. */
  readonly pool: Float64Array;
  poolAt: number;
  spare: number;
  hasSpare: boolean;
}

export function newXoshiro(): Xoshiro {
  return {
    s: new Uint32Array(8),
    scratch: new Uint32Array(4),
    pool: new Float64Array(POOL_SIZE),
    poolAt: POOL_SIZE,
    spare: 0,
    hasSpare: false,
  };
}

/**
 * A stored seed as its two uint32 halves. The seed is a `bigint` because it is
 * a Postgres `BIGINT` on `projection_runs` (04 §5.6, WP 4.6); the host refuses
 * anything outside the signed 64-bit range before it gets here, so the
 * two's-complement reinterpretation below is a bijection on legal seeds.
 */
export function seedHalves(seed: bigint): readonly [number, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt.asUintN(64, seed));
  return [view.getUint32(0), view.getUint32(4)];
}

/** Low 64 bits of (ah·2^32 + al) × (bh·2^32 + bl), into out[0] (high), out[1] (low). */
function mulLo64(ah: number, al: number, bh: number, bl: number, out: Uint32Array): void {
  // al × bl in full: 16-bit limbs keep every partial product below 2^33.
  const a0 = al & 0xffff;
  const a1 = al >>> 16;
  const b0 = bl & 0xffff;
  const b1 = bl >>> 16;
  const cross = a0 * b1 + a1 * b0; // < 2^33
  const low = a0 * b0 + (cross % 65_536) * 65_536; // < 2^33
  const carry = Math.floor(low / TWO_POW_32);
  const high = a1 * b1 + Math.floor(cross / 65_536) + carry; // < 2^33
  out[1] = low >>> 0;
  // The cross terms ah × bl and al × bh land entirely in the high word, mod 2^32.
  out[0] = (high + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}

/**
 * SplitMix64 word `k` for `seed`: mix(seed + (k + 1) × γ). Written into
 * `out[0]` (high) and `out[1]` (low). `k` is a non-negative integer below 2^53.
 */
export function splitMix64Word(
  seedHi: number,
  seedLo: number,
  k: number,
  out: Uint32Array,
): void {
  const step = k + 1;
  const stepHi = Math.floor(step / TWO_POW_32) >>> 0;
  const stepLo = step >>> 0;
  // x = seed + step × γ  (mod 2^64)
  mulLo64(stepHi, stepLo, GAMMA_HI, GAMMA_LO, out);
  const sumLo = seedLo + (out[1] ?? 0);
  let hi = (seedHi + (out[0] ?? 0) + (sumLo >= TWO_POW_32 ? 1 : 0)) >>> 0;
  let lo = sumLo >>> 0;
  // z = (z ^ (z >> 30)) × 0xbf58476d1ce4e5b9
  lo = (lo ^ ((lo >>> 30) | (hi << 2))) >>> 0;
  hi = (hi ^ (hi >>> 30)) >>> 0;
  mulLo64(hi, lo, MIX1_HI, MIX1_LO, out);
  hi = out[0] ?? 0;
  lo = out[1] ?? 0;
  // z = (z ^ (z >> 27)) × 0x94d049bb133111eb
  lo = (lo ^ ((lo >>> 27) | (hi << 5))) >>> 0;
  hi = (hi ^ (hi >>> 27)) >>> 0;
  mulLo64(hi, lo, MIX2_HI, MIX2_LO, out);
  hi = out[0] ?? 0;
  lo = out[1] ?? 0;
  // z ^ (z >> 31)
  out[1] = (lo ^ ((lo >>> 31) | (hi << 1))) >>> 0;
  out[0] = (hi ^ (hi >>> 31)) >>> 0;
}

/**
 * Seed `g` for one (path, stream): four consecutive SplitMix64 words, at the
 * position the header fixes. Resets the Box-Muller cache, so a path's normals
 * never depend on the previous path.
 */
export function seedStream(
  g: Xoshiro,
  seedHi: number,
  seedLo: number,
  path: number,
  stream: number,
): void {
  const first = 4 * (STREAMS_PER_PATH * path + stream);
  for (let w = 0; w < 4; w += 1) {
    splitMix64Word(seedHi, seedLo, first + w, g.scratch);
    g.s[2 * w] = g.scratch[0] ?? 0;
    g.s[2 * w + 1] = g.scratch[1] ?? 0;
  }
  // The all-zero state is xoshiro's one fixed point; SplitMix64 cannot emit four
  // zero words in a row for any seed, but the guard costs nothing.
  if ((g.s[0] | g.s[1] | g.s[2] | g.s[3] | g.s[4] | g.s[5] | g.s[6] | g.s[7]) === 0) g.s[7] = 1;
  g.poolAt = POOL_SIZE;
  g.spare = 0;
  g.hasSpare = false;
}

/**
 * Advance and return the next 64-bit output as halves in `out` (high, low).
 * The reference algorithm, on halves, one output at a time — the readable
 * form, which the vectors test pins and `refill` below must agree with. A
 * generator is driven through `nextWord` or through `nextDouble`, never both:
 * the pool would otherwise hold doubles from states `nextWord` has passed.
 */
export function nextWord(g: Xoshiro, out: Uint32Array): void {
  if (g.poolAt !== POOL_SIZE) throw new Error('nextWord on a generator with pooled doubles');
  const s = g.s;
  const s0h = s[0] ?? 0;
  const s0l = s[1] ?? 0;
  const s1h = s[2] ?? 0;
  const s1l = s[3] ?? 0;
  const s2h = s[4] ?? 0;
  const s2l = s[5] ?? 0;
  const s3h = s[6] ?? 0;
  const s3l = s[7] ?? 0;

  // result = rotl(s0 + s3, 23) + s0
  const addLo = s0l + s3l;
  const addHi = (s0h + s3h + (addLo >= TWO_POW_32 ? 1 : 0)) >>> 0;
  const aLo = addLo >>> 0;
  const rotHi = ((addHi << 23) | (aLo >>> 9)) >>> 0;
  const rotLo = ((aLo << 23) | (addHi >>> 9)) >>> 0;
  const resLo = rotLo + s0l;
  out[0] = (rotHi + s0h + (resLo >= TWO_POW_32 ? 1 : 0)) >>> 0;
  out[1] = resLo >>> 0;

  // t = s1 << 17
  const tHi = ((s1h << 17) | (s1l >>> 15)) >>> 0;
  const tLo = (s1l << 17) >>> 0;
  // s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 45)
  let n2h = (s2h ^ s0h) >>> 0;
  let n2l = (s2l ^ s0l) >>> 0;
  const n3h = (s3h ^ s1h) >>> 0;
  const n3l = (s3l ^ s1l) >>> 0;
  const n1h = (s1h ^ n2h) >>> 0;
  const n1l = (s1l ^ n2l) >>> 0;
  const n0h = (s0h ^ n3h) >>> 0;
  const n0l = (s0l ^ n3l) >>> 0;
  n2h = (n2h ^ tHi) >>> 0;
  n2l = (n2l ^ tLo) >>> 0;
  // rotl by 45 = swap the halves, then rotl by 13.
  s[6] = ((n3l << 13) | (n3h >>> 19)) >>> 0;
  s[7] = ((n3h << 13) | (n3l >>> 19)) >>> 0;
  s[0] = n0h;
  s[1] = n0l;
  s[2] = n1h;
  s[3] = n1l;
  s[4] = n2h;
  s[5] = n2l;
}

/**
 * `POOL_SIZE` outputs of the same algorithm as `nextWord`, each converted to a
 * double, with the state in locals. The halves are kept in **int32**
 * representation here (`| 0`, and a carry is an unsigned compare of the
 * truncated sum) because V8 keeps int32 locals in registers where a uint32
 * above 2^31 becomes a double — measured 25 % faster, identical outputs (the
 * vectors test checks 70 doubles, across a refill boundary).
 */
function refill(g: Xoshiro): void {
  const s = g.s;
  const pool = g.pool;
  let s0h = (s[0] ?? 0) | 0;
  let s0l = (s[1] ?? 0) | 0;
  let s1h = (s[2] ?? 0) | 0;
  let s1l = (s[3] ?? 0) | 0;
  let s2h = (s[4] ?? 0) | 0;
  let s2l = (s[5] ?? 0) | 0;
  let s3h = (s[6] ?? 0) | 0;
  let s3l = (s[7] ?? 0) | 0;
  for (let k = 0; k < POOL_SIZE; k += 1) {
    // result = rotl(s0 + s3, 23) + s0
    const aLo = (s0l + s3l) | 0;
    const aHi = (s0h + s3h + (aLo >>> 0 < s0l >>> 0 ? 1 : 0)) | 0;
    const rotHi = (aHi << 23) | (aLo >>> 9);
    const rotLo = (aLo << 23) | (aHi >>> 9);
    const outLo = (rotLo + s0l) | 0;
    const outHi = (rotHi + s0h + (outLo >>> 0 < rotLo >>> 0 ? 1 : 0)) | 0;
    pool[k] = ((outHi >>> 0) * TWO_POW_21 + (outLo >>> 11)) * TWO_POW_MINUS_53;
    // t = s1 << 17; s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t; s3 = rotl(s3, 45)
    const tHi = (s1h << 17) | (s1l >>> 15);
    const tLo = s1l << 17;
    const n2h = s2h ^ s0h;
    const n2l = s2l ^ s0l;
    const n3h = s3h ^ s1h;
    const n3l = s3l ^ s1l;
    s1h ^= n2h;
    s1l ^= n2l;
    s0h ^= n3h;
    s0l ^= n3l;
    s2h = n2h ^ tHi;
    s2l = n2l ^ tLo;
    s3h = (n3l << 13) | (n3h >>> 19);
    s3l = (n3h << 13) | (n3l >>> 19);
  }
  s[0] = s0h;
  s[1] = s0l;
  s[2] = s1h;
  s[3] = s1l;
  s[4] = s2h;
  s[5] = s2l;
  s[6] = s3h;
  s[7] = s3l;
  g.poolAt = 0;
}

/** A double in `[0, 1)`: the top 53 bits of the next output × 2^−53. */
export function nextDouble(g: Xoshiro): number {
  if (g.poolAt === POOL_SIZE) refill(g);
  const u = g.pool[g.poolAt] ?? 0;
  g.poolAt += 1;
  return u;
}

/**
 * A chi-square(2) variate, −2 ln u: the squared radius of a Box-Muller pair,
 * without the angle. `1 − u` keeps the log finite.
 */
export function nextChiSquare2(g: Xoshiro): number {
  return -2 * Math.log(1 - nextDouble(g));
}

/** An integer in `[0, n)`. The modulo bias at n ≈ 2,000 is below 2^−42 and is not worth a rejection loop. */
export function nextIndex(g: Xoshiro, n: number): number {
  return Math.floor(nextDouble(g) * n);
}

/**
 * A standard normal by Box-Muller, the pair's second half cached. `1 − u` puts
 * the log's argument in (0, 1], so the draw is always finite.
 */
export function nextNormal(g: Xoshiro): number {
  if (g.hasSpare) {
    g.hasSpare = false;
    return g.spare;
  }
  const u1 = 1 - nextDouble(g);
  const u2 = nextDouble(g);
  const radius = Math.sqrt(-2 * Math.log(u1));
  const angle = TWO_PI * u2;
  g.spare = radius * Math.sin(angle);
  g.hasSpare = true;
  return radius * Math.cos(angle);
}
