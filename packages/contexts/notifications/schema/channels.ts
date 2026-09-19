// SPDX-License-Identifier: MIT
/**
 * `notification_channels` and `notification_rules`.
 *
 * These definitions are the query surface and the ownership claim, not the DDL —
 * `packages/db/migrations/0011_notifications.sql` is the one ordered,
 * forward-only history, and the `CHECK` constraints that make an illegal row
 * impossible live there rather than here. Three of them are load-bearing and
 * worth naming from this side too, because a reader of the TypeScript would
 * otherwise have to take them on trust:
 *
 *   * `notification_channels_enabled_is_verified` — `enabled` cannot be true
 *     without a `verified_at`, so "both channels ship disabled until
 *     configured" is a constraint and not a default;
 *   * `notification_channels_scheme_matches_kind` — the scheme allow-list, as
 *     a closed set with no cleartext member;
 *   * `notification_rules_p0_ignores_quiet_hours` — a `P0_SAFETY` rule may not
 *     also claim quiet hours.
 */
import {
  byteaColumn,
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** The two adapters this context ships. `fake` is a test double and never a row. */
export const CHANNEL_KINDS = ['ntfy', 'smtp'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * The scheme allow-list.
 *
 * There is no `http` and no bare `smtp`: ntfy is HTTPS only, and SMTP is either
 * implicit TLS (`smtps`, port 465) or mandatory STARTTLS (`smtp+starttls`, port
 * 587). "Opportunistic" STARTTLS is not a member, because an attacker who can
 * strip the `STARTTLS` capability from a server's greeting downgrades the
 * session to cleartext and a client that only *prefers* TLS never notices.
 */
export const CHANNEL_SCHEMES = ['https', 'smtps', 'smtp+starttls'] as const;
export type ChannelScheme = (typeof CHANNEL_SCHEMES)[number];

/**
 * 02-phase-2-dispatch.md §6 question 3: "immediate delivery only for the
 * P0-safety class (overdraft, duplicate charge, missed debt payment)".
 *
 * `PROMPT` is the middle rung that default implies but does not name:
 * delivered as soon as it is seen, *except* during quiet hours, when it is held
 * until the window ends. `DIGEST` is the default for everything else and is
 * coalesced by the outbox.
 */
export const DELIVERY_CLASSES = ['P0_SAFETY', 'PROMPT', 'DIGEST'] as const;
export type DeliveryClass = (typeof DELIVERY_CLASSES)[number];

export const DIGEST_CADENCES = ['DAILY', 'WEEKLY'] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: idColumn(),
    userId: userIdColumn(),
    kind: text('kind').$type<ChannelKind>().notNull(),
    displayName: text('display_name').notNull(),
    /**
     * In the clear on purpose. It is not a secret — the allow-list it is
     * checked against is operator configuration — and keeping it readable is
     * what lets an operator answer "what can this deployment connect to?"
     * without holding the passphrase.
     */
    destinationHost: text('destination_host').notNull(),
    destinationPort: integer('destination_port').notNull(),
    scheme: text('scheme').$type<ChannelScheme>().notNull(),
    /** `SecretBox` envelope over the channel's secrets. Never a string. */
    sealedConfig: byteaColumn('sealed_config').notNull(),
    enabled: flagColumn('enabled').notNull().default(false),
    verifiedAt: instantColumn('verified_at'),
    verifyFailureCode: text('verify_failure_code'),
    lastDeliveryAt: instantColumn('last_delivery_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('notification_channels_user_name_idx').on(table.userId, table.displayName),
    index('notification_channels_user_enabled_idx').on(table.userId),
  ],
);

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: idColumn(),
    userId: userIdColumn(),
    channelId: uuid('channel_id').notNull(),
    name: text('name').notNull(),
    /** `<context>.<EventName>`. A wire contract, not a foreign key (D8). */
    eventType: text('event_type').notNull(),
    conditions: jsonb('conditions').notNull().default({}),
    deliveryClass: text('delivery_class').$type<DeliveryClass>().notNull(),
    digestCadence: text('digest_cadence').$type<DigestCadence>(),
    /** The account holder's zone. Quiet hours and the digest window use it. */
    timezone: text('timezone').notNull(),
    quietHoursEnabled: flagColumn('quiet_hours_enabled').notNull().default(true),
    /** Minutes from local midnight. 1320 = 22:00. */
    quietHoursStartMinute: integer('quiet_hours_start_minute').notNull().default(1320),
    /** Minutes from local midnight. 420 = 07:00. */
    quietHoursEndMinute: integer('quiet_hours_end_minute').notNull().default(420),
    enabled: flagColumn('enabled').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('notification_rules_user_name_idx').on(table.userId, table.name),
    index('notification_rules_event_idx').on(table.userId, table.eventType),
    index('notification_rules_channel_idx').on(table.channelId),
  ],
);

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;
export type NewNotificationChannelRow = typeof notificationChannels.$inferInsert;
export type NotificationRuleRow = typeof notificationRules.$inferSelect;
export type NewNotificationRuleRow = typeof notificationRules.$inferInsert;
