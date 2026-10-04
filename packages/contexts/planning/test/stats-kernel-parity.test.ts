// SPDX-License-Identifier: MIT
/**
 * WP 5.14: `src/windows.ts`'s `twiceMedian` used to carry its own bigint
 * "twice the median" arithmetic because `@core/kernel`'s `stats.ts` did not
 * exist yet (its own header explained why `@ctx/recurring`'s copy could not
 * be reused either). It now delegates to the kernel's `twiceMedianMinor`,
 * keeping only its own `RangeError` on empty input. This test is the proof
 * that the move changed nothing observable, over the same fixed vectors —
 * including the even-length "exact half" cases the one-off detector depends
 * on never being rounded.
 */
import { describe, expect, it } from 'vitest';

import { twiceMedianMinor } from '@core/kernel';

import { twiceMedian } from '../src/windows.ts';

const VECTORS: readonly (readonly bigint[])[] = [
  [5n],
  [3n, 7n],
  [1n, 2n, 3n],
  [1n, 2n, 3n, 4n],
  [-10n, -5n, 0n, 5n, 10n],
  [100n, 100n, 100n, 500n],
  [-1n, -2n],
  [2n, 4n, 4n, 4n, 100n, 100n, 500n, 1_234_567n],
  [0n, 0n, 0n],
  [9_007_199_254_740_993n, -9_007_199_254_740_993n, 1n],
];

describe('planning windows.twiceMedian delegates to @core/kernel exactly (WP 5.14)', () => {
  it.each(VECTORS.map((values, index) => ({ index, values })))(
    'twiceMedian(vector #$index) matches a direct kernel call to twiceMedianMinor',
    ({ values }) => {
      expect(twiceMedian(values)).toBe(twiceMedianMinor(values));
    },
  );

  it('is exact, never rounded, on an even-length "exact half" case', () => {
    // 1 and 2 average to 1.5 — twiceMedian must read 3, never a rounded 2.
    expect(twiceMedian([1n, 2n])).toBe(3n);
    expect(twiceMedianMinor([1n, 2n])).toBe(3n);
  });

  it('still throws RangeError on empty input, exactly as before the move', () => {
    expect(() => twiceMedian([])).toThrow(RangeError);
    expect(() => twiceMedian([])).toThrow('twiceMedian: empty');
  });
});
