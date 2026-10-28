// SPDX-License-Identifier: MIT
/**
 * The `insights.brief_narrate` job's kind, payload and enqueue (WP 11.4). The
 * handler lives in the composition root (`apps/api/src/brief-narration.ts`),
 * which owns the model and the Brief's blocks; the api never has a path to a
 * model.
 *
 * Enqueued by the weekly Brief job once per **published** Brief, after the
 * per-item narrations it enqueued (`insights.run_local`, one job per item).
 * The composition waits for those first — while any of this Brief's item
 * narrations is still queued or running it re-enqueues itself
 * `BRIEF_NARRATE_WAIT_MS` later, at most `BRIEF_NARRATE_MAX_WAITS` times —
 * so the composition reads the items' validated wording, not a race. Waiting
 * asks no model. Never retried by the queue (`maxAttempts: 1`), and bounded to
 * one model call per Brief by `brief_narrations`' unique claim, whatever the
 * queue does.
 */
import { enqueueJob, type Executor } from '@core/platform';

export const BRIEF_NARRATE_JOB_KIND = 'insights.brief_narrate';
/** How long to wait before looking again for the item narrations to finish. */
export const BRIEF_NARRATE_WAIT_MS = 60_000;
/** How many times to wait (an hour) before composing from whatever wording stands. */
export const BRIEF_NARRATE_MAX_WAITS = 60;

export interface BriefNarrateJobPayload {
  readonly briefId: string;
  readonly isoWeek: string;
  /** How many times this composition has already waited for the item narrations. */
  readonly waits: number;
}

export function briefNarrateDedupeKey(userId: string, briefId: string, waits: number): string {
  return `${BRIEF_NARRATE_JOB_KIND}:${userId}:${briefId}:${String(waits)}`;
}

export async function enqueueBriefNarration(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly briefId: string;
    readonly isoWeek: string;
    readonly waits: number;
    readonly runAfter?: Date;
    readonly correlationId: string;
  },
): Promise<{ readonly jobId: string; readonly deduped: boolean }> {
  const result = await enqueueJob(executor, {
    userId: input.userId,
    kind: BRIEF_NARRATE_JOB_KIND,
    payload: {
      briefId: input.briefId,
      isoWeek: input.isoWeek,
      waits: input.waits,
    } satisfies BriefNarrateJobPayload,
    dedupeKey: briefNarrateDedupeKey(input.userId, input.briefId, input.waits),
    // Bulk: after the item narrations the same Brief enqueued (the default band).
    priority: 500,
    maxAttempts: 1,
    ...(input.runAfter === undefined ? {} : { runAfter: input.runAfter }),
    correlationId: input.correlationId,
  });
  return { jobId: result.id, deduped: result.deduped };
}
