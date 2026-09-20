// SPDX-License-Identifier: MIT
/**
 * The two jobs: drain the outbox, and close digest windows.
 *
 * Both are `@core/platform` jobs rather than timers, so they survive a
 * `docker kill`, appear in the queue health view, and are claimed with
 * `FOR UPDATE SKIP LOCKED` so two workers never send the same notification.
 *
 * ## `notifications.deliver`
 *
 * Claim the due rows, open each channel's sealed config, hand it to the
 * adapter, and record what happened. Three properties are worth stating because
 * each one is a decision:
 *
 * * **The config is opened per attempt and never cached.** A plaintext SMTP
 *   password exists for the duration of one `sendMail` and is then unreachable
 *   again. Caching it across the worker's uptime would be the difference
 *   between a heap dump containing one secret and a heap dump containing every
 *   secret the deployment holds.
 * * **A `refused` never retries.** `markFailed` sends it straight to `dead`. A
 *   destination does not become legitimate by waiting, and retrying it four
 *   more times turns one refused connection into five — which is both wasted
 *   and, to anyone reading the logs, indistinguishable from a flaky server.
 * * **The digest body is composed at send time** from `group_count`, so the
 *   number the user reads is the number the outbox actually coalesced, not a
 *   number some earlier write guessed.
 *
 * ## `notifications.digest`
 *
 * The coalescing job. It does not decide *whether* to coalesce — the outbox's
 * UNIQUE index already did that, at insert — it decides when a window is over.
 * Rows whose `group_window_end` has passed stop being `held` and become
 * `pending`, at which point the drain treats them like anything else. Keeping
 * it a separate job means "the window closed" is an observable event with a
 * `job_runs` row behind it, rather than a side effect of a timestamp
 * comparison inside another job.
 */
import { newId, systemClock, type Clock } from '@core/kernel';
import {
  appendEvent,
  defineJob,
  upsertSchedule,
  type Executor,
  type JobContext,
  type JobHandlerRegistration,
} from '@core/platform';
import { sql } from 'drizzle-orm';
import type { SecretBox } from '@core/secretbox';
import type { Notification } from './channel.ts';
import { outboxOf, type NotificationsDatabase, type NotificationsExecutor } from './db.ts';
import { NotificationDelivered, NotificationFailed } from './events.ts';
import {
  claimDueNotifications,
  markDelivered,
  markFailed,
  DEFAULT_DELIVERY_BACKOFF,
} from './outbox.ts';
import { findChannel, openChannelConfig, type ChannelRegistry } from './service.ts';
import type { BackoffOptions } from '@core/platform';
import type { NotificationOutboxRow } from '../schema/index.ts';

export const DELIVER_JOB_KIND = 'notifications.deliver';
export const DIGEST_JOB_KIND = 'notifications.digest';

/** A `SecretBox` is per-user, so the job asks for one by user id. */
export type SecretBoxProvider = (userId: string) => SecretBox;

export interface DeliveryJobDependencies {
  readonly database: NotificationsDatabase;
  readonly registry: ChannelRegistry;
  readonly secretBoxFor: SecretBoxProvider;
  readonly clock?: Clock;
  readonly backoff?: BackoffOptions;
  readonly random?: () => number;
  /** Rows per run. Bounded so one user's storm cannot monopolise a worker. */
  readonly batchSize?: number;
}

/**
 * Compose the body a channel actually receives.
 *
 * A coalesced row says how many facts it stands for. The alternative — writing
 * "1 event" at insert and never updating it — is how a digest ends up claiming
 * it covers one thing when it covers two thousand.
 */
export function digestBody(row: NotificationOutboxRow): string {
  if (row.groupCount <= 1) return row.bodyMd;
  return `${row.bodyMd}\n\n${String(row.groupCount)} related events since ${
    row.groupWindowStart?.toISOString() ?? 'the window opened'
  }.`;
}

function notificationOf(row: NotificationOutboxRow): Notification {
  return {
    dedupeKey: row.dedupeKey,
    priority: row.priority,
    title: row.title,
    bodyMd: digestBody(row),
    deepLink: row.deepLink,
    actions: (row.actions as { label: string; url: string }[] | null) ?? [],
    groupKey: row.groupKey,
    groupCount: row.groupCount,
  };
}

export function createDeliveryJob(dependencies: DeliveryJobDependencies): JobHandlerRegistration {
  return defineJob(
    DELIVER_JOB_KIND,
    async (_payload: unknown, context: JobContext) => {
      await drainNotifications(dependencies, context.userId, context.correlationId);
    },
    // Four at once is `@core/platform`'s own stated figure for this kind
    // ("`projection` is 1; `notification` is 4").
    { concurrency: 4, backoff: DEFAULT_DELIVERY_BACKOFF },
  );
}

/**
 * The drain, as a plain function so a test can call it without a job runner.
 *
 * Returns the number of rows it attempted, which is what a caller polling for
 * "is the outbox empty?" needs.
 */
export async function drainNotifications(
  dependencies: DeliveryJobDependencies,
  userId: string,
  correlationId: string,
): Promise<number> {
  const clock = dependencies.clock ?? systemClock;
  const batchSize = dependencies.batchSize ?? 25;
  const now = clock.now();

  const claimed = await claimDueNotifications(dependencies.database, now, batchSize);
  const mine = claimed.filter((row) => row.userId === userId);

  for (const row of mine) {
    const notificationsContext = {
      userId,
      clock,
      correlationId,
      causationId: null,
    };
    const attempt = row.attemptCount + 1;
    const startedAt = clock.now();

    const channel = await findChannel(dependencies.database, userId, row.channelId);
    if (channel === null || !channel.enabled) {
      // A channel that was disabled between the enqueue and the send. Not a
      // refusal — nothing was dialled — and not retryable, because the user
      // turning a channel off is a decision, not an outage.
      await dependencies.database.transaction(async (tx) => {
        const outcome = await markFailed(tx, notificationsContext, {
          notificationId: row.id,
          channelKind: channel?.kind ?? 'ntfy',
          attempt,
          maxAttempts: row.maxAttempts,
          outcome: 'permanent',
          refusalCode: null,
          httpStatus: null,
          detail: 'the channel is disabled or has been deleted',
          durationMs: 0,
          startedAt,
        });
        await appendFailure(tx, notificationsContext, row, {
          channelKind: channel?.kind ?? 'ntfy',
          attempt,
          outcome: 'permanent',
          refusalCode: null,
          dead: outcome.dead,
          nextAttemptAt: outcome.nextAttemptAt,
        });
      });
      continue;
    }

    const adapter = dependencies.registry[channel.kind];
    let result;
    try {
      // Opened here, used once, and unreachable again the moment this
      // iteration ends. Never cached across rows.
      const config = await openChannelConfig(channel, dependencies.secretBoxFor(userId));
      result = await adapter.send(notificationOf(row), config);
    } catch (error) {
      result = {
        outcome: 'retryable' as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const finishedAt = clock.now();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    await dependencies.database.transaction(async (tx) => {
      if (result.outcome === 'delivered') {
        await markDelivered(tx, notificationsContext, {
          notificationId: row.id,
          channelId: channel.id,
          channelKind: channel.kind,
          attempt,
          durationMs,
          httpStatus: result.httpStatus ?? null,
          startedAt,
        });
        await appendEvent(
          outboxOf(tx),
          NotificationDelivered.create(
            {
              notificationId: row.id,
              channelId: channel.id,
              channelKind: channel.kind,
              attempt,
              groupCount: row.groupCount,
              durationMs,
            },
            {
              userId,
              aggregateId: row.id,
              correlationId,
              causationId: null,
            },
            clock,
          ),
        );
        return;
      }

      const outcome = await markFailed(tx, notificationsContext, {
        notificationId: row.id,
        channelKind: channel.kind,
        attempt,
        maxAttempts: row.maxAttempts,
        outcome: result.outcome,
        refusalCode: result.refusalCode ?? null,
        httpStatus: result.httpStatus ?? null,
        detail: result.detail ?? null,
        durationMs,
        startedAt,
        // Spread rather than assigned: under `exactOptionalPropertyTypes` an
        // explicit `undefined` is not the same as an absent optional, and
        // `markFailed` defaults these only when they are absent.
        ...(dependencies.backoff === undefined ? {} : { backoff: dependencies.backoff }),
        ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
      });
      await appendFailure(tx, notificationsContext, row, {
        channelKind: channel.kind,
        attempt,
        outcome: result.outcome,
        refusalCode: result.refusalCode ?? null,
        dead: outcome.dead,
        nextAttemptAt: outcome.nextAttemptAt,
      });
    });
  }

  return mine.length;
}

async function appendFailure(
  tx: NotificationsExecutor,
  context: { readonly userId: string; readonly clock: Clock; readonly correlationId: string },
  row: NotificationOutboxRow,
  input: {
    readonly channelKind: 'ntfy' | 'smtp' | 'fake';
    readonly attempt: number;
    readonly outcome: 'retryable' | 'permanent' | 'refused';
    readonly refusalCode: string | null;
    readonly dead: boolean;
    readonly nextAttemptAt: Date | null;
  },
): Promise<void> {
  await appendEvent(
    outboxOf(tx) as Executor,
    NotificationFailed.create(
      {
        notificationId: row.id,
        channelId: row.channelId,
        channelKind: input.channelKind,
        attempt: input.attempt,
        outcome: input.outcome,
        refusalCode: input.refusalCode,
        dead: input.dead,
        nextAttemptAt: input.nextAttemptAt?.toISOString() ?? null,
      },
      {
        userId: context.userId,
        aggregateId: row.id,
        correlationId: context.correlationId,
        causationId: null,
      },
      context.clock,
    ),
  );
}

// ---------------------------------------------------------------------------
// The digest job
// ---------------------------------------------------------------------------

export interface DigestJobDependencies {
  readonly database: NotificationsDatabase;
  readonly clock?: Clock;
}

export function createDigestJob(dependencies: DigestJobDependencies): JobHandlerRegistration {
  return defineJob(
    DIGEST_JOB_KIND,
    async (_payload: unknown, context: JobContext) => {
      await closeDigestWindows(dependencies.database, context.userId, context.clock.now());
    },
    { concurrency: 1 },
  );
}

/**
 * Release every digest whose window has closed.
 *
 * Returns the ids it released, so a test can assert on *which* windows closed
 * rather than on a count that would also be satisfied by releasing the wrong
 * ones.
 */
export async function closeDigestWindows(
  executor: NotificationsExecutor,
  userId: string,
  now: Date,
): Promise<readonly string[]> {
  const result = await executor.execute<{ id: string }>(sql`
    UPDATE notification_outbox
    SET status = 'pending',
        held_reason = NULL,
        not_before = LEAST(not_before, ${now.toISOString()}::timestamptz),
        updated_at = ${now.toISOString()}::timestamptz
    WHERE user_id = ${userId}::uuid
      AND status = 'held'
      AND held_reason = 'digest_window'
      AND group_window_end <= ${now.toISOString()}::timestamptz
    RETURNING id
  `);
  return result.rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * Two schedules, in the **user's** zone (08 §3.7 — never the container's `TZ`).
 *
 * The drain runs every five minutes: a notification is not an interactive
 * request, and a tighter loop would mostly find an empty table. Digest windows
 * are closed hourly, which is fine granularity for a window measured in days
 * and is what lets a `DAILY` cadence land shortly after local midnight rather
 * than at whatever hour the worker happened to start.
 */
/**
 * `schedules.name` is constrained to `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`
 * (0003_platform.sql). A UUID carries hyphens, and a colon is not in the
 * alphabet at all, so the per-user suffix is the id with its hyphens turned
 * into underscores after a dot. The Phase 2 cold boot (wp2.w-wiring.md) found
 * the original `notifications.deliver:<uuid>` crash-looping the worker inside
 * `resolveModules()` on every real install — a defect no unit test could see,
 * because the fake scheduler never applied the constraint.
 */
export function scheduleNameFor(kind: 'deliver' | 'digest', userId: string): string {
  return `notifications.${kind}.${userId.toLowerCase().replaceAll('-', '_')}`;
}

export async function registerNotificationSchedules(
  executor: Executor,
  input: { readonly userId: string; readonly timezone: string },
  clock: Clock = systemClock,
): Promise<void> {
  await upsertSchedule(
    executor,
    {
      userId: input.userId,
      name: scheduleNameFor('deliver', input.userId),
      cron: '*/5 * * * *',
      timezone: input.timezone,
      jobKind: DELIVER_JOB_KIND,
      jitterSeconds: 30,
    },
    clock,
  );
  await upsertSchedule(
    executor,
    {
      userId: input.userId,
      name: scheduleNameFor('digest', input.userId),
      cron: '5 * * * *',
      timezone: input.timezone,
      jobKind: DIGEST_JOB_KIND,
      jitterSeconds: 60,
    },
    clock,
  );
}

/** A fresh correlation id for a drain that no request caused. */
export function backgroundCorrelationId(): string {
  return newId();
}
