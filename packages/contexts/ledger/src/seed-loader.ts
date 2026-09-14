// SPDX-License-Identifier: MIT
/**
 * `@core/seed` → the real ledger, through the real write path.
 *
 * The demo-seed generator produces 24 months of in-memory history and the
 * ground-truth labels a detection algorithm is graded against
 * (`docs/TESTING.md`). Mapping it to `@ctx/ledger`'s schema was explicitly left
 * to Phase 1, and this is it.
 *
 * The one rule that makes this worth having: **it goes through
 * `applyProviderTransactions`, `pairTransfers` and `detectRefundHints`, exactly
 * as a provider adapter does.** A loader with its own `INSERT` statements would
 * produce a demo database that no sync path ever wrote, and would grade the
 * pairing heuristic against data the pairing heuristic had helped to create. Here
 * the seed is an adapter like any other — `provider = 'seed'`, the seed's own ids
 * as the provider's natural keys — so a precision/recall number from
 * `gradeTransfers` is a number about the shipped algorithm.
 *
 * Two deliberate fidelity choices, both stated so a reader can argue with them:
 *
 *   * `merchant_name` is supplied for a transaction that has a merchant and left
 *     NULL otherwise, mirroring Plaid's ~97% fill rate (01 §5.3). Transfers
 *     therefore arrive with nothing but a raw descriptor and exercise
 *     `normaliseMerchantName()` for real.
 *   * The seed has no balance observations, so one `derived` balance per account
 *     is computed from the transactions themselves. `derived` is a first-class
 *     `BALANCE_SOURCES` value precisely because a reconstruction should say that
 *     it is one.
 */
import {
  DateOnly,
  Money,
  type Clock,
  type DateOnly as DateOnlyType,
  type MoneyJson,
} from '@core/kernel';
import { eq } from 'drizzle-orm';
import { transactions, transactionsProvider } from '../schema/index.ts';
import type { AccountClassification, AccountType } from '../schema/index.ts';
import { applyProviderTransactions } from './apply.ts';
import {
  recordBalance,
  setAccountClosed,
  upsertAccount,
  type LedgerWriteContext,
} from './accounts.ts';
import type { LedgerDatabase } from './db.ts';
import { detectRefundHints } from './refunds.ts';
import { pairTransfers, type TransferPairingOptions } from './transfers.ts';
import type { ProviderTransactionInput } from './types.ts';

export const SEED_PROVIDER = 'seed';

/**
 * The shape this loader needs, declared structurally rather than imported.
 *
 * `@core/seed` is not on `@ctx/ledger`'s import allow-list and should not be: a
 * bounded context must not depend on a demo-data generator to compile, or
 * shipping the app means shipping the fixtures. `SeedDataset` satisfies these
 * interfaces structurally, so the test passes the real thing and TypeScript
 * checks the mapping for real — without the arrow ever pointing the wrong way.
 */
export interface SeedAccountLike {
  readonly id: string;
  /** `checking` | `savings` | `credit_card` | `brokerage` | `crypto_exchange` | `mortgage`. */
  readonly type: string;
  readonly name: string;
  readonly currency: string;
  readonly closedOn: DateOnlyType | null;
}

export interface SeedMerchantLike {
  readonly id: string;
  readonly canonicalName: string;
}

export interface SeedTransactionLike {
  readonly id: string;
  readonly accountId: string;
  readonly merchantId: string | null;
  readonly kind: string;
  readonly amount: MoneyJson;
  readonly pendingOn: DateOnlyType | null;
  readonly postedOn: DateOnlyType;
  /** `pending` | `posted`. */
  readonly status: string;
  readonly descriptorRaw: string;
}

export interface SeedDatasetLike {
  readonly startMonth: DateOnlyType;
  readonly accounts: readonly SeedAccountLike[];
  readonly merchants: readonly SeedMerchantLike[];
  readonly transactions: readonly SeedTransactionLike[];
  readonly labels: {
    readonly transfers: readonly {
      readonly fromTransactionId: string;
      readonly toTransactionId: string;
    }[];
    readonly refunds: readonly {
      readonly purchaseTransactionId: string;
      readonly refundTransactionId: string;
    }[];
  };
}

/** How the seed's vocabulary maps onto the ledger's. */
const ACCOUNT_MAPPING: Readonly<
  Record<string, { type: AccountType; classification: AccountClassification } | undefined>
> = Object.freeze({
  checking: { type: 'depository', classification: 'asset' },
  savings: { type: 'depository', classification: 'asset' },
  credit_card: { type: 'credit', classification: 'liability' },
  brokerage: { type: 'investment', classification: 'asset' },
  crypto_exchange: { type: 'crypto', classification: 'asset' },
  mortgage: { type: 'loan', classification: 'liability' },
});

const SUBTYPE: Readonly<Record<string, string | undefined>> = Object.freeze({
  checking: 'checking',
  savings: 'savings',
  credit_card: 'credit card',
  brokerage: 'brokerage',
  crypto_exchange: 'crypto exchange',
  mortgage: 'mortgage',
});

export interface Grading {
  readonly predicted: number;
  readonly actual: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  /** The pairs we proposed that the labels do not contain, for the failure report. */
  readonly falsePositivePairs: readonly (readonly [string, string])[];
  readonly falseNegativePairs: readonly (readonly [string, string])[];
}

export interface LoadSeedResult {
  readonly accountCount: number;
  readonly transactionCount: number;
  readonly pendingCount: number;
  readonly transferLinkCount: number;
  readonly refundHintCount: number;
  readonly transfers: Grading;
  readonly refunds: Grading;
}

export interface LoadSeedOptions {
  readonly clock: Clock;
  readonly correlationId?: string;
  /** Skip the heuristics and load raw facts only. */
  readonly detect?: boolean;
  readonly pairing?: TransferPairingOptions;
}

/**
 * Load a dataset for one user and grade the heuristics against its labels.
 *
 * One transaction per account rather than one for the whole dataset: the outbox's
 * sequencing lock is transaction-scoped and held until commit, so a single
 * 5,000-row transaction would block every other publisher for its whole duration
 * (see `appendEvent`'s note). Per account is both fast and well-behaved.
 */
export async function loadSeedDataset(
  db: LedgerDatabase,
  userId: string,
  dataset: SeedDatasetLike,
  options: LoadSeedOptions,
): Promise<LoadSeedResult> {
  const context: LedgerWriteContext = {
    clock: options.clock,
    correlationId: options.correlationId ?? '00000000-0000-7000-8000-000000000001',
  };
  const merchantNames = new Map(dataset.merchants.map((m) => [m.id, m.canonicalName]));
  const accountIds = new Map<string, string>();

  for (const account of dataset.accounts) {
    // An unmapped account type becomes a manual asset rather than throwing: a
    // new seed account type should show up in the demo looking plain, not break
    // the loader for every other account in the dataset.
    const mapping = ACCOUNT_MAPPING[account.type] ?? {
      type: 'manual' as AccountType,
      classification: 'asset' as AccountClassification,
    };
    const result = await db.transaction(async (tx) =>
      upsertAccount(
        tx,
        {
          userId,
          provider: SEED_PROVIDER,
          providerAccountId: account.id,
          connectionId: null,
          name: account.name,
          type: mapping.type,
          classification: mapping.classification,
          subtype: SUBTYPE[account.type] ?? null,
          currency: account.currency,
          mask: account.id.slice(0, 4),
        },
        context,
      ),
    );
    accountIds.set(account.id, result.accountId);
    if (account.closedOn !== null) {
      // A closed account keeps every transaction it ever had and stops counting
      // towards net worth. Closing it here rather than at upsert time is the
      // same asymmetry the upsert path enforces: `closed_at` is ledger state, not
      // provider metadata, so only an explicit close ever sets it.
      await db.transaction(async (tx) =>
        setAccountClosed(
          tx,
          {
            userId,
            accountId: result.accountId,
            closed: true,
            closedAt: new Date(`${account.closedOn}T00:00:00.000Z`),
          },
          context,
        ),
      );
    }
  }

  const byAccount = new Map<string, SeedTransactionLike[]>();
  for (const transaction of dataset.transactions) {
    const bucket = byAccount.get(transaction.accountId) ?? [];
    bucket.push(transaction);
    byAccount.set(transaction.accountId, bucket);
  }

  let transactionCount = 0;
  let pendingCount = 0;
  for (const [seedAccountId, items] of byAccount) {
    const accountId = accountIds.get(seedAccountId);
    if (accountId === undefined) continue;
    const added = items.map((item) => toProviderInput(item, merchantNames));
    transactionCount += added.length;
    pendingCount += added.filter((item) => item.pending).length;
    await db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId,
        accountId,
        provider: SEED_PROVIDER,
        added,
        clock: options.clock,
        correlationId: context.correlationId,
      }),
    );
  }

  await recordDerivedBalances(db, userId, dataset, accountIds, context);

  if (options.detect === false) {
    return {
      accountCount: accountIds.size,
      transactionCount,
      pendingCount,
      transferLinkCount: 0,
      refundHintCount: 0,
      transfers: emptyGrading(dataset.labels.transfers.length),
      refunds: emptyGrading(dataset.labels.refunds.length),
    };
  }

  const paired = await db.transaction(async (tx) =>
    pairTransfers(tx, { userId, ...options.pairing }, context),
  );
  const hints = await db.transaction(async (tx) => detectRefundHints(tx, { userId }, context));

  // Grade in the seed's own vocabulary: map our surrogate ids back through the
  // provider ids the loader used, which are the seed's transaction ids.
  const seedIdOf = await loadSeedIdMap(db, userId);
  const predictedTransfers = paired.paired.map(
    (pair) =>
      [
        seedIdOf.get(pair.outflowId) ?? pair.outflowId,
        seedIdOf.get(pair.inflowId) ?? pair.inflowId,
      ] as const,
  );
  const truthTransfers = dataset.labels.transfers.map(
    (pair) => [pair.fromTransactionId, pair.toTransactionId] as const,
  );
  const predictedRefunds = hints.map(
    (hint) =>
      [
        seedIdOf.get(hint.purchaseTransactionId) ?? hint.purchaseTransactionId,
        seedIdOf.get(hint.refundTransactionId) ?? hint.refundTransactionId,
      ] as const,
  );
  const truthRefunds = dataset.labels.refunds.map(
    (refund) => [refund.purchaseTransactionId, refund.refundTransactionId] as const,
  );

  return {
    accountCount: accountIds.size,
    transactionCount,
    pendingCount,
    transferLinkCount: paired.paired.length,
    refundHintCount: hints.length,
    transfers: grade(predictedTransfers, truthTransfers),
    refunds: grade(predictedRefunds, truthRefunds),
  };
}

/**
 * Precision and recall over unordered pairs.
 *
 * Unordered because "which leg is the outflow" is an artefact of how the label
 * was written, not a claim the algorithm should be graded on: the fact under test
 * is "these two rows are one movement".
 */
export function grade(
  predicted: readonly (readonly [string, string])[],
  actual: readonly (readonly [string, string])[],
): Grading {
  const key = (pair: readonly [string, string]): string =>
    pair[0] < pair[1] ? `${pair[0]}|${pair[1]}` : `${pair[1]}|${pair[0]}`;
  const predictedKeys = new Set(predicted.map(key));
  const actualKeys = new Set(actual.map(key));

  const truePositives = [...predictedKeys].filter((entry) => actualKeys.has(entry)).length;
  const falsePositives = predictedKeys.size - truePositives;
  const falseNegatives = actualKeys.size - truePositives;

  return {
    predicted: predictedKeys.size,
    actual: actualKeys.size,
    truePositives,
    falsePositives,
    falseNegatives,
    // An algorithm that proposed nothing has no precision to speak of; reporting
    // 1.0 there would let a do-nothing implementation pass a precision gate.
    precision: predictedKeys.size === 0 ? 0 : truePositives / predictedKeys.size,
    recall: actualKeys.size === 0 ? 0 : truePositives / actualKeys.size,
    falsePositivePairs: predicted.filter((pair) => !actualKeys.has(key(pair))),
    falseNegativePairs: actual.filter((pair) => !predictedKeys.has(key(pair))),
  };
}

function emptyGrading(actual: number): Grading {
  return {
    predicted: 0,
    actual,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: actual,
    precision: 0,
    recall: 0,
    falsePositivePairs: [],
    falseNegativePairs: [],
  };
}

/**
 * One provider transaction, as a provider adapter would hand it over.
 *
 * `authorized_date` carries the seed's `pendingOn`, because that is the day the
 * card was swiped — and `COALESCE(authorized_date, posted_date)` is the effective
 * date (04 §2.4), so a charge authorised on the 31st and posted on the 2nd lands
 * in the month it was spent.
 */
function toProviderInput(
  item: SeedTransactionLike,
  merchantNames: ReadonlyMap<string, string>,
): ProviderTransactionInput {
  const amount = Money.fromJSON(item.amount);
  const merchantName =
    item.merchantId === null ? null : (merchantNames.get(item.merchantId) ?? null);
  return {
    providerTransactionId: item.id,
    pendingTransactionId: null,
    amount,
    isoCurrency: amount.currency,
    postedDate: item.postedOn,
    authorizedDate: item.pendingOn,
    postedAt: null,
    authorizedAt: null,
    name: item.descriptorRaw,
    merchantName,
    originalDescription: item.descriptorRaw,
    paymentChannel: item.kind === 'purchase' ? 'in store' : 'other',
    providerCategory: null,
    pending: item.status === 'pending',
    location: null,
    counterparties: null,
    raw: { ...item },
  };
}

/**
 * One `derived` balance per account, as of the dataset's last day.
 *
 * The seed generates no balances, and an accounts page with no figures is a poor
 * demo. Reconstructing from the transactions is exactly what `source = 'derived'`
 * exists to label: it is our arithmetic, not the institution's statement, and
 * a reader is entitled to know the difference.
 */
async function recordDerivedBalances(
  db: LedgerDatabase,
  userId: string,
  dataset: SeedDatasetLike,
  accountIds: ReadonlyMap<string, string>,
  context: LedgerWriteContext,
): Promise<void> {
  const totals = new Map<string, bigint>();
  let lastDay = dataset.startMonth;
  for (const transaction of dataset.transactions) {
    const amount = Money.fromJSON(transaction.amount);
    totals.set(transaction.accountId, (totals.get(transaction.accountId) ?? 0n) + amount.minor);
    if (DateOnly.compare(transaction.postedOn, lastDay) > 0) lastDay = transaction.postedOn;
  }

  const asOf = new Date(`${lastDay}T23:59:59.000Z`);
  for (const account of dataset.accounts) {
    const accountId = accountIds.get(account.id);
    if (accountId === undefined) continue;
    await db.transaction(async (tx) =>
      recordBalance(
        tx,
        {
          userId,
          accountId,
          current: Money.of(totals.get(account.id) ?? 0n, account.currency),
          asOf,
          source: 'derived',
        },
        context,
      ),
    );
  }
}

/** Our surrogate transaction id → the seed's own id, for grading. */
async function loadSeedIdMap(db: LedgerDatabase, userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      transactionId: transactions.id,
      providerTransactionId: transactionsProvider.providerTransactionId,
    })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .where(eq(transactions.userId, userId));
  return new Map(rows.map((row) => [row.transactionId, row.providerTransactionId]));
}
