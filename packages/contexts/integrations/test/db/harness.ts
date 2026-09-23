// SPDX-License-Identifier: MIT
/**
 * The `@ctx/integrations` database-test harness.
 *
 * ## Why this is not `@core/testkit`
 *
 * Every other `*-db` suite in this repo uses `createTestDatabase` from
 * `@core/testkit`, and this one should too — eventually. It cannot yet:
 * `scripts/eslint-boundaries.js` has no `integrations` layer, so this package
 * falls under the generic `context` entry, whose allow-list is
 * `@core/{kernel,config,db,contracts,platform,secretbox}` plus `drizzle-orm`
 * and (in `*.test.ts` only) `vitest` and `fast-check`. `@core/testkit` is not
 * on it. The dispatch's §4 shared-file list has the orchestrator adding that
 * layer at a wave boundary, exactly as it did for `ledger`, `notifications` and
 * `insights`; until then, an import of `@core/testkit` from here is a lint
 * failure, and reaching for an `eslint-disable` to get around a boundary rule
 * is how a boundary becomes advisory.
 *
 * So this file does the same three things `@core/testkit` does — create a
 * scratch database, migrate it, seed one account holder — with nothing but
 * `@core/db`, `@core/kernel`, `@core/platform` and `drizzle-orm`. **When the
 * `integrations` layer lands, delete this and import `@core/testkit`**; the
 * shapes are deliberately the same as `@ctx/investments`' copy, so the change
 * is one import and one function name.
 *
 * ## One database per suite, and never the investments suite's
 *
 * `integrations-db` runs with `fileParallelism: false`, but a shared database
 * would still make every suite depend on the order the others ran in — and the
 * creation path drops and recreates, so the second suite to start would delete
 * the first one's evidence mid-run. That hazard is not confined to this
 * package: `@ctx/investments`' harness creates `personalfi_wp_sec_*` and both
 * projects can run in the same `vitest run`, so the prefix here is
 * `personalfi_wp_prices` — a different word, not a different suffix, so no
 * `suite` argument can ever collide the two.
 */

import {
  createDatabase,
  createPool,
  installTypeParsers,
  runMigrations,
  type Database,
} from '@core/db';
import { newId } from '@core/kernel';
import type { Executor } from '@core/platform';
import { sql, type SQL } from 'drizzle-orm';

export const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'];

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** Fixed, so a failure message reads the same twice. */
export const EPOCH = '2026-09-21T03:45:00.000Z';
export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000d4';

export interface TestDatabase {
  readonly url: string;
  readonly db: Database;
  readonly userId: string;
  createUser(displayName?: string): Promise<string>;
  /** A `securities` row, because `prices` references one. Returns its id. */
  createSecurity(kind?: string): Promise<string>;
  truncate(): Promise<void>;
  drop(): Promise<void>;
}

const silent = { info: () => undefined, warn: () => undefined };

/**
 * Create a scratch database, migrate it, and seed one account holder.
 *
 * `suite` becomes part of the Postgres database name, so it must be a valid
 * unquoted identifier — lowercase, digits, underscores. Two suites racing to
 * create the same name is a bug in the caller (each suite owns a name derived
 * from its own file), not something this function tries to arbitrate.
 */
export async function integrationsDatabase(suite: string): Promise<TestDatabase> {
  const adminUrl = ADMIN_URL;
  if (adminUrl === undefined) {
    throw new Error(
      'TEST_ADMIN_DATABASE_URL/DATABASE_URL is unset; run `just db-up` first ' +
        '(see docs/TESTING.md, "Database-backed tests").',
    );
  }

  installTypeParsers();
  const name = `personalfi_wp_prices_${suite}`;

  const adminPool = createPool({
    databaseUrl: adminUrl,
    applicationName: 'integrations-admin',
    max: 2,
  });
  const admin = createDatabase(adminPool);
  try {
    // `sql.raw` because CREATE DATABASE takes no parameters; `name` is built
    // from a literal suite string in this package's own tests and never from
    // anything a user typed.
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await adminPool.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  await runMigrations({ databaseUrl, logger: silent });

  const pool = createPool({ databaseUrl, applicationName: `integrations-${suite}`, max: 8 });
  const db = createDatabase(pool);

  async function createUser(displayName = 'Test Holder'): Promise<string> {
    const id = newId();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${id}::uuid, ${displayName})`,
    );
    return id;
  }

  const userId = await createUser();

  async function createSecurity(kind = 'etf'): Promise<string> {
    const id = newId();
    // The minimum `securities` row 0013 will accept. It exists so a `prices`
    // constraint test has something to reference; nothing here asserts on it.
    await db.execute(sql`
      INSERT INTO securities (id, user_id, identity_kind, identity_key, ticker,
                              name, type, currency, classification_source)
      VALUES (${id}::uuid, ${userId}::uuid, 'figi', ${`FIGI:${id}`}, 'VTI',
              'Vanguard Total Stock Market ETF', ${kind}, 'USD', 'UNCLASSIFIED')
    `);
    return id;
  }

  return {
    url: databaseUrl,
    db,
    userId,
    createUser,
    createSecurity,
    async truncate() {
      await db.execute(
        sql.raw(
          'TRUNCATE market_data_runs, price_source_priority, fx_rates, prices, ' +
            'securities, domain_events RESTART IDENTITY CASCADE',
        ),
      );
    },
    async drop() {
      await pool.end();
      const cleanupPool = createPool({
        databaseUrl: adminUrl,
        applicationName: 'integrations-admin',
        max: 2,
      });
      try {
        await createDatabase(cleanupPool).execute(
          sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
        );
      } finally {
        await cleanupPool.end();
      }
    },
  };
}

/**
 * The scratch database as `@core/platform`'s `Executor`.
 *
 * `appendEvent` takes an executor rather than a pool so that an event cannot be
 * written outside the caller's transaction (see `outbox.ts`). A `Database` is
 * one structurally; the cast is only about the row generic, exactly as
 * `@ctx/investments`' `outboxOf` does it.
 */
export function outboxOf(database: Database): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      database.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/**
 * The Postgres error a statement raised: its `SQLSTATE` and its constraint name.
 *
 * Drizzle wraps the driver's error, so `code` is on `error.cause` rather than
 * on the error itself and a bare `rejects.toMatchObject({ code })` passes for
 * the wrong reason — or, worse, fails while the constraint is working
 * perfectly. Unwrapping here means a suite asserts on the **constraint's name**,
 * which is the thing a reader can check against the migration.
 */
export async function pgFailureOf(
  run: Promise<unknown>,
): Promise<{ readonly code: string; readonly constraint: string }> {
  try {
    await run;
  } catch (error) {
    const cause = (error as { readonly cause?: unknown }).cause ?? error;
    const detail = cause as { readonly code?: string; readonly constraint?: string };
    return { code: detail.code ?? 'none', constraint: detail.constraint ?? 'none' };
  }
  throw new Error('pgFailureOf: the statement was expected to fail, and it succeeded');
}

export async function countRows(database: TestDatabase, table: string): Promise<number> {
  const result = await database.db.execute<{ count: string }>(
    sql.raw(`SELECT count(*)::text AS count FROM ${table}`),
  );
  return Number(result.rows[0]?.count ?? '0');
}
