// SPDX-License-Identifier: MIT
/**
 * The seal: when a day stops being a calculation and becomes history.
 *
 * 08 §3.5, in its own words: *"today's row is maintained incrementally and is
 * mutable; at 02:00 local it is sealed and never touched again."*
 *
 * The failure this prevents is not a crash. It is a chart that quietly rewrites
 * itself. A past day recomputed tonight uses tonight's prices and tonight's
 * corrected balances, so every trend the app draws would be a trend through
 * numbers that were never true on the days they are plotted against — and
 * nothing about the screen would look wrong.
 *
 * ## Three overlapping guards, and why the overlap is deliberate
 *
 *   1. `net_worth_daily_sealed_rows_are_immutable`, the BEFORE UPDATE trigger in
 *      migration 0017. This is the one that holds when a future writer forgets:
 *      it covers `psql`, a migration, a repair script, and code nobody has
 *      written yet. It raises SQLSTATE 23514 with the constraint's name.
 *   2. `net_worth_daily_one_open_day_idx`, a partial UNIQUE index on
 *      `(user_id, as_of_date) WHERE sealed_at IS NULL`, so "the row the writer
 *      may touch" is never ambiguous and a race cannot open a second one.
 *   3. `assertSealable` and the guarded `WHERE sealed_at IS NULL` in
 *      `src/store.ts`, which produce a *typed* `SealedRowImmutable` for the
 *      ordinary case instead of a driver error five frames down.
 *
 * The §5 exit criterion — `'a past date is byte-identical after a second
 * snapshot run'` — is sabotage-tested against guard 1: the test removes the
 * `sealed_at IS NULL` from the writer's own WHERE clause and asserts the
 * database refuses it by constraint name. A test that only exercised guard 3
 * would be testing the code it is trying to catch changing.
 *
 * ## A correction does not mutate
 *
 * It inserts the *next revision* of the day carrying `supersedes_id` and
 * `correction_reason`, and the sealed row it replaces is not written to at all.
 * That is what makes the byte-for-byte diff of a sealed range across two runs a
 * meaningful test rather than a tautology about an idempotent UPDATE.
 */
import { todayIn, type Clock, type DateOnly } from '@core/kernel';

/** 08 §3.5's hour, as a constant rather than a `2` at a comparison site. */
export const SEAL_HOUR_LOCAL = 2;

/** The typed refusal. A caller that sees this has tried to rewrite history. */
export class SealedRowImmutable extends Error {
  override readonly name = 'SealedRowImmutable';
  readonly asOfDate: string;
  readonly revision: number;

  constructor(asOfDate: string, revision: number) {
    super(
      `net_worth_daily ${asOfDate} revision ${String(revision)} is sealed and may never be ` +
        'updated (08 §3.5). A correction is a new revision carrying supersedes_id and ' +
        'correction_reason; it never writes to the row it replaces.',
    );
    this.asOfDate = asOfDate;
    this.revision = revision;
  }
}

/**
 * The local wall-clock date and hour, in the user's zone.
 *
 * `Intl.DateTimeFormat` with an explicit `hourCycle` rather than arithmetic on a
 * UTC offset: the offset changes twice a year and the whole point of sealing at
 * *02:00 local* is that it stays 02:00 across a DST transition. The scheduler
 * makes the same choice for the same reason (`cron-parser` with the row's IANA
 * zone), and two different answers to "what time is it there?" in one system is
 * how a day gets sealed twice or not at all.
 */
export function localHourIn(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === 'hour');
  if (hour === undefined) {
    throw new RangeError(`no hour part for time zone ${JSON.stringify(timeZone)}`);
  }
  return Number(hour.value);
}

/** Today, in the user's zone. The one day that is still allowed to move. */
export function openDateIn(clock: Clock, timeZone: string): DateOnly {
  return todayIn(clock, timeZone);
}

/**
 * May `asOfDate` be sealed, as of `now` in `timeZone`?
 *
 * A day is sealable once the local clock has reached 02:00 on the day *after*
 * it. So 2026-06-14 seals at 2026-06-15T02:00 local and not before — which
 * leaves the two hours after midnight for a late-arriving sync to land in the
 * day it belongs to rather than in a correction.
 *
 * Deliberately `>=` on the hour and strict on the date: a job that fires at
 * exactly 02:00:00 must seal, and 04:00 (the snapshot schedule) is comfortably
 * past it either way.
 */
export function isSealable(asOfDate: string, clock: Clock, timeZone: string): boolean {
  const today = todayIn(clock, timeZone);
  if (asOfDate >= today) return false;
  // Yesterday needs the hour check; anything older is past 02:00 of the day
  // after it by definition, whatever the hour is now.
  const dayAfter = nextDay(asOfDate);
  if (dayAfter < today) return true;
  return localHourIn(timeZone, clock.now()) >= SEAL_HOUR_LOCAL;
}

/** Every open day that has earned its seal, oldest first. */
export function sealableDates(
  openDates: readonly string[],
  clock: Clock,
  timeZone: string,
): readonly string[] {
  return [...openDates].sort().filter((date) => isSealable(date, clock, timeZone));
}

/**
 * Refuse a write to a row that is already sealed, in this process, by name.
 *
 * The database would refuse it too — that is guard 1 — but a `23514` surfacing
 * out of a job handler tells an operator that *some* check failed somewhere.
 * This tells them which day, which revision, and what to do instead.
 */
export function assertSealable(row: {
  readonly asOfDate: string;
  readonly revision: number;
  readonly sealedAt: Date | null;
}): void {
  if (row.sealedAt !== null) {
    throw new SealedRowImmutable(row.asOfDate, row.revision);
  }
}

function nextDay(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
