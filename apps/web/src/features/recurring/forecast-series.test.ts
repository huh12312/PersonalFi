// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { buildForecastBand, enumerateDays, type ForecastChargeInput } from './forecast-series.ts';

const USD = 'USD';
function money(minor: number) {
  return { minor: String(minor), currency: USD };
}

describe('enumerateDays', () => {
  it('includes both endpoints', () => {
    expect(enumerateDays('2026-06-01', '2026-06-03')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('returns a single day when from equals to', () => {
    expect(enumerateDays('2026-06-01', '2026-06-01')).toEqual(['2026-06-01']);
  });
});

describe('buildForecastBand', () => {
  it('carries the previous cumulative total forward on a day with no charge', () => {
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'INFLOW',
        expected: money(1000),
        low: money(900),
        high: money(1100),
      },
    ];
    const points = buildForecastBand('2026-06-01', '2026-06-03', charges);
    expect(points).toHaveLength(3);
    expect(points[0]!.cumulativeExpectedMinor).toBe(1000);
    expect(points[1]!.cumulativeExpectedMinor).toBe(1000);
    expect(points[2]!.cumulativeExpectedMinor).toBe(1000);
  });

  it('subtracts an outflow and adds an inflow to the expected line', () => {
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(500),
        low: money(500),
        high: money(500),
      },
      {
        date: '2026-06-02',
        sign: 'INFLOW',
        expected: money(2000),
        low: money(2000),
        high: money(2000),
      },
    ];
    const points = buildForecastBand('2026-06-01', '2026-06-02', charges);
    expect(points[0]!.cumulativeExpectedMinor).toBe(-500);
    expect(points[1]!.cumulativeExpectedMinor).toBe(1500);
  });

  it("an outflow's worst case is its high magnitude, negated — never its low", () => {
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(1000),
        low: money(800),
        high: money(1400),
      },
    ];
    const [point] = buildForecastBand('2026-06-01', '2026-06-01', charges);
    // Worst case spends the most: -1400. Best case spends the least: -800.
    expect(point!.cumulativeLowMinor).toBe(-1400);
    expect(point!.cumulativeHighMinor).toBe(-800);
  });

  it("an inflow's worst case is its low magnitude — never its high", () => {
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'INFLOW',
        expected: money(1000),
        low: money(800),
        high: money(1400),
      },
    ];
    const [point] = buildForecastBand('2026-06-01', '2026-06-01', charges);
    expect(point!.cumulativeLowMinor).toBe(800);
    expect(point!.cumulativeHighMinor).toBe(1400);
  });

  it('the band always contains the expected line (low <= expected <= high) across mixed charges', () => {
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(500),
        low: money(400),
        high: money(650),
      },
      {
        date: '2026-06-05',
        sign: 'INFLOW',
        expected: money(3000),
        low: money(2900),
        high: money(3100),
      },
      {
        date: '2026-06-10',
        sign: 'OUTFLOW',
        expected: money(1200),
        low: money(1200),
        high: money(1200),
      },
    ];
    const points = buildForecastBand('2026-06-01', '2026-06-12', charges);
    for (const point of points) {
      expect(point.cumulativeLowMinor).toBeLessThanOrEqual(point.cumulativeExpectedMinor);
      expect(point.cumulativeExpectedMinor).toBeLessThanOrEqual(point.cumulativeHighMinor);
    }
  });

  it('accumulates multiple charges on the same day', () => {
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(500),
        low: money(500),
        high: money(500),
      },
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(300),
        low: money(300),
        high: money(300),
      },
    ];
    const [point] = buildForecastBand('2026-06-01', '2026-06-01', charges);
    expect(point!.cumulativeExpectedMinor).toBe(-800);
  });
});
