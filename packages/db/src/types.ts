// SPDX-License-Identifier: MIT
import pg from 'pg';

const { types } = pg;

// Postgres type OIDs we deliberately override.
const OID_INT8 = 20;
const OID_DATE = 1082;

let installed = false;

/**
 * Install the node-postgres type parsers this codebase depends on.
 *
 * Two of these are correctness-critical:
 *
 * - **int8 (BIGINT).** node-postgres returns it as a *string* by default to avoid
 *   silent precision loss. Left alone, `"1234" + "567"` becomes `"1234567"` in a
 *   money column. We parse to `bigint`, which is what `Money` holds.
 * - **date (DATE).** The default parser builds a `Date` at local midnight, which
 *   is exactly how a 2026-03-01 posted date becomes 2026-02-28 for a user west of
 *   UTC. We keep the wire form, `YYYY-MM-DD`, which is `DateOnly`.
 *
 * `NUMERIC` is left as a string on purpose: it is `Quantity`, not a number.
 * `TIMESTAMPTZ` is left as a `Date`: it is a genuine instant.
 *
 * Idempotent, and must run before the first query. `createPool` calls it.
 */
export function installTypeParsers(): void {
  if (installed) return;
  types.setTypeParser(OID_INT8, (value: string) => BigInt(value));
  types.setTypeParser(OID_DATE, (value: string) => value);
  installed = true;
}

/** Test seam: forget that parsers were installed. */
export function resetTypeParsersForTest(): void {
  installed = false;
}
