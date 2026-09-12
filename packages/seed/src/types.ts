// SPDX-License-Identifier: MIT
import type { DateOnly, MoneyJson } from '@core/kernel';

/**
 * Typed in-memory shapes for the demo-seed generator.
 *
 * **Phase 1's job, not this package's**: mapping `SeedTransaction` to
 * `@ctx/ledger`'s `transactions` row, `SeedHolding` to `@ctx/investments`'s
 * schema, and so on. This package defines no `pgTable` and owns no table (see
 * `OWNERSHIP.md`) — writing one here would mean guessing a schema decision
 * that belongs to the context that will actually own it, months before that
 * context exists. Everything below is deliberately a plain, JSON-serialisable
 * description of "realistic financial history for one household", nothing more.
 *
 * Money is carried as `MoneyJson` (minor units as a *string*) rather than the
 * branded `Money` type: the whole point of `writeJson()` is that this survives
 * `JSON.stringify`/`JSON.parse` byte-for-byte, and a `bigint` cannot cross that
 * boundary. Rehydrate with `Money.fromJSON` on the reading side.
 */

export type AccountType =
  'checking' | 'savings' | 'credit_card' | 'brokerage' | 'crypto_exchange' | 'mortgage';

export interface SeedAccount {
  readonly id: string;
  readonly type: AccountType;
  readonly name: string;
  readonly currency: string;
  readonly openedOn: DateOnly;
  readonly closedOn: DateOnly | null;
}

export interface SeedMerchant {
  readonly id: string;
  /** The clean, human name a categoriser is expected to converge on. */
  readonly canonicalName: string;
  /** e.g. 'groceries', 'subscriptions', 'transport' — a loose hint, not a taxonomy. */
  readonly category: string;
}

export type TransactionStatus = 'pending' | 'posted';

export type TransactionKind =
  'purchase' | 'payment' | 'transfer' | 'refund' | 'interest' | 'fee' | 'deposit';

export interface SeedTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly merchantId: string | null;
  readonly kind: TransactionKind;
  /** Sign convention per CONVENTIONS.md: negative = outflow, positive = inflow. */
  readonly amount: MoneyJson;
  /** The date the provider would report as pending, before `postedOn`. */
  readonly pendingOn: DateOnly | null;
  readonly postedOn: DateOnly;
  readonly status: TransactionStatus;
  /** Raw descriptor exactly as a statement would print it (see `merchants.ts`). */
  readonly descriptorRaw: string;
}

export type RecurringCadence = 'monthly' | 'biweekly' | 'annual';

/**
 * Ground truth for a recurring-detection algorithm's golden test: every
 * transaction id this package generated *as* one series, and the facts about
 * that series a detector is graded against (07 §5.1; master plan Phase 2 exit
 * criterion, "recall >= 0.85 / precision >= 0.95").
 */
export interface SeedRecurringSeries {
  readonly id: string;
  readonly merchantId: string;
  readonly accountId: string;
  readonly cadence: RecurringCadence;
  readonly transactionIds: readonly string[];
  /** The amount before any price change, as a decimal string (e.g. `'-15.99'`). */
  readonly initialAmount: string;
  readonly currency: string;
  /**
   * If this series includes the canonical "price went up" case: the date of
   * the first transaction at the new amount, and what that amount is.
   */
  readonly priceIncrease: { readonly effectiveOn: DateOnly; readonly newAmount: string } | null;
  /** If this series went dormant: the date after which it never recurs again. */
  readonly dormantAfter: DateOnly | null;
}

/** Ground truth for an internal transfer: two legs that must net to zero. */
export interface SeedTransferPair {
  readonly id: string;
  readonly fromTransactionId: string;
  readonly toTransactionId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amount: MoneyJson;
}

/** Ground truth for a refund: the purchase it partially or fully reverses. */
export interface SeedRefundLink {
  readonly id: string;
  readonly purchaseTransactionId: string;
  readonly refundTransactionId: string;
}

export interface SeedHolding {
  readonly accountId: string;
  readonly securityId: string;
  readonly symbol: string;
  /** Decimal string, `@core/kernel`'s `Quantity` wire form. */
  readonly quantity: string;
  readonly asOf: DateOnly;
}

/**
 * A daily close. Decimal string per CONVENTIONS.md ("Prices and FX rates are
 * `NUMERIC(20,10)`, not minor units") — a price is not itself money.
 */
export interface SeedPricePoint {
  readonly securityId: string;
  readonly symbol: string;
  readonly date: DateOnly;
  readonly close: string;
}

export interface SeedLabels {
  readonly recurringSeries: readonly SeedRecurringSeries[];
  readonly transfers: readonly SeedTransferPair[];
  readonly refunds: readonly SeedRefundLink[];
}

export interface SeedDataset {
  readonly seed: number;
  readonly userId: string;
  readonly timezone: string;
  readonly baseCurrency: string;
  readonly startMonth: DateOnly;
  readonly monthCount: number;
  readonly accounts: readonly SeedAccount[];
  readonly merchants: readonly SeedMerchant[];
  readonly transactions: readonly SeedTransaction[];
  readonly holdings: readonly SeedHolding[];
  readonly prices: readonly SeedPricePoint[];
  readonly labels: SeedLabels;
}
