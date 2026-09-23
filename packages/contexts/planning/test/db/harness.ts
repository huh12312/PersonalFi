// SPDX-License-Identifier: MIT
/**
 * The `planning-db` harness.
 *
 * Thin, because `@core/testkit` does the work: `scripts/eslint-boundaries.js`
 * puts `@core/testkit` on the `planning` layer's allow-list (dev-only, declared
 * as a `devDependency`), so unlike `@ctx/investments`' suite this package never
 * needed its own copy of `createTestDatabase`.
 *
 * What is here is the two helpers the seal test cannot do without: a row dump
 * normalised so two runs can be compared **byte for byte**, and an unwrapper for
 * the SQLSTATE and constraint name Drizzle buries on `error.cause`.
 */
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';

export const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'];

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** Fixed, so a failure message reads the same twice. */
export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000c8';

/**
 * The scratch database the dispatch names for this work package.
 *
 * One per suite file, suffixed, because `planning-db` runs with
 * `fileParallelism: false` but a shared database would still make each suite
 * depend on the order the others ran in — and creation drops and recreates, so
 * the second suite to start would delete the first one's evidence mid-run.
 */
export function planningDatabase(suite: string): Promise<TestDatabase> {
  return createTestDatabase(`personalfi_wp_networth_${suite}`);
}

/**
 * Every row of `net_worth_daily` for a date range, as canonical JSON text.
 *
 * This is the instrument the §5 exit criterion is measured with, so it is worth
 * being precise about what it does and does not normalise.
 *
 * It renders `bigint` and `Date` as strings, because `JSON.stringify` throws on
 * the first and renders the second inconsistently across drivers — neither is a
 * fact about the row. It sorts object keys, because column order in a `SELECT *`
 * is a fact about Postgres and not about the data.
 *
 * It normalises **nothing else**. In particular `updated_at`, `computed_at`,
 * `sealed_at`, `revision` and the whole `breakdown` JSONB are compared exactly
 * as stored. That matters: an implementation that "re-sealed" a day by touching
 * `updated_at`, or that rewrote an identical breakdown with the keys in a
 * different order, would pass a test that normalised those away — and both are
 * writes to a sealed row, which is the thing being forbidden.
 */
export async function dumpRange(
  database: TestDatabase,
  userId: string,
  from: string,
  to: string,
): Promise<string> {
  const result = await database.db.execute<Record<string, unknown>>(sql`
    SELECT * FROM net_worth_daily
     WHERE user_id = ${userId}::uuid
       AND as_of_date BETWEEN ${from}::date AND ${to}::date
     ORDER BY as_of_date, revision
  `);
  return JSON.stringify(result.rows.map(canonicalise), null, 2);
}

function canonicalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, canonicalise(inner)]),
    );
  }
  return value;
}

/**
 * The Postgres error a statement raised: its SQLSTATE and its constraint name.
 *
 * Drizzle wraps the driver's error, so `code` lives on `error.cause` rather than
 * on the error itself, and a bare `rejects.toMatchObject({ code })` passes for
 * the wrong reason — or fails while the constraint is working perfectly.
 * Unwrapping here means a suite asserts on the **constraint's name**, which is
 * the thing a reader can check against the migration.
 */
export async function pgFailureOf(
  run: Promise<unknown>,
): Promise<{ readonly code: string; readonly constraint: string; readonly message: string }> {
  try {
    await run;
  } catch (error) {
    const cause = (error as { readonly cause?: unknown }).cause ?? error;
    const detail = cause as {
      readonly code?: string;
      readonly constraint?: string;
      readonly message?: string;
    };
    return {
      code: detail.code ?? 'none',
      constraint: detail.constraint ?? 'none',
      message: detail.message ?? String(error),
    };
  }
  throw new Error('pgFailureOf: the statement was expected to fail, and it succeeded');
}
