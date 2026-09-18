// SPDX-License-Identifier: MIT
/**
 * A seeded PRNG, so the corpus is a fixture and not a lottery.
 *
 * `mulberry32` — 32-bit state, one multiply-xor round, uniform enough for
 * jitter and amounts and small enough to read. `Math.random()` would make the
 * golden gate flap: a precision figure that changes between runs cannot be a
 * regression gate, and a failure nobody can reproduce gets muted within a week.
 *
 * Every draw the generator makes goes through one of these, seeded from a
 * constant in `synthetic.ts`. Change the seed and you get a different corpus
 * with the same statistics — which is the honest way to check that the gate is
 * measuring the detector and not one lucky arrangement of dates.
 */

export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[low, high]`. */
  int(low: number, high: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T;
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
  };
}
