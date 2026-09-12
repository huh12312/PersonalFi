// SPDX-License-Identifier: MIT
import { instantColumn, userIdColumn } from '@core/db/columns';
import { bigint, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * The transactional outbox (decision D7).
 *
 * Append-only. Nothing updates a row here except the redaction pass that runs
 * when a user deletes data, and that rewrites the payload rather than the row's
 * position, so the log keeps its ordering and its shape.
 *
 * `seq` is both a total order and a *commit* order. A bare `BIGSERIAL` only gives
 * the first: two writers can take 5 and 6 and commit in the other order, and a
 * consumer that has already read 6 will never see 5. The `append_domain_event`
 * SQL function takes a transaction-scoped advisory lock before consuming the
 * sequence, which costs a few microseconds of contention on a workload of dozens
 * of writes per minute and removes the entire class of skipped-event bugs.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    seq: bigint('seq', { mode: 'bigint' }).primaryKey(),
    /** UUIDv7. Stable across replay, so it is a consumer's idempotency key. */
    id: uuid('id').notNull().unique(),
    userId: userIdColumn(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id'),
    /** `<context>.<EventName>`, e.g. `ledger.TransactionsUpserted`. */
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull().default(1),
    /** Ids and small facts. Never a full entity: see the registry's doc comment. */
    payload: jsonb('payload').notNull(),
    occurredAt: instantColumn('occurred_at').notNull().defaultNow(),
    recordedAt: instantColumn('recorded_at').notNull().defaultNow(),
    correlationId: uuid('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    redaction: text('redaction').notNull().default('none'),
  },
  (table) => [
    index('domain_events_type_seq_idx').on(table.eventType, table.seq),
    index('domain_events_correlation_idx').on(table.correlationId),
    index('domain_events_aggregate_idx').on(table.aggregateType, table.aggregateId, table.seq),
    index('domain_events_user_seq_idx').on(table.userId, table.seq),
  ],
);

export type DomainEventRow = typeof domainEvents.$inferSelect;
