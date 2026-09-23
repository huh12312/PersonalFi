// SPDX-License-Identifier: MIT
/**
 * The consumer: something changed today, so today's row is stale.
 *
 * Contexts write events and never call each other, so this is how the
 * snapshotter learns that a balance landed, a holding moved or a price refresh
 * finished. It does the smallest possible thing — marks the open day `dirty` —
 * and deliberately does **not** recompute inline.
 *
 * ## Why marking beats recomputing
 *
 * A single nightly sync produces one `ledger.BalanceRecorded` per account and a
 * price refresh produces one `integrations.PricesUpdated` per run. Recomputing
 * net worth inside each delivery would run the whole aggregate — every account,
 * every holding, an FX lookup each — a dozen times in ninety seconds to produce
 * a row that only the last run's value survives in. Marking is O(1) and the
 * 04:00 job (or the next explicit snapshot) does the work once.
 *
 * ## Why it never creates a row
 *
 * `markDirty` is an UPDATE. On an install where the day has no row yet there is
 * nothing to mark, and that is correct rather than a gap: the snapshotter
 * computes today unconditionally, so a day with no row is already going to be
 * computed from scratch. Inserting a placeholder so the flag had somewhere to
 * live would put a point on the chart asserting a net worth of zero, and a zero
 * that means "not computed yet" is exactly the class of lie this work package
 * exists to refuse.
 *
 * ## Idempotence
 *
 * Setting a boolean that is already set is the same as setting it once, and the
 * `AND NOT dirty` in the statement means a replay writes no rows at all. The
 * handler appends no event, so replaying the whole log produces no second
 * announcement of anything.
 *
 * ## Failure posture
 *
 * The handler runs inside the pump's transaction: a throw rolls back both the
 * mark and the offset, and the event is retried with backoff. Nothing here
 * catches, because there is no partial state to reconcile.
 */
import {
  registerConsumer,
  type ConsumerContext,
  type EventEnvelope,
  type RegisteredConsumer,
} from '@core/platform';
import { markDirty, type PlanningExecutor } from './store.ts';
import { openDateIn } from './seal.ts';

/**
 * The event types this consumer wants.
 *
 * Strings, not imports. `@ctx/planning` *may* import `@ctx/investments` (08 §1.6
 * points the arrow that way) but may not import `@ctx/integrations` or
 * `@ctx/ledger`'s event module, and mixing "imported constant" with "string
 * literal" in one filter list would make the inconsistency look like a decision.
 * An event type is a wire contract, like a URL; writing it out is the honest
 * cost of the decoupling the outbox exists to provide.
 *
 *   * `ledger.BalanceRecorded` — a cash, credit or loan account reported.
 *   * `investments.HoldingsUpdated` — a position's quantity moved.
 *   * `integrations.PricesUpdated` — a refresh landed, so quantity x price has
 *     a different answer even though no holding changed.
 */
export const CONSUMED_EVENT_TYPES = [
  'ledger.BalanceRecorded',
  'investments.HoldingsUpdated',
  'integrations.PricesUpdated',
] as const;

/**
 * The consumer name carries a version by convention (`registerConsumer`).
 * Changing what "dirty" means — or making this consumer do real work — means
 * bumping it and replaying from 0.
 */
export const CONSUMER_NAME = 'planning.net_worth@v1';

export interface PlanningConsumerOptions {
  /** IANA zone. "Today" is a local calendar day, never a UTC one (08 §3.5). */
  readonly timeZone: string;
}

export function createNetWorthConsumer(dependencies: {
  readonly database: PlanningExecutor;
  readonly options: PlanningConsumerOptions;
  /**
   * The pump's per-event transaction, when the composition root can supply one.
   * `apps/api`'s `drizzleTransactionalExecutor` makes this possible; see
   * `docs/evidence/phase-3/wp3.w-wiring.md` §4 for why `ConsumerContext.tx` is
   * not a Drizzle handle and what the wiring batch did about it. Absent, the
   * pool-backed handle in `database` is used and the mark is its own
   * transaction — which is safe here precisely because the handler writes one
   * boolean and appends no event.
   */
  readonly executorFor?: (context: ConsumerContext) => PlanningExecutor;
}): RegisteredConsumer {
  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const executor = dependencies.executorFor?.(context) ?? dependencies.database;
      const today = openDateIn(context.clock, dependencies.options.timeZone);

      const marked = await markDirty(executor, {
        userId: event.userId,
        asOfDate: today,
        clock: context.clock,
      });

      context.logger.info(
        {
          consumer: CONSUMER_NAME,
          eventType: event.eventType,
          asOfDate: today,
          marked,
        },
        marked > 0
          ? 'marked the open net-worth day dirty'
          : 'no open net-worth day to mark; the snapshotter computes it from scratch',
      );
    },
    { filter: [...CONSUMED_EVENT_TYPES] },
  );
}
