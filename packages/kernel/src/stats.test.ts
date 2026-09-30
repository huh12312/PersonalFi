// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { madMinor, madNumber, medianMinor, medianNumber, twiceMedianMinor } from './stats.ts';

describe('medianMinor', () => {
  it('is the middle value of an odd-length list', () => {
    expect(medianMinor([3n, 1n, 2n])).toBe(2n);
  });

  it('rounds an even-length midpoint half-even', () => {
    // (1 + 2) / 2 = 1.5 -> 2 (the even neighbour); (3 + 4) / 2 = 3.5 -> 4.
    expect(medianMinor([1n, 2n])).toBe(2n);
    expect(medianMinor([3n, 4n])).toBe(4n);
    // (2 + 3) / 2 = 2.5 -> 2 (already even).
    expect(medianMinor([2n, 3n])).toBe(2n);
  });

  it('is order-independent', () => {
    expect(medianMinor([5n, -3n, 100n, 1n, 1n])).toBe(1n);
    expect(medianMinor([1n, 1n, 5n, -3n, 100n])).toBe(1n);
  });

  it('handles negative values exactly', () => {
    expect(medianMinor([-10n, -5n, -1n])).toBe(-5n);
  });

  it('is exact over amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    // If the implementation ever cast to `Number` internally, this pair would
    // collide (both round to the same IEEE-754 double) and the median would be
    // silently wrong. `9_007_199_254_740_993n` is `MAX_SAFE_INTEGER + 2`, the
    // canonical case `money.test.ts` uses for the same proof.
    const big = 9_007_199_254_740_993n;
    const bigger = 9_007_199_254_740_995n;
    expect(medianMinor([big, bigger])).toBe(9_007_199_254_740_994n);
  });

  it('throws on an empty list rather than returning a fabricated zero', () => {
    expect(() => medianMinor([])).toThrow();
  });
});

describe('twiceMedianMinor', () => {
  it('equals twice the rounded median for an odd-length list', () => {
    expect(twiceMedianMinor([3n, 1n, 2n])).toBe(4n);
  });

  it('is the exact, unrounded sum of the two middle values for an even-length list', () => {
    // medianMinor([1n, 2n]) rounds to 2n, so 2 * median = 4n -- but the exact
    // midpoint is 1.5, and twice that is exactly 3n. This is the case
    // `@ctx/planning`'s one-off detector needs and a rounded median cannot give.
    expect(twiceMedianMinor([1n, 2n])).toBe(3n);
    expect(twiceMedianMinor([2n, 3n])).toBe(5n);
  });

  it('throws on an empty list', () => {
    expect(() => twiceMedianMinor([])).toThrow();
  });
});

describe('madMinor', () => {
  it('is the median of the absolute deviations from the median', () => {
    // median of [1, 2, 3, 4, 100] is 3; deviations are [2, 1, 0, 1, 97];
    // median of those is 1.
    expect(madMinor([1n, 2n, 3n, 4n, 100n])).toBe(1n);
  });

  it('is zero when every value is identical', () => {
    expect(madMinor([50n, 50n, 50n])).toBe(0n);
  });

  it('is robust to a single extreme outlier: one bad row does not move it much', () => {
    const withoutOutlier = madMinor([100n, 102n, 98n, 101n, 99n]);
    const withOutlier = madMinor([100n, 102n, 98n, 101n, 99n, 1_000_000n]);
    // A mean-based spread would be dominated by the outlier; the median-based
    // one barely moves, which is the entire reason 04 §5.1 picked it.
    expect(withOutlier - withoutOutlier < 5n).toBe(true);
  });

  it('is exact over amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    const values = [9_007_199_254_740_993n, 9_007_199_254_740_995n, 9_007_199_254_740_997n];
    // median is the middle value (740_995n); deviations are [2n, 0n, 2n];
    // median of those is 2n.
    expect(madMinor(values)).toBe(2n);
  });

  it('throws on an empty list', () => {
    expect(() => madMinor([])).toThrow();
  });

  it('the median and MAD are exact over bigint and never pass through a float', () => {
    // Two values one minor unit apart, both far beyond
    // `Number.MAX_SAFE_INTEGER` (2^53 - 1): a `Number(...)` cast anywhere in
    // the median or the MAD would round both to the same double, and the
    // exact difference this asserts would be lost.
    const low = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    const high = 9_007_199_254_740_995n; // MAX_SAFE_INTEGER + 4
    const middle = 9_007_199_254_740_994n; // exactly between the two
    expect(medianMinor([low, high])).toBe(middle);
    // Five values an order of magnitude past `Number.MAX_SAFE_INTEGER`,
    // where a double's rounding granularity is coarse enough that
    // `Number(value) - Number(centre)` collapses every deviation here to
    // zero -- a `madMinor` that ever cast to `Number` would report 0n
    // instead of the true 3n.
    const base = 90_071_992_547_409_930n; // ten times MAX_SAFE_INTEGER
    const values = [base - 11n, base - 3n, base, base + 3n, base + 11n];
    expect(medianMinor(values)).toBe(base);
    expect(madMinor(values)).toBe(3n);
  });

  it('a fast-check property: MAD never exceeds the range of the input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }), { minLength: 1 }),
        (values) => {
          const mad = madMinor(values);
          const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const range = (sorted[sorted.length - 1] as bigint) - (sorted[0] as bigint);
          expect(mad >= 0n).toBe(true);
          expect(mad <= range).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('medianNumber and madNumber', () => {
  it('mirror the bigint versions over plain numbers', () => {
    expect(medianNumber([3, 1, 2])).toBe(2);
    expect(medianNumber([1, 2])).toBe(1.5);
    expect(madNumber([1, 2, 3, 4, 100])).toBe(1);
  });

  it('throw on an empty list', () => {
    expect(() => medianNumber([])).toThrow();
    expect(() => madNumber([])).toThrow();
  });
});
