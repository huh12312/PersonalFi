// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { cumulative, paceFixture } from '../test-utils.tsx';
import { comparePace, paceRows, paceState } from './pace.ts';

function flat(length: number, total: number) {
  // Spend `total` on day 1, then nothing: the cumulative value is `total` every day.
  return cumulative([total, ...new Array<number>(length - 1).fill(0)]);
}

describe('the pace sentence arithmetic (WP 10.9)', () => {
  it('compares today with the same day of last month, and says the difference in money', () => {
    const state = paceState(paceFixture());
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    const { comparison } = state;
    expect(comparison.day).toBe(17);
    expect(comparison.spent.minor).toBe(4300n);
    expect(comparison.lastMonth?.day).toBe(17);
    expect(comparison.lastMonth?.spent.minor).toBe(9000n);
    expect(comparison.lastMonth?.difference.minor).toBe(4700n);
    expect(comparison.lastMonth?.direction).toBe('under');
  });

  it('over: more spent than by the same day last month', () => {
    const c = comparePace(
      paceFixture({ days: flat(10, 12_000), today: 10, lastMonth: flat(28, 9_000) }),
      'USD',
    );
    expect(c.lastMonth?.direction).toBe('over');
    expect(c.lastMonth?.difference.minor).toBe(3000n);
  });

  it('the same amount is "same", with a zero difference', () => {
    const c = comparePace(
      paceFixture({ days: flat(5, 700), today: 5, lastMonth: flat(30, 700) }),
      'USD',
    );
    expect(c.lastMonth?.direction).toBe('same');
    expect(c.lastMonth?.difference.minor).toBe(0n);
  });

  // Month lengths: "by this day last month" reads last month at min(today, its length).
  it.each([
    // [this month's length, today, last month's length, the day of last month compared]
    [31, 31, 30, 30], // May 31 against April (30): April's last day
    [31, 30, 28, 28], // March 30 against a 28-day February
    [31, 29, 29, 29], // March 29 against a leap February (29)
    [30, 30, 31, 30], // April 30 against March (31): the same day, not March 31
    [28, 28, 31, 28], // February 28 against January
    [29, 29, 31, 29], // leap February 29 against January
  ])(
    'a %i-day month on day %i against a %i-day last month compares day %i',
    (length, today, lastLength, expectedDay) => {
      const lastMonth = cumulative(Array.from({ length: lastLength }, () => 100)); // 100 a day
      const c = comparePace(
        paceFixture({ daysInMonth: length, today, days: flat(today, 1), lastMonth }),
        'USD',
      );
      expect(c.lastMonth?.day).toBe(expectedDay);
      expect(c.lastMonth?.spent.minor).toBe(BigInt(expectedDay * 100));
    },
  );

  it('a month with no spend yet is a real zero (the ledger has rows), compared with last month', () => {
    const c = comparePace(
      paceFixture({ today: 1, days: [{ day: 1, cumulativeMinor: '0' }] }),
      'USD',
    );
    expect(c.spent.minor).toBe(0n);
    expect(c.lastMonth?.spent.minor).toBe(0n); // February day 1: nothing yet either
    expect(c.lastMonth?.direction).toBe('same');
  });

  it('no last month data is no comparison, never a zero', () => {
    const c = comparePace(paceFixture({ lastMonth: [] }), 'USD');
    expect(c.lastMonth).toBeNull();
  });

  it('a past month speaks of its last day', () => {
    const c = comparePace(
      paceFixture({
        today: null,
        daysInMonth: 28,
        days: flat(28, 5_000),
        lastMonth: flat(31, 4_000),
      }),
      'USD',
    );
    expect(c.day).toBe(28);
    expect(c.lastMonth?.day).toBe(28);
  });

  it('no currency, or nothing in any series, is no data; no days but history is a future month', () => {
    expect(paceState(paceFixture({ currency: null })).kind).toBe('no-data');
    expect(
      paceState(paceFixture({ days: [], lastMonth: [], trailingAverage: [], trailingMonths: [] }))
        .kind,
    ).toBe('no-data');
    expect(paceState(paceFixture({ days: [], today: null })).kind).toBe('future');
  });

  it('the table rows carry every day, a dash-able null where a series has no day', () => {
    const rows = paceRows(paceFixture());
    expect(rows).toHaveLength(31);
    expect(rows[16]).toEqual({ day: 17, thisMonth: 4300n, lastMonth: 9000n, average: 6000n });
    expect(rows[17]?.thisMonth).toBeNull(); // day 18 has not happened
    expect(rows[28]?.lastMonth).toBeNull(); // February has no 29th
    expect(rows[30]?.average).toBe(6000n);
  });
});
