// SPDX-License-Identifier: MIT
import type { Brand } from './brand.ts';
import { InvalidValueError } from './errors.ts';

/**
 * A calendar date with no time and no zone, as `YYYY-MM-DD`.
 *
 * A bank's posted date is a calendar date, not an instant. Coercing it through a
 * timezone is how a 2026-03-01 transaction becomes 2026-02-28 for a user in
 * UTC-5, which is exactly where budgets break. Maps to Postgres `date`.
 *
 * The ISO form means lexicographic ordering is chronological ordering, so these
 * sort correctly in SQL, in JS, and in a URL query string without conversion.
 */
export type DateOnly = Brand<string, 'DateOnly'>;

const ISO_PATTERN = /^(-?\d{4,6})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      throw new InvalidValueError('month', `expected 1..12, got ${month}`);
  }
}

function pad(value: number, width: number): string {
  const negative = value < 0;
  return (negative ? '-' : '') + String(Math.abs(value)).padStart(width, '0');
}

/** Construct from calendar parts. Rejects 2026-02-30 rather than rolling it over. */
export function dateOnly(year: number, month: number, day: number): DateOnly {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new InvalidValueError('date', `expected integers, got ${year}-${month}-${day}`);
  }
  if (month < 1 || month > 12) throw new InvalidValueError('date', `month ${month} out of range`);
  const limit = daysInMonth(year, month);
  if (day < 1 || day > limit) {
    throw new InvalidValueError(
      'date',
      `${pad(year, 4)}-${pad(month, 2)} has ${limit} days, got ${day}`,
    );
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as DateOnly;
}

export function parseDateOnly(text: string): DateOnly {
  const match = ISO_PATTERN.exec(text.trim());
  if (match === null) {
    throw new InvalidValueError('date', `expected YYYY-MM-DD, got ${JSON.stringify(text)}`);
  }
  const [, y = '', m = '', d = ''] = match;
  return dateOnly(Number(y), Number(m), Number(d));
}

export function isDateOnly(text: string): text is DateOnly {
  try {
    parseDateOnly(text);
    return true;
  } catch {
    return false;
  }
}

export function year(date: DateOnly): number {
  return Number(date.slice(0, date.length - 6));
}

export function month(date: DateOnly): number {
  return Number(date.slice(-5, -3));
}

export function day(date: DateOnly): number {
  return Number(date.slice(-2));
}

/**
 * Days since 1970-01-01, by Howard Hinnant's `days_from_civil`. Pure integer
 * arithmetic: no `Date`, no timezone, no DST, correct for any proleptic
 * Gregorian year.
 */
export function toEpochDay(date: DateOnly): number {
  const m = month(date);
  const d = day(date);
  const y = year(date) - (m <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Inverse of `toEpochDay` (`civil_from_days`). */
export function fromEpochDay(epochDay: number): DateOnly {
  if (!Number.isInteger(epochDay)) {
    throw new InvalidValueError('epoch day', `expected an integer, got ${epochDay}`);
  }
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const y = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const d = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return dateOnly(y + (m <= 2 ? 1 : 0), m, d);
}

export function addDays(date: DateOnly, days: number): DateOnly {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Clamps to the end of the target month: 2026-01-31 + 1 month is 2026-02-28. */
export function addMonths(date: DateOnly, months: number): DateOnly {
  const total = year(date) * 12 + (month(date) - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  return dateOnly(
    targetYear,
    targetMonth,
    Math.min(day(date), daysInMonth(targetYear, targetMonth)),
  );
}

export function addYears(date: DateOnly, years: number): DateOnly {
  return addMonths(date, years * 12);
}

/** `b - a` in whole days. Positive when `b` is later. */
export function differenceInDays(a: DateOnly, b: DateOnly): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function startOfMonth(date: DateOnly): DateOnly {
  return dateOnly(year(date), month(date), 1);
}

export function endOfMonth(date: DateOnly): DateOnly {
  const y = year(date);
  const m = month(date);
  return dateOnly(y, m, daysInMonth(y, m));
}

export function startOfYear(date: DateOnly): DateOnly {
  return dateOnly(year(date), 1, 1);
}

export function endOfYear(date: DateOnly): DateOnly {
  return dateOnly(year(date), 12, 31);
}

/** 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(date: DateOnly): number {
  const epochDay = toEpochDay(date);
  return (((epochDay + 4) % 7) + 7) % 7;
}

export function compareDateOnly(a: DateOnly, b: DateOnly): -1 | 0 | 1 {
  if (a === b) return 0;
  return toEpochDay(a) < toEpochDay(b) ? -1 : 1;
}

export function isBefore(a: DateOnly, b: DateOnly): boolean {
  return compareDateOnly(a, b) === -1;
}

export function isAfter(a: DateOnly, b: DateOnly): boolean {
  return compareDateOnly(a, b) === 1;
}

export function minDate(a: DateOnly, b: DateOnly): DateOnly {
  return isBefore(a, b) ? a : b;
}

export function maxDate(a: DateOnly, b: DateOnly): DateOnly {
  return isAfter(a, b) ? a : b;
}

export const DateOnly = {
  of: dateOnly,
  parse: parseDateOnly,
  is: isDateOnly,
  year,
  month,
  day,
  toEpochDay,
  fromEpochDay,
  addDays,
  addMonths,
  addYears,
  differenceInDays,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  dayOfWeek,
  compare: compareDateOnly,
  isBefore,
  isAfter,
  min: minDate,
  max: maxDate,
  daysInMonth,
  isLeapYear,
} as const;
