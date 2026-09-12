// SPDX-License-Identifier: MIT
import pg from 'pg';

/**
 * Turn a TIMESTAMPTZ that came back from a raw `execute()` into a `Date`.
 *
 * ## Why this file has to exist
 *
 * `@core/db` deliberately leaves node-postgres's `timestamptz` parser alone —
 * "`TIMESTAMPTZ` is left as a `Date`: it is a genuine instant" — and that is true
 * of every query issued through the driver. It is **not** true of a query issued
 * through Drizzle. Drizzle's node-postgres session builds its query config with
 * its own `types.getTypeParser`, which returns the raw string for `TIMESTAMPTZ`,
 * `TIMESTAMP`, `DATE` and `INTERVAL` (see `drizzle-orm/node-postgres/session.js`)
 * because the ORM layer maps those columns itself. A hand-written
 * `db.execute(sql`…`)` has no column metadata to map with, so the string escapes
 * as-is and `row.next_run_at` is `'2026-03-02 08:15:00+00'`, not a `Date`.
 *
 * That difference is invisible at the type level — the row type is whatever the
 * caller declares — and it surfaces three frames later as
 * `row.next_run_at.toISOString is not a function`, inside a `try` that logs and
 * carries on. Every raw timestamp this package reads therefore goes through here,
 * so the discrepancy stops at the row boundary.
 *
 * The parser is the driver's own, fetched lazily from the global registry rather
 * than hand-rolled: it already handles microseconds, BC dates and the `+HH` and
 * `+HH:MM` offset forms, and if `@core/db` ever overrides `timestamptz` globally
 * this picks that up instead of quietly disagreeing with it.
 */

const TIMESTAMPTZ_OID = 1184;

/** What a TIMESTAMPTZ column may arrive as, depending on who ran the query. */
export type TimestampValue = Date | string;

let parseTimestamptz: ((value: string) => unknown) | undefined;

function parse(value: string): Date {
  parseTimestamptz ??= pg.types.getTypeParser(TIMESTAMPTZ_OID, 'text') as (
    value: string,
  ) => unknown;
  const parsed = parseTimestamptz(value);
  if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) return parsed;
  // `infinity`/`-infinity` parse to a number, and a malformed value to an
  // Invalid Date. Neither belongs in any column this package owns, and both are
  // far cheaper to diagnose here than as an `Invalid Date` written back later.
  throw new TypeError(`cannot read ${JSON.stringify(value)} as a timestamptz`);
}

/** Coerce a TIMESTAMPTZ column value to a `Date`. Throws on null. */
export function toInstant(value: TimestampValue): Date {
  return value instanceof Date ? value : parse(value);
}

/** Coerce a nullable TIMESTAMPTZ column value. `null`/`undefined` pass through. */
export function toInstantOrNull(value: TimestampValue | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return toInstant(value);
}
