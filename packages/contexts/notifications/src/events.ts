// SPDX-License-Identifier: MIT
/**
 * Every fact this context states.
 *
 * Same payload discipline as the rest of the repository: **ids and counts,
 * never rows** — and here that rule has a second edge. A notification's title
 * and body are, by construction, the most user-legible text in the system:
 * "Chase needs reconnection", "you have spent 80% of Groceries". `domain_events`
 * is replayable, exportable and dumped into backups, so putting a rendered body
 * into a payload would quietly make the event log a second copy of the user's
 * financial narrative. None of the three events below carries a title, a body,
 * a deep link or a destination. A consumer that wants them reads
 * `notification_outbox` through this context's reader.
 *
 * `dedupeKey` is not carried either. It is derived from the fact — a category
 * id, a period, a connection id — and is therefore an identifier of the user's
 * data wearing a string's clothes. `notificationId` is enough for anything a
 * consumer legitimately wants to do.
 *
 * ## Why `NotificationFailed` distinguishes `refused`
 *
 * 02-phase-2-dispatch.md §5 names this context's risk precisely: an SSRF here
 * reaches `db:5432` and the metadata endpoint. `outcome: 'refused'` with a
 * `refusalCode` is the event that says *we declined to connect*, and it is a
 * different operational fact from a mail server being down. A monitoring rule
 * that alerts on a `refused` is alerting on an attempted egress violation; one
 * that alerted on "failed" would be alerting on the weather.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';

const uuid = z.uuid();

export const NotificationQueued = defineEvent({
  type: 'notifications.NotificationQueued',
  aggregateType: 'notification',
  description:
    'A notification was written to the outbox. Emitted on the *insert*, not on every event that ' +
    'maps to it: a coalesced digest row is announced once and then accumulates, which is why ' +
    'groupCount is carried and why a 2,000-transaction backfill produces one of these and not ' +
    '2,000. heldUntil is non-null when quiet hours or a digest window pushed the row out; a held ' +
    'notification is still a queued one, and nothing on that path deletes a row.',
  schema: z.object({
    notificationId: uuid,
    channelId: uuid,
    ruleId: uuid.nullable(),
    channelKind: z.enum(['ntfy', 'smtp']),
    deliveryClass: z.enum(['P0_SAFETY', 'PROMPT', 'DIGEST']),
    /** Whether this insert created the row or coalesced into an existing one. */
    coalesced: z.boolean(),
    groupCount: z.int().positive(),
    /** ISO instant. Null when the row is immediately eligible. */
    heldUntil: z.iso.datetime().nullable(),
    heldReason: z.enum(['quiet_hours', 'digest_window']).nullable(),
    sourceEventType: z.string().nullable(),
  }),
});

export const NotificationDelivered = defineEvent({
  type: 'notifications.NotificationDelivered',
  aggregateType: 'notification',
  description:
    'A channel accepted the notification. Carries the attempt number because "delivered on the ' +
    'first try" and "delivered on the fourth, after two backoffs" are different statements about ' +
    "a channel's health, and the second is the one that predicts the dead letter next week.",
  schema: z.object({
    notificationId: uuid,
    channelId: uuid,
    channelKind: z.enum(['ntfy', 'smtp', 'fake']),
    attempt: z.int().positive(),
    groupCount: z.int().positive(),
    durationMs: z.int().nonnegative(),
  }),
});

export const NotificationFailed = defineEvent({
  type: 'notifications.NotificationFailed',
  aggregateType: 'notification',
  description:
    'An attempt did not deliver. Emitted per attempt, with `dead` true on the one that exhausts ' +
    'max_attempts, so a consumer can react either to the first sign of trouble or only to the ' +
    'final state. `outcome: "refused"` means the egress guard declined to connect and is never ' +
    'retried: the destination did not become legitimate while we waited.',
  schema: z.object({
    notificationId: uuid,
    channelId: uuid,
    channelKind: z.enum(['ntfy', 'smtp', 'fake']),
    attempt: z.int().positive(),
    outcome: z.enum(['retryable', 'permanent', 'refused']),
    /** Set exactly when `outcome` is `refused`. One of `REFUSAL_CODES`. */
    refusalCode: z.string().nullable(),
    /** True on the attempt that moved the row to `dead`. */
    dead: z.boolean(),
    nextAttemptAt: z.iso.datetime().nullable(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const NOTIFICATIONS_EVENTS: readonly EventDefinition[] = Object.freeze([
  NotificationQueued,
  NotificationDelivered,
  NotificationFailed,
]);
