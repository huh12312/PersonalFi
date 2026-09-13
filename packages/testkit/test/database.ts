// SPDX-License-Identifier: MIT
import { createDatabase, createPool, runMigrations, type Database } from '@core/db';
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import pg from 'pg';

/**
 * A real Postgres for integration tests, shared by every package's test suite.
 *
 * There is no fake here on purpose. `FOR UPDATE SKIP LOCKED`, an advisory
 * lock surviving a dropped connection, `ON CONFLICT` deduplicating a concurrent
 * insert, a single-use `UPDATE ... WHERE used_at IS NULL` — every property a
 * `*-db` test suite in this repo asserts is a property of Postgres, not of our
 * TypeScript. A mock would only assert that the mock works.
 *
 * `TEST_ADMIN_DATABASE_URL` (falling back to `DATABASE_URL`) points at an admin
 * connection; each suite gets its own scratch database by name, so nothing
 * depends on execution order and a failed suite leaves the others' data alone.
 */

export const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export interface TestDatabase {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly db: Database;
  readonly userId: string;
  /** Seed a second account holder, for the tests that need two. */
  createUser(displayName?: string): Promise<string>;
  /**
   * Wipe rows without dropping the database.
   *
   * With no argument, every base table in the `public` schema is truncated
   * except `schema_migrations` (the migration ledger) and `users` (the seeded
   * holder every other row's `user_id` foreign key depends on — see
   * `createUser` if a test genuinely wants a second one gone too).
   *
   * Pass an explicit list to scope it — the platform suites do, so an
   * `event_consumer_offsets` row from one test cannot leak into the next
   * without dropping unrelated context tables in between.
   *
   * **Read this before asserting on a sequence.** `TRUNCATE ... RESTART
   * IDENTITY CASCADE` only restarts the identity sequence of the tables named
   * in the statement; a table dragged in only by `CASCADE` (because it has a
   * foreign key to one you named) has its rows deleted but keeps counting from
   * wherever it was. A test that calls `truncate(['jobs'])` and then expects
   * `job_runs.id` (cascaded, not named) to restart at 1 will be flaky the
   * second time it runs in the same suite. Prefer no argument, or name every
   * table you need a fresh sequence on.
   */
  truncate(tables?: readonly string[]): Promise<void>;
  /** Close the pool. The database itself is left in place. */
  close(): Promise<void>;
  /** Close the pool and drop the scratch database. */
  drop(): Promise<void>;
}

const silentMigrationLogger = { info: () => undefined, warn: () => undefined };

/**
 * Never truncated by the no-argument form of `truncate()`: the migration
 * ledger is not test data, and `users` is what every other row's `user_id`
 * foreign key depends on for the lifetime of the `TestDatabase`.
 */
const PRESERVED_TABLES = new Set(['schema_migrations', 'users']);

export interface CreateTestDatabaseOptions {
  /** Overrides `ADMIN_URL`, for a caller that manages its own admin pool. */
  readonly adminUrl?: string;
  /** Overrides the default seeded holder's display name. */
  readonly displayName?: string;
}

/**
 * Create a scratch database, migrate it, and seed one account holder.
 *
 * `name` becomes the Postgres database name, so it must be a valid unquoted
 * identifier — lowercase, digits, underscores. Two suites racing to create the
 * same name is a bug in the caller (each suite should own a name derived from
 * its own file), not something this function tries to arbitrate.
 */
export async function createTestDatabase(
  name: string,
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const adminUrl = options.adminUrl ?? ADMIN_URL;
  if (adminUrl === undefined) {
    throw new Error(
      'TEST_ADMIN_DATABASE_URL/DATABASE_URL is unset; run `just db-up` first ' +
        '(see docs/TESTING.md, "Database-backed tests").',
    );
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  await runMigrations({ databaseUrl, logger: silentMigrationLogger });

  const pool = createPool({ databaseUrl, applicationName: `testkit-${name}`, max: 12 });
  const db = createDatabase(pool);

  const userId = newId();
  await db.execute(sql`
    INSERT INTO users (id, display_name) VALUES (${userId}::uuid, ${options.displayName ?? 'Test Holder'})
  `);

  async function discoverTruncatableTables(): Promise<string[]> {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    return result.rows.map((row) => row.table_name).filter((table) => !PRESERVED_TABLES.has(table));
  }

  return {
    url: databaseUrl,
    pool,
    db,
    userId,

    async createUser(displayName = 'Second Holder') {
      const id = newId();
      await db.execute(sql`
        INSERT INTO users (id, display_name) VALUES (${id}::uuid, ${displayName})
      `);
      return id;
    },

    async truncate(tables) {
      const names = tables ?? (await discoverTruncatableTables());
      if (names.length === 0) return;
      const identifiers = sql.join(
        names.map((table) => sql.identifier(table)),
        sql.raw(', '),
      );
      await db.execute(sql`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
    },

    async close() {
      await endPool(pool);
    },

    async drop() {
      // `pool.end()` waits for every checked-out client to be released, and a
      // test that failed before releasing one has left an advisory-lease
      // connection checked out forever. Without the timeout the whole suite
      // reports "hook timed out" instead of the assertion that actually failed.
      await endPool(pool);
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        // FORCE terminates whatever the leaked pool client was still holding.
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * `pool.end()`, but bounded.
 *
 * `pg.Pool#end()` resolves only once every checked-out client has been
 * released, and a test that threw before calling `client.release()` (or before
 * an advisory lease's `stop()`) has left one checked out forever. Left
 * unbounded, `drop()`/`close()` never resolve and the failure that actually
 * matters — the original assertion — is buried under a generic "hook timed
 * out" from the test runner instead.
 */
export async function endPool(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const giveUp = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([pool.end().catch(() => undefined), giveUp]);
}
