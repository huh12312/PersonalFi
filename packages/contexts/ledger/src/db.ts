// SPDX-License-Identifier: MIT
import type { Database } from '@core/db';
import { DateOnly, money, type Clock, type DateOnly as DateOnlyType, type Money } from '@core/kernel';
import type { EffectiveTransaction, LedgerTransaction, TransactionFact } from './types.ts';
import type { TransactionProviderRow, TransactionRow } from '../schema/index.ts';

/**
 * The database surface this context needs.
 *
 * A `Pick` rather than the full `Database`, so a Drizzle transaction handle and
 * the pool-backed database both satisfy it structurally and every write function
 * can be called inside a caller-supplied transaction. That is not a convenience:
 * `appendEvent` requires a transaction handle by construction (there is no
 * overload that publishes outside one), so a writer that could not accept one
 * could not emit its own events atomically.
 */
export type LedgerExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

/** The pool-backed database, which can also open transactions. */
export type LedgerDatabase = Database;

/** Everything a write path needs that is not data. */
export interface LedgerContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a whole sync run together in the event log and the logs. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export function moneyOf(minor: bigint, currency: string): Money {
  return money(minor, currency.trim());
}

/** `DATE` arrives as `YYYY-MM-DD` because `@core/db` overrides the driver's parser. */
export function dateOnlyOf(value: string): DateOnlyType {
  return DateOnly.parse(value);
}

/** The narrow slice of a provider row that `resolveEffective` is allowed to see. */
export function factOf(row: TransactionProviderRow): TransactionFact {
  return {
    amount: moneyOf(row.amountMinor, row.currency),
    postedDate: dateOnlyOf(row.postedDate),
    authorizedDate: row.authorizedDate === null ? null : dateOnlyOf(row.authorizedDate),
    name: row.name,
    merchantName: row.merchantName,
    pending: row.pending,
  };
}

/**
 * Rehydrate the stored effective columns.
 *
 * Note what this does *not* do: recompute them. The stored columns are the
 * projection `resolveEffective()` produced at write time, and reading them back is
 * the whole point of denormalising them. `effective-invariant.test.ts` is what
 * keeps the two honest — it walks every row in the database and asserts the stored
 * values equal a fresh resolution of the fact and overlay.
 */
export function effectiveOf(row: TransactionRow): EffectiveTransaction {
  const merchantName = row.userMerchantName ?? row.effectiveName;
  return {
    date: dateOnlyOf(row.effectiveDate),
    amount: moneyOf(row.effectiveAmountMinor, row.effectiveCurrency),
    name: row.effectiveName,
    merchantKey: null,
    merchantDisplayName: row.effectiveMerchantId === null ? null : merchantName,
    pending: row.pending,
    excluded: row.userExcluded,
    categoryId: row.userCategoryId,
    note: row.userNote,
  };
}

export function transactionOf(row: TransactionRow): LedgerTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    factId: row.currentFactId,
    effective: effectiveOf(row),
    merchantId: row.effectiveMerchantId,
    isTransfer: row.isTransfer,
    transferLinkId: row.transferLinkId,
    refundOfId: row.refundOfId,
    refundConfidence: row.refundConfidence,
    supersededById: row.supersededById,
    supersededReason: row.supersededReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
