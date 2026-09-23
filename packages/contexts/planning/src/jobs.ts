// SPDX-License-Identifier: MIT
/**
 * The 04:00 job and the schedule that fires it.
 *
 * Shaped exactly like `@ctx/categorization`'s `schedule.ts` and
 * `@ctx/connections`' `jobHandler()`, because `apps/api/src/modules.ts` — the
 * composition root's module registry, the orchestrator's file and not this work
 * package's — expects that shape from `ModuleRegistration.jobs` and
 * `.schedules`. The registration lines are written out in
 * `docs/evidence/phase-3/wp3.8-net-worth.md` §8.
 *
 * ## 04:00 local, and why that number
 *
 * The nightly sync runs at 03:15 (`@ctx/connections`) and the price refresh at
 * 03:45 (`integrations.price_refresh`, wp3.w-wiring.md §2). 04:00 is after both,
 * so the day the snapshotter seals is a day whose balances and prices have
 * already landed. It is also comfortably past 08 §3.5's 02:00 seal boundary, so
 * every day that closed overnight is sealable by the time this runs — the job
 * never has to leave one open for another twenty-four hours because it fired
 * ninety seconds early.
 *
 * ## The name
 *
 * `planning.net_worth_snapshot`, matching `SCHEDULE_NAME_PATTERN`
 * (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`) and `schedules.name`'s identical CHECK in
 * 0003_platform.sql. The Phase 2 cold boot found a context registering
 * `notifications.deliver:<uuid>`: every unit test passed because the fake
 * scheduler never applied the constraint, and the real worker crash-looped from
 * its first start. `upsertSchedule` calls `assertScheduleName` for us, and
 * `test/schedule-name.test.ts` asserts the constant against the pattern read out
 * of the platform rather than against a copy of it.
 */
import { systemClock, type Clock } from '@core/kernel';
import { defineJob, upsertSchedule, type JobHandlerRegistration } from '@core/platform';
import type { SnapshotPorts } from './ports.ts';
import { runSnapshot, type SnapshotContext } from './snapshot.ts';
import { platformOf, type PlanningDatabase, type PlanningExecutor } from './store.ts';

export const SNAPSHOT_JOB_KIND = 'planning.net_worth_snapshot';
export const SNAPSHOT_SCHEDULE_NAME = 'planning.net_worth_snapshot';
/** 04:00 local — after the 03:15 sync and the 03:45 price refresh. */
export const SNAPSHOT_CRON = '0 4 * * *';

export interface SnapshotJobDependencies {
  readonly database: PlanningDatabase;
  /**
   * Built per run rather than closed over once, so the readers see the job's own
   * transaction. The composition root supplies the adapters
   * (`apps/api/src/domain.ts`); this context never learns what is behind them.
   */
  readonly portsFor: (executor: PlanningExecutor) => SnapshotPorts;
  readonly timeZone: string;
  readonly baseCurrency: string;
}

/**
 * One `runSnapshot` per fan-out job.
 *
 * Runs inside a transaction so the seals, the open day's row and
 * `planning.NetWorthSnapshotTaken` are one atomic fact: an event announcing a
 * snapshot whose row rolled back would tell a notification rule something that
 * is not true, which is the failure mode `appendEvent`-in-the-same-transaction
 * exists to prevent.
 *
 * Uses the runner's own `context.clock` — real wall clock in production,
 * injectable in a test — and never a clock closed over at registration time.
 * That matters more here than in most jobs: every seal decision in
 * `src/seal.ts` is a comparison against it.
 */
export function netWorthSnapshotJobHandler(
  dependencies: SnapshotJobDependencies,
): JobHandlerRegistration {
  return defineJob(
    SNAPSHOT_JOB_KIND,
    async (_payload, context) => {
      await dependencies.database.transaction(async (tx) => {
        const executor = tx as unknown as PlanningExecutor;
        const snapshotContext: SnapshotContext = {
          userId: context.userId,
          clock: context.clock,
          timeZone: dependencies.timeZone,
          baseCurrency: dependencies.baseCurrency,
          correlationId: context.correlationId,
        };
        await runSnapshot(executor, dependencies.portsFor(executor), snapshotContext);
      });
    },
    // One snapshot in flight at a time. Two concurrent runs would both try to
    // seal the same day; the `sealed_at IS NULL` guard makes the loser's UPDATE
    // a typed refusal rather than a corruption, but a job that predictably
    // throws is not a design, it is a race with a safety net.
    { concurrency: 1 },
  );
}

/**
 * Declare the daily schedule.
 *
 * Called at boot by whichever module owns the work — `apps/api/src/modules.ts` —
 * and **not** called when `module.planning` is off, same as every other module's
 * schedule (docs/CONVENTIONS.md, "a disabled module registers no consumers and
 * no schedules").
 *
 * The timezone is the row's, and `cron-parser` resolves 04:00 against it, so the
 * job stays at 04:00 across a DST transition rather than drifting an hour twice
 * a year — which for a *daily* seal would mean two days a year sealed against
 * the wrong calendar date.
 */
export function registerNetWorthSnapshotSchedule(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(executor),
    {
      userId: input.userId,
      name: SNAPSHOT_SCHEDULE_NAME,
      cron: input.cron ?? SNAPSHOT_CRON,
      timezone: input.timezone,
      jobKind: SNAPSHOT_JOB_KIND,
      jobPayload: {},
      enabled: true,
      // Ten minutes. Smaller than the retrain's half hour because this job has a
      // deadline the user can see — the chart should be right when they open the
      // app in the morning — and larger than zero for 08 §3.7's reason: one
      // install firing at exactly 04:00:00 looks like a cron job, and every
      // install doing it looks like a botnet to whatever they are all calling.
      jitterSeconds: 10 * 60,
    },
    clock,
  );
}
