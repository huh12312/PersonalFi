// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { colorForIndex, groupByCurrency, interpolatedCount, latestValued } from './series.ts';
import type { RawSeriesPoint } from './series.ts';
import { windowForRange } from './search.ts';

function point(overrides: Partial<RawSeriesPoint> & { asOfDate: string }): RawSeriesPoint {
  return {
    netWorth: null,
    assets: null,
    liabilities: null,
    liquid: null,
    investable: null,
    onBudget: null,
    sealed: true,
    sealedAt: null,
    revision: 1,
    source: 'observed',
    stalePrice: false,
    dirty: false,
    accountsCounted: 1,
    accountsUnvalued: 0,
    correctionReason: null,
    ...overrides,
  };
}

describe('groupByCurrency', () => {
  it('produces one series for a single-currency window', () => {
    const points = [
      point({ asOfDate: '2026-09-01', netWorth: { minor: '100000', currency: 'USD' } }),
      point({ asOfDate: '2026-09-02', netWorth: { minor: '101000', currency: 'USD' } }),
    ];

    const series = groupByCurrency(points);

    expect(series).toHaveLength(1);
    expect(series[0]?.currency).toBe('USD');
    expect(series[0]?.points.map((p) => p.netWorthMinor)).toEqual([100000, 101000]);
  });

  it("never sums two currencies into one line — each series carries the other currency's days as null", () => {
    const points = [
      point({ asOfDate: '2026-09-01', netWorth: { minor: '100000', currency: 'USD' } }),
      point({ asOfDate: '2026-09-02', netWorth: { minor: '8000', currency: 'CAD' } }),
      point({ asOfDate: '2026-09-03', netWorth: { minor: '102000', currency: 'USD' } }),
    ];

    const series = groupByCurrency(points);

    expect(series.map((s) => s.currency)).toEqual(['CAD', 'USD']);

    const usd = series.find((s) => s.currency === 'USD')!;
    expect(usd.points.map((p) => p.netWorthMinor)).toEqual([100000, null, 102000]);

    const cad = series.find((s) => s.currency === 'CAD')!;
    expect(cad.points.map((p) => p.netWorthMinor)).toEqual([null, 8000, null]);

    // No series entry is ever the sum or an FX-converted blend of the two —
    // each currency's array only ever contains its own values or null.
    const allValues = series.flatMap((s) => s.points.map((p) => p.netWorthMinor));
    expect(allValues).not.toContain(108000); // 100000 + 8000 — the forbidden blended total
  });

  it('a day with no data at all is null in every series, not zero', () => {
    const points = [
      point({ asOfDate: '2026-09-01', netWorth: { minor: '100000', currency: 'USD' } }),
      point({ asOfDate: '2026-09-02', netWorth: null }),
    ];

    const series = groupByCurrency(points);

    expect(series[0]?.points.map((p) => p.netWorthMinor)).toEqual([100000, null]);
  });

  it('carries sealed/source through unchanged for the sealed-vs-live and interpolated-label mechanisms', () => {
    const points = [
      point({
        asOfDate: '2026-09-01',
        netWorth: { minor: '100000', currency: 'USD' },
        sealed: true,
        source: 'observed',
      }),
      point({
        asOfDate: '2026-09-02',
        netWorth: { minor: '100500', currency: 'USD' },
        sealed: false,
        source: null,
      }),
      point({
        asOfDate: '2026-09-03',
        netWorth: { minor: '100200', currency: 'USD' },
        sealed: true,
        source: 'interpolated',
      }),
    ];

    const [series] = groupByCurrency(points);

    expect(series?.points.map((p) => p.sealed)).toEqual([true, false, true]);
    expect(series?.points.map((p) => p.source)).toEqual(['observed', null, 'interpolated']);
  });
});

describe('colorForIndex', () => {
  it('gives distinct colours for the first few series and cycles rather than throwing past the end', () => {
    const first = colorForIndex(0);
    const second = colorForIndex(1);
    expect(first).not.toBe(second);
    expect(colorForIndex(100)).toBe(colorForIndex(100 % 4));
  });
});

describe('interpolatedCount', () => {
  it('counts only source: interpolated days', () => {
    const points = [
      point({ asOfDate: '2026-09-01', source: 'observed' }),
      point({ asOfDate: '2026-09-02', source: 'interpolated' }),
      point({ asOfDate: '2026-09-03', source: 'corrected' }),
      point({ asOfDate: '2026-09-04', source: 'interpolated' }),
    ];
    expect(interpolatedCount(points)).toBe(2);
  });
});

describe('latestValued', () => {
  it('finds the most recent point that actually carries a value', () => {
    const points = [
      point({ asOfDate: '2026-09-01', netWorth: { minor: '100000', currency: 'USD' } }),
      point({ asOfDate: '2026-09-02', netWorth: null }),
    ];
    expect(latestValued(points)?.asOfDate).toBe('2026-09-01');
  });

  it('returns undefined over an all-gap window', () => {
    const points = [point({ asOfDate: '2026-09-01', netWorth: null })];
    expect(latestValued(points)).toBeUndefined();
  });
});

describe('windowForRange', () => {
  it('computes a 30-day window inclusive of both ends', () => {
    const { from, to } = windowForRange('p30d', '2026-09-30');
    expect(to).toBe('2026-09-30');
    expect(from).toBe('2026-09-01');
  });

  it('computes a 90-day and a 1-year window', () => {
    expect(windowForRange('p90d', '2026-09-30').from).toBe('2026-07-03');
    expect(windowForRange('p1y', '2026-09-30').from).toBe('2025-10-01');
  });

  it('"all" asks for the widest window the API will materialise', () => {
    const { from, to } = windowForRange('all', '2026-09-30');
    expect(to).toBe('2026-09-30');
    expect(from < '2016-10-01').toBe(true);
  });
});
