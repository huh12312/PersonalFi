// SPDX-License-Identifier: MIT
/**
 * The `insights.explain` job's kind, payload and enqueue (WP 11.3). The
 * handler lives in the composition root (`apps/api/src/insight-explain.ts`),
 * which owns the model; the api never has a path to one, so an explanation
 * the cache does not hold is always the worker's (the WP 10.16 job pattern:
 * the api answers 202 and the screen polls).
 *
 * Deduped per (holder, entity, evidence digest): a second tap, a poll's
 * retry and the Brief's prefetch of the same evidence are one job. Never
 * retried by the queue (`maxAttempts: 1`): a failed explanation is asked
 * again only when the holder asks again.
 */
import { enqueueJob, type Executor } from '@core/platform';
import type { RunTrigger } from '../../../schema/index.ts';
import { EXPLAIN_PREFETCH_MAX } from './manifest.ts';
import type { ExplainEntityKind } from './request.ts';

export const EXPLAIN_JOB_KIND = 'insights.explain';

export interface ExplainJobPayload {
  readonly entityKind: ExplainEntityKind;
  readonly entityId: string;
  readonly trigger: Extract<RunTrigger, 'manual' | 'event'>;
}

export function explainDedupeKey(
  userId: string,
  entityKind: ExplainEntityKind,
  entityId: string,
  digest: string,
): string {
  return `${EXPLAIN_JOB_KIND}:${userId}:${entityKind}:${entityId}:${digest}`;
}

export async function enqueueExplain(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly entityKind: ExplainEntityKind;
    readonly entityId: string;
    readonly digest: string;
    readonly trigger: ExplainJobPayload['trigger'];
    readonly correlationId: string;
  },
): Promise<{ readonly jobId: string; readonly deduped: boolean }> {
  const result = await enqueueJob(executor, {
    userId: input.userId,
    kind: EXPLAIN_JOB_KIND,
    payload: {
      entityKind: input.entityKind,
      entityId: input.entityId,
      trigger: input.trigger,
    } satisfies ExplainJobPayload,
    dedupeKey: explainDedupeKey(input.userId, input.entityKind, input.entityId, input.digest),
    // A tap is interactive; the Brief's prefetch is bulk.
    priority: input.trigger === 'manual' ? 10 : 500,
    maxAttempts: 1,
    correlationId: input.correlationId,
  });
  return { jobId: result.id, deduped: result.deduped };
}

/** The Brief's prefetch: its ranked items, in rank order, at most `EXPLAIN_PREFETCH_MAX`. Never the backlog. */
export function briefPrefetchIds(rankedInsightIds: readonly string[]): readonly string[] {
  return [...new Set(rankedInsightIds)].slice(0, EXPLAIN_PREFETCH_MAX);
}
