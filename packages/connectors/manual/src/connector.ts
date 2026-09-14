// SPDX-License-Identifier: MIT
/**
 * `ManualConnector` — the user is the provider.
 *
 * Property, vehicles, private equity, a loan from a relative, cash under the
 * mattress. Essential for true net worth (08 §2.6), and a first-class adapter
 * rather than a special case so that manual accounts get the same orchestrator,
 * the same events, the same sync-run history and the same UI as Plaid.
 *
 * The cursor is a sequence number over `ManualStore`'s append-only log. That is
 * the weakest possible cursor and it is deliberately real: if the orchestrator
 * works against a counter it works against anything, and every cursor bug shows
 * up here first, in a test that needs no network.
 */
import {
  ConnectorError,
  assertSupports,
  cursorOf,
  emptyPage,
  fingerprintOf,
  importedTransactionIdOf,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorManifest,
  type Cursor,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderTransactionFact,
  type SyncOptions,
  type TransactionPage,
} from '@connector/port';
import { newId, type DateOnly, type Money } from '@core/kernel';
import { z } from 'zod';
import { type ManualStore, type ManualEntry } from './store.ts';

export const MANUAL_PROVIDER = 'manual';

/**
 * Honest to the point of being boring.
 *
 * `holdings` is **not** declared even though 08 §2.6's roster lists it for this
 * adapter: `syncHoldings` is not implemented, Investments is a Phase 3 context,
 * and a declared-but-empty dataset is exactly the lie the conformance suite
 * exists to catch. It goes in when the method does.
 */
export const MANUAL_CAPABILITIES: ConnectorCapabilities = Object.freeze({
  supports: Object.freeze([
    'accounts',
    'balances',
    'transactions',
    'incremental_sync',
    'on_demand_refresh',
    'historical_backfill',
  ] as const),
  // The user's memory is the window, and it is not ours to bound.
  historyWindowDays: 'unbounded',
  // There is no remote to be polite to. Syncing twice in a second costs nothing.
  minSyncIntervalSeconds: 0,
  refreshBudgetPerDay: null,
  supportsWebhooks: false,
  // Nothing to reconnect: there is no credential that can expire.
  reconnectFlow: 'none',
  consentWindowDays: null,
  currencies: 'multi',
});

export const MANUAL_MANIFEST: ConnectorManifest = Object.freeze({
  provider: MANUAL_PROVIDER,
  displayName: 'Manual account',
  description:
    'An account you maintain yourself: a car, a property, a private loan, cash. Balances and ' +
    'transactions are whatever you enter, and nothing ever leaves this machine.',
  iconKey: 'pencil',
  linkKind: 'manual_entry',
  docsUrl: null,
});

const accountSchema = z.object({
  providerAccountId: z.string().min(1),
  name: z.string().min(1),
  officialName: z.string().nullable().default(null),
  type: z.enum(['depository', 'credit', 'loan', 'investment', 'crypto', 'manual']),
  subtype: z.string().nullable().default(null),
  currency: z.string().length(3),
  mask: z.string().nullable().default(null),
  closed: z.boolean().default(false),
});

const connectSchema = z.object({
  displayName: z.string().min(1),
  /** Supplied by a test or a re-link; generated when absent. */
  providerConnectionId: z.string().min(1).optional(),
  accounts: z.array(accountSchema).min(1),
});

export interface ManualConnectorOptions {
  readonly store: ManualStore;
  /** Rows per page. Small by default so pagination is exercised, not theoretical. */
  readonly pageSize?: number;
  /**
   * Overridden by `SeedConnector`, which is this connector under a different
   * provider id. A field rather than a subclass override because `provider` is
   * what `accounts.provider` and the natural key `(user_id, provider,
   * provider_account_id)` are built from: two adapters sharing one id would make
   * a seeded account and a hand-entered account collide.
   */
  readonly provider?: string;
  readonly displayName?: string;
}

export class ManualConnector implements Connector {
  readonly provider: string;
  readonly displayName: string;
  readonly #store: ManualStore;
  readonly #pageSize: number;

  constructor(options: ManualConnectorOptions) {
    this.#store = options.store;
    this.#pageSize = options.pageSize ?? 100;
    this.provider = options.provider ?? MANUAL_PROVIDER;
    this.displayName = options.displayName ?? MANUAL_MANIFEST.displayName;
  }

  capabilities(): ConnectorCapabilities {
    return MANUAL_CAPABILITIES;
  }

  async connect(input: unknown): Promise<ConnectResult> {
    const parsed = connectSchema.safeParse(input);
    if (!parsed.success) {
      throw new ConnectorError('manual connect input is not a valid account set', {
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
        redactedContext: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      });
    }

    const providerConnectionId = parsed.data.providerConnectionId ?? newId();
    const accounts: ProviderAccountFact[] = parsed.data.accounts.map((account) => ({
      ...account,
      capabilities: ['accounts', 'balances', 'transactions'],
    }));

    this.#store.open(providerConnectionId);
    this.#store.append(providerConnectionId, { accounts });

    return {
      providerConnectionId,
      displayName: parsed.data.displayName,
      // No credential exists, so none can leak. That is not a gap in the adapter;
      // it is the reason a manual account has no reconnect flow.
      credentials: {},
      accounts,
      observedCapabilities: null,
      consentExpiresAt: null,
    };
  }

  async listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]> {
    this.#assertOpen(handle);
    return this.#store.accounts(handle.providerConnectionId);
  }

  async syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    _options: SyncOptions,
  ): Promise<TransactionPage> {
    this.#assertOpen(handle);
    const after = parseCursor(cursor);
    const entries = this.#store.entriesAfter(handle.providerConnectionId, after, this.#pageSize);

    if (entries.length === 0) {
      // Terminal page. `nextCursor` repeats the caller's position rather than
      // going backwards or to null: a run with nothing new must leave the cursor
      // where it was, and `null` would mean "this provider has no incremental
      // support" (cursor-contract rule 3), which is the opposite of true here.
      return {
        ...emptyPage(cursorOf(String(after))),
        accounts: cursor === null ? this.#store.accounts(handle.providerConnectionId) : [],
      };
    }

    const added: ProviderTransactionFact[] = [];
    const modified: ProviderTransactionFact[] = [];
    const removed: { providerAccountId: string; providerTransactionId: string }[] = [];
    for (const entry of entries) fanOut(entry, added, modified, removed);

    const last = entries.at(-1)?.seq ?? after;
    return {
      added,
      modified,
      removed,
      // Only on the first page: an account upsert is idempotent, but repeating it
      // on every page of a 24-month backfill is 60 pointless writes.
      accounts: cursor === null ? this.#store.accounts(handle.providerConnectionId) : [],
      nextCursor: cursorOf(String(last)),
      hasMore: last < this.#store.highestSeq(handle.providerConnectionId),
    };
  }

  async syncBalances(
    handle: ConnectionHandle,
    _options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]> {
    this.#assertOpen(handle);
    assertSupports(this.provider, this.capabilities(), 'balances');
    return this.#store.balances(handle.providerConnectionId);
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.#store.close(handle.providerConnectionId);
  }

  // No `health`: the optional probe exists so the health job can ask a *remote*
  // whether it is still reachable without spending refresh budget. There is no
  // remote here, and a probe that always answers "yes" is worse than none.

  #assertOpen(handle: ConnectionHandle): void {
    if (this.#store.has(handle.providerConnectionId)) return;
    // A disconnected connection is gone, and asking it for data is not a
    // transient failure that a retry will fix.
    throw ConnectorError.fromCondition(
      'AUTH_REQUIRED',
      'this manual connection has been disconnected',
      {
        redactedContext: { providerConnectionId: handle.providerConnectionId },
      },
    );
  }
}

function fanOut(
  entry: ManualEntry,
  added: ProviderTransactionFact[],
  modified: ProviderTransactionFact[],
  removed: { providerAccountId: string; providerTransactionId: string }[],
): void {
  if (entry.kind === 'removed' || entry.fact === null) {
    removed.push({
      providerAccountId: entry.providerAccountId,
      providerTransactionId: entry.providerTransactionId,
    });
    return;
  }
  (entry.kind === 'added' ? added : modified).push(entry.fact);
}

/**
 * The one place a manual cursor is read.
 *
 * An adapter may parse the cursor it produced — that is its own private format.
 * What the *orchestrator* may never do is parse one, which is why nothing here
 * is exported.
 */
function parseCursor(cursor: Cursor | null): number {
  if (cursor === null) return 0;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 0) {
    // Someone handed us a cursor we did not issue, or the column was corrupted.
    // Recovery is a full re-pull healed by idempotent upsert, never a deletion.
    throw ConnectorError.fromCondition('CURSOR_EXPIRED', 'manual cursor is not a sequence number');
  }
  return value;
}

export interface ManualTransactionInput {
  readonly providerAccountId: string;
  /** Defaults to a content hash, so entering the same row twice is one row. */
  readonly providerTransactionId?: string;
  readonly amount: Money;
  readonly postedDate: DateOnly;
  readonly name: string;
  readonly merchantName?: string | null;
  readonly pending?: boolean;
  readonly pendingTransactionId?: string | null;
  readonly occurrence?: number;
}

/**
 * Build a canonical fact from what a human typed.
 *
 * Exported because the UI (WP 1.6) and the tests both need it, and because
 * "compute the fingerprint" is not something a call site should be trusted to
 * remember — 08 §2.5 makes it mandatory on every adapter.
 */
export function manualTransaction(input: ManualTransactionInput): ProviderTransactionFact {
  const fingerprint = fingerprintOf({
    providerAccountId: input.providerAccountId,
    postedDate: input.postedDate,
    amount: input.amount,
    description: input.name,
  });
  return {
    providerAccountId: input.providerAccountId,
    providerTransactionId:
      input.providerTransactionId ??
      importedTransactionIdOf({
        provider: MANUAL_PROVIDER,
        providerAccountId: input.providerAccountId,
        postedDate: input.postedDate,
        amount: input.amount,
        description: input.name,
        occurrence: input.occurrence ?? 1,
      }),
    pendingTransactionId: input.pendingTransactionId ?? null,
    amount: input.amount,
    isoCurrency: input.amount.currency,
    postedDate: input.postedDate,
    authorizedDate: null,
    postedAt: null,
    authorizedAt: null,
    name: input.name,
    merchantName: input.merchantName ?? null,
    originalDescription: null,
    paymentChannel: 'other',
    providerCategory: null,
    pending: input.pending ?? false,
    location: null,
    counterparties: null,
    raw: { source: MANUAL_PROVIDER },
    fingerprint,
  };
}
