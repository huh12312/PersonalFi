// SPDX-License-Identifier: MIT
/**
 * The actuals consumer: ledger and categorisation facts in, envelopes recomputed.
 *
 * A consumer rather than a call from the sync path, for the reason
 * `@core/platform`'s header gives: "contexts write events, never call each
 * other". `@ctx/ledger` appends its event inside the same transaction as the
 * write; the pump delivers it here, exactly once, in order, with a replay
 * button.
 *
 * ## What it does with an event, and what it deliberately does not
 *
 * It **marks periods dirty and recomputes them**. It never applies a delta from
 * a payload. That is the difference between a read model that survives a replay
 * and one that does not: `recomputePeriod` is a deterministic function of
 * current state over a date window, so running it five times is identical to
 * running it once, and replaying the whole log from `seq = 0` rebuilds every
 * envelope from today's data rather than from a picture of the world as it was.
 * `@ctx/ledger`'s `events.ts` says the same thing from the publisher's side:
 * "Consumers … recompute a deterministic function of current state over the
 * affected window, which is what makes running them five times identical to
 * running them once."
 *
 * ## Which events, and why each one
 *
 * | Event | Why budgeting cares |
 * |---|---|
 * | `ledger.TransactionsUpserted` | new or changed spending in a date window |
 * | `ledger.TransactionSupersededByPosted` | pending → posted moves the amount and the date (tips, FX, fuel holds), and both are envelope inputs |
 * | `ledger.TransferPaired` | two rows just became invisible to every budget total; the periods they sat in are now wrong |
 * | `ledger.BalanceRecorded` | the right-hand side of the Ready-to-Assign identity moved |
 * | `categorization.AssignmentsChanged` | money moved between envelopes without any transaction changing |
 *
 * All five exist today with these exact names and payloads
 * (`packages/contexts/{ledger,categorization}/src/events.ts`); none had to be
 * added, and none is consumed speculatively.
 *
 * The types are written as **strings**, not imported from those packages, for
 * the reason `@ctx/categorization`'s consumer gives: importing them would be
 * importing another context and the boundary lint correctly refuses. An event
 * type is a wire contract, the same kind of thing as a URL, and duplicating the
 * string is the honest cost of the decoupling the outbox exists to provide.
 * `test/db/actuals-consumer.test.ts` publishes real envelopes and asserts this
 * consumer wakes, which is what keeps the two copies in step.
 *
 * ## Failure posture
 *
 * The handler runs inside the pump's transaction, so a throw rolls back the
 * recompute *and* the offset and the event is retried with backoff. That is the
 * right default here and, unlike in categorisation, there is no case that should
 * be swallowed: every error this can raise — an identity violation, an
 * unreported balance — is a statement that the budget does not add up, and a
 * budget that does not add up must stop rather than persist a number.
 *
 * The one thing that is *not* an error is an event for a user with no budget.
 * That is the normal state of the app before anybody opens the budget screen,
 * and it is a no-op.
 */
import { DateOnly, type DateOnly as DateOnlyType } from '@core/kernel';
import {
  hasLaterEvent,
  registerConsumer,
  type ConsumerContext,
  type EventEnvelope,
  type RegisteredConsumer,
} from '@core/platform';
import { and, eq } from 'drizzle-orm';
import { budgetPeriods, budgets } from '../schema/index.ts';
import type { BudgetingDatabase } from './db.ts';
import { isBudgetingError } from './errors.ts';
import type { LedgerPort } from './ledger-port.ts';
import { markDirtyFrom, recomputeDirty } from './service.ts';

export const CONSUMED_EVENT_TYPES = [
  'ledger.TransactionsUpserted',
  'ledger.TransactionSupersededByPosted',
  'ledger.TransferPaired',
  'ledger.BalanceRecorded',
  'categorization.AssignmentsChanged',
] as const;

/**
 * The consumer name carries a version by convention (`@core/platform`'s
 * `registerConsumer`): changing the cascade means bumping it and replaying from
 * 0, which rebuilds every envelope from the log and current state.
 */
export const CONSUMER_NAME = 'budgeting.actuals@v1';

interface UpsertedPayload {
  readonly dateFrom?: string | null;
  readonly dateTo?: string | null;
  readonly addedIds?: readonly string[];
  readonly updatedIds?: readonly string[];
  readonly removedIds?: readonly string[];
}

interface SupersededPayload {
  readonly transactionId?: string;
}

interface TransferPairedPayload {
  readonly outflowTransactionId?: string;
  readonly inflowTransactionId?: string;
}

interface AssignmentsChangedPayload {
  readonly transactionIds?: readonly string[];
}

/** The transaction ids an envelope names, when it names any. */
export function transactionIdsOf(event: EventEnvelope): readonly string[] {
  switch (event.eventType) {
    case 'ledger.TransactionsUpserted': {
      const payload = event.payload as UpsertedPayload;
      // Removed ids are included here, unlike in categorisation: a tombstoned
      // row must *stop* counting towards an envelope, and the period it used to
      // sit in is exactly the one that now holds a stale total.
      return [
        ...(payload.addedIds ?? []),
        ...(payload.updatedIds ?? []),
        ...(payload.removedIds ?? []),
      ];
    }
    case 'ledger.TransactionSupersededByPosted': {
      const payload = event.payload as SupersededPayload;
      return payload.transactionId === undefined ? [] : [payload.transactionId];
    }
    case 'ledger.TransferPaired': {
      const payload = event.payload as TransferPairedPayload;
      return [payload.outflowTransactionId, payload.inflowTransactionId].filter(
        (id): id is string => typeof id === 'string',
      );
    }
    case 'categorization.AssignmentsChanged': {
      const payload = event.payload as AssignmentsChangedPayload;
      return payload.transactionIds ?? [];
    }
    default:
      return [];
  }
}

/**
 * The earliest date this event can have changed anything on.
 *
 * `TransactionsUpserted` carries its own window and is the cheap path — it is
 * also the hot one, since a sync page emits it. Everything else names ids, and
 * the port is asked for their dates rather than guessing a window: a guess that
 * is too narrow loses money silently, and a guess that is too wide re-derives a
 * year of history on every page. `BalanceRecorded` names no transaction at all
 * and moves only the identity's right-hand side, so it dirties the periods a
 * balance can still affect — which is all of them from the earliest open one
 * forward, expressed as `null`.
 */
async function earliestAffectedDate(
  event: EventEnvelope,
  port: LedgerPort,
  userId: string,
): Promise<DateOnlyType | null> {
  if (event.eventType === 'ledger.BalanceRecorded') return null;

  if (event.eventType === 'ledger.TransactionsUpserted') {
    const payload = event.payload as UpsertedPayload;
    if (typeof payload.dateFrom === 'string' && DateOnly.is(payload.dateFrom)) {
      return DateOnly.parse(payload.dateFrom);
    }
  }

  const ids = new Set(transactionIdsOf(event));
  if (ids.size === 0) return null;

  // A bounded look-back rather than an unbounded scan. 24 months is the seed
  // generator's whole history and comfortably more than any provider backfill
  // window; a row older than that arriving late is a manual import, and the
  // fallback of `null` (dirty everything) is the correct answer for it.
  const today = DateOnly.fromEpochDay(Math.floor(event.occurredAt.getTime() / 86_400_000));
  const from = DateOnly.addMonths(today, -24);
  const to = DateOnly.addDays(today, 400);

  let earliest: DateOnlyType | null = null;
  let cursor: string | null = null;
  do {
    const page = await port.listForBudget({
      userId,
      dateFrom: from,
      dateTo: to,
      cursor,
      limit: 500,
    });
    for (const row of page.items) {
      if (!ids.has(row.id)) continue;
      if (earliest === null || DateOnly.isBefore(row.budgetDate, earliest)) {
        earliest = row.budgetDate;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  return earliest;
}

export function createBudgetingConsumer(dependencies: {
  readonly database: BudgetingDatabase;
  readonly port: LedgerPort;
}): RegisteredConsumer {
  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const userBudgets = await dependencies.database
        .select({ id: budgets.id })
        .from(budgets)
        .where(and(eq(budgets.userId, event.userId)));
      // No budget yet is the normal state of a fresh install, not an error.
      if (userBudgets.length === 0) return;

      const date = await earliestAffectedDate(event, dependencies.port, event.userId);

      const budgetingContext = {
        userId: event.userId,
        clock: context.clock,
        // The sync run's correlation id flows straight through, so one id spans
        // the browser request, the sync, the categorisation and the envelope it
        // moved.
        correlationId: event.correlationId,
        causationId: event.id,
      };

      // P-4 (WP 9.14): the recompute is a deterministic function of current state, so after event 1 of a
      // backlog of thousands every later recompute but the last is thrown away. Every event still marks its
      // periods dirty in its own transaction (a retry, a crash or a replay loses nothing); only the recompute
      // is left to the final event of THIS holder's backlog. `domain_events` is the platform's table.
      const backlog = await hasLaterEvent(context.tx, {
        afterSeq: event.seq,
        userId: event.userId,
        eventTypes: CONSUMED_EVENT_TYPES,
      });

      for (const budget of userBudgets) {
        // One transaction per budget, opened on this context's own pool handle
        // rather than on `context.tx`. The pump's handle is `@core/platform`'s
        // narrow `Executor` — a single `execute` — and the cascade is built out
        // of Drizzle query builders, which it cannot carry. That is the same
        // trade `@ctx/categorization`'s consumer makes, and the consequence is
        // worth stating plainly: the recompute is atomic with the events it
        // appends, so no threshold crossing is ever announced for a rolled-back
        // recompute, but it is *not* atomic with the offset advance. A crash in
        // the gap replays the event, and the cascade is idempotent by
        // construction — it recomputes a function of current state — so a
        // replay re-derives exactly the same envelopes.
        await dependencies.database.transaction(async (tx) => {
          if (date === null) {
            await tx
              .update(budgetPeriods)
              .set({ dirty: true, updatedAt: context.clock.now() })
              .where(
                and(eq(budgetPeriods.budgetId, budget.id), eq(budgetPeriods.userId, event.userId)),
              );
          } else {
            await markDirtyFrom(tx, budgetingContext, { budgetId: budget.id, date });
          }
          // A later event for this holder is waiting: it will recompute what this one dirtied.
          if (backlog) return;
          // G-23 / F-94-5 (WP 9.11): an on-budget account with no balance
          // observation yet (a freshly linked institution) is "not yet", not a
          // poison event. The recompute runs in a savepoint; that one refusal
          // rolls it back and leaves the periods marked dirty above, so the
          // next event — or the balance itself, `ledger.BalanceRecorded` —
          // recomputes them. At HEAD it threw, five retries dead-lettered the
          // consumer, and nothing but SQL brought it back.
          try {
            await tx.transaction(async (savepoint) => {
              await recomputeDirty(
                savepoint,
                budgetingContext,
                { port: dependencies.port },
                budget.id,
              );
            });
          } catch (error) {
            if (!(isBudgetingError(error) && error.code === 'budgeting.balance_unreported')) {
              throw error;
            }
          }
        });
      }
    },
    { filter: CONSUMED_EVENT_TYPES },
  );
}
