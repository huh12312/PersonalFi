// SPDX-License-Identifier: MIT
/**
 * The delivery outbox: at-most-once insert, digest coalescing, claim, and the
 * backoff ladder that ends in a visible dead letter.
 *
 * 08 §4.5 states the two properties this file implements and says where they
 * must live:
 *
 * > "the consumer inserts into `notification_outbox` (idempotent via
 * > `dedupeKey`); a job drains it with exponential backoff and a dead-letter
 * > state visible in the UI. Digest mode coalesces by `groupKey` within a
 * > window so a 2,000-transaction backfill produces one notification, not
 * > 2,000 — **this is enforced by the outbox, not by each rule remembering to
 * > do it**."
 *
 * ## Both properties are one INSERT
 *
 * ```sql
 * INSERT INTO notification_outbox (…)
 * ON CONFLICT (user_id, dedupe_key) DO UPDATE
 *   SET group_count = notification_outbox.group_count
 *                   + (CASE WHEN EXCLUDED.group_key IS NULL THEN 0 ELSE 1 END)
 * RETURNING id, group_count, status, (xmax = 0) AS inserted
 * ```
 *
 * A read-then-write would race exactly the thing it defends against — two
 * events arriving 50 ms apart — so the conflict target does the work, the same
 * shape `@core/platform`'s `enqueueJob` uses. `xmax = 0` distinguishes the
 * insert from the update, which is what `coalesced` on
 * `notifications.NotificationQueued` reports.
 *
 * ## Why a digest's dedupe key is derived here and not passed in
 *
 * A `DIGEST` row's `dedupe_key` is `digest:<groupKey>:<windowStartIso>`,
 * constructed by this file. The caller may not supply its own, because the two
 * UNIQUE indexes — `(user_id, dedupe_key)` and `(user_id, channel_id,
 * group_key, group_window_start)` — must agree about what "the same
 * notification" means. If a rule could pick its own dedupe key for a grouped
 * row, two rules writing the same `group_key` into the same window would
 * collide on the *second* index, raise a constraint violation, and roll back a
 * consumer transaction — turning a coalescing decision into an outage. Deriving
 * it means the first index always fires first and the second is a standing
 * proof that it did.
 *
 * ## Why a delivered digest cannot swallow a later fact
 *
 * A grouped row's `not_before` is its **window end**, so a digest is never sent
 * while its window is still open. By the time a row is `delivered`, any new
 * event falls in the next window, derives a different `group_window_start`, and
 * therefore a different dedupe key — a new row. The one case where a fact is
 * absorbed into a row that will not be sent is a digest that dead-lettered
 * mid-window; that row is visible in the dead-letter view and
 * `retryNotification` puts it back on the ladder, which is the recovery walked
 * in the evidence note.
 */
import { newId } from '@core/kernel';
import { backoffDelayMs, type BackoffOptions } from '@core/platform';
import { and, eq, sql } from 'drizzle-orm';
import type { NotificationAction } from './channel.ts';
import type { NotificationsContext, NotificationsExecutor } from './db.ts';
import type { DigestWindow } from './time.ts';
import {
  notificationOutbox,
  type DeliveryClass,
  type HeldReason,
  type NotificationOutboxRow,
  type NotificationPriority,
} from '../schema/index.ts';

/**
 * Five attempts, doubling from thirty seconds, capped at six hours.
 *
 * Slower than `DEFAULT_JOB_BACKOFF`'s one second because the failures this
 * ladder actually sees are a self-hosted ntfy container restarting and a mail
 * provider rate-limiting. Retrying either after a second achieves nothing and
 * costs a connection; the alert is not more urgent for having been attempted
 * four times in ten seconds.
 */
export const DEFAULT_DELIVERY_BACKOFF: BackoffOptions = Object.freeze({
  baseMs: 30_000,
  factor: 2,
  maxMs: 6 * 60 * 60 * 1_000,
  jitter: 'full',
});

export const DEFAULT_MAX_ATTEMPTS = 5;

export interface EnqueueNotificationInput {
  readonly channelId: string;
  readonly ruleId: string | null;
  /** Ignored for a `DIGEST` row; see the header. */
  readonly dedupeKey: string;
  readonly groupKey: string | null;
  readonly groupWindow: DigestWindow | null;
  readonly deliveryClass: DeliveryClass;
  readonly priority: NotificationPriority;
  readonly title: string;
  readonly bodyMd: string;
  readonly deepLink?: string | null;
  readonly actions?: readonly NotificationAction[];
  /** When the drain may first pick this up. Quiet hours and digests move it. */
  readonly notBefore: Date;
  readonly heldReason: HeldReason | null;
  readonly sourceEventId?: string | null;
  readonly sourceEventType?: string | null;
  readonly maxAttempts?: number;
}

export interface EnqueueNotificationResult {
  readonly id: string;
  /** False when this insert created the row. */
  readonly coalesced: boolean;
  readonly groupCount: number;
  readonly status: string;
  readonly heldReason: HeldReason | null;
  readonly notBefore: Date;
}

/** `digest:<groupKey>:<windowStartIso>` — the key both UNIQUE indexes agree on. */
export function digestDedupeKey(groupKey: string, window: DigestWindow): string {
  return `digest:${groupKey}:${window.start.toISOString()}`;
}

export async function enqueueNotification(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  input: EnqueueNotificationInput,
): Promise<EnqueueNotificationResult> {
  const grouped = input.groupKey !== null && input.groupWindow !== null;
  if (input.deliveryClass === 'DIGEST' && !grouped) {
    throw new TypeError(
      'a DIGEST notification needs a groupKey and a window; coalescing is not optional ' +
        '(notification_outbox_digest_is_grouped enforces the same thing in SQL)',
    );
  }

  const dedupeKey =
    grouped && input.groupKey !== null && input.groupWindow !== null
      ? digestDedupeKey(input.groupKey, input.groupWindow)
      : input.dedupeKey;

  const id = newId();
  const status = input.heldReason === null ? 'pending' : 'held';

  const result = await executor.execute<{
    id: string;
    group_count: number;
    status: string;
    held_reason: string | null;
    not_before: Date | string;
    inserted: boolean;
  }>(sql`
    INSERT INTO notification_outbox (
      id, user_id, channel_id, rule_id, dedupe_key,
      group_key, group_window_start, group_window_end, group_count,
      delivery_class, priority, title, body_md, deep_link, actions,
      status, held_reason, max_attempts, not_before,
      source_event_id, source_event_type, correlation_id
    ) VALUES (
      ${id}::uuid,
      ${context.userId}::uuid,
      ${input.channelId}::uuid,
      ${input.ruleId}::uuid,
      ${dedupeKey}::text,
      ${input.groupKey}::text,
      ${input.groupWindow === null ? null : input.groupWindow.start.toISOString()}::timestamptz,
      ${input.groupWindow === null ? null : input.groupWindow.end.toISOString()}::timestamptz,
      1,
      ${input.deliveryClass}::text,
      ${input.priority}::text,
      ${input.title}::text,
      ${input.bodyMd}::text,
      ${input.deepLink ?? null}::text,
      ${JSON.stringify(input.actions ?? [])}::jsonb,
      ${status}::text,
      ${input.heldReason}::text,
      ${input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS},
      ${input.notBefore.toISOString()}::timestamptz,
      ${input.sourceEventId ?? null}::uuid,
      ${input.sourceEventType ?? null}::text,
      ${context.correlationId}::uuid
    )
    ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
      -- An ungrouped collision is the at-most-once case: the row already says
      -- what this event says, so nothing changes and nothing is sent twice.
      group_count = notification_outbox.group_count
                    + (CASE WHEN EXCLUDED.group_key IS NULL THEN 0 ELSE 1 END),
      updated_at = ${context.clock.now().toISOString()}::timestamptz
    RETURNING
      id,
      group_count,
      status,
      held_reason,
      not_before,
      (xmax = 0) AS inserted
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('notification_outbox upsert returned no row');
  }

  return {
    id: row.id,
    coalesced: !row.inserted,
    groupCount: Number(row.group_count),
    status: row.status,
    heldReason: (row.held_reason as HeldReason | null) ?? null,
    notBefore: row.not_before instanceof Date ? row.not_before : new Date(row.not_before),
  };
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

/**
 * Claim up to `limit` due notifications.
 *
 * `FOR UPDATE SKIP LOCKED` for the reason `@core/platform`'s job runner uses
 * it: two workers never see the same row and no lock is held across the
 * network call. A `held` row becomes claimable the moment `not_before` passes,
 * which is what makes "held, not dropped" operational rather than aspirational
 * — the release is a comparison, not a second job that has to remember.
 */
export async function claimDueNotifications(
  executor: NotificationsExecutor,
  now: Date,
  limit: number,
): Promise<readonly NotificationOutboxRow[]> {
  const result = await executor.execute<Record<string, unknown>>(sql`
    UPDATE notification_outbox AS target
    SET status = 'sending', held_reason = NULL, updated_at = ${now.toISOString()}::timestamptz
    WHERE target.id IN (
      SELECT candidate.id FROM notification_outbox AS candidate
      WHERE candidate.status IN ('pending', 'held')
        AND candidate.not_before <= ${now.toISOString()}::timestamptz
      ORDER BY candidate.not_before, candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING target.*
  `);
  return result.rows.map(toOutboxRow);
}

/**
 * A raw `RETURNING target.*` row, mapped into the Drizzle row shape.
 *
 * This exists because the claim **must** be raw SQL — `FOR UPDATE SKIP LOCKED`
 * over a subquery is not expressible in the query builder — and a raw row comes
 * back with Postgres's column names. Casting it to `NotificationOutboxRow` and
 * reading `row.userId` off it is how a delivery drain silently claims rows and
 * then delivers none of them: every property is `undefined`, the per-user filter
 * matches nothing, and the only symptom is an outbox that fills up. There is one
 * mapping, it is here, and `test/db/dedupe.test.ts` fails if it drifts.
 */
function toOutboxRow(raw: Record<string, unknown>): NotificationOutboxRow {
  return {
    id: String(raw['id']),
    userId: String(raw['user_id']),
    channelId: String(raw['channel_id']),
    ruleId: asString(raw['rule_id']),
    dedupeKey: String(raw['dedupe_key']),
    groupKey: asString(raw['group_key']),
    groupWindowStart: asDate(raw['group_window_start']),
    groupWindowEnd: asDate(raw['group_window_end']),
    groupCount: Number(raw['group_count']),
    deliveryClass: raw['delivery_class'] as DeliveryClass,
    priority: raw['priority'] as NotificationPriority,
    title: String(raw['title']),
    bodyMd: String(raw['body_md']),
    deepLink: asString(raw['deep_link']),
    actions: raw['actions'] ?? [],
    status: raw['status'] as NotificationOutboxRow['status'],
    heldReason: (raw['held_reason'] as HeldReason | null) ?? null,
    attemptCount: Number(raw['attempt_count']),
    maxAttempts: Number(raw['max_attempts']),
    notBefore: asDate(raw['not_before']) ?? new Date(0),
    sourceEventId: asString(raw['source_event_id']),
    sourceEventType: asString(raw['source_event_type']),
    correlationId: String(raw['correlation_id']),
    queuedAt: asDate(raw['queued_at']) ?? new Date(0),
    deliveredAt: asDate(raw['delivered_at']),
    deadAt: asDate(raw['dead_at']),
    lastFailureCode: asString(raw['last_failure_code']),
    createdAt: asDate(raw['created_at']) ?? new Date(0),
    updatedAt: asDate(raw['updated_at']) ?? new Date(0),
  };
}

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

export interface AttemptRecord {
  readonly notificationId: string;
  readonly attempt: number;
  readonly channelKind: string;
  readonly outcome: 'delivered' | 'retryable' | 'permanent' | 'refused';
  readonly refusalCode: string | null;
  readonly httpStatus: number | null;
  readonly detail: string | null;
  readonly durationMs: number;
  readonly nextAttemptAt: Date | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

async function recordAttempt(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  record: AttemptRecord,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO delivery_attempts (
      id, user_id, notification_id, attempt, channel_kind, outcome,
      refusal_code, http_status, detail, duration_ms, next_attempt_at,
      started_at, finished_at
    ) VALUES (
      ${newId()}::uuid,
      ${context.userId}::uuid,
      ${record.notificationId}::uuid,
      ${record.attempt},
      ${record.channelKind}::text,
      ${record.outcome}::text,
      ${record.refusalCode}::text,
      ${record.httpStatus}::integer,
      ${record.detail === null ? null : record.detail.slice(0, 500)}::text,
      ${record.durationMs},
      ${record.nextAttemptAt === null ? null : record.nextAttemptAt.toISOString()}::timestamptz,
      ${record.startedAt.toISOString()}::timestamptz,
      ${record.finishedAt.toISOString()}::timestamptz
    )
  `);
}

export async function markDelivered(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  input: {
    readonly notificationId: string;
    readonly channelId: string;
    readonly channelKind: string;
    readonly attempt: number;
    readonly durationMs: number;
    readonly httpStatus: number | null;
    readonly startedAt: Date;
  },
): Promise<void> {
  const now = context.clock.now();
  await executor.execute(sql`
    UPDATE notification_outbox
    SET status = 'delivered',
        delivered_at = ${now.toISOString()}::timestamptz,
        attempt_count = ${input.attempt},
        last_failure_code = NULL,
        held_reason = NULL,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE id = ${input.notificationId}::uuid AND user_id = ${context.userId}::uuid
  `);
  await executor.execute(sql`
    UPDATE notification_channels
    SET last_delivery_at = ${now.toISOString()}::timestamptz,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE id = ${input.channelId}::uuid AND user_id = ${context.userId}::uuid
  `);
  await recordAttempt(executor, context, {
    notificationId: input.notificationId,
    attempt: input.attempt,
    channelKind: input.channelKind,
    outcome: 'delivered',
    refusalCode: null,
    httpStatus: input.httpStatus,
    detail: null,
    durationMs: input.durationMs,
    nextAttemptAt: null,
    startedAt: input.startedAt,
    finishedAt: now,
  });
}

export interface MarkFailedResult {
  readonly dead: boolean;
  readonly nextAttemptAt: Date | null;
}

/**
 * Record a failed attempt and decide what happens next.
 *
 * Three different answers, and the difference is the point:
 *
 * * `refused` — the egress guard declined. **Never retried.** A destination
 *   does not become legitimate by waiting, and retrying it four more times
 *   would turn one refused connection into five and make an SSRF probe look
 *   like a flapping mail server. Straight to `dead`, with the refusal code on
 *   the row and on every attempt.
 * * `permanent` — they refused us (a 4xx, an SMTP 5xx). Also straight to
 *   `dead`: an invalid credential is not fixed by patience.
 * * `retryable` — backoff, unless this was the last attempt.
 *
 * ## The last rung is recorded as `permanent`, and the schema is why
 *
 * `delivery_attempts_retryable_has_next` says an attempt whose outcome is
 * `retryable` must name the attempt that follows it, which is the constraint
 * form of "retryable means we scheduled a retry". The rung that exhausts
 * `max_attempts` schedules nothing, so recording the adapter's word for it
 * would write a row the database correctly refuses — and the refusal lands
 * inside the delivery job's transaction, where it rolls the whole attempt back
 * and the ladder never terminates. The exhausting rung is therefore written as
 * `permanent` with the original reason preserved in `detail`, and the row's
 * `last_failure_code` becomes `attempts_exhausted`, which is the thing an
 * operator actually needs to read: not *why* the fifth attempt failed, but that
 * there will not be a sixth.
 */
export async function markFailed(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  input: {
    readonly notificationId: string;
    readonly channelKind: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly outcome: 'retryable' | 'permanent' | 'refused';
    readonly refusalCode: string | null;
    readonly httpStatus: number | null;
    readonly detail: string | null;
    readonly durationMs: number;
    readonly startedAt: Date;
    readonly backoff?: BackoffOptions;
    readonly random?: () => number;
  },
): Promise<MarkFailedResult> {
  const now = context.clock.now();
  const terminal = input.outcome !== 'retryable' || input.attempt >= input.maxAttempts;
  /** A retryable failure on the rung that exhausts the ladder. See the header. */
  const exhausted = input.outcome === 'retryable' && terminal;
  const recordedOutcome = exhausted ? 'permanent' : input.outcome;
  const recordedDetail = exhausted
    ? `${input.detail ?? 'retryable failure'} (no further attempts: ${String(input.maxAttempts)} exhausted)`
    : input.detail;
  const failureCode = input.refusalCode ?? (exhausted ? 'attempts_exhausted' : input.outcome);

  const nextAttemptAt = terminal
    ? null
    : new Date(
        now.getTime() +
          backoffDelayMs(input.attempt, input.backoff ?? DEFAULT_DELIVERY_BACKOFF, input.random),
      );

  await executor.execute(sql`
    UPDATE notification_outbox
    SET status = ${terminal ? 'dead' : 'pending'}::text,
        dead_at = ${terminal ? now.toISOString() : null}::timestamptz,
        attempt_count = ${input.attempt},
        last_failure_code = ${failureCode}::text,
        held_reason = NULL,
        not_before = ${(nextAttemptAt ?? now).toISOString()}::timestamptz,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE id = ${input.notificationId}::uuid AND user_id = ${context.userId}::uuid
  `);

  await recordAttempt(executor, context, {
    notificationId: input.notificationId,
    attempt: input.attempt,
    channelKind: input.channelKind,
    outcome: recordedOutcome,
    refusalCode: input.refusalCode,
    httpStatus: input.httpStatus,
    detail: recordedDetail,
    durationMs: input.durationMs,
    nextAttemptAt,
    startedAt: input.startedAt,
    finishedAt: now,
  });

  return { dead: terminal, nextAttemptAt };
}

/**
 * Put a dead letter back on the ladder.
 *
 * The other half of "a dead-letter state visible in the UI": visible is only
 * useful if it is also actionable. The attempt history is kept — this does not
 * delete `delivery_attempts` rows — so a notification that dead-lettered, was
 * fixed and was retried reads as one story.
 *
 * A `refused` dead letter is retried too, and will be refused again unless the
 * operator changed the allow-list or the user fixed the channel. That is the
 * correct behaviour: the guard, not the retry path, is what decides.
 *
 * ## The attempt counter goes forward, never back
 *
 * `attempt_count` is **not** reset. It is the high-water mark of a ladder whose
 * rungs are `delivery_attempts` rows keyed `(notification_id, attempt)` UNIQUE,
 * so a retry that rewound the counter to zero would make the next attempt claim
 * the number 1 again and die on that index — turning "retry the dead letter"
 * into a constraint violation inside the delivery job. What a retry grants is a
 * *fresh ladder*: `max_attempts` moves out by another five from where the row
 * already stands. The history then reads as one story — attempts 1–5 failed,
 * the operator fixed the channel, attempt 6 delivered — which is the whole
 * reason the attempts survive the row reaching `dead`.
 */
export async function retryNotification(
  executor: NotificationsExecutor,
  context: NotificationsContext,
  notificationId: string,
): Promise<boolean> {
  const now = context.clock.now();
  const result = await executor
    .update(notificationOutbox)
    .set({
      status: 'pending',
      deadAt: null,
      heldReason: null,
      maxAttempts: sql`${notificationOutbox.attemptCount} + ${DEFAULT_MAX_ATTEMPTS}`,
      lastFailureCode: null,
      notBefore: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(notificationOutbox.id, notificationId),
        eq(notificationOutbox.userId, context.userId),
        eq(notificationOutbox.status, 'dead'),
      ),
    )
    .returning({ id: notificationOutbox.id });
  return result.length > 0;
}
