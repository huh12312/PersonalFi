// SPDX-License-Identifier: MIT
/**
 * Robust statistics, in the two number systems this engine is allowed to use.
 *
 * **Money is `bigint` minor units and stays that way.** `medianMinor`,
 * `madMinor` and every amount this module returns are exact integers; nothing
 * here ever converts an amount to a `number` and back. The one float is
 * `coefficientOfVariation`, which is a *ratio* — a dimensionless score used to
 * pick an `AmountModel` — and by construction it cannot flow into a `*_minor`
 * value: it is not a `Money` and there is no function here that turns it into
 * one (04 §2.3, CONVENTIONS "Money").
 *
 * Median and MAD rather than mean and standard deviation, because 04 §5.1 is
 * right: one double-posted month otherwise destroys the estimate, and a
 * double-posted month is a thing that happens.
 *
 * **`medianMinor` and `madMinor` now delegate to `@core/kernel`'s `stats.ts`
 * (WP 5.14).** This module carried its own byte-identical copy until then —
 * `@ctx/planning`'s `windows.ts` carried a second one, and `@ctx/insights`'s
 * anomaly baseline (WP 5.7) was a third caller with the same need, which is
 * what made `packages/kernel/src/stats.ts` the shared home. Re-exported under
 * their original names so every existing `from './stats.ts'` import in this
 * package is unchanged; the move is behaviour-preserving, proven by
 * `test/stats-kernel-parity.test.ts`.
 */
export { medianMinor, madMinor } from '@core/kernel';

/** Median of a list of plain numbers (day counts, residuals). */
export function medianNumber(values: readonly number[]): number {
  if (values.length === 0) throw new Error('medianNumber: empty');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) as number;
}

export function madNumber(values: readonly number[]): number {
  if (values.length === 0) throw new Error('madNumber: empty');
  const centre = medianNumber(values);
  return medianNumber(values.map((value) => Math.abs(value - centre)));
}

export function meanNumber(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * `stdev / mean` over absolute minor units.
 *
 * Computed from `Number(...)` of each magnitude, which is exact for every
 * amount below 2^53 minor units — $90 trillion. Above that the ratio is still
 * fine to three decimal places, and the ratio is all this is ever used for.
 */
export function coefficientOfVariation(values: readonly bigint[]): number {
  if (values.length === 0) return 0;
  const magnitudes = values.map((value) => Number(value < 0n ? -value : value));
  const mean = meanNumber(magnitudes);
  if (mean === 0) return 0;
  const variance = meanNumber(magnitudes.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance) / mean;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}
