// SPDX-License-Identifier: MIT
/**
 * `investment_transactions` — migration `0014_lots.sql`.
 *
 * Idempotent on the provider's natural key, per account. 01 §5.5 records that
 * there is no `/investments/transactions/sync`: these arrive by **date window**,
 * the window is re-fetched next run, and the UNIQUE (user_id, account_id,
 * provider, provider_transaction_id) is what makes that harmless. There is no
 * cursor column, deliberately — `@connector/port`'s `syncInvestmentTransactions`
 * returns an array rather than a `TransactionPage` for the same reason.
 *
 * ## `type` is the house vocabulary, not the provider's
 *
 * Plaid says `buy`; Coinbase says `BUY` on an Advanced Trade fill and, per the
 * measured R6 verdict, says *nothing at all* for a deposit, a withdrawal, a
 * staking reward or a transfer — those come from the CSV export, where the same
 * facts are spelled `Deposit`, `Withdrawal`, `Staking Income` and `Send`.
 * Normalising at the adapter boundary is the same discipline the house sign
 * convention follows (04 §2.3), and it is the reason there is one lot engine
 * rather than one per provider. `subtype` keeps the provider's own word as
 * evidence; nothing switches on it.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  idColumn,
  quantityColumn,
  rateColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * The normalised movement vocabulary.
 *
 * `TRANSFER_IN`/`TRANSFER_OUT` are the two the crypto path leans on hardest:
 * 07 §6.2 calls a mishandled self-transfer "the single most common source of
 * wrong crypto tax numbers", and the fix is that a transfer is a *carry*, never
 * a disposal and never income.
 */
export const INVESTMENT_TRANSACTION_TYPES = [
  'BUY',
  'SELL',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'DIVIDEND',
  'REINVESTED_DIVIDEND',
  'INTEREST',
  'STAKING_REWARD',
  'AIRDROP',
  'MINING',
  'FORK',
  'GIFT_IN',
  'FEE',
  'CASH',
  'SPLIT',
  'OTHER',
] as const;
export type InvestmentTransactionType = (typeof INVESTMENT_TRANSACTION_TYPES)[number];

/**
 * How the row reached us, and therefore what a lot it opens may claim.
 *
 * The R6 verdict makes `BROKER` and `IMPORTED` co-exist on one account: the
 * Advanced Trade fill is exact, and the deposit beside it is a CSV row. The lot
 * engine must accept both legs and invent basis for neither.
 */
export const TRANSACTION_SOURCES = ['BROKER', 'IMPORTED', 'USER'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const investmentTransactions = pgTable(
  'investment_transactions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id').notNull(),
    /** NULL for a cash sweep, a fee or a deposit — all real, none about a security. */
    securityId: uuid('security_id'),

    provider: text('provider').notNull(),
    /** Plaid's `investment_transaction_id`, Coinbase's fill id, a CSV row key. */
    providerTransactionId: text('provider_transaction_id').notNull(),

    type: text('type').$type<InvestmentTransactionType>().notNull(),
    /** The provider's own word, verbatim. Evidence for a mapping review. */
    subtype: text('subtype'),
    name: text('name'),

    /** Signed as the provider reports it: negative on a disposal. */
    quantity: quantityColumn('quantity').notNull(),
    /** Unit price, `NUMERIC(20,10)`. NULL when nobody stated one. */
    price: rateColumn('price'),
    /** House sign convention: negative = money left the account. */
    amountMinor: amountMinorColumn('amount_minor').notNull(),
    feesMinor: amountMinorColumn('fees_minor').notNull(),
    currency: currencyColumn().notNull(),

    tradeDate: dateColumn('trade_date').notNull(),
    settleDate: dateColumn('settle_date'),

    source: text('source').$type<TransactionSource>().notNull(),
    fingerprint: text('fingerprint'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('investment_transactions_provider_key_uniq').on(
      table.userId,
      table.accountId,
      table.provider,
      table.providerTransactionId,
    ),
  ],
);

export type InvestmentTransactionRow = typeof investmentTransactions.$inferSelect;
export type NewInvestmentTransactionRow = typeof investmentTransactions.$inferInsert;
