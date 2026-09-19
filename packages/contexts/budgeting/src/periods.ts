// SPDX-License-Identifier: MIT
/**
 * The period grid — 07 §1.7, half-open and computed entirely in `DateOnly`.
 *
 * > ```
 * > budget_period(id, kind, start_date, end_date, anchor_txn_id?)
 * > kind ∈ {CALENDAR_MONTH, SEMIMONTHLY, BIWEEKLY, WEEKLY, CUSTOM}
 * > ```
 * >
 * > Biweekly anchored to an actual payday means 26 periods/yr and two
 * > "3-paycheck months" — the engine must handle periods that don't tile months.
 * > All budget math in §1.2 is already indexed by `period_id`, not month, so this
 * > is free. — 07 §1.7, lines 206–214
 *
 * ## Why a DST boundary is uninteresting here
 *
 * Phase 2's exit criterion is "a month closes and rolls over correctly across a
 * timezone and DST boundary". The way to pass it is to make it impossible to
 * fail rather than to handle it: a period boundary is a **calendar date in the
 * user's zone**, stored in a `DATE` column, and every function below is integer
 * arithmetic on `DateOnly` via `toEpochDay`/`fromEpochDay`. 2026-03-08 is 23
 * hours long in `America/New_York` and 2026-11-01 is 25, and neither fact can
 * reach this file, because no value in it is an instant.
 *
 * The one place the zone is consulted at all is `todayIn(clock, zone)` —
 * "which calendar date is it for this user right now" — which is `@core/kernel`'s
 * and is the only sanctioned way to ask. `new Date()` is lint-banned outside
 * that file precisely so this stays true.
 *
 * `test/db/period-roll-dst.test.ts` proves it for a calendar month across the
 * spring-forward boundary and, separately, for a biweekly grid that does not
 * tile months — the harder case, because it is the one where "the month rolled"
 * and "the period rolled" are different events.
 */
import { DateOnly, todayIn, type Clock, type DateOnly as DateOnlyType } from '@core/kernel';
import type { PeriodKind } from '../schema/index.ts';

export interface PeriodGridSettings {
  readonly kind: PeriodKind;
  /** IANA zone. Only ever used to answer "what is today's date for this user". */
  readonly timezone: string;
  /** The payday (or arbitrary date) a non-calendar grid hangs off. */
  readonly anchorDate: DateOnlyType | null;
  /** `CUSTOM` only. */
  readonly lengthDays: number | null;
  /** `SEMIMONTHLY` only: the day the second half-month starts. 2..28. */
  readonly semimonthlySecondDay: number;
}

/** A half-open `[start, end)` window. `end` is **exclusive**, always. */
export interface PeriodBounds {
  readonly startDate: DateOnlyType;
  readonly endDate: DateOnlyType;
}

function assertAnchor(settings: PeriodGridSettings): DateOnlyType {
  if (settings.anchorDate === null) {
    throw new RangeError(`period kind ${settings.kind} requires an anchor date`);
  }
  return settings.anchorDate;
}

/**
 * Whole periods of `stride` days between the anchor and `date`, floored.
 *
 * `Math.floor` rather than truncation because a date *before* the anchor must
 * land in a period with a negative index rather than collapsing onto index 0 and
 * overlapping the anchor period — the `EXCLUDE` constraint would refuse the
 * insert, but only after the grid had already been generated wrong.
 */
function strideIndex(anchor: DateOnlyType, date: DateOnlyType, stride: number): number {
  return Math.floor(DateOnly.differenceInDays(anchor, date) / stride);
}

/** The half-open period containing `date`, for any grid. */
export function periodContaining(
  settings: PeriodGridSettings,
  date: DateOnlyType,
): PeriodBounds {
  switch (settings.kind) {
    case 'CALENDAR_MONTH': {
      const start = DateOnly.startOfMonth(date);
      // The 1st of the next month, never "the last day of this one". The
      // half-open form is what makes a 28-, 29-, 30- and 31-day month the same
      // kind of object, and what makes `budget_date < end_date` a single
      // comparison with no month-length special case anywhere downstream.
      return { startDate: start, endDate: DateOnly.addMonths(start, 1) };
    }

    case 'SEMIMONTHLY': {
      const start = DateOnly.startOfMonth(date);
      const split = DateOnly.of(
        DateOnly.year(date),
        DateOnly.month(date),
        settings.semimonthlySecondDay,
      );
      return DateOnly.isBefore(date, split)
        ? { startDate: start, endDate: split }
        : { startDate: split, endDate: DateOnly.addMonths(start, 1) };
    }

    case 'BIWEEKLY':
    case 'WEEKLY':
    case 'CUSTOM': {
      const anchor = assertAnchor(settings);
      const stride =
        settings.kind === 'WEEKLY' ? 7 : settings.kind === 'BIWEEKLY' ? 14 : (settings.lengthDays ?? 0);
      if (!Number.isInteger(stride) || stride < 1) {
        throw new RangeError(`period kind ${settings.kind} needs a positive length, got ${stride}`);
      }
      const start = DateOnly.addDays(anchor, strideIndex(anchor, date, stride) * stride);
      return { startDate: start, endDate: DateOnly.addDays(start, stride) };
    }
  }
}

/** The period immediately after `bounds`, on the same grid. */
export function nextPeriod(settings: PeriodGridSettings, bounds: PeriodBounds): PeriodBounds {
  // `endDate` is exclusive, so it is already the first date of the next period —
  // for every kind, including the ones that do not tile months. Asking the grid
  // rather than adding a fixed stride is what keeps SEMIMONTHLY honest across a
  // 31-day month.
  return periodContaining(settings, bounds.endDate);
}

export function previousPeriod(settings: PeriodGridSettings, bounds: PeriodBounds): PeriodBounds {
  return periodContaining(settings, DateOnly.addDays(bounds.startDate, -1));
}

/** `startDate <= date < endDate`. The only containment test in the package. */
export function contains(bounds: PeriodBounds, date: DateOnlyType): boolean {
  return (
    !DateOnly.isBefore(date, bounds.startDate) && DateOnly.isBefore(date, bounds.endDate)
  );
}

/**
 * `count` consecutive periods starting with the one containing `from`.
 *
 * Used to open a grid ahead of time and by the evidence note's 13-period run.
 */
export function generatePeriods(
  settings: PeriodGridSettings,
  from: DateOnlyType,
  count: number,
): PeriodBounds[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, got ${count}`);
  }
  const periods: PeriodBounds[] = [periodContaining(settings, from)];
  while (periods.length < count) {
    const last = periods[periods.length - 1];
    if (last === undefined) break;
    periods.push(nextPeriod(settings, last));
  }
  return periods;
}

/** The period containing the user's *current* calendar date. */
export function currentPeriod(settings: PeriodGridSettings, clock: Clock): PeriodBounds {
  return periodContaining(settings, todayIn(clock, settings.timezone));
}

/**
 * Whole periods from `bounds` up to and including the one containing `target`.
 *
 * `TARGET_BY_DATE`'s `periods_remaining_inclusive` (07 §1.8 line 222). Returns
 * at least 1: a goal whose date has already passed still needs the shortfall
 * assigned *this* period, and dividing by zero periods would either throw or
 * silently produce an infinite requirement.
 */
export function periodsRemainingInclusive(
  settings: PeriodGridSettings,
  bounds: PeriodBounds,
  target: DateOnlyType,
): number {
  if (DateOnly.isBefore(target, bounds.endDate)) return 1;
  let count = 1;
  let cursor = bounds;
  // Bounded rather than unbounded: a goal 40 years out on a weekly grid is 2,000
  // iterations of integer arithmetic, which is fine, but a corrupt grid that
  // failed to advance would otherwise hang the recompute rather than fail it.
  while (count < 5_000) {
    cursor = nextPeriod(settings, cursor);
    count += 1;
    if (DateOnly.isBefore(target, cursor.endDate)) return count;
  }
  return count;
}
