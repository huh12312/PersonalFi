// SPDX-License-Identifier: MIT
/**
 * ISO 8601 week numbering, pure integer arithmetic over `DateOnly`.
 *
 * The Brief's schedule fires Sunday 06:00 local, and an ISO week runs
 * Monday..Sunday -- so `isoWeekOf(today)` on a Sunday names the week that just
 * ended, which is exactly the week the Brief reports on.
 *
 * The standard algorithm: the ISO week-numbering year of a date is the year
 * that contains *that week's Thursday* (ISO weeks always have their Thursday
 * in the year they belong to, which is what makes the first and last weeks of
 * a year unambiguous); the week number is how many Thursdays have passed
 * since the first one of that year.
 */
import { DateOnly, type DateOnly as DateOnlyType } from '@core/kernel';

const ISO_WEEK_PATTERN = /^([0-9]{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/;

/** `1` (Monday) .. `7` (Sunday). `DateOnly.dayOfWeek` is `0` (Sunday) .. `6` (Saturday). */
function isoWeekday(date: DateOnlyType): number {
  const sundayIsZero = DateOnly.dayOfWeek(date);
  return sundayIsZero === 0 ? 7 : sundayIsZero;
}

/** `YYYY-Www`, e.g. `2026-W40`. */
export function isoWeekOf(date: DateOnlyType): string {
  const thursday = DateOnly.addDays(date, 4 - isoWeekday(date));
  const isoYear = DateOnly.year(thursday);
  const firstThursdayYear = DateOnly.of(isoYear, 1, 1);
  const ordinalDay = DateOnly.differenceInDays(firstThursdayYear, thursday) + 1;
  const week = Math.floor((ordinalDay - 1) / 7) + 1;
  return `${String(isoYear).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

export function isIsoWeek(text: string): boolean {
  return ISO_WEEK_PATTERN.test(text);
}

/** The Monday..Sunday preceding `isoWeek`'s own Monday..Sunday. */
export function previousIsoWeek(isoWeek: string): string {
  const match = ISO_WEEK_PATTERN.exec(isoWeek);
  if (match === null) throw new Error(`not an ISO week: ${isoWeek}`);
  const [, yearText = '', weekText = ''] = match;
  const isoYear = Number(yearText);
  const week = Number(weekText);
  // The Thursday of ISO week 1 of `isoYear`, then step back one calendar week
  // at a time -- correct across a year boundary without re-deriving the ISO
  // year rule twice.
  const jan4 = DateOnly.of(isoYear, 1, 4); // always in week 1 (ISO's defining rule)
  const week1Thursday = DateOnly.addDays(jan4, 4 - isoWeekday(jan4));
  const thisWeekThursday = DateOnly.addDays(week1Thursday, (week - 1) * 7);
  const previousThursday = DateOnly.addDays(thisWeekThursday, -7);
  return isoWeekOf(previousThursday);
}
