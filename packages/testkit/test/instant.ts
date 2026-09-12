// SPDX-License-Identifier: MIT

/**
 * Re-exported from `@core/platform`, not reimplemented.
 *
 * `@core/db` deliberately leaves node-postgres's own `TIMESTAMPTZ` parser alone
 * for a raw `db.execute(sql\`...\`)`, but Drizzle's node-postgres session
 * installs its own type parsers and maps `TIMESTAMPTZ` itself — so a
 * hand-written query issued through a Drizzle `Database` gets back a string
 * (`'2026-03-02 08:15:00+00'`), not a `Date`, and `row.created_at.toISOString`
 * throws three frames away from the actual cause. Every test in this repo that
 * asserts on a raw-SQL timestamp column needs the same fix `@core/platform`
 * already wrote for its own outbox/job/schedule columns; re-exporting it here
 * means there is still exactly one implementation, not a second one that can
 * quietly disagree with the first.
 */
export { toInstant, toInstantOrNull, type TimestampValue } from '@core/platform';
