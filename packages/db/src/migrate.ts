// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { installTypeParsers } from './types.ts';

const { Client } = pg;

/**
 * Advisory lock key for migrations: the ASCII bytes of `PFMIGRAT` as a signed
 * int64. Any value works as long as it never changes; a constant means two
 * `api` containers starting at once cannot both migrate.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 0x50464d4947524154n;

export const DEFAULT_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly executionMs: number;
}

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

const consoleLogger: MigrationLogger = {
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
};

export class MigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function checksumOf(sql: string): string {
  // Normalise line endings so a checkout on another platform does not read as drift.
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/** Read and validate the migration directory, in lexical (= chronological) order. */
export function readMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
  const seen = new Set<string>();
  return entries.map((entry) => {
    const match = FILENAME_PATTERN.exec(entry);
    if (match === null) {
      throw new MigrationError(
        'migration.bad_filename',
        `${entry}: migrations must be named NNNN_snake_case.sql`,
      );
    }
    const [, version = '', name = ''] = match;
    if (seen.has(version)) {
      throw new MigrationError(
        'migration.duplicate_version',
        `duplicate migration version ${version}`,
      );
    }
    seen.add(version);
    const path = join(dir, entry);
    const sql = readFileSync(path, 'utf8');
    return { version, name, path, sql, checksum: checksumOf(sql) };
  });
}

/**
 * CF-2 (09-phase-9-dispatch.md §2b, WP 9.4): refuse a database that has applied a
 * migration this binary does not carry. That database was migrated by a newer
 * release, and an older binary serving it would read and write a schema it does
 * not know — which is exactly what "pin the prior image" rollback used to do,
 * silently, with `/ready` green.
 *
 * "Newer" is SET MEMBERSHIP: an applied version with no file on disk. Never a
 * maximum-version comparison — Phase 9's migrations land on production in landing
 * order, not number order (0036 before 0035), and a max comparison would both
 * lock out a legitimately out-of-order install and miss a database holding a
 * version this binary skipped while carrying a higher one
 * (`packages/db/test/migrate-newer.test.ts`).
 */
function refuseDatabaseNewer(
  applied: ReadonlyArray<{ version: string; name?: string | null }>,
  files: readonly MigrationFile[],
): void {
  const onDisk = new Set(files.map((file) => file.version));
  const unknown = applied
    .filter((row) => !onDisk.has(row.version))
    .map((row) => (row.name ? `${row.version}_${row.name}` : row.version))
    .sort();
  if (unknown.length === 0) return;
  throw new MigrationError(
    'migration.database_newer',
    `migration.database_newer: the database has applied ${unknown.join(', ')}, which this ` +
      'binary does not carry — it was migrated by a newer release. Refusing to migrate or ' +
      'serve it: an older binary never runs against a newer schema. Run the release that ' +
      'applied it, or roll back by restoring the pre-migration backup (RUNBOOK.md "Upgrade").',
  );
}

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version      TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  checksum     TEXT        NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_ms INTEGER     NOT NULL
);
-- A re-stamp (below) keeps the checksum that was recorded when the file was
-- applied, so the row still says what ran. Both columns are NULL for every
-- migration that was never re-stamped.
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS previous_checksum TEXT;
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS restamped_at TIMESTAMPTZ;`;

/**
 * A deliberate, two-factor acknowledgement that an applied migration's *file*
 * changed without its SQL changing — the only legitimate case is a comment
 * edit, typically after a history rewrite. The operator names the version and
 * the checksum the database recorded when it applied the file (at least its
 * first twelve hex characters, which is what the refusal prints); the migrator
 * records the file's new checksum and keeps the old one in `previous_checksum`.
 * It never re-runs the SQL. Nothing here relaxes the immutability rule for a
 * version the operator did not name.
 */
export interface RestampRequest {
  readonly version: string;
  readonly previousChecksum: string;
}

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  readonly migrationsDir?: string;
  readonly logger?: MigrationLogger;
  /** Report what would run, change nothing. */
  readonly dryRun?: boolean;
  /** Applied migrations whose changed file the operator vouches for (see `RestampRequest`). */
  readonly restamp?: readonly RestampRequest[];
}

export interface RunMigrationsResult {
  readonly applied: readonly AppliedMigration[];
  readonly alreadyApplied: number;
  readonly pending: readonly string[];
  /** Versions whose recorded checksum was replaced by the file's (empty unless `restamp` was given). */
  readonly restamped: readonly string[];
}

/**
 * Apply every pending migration, in order, under an advisory lock.
 *
 * Forward-only: there are no down migrations. For a single-user app the recovery
 * path is restore-from-backup, and a maintained-but-never-tested `down` script is
 * false comfort. Each file runs in its own transaction together with its
 * bookkeeping row, so a failure leaves a consistent, resumable state.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  installTypeParsers();
  const logger = options.logger ?? consoleLogger;
  const files = readMigrationFiles(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();

  const applied: AppliedMigration[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    await client.query(BOOTSTRAP_SQL);

    const { rows } = await client.query<{ version: string; checksum: string; name: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    const alreadyApplied = new Map(rows.map((row) => [row.version, row]));
    // Before anything else, including --dry-run: a refusal is the answer to
    // "what would run" as much as to "run it".
    refuseDatabaseNewer(rows, files);

    const restampByVersion = new Map((options.restamp ?? []).map((r) => [r.version, r]));
    for (const request of restampByVersion.values()) {
      if (!/^[0-9a-f]{12,64}$/u.test(request.previousChecksum)) {
        throw new MigrationError(
          'migration.restamp_invalid',
          `--restamp ${request.version}: the previous checksum must be at least twelve hex characters.`,
        );
      }
      if (!alreadyApplied.has(request.version)) {
        throw new MigrationError(
          'migration.restamp_invalid',
          `--restamp ${request.version}: that migration has not been applied here; nothing to re-stamp.`,
        );
      }
      if (!files.some((file) => file.version === request.version)) {
        throw new MigrationError(
          'migration.restamp_invalid',
          `--restamp ${request.version}: no migration file carries that version.`,
        );
      }
    }
    const restamped: string[] = [];

    const pending: string[] = [];
    for (const file of files) {
      const record = alreadyApplied.get(file.version);
      if (record !== undefined) {
        const request = restampByVersion.get(file.version);
        if (request !== undefined) {
          if (!record.checksum.startsWith(request.previousChecksum)) {
            throw new MigrationError(
              'migration.restamp_mismatch',
              `--restamp ${file.version}: the database recorded ${record.checksum.slice(0, 12)}, ` +
                `not ${request.previousChecksum.slice(0, 12)}. Re-stamping needs the recorded checksum.`,
            );
          }
          if (record.checksum === file.checksum) {
            throw new MigrationError(
              'migration.restamp_unneeded',
              `--restamp ${file.version}: the file's checksum already matches the record; nothing to do.`,
            );
          }
          if (options.dryRun !== true) {
            await client.query(
              'UPDATE schema_migrations SET previous_checksum = $2, checksum = $3, restamped_at = now() WHERE version = $1',
              [file.version, record.checksum, file.checksum],
            );
            logger.info(
              `re-stamped ${file.version}_${file.name}: ${record.checksum.slice(0, 12)} → ${file.checksum.slice(0, 12)} (the SQL was not re-run)`,
            );
          }
          restamped.push(`${file.version}_${file.name}`);
          continue;
        }
        if (record.checksum !== file.checksum) {
          throw new MigrationError(
            'migration.drift',
            `${file.version}_${file.name}.sql changed after it was applied ` +
              `(recorded ${record.checksum.slice(0, 12)}, file ${file.checksum.slice(0, 12)}). ` +
              'Applied migrations are immutable: add a new migration instead. If only comments changed ' +
              '(a history rewrite), an operator may vouch for it: --restamp <version>=<recorded checksum>.',
          );
        }
        continue;
      }
      pending.push(`${file.version}_${file.name}`);
    }

    if (options.dryRun === true) {
      return { applied: [], alreadyApplied: alreadyApplied.size, pending, restamped };
    }

    for (const file of files) {
      if (alreadyApplied.has(file.version)) continue;
      const startedAt = performance.now();
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        const executionMs = Math.round(performance.now() - startedAt);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
          [file.version, file.name, file.checksum, executionMs],
        );
        await client.query('COMMIT');
        applied.push({
          version: file.version,
          name: file.name,
          checksum: file.checksum,
          executionMs,
        });
        logger.info(`applied ${file.version}_${file.name} in ${executionMs}ms`);
      } catch (cause) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(
          'migration.failed',
          `${file.version}_${file.name}.sql failed and was rolled back: ${(cause as Error).message}`,
        );
      }
    }

    if (applied.length === 0) logger.info('database is up to date; nothing to apply');
    return { applied, alreadyApplied: alreadyApplied.size, pending: [], restamped };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()])
      .catch(() => undefined);
    await client.end();
  }
}

/** Anything that can run a text query: a `pg.Pool`, a `pg.Client`, or a test double. */
export interface MigrationQueryable {
  query(text: string): Promise<unknown>;
}

/**
 * Migrations on disk that the database has not applied. `/ready` stays false
 * while this is non-empty, so a container never serves traffic against a schema
 * it does not match.
 *
 * CF-2: a database holding a version this binary lacks is not "nothing pending" —
 * this rejects with `migration.database_newer`, naming the version, so `/ready`
 * stays false for an older image pointed at a newer schema too.
 */
export async function pendingMigrations(
  queryable: MigrationQueryable,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const files = readMigrationFiles(migrationsDir);
  let rows: ReadonlyArray<{ version: string; name: string | null }>;
  try {
    const result = (await queryable.query('SELECT version, name FROM schema_migrations')) as {
      rows: ReadonlyArray<{ version: string; name: string | null }>;
    };
    rows = result.rows;
  } catch {
    // The bookkeeping table does not exist yet: everything is pending.
    rows = [];
  }
  // Outside the try: the refusal must never be read as "table missing".
  refuseDatabaseNewer(rows, files);
  const applied = new Set(rows.map((row) => row.version));
  return files
    .filter((file) => !applied.has(file.version))
    .map((file) => `${file.version}_${file.name}`);
}
