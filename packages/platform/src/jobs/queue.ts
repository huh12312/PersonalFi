// SPDX-License-Identifier: MIT
import { newId, systemClock, type Clock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { PlatformError } from '../errors.ts';
import type { Executor } from '../executor.ts';
import { METRIC, type Metrics } from '../metrics.ts';

/**
 * The enqueue side of the job queue.
 *
 * `enqueueJob` takes an `Executor` for the same reason `appendEvent` does: the
 * decisive property of a Postgres-backed queue is that writing the data and
 * queueing the work that follows from it happen in **one transaction**. A sync
 * that commits a page and then fails to enqueue the next one is a silently
 * truncated backfill; here that cannot happen, because there is nothing to fail
 * between the two.
 */

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface EnqueueJobInput {
  readonly userId: string;
  /** Lower-snake, dotted: `sync.connection`, `notifications.digest`. */
  readonly kind: string;
  readonly payload?: unknown;
  /**
   * "Do not queue this twice." Unique among queued-or-running jobs; a second
   * enqueue returns the existing id and enqueues nothing. This is the guard
   * against a webhook, the nightly schedule, and a user clicking refresh all
   * starting a cursor loop on the same connection.
   */
  readonly dedupeKey?: string;
  /**
   * "Do not run two of these at once." Others still queue and run afterwards.
   * Weaker than dedupe and the right tool when every occurrence matters but the
   * order and the concurrency do not.
   */
  readonly singletonKey?: string;
  readonly runAfter?: Date;
  /** Lower runs first. 100 is the default band; 10 is interactive, 500 is bulk. */
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly correlationId: string;
  /** The event that caused this job, if any. Completes the causal chain. */
  readonly causationEventId?: string | null;
}

export interface EnqueueResult {
  readonly id: string;
  /** True when an equivalent job was already queued or running and this is it. */
  readonly deduped: boolean;
}

export interface EnqueueOptions {
  readonly clock?: Clock;
  readonly metrics?: Metrics;
}

export async function enqueueJob(
  executor: Executor,
  input: EnqueueJobInput,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const clock = options.clock ?? systemClock;
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(input.kind)) {
    throw new PlatformError(
      'platform.job_kind_invalid',
      `${input.kind}: job kinds are lower_snake, dotted, e.g. sync.connection`,
    );
  }

  const id = newId();
  const runAfter = input.runAfter ?? clock.now();

  // ON CONFLICT against the partial unique index does the dedupe in one
  // statement. A read-then-write would race with the very thing it defends
  // against, which is two enqueues arriving 50 ms apart.
  const inserted = await executor.execute<{ id: string }>(sql`
    INSERT INTO jobs (
      id, user_id, kind, payload, dedupe_key, singleton_key,
      priority, run_after, max_attempts, correlation_id, causation_event_id
    ) VALUES (
      ${id}::uuid,
      ${input.userId}::uuid,
      ${input.kind},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.dedupeKey ?? null},
      ${input.singletonKey ?? null},
      ${input.priority ?? 100},
      ${runAfter.toISOString()}::timestamptz,
      ${input.maxAttempts ?? 5},
      ${input.correlationId}::uuid,
      ${input.causationEventId ?? null}
    )
    ON CONFLICT (dedupe_key) WHERE status IN ('pending', 'running') DO NOTHING
    RETURNING id
  `);

  if (inserted.rows.length > 0) {
    options.metrics?.increment(METRIC.jobsEnqueued, { kind: input.kind });
    return { id, deduped: false };
  }

  const existing = await executor.execute<{ id: string }>(sql`
    SELECT id FROM jobs
    WHERE dedupe_key = ${input.dedupeKey ?? null}
      AND status IN ('pending', 'running')
    LIMIT 1
  `);
  const existingId = existing.rows[0]?.id;
  if (existingId === undefined) {
    throw new PlatformError(
      'platform.job_enqueue_failed',
      `${input.kind}: insert was skipped but no active job holds dedupe key ${String(input.dedupeKey)}`,
    );
  }
  options.metrics?.increment(METRIC.jobsDeduped, { kind: input.kind });
  return { id: existingId, deduped: true };
}

/** Cancel a job that has not started. A running job is left to finish. */
export async function cancelJob(executor: Executor, id: string): Promise<boolean> {
  const result = await executor.execute<{ id: string }>(sql`
    UPDATE jobs
    SET status = 'cancelled', completed_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND status = 'pending'
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Put a dead job back on the queue. The maintenance page's "retry" button. */
export async function retryDeadJob(executor: Executor, id: string): Promise<boolean> {
  const result = await executor.execute<{ id: string }>(sql`
    UPDATE jobs
    SET status = 'pending',
        attempts = 0,
        run_after = now(),
        locked_by = NULL,
        locked_at = NULL,
        heartbeat_at = NULL,
        completed_at = NULL,
        updated_at = now()
    WHERE id = ${id}::uuid AND status IN ('dead', 'failed', 'cancelled')
    RETURNING id
  `);
  return result.rows.length > 0;
}

export interface QueueHealth {
  readonly pending: number;
  readonly running: number;
  readonly dead: number;
  readonly failed: number;
  /** How long the oldest runnable job has been waiting. The number that matters. */
  readonly oldestPendingAgeSeconds: number | null;
  /** Jobs whose worker died: `running` with a heartbeat older than the threshold. */
  readonly stalled: number;
}

/**
 * Queue depth and staleness for `/ready` and the maintenance page.
 *
 * `oldestPendingAgeSeconds` is the health signal, not `pending`: a queue of 400
 * jobs that drains in a minute is fine, and a queue of one job that has been
 * waiting six hours means no worker is running.
 */
export async function queueHealth(
  executor: Executor,
  stalledAfterSeconds = 90,
): Promise<QueueHealth> {
  const result = await executor.execute<{
    pending: bigint;
    running: bigint;
    dead: bigint;
    failed: bigint;
    stalled: bigint;
    oldest_pending_age: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')                            AS pending,
      count(*) FILTER (WHERE status = 'running')                            AS running,
      count(*) FILTER (WHERE status = 'dead')                               AS dead,
      count(*) FILTER (WHERE status = 'failed')                             AS failed,
      count(*) FILTER (
        WHERE status = 'running'
          AND heartbeat_at < now() - make_interval(secs => ${stalledAfterSeconds})
      )                                                                     AS stalled,
      extract(epoch FROM now() - min(run_after) FILTER (
        WHERE status = 'pending' AND run_after <= now()
      ))::text                                                              AS oldest_pending_age
    FROM jobs
  `);

  const row = result.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    dead: Number(row?.dead ?? 0),
    failed: Number(row?.failed ?? 0),
    stalled: Number(row?.stalled ?? 0),
    oldestPendingAgeSeconds:
      row?.oldest_pending_age == null ? null : Math.max(0, Number(row.oldest_pending_age)),
  };
}
