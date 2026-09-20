// SPDX-License-Identifier: MIT
/**
 * The schedules this module registers at boot must be ones Postgres accepts.
 *
 * `schedules.name` carries a CHECK (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`,
 * 0003_platform.sql). The Phase 2 cold boot (docs/evidence/phase-2/
 * wp2.w-wiring.md) found `registerNotificationSchedules` writing
 * `notifications.deliver:<uuid>` — a colon and four hyphens — so the worker
 * crash-looped inside `resolveModules()` on every real install while every
 * unit test stayed green against a fake scheduler. This suite registers the
 * schedules against a real database and reads the rows back, so the
 * constraint is exercised where it lives.
 */
import { platformExecutor } from '@core/platform';
import type { TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerNotificationSchedules, scheduleNameFor } from '../../src/jobs.ts';
import { NO_DATABASE, notificationsDatabase } from '../harness.ts';

const SCHEDULE_NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

describe('schedule names', () => {
  it('always satisfy the schedules.name CHECK constraint, for any user id', () => {
    fc.assert(
      fc.property(fc.uuid(), (userId) => {
        expect(scheduleNameFor('deliver', userId)).toMatch(SCHEDULE_NAME);
        expect(scheduleNameFor('digest', userId)).toMatch(SCHEDULE_NAME);
      }),
      { numRuns: 200 },
    );
  });

  it('are distinct per user and per kind', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const names = new Set([
      scheduleNameFor('deliver', a),
      scheduleNameFor('digest', a),
      scheduleNameFor('deliver', b),
      scheduleNameFor('digest', b),
    ]);
    expect(names.size).toBe(4);
  });
});

describe.skipIf(NO_DATABASE)('registerNotificationSchedules against Postgres', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await notificationsDatabase('schedules');
  });

  afterAll(async () => {
    await database.drop();
  });

  it('registers both schedules for the user, and registering again is idempotent', async () => {
    const { db, userId } = database;
    const executor = platformExecutor(db);
    await registerNotificationSchedules(executor, { userId, timezone: 'America/New_York' });
    await registerNotificationSchedules(executor, { userId, timezone: 'America/New_York' });

    const rows = await db.execute<{ name: string; job_kind: string; enabled: boolean }>(sql`
      SELECT name, job_kind, enabled FROM schedules
      WHERE user_id = ${userId}::uuid AND job_kind LIKE 'notifications.%'
      ORDER BY name
    `);
    expect(rows.rows.map((row) => row.job_kind)).toEqual([
      'notifications.deliver',
      'notifications.digest',
    ]);
    expect(rows.rows.every((row) => SCHEDULE_NAME.test(row.name))).toBe(true);
    expect(rows.rows.every((row) => row.enabled)).toBe(true);
  });
});
