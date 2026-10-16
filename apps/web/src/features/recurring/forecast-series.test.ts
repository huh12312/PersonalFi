// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  buildChargeMarks,
  buildForecastBand,
  describeEmptyWindow,
  enumerateDays,
  forecastShape,
  streamsOutsideWindow,
  type ForecastChargeInput,
  type ForecastMarkInput,
} from './forecast-series.ts';

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

// ---------------------------------------------------------------------------
// WP 10.7
// ---------------------------------------------------------------------------

describe('buildForecastBand on the signed wire (WP 10.7)', () => {
  // `@ctx/recurring` sends amounts signed (an outflow is negative, `low` its pessimistic end). Before WP 10.7 the
  // builder negated an outflow a second time, so this outflow plotted as +$10.00.
  it('an outflow sent negative still subtracts, and its worst case is its larger magnitude', () => {
    const [point] = buildForecastBand('2026-06-01', '2026-06-01', [
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(-1000),
        low: money(-1400),
        high: money(-800),
      },
    ]);
    expect(point!.cumulativeExpectedMinor).toBe(-1000);
    expect(point!.cumulativeLowMinor).toBe(-1400);
    expect(point!.cumulativeHighMinor).toBe(-800);
  });

  it("the last point equals the route's own net / netLow / netHigh sums", () => {
    // The e2e fixture's charges (e2e/support/mock-recurring-insights.ts) and the sums the route would send.
    const charges: ForecastChargeInput[] = [
      {
        date: '2026-06-01',
        sign: 'OUTFLOW',
        expected: money(-145000),
        low: money(-145000),
        high: money(-145000),
      },
      {
        date: '2026-06-08',
        sign: 'OUTFLOW',
        expected: money(-8500),
        low: money(-11000),
        high: money(-7000),
      },
      {
        date: '2026-06-15',
        sign: 'OUTFLOW',
        expected: money(-6500),
        low: money(-6500),
        high: money(-6500),
      },
      {
        date: '2026-06-15',
        sign: 'OUTFLOW',
        expected: money(-4200),
        low: money(-5000),
        high: money(-3600),
      },
      {
        date: '2026-06-20',
        sign: 'INFLOW',
        expected: money(2500),
        low: money(2000),
        high: money(3000),
      },
      {
        date: '2026-07-01',
        sign: 'OUTFLOW',
        expected: money(-999),
        low: money(-999),
        high: money(-999),
      },
    ];
    const last = buildForecastBand('2026-06-01', '2026-07-01', charges).at(-1)!;
    expect(last.cumulativeExpectedMinor).toBe(-162699);
    expect(last.cumulativeLowMinor).toBe(-166499);
    expect(last.cumulativeHighMinor).toBe(-160099);
  });
});

function markInput(
  seriesId: string,
  date: string,
  expected: number,
  low = expected,
  high = expected,
): ForecastMarkInput {
  return {
    seriesId,
    merchantId: `merch_${seriesId}`,
    cadence: 'MONTHLY',
    date,
    sign: expected < 0 ? 'OUTFLOW' : 'INFLOW',
    expected: money(expected),
    low: money(low),
    high: money(high),
  };
}

const names = (merchantId: string) => merchantId.replace('merch_', '').toUpperCase();

describe('buildChargeMarks', () => {
  it('one mark per charge, never one per day: two charges on one day are two marks, ranked for the lane', () => {
    const marks = buildChargeMarks(
      '2026-06-01',
      '2026-06-30',
      [
        markInput('water', '2026-06-15', -4200, -5000, -3600),
        markInput('rent', '2026-06-01', -145000),
        markInput('phone', '2026-06-15', -6500),
      ],
      names,
    );
    expect(marks.map((m) => [m.date, m.name, m.rank])).toEqual([
      ['2026-06-01', 'RENT', 0],
      // Larger first on a shared day.
      ['2026-06-15', 'PHONE', 0],
      ['2026-06-15', 'WATER', 1],
    ]);
    const water = marks[2]!;
    expect(water.expectedMinor).toBe(-4200);
    expect(water.worstMinor).toBe(-5000);
    expect(water.bestMinor).toBe(-3600);
  });

  it('signs by direction whatever sign the amount arrives with', () => {
    const [inflow] = buildChargeMarks(
      '2026-06-01',
      '2026-06-30',
      [{ ...markInput('cashback', '2026-06-20', 2500, 2000, 3000) }],
      names,
    );
    expect(inflow!.sign).toBe('INFLOW');
    expect(inflow!.expectedMinor).toBe(2500);
    expect(inflow!.worstMinor).toBe(2000);
  });

  it('drops a charge outside the window rather than draw it off the axis', () => {
    expect(
      buildChargeMarks('2026-06-01', '2026-06-30', [markInput('late', '2026-07-02', -100)], names),
    ).toEqual([]);
  });
});

describe('forecastShape', () => {
  it("no charge in the window is 'empty', even though the day-by-day series is 31 points of $0", () => {
    const points = buildForecastBand('2026-10-16', '2026-11-15', []);
    expect(points).toHaveLength(31);
    expect(forecastShape(points, [])).toBe('empty');
  });

  it("every charge fixed is 'certain': the band has no width", () => {
    const inputs = [
      markInput('rent', '2026-06-01', -145000),
      markInput('spotify', '2026-06-30', -999),
    ];
    const points = buildForecastBand('2026-06-01', '2026-06-30', inputs);
    const marks = buildChargeMarks('2026-06-01', '2026-06-30', inputs, names);
    expect(forecastShape(points, marks)).toBe('certain');
  });

  it("one charge with a range is 'banded'", () => {
    const inputs = [
      markInput('rent', '2026-06-01', -145000),
      markInput('power', '2026-06-08', -8500, -11000, -7000),
    ];
    const points = buildForecastBand('2026-06-01', '2026-06-30', inputs);
    const marks = buildChargeMarks('2026-06-01', '2026-06-30', inputs, names);
    expect(forecastShape(points, marks)).toBe('banded');
  });
});

describe('the empty window statement', () => {
  const stream = (id: string, cadence: string, state = 'ACTIVE') => ({
    id,
    merchantId: `merch_${id}`,
    cadence,
    state,
  });
  const cadence = (c: string) => ({ ANNUAL: 'Yearly', MONTHLY: 'Monthly' })[c] ?? 'Irregular';

  it('names the one stream with no due date in the window (the sandbox: one yearly Uber charge)', () => {
    const streams = streamsOutsideWindow([stream('uber', 'ANNUAL')], []);
    expect(describeEmptyWindow(30, streams, () => 'Uber', cadence)).toBe(
      'No charges expected in the next 30 days — 1 stream (Uber, yearly) has no due date in this window.',
    );
  });

  it('names three and counts the rest; an archived stream is not a reason', () => {
    const streams = streamsOutsideWindow(
      [
        stream('a', 'ANNUAL'),
        stream('b', 'MONTHLY'),
        stream('c', 'ANNUAL'),
        stream('d', 'ANNUAL'),
        stream('gone', 'MONTHLY', 'ARCHIVED'),
      ],
      [],
    );
    expect(describeEmptyWindow(30, streams, names, cadence)).toBe(
      'No charges expected in the next 30 days — 4 streams (A, yearly; B, monthly; C, yearly; and 1 more) have no due date in this window.',
    );
  });

  it('says so when there are no streams at all', () => {
    expect(describeEmptyWindow(30, [], names, cadence)).toBe(
      'No charges expected in the next 30 days — no recurring streams have been confirmed or detected yet.',
    );
  });

  it('a stream that does put a charge in the window is not listed', () => {
    const marks = buildChargeMarks(
      '2026-06-01',
      '2026-06-30',
      [markInput('rent', '2026-06-01', -1000)],
      names,
    );
    expect(
      streamsOutsideWindow([stream('rent', 'MONTHLY'), stream('uber', 'ANNUAL')], marks).map(
        (s) => s.id,
      ),
    ).toEqual(['uber']);
  });
});
