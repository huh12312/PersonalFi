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
import type { StagingStore } from './staging.ts';

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
  /**
   * Always in-memory, always written first. `connect()` stages an account
   * before this connector has been told which `connections` row or which user
   * it belongs to (neither is on the `unknown` input `connect` accepts), so
   * there is no `userId` to hand a durable store at that point — see
   * `staging.ts`'s module comment. Every other public method receives a
   * `ConnectionHandle`, which does carry both, and `#sync` is where the two
   * ids finally meet the durable store, if one is attached.
   */
  readonly #local: ManualStore;
  /** `null` until `attachStagingStore` runs — a test with no database, say. */
  #durable: StagingStore | null = null;
  /** How many of `#local`'s log entries, per connection, are already durable. */
  readonly #flushed = new Map<string, number>();
  readonly #pageSize: number;

  constructor(options: ManualConnectorOptions) {
    this.#local = options.store;
    this.#pageSize = options.pageSize ?? 100;
    this.provider = options.provider ?? MANUAL_PROVIDER;
    this.displayName = options.displayName ?? MANUAL_MANIFEST.displayName;
  }

  /**
   * Point this connector at a durable mirror. Called once, at boot, by
   * `apps/api/src/domain.ts` — the one place a `Database` and this registry
   * both exist. Idempotent, and safe to call again with the same store: a
   * request in flight during the swap keeps using whatever `#durable` was at
   * the time each of its `await`s resumed, and the next call sees the new one.
   */
  attachStagingStore(store: StagingStore): void {
    this.#durable = store;
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

    this.#local.open(providerConnectionId);
    this.#local.append(providerConnectionId, { accounts });

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
    await this.#sync(handle);
    return this.#local.accounts(handle.providerConnectionId);
  }

  async syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    _options: SyncOptions,
  ): Promise<TransactionPage> {
    await this.#sync(handle);
    const after = parseCursor(cursor);
    const entries = this.#local.entriesAfter(handle.providerConnectionId, after, this.#pageSize);

    if (entries.length === 0) {
      // Terminal page. `nextCursor` repeats the caller's position rather than
      // going backwards or to null: a run with nothing new must leave the cursor
      // where it was, and `null` would mean "this provider has no incremental
      // support" (cursor-contract rule 3), which is the opposite of true here.
      return {
        ...emptyPage(cursorOf(String(after))),
        accounts: cursor === null ? this.#local.accounts(handle.providerConnectionId) : [],
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
      accounts: cursor === null ? this.#local.accounts(handle.providerConnectionId) : [],
      nextCursor: cursorOf(String(last)),
      hasMore: last < this.#local.highestSeq(handle.providerConnectionId),
    };
  }

  async syncBalances(
    handle: ConnectionHandle,
    _options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]> {
    await this.#sync(handle);
    assertSupports(this.provider, this.capabilities(), 'balances');
    return this.#local.balances(handle.providerConnectionId);
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    this.#local.close(handle.providerConnectionId);
    this.#flushed.delete(handle.providerConnectionId);
    if (this.#durable !== null) await this.#durable.close(handle.connectionId);
  }

  // No `health`: the optional probe exists so the health job can ask a *remote*
  // whether it is still reachable without spending refresh budget. There is no
  // remote here, and a probe that always answers "yes" is worse than none.

  /**
   * Make `#local` current before a call reads it: hydrate from `#durable` if
   * this process has never opened the connection, then flush whatever `#local`
   * now holds back to `#durable` so a *different* process can see it next.
   *
   * Order matters. Hydrating first means a process that has staged nothing of
   * its own does not flush an empty state over rows another process already
   * made durable; flushing second means the accounts `connect()` staged (which
   * had no durable store to write to at the time — see `#local`'s doc comment)
   * reach it before this call returns.
   */
  async #sync(handle: ConnectionHandle): Promise<void> {
    if (this.#durable === null) {
      this.#assertLocallyOpen(handle);
      return;
    }
    if (!this.#local.has(handle.providerConnectionId)) {
      if (!(await this.#durable.has(handle.connectionId))) {
        this.#assertLocallyOpen(handle); // throws — neither layer has it.
      }
      await this.#hydrate(handle);
    }
    await this.#flush(handle);
  }

  async #hydrate(handle: ConnectionHandle): Promise<void> {
    const durable = this.#durable;
    if (durable === null) return;
    const { connectionId, providerConnectionId } = handle;
    this.#local.open(providerConnectionId);
    const [accounts, balances, entries] = await Promise.all([
      durable.accounts(connectionId),
      durable.balances(connectionId),
      durable.entriesAfter(connectionId, 0, Number.MAX_SAFE_INTEGER),
    ]);
    if (accounts.length > 0 || balances.length > 0) {
      this.#local.append(providerConnectionId, { accounts, balances });
    }
    // One `append` per entry, in durable order: `ManualStore#push` numbers a
    // pushed entry `previous + 1` regardless of how many are pushed per call,
    // so replaying one at a time reproduces the exact sequence numbers the
    // process that originally staged them assigned — which is what lets the
    // orchestrator's persisted cursor (a plain string) mean the same position
    // in either process.
    for (const entry of entries) {
      if (entry.kind === 'removed' || entry.fact === null) {
        this.#local.append(providerConnectionId, {
          removed: [
            {
              providerAccountId: entry.providerAccountId,
              providerTransactionId: entry.providerTransactionId,
            },
          ],
        });
      } else if (entry.kind === 'added') {
        this.#local.append(providerConnectionId, { added: [entry.fact] });
      } else {
        this.#local.append(providerConnectionId, { modified: [entry.fact] });
      }
    }
    this.#flushed.set(providerConnectionId, entries.length);
  }

  async #flush(handle: ConnectionHandle): Promise<void> {
    const durable = this.#durable;
    if (durable === null) return;
    const { connectionId, userId, providerConnectionId } = handle;
    await durable.open(connectionId, userId);

    const accounts = this.#local.accounts(providerConnectionId);
    if (accounts.length > 0) await durable.putAccounts(connectionId, userId, accounts);

    const balances = this.#local.balances(providerConnectionId);
    if (balances.length > 0) await durable.putBalances(connectionId, userId, balances);

    const already = this.#flushed.get(providerConnectionId) ?? 0;
    const all = this.#local.entriesAfter(providerConnectionId, 0, Number.MAX_SAFE_INTEGER);
    const pending = all.slice(already);
    if (pending.length > 0) {
      await durable.appendTransactions(
        connectionId,
        userId,
        pending.map((entry) => ({
          kind: entry.kind,
          providerAccountId: entry.providerAccountId,
          providerTransactionId: entry.providerTransactionId,
          fact: entry.fact,
        })),
      );
      this.#flushed.set(providerConnectionId, all.length);
    }
  }

  #assertLocallyOpen(handle: ConnectionHandle): void {
    if (this.#local.has(handle.providerConnectionId)) return;
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
