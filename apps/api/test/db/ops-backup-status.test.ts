// SPDX-License-Identifier: MIT
/**
 * WP 9.1 exit tests for `GET /ops/backup-status` (CF-17, D24, 09 §5.7;
 * docs/plan/09-phase-9-dispatch.md §3 "WP 9.1" part 2).
 *
 * Every assertion goes through the shipped composition (C5-11): the real
 * `buildApp` registration of `opsRoutes` (via the api harness), the real
 * `requireSession` guard, the real `backupStatus` reader over the real
 * `ops_backup_runs` / `ops_restore_drills` tables from migration 0036. Rows are
 * inserted with the same columns `docker/backup/backup.sh` and the
 * `restore-drill` recipe write.
 */
import { fixedClock, newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const daysAgo = (days: number) => hoursAgo(days * 24);

interface Status {
  lastAttemptStatus: 'ok' | 'fail' | null;
  lastAttemptAt: string | null;
  lastSuccessfulBackupAt: string | null;
  lastSuccessfulBackupAgeSeconds: number | null;
  backupOverdue: boolean;
  lastDrillVerdict: 'pass' | 'fail' | null;
  lastDrillAt: string | null;
  lastDrillAgeDays: number | null;
  drillOverdue: boolean;
}

describe.skipIf(NO_DATABASE)('GET /ops/backup-status (WP 9.1 part 2)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp91-ops', clock: fixedClock(NOW) });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.database.db.execute(sql`TRUNCATE ops_backup_runs, ops_restore_drills`);
  });

  const backup = async (status: 'ok' | 'fail', finishedAt: string, reason = 'test') => {
    await h.database.db.execute(
      sql`INSERT INTO ops_backup_runs (id, status, finished_at, plaintext_bytes, toc_entries, reason)
          VALUES (${newId()}::uuid, ${status}, ${finishedAt}::timestamptz, ${status === 'ok' ? 66_346 : null},
                  ${status === 'ok' ? 160 : null}, ${reason})`,
    );
  };
  const drill = async (verdict: 'pass' | 'fail', ranAt: string) => {
    await h.database.db.execute(
      sql`INSERT INTO ops_restore_drills (id, verdict, ran_at, restored_table_count, live_table_count, max_migration, rto_seconds)
          VALUES (${newId()}::uuid, ${verdict}, ${ranAt}::timestamptz, 99, 99, '0036', 74)`,
    );
  };
  const status = async (): Promise<Status> => {
    const response = await h.request({
      method: 'GET',
      url: '/ops/backup-status',
      session: h.stale,
    });
    expectStatus(response, 200);
    return response.json() as Status;
  };

  it('the status reports the newest successful backup and never a newer failed one', async () => {
    // Nothing yet: no backup is overdue, not "fine".
    const empty = await status();
    expect(empty.lastSuccessfulBackupAt).toBeNull();
    expect(empty.lastAttemptStatus).toBeNull();
    expect(empty.backupOverdue).toBe(true);
    expect(empty.drillOverdue).toBe(true);
    expect(empty.lastDrillVerdict).toBeNull();

    await backup('ok', hoursAgo(30));
    await backup('ok', hoursAgo(10));
    await backup('fail', hoursAgo(1), 'pg_dump failed; nothing written, nothing pruned');

    const body = await status();
    // The newest *successful* backup (10 h old), not the failure from an hour ago.
    expect(body.lastSuccessfulBackupAt).toBe(hoursAgo(10));
    expect(body.lastSuccessfulBackupAgeSeconds).toBe(10 * 3600);
    expect(body.backupOverdue).toBe(false);
    // The newer failure is still reported, separately, as the last attempt.
    expect(body.lastAttemptStatus).toBe('fail');
    expect(body.lastAttemptAt).toBe(hoursAgo(1));

    // Failures only, after one old success: the success is what is reported, and it is overdue.
    await h.database.db.execute(sql`TRUNCATE ops_backup_runs`);
    await backup('ok', hoursAgo(40));
    await backup('fail', hoursAgo(16));
    await backup('fail', hoursAgo(2));
    const stale = await status();
    expect(stale.lastSuccessfulBackupAgeSeconds).toBe(40 * 3600);
    expect(stale.backupOverdue).toBe(true);
    expect(stale.lastAttemptStatus).toBe('fail');

    // Only failures ever: nothing is claimed as a successful backup.
    await h.database.db.execute(sql`TRUNCATE ops_backup_runs`);
    await backup('fail', hoursAgo(1));
    const never = await status();
    expect(never.lastSuccessfulBackupAt).toBeNull();
    expect(never.lastSuccessfulBackupAgeSeconds).toBeNull();
    expect(never.backupOverdue).toBe(true);
  }, 60_000);

  it('a drill older than 35 days reads overdue', async () => {
    await drill('pass', daysAgo(36));
    const old = await status();
    expect(old.lastDrillVerdict).toBe('pass');
    expect(old.lastDrillAgeDays).toBe(36);
    expect(old.drillOverdue).toBe(true);

    // Exactly 35 days is still inside the window; 35 days and a bit is the first overdue instant.
    await h.database.db.execute(sql`TRUNCATE ops_restore_drills`);
    await drill('pass', daysAgo(35));
    expect((await status()).drillOverdue).toBe(false);
    await h.database.db.execute(sql`TRUNCATE ops_restore_drills`);
    await drill('pass', daysAgo(36));
    expect((await status()).drillOverdue).toBe(true);

    // A newer drill replaces the old one, whatever the old verdict was.
    await drill('fail', daysAgo(3));
    const fresh = await status();
    expect(fresh.lastDrillVerdict).toBe('fail');
    expect(fresh.lastDrillAgeDays).toBe(3);
    expect(fresh.drillOverdue).toBe(false);
  }, 60_000);

  it('the route needs a session and returns nothing a user owns', async () => {
    await backup('ok', hoursAgo(4));
    await drill('pass', daysAgo(7));

    // No session: 401, and no status in the body.
    const anonymous = await h.request({ method: 'GET', url: '/ops/backup-status' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain('lastSuccessfulBackupAt');

    // A second account holder's session reads the identical, install-wide answer.
    const mine = await h.request({ method: 'GET', url: '/ops/backup-status', session: h.stale });
    expectStatus(mine, 200);
    const secondUser = await h.database.createUser('Second Holder');
    const theirs = await h.issueSession({ userId: secondUser });
    const other = await h.request({ method: 'GET', url: '/ops/backup-status', session: theirs });
    expectStatus(other, 200);
    expect(other.json()).toEqual(mine.json());

    // Nothing in the answer names a user, an id or a row: exactly the nine status fields.
    expect(Object.keys(mine.json() as object).sort()).toEqual([
      'backupOverdue',
      'drillOverdue',
      'lastAttemptAt',
      'lastAttemptStatus',
      'lastDrillAgeDays',
      'lastDrillAt',
      'lastDrillVerdict',
      'lastSuccessfulBackupAgeSeconds',
      'lastSuccessfulBackupAt',
    ]);
    for (const needle of [h.userId, secondUser, 'userId', 'user_id', 'reason']) {
      expect(mine.body).not.toContain(needle);
    }

    // The route is registered by the real app composition, with the session guard in front.
    const route = h.app.printRoutes();
    expect(route).toContain('ops/backup-status');
  }, 60_000);
});
