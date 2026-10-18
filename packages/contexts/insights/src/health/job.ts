// SPDX-License-Identifier: MIT
/**
 * `insights.health_snapshot` — the daily health snapshot job, and its 04:10 local schedule (WP 10.12).
 *
 * 04:10: after the 03:45 price refresh and the 04:00 net-worth snapshot (so holdings are priced and the
 * day's balances are sealed), before the 04:15 advisor pass. Idempotent per (holder, day): a second tick
 * the same day finds the row and writes nothing (`ensureHealthSnapshotForToday`). Backfills nothing — a
 * day the worker was down has no row, and the screen draws the gap rather than a guess. Registered by the
 * composition root (`apps/api/src/modules.ts`'s `insightsModule`), only when `module.insights` is on.
 */
import { systemClock, type Clock } from '@core/kernel';
import {
  defineJob,
  upsertSchedule,
  type JobContext,
  type JobHandlerRegistration,
} from '@core/platform';
import { platformOf, type InsightsDatabase } from '../db.ts';
import { ensureHealthSnapshotForToday, type HealthSnapshotDependencies } from './snapshots.ts';

export const HEALTH_SNAPSHOT_JOB_KIND = 'insights.health_snapshot';
export const HEALTH_SNAPSHOT_SCHEDULE_NAME = 'insights.health_snapshot_daily';
/** 04:10 local, every day. */
export const DEFAULT_HEALTH_SNAPSHOT_CRON = '10 4 * * *';

export interface HealthSnapshotJobDependencies extends HealthSnapshotDependencies {
  readonly timeZone: string;
}

export function createHealthSnapshotJob(
  deps: HealthSnapshotJobDependencies,
): JobHandlerRegistration {
  return defineJob(
    HEALTH_SNAPSHOT_JOB_KIND,
    async (_payload: unknown, context: JobContext) => {
      const result = await ensureHealthSnapshotForToday(
        { ...deps, clock: deps.clock ?? context.clock },
        { userId: context.userId, timeZone: deps.timeZone },
      );
      context.logger.info(
        {
          job: HEALTH_SNAPSHOT_JOB_KIND,
          asOfDate: result.snapshot.asOfDate,
          written: result.written,
          score: result.snapshot.score,
        },
        result.written ? 'health snapshot written' : 'health snapshot already written today',
      );
    },
    { concurrency: 1 },
  );
}

export async function registerHealthSnapshotSchedule(
  database: InsightsDatabase,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(database),
    {
      userId: input.userId,
      name: HEALTH_SNAPSHOT_SCHEDULE_NAME,
      cron: input.cron ?? DEFAULT_HEALTH_SNAPSHOT_CRON,
      timezone: input.timezone,
      jobKind: HEALTH_SNAPSHOT_JOB_KIND,
      enabled: true,
      // Under the five minutes to the 04:15 advisor pass.
      jitterSeconds: 120,
    },
    clock,
  );
}
