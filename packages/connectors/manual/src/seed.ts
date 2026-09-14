// SPDX-License-Identifier: MIT
/**
 * `SeedConnector` — the demo dataset, delivered through the port.
 *
 * `@ctx/ledger` already has `loadSeedDataset`, which writes the demo data
 * straight into the ledger. That stays as it is: it is the fast path the
 * heuristics are graded against, and it loads ~1,000 transactions in one call.
 *
 * This is the *other* reason to have demo data — proving the orchestrator works.
 * The same dataset arrives as pages, through `syncTransactions`, with a cursor,
 * a `sync_runs` row, per-page commits and real events. If the seed path is green
 * here, the only thing WP 1.3's Plaid adapter has to get right is the mapping;
 * the machinery around it has already been exercised against a thousand rows.
 *
 * ## Why the dataset type is declared structurally
 *
 * `@core/seed` is not on this layer's allow-list in
 * `scripts/eslint-boundaries.js`, and should not be: a shipped adapter must not
 * depend on a fixture generator. `SeedDatasetLike` below is the same trick
 * `@ctx/ledger`'s `seed-loader.ts` uses, for the same reason — the caller passes
 * `generateDemoData(1)` and TypeScript checks the shape structurally.
 *
 * ## Pending → posted is emitted the hard way, on purpose
 *
 * A seed transaction that was pending and then posted is delivered as Plaid
 * delivers it (01 §5.2): an `added` pending fact, then a `removed` of that
 * pending id, then an `added` posted fact carrying `pendingTransactionId`. The
 * naive alternative — emitting only the final posted row — would make the seed
 * path green while leaving decision D10's identity migration completely
 * untested through the orchestrator, which is the single highest-value
 * invariant in the schema.
 */
import type {
  ConnectorManifest,
  ProviderAccountFact,
  ProviderBalanceFact,
  ProviderTransactionFact,
} from '@connector/port';
import { fingerprintOf } from '@connector/port';
import { Money, type DateOnly, type MoneyJson } from '@core/kernel';
import { ManualStore, type ManualBatch } from './store.ts';
import { ManualConnector, type ManualConnectorOptions } from './connector.ts';

export const SEED_PROVIDER = 'seed';

/**
 * The demo dataset, as the "add a connection" screen sees it.
 *
 * A manifest rather than a hidden developer path: loading demo data is a thing a
 * user does on day one to see what the app looks like with history in it, and an
 * adapter the UI renders from data is one the UI needs no branch for. It is
 * still gated at the composition root — `apps/api` registers it only when the
 * `module.demo_data` flag is on — because a registry entry is what makes it
 * appear, and a flag is what decides whether it is registered.
 */
export const SEED_MANIFEST: ConnectorManifest = Object.freeze({
  provider: SEED_PROVIDER,
  displayName: 'Demo data',
  description:
    'Twenty-four months of generated history for a fictional household, delivered through the ' +
    'same sync path as a real bank. Deterministic from a seed integer, so what you see is what ' +
    'the tests see.',
  iconKey: 'beaker',
  linkKind: 'manual_entry',
  docsUrl: null,
});

/** The slice of `@core/seed`'s `SeedDataset` this loader reads. */
export interface SeedAccountLike {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly currency: string;
  readonly closedOn: DateOnly | null;
}

export interface SeedTransactionLike {
  readonly id: string;
  readonly accountId: string;
  readonly merchantId: string | null;
  readonly amount: MoneyJson;
  readonly pendingOn: DateOnly | null;
  readonly postedOn: DateOnly;
  readonly status: string;
  readonly descriptorRaw: string;
}

export interface SeedMerchantLike {
  readonly id: string;
  readonly canonicalName: string;
}

export interface SeedDatasetLike {
  readonly accounts: readonly SeedAccountLike[];
  readonly merchants: readonly SeedMerchantLike[];
  readonly transactions: readonly SeedTransactionLike[];
}

/**
 * Seed account types → the six the ledger models.
 *
 * A total function over the seed's vocabulary with an explicit fallback, rather
 * than a lookup that returns `undefined` and turns a new seed account type into
 * a null-type row three layers downstream.
 */
function accountTypeOf(seedType: string): ProviderAccountFact['type'] {
  switch (seedType) {
    case 'checking':
    case 'savings':
      return 'depository';
    case 'credit_card':
      return 'credit';
    case 'brokerage':
      return 'investment';
    case 'crypto_exchange':
      return 'crypto';
    case 'mortgage':
      return 'loan';
    default:
      return 'manual';
  }
}

function factOf(
  seedTransaction: SeedTransactionLike,
  merchantNames: ReadonlyMap<string, string>,
  overrides: {
    readonly providerTransactionId: string;
    readonly postedDate: DateOnly;
    readonly pending: boolean;
    readonly pendingTransactionId: string | null;
  },
): ProviderTransactionFact {
  const amount = Money.fromJSON(seedTransaction.amount);
  return {
    providerAccountId: seedTransaction.accountId,
    providerTransactionId: overrides.providerTransactionId,
    pendingTransactionId: overrides.pendingTransactionId,
    amount,
    isoCurrency: amount.currency,
    postedDate: overrides.postedDate,
    // The seed's pending date is the authorisation; carrying it means the
    // ledger's effective date does not jump when the charge settles.
    authorizedDate: seedTransaction.pendingOn,
    postedAt: null,
    authorizedAt: null,
    name: seedTransaction.descriptorRaw,
    merchantName:
      seedTransaction.merchantId === null
        ? null
        : (merchantNames.get(seedTransaction.merchantId) ?? null),
    originalDescription: seedTransaction.descriptorRaw,
    paymentChannel: null,
    providerCategory: null,
    pending: overrides.pending,
    location: null,
    counterparties: null,
    raw: { source: SEED_PROVIDER, seedTransactionId: seedTransaction.id },
    fingerprint: fingerprintOf({
      providerAccountId: seedTransaction.accountId,
      postedDate: overrides.postedDate,
      amount,
      description: seedTransaction.descriptorRaw,
    }),
  };
}

export interface SeedBatchOptions {
  /** When the balances the loader derives are stated to be as of. */
  readonly asOf: Date;
  /**
   * Rows per batch. The store is an append-only log, so this only affects how
   * the caller chunks its writes; the *page* size is the connector's.
   */
  readonly batchSize?: number;
}

/**
 * Turn a dataset into the batches `ManualStore` consumes.
 *
 * Deterministic: transactions are ordered by `(postedOn, id)` before anything
 * else happens, so the same dataset produces the same log, the same cursors and
 * the same pages on every run.
 */
export function seedBatches(dataset: SeedDatasetLike, options: SeedBatchOptions): ManualBatch[] {
  const merchantNames = new Map(dataset.merchants.map((m) => [m.id, m.canonicalName]));
  const accounts: ProviderAccountFact[] = dataset.accounts.map((account) => ({
    providerAccountId: account.id,
    name: account.name,
    officialName: null,
    type: accountTypeOf(account.type),
    subtype: account.type,
    currency: account.currency,
    mask: account.id.slice(-4),
    closed: account.closedOn !== null,
    capabilities: ['accounts', 'balances', 'transactions'],
  }));

  const ordered = [...dataset.transactions].sort((a, b) =>
    a.postedOn === b.postedOn ? a.id.localeCompare(b.id) : a.postedOn.localeCompare(b.postedOn),
  );

  const batchSize = options.batchSize ?? 200;
  const batches: ManualBatch[] = [{ accounts, balances: balancesOf(dataset, options.asOf) }];
  let added: ProviderTransactionFact[] = [];
  let removed: { providerAccountId: string; providerTransactionId: string }[] = [];

  const flush = (): void => {
    if (added.length === 0 && removed.length === 0) return;
    batches.push({ added, removed });
    added = [];
    removed = [];
  };

  for (const transaction of ordered) {
    const settled = transaction.status === 'posted';
    const hadPendingPhase = transaction.pendingOn !== null;

    if (hadPendingPhase) {
      const pendingId = `${transaction.id}-pending`;
      added.push(
        factOf(transaction, merchantNames, {
          providerTransactionId: pendingId,
          postedDate: transaction.pendingOn ?? transaction.postedOn,
          pending: true,
          pendingTransactionId: null,
        }),
      );
      if (settled) {
        // The delete-plus-insert Plaid actually performs. Both halves are in the
        // same batch here but not in the same *page* once the connector chunks
        // them, which is exactly the ordering `applyProviderTransactions` has to
        // survive — and does, in either order.
        removed.push({
          providerAccountId: transaction.accountId,
          providerTransactionId: pendingId,
        });
        added.push(
          factOf(transaction, merchantNames, {
            providerTransactionId: transaction.id,
            postedDate: transaction.postedOn,
            pending: false,
            pendingTransactionId: pendingId,
          }),
        );
      }
    } else {
      added.push(
        factOf(transaction, merchantNames, {
          providerTransactionId: transaction.id,
          postedDate: transaction.postedOn,
          pending: !settled,
          pendingTransactionId: null,
        }),
      );
    }

    if (added.length + removed.length >= batchSize) flush();
  }
  flush();
  return batches;
}

/**
 * A balance per account, derived by summing the account's transactions.
 *
 * `source: 'derived'` is what the ledger records for this, and that honesty is
 * the point: a reconstruction is not an observation the institution made.
 */
function balancesOf(dataset: SeedDatasetLike, asOf: Date): ProviderBalanceFact[] {
  const totals = new Map<string, Money>();
  for (const transaction of dataset.transactions) {
    const amount = Money.fromJSON(transaction.amount);
    const running = totals.get(transaction.accountId);
    totals.set(transaction.accountId, running === undefined ? amount : Money.add(running, amount));
  }
  return dataset.accounts.map((account) => ({
    providerAccountId: account.id,
    current: totals.get(account.id) ?? Money.zero(account.currency),
    available: null,
    limit: null,
    asOf,
  }));
}

export interface SeedConnectorOptions extends Omit<ManualConnectorOptions, 'store'> {
  readonly store?: ManualStore;
}

/**
 * The manual connector under a different provider id, pre-loaded from a dataset.
 *
 * Not a second implementation of the port: the delivery mechanics of "a log of
 * transactions the user owns" and "a log of transactions a generator produced"
 * are identical, and writing them twice would mean testing the orchestrator
 * against a connector that no longer resembles the one in production.
 */
export class SeedConnector extends ManualConnector {
  readonly #seedStore: ManualStore;

  constructor(options: SeedConnectorOptions = {}) {
    const store = options.store ?? new ManualStore();
    super({ ...options, store, provider: SEED_PROVIDER, displayName: 'Demo data' });
    this.#seedStore = store;
  }

  /**
   * Stage a dataset for delivery. Returns the connection id `connect` will use.
   *
   * Separate from `connect` because `connect`'s input is `unknown` by contract
   * and threading a whole dataset through a zod schema would validate a shape
   * that a workspace-internal caller has already had type-checked.
   */
  load(providerConnectionId: string, dataset: SeedDatasetLike, options: SeedBatchOptions): string {
    this.#seedStore.open(providerConnectionId);
    for (const batch of seedBatches(dataset, options)) {
      this.#seedStore.append(providerConnectionId, batch);
    }
    return providerConnectionId;
  }
}
