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
 */

/** Median of a non-empty list of minor units. Even lengths round half-even. */
export function medianMinor(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error('medianMinor: empty');
  const sorted = [...values].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as bigint;
  const low = sorted[mid - 1] as bigint;
  const high = sorted[mid] as bigint;
  const total = low + high;
  // Half-even on the .5 case, so a median of 1 and 2 is 2 and of 3 and 4 is 4.
  const quotient = total / 2n;
  if (total % 2n === 0n) return quotient;
  const away = total < 0n ? quotient - 1n : quotient + 1n;
  return quotient % 2n === 0n ? quotient : away;
}

/** Median absolute deviation from the median, in minor units. */
export function madMinor(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error('madMinor: empty');
  const centre = medianMinor(values);
  return medianMinor(values.map((value) => (value < centre ? centre - value : value - centre)));
}

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
