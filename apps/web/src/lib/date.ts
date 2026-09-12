// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { format as formatDateFns } from 'date-fns';

/** The branded `DateOnly` type and its namespace object share one name (`@core/kernel`). */
type DateOnlyType = DateOnly;

/**
 * `DateOnly` ("YYYY-MM-DD", no zone — docs/CONVENTIONS.md "Time") must never
 * pass through `new Date(isoString)`, which parses as UTC midnight and can
 * shift a day when formatted back in a non-UTC-0 zone. Build a *local*
 * midnight `Date` from the calendar parts instead — display-only, never fed
 * back into business logic.
 */
export function toLocalDisplayDate(value: DateOnlyType | string): Date {
  const parsed = DateOnly.is(value) ? value : DateOnly.parse(value);
  return new Date(DateOnly.year(parsed), DateOnly.month(parsed) - 1, DateOnly.day(parsed));
}

export function formatDateOnly(value: DateOnlyType | string, pattern = 'MMM d, yyyy'): string {
  return formatDateFns(toLocalDisplayDate(value), pattern);
}

export function formatDateOnlyShort(value: DateOnlyType | string): string {
  return formatDateFns(toLocalDisplayDate(value), 'MMM d');
}
