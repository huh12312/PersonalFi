// SPDX-License-Identifier: MIT
/**
 * The advisor's two worker jobs (WP 11.5d). The handlers live in the
 * composition root (`apps/api/src/advisor-mode.ts`), which owns the models and
 * the catalogue's ports; **the api never has a path to a model**: its routes
 * write the session and enqueue `insights.advisor_step`, and the worker runs
 * the steps.
 *
 *   * `insights.advisor_step` — one pass over one session (`runAdvisorPass`).
 *     Never retried by the queue (`maxAttempts: 1`), and bounded to one model
 *     call per step by `advisor_session_steps`' UNIQUE, whatever the queue
 *     does. Deduped per session and per stage.
 *   * `insights.advisor_follow_up` — the deterministic watchers of every
 *     tracked session (no model), daily and before the weekly Brief.
 */
import { systemClock, type Clock } from '@core/kernel';
import { enqueueJob, upsertSchedule, type Executor } from '@core/platform';
import { platformOf, type InsightsDatabase } from '../../db.ts';

export const ADVISOR_STEP_JOB_KIND = 'insights.advisor_step';
export const ADVISOR_FOLLOW_UP_JOB_KIND = 'insights.advisor_follow_up';

export interface AdvisorStepJobPayload {
  readonly sessionId: string;
}

export async function enqueueAdvisorStep(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    /** What the holder just did (`start`, `answers`, `pick`): one job per stage. */
    readonly stage: string;
    readonly correlationId: string;
  },
): Promise<{ readonly jobId: string; readonly deduped: boolean }> {
  const result = await enqueueJob(executor, {
    userId: input.userId,
    kind: ADVISOR_STEP_JOB_KIND,
    payload: { sessionId: input.sessionId } satisfies AdvisorStepJobPayload,
    dedupeKey: `${ADVISOR_STEP_JOB_KIND}:${input.userId}:${input.sessionId}:${input.stage}`,
    // Interactive: the holder is waiting on the screen.
    priority: 10,
    maxAttempts: 1,
    correlationId: input.correlationId,
  });
  return { jobId: result.id, deduped: result.deduped };
}

export async function enqueueAdvisorFollowUp(
  executor: Executor,
  input: { readonly userId: string; readonly correlationId: string; readonly day: string },
): Promise<{ readonly jobId: string; readonly deduped: boolean }> {
  const result = await enqueueJob(executor, {
    userId: input.userId,
    kind: ADVISOR_FOLLOW_UP_JOB_KIND,
    payload: {},
    dedupeKey: `${ADVISOR_FOLLOW_UP_JOB_KIND}:${input.userId}:${input.day}`,
    priority: 50,
    maxAttempts: 1,
    correlationId: input.correlationId,
  });
  return { jobId: result.id, deduped: result.deduped };
}

export const ADVISOR_FOLLOW_UP_SCHEDULE_NAME = 'insights.advisor_follow_up_daily';
/** 05:40 local: after the 04:15 advisor pass, before Sunday's 06:00 Brief. */
export const DEFAULT_ADVISOR_FOLLOW_UP_CRON = '40 5 * * *';

export async function registerAdvisorFollowUpSchedule(
  database: InsightsDatabase,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(database),
    {
      userId: input.userId,
      name: ADVISOR_FOLLOW_UP_SCHEDULE_NAME,
      cron: input.cron ?? DEFAULT_ADVISOR_FOLLOW_UP_CRON,
      timezone: input.timezone,
      jobKind: ADVISOR_FOLLOW_UP_JOB_KIND,
      enabled: true,
      jitterSeconds: 120,
    },
    clock,
  );
}
