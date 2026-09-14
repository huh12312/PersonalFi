// SPDX-License-Identifier: MIT
/**
 * Every fact the Connections context states.
 *
 * Three events, and the shortlist is the design. 08 §1.3 lists eight names for
 * this context, but four of them — `TransactionsUpserted`, `BalancesUpdated`,
 * `HoldingsUpdated`, `AccountsDiscovered` — are facts about *the ledger*, and
 * the same section says so explicitly: "`TransactionsUpserted` is emitted by
 * Ledger (the writer), not Connections — Connections emits sync lifecycle events
 * only. One event, one owner." `applyProviderTransactions` already appends
 * `ledger.TransactionsUpserted` inside the orchestrator's own transaction, so
 * re-announcing it here would give every consumer two wake-ups for one page and
 * make "how many times did this happen?" unanswerable.
 *
 * Of the remaining four, `ConnectionDegraded` and `ConnectionReauthRequired` are
 * both "the status changed, and here is why", and `SyncRunFailed` is
 * `SyncRunCompleted` with a status. Collapsing them means a consumer subscribes
 * once and switches on a field rather than subscribing three times and hoping it
 * found them all — and a new status in Phase 3 does not need a new event type,
 * a new registration at the composition root, and a new consumer branch.
 *
 * **Payloads are ids, counts and enums, never rows.** A consumer that wants the
 * connection re-reads it.
 */
import { defineEvent, type EventDefinition } from '@core/platform';
import { z } from 'zod';
import { CONNECTION_STATUSES, SYNC_RUN_STATUSES, SYNC_TRIGGERS } from '../schema/index.ts';
import { CONNECTOR_ERROR_KINDS } from './port.ts';

const uuid = z.uuid();

export const ConnectionCreated = defineEvent({
  type: 'connections.ConnectionCreated',
  aggregateType: 'connection',
  description:
    'A provider was linked. Carries the provider and the number of accounts it exposed, not the ' +
    'accounts themselves: the ledger has already emitted AccountUpserted for each of them, and a ' +
    'consumer that wants them re-reads through listAccounts(). The initial backfill is enqueued in ' +
    'this same transaction, so a crash between "linked" and "syncing" is impossible.',
  schema: z.object({
    connectionId: uuid,
    provider: z.string().min(1),
    accountCount: z.int().nonnegative(),
    /** Whether this link replaced an existing connection to the same provider id. */
    relinked: z.boolean(),
  }),
});

export const ConnectionStatusChanged = defineEvent({
  type: 'connections.ConnectionStatusChanged',
  aggregateType: 'connection',
  description:
    'A connection moved between active, reauth_required, error and disconnected. This is the event ' +
    'Notifications turns into "Chase needs reconnection" and the one the UI turns into a banner. ' +
    'The reason is the ConnectorError kind, not a message: user-facing copy gets rewritten a dozen ' +
    'times and a consumer must never switch on it. Silent data staleness is the worst failure mode ' +
    'in a finance app, which is why a transition *into* a non-active status is a first-class fact ' +
    'and not a column somebody might notice.',
  schema: z.object({
    connectionId: uuid,
    provider: z.string().min(1),
    from: z.enum(CONNECTION_STATUSES),
    to: z.enum(CONNECTION_STATUSES),
    /** The ConnectorError kind that caused it, when a failure did. */
    reason: z.enum(CONNECTOR_ERROR_KINDS).nullable(),
    /** The provider's own code, for the detail view. Never a message. */
    providerCode: z.string().nullable(),
  }),
});

export const SyncRunCompleted = defineEvent({
  type: 'connections.SyncRunCompleted',
  aggregateType: 'connection',
  description:
    'One sync attempt finished, successfully or not. Counts and timings only — the transactions ' +
    'themselves were announced by ledger.TransactionsUpserted, page by page, as they committed. ' +
    'Emitted for failures too (status = failed): a run that never happened and a run that failed ' +
    'look identical from the outside, and telling them apart is most of what the connections ' +
    'history view is for.',
  schema: z.object({
    connectionId: uuid,
    syncRunId: uuid,
    trigger: z.enum(SYNC_TRIGGERS),
    status: z.enum(SYNC_RUN_STATUSES),
    pageCount: z.int().nonnegative(),
    addedCount: z.int().nonnegative(),
    modifiedCount: z.int().nonnegative(),
    removedCount: z.int().nonnegative(),
    restartCount: z.int().nonnegative(),
    durationMs: z.int().nonnegative(),
    errorKind: z.enum(CONNECTOR_ERROR_KINDS).nullable(),
  }),
});

/**
 * Registered at the composition root. Exported as a list so `apps/api` cannot
 * forget one: an event type that is appended but not registered is invisible to
 * the pump's upcasting, and the failure surfaces as a silent consumer rather
 * than as an error.
 */
export const CONNECTIONS_EVENTS: readonly EventDefinition[] = Object.freeze([
  ConnectionCreated,
  ConnectionStatusChanged,
  SyncRunCompleted,
]);
