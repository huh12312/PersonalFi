// SPDX-License-Identifier: MIT
/**
 * The `insights.ask` job's kind, payload and enqueue (WP 11.5c). The handler
 * lives in the composition root (`apps/api/src/ask.ts`), which owns the models
 * and the catalogue's ports; **the api never has a path to a model**: `POST
 * /ask` writes the session and enqueues this, and the worker runs compile →
 * the catalogue calls → narrate.
 *
 * Never retried by the queue (`maxAttempts: 1`), and bounded to one model call
 * per step by `ask_sessions`' step claims, whatever the queue does. Deduped
 * per session.
 */
import { enqueueJob, type Executor } from '@core/platform';

export const ASK_JOB_KIND = 'insights.ask';

export interface AskJobPayload {
  readonly sessionId: string;
}

export function askDedupeKey(userId: string, sessionId: string): string {
  return `${ASK_JOB_KIND}:${userId}:${sessionId}`;
}

export async function enqueueAsk(
  executor: Executor,
  input: { readonly userId: string; readonly sessionId: string; readonly correlationId: string },
): Promise<{ readonly jobId: string; readonly deduped: boolean }> {
  const result = await enqueueJob(executor, {
    userId: input.userId,
    kind: ASK_JOB_KIND,
    payload: { sessionId: input.sessionId } satisfies AskJobPayload,
    dedupeKey: askDedupeKey(input.userId, input.sessionId),
    // Interactive: the holder is waiting on the screen.
    priority: 10,
    maxAttempts: 1,
    correlationId: input.correlationId,
  });
  return { jobId: result.id, deduped: result.deduped };
}
