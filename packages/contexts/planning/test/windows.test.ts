// SPDX-License-Identifier: MIT
/**
 * The claims `src/windows.ts` makes in prose, each held to a test: the window
 * never includes the month in progress, the one-off rule is a conjunction that
 * a raise does not trip, two one-offs cannot mask each other, a series too
 * short to judge is never judged, and every division rounds once, half-even.
 */
import { describe, expect, it } from 'vitest';
import {
  divideHalfEven,
  parseThreshold,
  ratioToDecimal,
  separateOneOffs,
  trailingWindow,
  type OneOffThresholds,
} from '../src/windows.ts';
import { day } from './revealed-fixtures.ts';

const DEFAULTS: OneOffThresholds = {
  medianMultiple: parseThreshold('m', '4'),
  sigma: parseThreshold('k', '3'),
  minimumPeers: 3,
};

function split(values: readonly bigint[], thresholds: OneOffThresholds = DEFAULTS) {
  const items = values.map((value, index) => ({ value, index }));
  const verdict = separateOneOffs(
    items,
    (item) => item.value,
    (a, b) => a.index - b.index,
    thresholds,
  );
  return {
    excluded: verdict.excluded.map(({ item }) => item.value),
    kept: verdict.kept.length,
    judged: verdict.judged,
  };
}

const TWELVE_500S = Array.from({ length: 12 }, () => 50_000n);

describe('trailing windows', () => {
  it('never includes the month in progress, and includes a month that has just ended', () => {
    expect(trailingWindow(day('2026-09-26'), 12)).toMatchObject({
      from: '2025-09-01',
      to: '2026-08-31',
      days: 365,
    });
    expect(trailingWindow(day('2026-08-31'), 12)).toMatchObject({
      from: '2025-09-01',
      to: '2026-08-31',
    });
    expect(trailingWindow(day('2024-03-01'), 12)).toMatchObject({
      from: '2023-03-01',
      to: '2024-02-29',
      days: 366,
    });
  });
});

describe('the one-off detector', () => {
  it('a raise is not a one-off: twelve $500s and a $520 keep all thirteen', () => {
    // Leave-one-out σ of twelve identical values is zero, so σ alone would
    // strike the $520; the median multiple is what stops it.
    expect(split([...TWELVE_500S, 52_000n])).toEqual({ excluded: [], kept: 13, judged: true });
  });

  it('a $40,000 among twelve $500s is a one-off', () => {
    expect(split([...TWELVE_500S, 4_000_000n]).excluded).toEqual([4_000_000n]);
  });

  it('two one-offs in the same year do not mask each other', () => {
    // Tested together against the same peers, each inflates the other's σ and
    // neither clears 3σ. Largest-first, repeated, strikes both.
    expect(split([...TWELVE_500S, 4_000_000n, 3_000_000n]).excluded).toEqual([
      4_000_000n,
      3_000_000n,
    ]);
  });

  it('a genuinely wide distribution keeps its upper tail', () => {
    // Monthly transfers that genuinely run $100 … $1,500. The $1,500 is 6× the
    // median of its peers ($250), so the median multiple alone would strike it;
    // it is only 2.6σ above their mean ($455.56, σ $401), so the conjunction
    // keeps it. Spread is the σ test's job.
    const wide = [
      10_000n,
      10_000n,
      15_000n,
      20_000n,
      25_000n,
      30_000n,
      80_000n,
      100_000n,
      120_000n,
      150_000n,
    ];
    expect(split(wide).excluded).toEqual([]);
    const medianOnly = { ...DEFAULTS, sigma: parseThreshold('k', '0') };
    expect(split(wide, medianOnly).excluded).toContain(150_000n);
  });

  it('a series with fewer than the minimum peers is never judged', () => {
    expect(split([50_000n, 50_000n, 4_000_000n])).toEqual({ excluded: [], kept: 3, judged: false });
  });

  it('k = 0 degenerates to the median test alone, and m = 0 to the σ test alone', () => {
    const medianOnly = { ...DEFAULTS, sigma: parseThreshold('k', '0') };
    // With σ switched off, the $520 is still under 4× the median: kept.
    expect(split([...TWELVE_500S, 52_000n], medianOnly).excluded).toEqual([]);
    const sigmaOnly = { ...DEFAULTS, medianMultiple: parseThreshold('m', '0') };
    // With the median multiple switched off, σ = 0 strikes the raise — the
    // failure the conjunction exists to prevent.
    expect(split([...TWELVE_500S, 52_000n], sigmaOnly).excluded).toEqual([52_000n]);
  });

  it('refuses a threshold given as a number', () => {
    expect(() => parseThreshold('k', 3)).toThrow(/decimal string/);
  });
});

describe('exact arithmetic', () => {
  it('rounds once, half-even', () => {
    expect(divideHalfEven(5n, 2n)).toBe(2n);
    expect(divideHalfEven(7n, 2n)).toBe(4n);
    expect(divideHalfEven(-5n, 2n)).toBe(-2n);
    expect(divideHalfEven(400_000n, 12n)).toBe(33_333n);
    expect(ratioToDecimal(400_000n, 8_060_000n, 4)).toBe('0.0496');
    expect(ratioToDecimal(1n, 8n, 2)).toBe('0.12');
    expect(ratioToDecimal(3n, 8n, 2)).toBe('0.38');
  });
});
