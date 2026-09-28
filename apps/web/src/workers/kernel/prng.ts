// SPDX-License-Identifier: MIT
/**
 * xoshiro256++ seeded by SplitMix64 — **a byte-for-byte port** of
 * `packages/contexts/planning/src/engine/prng.ts` (WP 4.5), trimmed to the
 * subset the client kernel's lognormal path uses (no `nextWord`, no
 * `nextIndex`, no `nextChiSquare2`: those exist only for the bootstrap engine
 * and the crypto sleeve, neither of which this worker runs — see
 * `kernel/montecarlo.ts`'s header for the scope and why).
 *
 * ## Why a port and not an import (WP 4.11 §"THE CLIENT MUST RUN THE SAME
 * KERNEL")
 *
 * `scripts/eslint-boundaries.js`'s `app` layer has `allow: null` — "composition
 * root: allowed to wire anything together" — so the layer rule itself does
 * **not** forbid `apps/web` importing `@ctx/planning`. What forbids it in
 * practice is `apps/web/package.json`: it does not declare `@ctx/planning` as
 * a dependency (only `apps/api` does), so there is no
 * `apps/web/node_modules/@ctx/planning` symlink for pnpm to resolve — a build
 * error, not a lint error, and one this WP's rules (no `package.json` edits)
 * cannot fix. See `docs/evidence/phase-4/wp4.11-client-worker.md` §"For the
 * orchestrator" for the proposed seam (`@core/projection-kernel`, hoisting
 * this file and `deterministic.ts`/`montecarlo.ts`'s ported subset out of
 * both `@ctx/planning` and `apps/web` into one package both can depend on).
 * Until that lands, this file and its siblings under `kernel/` are a
 * **deliberate, documented duplication**: every arithmetic line below is
 * transcribed from the server file so the two stay bit-identical, proven by
 * `../projection.worker.test.ts`'s golden-vector reproduction. A change to
 * the server's `prng.ts` that is not mirrored here is exactly the drift this
 * WP's golden vector exists to catch.
 *
 * Everything below this point is the server file's own math, unchanged.
 * Original doc comment (algorithms, 64-bit-in-32-bit-halves rationale,
 * stream derivation) lives at the source above; repeating it here would be
 * the drift risk this file's own header just warned about, so it is not
 * duplicated — read the source for the "why", this file is the "what".
 */

const GAMMA_HI = 0x9e3779b9;
const GAMMA_LO = 0x7f4a7c15;
const MIX1_HI = 0xbf58476d;
const MIX1_LO = 0x1ce4e5b9;
const MIX2_HI = 0x94d049bb;
const MIX2_LO = 0x133111eb;

const TWO_POW_32 = 4_294_967_296;
const TWO_POW_21 = 2_097_152;
const TWO_POW_MINUS_53 = 1.1102230246251565e-16;
const TWO_PI = 2 * Math.PI;

export const POOL_SIZE = 64;
export const STREAMS_PER_PATH = 2;
export const MARKET_STREAM = 0;

export interface Xoshiro {
  readonly s: Uint32Array;
  readonly scratch: Uint32Array;
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

export function canonicalSeed(seed: bigint): bigint {
  return BigInt.asUintN(64, seed);
}

export function seedHalves(seed: bigint): readonly [number, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt.asUintN(64, seed));
  return [view.getUint32(0), view.getUint32(4)];
}

function mulLo64(ah: number, al: number, bh: number, bl: number, out: Uint32Array): void {
  const a0 = al & 0xffff;
  const a1 = al >>> 16;
  const b0 = bl & 0xffff;
  const b1 = bl >>> 16;
  const cross = a0 * b1 + a1 * b0;
  const low = a0 * b0 + (cross % 65_536) * 65_536;
  const carry = Math.floor(low / TWO_POW_32);
  const high = a1 * b1 + Math.floor(cross / 65_536) + carry;
  out[1] = low >>> 0;
  out[0] = (high + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}

function splitMix64Word(seedHi: number, seedLo: number, k: number, out: Uint32Array): void {
  const step = k + 1;
  const stepHi = Math.floor(step / TWO_POW_32) >>> 0;
  const stepLo = step >>> 0;
  mulLo64(stepHi, stepLo, GAMMA_HI, GAMMA_LO, out);
  const sumLo = seedLo + (out[1] ?? 0);
  let hi = (seedHi + (out[0] ?? 0) + (sumLo >= TWO_POW_32 ? 1 : 0)) >>> 0;
  let lo = sumLo >>> 0;
  lo = (lo ^ ((lo >>> 30) | (hi << 2))) >>> 0;
  hi = (hi ^ (hi >>> 30)) >>> 0;
  mulLo64(hi, lo, MIX1_HI, MIX1_LO, out);
  hi = out[0] ?? 0;
  lo = out[1] ?? 0;
  lo = (lo ^ ((lo >>> 27) | (hi << 5))) >>> 0;
  hi = (hi ^ (hi >>> 27)) >>> 0;
  mulLo64(hi, lo, MIX2_HI, MIX2_LO, out);
  hi = out[0] ?? 0;
  lo = out[1] ?? 0;
  out[1] = (lo ^ ((lo >>> 31) | (hi << 1))) >>> 0;
  out[0] = (hi ^ (hi >>> 31)) >>> 0;
}

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
  let any = 0;
  for (let h = 0; h < 8; h += 1) any |= g.s[h] ?? 0;
  if (any === 0) g.s[7] = 1;
  g.poolAt = POOL_SIZE;
  g.spare = 0;
  g.hasSpare = false;
}

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
    const aLo = (s0l + s3l) | 0;
    const aHi = (s0h + s3h + (aLo >>> 0 < s0l >>> 0 ? 1 : 0)) | 0;
    const rotHi = (aHi << 23) | (aLo >>> 9);
    const rotLo = (aLo << 23) | (aHi >>> 9);
    const outLo = (rotLo + s0l) | 0;
    const outHi = (rotHi + s0h + (outLo >>> 0 < rotLo >>> 0 ? 1 : 0)) | 0;
    pool[k] = ((outHi >>> 0) * TWO_POW_21 + (outLo >>> 11)) * TWO_POW_MINUS_53;
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

export function nextDouble(g: Xoshiro): number {
  if (g.poolAt === POOL_SIZE) refill(g);
  const u = g.pool[g.poolAt] ?? 0;
  g.poolAt += 1;
  return u;
}

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
