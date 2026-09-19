// SPDX-License-Identifier: MIT
/**
 * Wall-clock arithmetic in the account holder's zone.
 *
 * Two things in this context are calendar facts rather than instants — the
 * quiet-hours window and the digest window — and both are stated in local time:
 * "22:00 to 07:00", "the week beginning Monday". Computing either by adding a
 * fixed number of milliseconds is wrong twice a year, and it is wrong in the
 * direction that matters: on the spring-forward night a notification held with
 * "+9 hours" is released an hour *late*, and on the fall-back night an hour
 * *early* — which is to say, inside quiet hours, which is the one thing the
 * feature exists to prevent.
 *
 * `@core/kernel`'s `todayIn` is the only zone-aware helper the shared kernel
 * offers and it answers a date, not a time, so the rest lives here. Nothing
 * below reads a clock: every function takes the instant it is asked about.
 *
 * ## The two-pass local→instant solve
 *
 * "07:00 on 2026-03-08 in America/New_York" names an instant, but finding it
 * needs the offset, and the offset needs the instant. The standard fix is to
 * guess with the offset at the UTC-interpreted time, then re-guess with the
 * offset at the first guess. Two passes converge everywhere a zone's offset is
 * piecewise-constant with transitions at least an hour apart, which is every
 * IANA zone.
 *
 * Two local times are pathological and both are handled explicitly rather than
 * being allowed to fall out of the arithmetic:
 *
 * * **A gap** (02:30 on a spring-forward morning) names no instant at all.
 *   `instantForLocalTime` returns the first instant *after* the gap, so a
 *   release time that does not exist releases late by minutes rather than
 *   never, or — far worse — a year.
 * * **A fold** (01:30 on a fall-back morning) names two. It returns the
 *   earlier, because for a release time "as soon as the wall clock first says
 *   07:00" is the reading a user would recognise.
 */
import { DateOnly, type DateOnly as DateOnlyType } from '@core/kernel';

export const MINUTES_PER_DAY = 1440;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall clock in `timeZone` at `instant`. */
export function localPartsIn(timeZone: string, instant: Date): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) throw new TypeError(`no ${type} part for ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hourCycle: 'h23'` still formats midnight as 24 in some ICU builds.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Minutes since local midnight. 22:00 is 1320; 07:00 is 420. */
export function localMinuteOfDay(timeZone: string, instant: Date): number {
  const parts = localPartsIn(timeZone, instant);
  return parts.hour * 60 + parts.minute;
}

export function localDateIn(timeZone: string, instant: Date): DateOnlyType {
  const parts = localPartsIn(timeZone, instant);
  return DateOnly.parse(
    `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
  );
}

/** The local wall clock, expressed as the epoch ms it would be if it were UTC. */
function localEpochMs(timeZone: string, instant: Date): number {
  const parts = localPartsIn(timeZone, instant);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * The instant at which the wall clock in `timeZone` reads
 * `date` at `minuteOfDay`.
 *
 * See the header for the gap and fold rules.
 */
export function instantForLocalTime(
  timeZone: string,
  date: DateOnlyType,
  minuteOfDay: number,
): Date {
  const [year = 1970, month = 1, day = 1] = date
    .split('-')
    .map((part) => Number.parseInt(part, 10));
  const target = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);

  const first = target - (localEpochMs(timeZone, new Date(target)) - target);
  const second = target - (localEpochMs(timeZone, new Date(first)) - first);

  const candidates = [first, second].filter(
    (candidate) => localEpochMs(timeZone, new Date(candidate)) === target,
  );
  if (candidates.length > 0) {
    // A fold names two instants; take the earlier, which is the first time the
    // wall clock reads it.
    return new Date(Math.min(...candidates));
  }
  // A gap names none. The later candidate sits after the transition, which is
  // the first instant at which the clock has passed the requested time.
  return new Date(Math.max(first, second));
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

export interface QuietHours {
  readonly enabled: boolean;
  readonly timeZone: string;
  /** Minutes from local midnight. 1320 = 22:00. */
  readonly startMinute: number;
  /** Minutes from local midnight. 420 = 07:00. */
  readonly endMinute: number;
}

/**
 * Is the wall clock inside the window?
 *
 * The window is half-open, `[start, end)`, and wraps when `start > end` —
 * 22:00–07:00 does. A window with `start === end` would mean either "never" or
 * "always" depending on how you squint, so the schema forbids it
 * (`notification_rules_quiet_window_is_real`) and this treats it as never.
 */
export function isWithinQuietHours(minuteOfDay: number, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const { startMinute, endMinute } = quiet;
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

export function isQuietAt(instant: Date, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  return isWithinQuietHours(localMinuteOfDay(quiet.timeZone, instant), quiet);
}

/**
 * The instant quiet hours next end, for a notification that arrived at
 * `instant`.
 *
 * Computed as "the next time the wall clock reads `endMinute`", never as
 * "`instant` plus the remaining minutes". On the spring-forward morning those
 * two answers are an hour apart, and `test/db/quiet-hours.test.ts` asserts
 * which one this returns.
 */
export function quietHoursReleaseAt(instant: Date, quiet: QuietHours): Date {
  const today = localDateIn(quiet.timeZone, instant);
  const todayEnd = instantForLocalTime(quiet.timeZone, today, quiet.endMinute);
  if (todayEnd.getTime() > instant.getTime()) return todayEnd;
  return instantForLocalTime(quiet.timeZone, DateOnly.addDays(today, 1), quiet.endMinute);
}

// ---------------------------------------------------------------------------
// Digest windows
// ---------------------------------------------------------------------------

export type DigestCadenceName = 'DAILY' | 'WEEKLY';

export interface DigestWindow {
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/**
 * The window `instant` falls in, anchored on local midnight.
 *
 * `DAILY` is [local 00:00, next local 00:00); `WEEKLY` is [local Monday 00:00,
 * the next local Monday 00:00). Both are computed through
 * `instantForLocalTime`, so a week containing a DST transition is 169 or 167
 * hours long and still exactly one week of wall clock — which is what a user
 * who asked for "a weekly digest" meant.
 *
 * The bounds are what go into `notification_outbox.group_window_start/end`, and
 * `group_window_start` is part of the coalescing UNIQUE index. Two events
 * either side of a boundary therefore produce two rows *because the index says
 * so*, not because a job remembered to check.
 */
export function digestWindowFor(
  instant: Date,
  timeZone: string,
  cadence: DigestCadenceName,
): DigestWindow {
  const localToday = localDateIn(timeZone, instant);
  const startDate = cadence === 'DAILY' ? localToday : mondayOnOrBefore(localToday);
  const endDate = DateOnly.addDays(startDate, cadence === 'DAILY' ? 1 : 7);
  return {
    start: instantForLocalTime(timeZone, startDate, 0),
    end: instantForLocalTime(timeZone, endDate, 0),
  };
}

/**
 * The Monday of `date`'s local week.
 *
 * ISO weeks, because a "weekly digest" that arrives on a Sunday for a week that
 * started on a Sunday is the convention nobody in the app's locale uses. Monday
 * is also where `DateOnly.fromEpochDay(0)` — 1970-01-01, a Thursday — makes the
 * arithmetic obvious: `(epochDay + 3) mod 7` is days since Monday.
 */
export function mondayOnOrBefore(date: DateOnlyType): DateOnlyType {
  const daysSinceMonday = (((DateOnly.toEpochDay(date) + 3) % 7) + 7) % 7;
  return DateOnly.addDays(date, -daysSinceMonday);
}
