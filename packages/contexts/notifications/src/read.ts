// SPDX-License-Identifier: MIT
/**
 * Read models.
 *
 * Everything here returns *redacted* shapes: no `sealed_config`, no adapter
 * config, no secret of any kind. A notification's title and body do cross —
 * they are what the settings screen shows the user about their own alerts —
 * but a channel never renders as more than its host, port and scheme.
 *
 * The dead-letter reader is the one 08 §4.5 asks for by name ("a dead-letter
 * state visible in the UI"). It returns the attempts alongside the row, because
 * a dead letter with no attempt history tells the user something failed and
 * nothing about why, which is the version of this screen nobody opens twice.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NotificationsExecutor } from './db.ts';
import {
  deliveryAttempts,
  notificationOutbox,
  type AttemptOutcome,
  type DeliveryClass,
  type HeldReason,
  type NotificationPriority,
  type OutboxStatus,
} from '../schema/index.ts';

export interface OutboxEntry {
  readonly id: string;
  readonly channelId: string;
  readonly ruleId: string | null;
  readonly status: OutboxStatus;
  readonly heldReason: HeldReason | null;
  readonly deliveryClass: DeliveryClass;
  readonly priority: NotificationPriority;
  readonly title: string;
  readonly bodyMd: string;
  readonly deepLink: string | null;
  readonly groupKey: string | null;
  readonly groupCount: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly notBefore: Date;
  readonly queuedAt: Date;
  readonly deliveredAt: Date | null;
  readonly deadAt: Date | null;
  readonly lastFailureCode: string | null;
}

export interface AttemptEntry {
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  readonly refusalCode: string | null;
  readonly httpStatus: number | null;
  readonly detail: string | null;
  readonly durationMs: number | null;
  readonly nextAttemptAt: Date | null;
  readonly finishedAt: Date;
}

export interface DeadLetter extends OutboxEntry {
  readonly attempts: readonly AttemptEntry[];
}

export async function listOutbox(
  executor: NotificationsExecutor,
  userId: string,
  options: { readonly limit?: number; readonly statuses?: readonly OutboxStatus[] } = {},
): Promise<readonly OutboxEntry[]> {
  const rows = await executor
    .select()
    .from(notificationOutbox)
    .where(
      options.statuses === undefined
        ? eq(notificationOutbox.userId, userId)
        : and(
            eq(notificationOutbox.userId, userId),
            inArray(notificationOutbox.status, [...options.statuses]),
          ),
    )
    .orderBy(desc(notificationOutbox.queuedAt))
    .limit(options.limit ?? 100);
  return rows.map(toEntry);
}

/**
 * The dead-letter view, newest first, with every attempt.
 *
 * `refusalCode` surviving all the way out here is the point: an operator
 * looking at this screen must be able to tell "we refused to connect to that"
 * from "their server was down", because only one of those is a sign that
 * something is trying to make this app talk to `db:5432`.
 */
export async function listDeadLetters(
  executor: NotificationsExecutor,
  userId: string,
  limit = 50,
): Promise<readonly DeadLetter[]> {
  const rows = await executor
    .select()
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.userId, userId), eq(notificationOutbox.status, 'dead')))
    .orderBy(desc(notificationOutbox.deadAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const attempts = await executor
    .select()
    .from(deliveryAttempts)
    .where(
      and(
        eq(deliveryAttempts.userId, userId),
        inArray(
          deliveryAttempts.notificationId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(deliveryAttempts.attempt);

  return rows.map((row) => ({
    ...toEntry(row),
    attempts: attempts
      .filter((attempt) => attempt.notificationId === row.id)
      .map((attempt) => ({
        attempt: attempt.attempt,
        outcome: attempt.outcome,
        refusalCode: attempt.refusalCode,
        httpStatus: attempt.httpStatus,
        detail: attempt.detail,
        durationMs: attempt.durationMs,
        nextAttemptAt: attempt.nextAttemptAt,
        finishedAt: attempt.finishedAt,
      })),
  }));
}

export async function listAttempts(
  executor: NotificationsExecutor,
  userId: string,
  notificationId: string,
): Promise<readonly AttemptEntry[]> {
  const rows = await executor
    .select()
    .from(deliveryAttempts)
    .where(
      and(eq(deliveryAttempts.userId, userId), eq(deliveryAttempts.notificationId, notificationId)),
    )
    .orderBy(deliveryAttempts.attempt);
  return rows.map((row) => ({
    attempt: row.attempt,
    outcome: row.outcome,
    refusalCode: row.refusalCode,
    httpStatus: row.httpStatus,
    detail: row.detail,
    durationMs: row.durationMs,
    nextAttemptAt: row.nextAttemptAt,
    finishedAt: row.finishedAt,
  }));
}

function toEntry(row: typeof notificationOutbox.$inferSelect): OutboxEntry {
  return {
    id: row.id,
    channelId: row.channelId,
    ruleId: row.ruleId,
    status: row.status,
    heldReason: row.heldReason,
    deliveryClass: row.deliveryClass,
    priority: row.priority,
    title: row.title,
    bodyMd: row.bodyMd,
    deepLink: row.deepLink,
    groupKey: row.groupKey,
    groupCount: row.groupCount,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    notBefore: row.notBefore,
    queuedAt: row.queuedAt,
    deliveredAt: row.deliveredAt,
    deadAt: row.deadAt,
    lastFailureCode: row.lastFailureCode,
  };
}
