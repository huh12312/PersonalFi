// SPDX-License-Identifier: MIT
/**
 * Robust statistics over exact `bigint` amounts.
 *
 * A bigint median existed twice before this file: `@ctx/recurring`'s
 * `src/stats.ts` (the amount-model classifier) and `@ctx/planning`'s
 * `src/windows.ts` (the one-off detector), and `windows.ts`'s own header
 * explains why it could not import the other — a cross-context boundary the
 * lint forbids, and a rounding mode (`recurring`'s rounds half-even to a whole
 * minor unit) the exact one-off test could not use. WP 5.7's anomaly baseline
 * is a third caller with the same need, so this is the shared home the two
 * carries there both name: `@core/kernel`, importable by every context,
 * dependent on nothing but the language.
 *
 * **Median and MAD, not mean and standard deviation.** 04 §5.1: one
 * double-posted month otherwise destroys the estimate, and a double-posted
 * month is a thing that happens. Both are exact over `bigint` and never pass
 * through a `number` — the input, the sort, the midpoint arithmetic and the
 * output are all integers. A caller that needs a *ratio* (how many MADs an
 * amount sits from the median, a percentage, a confidence score) computes it
 * at its own boundary, once, the same way `Money`'s ratio-returning callers do
 * — the exactness this module promises is about the statistic, not about
 * whatever a caller renders from it.
 *
 * `medianMinor` rounds a two-element midpoint half-even, to a whole unit — the
 * `@ctx/recurring` convention, carried forward because every existing caller
 * of that shape expects a minor-unit answer, not a fraction. A caller that
 * needs the *exact* rational midpoint (`@ctx/planning`'s one-off detector
 * compares against `2 × median` without rounding first) sums the two middle
 * values itself with `twiceMedianMinor` rather than reconstructing it from a
 * rounded answer — reconstructing loses precisely the half-unit the exact
 * comparison needs.
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

/**
 * `2 × median`, exact for an even-length list — never a rounded median
 * doubled back. Equal to `2 × medianMinor(values)` for an odd-length list.
 */
export function twiceMedianMinor(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error('twiceMedianMinor: empty');
  const sorted = [...values].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return 2n * (sorted[mid] as bigint);
  return (sorted[mid - 1] as bigint) + (sorted[mid] as bigint);
}

/** Median absolute deviation from the median, in minor units. Exact bigint throughout. */
export function madMinor(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new Error('madMinor: empty');
  const centre = medianMinor(values);
  return medianMinor(values.map((value) => (value < centre ? centre - value : value - centre)));
}

/** Median of a list of plain numbers (day counts, residuals) — not a money path. */
export function medianNumber(values: readonly number[]): number {
  if (values.length === 0) throw new Error('medianNumber: empty');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) as number;
}

/** Median absolute deviation over plain numbers. */
export function madNumber(values: readonly number[]): number {
  if (values.length === 0) throw new Error('madNumber: empty');
  const centre = medianNumber(values);
  return medianNumber(values.map((value) => Math.abs(value - centre)));
}

/** Namespace form, for call sites that prefer `Stats.medianMinor(values)`. */
export const Stats = {
  medianMinor,
  twiceMedianMinor,
  madMinor,
  medianNumber,
  madNumber,
} as const;
