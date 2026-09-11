// SPDX-License-Identifier: MIT
/**
 * `@core/db` — Drizzle, the pool, the column vocabulary, and the migration runner.
 *
 * A context imports this for its *own* schema and queries. It must not reach for
 * another context's tables through it; that is what the schema-ownership check
 * exists to catch.
 */
export * from './columns.ts';
export {
  createPool,
  createDatabase,
  checkConnection,
  type Database,
  type PoolOptions,
} from './client.ts';
export { installTypeParsers } from './types.ts';
export {
  runMigrations,
  pendingMigrations,
  readMigrationFiles,
  MigrationError,
  MIGRATION_ADVISORY_LOCK_KEY,
  DEFAULT_MIGRATIONS_DIR,
  type MigrationFile,
  type AppliedMigration,
  type RunMigrationsOptions,
  type RunMigrationsResult,
  type MigrationQueryable,
} from './migrate.ts';
export * from './schema/index.ts';
