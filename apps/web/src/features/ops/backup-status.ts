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

// ---------------------------------------------------------------------------
// WP 10.16: when the GenAI controls were last proven
// ---------------------------------------------------------------------------

/** `GET /narrator/control-checks`'s `lastProven`: the newest finished run of the controls self-test. */
export interface ControlsProven {
  readonly at: string;
  readonly overall: 'pass' | 'fail' | 'partial';
}

/**
 * What the dashboard knows about the controls: `unknown` (the route failed, is not mocked, or answered something
 * that is not the shape) says nothing at all; `known` with `lastProven: null` is "never proven".
 */
export type ControlsStatus =
  { readonly known: false } | { readonly known: true; readonly lastProven: ControlsProven | null };

export const CONTROLS_UNKNOWN: ControlsStatus = { known: false };

const OVERALLS: ReadonlySet<unknown> = new Set(['pass', 'fail', 'partial']);

/**
 * A `GET /narrator/control-checks` body is only believed if it has the shape: an object with a `runs` array and a
 * `lastProven` that is either `null` or a dated `{ at, overall }`. Anything else (an SPA fallback page, a problem
 * body, a missing key) is `unknown`, so the line can never claim the controls were proven without a row saying so.
 */
export function controlsStatusOf(value: unknown): ControlsStatus {
  if (typeof value !== 'object' || value === null) return CONTROLS_UNKNOWN;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['runs']) || !('lastProven' in record)) return CONTROLS_UNKNOWN;
  const proven = record['lastProven'];
  if (proven === null) return { known: true, lastProven: null };
  if (typeof proven !== 'object') return CONTROLS_UNKNOWN;
  const at = (proven as Record<string, unknown>)['at'];
  const overall = (proven as Record<string, unknown>)['overall'];
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(at) || !OVERALLS.has(overall)) {
    return CONTROLS_UNKNOWN;
  }
  return { known: true, lastProven: { at, overall: overall as ControlsProven['overall'] } };
}

/**
 * The line with the controls appended: "· controls proven 2026-10-19" for a pass, "· controls partly proven
 * 2026-10-19" for a partial run, "· controls check failed 2026-10-19" (and "the last controls check failed" in
 * the warning) for a failed one, "· controls never proven" with no run. Unknown adds nothing.
 */
export function withControls(line: BackupLine, controls: ControlsStatus): BackupLine {
  if (!controls.known) return line;
  const proven = controls.lastProven;
  if (proven === null) return { ...line, text: `${line.text} · controls never proven` };
  const day = proven.at.slice(0, 10);
  if (proven.overall === 'pass') return { ...line, text: `${line.text} · controls proven ${day}` };
  if (proven.overall === 'partial') {
    return { ...line, text: `${line.text} · controls partly proven ${day}` };
  }
  const failed = 'the last controls check failed';
  return {
    tone: 'warning',
    text: `${line.text} · controls check failed ${day}`,
    warning: line.warning === null ? failed : `${line.warning}; ${failed}`,
  };
}
