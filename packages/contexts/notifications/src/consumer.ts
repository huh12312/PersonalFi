// SPDX-License-Identifier: MIT
/**
 * The rules consumer: events in, outbox rows out.
 *
 * A consumer rather than a call from the publishing context, for the reason
 * `@core/platform`'s header gives: "contexts write events, never call each
 * other". `@ctx/budgeting` appends `BudgetThresholdCrossed` inside the same
 * transaction as its recompute; the pump delivers it here, exactly once, in
 * order, with a replay button.
 *
 * ## What it does, and what it deliberately does not
 *
 * It **writes to the outbox and stops.** It never opens a socket. Delivery is
 * the job's business, for three reasons that all matter here: the pump's
 * transaction must not be held open across a network call to somebody else's
 * mail server; a failed send must not roll back the consumer offset and replay
 * the event; and an SMTP connection that hangs must not stall every other
 * consumer behind it.
 *
 * ## Replay safety
 *
 * A replay from `seq = 0` re-delivers every envelope. The dedupe key is derived
 * from the *fact* — `(period, line, threshold)`, not the event id — so the
 * second delivery collides with the row the first one wrote, `xmax` is
 * non-zero, `coalesced` is true, and no `NotificationQueued` is appended. The
 * user is not notified twice about a replay, which is what "idempotent via
 * dedupeKey" (08 §4.5) buys.
 *
 * ## Which events, and why each one
 *
 * | Event | Why notifications cares |
 * |---|---|
 * | `budgeting.BudgetThresholdCrossed` | the one alert 07 §1.9 calls hard |
 * | `recurring.PriceChangeDetected` | 04 §5.1's changepoint, with its annual impact already computed so a rule can threshold it without re-reading |
 * | `connections.ConnectionStatusChanged` | "silent data staleness is the worst failure mode in a finance app" — that context's own words |
 * | `connections.SyncRunCompleted` | a failed run that nobody sees is the same staleness by another door |
 * | `insights.InsightProposed` | WP 2.6's, not yet registered — see `render.ts` |
 *
 * ## Failure posture
 *
 * The handler runs inside the pump's transaction, so a throw rolls back the
 * enqueue *and* the offset and the event is retried with backoff. That is right
 * here: every error this can raise is either a malformed rule (which the user
 * must fix) or a database problem, and neither is a reason to silently drop a
 * notification. The one thing that is not an error is an event for a user with
 * no matching rule — the normal state of the app before anybody opens the
 * notification settings screen, and a no-op.
 */
import {
  registerConsumer,
  appendEvent,
  type ConsumerContext,
  type EventEnvelope,
  type RegisteredConsumer,
} from '@core/platform';
import { matchesConditions, type Conditions } from './conditions.ts';
import { outboxOf, type NotificationsDatabase } from './db.ts';
import { NotificationQueued } from './events.ts';
import { enqueueNotification } from './outbox.ts';
import { CONSUMED_EVENT_TYPES, renderNotification } from './render.ts';
import { rulesForEvent } from './service.ts';
import { digestWindowFor, isQuietAt, quietHoursReleaseAt, type QuietHours } from './time.ts';
import type { HeldReason } from '../schema/index.ts';

export { CONSUMED_EVENT_TYPES };

/**
 * The consumer name carries a version by convention
 * (`@core/platform`'s `registerConsumer`): changing how an event becomes a
 * notification means bumping it and replaying from 0, which re-derives the
 * outbox from the log and today's rules.
 */
export const CONSUMER_NAME = 'notifications.rules@v1';

export interface NotificationsConsumerDependencies {
  readonly database: NotificationsDatabase;
}

export function createNotificationsConsumer(
  dependencies: NotificationsConsumerDependencies,
): RegisteredConsumer {
  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const rendered = renderNotification(
        event.eventType,
        (event.payload ?? {}) as Record<string, unknown>,
      );
      // Not every instance of a subscribed type is news: a connection going
      // back to `active` and a sync that succeeded are both deliberately
      // silent.
      if (rendered === null) return;

      const matches = await rulesForEvent(dependencies.database, event.userId, event.eventType);
      // No channel, or no rule: the normal state of a fresh install.
      if (matches.length === 0) return;

      const now = context.clock.now();

      for (const { rule } of matches) {
        if (!matchesConditions(event.payload, rule.conditions as Conditions)) continue;

        const quiet: QuietHours = {
          enabled: rule.quietHoursEnabled,
          timeZone: rule.timezone,
          startMinute: rule.quietHoursStartMinute,
          endMinute: rule.quietHoursEndMinute,
        };

        let notBefore = now;
        let heldReason: HeldReason | null = null;
        let groupKey: string | null = null;
        let groupWindow = null as ReturnType<typeof digestWindowFor> | null;

        if (rule.deliveryClass === 'DIGEST') {
          // The window's *end* is when the digest may be sent, which is what
          // makes a coalescing window a window rather than a hope.
          groupKey = rendered.groupKey;
          groupWindow = digestWindowFor(now, rule.timezone, rule.digestCadence ?? 'WEEKLY');
          notBefore = groupWindow.end;
          heldReason = 'digest_window';
        } else if (rule.deliveryClass === 'PROMPT' && isQuietAt(now, quiet)) {
          // Held, never dropped. `not_before` is the next instant the wall
          // clock reads the window's end in the user's zone — not "now plus
          // the remaining minutes", which is an hour wrong twice a year.
          notBefore = quietHoursReleaseAt(now, quiet);
          heldReason = 'quiet_hours';
        }

        const notificationsContext = {
          userId: event.userId,
          clock: context.clock,
          correlationId: event.correlationId,
          causationId: event.id,
        };

        // One transaction per rule, opened on this context's own handle rather
        // than on `context.tx`: the pump's handle is `@core/platform`'s narrow
        // `Executor` (a single `execute`) and cannot carry a Drizzle query
        // builder. Same trade `@ctx/budgeting`'s consumer makes, with the same
        // consequence — the enqueue is atomic with the event it appends, but
        // not with the offset advance. A crash in the gap replays the event,
        // and the dedupe key makes the replay a no-op.
        await dependencies.database.transaction(async (tx) => {
          const result = await enqueueNotification(tx, notificationsContext, {
            channelId: rule.channelId,
            ruleId: rule.id,
            dedupeKey: rendered.dedupeKey,
            groupKey,
            groupWindow,
            deliveryClass: rule.deliveryClass,
            priority: rendered.priority,
            title: rendered.title,
            bodyMd: rendered.bodyMd,
            deepLink: rendered.deepLink,
            actions: [],
            notBefore,
            heldReason,
            sourceEventId: event.id,
            sourceEventType: event.eventType,
          });

          // Announced on the insert only. A coalesced fact is not a new
          // notification, and a 2,000-transaction backfill therefore produces
          // one of these rather than 2,000.
          if (result.coalesced) return;

          const channel = matches.find((match) => match.rule.id === rule.id)?.channel;
          await appendEvent(
            outboxOf(tx),
            NotificationQueued.create(
              {
                notificationId: result.id,
                channelId: rule.channelId,
                ruleId: rule.id,
                channelKind: channel?.kind ?? 'ntfy',
                deliveryClass: rule.deliveryClass,
                coalesced: false,
                groupCount: result.groupCount,
                heldUntil: heldReason === null ? null : notBefore.toISOString(),
                heldReason,
                sourceEventType: event.eventType,
              },
              {
                userId: event.userId,
                aggregateId: result.id,
                correlationId: event.correlationId,
                causationId: event.id,
              },
              context.clock,
            ),
          );
        });
      }
    },
    { filter: CONSUMED_EVENT_TYPES },
  );
}
