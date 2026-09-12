// SPDX-License-Identifier: MIT
import { createDatabase, createPool, runMigrations } from '@core/db';
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { platformExecutor } from '../src/database.ts';
import type { TransactionalExecutor } from '../src/executor.ts';

/**
 * A real Postgres for the platform's integration tests.
 *
 * There is no fake here on purpose. Every property this package claims —
 * `FOR UPDATE SKIP LOCKED` handing one row to one worker, an advisory lock
 * surviving a dropped connection, `ON CONFLICT` deduplicating two concurrent
 * enqueues, a transaction rolling an event back with its data — is a property of
 * Postgres, not of our TypeScript. A mock would assert that the mock works.
 *
 * `WP03_DATABASE_URL` (falling back to `DATABASE_URL`) points at an admin
 * database; each suite gets its own scratch database so nothing depends on
 * execution order and a failure leaves the others' data alone.
 */

export const ADMIN_URL = process.env['WP03_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export interface TestDatabase {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly db: TransactionalExecutor;
  readonly userId: string;
  /** Seed a second account holder, for the tests that need two. */
  createUser(displayName?: string): Promise<string>;
  truncate(): Promise<void>;
  close(): Promise<void>;
  drop(): Promise<void>;
}

const silent = { info: () => undefined, warn: () => undefined };

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  if (ADMIN_URL === undefined) {
    throw new Error('DATABASE_URL is unset; run `just db-up` first');
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  await runMigrations({ databaseUrl, logger: silent });

  const pool = createPool({ databaseUrl, applicationName: `wp03-${name}`, max: 12 });
  const db = platformExecutor(createDatabase(pool));

  const userId = newId();
  await db.execute(sql`
    INSERT INTO users (id, display_name) VALUES (${userId}::uuid, 'Test Holder')
  `);

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

    async truncate() {
      await db.execute(sql`
        TRUNCATE domain_events, processed_events, event_consumer_offsets,
                 jobs, job_runs, schedules, config_snapshots, feature_flags
        RESTART IDENTITY CASCADE
      `);
    },

    async close() {
      await pool.end();
    },

    async drop() {
      await pool.end().catch(() => undefined);
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** A logger that records what it was told, for asserting on warn/error paths. */
export interface RecordingLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  readonly lines: Array<{ level: string; obj: Record<string, unknown>; msg: string | undefined }>;
}

export function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger['lines'] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      lines.push({ level, obj, msg });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    lines,
  };
}

/** Poll until `predicate` holds or the deadline passes. Beats an arbitrary sleep. */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 10_000, intervalMs = 25, what = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
