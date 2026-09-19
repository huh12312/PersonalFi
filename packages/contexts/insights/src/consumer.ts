// SPDX-License-Identifier: MIT
/**
 * The consumer: something the advice depends on changed, so re-run the advisors
 * that said they care.
 *
 * Contexts write events and never call each other (`@core/platform`'s header),
 * so this is how the insight feed learns that a budget line went over, a price
 * changed, or a page of transactions landed. The pump delivers each event once,
 * in order, inside its own transaction, with a replay button.
 *
 * ## The filter is derived from the registry, not hardcoded
 *
 * An advisor's manifest declares its triggers. The consumer's filter is the
 * union of every registered advisor's declared event types, plus the small
 * fixed set below that is structural rather than per-advisor.
 *
 * That inversion matters: adding an advisor in WP 2.7 that wants to hear about
 * `budgeting.ThresholdCrossed` should not require editing this file. It also
 * means the filter is *narrow* — if no advisor asks for an event type, the pump
 * never wakes this consumer for it at all.
 *
 * ## Event types are strings, deliberately
 *
 * Importing `@ctx/budgeting`'s `events.ts` would be importing another context
 * and the boundary lint refuses. An event type is a wire contract, like a URL,
 * and duplicating it is the honest cost of the decoupling the outbox exists to
 * provide.
 *
 * ## Why the handler does not run the advisors inline
 *
 * The handler runs inside the pump's transaction. An advisor run takes up to
 * five minutes and does its own two-transaction dance (`service.ts`), so doing
 * it here would hold the consumer's transaction open across an untrusted call
 * and stall every event behind it. So the consumer **enqueues a job** — durable,
 * `FOR UPDATE SKIP LOCKED`, visible in queue health — and returns.
 *
 * The consequence worth naming: a burst of events produces a burst of jobs, and
 * an advisor re-run per transaction page is exactly the quadratic shape
 * `@ctx/recurring`'s consumer header warns about. The `dedupeKey` on the
 * enqueue is what prevents it — one pending `insights.run` per (advisor,
 * trigger) at a time, so two thousand transactions arriving in a backfill
 * produce one run, not two thousand. That is the same sentence 08 §4.5 makes
 * about notification digests, one layer up.
 *
 * ## Idempotence
 *
 * A run is a deterministic function of current state and upserts what it finds,
 * so delivering an event twice — a replay, a retry after a crash between the
 * work and the offset — enqueues a job that produces the same rows and appends
 * no second `InsightProposed` (the event is emitted from the insert branch of
 * the upsert only). Nothing here catches: a throw rolls back both the enqueue
 * and the offset, and the event is retried with backoff.
 */
import {
  enqueueJob,
  registerConsumer,
  type ConsumerContext,
  type EventEnvelope,
  type RegisteredConsumer,
} from '@core/platform';
import { RUN_JOB_KIND, type RunJobPayload } from './jobs.ts';
import type { AdvisorRegistry } from './registry.ts';

/**
 * The event types this consumer always wants, whatever any manifest says.
 *
 * `ledger.TransactionsUpserted` is here because it is the event that changes
 * *every* block of the snapshot at once — balances, cashflow, the category
 * summary, the raw rows — so an advisor that declared no trigger at all still
 * has a stale view after one. The rest are the two contexts whose read models
 * feed dedicated snapshot blocks.
 */
export const BASE_EVENT_TYPES = [
  'ledger.TransactionsUpserted',
  'budgeting.ThresholdCrossed',
  'budgeting.PeriodRolled',
  'recurring.PriceChangeDetected',
  'recurring.SeriesConfirmed',
  'recurring.SeriesLapsed',
  'recurring.DuplicateServiceDetected',
] as const;

/**
 * The consumer name carries a version by convention (`registerConsumer`).
 *
 * Bumping it and replaying from 0 re-enqueues a run per historical event, which
 * is safe — the upsert is idempotent and the cooldown ladder lives in
 * `insight_dismissals` rather than in the derived rows, so a replay does not
 * re-offer one single thing the user has already refused.
 */
export const CONSUMER_NAME = 'insights.advisors@v1';

export interface InsightsConsumerOptions {
  /**
   * Advisors to run for an event no manifest claimed, or `[]` for none.
   *
   * The honest default is `[]`: an advisor that did not declare a trigger did
   * not ask to be woken. This exists for the operator who wants a catch-all
   * during a migration and wants it to be visible configuration rather than a
   * behaviour.
   */
  readonly fallbackAdvisorIds?: readonly string[];
}

/** The advisors this event should wake. Manifest-declared, plus the fallback. */
export function advisorsForEvent(
  registry: AdvisorRegistry,
  eventType: string,
  options: InsightsConsumerOptions = {},
): readonly string[] {
  const declared = registry.triggeredBy(eventType).map((entry) => entry.manifest.advisor_id);
  if (declared.length > 0) return declared;
  return options.fallbackAdvisorIds ?? [];
}

export function createInsightsConsumer(dependencies: {
  readonly registry: AdvisorRegistry;
  readonly options?: InsightsConsumerOptions;
}): RegisteredConsumer {
  const options = dependencies.options ?? {};
  // The union, computed once at registration. A manifest cannot be edited
  // without restarting the process that registered it, so recomputing per event
  // would buy nothing and would make the filter depend on mutable state.
  const filter = [
    ...new Set<string>([...BASE_EVENT_TYPES, ...dependencies.registry.eventTypes()]),
  ].sort();

  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const advisorIds = advisorsForEvent(dependencies.registry, event.eventType, options);
      if (advisorIds.length === 0) return;

      for (const advisorId of advisorIds) {
        const payload: RunJobPayload = {
          advisorId,
          trigger: 'event',
          triggerEventType: event.eventType,
        };
        // `context.tx` and not the pool: the enqueue must commit with the
        // offset advance. Enqueuing on the pool would leave a queued run
        // behind after a handler failure rolled the offset back, and the
        // retry would enqueue a second one.
        await enqueueJob(context.tx, {
          kind: RUN_JOB_KIND,
          userId: event.userId,
          payload,
          // One pending run per advisor at a time. A backfill of two thousand
          // transactions therefore produces one job per advisor, not two
          // thousand — the run reads current state, so the second enqueue would
          // have computed exactly what the first one is about to.
          dedupeKey: `${RUN_JOB_KIND}:${advisorId}`,
          correlationId: event.correlationId,
          causationEventId: event.id,
        });
      }

      context.logger.info(
        {
          consumer: CONSUMER_NAME,
          eventType: event.eventType,
          advisors: advisorIds.length,
        },
        'queued advisor runs',
      );
    },
    { filter },
  );
}
