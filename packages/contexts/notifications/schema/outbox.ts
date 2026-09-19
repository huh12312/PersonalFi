// SPDX-License-Identifier: MIT
/**
 * `notification_outbox` and `delivery_attempts`.
 *
 * The two claims 08 §4.5 makes about this table are **indexes**, declared in
 * `0011_notifications.sql` and restated here only so a reader of the queries
 * knows what is holding them up:
 *
 *   notification_outbox_dedupe_idx  UNIQUE (user_id, dedupe_key)
 *   notification_outbox_group_idx   UNIQUE (user_id, channel_id, group_key,
 *                                           group_window_start)
 *                                   WHERE group_key IS NOT NULL
 *
 * The first is at-most-once delivery. The second is digest coalescing, and it
 * is here rather than in each rule for the reason the memo gives: "this is
 * enforced by the outbox, not by each rule remembering to do it". A rule that
 * forgot would still collide.
 */
import { createdAtColumn, idColumn, instantColumn, updatedAtColumn, userIdColumn } from '@core/db';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ChannelKind, DeliveryClass } from './channels.ts';

/**
 * `held` is the state that makes "quiet hours hold, they never drop" true —
 * there is no `dropped` member and no DELETE on the hold path.
 */
export const OUTBOX_STATUSES = [
  'pending',
  'held',
  'sending',
  'delivered',
  'failed',
  'dead',
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const HELD_REASONS = ['quiet_hours', 'digest_window'] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

/**
 * Four outcomes, not three.
 *
 * `refused` means *we* would not connect: the egress guard said no. It is kept
 * distinct from `permanent` (they refused us) because collapsing them would
 * make an SSRF attempt read like a mail server being down, which is exactly
 * the signal an operator most needs to see.
 */
export const ATTEMPT_OUTCOMES = ['delivered', 'retryable', 'permanent', 'refused'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: idColumn(),
    userId: userIdColumn(),
    channelId: uuid('channel_id').notNull(),
    /** NULL for a "send test": a verification has no rule behind it. */
    ruleId: uuid('rule_id'),
    /** Derived from the *fact*, never from the event id. UNIQUE per user. */
    dedupeKey: text('dedupe_key').notNull(),
    groupKey: text('group_key'),
    groupWindowStart: instantColumn('group_window_start'),
    groupWindowEnd: instantColumn('group_window_end'),
    /** Facts coalesced into this row. 2,000 after a backfill. */
    groupCount: integer('group_count').notNull().default(1),
    deliveryClass: text('delivery_class').$type<DeliveryClass>().notNull(),
    priority: text('priority').$type<NotificationPriority>().notNull().default('normal'),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    deepLink: text('deep_link'),
    actions: jsonb('actions').notNull().default([]),
    status: text('status').$type<OutboxStatus>().notNull().default('pending'),
    heldReason: text('held_reason').$type<HeldReason>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /** The quiet-hours hold and the backoff ladder both move this forward. */
    notBefore: instantColumn('not_before').notNull().defaultNow(),
    sourceEventId: uuid('source_event_id'),
    sourceEventType: text('source_event_type'),
    correlationId: uuid('correlation_id').notNull(),
    queuedAt: instantColumn('queued_at').notNull().defaultNow(),
    deliveredAt: instantColumn('delivered_at'),
    deadAt: instantColumn('dead_at'),
    lastFailureCode: text('last_failure_code'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('notification_outbox_dedupe_idx').on(table.userId, table.dedupeKey),
    uniqueIndex('notification_outbox_group_idx').on(
      table.userId,
      table.channelId,
      table.groupKey,
      table.groupWindowStart,
    ),
    index('notification_outbox_due_idx').on(table.notBefore, table.id),
    index('notification_outbox_dead_idx').on(table.userId, table.deadAt),
    index('notification_outbox_user_queued_idx').on(table.userId, table.queuedAt),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: idColumn(),
    userId: userIdColumn(),
    notificationId: uuid('notification_id').notNull(),
    attempt: integer('attempt').notNull(),
    channelKind: text('channel_kind').$type<ChannelKind | 'fake'>().notNull(),
    outcome: text('outcome').$type<AttemptOutcome>().notNull(),
    /** Set exactly when `outcome = 'refused'`. The refusal matrix reads this. */
    refusalCode: text('refusal_code'),
    httpStatus: integer('http_status'),
    /** Already redacted. Never a response body, never a URL with a credential. */
    detail: text('detail'),
    durationMs: integer('duration_ms'),
    nextAttemptAt: instantColumn('next_attempt_at'),
    startedAt: instantColumn('started_at').notNull().defaultNow(),
    finishedAt: instantColumn('finished_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('delivery_attempts_notification_attempt_idx').on(
      table.notificationId,
      table.attempt,
    ),
    index('delivery_attempts_user_idx').on(table.userId, table.createdAt),
    index('delivery_attempts_refused_idx').on(table.userId, table.refusalCode),
  ],
);

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NewNotificationOutboxRow = typeof notificationOutbox.$inferInsert;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttemptRow = typeof deliveryAttempts.$inferInsert;
