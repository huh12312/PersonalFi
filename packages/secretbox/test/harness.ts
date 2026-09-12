// SPDX-License-Identifier: MIT
/**
 * A real Postgres for the keyring's integration tests.
 *
 * There is no fake `SecretBoxQueryable` here, deliberately. The properties under
 * test are properties of the round trip through the database: that a `bytea`
 * arrives back as the same bytes, that `jsonb` parameters survive, that the
 * partial index on `retired_at IS NULL` really does pick the live key. A fake
 * would assert that the fake works, and the one thing P0-1 demands — reading the
 * raw column and finding no plaintext — cannot be asserted against one at all.
 *
 * `WP02_DATABASE_URL` (falling back to `DATABASE_URL`) points at an admin
 * database; each suite gets its own scratch database so a failure leaves the
 * others alone.
 */
import { createPool, runMigrations } from '@core/db';
import { newId } from '@core/kernel';
import type { SecretBoxQueryable } from '../src/store.ts';

export const ADMIN_URL = process.env['WP02_DATABASE_URL'] ?? process.env['DATABASE_URL'];

export interface TestDatabase {
  readonly url: string;
  readonly db: SecretBoxQueryable;
  readonly userId: string;
  createUser(displayName?: string): Promise<string>;
  drop(): Promise<void>;
}

const silent = { info: () => undefined, warn: () => undefined };

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  if (ADMIN_URL === undefined) {
    throw new Error('DATABASE_URL is unset; run `just db-up` first');
  }

  // `createPool` rather than a raw `pg.Client`: `personalfi/layer-imports` allows
  // `@core/db` in this package and denies `pg`, and the chokepoint rule is not
  // suspended for test helpers.
  const admin = createPool({ databaseUrl: ADMIN_URL, max: 1, applicationName: 'wp02-admin' });
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  await runMigrations({ databaseUrl, logger: silent });

  const pool = createPool({ databaseUrl, applicationName: `wp02-${name}`, max: 6 });

  async function createUser(displayName = 'Test Holder'): Promise<string> {
    const id = newId();
    await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, $2)`, [id, displayName]);
    return id;
  }

  const userId = await createUser();

  return {
    url: databaseUrl,
    db: pool,
    userId,
    createUser,
    async drop(): Promise<void> {
      await pool.end().catch(() => undefined);
      const cleanup = createPool({
        databaseUrl: ADMIN_URL,
        max: 1,
        applicationName: 'wp02-cleanup',
      });
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/**
 * Development-floor Argon2id: ~5 ms instead of ~5.9 s.
 *
 * The production parameters are enforced by `loadConfig` (`KEK_ARGON2_FLOORS`)
 * and evidenced in `docs/evidence/phase-0/wp0.2-argon2-parameters.md`. What these
 * suites test is the envelope, the keyring and the custody state machine, none of
 * which change with the cost parameters.
 */
export const TEST_KDF = { memoryKiB: 8_192, timeCost: 2, parallelism: 1 } as const;
