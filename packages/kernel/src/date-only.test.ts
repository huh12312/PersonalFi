// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDateOnly,
  dateOnly,
  dayOfWeek,
  differenceInDays,
  endOfMonth,
  fromEpochDay,
  month,
  parseDateOnly,
  startOfMonth,
  toEpochDay,
  year,
} from './date-only.ts';
import { InvalidValueError } from './errors.ts';

const arbEpochDay = fc.integer({ min: -60_000, max: 60_000 });
const arbDate = arbEpochDay.map(fromEpochDay);

describe('DateOnly', () => {
  it('round-trips through its epoch-day representation', () => {
    fc.assert(
      fc.property(arbEpochDay, (epochDay) => {
        expect(toEpochDay(fromEpochDay(epochDay))).toBe(epochDay);
      }),
    );
  });

  it('round-trips through its ISO string', () => {
    fc.assert(
      fc.property(arbDate, (date) => {
        expect(parseDateOnly(date)).toBe(date);
      }),
    );
  });

  it('sorts lexicographically in chronological order', () => {
    // This is why the type is an ISO string: ORDER BY in SQL, .sort() in JS, and
    // a URL query parameter all agree without any conversion.
    fc.assert(
      fc.property(arbDate, arbDate, (a, b) => {
        const lexical = a < b ? -1 : a > b ? 1 : 0;
        expect(compareDateOnly(a, b)).toBe(lexical);
      }),
    );
  });

  it('adds days reversibly', () => {
    fc.assert(
      fc.property(arbDate, fc.integer({ min: -5_000, max: 5_000 }), (date, days) => {
        expect(addDays(addDays(date, days), -days)).toBe(date);
        expect(differenceInDays(date, addDays(date, days))).toBe(days);
      }),
    );
  });

  it('handles leap days without a Date object in sight', () => {
    expect(addDays(dateOnly(2028, 2, 28), 1)).toBe('2028-02-29');
    expect(addDays(dateOnly(2026, 2, 28), 1)).toBe('2026-03-01');
    expect(dateOnly(2000, 2, 29)).toBe('2000-02-29'); // divisible by 400
    expect(() => dateOnly(2100, 2, 29)).toThrow(InvalidValueError); // divisible by 100
  });

  it('clamps month arithmetic to the end of the target month', () => {
    // The classic subscription-billing bug: Jan 31 + 1 month must not be Mar 3.
    expect(addMonths(dateOnly(2026, 1, 31), 1)).toBe('2026-02-28');
    expect(addMonths(dateOnly(2028, 1, 31), 1)).toBe('2028-02-29');
    expect(addMonths(dateOnly(2026, 3, 31), -1)).toBe('2026-02-28');
    expect(addMonths(dateOnly(2026, 12, 15), 1)).toBe('2027-01-15');
    expect(addMonths(dateOnly(2026, 1, 15), -1)).toBe('2025-12-15');
  });

  it('never lands outside the target month', () => {
    fc.assert(
      fc.property(arbDate, fc.integer({ min: -240, max: 240 }), (date, months) => {
        const moved = addMonths(date, months);
        expect(startOfMonth(moved) <= moved && moved <= endOfMonth(moved)).toBe(true);
      }),
    );
  });

  it('round-trips when clamping cannot happen: day <= 28 goes forward and back exactly', () => {
    // Restricted to day <= 28 on purpose: every calendar month has at least 28
    // days, so neither the forward move nor the `-months` move back can ever
    // clamp, and the round trip is then a property of the arithmetic, not an
    // artifact of which months happen to be long enough. Above 28 the
    // "clamps to the end of the month" test already covers the (deliberately
    // lossy) alternative.
    fc.assert(
      fc.property(
        arbDate,
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: -240, max: 240 }),
        (date, dayOfMonth, months) => {
          const anchor = dateOnly(year(date), month(date), dayOfMonth);
          expect(addMonths(addMonths(anchor, months), -months)).toBe(anchor);
        },
      ),
    );
  });

  it('composes: moving by a then b months matches moving by a + b, day <= 28', () => {
    fc.assert(
      fc.property(
        arbDate,
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: -120, max: 120 }),
        fc.integer({ min: -120, max: 120 }),
        (date, dayOfMonth, a, b) => {
          const anchor = dateOnly(year(date), month(date), dayOfMonth);
          expect(addMonths(addMonths(anchor, a), b)).toBe(addMonths(anchor, a + b));
        },
      ),
    );
  });

  it('computes month boundaries', () => {
    expect(startOfMonth(dateOnly(2026, 2, 17))).toBe('2026-02-01');
    expect(endOfMonth(dateOnly(2026, 2, 17))).toBe('2026-02-28');
    expect(endOfMonth(dateOnly(2028, 2, 1))).toBe('2028-02-29');
    expect(endOfMonth(dateOnly(2026, 12, 1))).toBe('2026-12-31');
  });

  it('agrees with the calendar on weekdays', () => {
    expect(dayOfWeek(dateOnly(1970, 1, 1))).toBe(4); // a Thursday
    expect(dayOfWeek(dateOnly(2026, 9, 11))).toBe(5); // a Friday
  });

  it('rejects impossible dates rather than rolling them over', () => {
    // `new Date(2026, 1, 30)` silently becomes March 2nd. That is the bug.
    expect(() => dateOnly(2026, 2, 30)).toThrow(InvalidValueError);
    expect(() => dateOnly(2026, 13, 1)).toThrow(InvalidValueError);
    expect(() => dateOnly(2026, 0, 1)).toThrow(InvalidValueError);
    expect(() => dateOnly(2026, 4, 31)).toThrow(InvalidValueError);
    expect(() => parseDateOnly('2026-9-1')).toThrow(InvalidValueError);
    expect(() => parseDateOnly('11/09/2026')).toThrow(InvalidValueError);
  });
});
