// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/notifications`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database.
 */
export {
  notificationChannels,
  notificationRules,
  CHANNEL_KINDS,
  CHANNEL_SCHEMES,
  DELIVERY_CLASSES,
  DIGEST_CADENCES,
  type ChannelKind,
  type ChannelScheme,
  type DeliveryClass,
  type DigestCadence,
  type NotificationChannelRow,
  type NewNotificationChannelRow,
  type NotificationRuleRow,
  type NewNotificationRuleRow,
} from './channels.ts';
export {
  notificationOutbox,
  deliveryAttempts,
  OUTBOX_STATUSES,
  HELD_REASONS,
  NOTIFICATION_PRIORITIES,
  ATTEMPT_OUTCOMES,
  type OutboxStatus,
  type HeldReason,
  type NotificationPriority,
  type AttemptOutcome,
  type NotificationOutboxRow,
  type NewNotificationOutboxRow,
  type DeliveryAttemptRow,
  type NewDeliveryAttemptRow,
} from './outbox.ts';
