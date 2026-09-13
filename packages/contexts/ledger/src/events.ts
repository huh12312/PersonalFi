// SPDX-License-Identifier: MIT
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';

/**
 * Every fact the Ledger states.
 *
 * Ledger is the gravitational centre of the app and it talks to nobody. Budgeting,
 * Recurring, Insights and Notifications all need to react to new transactions; if
 * Ledger called them it would depend on everything, the boundary lint would refuse
 * the import cycle, and a crash between the write and the call would lose the work
 * entirely. So Ledger appends an event inside the same transaction as the write
 * and stops (08 §3.1, decision D7).
 *
 * **Payloads are ids and counts, never rows.** A fat payload makes the log big,
 * makes a replay resurrect a stale snapshot instead of reflecting today's data,
 * and quietly becomes a second copy of the record that will drift from the first.
 * A consumer that wants the transactions re-reads them through this context's
 * reader, which is also how it gets whatever the user has since changed.
 */

const uuid = z.uuid();

export const AccountUpserted = defineEvent({
  type: 'ledger.AccountUpserted',
  aggregateType: 'account',
  description:
    'An account appeared or its provider metadata changed. Carries what changed by name, not the ' +
    'values: a consumer that cares re-reads through listAccounts(). `created` distinguishes the ' +
    'first sighting, which is the one a connections UI wants to celebrate and a net-worth ' +
    'backfill wants to trigger.',
  schema: z.object({
    accountId: uuid,
    connectionId: uuid.nullable(),
    provider: z.string().min(1),
    created: z.boolean(),
    changedFields: z.array(z.string()),
  }),
});

export const BalanceRecorded = defineEvent({
  type: 'ledger.BalanceRecorded',
  aggregateType: 'account',
  description:
    'A point-in-time balance observation was appended. `asOf` and `source` are in the payload ' +
    'because staleness is the fact a consumer reacts to — the net-worth snapshotter needs to know ' +
    'a figure is new, not what it is. The amount is not, for the usual payload-discipline reason.',
  schema: z.object({
    accountId: uuid,
    balanceId: uuid,
    asOf: z.iso.datetime(),
    source: z.enum(['provider', 'manual', 'derived']),
  }),
});

export const TransactionsUpserted = defineEvent({
  type: 'ledger.TransactionsUpserted',
  aggregateType: 'account',
  description:
    'A sync page landed. Ids and counts only. Consumers (Budgeting actuals, Recurring detection, ' +
    'Insights) recompute a deterministic function of current state over the affected window, ' +
    'which is what makes running them five times identical to running them once.',
  schema: z.object({
    accountId: uuid,
    addedIds: z.array(uuid),
    updatedIds: z.array(uuid),
    removedIds: z.array(uuid),
    /** The effective-date window touched, so a consumer can scope its recompute. */
    dateFrom: z.string().nullable(),
    dateTo: z.string().nullable(),
    count: z.int().nonnegative(),
  }),
});

export const TransferPaired = defineEvent({
  type: 'ledger.TransferPaired',
  aggregateType: 'transfer_link',
  description:
    'Two transactions were identified as one internal movement. Budgeting must drop both from ' +
    'spend and income totals — money moving between accounts you own is double-counted by ' +
    'construction, and "spend totals contain zero internal transfers" is a Phase 1 exit criterion. ' +
    'The confidence and match kind are carried so a consumer can choose to act only on certainty.',
  schema: z.object({
    transferLinkId: uuid,
    outflowTransactionId: uuid,
    inflowTransactionId: uuid,
    confidence: z.number().gt(0).lte(1),
    howMatched: z.enum([
      'exact_amount_same_day',
      'exact_amount_near_date',
      'amount_within_tolerance',
      'user_confirmed',
    ]),
  }),
});

export const TransactionSupersededByPosted = defineEvent({
  type: 'ledger.TransactionSupersededByPosted',
  aggregateType: 'transaction',
  description:
    'A pending provider fact was replaced by the posted one, and the user-facing transaction id ' +
    'did NOT change (decision D10). Emitted because the amount and date commonly move between ' +
    'pending and posted — tips, FX, gas holds — so a consumer holding a cached figure must ' +
    're-read even though nothing was added or removed.',
  schema: z.object({
    transactionId: uuid,
    accountId: uuid,
    pendingFactId: uuid,
    postedFactId: uuid,
    amountChanged: z.boolean(),
    dateChanged: z.boolean(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather than
 * as an error.
 */
export const LEDGER_EVENTS: readonly EventDefinition[] = Object.freeze([
  AccountUpserted,
  BalanceRecorded,
  TransactionsUpserted,
  TransferPaired,
  TransactionSupersededByPosted,
]);
