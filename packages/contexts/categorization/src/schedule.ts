// SPDX-License-Identifier: MIT
/**
 * A cadence for `retrainClassifier` (WP 2.5, wp1.4 evidence §8's "deferred:
 * classifier retraining cadence — deciding when to call it belongs with the job
 * scheduler").
 *
 * Shaped the same way `@ctx/connections`'s nightly sync schedule is
 * (`orchestrator.ts`'s `jobHandler()` / `registerNightlySchedule`), because
 * `apps/api/src/modules.ts` — the composition root's module registry, owned by
 * the orchestrator and not by this work package — expects exactly that shape
 * from `ModuleRegistration.jobs` and `.schedules`:
 *
 * ```ts
 * {
 *   flagKey: 'module.categorization',
 *   events: CATEGORIZATION_EVENTS,
 *   consumers: [createCategorizationConsumer({ database, port })],
 *   jobs: [retrainJobHandler(database)],
 *   schedules: async (userId: string): Promise<void> => {
 *     await registerRetrainSchedule(database, { userId, timezone: options.timezone });
 *   },
 * },
 * ```
 *
 * A weekly cadence, not nightly: `retrainClassifier` is a full rebuild from
 * `classifier_examples` (`service.ts`'s own doc comment — "a few thousand
 * features takes milliseconds"), so there is no correctness reason to run it
 * more often than the corpus meaningfully changes, and 08 §3.7's jitter exists
 * for exactly this kind of background job so ten users' retrains do not all
 * land on the same second. `model_retrain` is already a recognised
 * `CategorizationTrigger` (`service.ts`) carried on `AssignmentsChanged` — this
 * file is what finally calls it on a schedule instead of only from a test.
 */
import { systemClock, type Clock } from '@core/kernel';
import { defineJob, upsertSchedule, type JobHandlerRegistration } from '@core/platform';
import { outboxOf, type CategorizationDatabase, type CategorizationExecutor } from './db.ts';
import { retrainClassifier } from './service.ts';

export const RETRAIN_JOB_KIND = 'categorization.retrain';
export const RETRAIN_SCHEDULE_NAME = 'categorization.retrain_weekly';
/** Sunday 04:00 local — after the nightly sync (03:15) has had time to land. */
export const RETRAIN_CRON = '0 4 * * 0';

/**
 * The handler `apps/api`'s worker registers, one `retrainClassifier` call per
 * fan-out job. Never throws for "nothing to train" — an untrained user is not a
 * failure, `COLD_MODEL` is the correct answer until they have confirmations —
 * so a retry only fires for a genuine database failure. Uses the job runner's
 * own `context.clock` (real wall-clock in production, injectable in a test),
 * never a clock closed over at registration time.
 */
export function retrainJobHandler(database: CategorizationDatabase): JobHandlerRegistration {
  return defineJob(
    RETRAIN_JOB_KIND,
    async (_payload, context) => {
      await retrainClassifier(database, {
        userId: context.userId,
        clock: context.clock,
        correlationId: context.correlationId,
      });
    },
    // One retrain in flight at a time is plenty; this is a background chore,
    // never a request a user is waiting on.
    { concurrency: 1 },
  );
}

/**
 * Declare the weekly schedule. Called at boot by whichever module owns the
 * work — `apps/api/src/modules.ts` — and *not* called when `module.categorization`
 * is off, same as every other module's schedule (docs/CONVENTIONS.md, "a
 * disabled module registers no consumers and no schedules").
 */
export function registerRetrainSchedule(
  executor: CategorizationExecutor,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    outboxOf(executor),
    {
      userId: input.userId,
      name: RETRAIN_SCHEDULE_NAME,
      cron: input.cron ?? RETRAIN_CRON,
      timezone: input.timezone,
      jobKind: RETRAIN_JOB_KIND,
      jobPayload: {},
      enabled: true,
      // Spread over half an hour for the same reason the nightly sync is
      // jittered: one user retraining at exactly 04:00:00 looks like a cron
      // job; ten deployments doing it at the same second looks like a scraper.
      jitterSeconds: 30 * 60,
    },
    clock,
  );
}
