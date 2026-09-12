// SPDX-License-Identifier: MIT
import { sql } from 'drizzle-orm';
import type { Executor } from '../executor.ts';
import { PlatformError } from '../errors.ts';
import { toInstant, type TimestampValue } from '../instants.ts';
import { METRIC, type Metrics } from '../metrics.ts';
import { newEventSchema, type EventEnvelope, type NewEvent } from './envelope.ts';

/**
 * The outbox write path.
 *
 * ## The rule
 *
 * **Contexts write events. Contexts never call each other.**
 *
 * When `@ctx/ledger` finishes upserting a page of transactions it appends
 * `ledger.TransactionsUpserted` and stops. It does not call budgeting, does not
 * know budgeting exists, and does not change when a fifth consumer appears in
 * Phase 5. The alternative — Ledger calling the four things that care — makes
 * Ledger depend on everything, creates import cycles the boundary lint then has
 * to refuse, and loses the work entirely if the process dies between the write
 * and the call.
 *
 * The consequence to internalise: an event is **not** a request, and a publisher
 * gets no acknowledgement and no return value from its consumers. Where a context
 * needs "after X, then Y", Y reacts to an event X's consumer emits *after* its
 * own write (08 §3.3), never to a callback.
 *
 * ## Why the signature is what it is
 *
 * `appendEvent` takes an `Executor` — a Drizzle transaction handle — as its first
 * argument and there is no overload that does not. That is the whole atomicity
 * guarantee expressed as a type: you cannot publish without being inside someone
 * else's transaction, so an event cannot exist for data that was rolled back, and
 * data cannot be committed with its event lost to a crash.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await tx.insert(transactions).values(rows);
 *   await appendEvent(tx, TransactionsUpserted.create(
 *     { accountId, addedIds, count: rows.length },
 *     { userId, correlationId },
 *   ));
 * });
 * ```
 *
 * Append last where you can. The SQL function takes a transaction-scoped advisory
 * lock to make `seq` order equal commit order, and that lock is held until your
 * transaction ends — so a transaction that appends and then does thirty seconds
 * of work blocks every other publisher for thirty seconds.
 */

interface AppendRow extends Record<string, unknown> {
  out_seq: bigint;
  out_recorded_at: TimestampValue;
}

export interface AppendOptions {
  readonly metrics?: Metrics;
}

/** Append one event inside the caller's transaction. Returns it with its `seq`. */
export async function appendEvent<TPayload>(
  executor: Executor,
  event: NewEvent<TPayload>,
  options: AppendOptions = {},
): Promise<EventEnvelope<TPayload>> {
  const parsed = newEventSchema.safeParse(event);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlatformError(
      'platform.event_invalid',
      `${event.eventType ?? '(no type)'}: ${issue?.path.join('.') ?? '(root)'} ${issue?.message ?? 'is invalid'}`,
    );
  }

  const result = await executor.execute<AppendRow>(sql`
    SELECT out_seq, out_recorded_at FROM append_domain_event(
      ${event.id}::uuid,
      ${event.userId}::uuid,
      ${event.aggregateType}::text,
      ${event.aggregateId}::uuid,
      ${event.eventType}::text,
      ${event.eventVersion}::integer,
      ${JSON.stringify(event.payload ?? null)}::jsonb,
      ${event.occurredAt.toISOString()}::timestamptz,
      ${event.correlationId}::uuid,
      ${event.causationId}::uuid,
      ${event.redaction}::text
    )
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw new PlatformError(
      'platform.event_append_failed',
      `append_domain_event returned no row for ${event.eventType}`,
    );
  }

  options.metrics?.increment(METRIC.eventsAppended, { type: event.eventType });

  return {
    ...event,
    seq: BigInt(row.out_seq),
    recordedAt: toInstant(row.out_recorded_at),
  };
}

/**
 * Append several events in order inside one transaction.
 *
 * Sequential rather than a multi-row INSERT: the ordering lock is already held
 * after the first call, so the round trips are cheap, and keeping one code path
 * means the single-event case cannot drift from the batch case.
 */
export async function appendEvents(
  executor: Executor,
  events: readonly NewEvent[],
  options: AppendOptions = {},
): Promise<EventEnvelope[]> {
  const appended: EventEnvelope[] = [];
  for (const event of events) {
    appended.push(await appendEvent(executor, event, options));
  }
  return appended;
}
