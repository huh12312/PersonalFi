// SPDX-License-Identifier: MIT
/**
 * WP 5.14: `@ctx/recurring`'s `src/stats.ts` used to carry its own bigint
 * `medianMinor`/`madMinor`, byte-identical to `@core/kernel`'s. This package
 * now re-exports the kernel's implementation under the same names so every
 * existing `from './stats.ts'` import is unchanged; this test is the proof
 * that the move changed nothing observable, over the same fixed vectors the
 * pre-move implementation would have been run against (odd/even length,
 * negative minor units, a repeated value, and the two-value exact-half case
 * `windows.ts`'s sibling move depends on reading the same way).
 */
import { describe, expect, it } from 'vitest';

import * as kernel from '@core/kernel';

import { madMinor, medianMinor } from '../src/stats.ts';

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

describe('recurring stats delegate to @core/kernel exactly (WP 5.14)', () => {
  it('medianMinor is the kernel function, re-exported — same reference', () => {
    expect(medianMinor).toBe(kernel.medianMinor);
  });

  it('madMinor is the kernel function, re-exported — same reference', () => {
    expect(madMinor).toBe(kernel.madMinor);
  });

  it.each(VECTORS.map((values, index) => ({ index, values })))(
    'medianMinor(vector #$index) matches a direct kernel call',
    ({ values }) => {
      expect(medianMinor(values)).toBe(kernel.medianMinor(values));
    },
  );

  it.each(VECTORS.map((values, index) => ({ index, values })))(
    'madMinor(vector #$index) matches a direct kernel call',
    ({ values }) => {
      expect(madMinor(values)).toBe(kernel.madMinor(values));
    },
  );

  it('reproduces the pre-move half-even behaviour on the documented example', () => {
    // The old header example: "a median of 1 and 2 is 2 and of 3 and 4 is 4".
    expect(medianMinor([1n, 2n])).toBe(2n);
    expect(medianMinor([3n, 4n])).toBe(4n);
  });

  it('still throws on empty input, with the original message', () => {
    expect(() => medianMinor([])).toThrow('medianMinor: empty');
    expect(() => madMinor([])).toThrow('madMinor: empty');
  });
});
