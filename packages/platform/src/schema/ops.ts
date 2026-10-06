// SPDX-License-Identifier: MIT
/**
 * `ops_backup_runs` / `ops_restore_drills` -- migration
 * `0036_ops_status.sql` (CF-17, D24, 09 §5.7;
 * docs/plan/09-phase-9-dispatch.md §3 "WP 9.1").
 *
 * Both tables are install-wide, never user-scoped -- a backup or a restore
 * drill is a fact about the deployment, not about any one account holder,
 * the same footing `configSnapshots` and `jobRuns` already stand on in this
 * package. Neither carries a `userId` column, so `discoverUserScopedTables`
 * (`apps/api/src/reports/export/registry.ts`) never sees them; they are
 * still named there as a reasoned deferral ("install telemetry, not holder
 * data"), not left to be found by absence.
 *
 * CHECK constraints (`status IN ('ok','fail')`, `verdict IN ('pass','fail')`)
 * live only in the SQL migration, matching every other table-definition
 * file in this package (e.g. `health_scores`' two CHECKs are not mirrored
 * here either) -- this file is what TypeScript reads and writes columns
 * through, not a second copy of the schema's constraints.
 */
import { instantColumn } from '@core/db/columns';
import { bigint, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per `docker/backup/backup.sh` attempt. The insert from
 * `backup.sh` is best-effort against a schema that may predate this
 * migration (WP 9.4's pre-migration backup runs before this table may
 * exist) -- that contract lives in the shell script's own comment.
 */
export const opsBackupRuns = pgTable(
  'ops_backup_runs',
  {
    id: uuid('id').primaryKey(),
    /** `'ok'` -- the dump was verified restorable and promoted. `'fail'` -- any earlier exit. */
    status: text('status').notNull(),
    finishedAt: instantColumn('finished_at').notNull(),
    /** Bytes of the plaintext `pg_dump`. NULL when `pg_dump` itself failed. */
    plaintextBytes: bigint('plaintext_bytes', { mode: 'number' }),
    /** Objects `pg_restore --list` enumerated. NULL when the run never reached that check. */
    tocEntries: integer('toc_entries'),
    /** A short operator-facing sentence from `backup.sh` itself -- never a value from the holder's own data. */
    reason: text('reason').notNull(),
    createdAt: instantColumn('created_at').notNull().defaultNow(),
  },
  (table) => [index('ops_backup_runs_ok_finished_idx').on(table.finishedAt)],
);

export type OpsBackupRunRow = typeof opsBackupRuns.$inferSelect;

/** One row per `just restore-drill` run. */
export const opsRestoreDrills = pgTable(
  'ops_restore_drills',
  {
    id: uuid('id').primaryKey(),
    /** `'pass'` or `'fail'` -- the drill's own four assertions, collapsed to one verdict. */
    verdict: text('verdict').notNull(),
    ranAt: instantColumn('ran_at').notNull().defaultNow(),
    restoredTableCount: integer('restored_table_count').notNull(),
    liveTableCount: integer('live_table_count').notNull(),
    /** `schema_migrations.version` on the restored side, e.g. `'0034'`, or `'(none)'`. */
    maxMigration: text('max_migration').notNull(),
    /** Wall-clock seconds from "restore started" to "the restored database answered /ready". */
    rtoSeconds: integer('rto_seconds').notNull(),
    createdAt: instantColumn('created_at').notNull().defaultNow(),
  },
  (table) => [index('ops_restore_drills_ran_at_idx').on(table.ranAt)],
);

export type OpsRestoreDrillRow = typeof opsRestoreDrills.$inferSelect;
