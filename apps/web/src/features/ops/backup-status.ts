// SPDX-License-Identifier: MIT
/**
 * The dashboard's backup line (CF-17, D24, 09 §5.7; WP 9.1 part 2):
 * "Last backup 4 h ago · restore drill passed 2026-10-13".
 *
 * The response is typed here, locally, because `GET /ops/backup-status` is not
 * in the generated client until the orchestrator's `just openapi` + `pnpm run
 * gen` run after Wave A (09 §4 batch 8); the shape mirrors
 * `apps/api/src/routes/ops.ts`'s `OpsBackupStatus`. After the regeneration
 * `getOpsBackupStatusOptions()` replaces `useBackupStatusQuery`'s `queryFn`.
 *
 * Pure: no React, no clock. The component decides nothing but layout.
 */

export interface OpsBackupStatus {
  readonly lastAttemptStatus: 'ok' | 'fail' | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessfulBackupAt: string | null;
  readonly lastSuccessfulBackupAgeSeconds: number | null;
  readonly backupOverdue: boolean;
  readonly lastDrillVerdict: 'pass' | 'fail' | null;
  readonly lastDrillAt: string | null;
  readonly lastDrillAgeDays: number | null;
  readonly drillOverdue: boolean;
}

/**
 * A response is only believed if it has the shape. A dev server's SPA fallback
 * answers an unmocked `/api/...` path with `200 text/html`, which a client
 * would hand over as a string: that must read as "unknown", not crash.
 */
export function isOpsBackupStatus(value: unknown): value is OpsBackupStatus {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['backupOverdue'] === 'boolean' &&
    typeof record['drillOverdue'] === 'boolean' &&
    (record['lastSuccessfulBackupAgeSeconds'] === null ||
      typeof record['lastSuccessfulBackupAgeSeconds'] === 'number') &&
    (record['lastDrillAt'] === null || typeof record['lastDrillAt'] === 'string')
  );
}

export type BackupLineTone = 'ok' | 'warning' | 'unknown';

export interface BackupLine {
  readonly tone: BackupLineTone;
  /** The whole line, e.g. "Last backup 4 h ago · restore drill passed 2026-10-13". */
  readonly text: string;
  /** Present only for a warning: what is wrong, in words (never colour alone). */
  readonly warning: string | null;
}

export const STATUS_UNKNOWN: BackupLine = {
  tone: 'unknown',
  text: 'Backup status unknown',
  warning: null,
};

export function formatBackupAge(seconds: number): string {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  if (seconds < 48 * 3600) return `${String(Math.floor(seconds / 3600))} h ago`;
  return `${String(Math.floor(seconds / 86_400))} d ago`;
}

export function describeBackupStatus(status: OpsBackupStatus): BackupLine {
  const backup =
    status.lastSuccessfulBackupAgeSeconds === null
      ? 'No successful backup yet'
      : `Last backup ${formatBackupAge(status.lastSuccessfulBackupAgeSeconds)}`;
  const drill =
    status.lastDrillVerdict === null || status.lastDrillAt === null
      ? 'no restore drill yet'
      : `restore drill ${status.lastDrillVerdict === 'pass' ? 'passed' : 'failed'} ${status.lastDrillAt.slice(0, 10)}`;

  const problems: string[] = [];
  if (status.backupOverdue) {
    problems.push(
      status.lastSuccessfulBackupAgeSeconds === null
        ? 'no backup has succeeded'
        : 'backup is overdue',
    );
  }
  if (status.lastDrillVerdict === 'fail') problems.push('the last restore drill failed');
  else if (status.drillOverdue) {
    problems.push(
      status.lastDrillAt === null ? 'no restore drill has run' : 'restore drill is overdue',
    );
  }

  return {
    tone: problems.length > 0 ? 'warning' : 'ok',
    text: `${backup} · ${drill}`,
    warning: problems.length > 0 ? problems.join('; ') : null,
  };
}
