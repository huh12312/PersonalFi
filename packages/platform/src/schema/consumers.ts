// SPDX-License-Identifier: MIT
import { instantColumn, updatedAtColumn, userIdColumn } from '@core/db/columns';
import { bigint, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

/**
 * How far each consumer has read, and whether it is healthy.
 *
 * Global rather than user-scoped: an offset is a property of this deployment's
 * pump, not of the account holder. It is not user data, so it is neither exported
 * nor restored with one.
 *
 * The name carries a version by convention (`budgeting.actuals@v3`). Bumping the
 * version and resetting `lastSeq` to 0 *is* the read-model rebuild procedure —
 * one row update instead of a bespoke data-repair script.
 */
export const eventConsumerOffsets = pgTable('event_consumer_offsets', {
  consumerName: text('consumer_name').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'bigint' }).notNull().default(0n),
  /** `running` | `paused` | `replaying` | `failed`. */
  status: text('status').notNull().default('running'),
  /**
   * Dead-letter detail. A consumer that exhausts its retries goes `failed` and
   * *stops* at the offending event; it never skips. A skipped event is a read
   * model that is silently wrong, which is worse than one that is visibly stuck.
   */
  failedSeq: bigint('failed_seq', { mode: 'bigint' }),
  failedEventId: uuid('failed_event_id'),
  failedError: text('failed_error'),
  failedCount: integer('failed_count').notNull().default(0),
  retryAfter: instantColumn('retry_after'),
  lastEventAt: instantColumn('last_event_at'),
  updatedAt: updatedAtColumn(),
});

export type EventConsumerOffsetRow = typeof eventConsumerOffsets.$inferSelect;

/**
 * Delivery receipts: the bookkeeping half of idempotency.
 *
 * The other half is structural and preferred — a handler that recomputes a
 * deterministic function of current state over an affected window is idempotent
 * by construction, and running it five times is the same as running it once.
 * This table is for the handlers that *cannot* be recomputed: sending a
 * notification, calling a provider, appending an insight.
 *
 * The receipt is written in the same transaction as the handler's own writes and
 * the offset advance, so "did this side effect happen?" and "did we record that
 * it happened?" cannot disagree.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    consumerName: text('consumer_name').notNull(),
    eventId: uuid('event_id').notNull(),
    userId: userIdColumn(),
    eventSeq: bigint('event_seq', { mode: 'bigint' }).notNull(),
    processedAt: instantColumn('processed_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.consumerName, table.eventId] }),
    index('processed_events_consumer_seq_idx').on(table.consumerName, table.eventSeq),
  ],
);

export type ProcessedEventRow = typeof processedEvents.$inferSelect;
