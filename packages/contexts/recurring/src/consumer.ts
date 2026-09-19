// SPDX-License-Identifier: MIT
/**
 * The consumer: transactions changed, so re-detect — for the touched payees only.
 *
 * Contexts write events and never call each other (`@core/platform`'s header),
 * so this is how detection learns that a sync landed. The pump delivers each
 * event once, in order, inside its own transaction, with a replay button.
 *
 * ## Why the scope is merchants and not transactions
 *
 * The events name *transactions*. Detection's unit is a *stream*, and a stream
 * is every transaction this user has ever had with one payee — so re-detecting
 * "the transactions in this page" is meaningless: three new charges tell you
 * nothing about a cadence without the twenty before them.
 *
 * The naive fix (re-detect everything on every page) is a full-history scan per
 * sync page, and a sync of six months across four accounts is dozens of pages.
 * So the consumer asks the port one question — `merchantsOf(transactionIds)` —
 * and re-runs detection scoped to the handful of payees that page touched. The
 * *history* read for those payees is still complete; only the payee set is
 * narrowed. That is the difference between a bounded amount of work per page
 * and a quadratic one.
 *
 * Ids whose merchant identity the ledger refused (`bank_operation`,
 * `self_transfer`, …) contribute no merchant and therefore no work, which is
 * decision D25 paying for itself: the rows that would have been most expensive
 * to group are the ones that are not a payee at all.
 *
 * ## Idempotence
 *
 * `runDetection` is a deterministic function of current state and writes only
 * what differs, so delivering this event twice — a replay, a retry after a
 * crash between the work and the offset — produces the same rows and appends no
 * second event. `test/db/idempotence.test.ts` asserts exactly that, comparing
 * whole rows and the `domain_events` count.
 *
 * ## Failure posture
 *
 * The handler runs inside the pump's transaction: a throw rolls back both the
 * detection *and* the offset, and the event is retried with backoff. There is
 * no partial state to reconcile, which is why nothing here catches. An event
 * that names no merchants returns early and advances the offset — that is not a
 * failure, it is a page of internal transfers.
 */
import {
  registerConsumer,
  type ConsumerContext,
  type EventEnvelope,
  type RegisteredConsumer,
} from '@core/platform';
import { runDetection, type DetectionRunInput, type RecurringDependencies } from './service.ts';
import type { RecurringDatabase } from './store.ts';

/**
 * The event types this consumer wants.
 *
 * Strings, not imports: importing `@ctx/ledger`'s `events.ts` is importing
 * another context and the boundary lint refuses. An event type is a wire
 * contract, like a URL, and duplicating it is the honest cost of the decoupling
 * the outbox exists to provide.
 *
 * `categorization.AssignmentsChanged` is here for one reason worth stating:
 * `subscription_metadata.merchant_class` feeds the engine's `merchant_prior`
 * and its suppression rules, and a recategorisation is the most common way that
 * fact changes. A mortgage the user just moved into "Housing/Loan" should stop
 * being offered as a subscription on the next pass, not on the next sync.
 */
export const CONSUMED_EVENT_TYPES = [
  'ledger.TransactionsUpserted',
  'ledger.TransactionSupersededByPosted',
  'categorization.AssignmentsChanged',
] as const;

/**
 * The consumer name carries a version by convention (`registerConsumer`):
 * changing what detection concludes means bumping it and replaying from 0,
 * which rebuilds every series from the log and current state — and, because a
 * rejection lives in `recurring_candidates` rather than in the derived rows,
 * without re-proposing one single thing the user has already refused.
 */
export const CONSUMER_NAME = 'recurring.detection@v1';

interface UpsertedPayload {
  readonly addedIds?: readonly string[];
  readonly updatedIds?: readonly string[];
  readonly removedIds?: readonly string[];
}

interface SupersededPayload {
  readonly transactionId?: string;
}

interface AssignmentsPayload {
  readonly transactionIds?: readonly string[];
}

/**
 * The transaction ids in an envelope whose payees are worth re-detecting.
 *
 * `removedIds` **are** included, unlike in `@ctx/categorization`'s equivalent,
 * and the difference is not an oversight. A tombstoned transaction should keep
 * its category — that is a decision about *that row*. A tombstoned occurrence
 * changes a *stream*: it is one fewer hit on the schedule, which moves the
 * cadence score, the coverage and possibly the dormancy rung. Leaving the payee
 * out of the scope would leave a series quietly asserting an occurrence the
 * ledger no longer has.
 */
export function transactionIdsOf(event: EventEnvelope): readonly string[] {
  switch (event.eventType) {
    case 'ledger.TransactionsUpserted': {
      const payload = event.payload as UpsertedPayload;
      return [
        ...(payload.addedIds ?? []),
        ...(payload.updatedIds ?? []),
        ...(payload.removedIds ?? []),
      ];
    }
    case 'ledger.TransactionSupersededByPosted': {
      const payload = event.payload as SupersededPayload;
      // Pending → posted keeps the id (D10) but the amount and date commonly
      // move, and both are what a cadence and an amount model are made of.
      return payload.transactionId === undefined ? [] : [payload.transactionId];
    }
    case 'categorization.AssignmentsChanged': {
      const payload = event.payload as AssignmentsPayload;
      return payload.transactionIds ?? [];
    }
    default:
      return [];
  }
}

export interface RecurringConsumerOptions {
  readonly timeZone: string;
  readonly historyDays?: number;
  readonly subscriptionMonthlyCeilingMajor?: bigint;
}

export function createRecurringConsumer(dependencies: {
  readonly database: RecurringDatabase;
  readonly port: RecurringDependencies['port'];
  readonly options: RecurringConsumerOptions;
}): RegisteredConsumer {
  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const transactionIds = transactionIdsOf(event);
      if (transactionIds.length === 0) return;

      const merchantIds = await dependencies.port.merchantsOf({
        userId: event.userId,
        transactionIds,
      });
      // A page of transfers, fees and ATM withdrawals names no payee. That is
      // the D25 gate doing its job, not an empty result to log about.
      if (merchantIds.length === 0) return;

      const input: DetectionRunInput = {
        timeZone: dependencies.options.timeZone,
        merchantIds,
        ...(dependencies.options.historyDays === undefined
          ? {}
          : { historyDays: dependencies.options.historyDays }),
        ...(dependencies.options.subscriptionMonthlyCeilingMajor === undefined
          ? {}
          : {
              subscriptionMonthlyCeilingMajor: dependencies.options.subscriptionMonthlyCeilingMajor,
            }),
      };

      const result = await runDetection(
        dependencies.database,
        {
          userId: event.userId,
          clock: context.clock,
          // The sync run's correlation id flows straight through, so one id
          // spans the browser request, the sync, and every series it caused.
          correlationId: event.correlationId,
          causationId: event.id,
        },
        { port: dependencies.port },
        input,
      );

      context.logger.info(
        {
          consumer: CONSUMER_NAME,
          eventType: event.eventType,
          merchants: merchantIds.length,
          inputs: result.inputs,
          streams: result.streams,
          seriesInserted: result.seriesInserted,
          seriesChanged: result.seriesChanged,
          seriesArchived: result.seriesArchived,
          candidatesProposed: result.candidatesProposed,
          lapsed: result.lapsed,
          priceChanges: result.priceChanges,
        },
        'ran recurring detection',
      );
    },
    { filter: [...CONSUMED_EVENT_TYPES] },
  );
}
