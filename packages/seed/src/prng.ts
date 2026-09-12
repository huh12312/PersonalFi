// SPDX-License-Identifier: MIT

/**
 * A small, deterministic PRNG and the helpers built on it.
 *
 * Not `Math.random()` (unseedable, and banned here for exactly that reason —
 * the entire point of this package is "identical seed, identical bytes", the
 * same property Phase 4's Monte Carlo engine is graded on). Not a dependency
 * either: `mulberry32` is twelve lines, public-domain-grade, and pulling in a
 * package for it would be a stranger trade than writing it, per D14's
 * dependency-count budget.
 *
 * `mulberry32` (Tommy Ettinger, public domain) is not cryptographically secure
 * and must never be used for anything security-sensitive — it is exactly
 * sufficient for "shuffle a list of merchants the same way twice".
 */
export type Rng = () => number;

/** A 32-bit generator seeded by one integer. `next()` returns `[0, 1)`. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Integer in `[min, max]`, inclusive on both ends. */
export function randomInt(rng: Rng, min: number, max: number): number {
  if (max < min) throw new RangeError(`randomInt: max (${max}) < min (${min})`);
  return min + Math.floor(rng() * (max - min + 1));
}

/** Float in `[min, max)`. */
export function randomFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** True with probability `p` (`0..1`). */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** One element, uniformly. Throws on an empty array — there is no sane default. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick: items must not be empty');
  const index = randomInt(rng, 0, items.length - 1);
  const item = items[index];
  if (item === undefined) throw new RangeError('pick: index out of range');
  return item;
}

/** `n` elements without replacement, order preserved from the shuffled draw. */
export function sample<T>(rng: Rng, items: readonly T[], n: number): T[] {
  if (n > items.length) {
    throw new RangeError(`sample: cannot draw ${n} from ${items.length} items`);
  }
  return shuffle(rng, items).slice(0, n);
}

/** Fisher–Yates, using `rng`. Does not mutate `items`. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, 0, i);
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/** A decimal amount string with `decimals` places, uniform over `[min, max]`. */
export function randomDecimal(rng: Rng, min: number, max: number, decimals = 2): string {
  const scale = 10 ** decimals;
  const value = Math.round(randomFloat(rng, min, max) * scale) / scale;
  return value.toFixed(decimals);
}

const HEX = '0123456789abcdef';

/**
 * A UUID-*shaped* id, drawn entirely from `rng`.
 *
 * Deliberately not `@core/kernel`'s `newId()`: that generates a real UUIDv7,
 * which embeds the wall-clock millisecond it was called at, and this
 * package's one hard requirement is "identical seed, identical bytes" — a
 * dataset generated at 09:00 and again at 17:00 from the same seed must be the
 * same dataset. Version nibble `4` and a valid variant nibble are set so the
 * result still round-trips through `@core/kernel`'s `isUuid`/`parseId`, but
 * nothing about it is cryptographically random or time-ordered.
 */
export function randomUuid(rng: Rng): string {
  const hex = (n: number): string => Array.from({ length: n }, () => pick(rng, [...HEX])).join('');
  const variant = pick(rng, ['8', '9', 'a', 'b']);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
