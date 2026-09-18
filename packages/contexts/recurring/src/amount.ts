// SPDX-License-Identifier: MIT
/**
 * The amount half of Stage 2: buckets, and the model a bucket follows.
 *
 * One merchant hosts several streams — Apple is iCloud $2.99, Apple TV+ $12.99
 * and a one-off app purchase in the same coarse group — so amounts are split
 * before cadence is ever considered (07 §2.2). The split rule is a *relative*
 * gap with an absolute floor, because 25% of $0.99 is 25 cents and would shatter
 * a cheap subscription into a bucket per cent of sales tax.
 *
 * All arithmetic is `bigint` minor units. The only float is the coefficient of
 * variation, which is a ratio and never becomes an amount.
 */

import { Money, minorUnitScale, type CurrencyCode } from '@core/kernel';
import { coefficientOfVariation, madMinor, medianMinor } from './stats.ts';
import type { AmountModel } from './types.ts';

/** 07 §2.2: split where the gap exceeds `max($2, 25% of the lower value)`. */
export const BUCKET_GAP_FLOOR_MAJOR = 2n;
export const BUCKET_GAP_FRACTION_PERCENT = 25n;

/** 07 §2.3: `cv ≤ 0.03` **or** a spread within $0.50 is FIXED. */
export const FIXED_CV = 0.03;
export const FIXED_SPREAD_MAJOR = 50n; // cents, i.e. $0.50 at scale 2
export const VARIABLE_CV = 0.35;

/** 04 §5.1: the tolerance band is `max(5% of median, $1.00)`. */
export const TOLERANCE_FRACTION_PERCENT = 5n;
export const TOLERANCE_FLOOR_MAJOR = 1n;

function majorToMinor(major: bigint, code: CurrencyCode): bigint {
  return major * 10n ** BigInt(minorUnitScale(code));
}

/** `$0.50` expressed in the currency's minor units (50 at scale 2, 0 at scale 0). */
function halfMajorToMinor(code: CurrencyCode): bigint {
  const scale = minorUnitScale(code);
  return scale === 0 ? 1n : (FIXED_SPREAD_MAJOR * 10n ** BigInt(scale)) / 100n;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Sort by magnitude and split where the gap is too large to be one stream.
 *
 * Returns index lists into `items`, ordered by the bucket's median magnitude, so
 * the bucket index is stable for a given input and can go into a stream key.
 */
export function bucketByAmount<T>(items: readonly T[], amountOf: (item: T) => Money): T[][] {
  if (items.length === 0) return [];
  const code = amountOf(items[0] as T).currency;
  const gapFloor = majorToMinor(BUCKET_GAP_FLOOR_MAJOR, code);

  const sorted = [...items].sort((a, b) => {
    const left = magnitude(amountOf(a).minor);
    const right = magnitude(amountOf(b).minor);
    return left === right ? 0 : left < right ? -1 : 1;
  });

  const buckets: T[][] = [];
  let current: T[] = [];
  let previous: bigint | null = null;
  for (const item of sorted) {
    const value = magnitude(amountOf(item).minor);
    if (previous !== null) {
      const gap = value - previous;
      const threshold =
        gapFloor > (previous * BUCKET_GAP_FRACTION_PERCENT) / 100n
          ? gapFloor
          : (previous * BUCKET_GAP_FRACTION_PERCENT) / 100n;
      if (gap > threshold) {
        buckets.push(current);
        current = [];
      }
    }
    current.push(item);
    previous = value;
  }
  if (current.length > 0) buckets.push(current);
  return buckets;
}

export interface AmountProfile {
  readonly model: AmountModel;
  readonly typical: Money;
  readonly mad: Money;
  readonly cv: number;
  readonly tolerance: Money;
  readonly spread: Money;
}

export function profileAmounts(amounts: readonly Money[]): AmountProfile {
  if (amounts.length === 0) throw new Error('profileAmounts: empty');
  const code = (amounts[0] as Money).currency;
  const minors = amounts.map((amount) => amount.minor);
  const magnitudes = minors.map(magnitude);

  const typicalMinor = medianMinor(minors);
  const madValue = madMinor(minors);
  const cv = coefficientOfVariation(minors);

  let low = magnitudes[0] as bigint;
  let high = magnitudes[0] as bigint;
  for (const value of magnitudes) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const spread = high - low;

  const typicalMagnitude = magnitude(typicalMinor);
  const fractional = (typicalMagnitude * TOLERANCE_FRACTION_PERCENT) / 100n;
  const floor = majorToMinor(TOLERANCE_FLOOR_MAJOR, code);
  const tolerance = fractional > floor ? fractional : floor;

  const model: AmountModel =
    cv <= FIXED_CV || spread <= halfMajorToMinor(code)
      ? 'FIXED'
      : cv <= VARIABLE_CV
        ? 'VARIABLE'
        : 'IRREGULAR';

  return {
    model,
    typical: Money.of(typicalMinor, code),
    mad: Money.of(madValue, code),
    cv,
    tolerance: Money.of(tolerance, code),
    spread: Money.of(spread, code),
  };
}

/** Do two medians sit within `percent`% of each other? Exact, in minor units. */
export function withinPercent(a: Money, b: Money, percent: bigint): boolean {
  const left = magnitude(a.minor);
  const right = magnitude(b.minor);
  const base = left > right ? left : right;
  if (base === 0n) return true;
  const difference = left > right ? left - right : right - left;
  return difference * 100n <= base * percent;
}
