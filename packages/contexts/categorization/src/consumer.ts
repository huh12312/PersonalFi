// SPDX-License-Identifier: MIT
/**
 * The consumer: `ledger.TransactionsUpserted` in, categories out.
 *
 * This is the only place categorisation happens automatically, and it is a
 * consumer rather than a call from the sync path for the reason `@core/platform`'s
 * header gives: "contexts write events, never call each other". `@ctx/ledger`
 * appends the event inside the same transaction as the write; the pump delivers
 * it here, exactly once, in order, with a replay button.
 *
 * ## Why the payload's ids are not simply trusted
 *
 * They are used as a *filter*, and the rows are re-read through the port. The
 * event carries ids and counts by design, and re-reading is what makes a replay
 * meaningful — a consumer that categorised from a payload snapshot would, on
 * replay, recategorise from a picture of the world as it was, ignoring every
 * correction the user has made since.
 *
 * ## Failure posture
 *
 * The handler runs inside the pump's transaction, so a throw rolls back the
 * assignments *and* the offset, and the event is retried with backoff. That is
 * the right default. What must not happen is a permanent dead-letter caused by
 * one malformed rule or one transaction the port cannot find, so both of those
 * are handled without throwing: a rule that fails validation is skipped and
 * logged once per batch (`loadRules`), and an id in the payload that the port
 * does not return simply is not categorised. A genuine database failure still
 * throws, and should.
 */
import { registerConsumer, type ConsumerContext, type EventEnvelope, type RegisteredConsumer } from '@core/platform';
import type { CategorizationDatabase } from './db.ts';
import type { LedgerPort } from './ledger-port.ts';
import { categorizeTransactions, type CategorizeOptions } from './service.ts';

/**
 * The event types this consumer wants.
 *
 * Named as strings rather than imported from `@ctx/ledger`'s `events.ts`, because
 * importing that module is importing another context and the boundary lint
 * (correctly) refuses. An event type is a wire contract — the same kind of thing
 * as a URL — and duplicating the string is the honest cost of the decoupling the
 * outbox exists to provide. `consumer.test.ts` publishes a real
 * `ledger.TransactionsUpserted` envelope and asserts this consumer wakes, which
 * is what keeps the two strings in step.
 */
export const CONSUMED_EVENT_TYPES = [
  'ledger.TransactionsUpserted',
  'ledger.TransactionSupersededByPosted',
] as const;

/**
 * The consumer name carries a version by convention (`@core/platform`'s
 * `registerConsumer`): changing the logic means bumping it and replaying from 0,
 * which rebuilds every assignment from the log and current state.
 */
export const CONSUMER_NAME = 'categorization.assignments@v1';

interface UpsertedPayload {
  readonly addedIds?: readonly string[];
  readonly updatedIds?: readonly string[];
  readonly removedIds?: readonly string[];
}

interface SupersededPayload {
  readonly transactionId?: string;
  readonly amountChanged?: boolean;
  readonly dateChanged?: boolean;
}

/** The ids in an envelope that are worth (re)deciding. */
export function transactionIdsOf(event: EventEnvelope): readonly string[] {
  if (event.eventType === 'ledger.TransactionsUpserted') {
    const payload = event.payload as UpsertedPayload;
    // Removed ids are excluded: a tombstoned transaction should keep whatever
    // category it had — `removed[]` and the `added[]` that supersedes it are not
    // ordered relative to each other (@ctx/ledger's own note), so discarding the
    // decision here would lose work a later page is about to reclaim.
    return [...(payload.addedIds ?? []), ...(payload.updatedIds ?? [])];
  }

  if (event.eventType === 'ledger.TransactionSupersededByPosted') {
    const payload = event.payload as SupersededPayload;
    if (payload.transactionId === undefined) return [];
    // Pending → posted keeps the transaction id (decision D10) but the amount
    // and date commonly move — tips, FX, fuel holds — and both are engine
    // inputs. Re-deciding is cheap and skipping it leaves a category that was
    // chosen for a number that is no longer true.
    return [payload.transactionId];
  }

  return [];
}

export function createCategorizationConsumer(dependencies: {
  readonly database: CategorizationDatabase;
  readonly port: LedgerPort;
  readonly options?: CategorizeOptions;
}): RegisteredConsumer {
  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const transactionIds = transactionIdsOf(event);
      if (transactionIds.length === 0) return;

      const result = await categorizeTransactions(
        dependencies.database,
        dependencies.port,
        { transactionIds },
        {
          userId: event.userId,
          clock: context.clock,
          // The sync run's correlation id flows straight through, so one id spans
          // the browser request, the sync, and every category it caused.
          correlationId: event.correlationId,
          causationId: event.id,
        },
        { ...dependencies.options, trigger: 'sync' },
      );

      context.logger.info(
        {
          consumer: CONSUMER_NAME,
          eventType: event.eventType,
          considered: result.considered,
          written: result.written,
          skipped: result.skipped,
          bySource: result.bySource,
        },
        'categorised transactions',
      );
    },
    { filter: [...CONSUMED_EVENT_TYPES] },
  );
}
