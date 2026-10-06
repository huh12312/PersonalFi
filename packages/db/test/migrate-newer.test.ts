// SPDX-License-Identifier: MIT
/**
 * CF-2 (09-phase-9-dispatch.md §2b; WP 9.4): an older binary must never serve a
 * newer schema. Before this, `runMigrations` and `pendingMigrations` iterated the
 * files on disk only, so an applied version with no file was silently ignored: a
 * downgraded image migrated nothing and reported `/ready`. RUNBOOK "Upgrade"
 * recommended exactly that rollback.
 *
 * "Newer" is SET MEMBERSHIP — an applied version absent on disk — and never a
 * maximum-version comparison. Phase 9's migrations land on production in landing
 * order, not number order (0036 before 0035), so a max comparison would either
 * lock the holder out of an out-of-order install or, the other way round, miss a
 * database that holds a version the binary skipped. Both directions are pinned
 * below, and each test was observed red against the pre-CF-2 `migrate.ts`
 * (docs/evidence/phase-9/wp9.4-upgrade.md).
 *
 * Its own file, not the shared `migrate.test.ts` (the W-A batch edits that one).
 * Scratch databases are named `personalfi_wp94_*` so nothing collides with
 * another agent's.
 */
import { copyFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationError,
  pendingMigrations,
  readMigrationFiles,
  runMigrations,
} from '../src/migrate.ts';

const ADMIN_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;
if (ADMIN_URL === undefined) {
  console.warn('DATABASE_URL is unset; skipping the newer-database tests (run `just db-up`).');
}

const silent = { info: () => undefined, warn: () => undefined };

async function createScratchDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropScratchDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** A migrations directory holding exactly the named synthetic files. */
async function syntheticDir(versions: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pf-wp94-migrations-'));
  for (const version of versions) {
    writeFileSync(
      join(dir, `${version}_t${version}.sql`),
      `CREATE TABLE t${version} (id INTEGER PRIMARY KEY);\n`,
    );
  }
  return dir;
}

async function appliedVersions(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    return rows.map((row) => row.version);
  } finally {
    await client.end();
  }
}

async function withPool<T>(url: string, run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

/** Resolve to the MigrationError a promise rejects with, or fail the test. */
async function refusal(promise: Promise<unknown>): Promise<MigrationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return error as MigrationError;
  }
  throw new Error('expected a MigrationError refusal; the call resolved instead');
}

describeWithDb('CF-2: an older binary never serves a newer schema', () => {
  const dirs: string[] = [];
  const databases: string[] = [];

  async function scratch(name: string): Promise<string> {
    databases.push(name);
    return createScratchDatabase(name);
  }
  async function dir(versions: readonly string[]): Promise<string> {
    const made = await syntheticDir(versions);
    dirs.push(made);
    return made;
  }

  beforeAll(() => {
    expect(readMigrationFiles().length).toBeGreaterThan(1);
  });

  afterAll(async () => {
    for (const name of databases) await dropScratchDatabase(name);
    for (const made of dirs) await rm(made, { recursive: true, force: true });
  });

  it('a database holding a migration this binary lacks refuses to migrate and /ready stays false, named', async () => {
    // The shipped migrations, applied by "the newer release" ...
    const url = await scratch('personalfi_wp94_newer_real');
    await runMigrations({ databaseUrl: url, logger: silent });
    const files = readMigrationFiles();
    const newest = files.at(-1);
    expect(newest).toBeDefined();

    // ... then "the previous release": every file but the newest, byte-identical.
    const olderDir = await mkdtemp(join(tmpdir(), 'pf-wp94-older-'));
    dirs.push(olderDir);
    for (const file of files.slice(0, -1)) {
      copyFileSync(file.path, join(olderDir, `${file.version}_${file.name}.sql`));
    }
    const before = await appliedVersions(url);

    // The migrator (and its --dry-run) refuses, by code, naming the version.
    for (const dryRun of [false, true]) {
      const error = await refusal(
        runMigrations({ databaseUrl: url, migrationsDir: olderDir, logger: silent, dryRun }),
      );
      expect(error.code).toBe('migration.database_newer');
      expect(error.message).toContain(`${newest?.version}_${newest?.name}`);
    }

    // `/ready` calls exactly this; a refusal is never an empty "nothing pending".
    const readyError = await withPool(url, (pool) => refusal(pendingMigrations(pool, olderDir)));
    expect(readyError.code).toBe('migration.database_newer');
    expect(readyError.message).toContain(`${newest?.version}_${newest?.name}`);

    // Nothing was written by the refused run.
    expect(await appliedVersions(url)).toEqual(before);
    // And the binary that does have every file still reads the database as current.
    expect(await withPool(url, (pool) => pendingMigrations(pool, DEFAULT_MIGRATIONS_DIR))).toEqual(
      [],
    );
  }, 60_000);

  it('migrations applied out of number order converge and never read as newer', async () => {
    // Production applies Phase 9's migrations in landing order: 0036 (wave A)
    // before 0035 (wave B). Synthetic stand-ins: 0004 first, then 0003.
    const url = await scratch('personalfi_wp94_out_of_order');
    const waveA = await dir(['0001', '0002', '0004']);
    const waveB = await dir(['0001', '0002', '0003', '0004']);

    await runMigrations({ databaseUrl: url, migrationsDir: waveA, logger: silent });
    expect(await appliedVersions(url)).toEqual(['0001', '0002', '0004']);
    expect(await withPool(url, (pool) => pendingMigrations(pool, waveA))).toEqual([]);

    // Wave B's binary sees 0003 pending — not "the database is newer than me".
    expect(await withPool(url, (pool) => pendingMigrations(pool, waveB))).toEqual(['0003_t0003']);
    const result = await runMigrations({ databaseUrl: url, migrationsDir: waveB, logger: silent });
    expect(result.applied.map((m) => m.version)).toEqual(['0003']);
    expect(await appliedVersions(url)).toEqual(['0001', '0002', '0003', '0004']);
    expect(await withPool(url, (pool) => pendingMigrations(pool, waveB))).toEqual([]);

    // Converged: a second run applies nothing and refuses nothing.
    const again = await runMigrations({ databaseUrl: url, migrationsDir: waveB, logger: silent });
    expect(again.applied).toEqual([]);
  }, 60_000);

  it('newer is an applied version absent on disk, never a larger number', async () => {
    // The database holds 0004; this binary skipped it but carries a HIGHER 0005.
    // A max-version comparison reads that as "binary is newer" and serves a
    // schema it does not know. Set membership refuses, naming 0004.
    const url = await scratch('personalfi_wp94_set_membership');
    await runMigrations({
      databaseUrl: url,
      migrationsDir: await dir(['0001', '0002', '0004']),
      logger: silent,
    });
    const skipped = await dir(['0001', '0002', '0003', '0005']);

    const error = await refusal(
      runMigrations({ databaseUrl: url, migrationsDir: skipped, logger: silent }),
    );
    expect(error.code).toBe('migration.database_newer');
    expect(error.message).toContain('0004_t0004');
    expect(error.message).not.toContain('0005');
    const ready = await withPool(url, (pool) => refusal(pendingMigrations(pool, skipped)));
    expect(ready.code).toBe('migration.database_newer');
    // Neither 0003 nor 0005 was applied by the refused run.
    expect(await appliedVersions(url)).toEqual(['0001', '0002', '0004']);
  }, 60_000);

  it('an empty or fresh database is never "newer"', async () => {
    const url = await scratch('personalfi_wp94_fresh');
    const files = await dir(['0001', '0002']);
    // No schema_migrations table at all: everything pending, no refusal.
    expect(await withPool(url, (pool) => pendingMigrations(pool, files))).toEqual([
      '0001_t0001',
      '0002_t0002',
    ]);
    const result = await runMigrations({ databaseUrl: url, migrationsDir: files, logger: silent });
    expect(result.applied).toHaveLength(2);
  }, 60_000);
});
