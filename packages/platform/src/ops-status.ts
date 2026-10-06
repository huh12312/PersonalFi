// SPDX-License-Identifier: MIT
/**
 * The query half of `GET /ops/backup-status` (CF-17, D24, 09 §5.7;
 * docs/plan/09-phase-9-dispatch.md §3 "WP 9.1"). Lives in `@core/platform`,
 * not in the route file, because `apps/api/src/routes/ops.ts` imports only
 * `@core/platform` (09 §4 wiring batch 2) -- an install-wide status read has
 * no business reaching into a context, and this way it does not need to.
 *
 * `ops_backup_runs`/`ops_restore_drills` (`./schema/ops.ts`,
 * `packages/db/migrations/0036_ops_status.sql`) are install-wide, so this
 * function takes no `userId` and the route it serves needs none either --
 * only a session, to keep an unauthenticated prober from learning anything
 * about the install.
 */
import { sql } from 'drizzle-orm';
import type { Clock } from '@core/kernel';
import type { Executor } from './executor.ts';

export interface BackupStatus {
  /** The newest attempt's `status`, whether or not it succeeded. `null` before any attempt. */
  readonly lastAttemptStatus: 'ok' | 'fail' | null;
  readonly lastAttemptAt: string | null;
  /**
   * The newest row with `status = 'ok'` -- deliberately not the same row as
   * `lastAttemptAt` whenever a later attempt failed, so a string of failures
   * after a good night never reports as "backed up moments ago" (the route's
   * own exit test: "never a newer failed one").
   */
  readonly lastSuccessfulBackupAt: string | null;
  readonly lastSuccessfulBackupAgeSeconds: number | null;
  readonly backupOverdue: boolean;
  readonly lastDrillVerdict: 'pass' | 'fail' | null;
  readonly lastDrillAt: string | null;
  readonly lastDrillAgeDays: number | null;
  readonly drillOverdue: boolean;
}

/**
 * RPO is the nightly cadence (`BACKUP_HOUR_UTC`) plus slack for a delayed
 * run -- 09 §9's own cross-reference ("the 26 h staleness check") is this
 * constant. A missed single night (still inside 24 h) must not warn; two
 * missed nights in a row should.
 */
export const DEFAULT_BACKUP_MAX_AGE_SECONDS = 26 * 60 * 60;

/** D24 / RUNBOOK "Restore drill": run monthly at minimum. 35 days is the month plus a few days' slack. */
export const DRILL_MAX_AGE_DAYS = 35;

export async function backupStatus(
  executor: Executor,
  clock: Clock,
  options: { readonly maxBackupAgeSeconds?: number } = {},
): Promise<BackupStatus> {
  const maxBackupAgeSeconds = options.maxBackupAgeSeconds ?? DEFAULT_BACKUP_MAX_AGE_SECONDS;
  const now = clock.now();

  const [lastAttemptResult, lastSuccessResult, lastDrillResult] = await Promise.all([
    executor.execute<{ status: string; finished_at: Date }>(sql`
      SELECT status, finished_at FROM ops_backup_runs ORDER BY finished_at DESC LIMIT 1
    `),
    executor.execute<{ finished_at: Date }>(sql`
      SELECT finished_at FROM ops_backup_runs WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1
    `),
    executor.execute<{ verdict: string; ran_at: Date }>(sql`
      SELECT verdict, ran_at FROM ops_restore_drills ORDER BY ran_at DESC LIMIT 1
    `),
  ]);

  const lastAttempt = lastAttemptResult.rows[0];
  const lastSuccess = lastSuccessResult.rows[0];
  const lastDrill = lastDrillResult.rows[0];

  const lastSuccessfulBackupAgeSeconds =
    lastSuccess === undefined
      ? null
      : Math.max(
          0,
          Math.floor((now.getTime() - new Date(lastSuccess.finished_at).getTime()) / 1000),
        );

  const lastDrillAgeDays =
    lastDrill === undefined
      ? null
      : Math.max(
          0,
          Math.floor(
            (now.getTime() - new Date(lastDrill.ran_at).getTime()) / (24 * 60 * 60 * 1000),
          ),
        );

  return {
    lastAttemptStatus: (lastAttempt?.status as 'ok' | 'fail' | undefined) ?? null,
    lastAttemptAt:
      lastAttempt === undefined ? null : new Date(lastAttempt.finished_at).toISOString(),
    lastSuccessfulBackupAt:
      lastSuccess === undefined ? null : new Date(lastSuccess.finished_at).toISOString(),
    lastSuccessfulBackupAgeSeconds,
    // No backup at all is overdue too -- a fresh, never-backed-up install is
    // not "fine", it just has nothing to warn about yet in age terms, so it
    // reads overdue rather than false.
    backupOverdue:
      lastSuccessfulBackupAgeSeconds === null ||
      lastSuccessfulBackupAgeSeconds > maxBackupAgeSeconds,
    lastDrillVerdict: (lastDrill?.verdict as 'pass' | 'fail' | undefined) ?? null,
    lastDrillAt: lastDrill === undefined ? null : new Date(lastDrill.ran_at).toISOString(),
    lastDrillAgeDays,
    drillOverdue: lastDrillAgeDays === null || lastDrillAgeDays > DRILL_MAX_AGE_DAYS,
  };
}
