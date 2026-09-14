// SPDX-License-Identifier: MIT
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { confidenceColumn } from './confidence.ts';
import { accounts } from './accounts.ts';
import { merchants } from './merchants.ts';

/**
 * Immutable provider facts.
 *
 * One row per provider revision of one transaction. Sync writes here and nothing
 * else does; a user edit never touches this table. `raw` keeps the verbatim
 * payload, which buys free auditability ("what did Plaid say last Tuesday"), free
 * replay of derived data after an algorithm fix, and somewhere to find the field
 * we did not think to model in Phase 1.
 *
 * The sign convention is the house one — negative = outflow — because the adapter
 * normalised it at the edge. Plaid's own convention is the opposite and it never
 * reaches this table.
 */
export const transactionsProvider = pgTable(
  'transactions_provider',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerTransactionId: text('provider_transaction_id').notNull(),
    /**
     * Plaid's link from a posted transaction back to the pending one it replaces.
     * NULL when the institution supplies no pending data or the match failed —
     * which is when the fuzzy path in `applyProviderTransactions` takes over.
     */
    pendingTransactionId: text('pending_transaction_id'),
    amountMinor: amountMinorColumn('amount_minor').notNull(),
    currency: currencyColumn().notNull(),
    /** The provider's own currency string, verbatim, for reconciliation. */
    isoCurrency: text('iso_currency'),
    /** When it settled. Plaid's `date`. Always present. */
    postedDate: dateColumn('posted_date').notNull(),
    /** When the card was swiped. Often NULL. */
    authorizedDate: dateColumn('authorized_date'),
    /** Genuine instants, frequently NULL. Never conflated with the DATEs above. */
    postedAt: instantColumn('posted_at'),
    authorizedAt: instantColumn('authorized_at'),
    name: text('name').notNull(),
    merchantName: text('merchant_name'),
    originalDescription: text('original_description'),
    paymentChannel: text('payment_channel'),
    /**
     * The provider's taxonomy verbatim (Plaid `personal_finance_category`). An
     * immutable *source* field: our own category lives in the overlay, so a Plaid
     * taxonomy revision cannot shift budget history under us (01 §5.4).
     */
    providerCategory: jsonb('provider_category'),
    pending: flagColumn('pending').notNull(),
    location: jsonb('location'),
    counterparties: jsonb('counterparties'),
    raw: jsonb('raw').notNull(),
    /**
     * Idempotency layer 2 (04 §4.4). A `modified` whose hash matches the current
     * fact bumps `lastSeenAt` and writes nothing else. Plaid re-sends unchanged
     * rows often; without this the fact table grows without bound and the audit
     * trail becomes noise.
     */
    contentHash: text('content_hash').notNull(),
    revision: integer('revision').notNull().default(1),
    firstSeenAt: instantColumn('first_seen_at').notNull(),
    lastSeenAt: instantColumn('last_seen_at').notNull(),
    /** Provider tombstone. A `removed[]` id writes this, never a DELETE. */
    removedAt: instantColumn('removed_at'),
    /**
     * The posted fact that took this pending fact's place. Audit trail for the
     * identity migration; the user-facing `transactions` row did not move.
     */
    supersededById: uuid('superseded_by_id'),
  },
  (table) => [
    // Idempotency layer 1. Unique *per account*, so two providers reusing an
    // opaque id on different accounts cannot collide.
    uniqueIndex('transactions_provider_natural_key_idx').on(
      table.accountId,
      table.provider,
      table.providerTransactionId,
    ),
    index('transactions_provider_pending_link_idx').on(table.accountId, table.pendingTransactionId),
    index('transactions_provider_account_date_idx').on(table.accountId, table.postedDate),
  ],
);

/**
 * The stable user-facing row.
 *
 * Its `id` is a UUIDv7 generated app-side and **it survives the pending → posted
 * transition**: only `currentFactId` advances from the pending fact to the posted
 * one. That is decision D10 and the single highest-value invariant in the schema —
 * splits, notes, categories, exclusions, budget assignments and recurring-series
 * memberships all hang off this id, and all of them evaporate if it changes when
 * a charge settles.
 *
 * Three groups of columns, and confusing them is the bug this design prevents:
 *
 *   * `currentFactId` — the pointer into immutable provider truth;
 *   * `user*` — sparse overlay. NULL means "the user has not spoken";
 *   * `effective*` — a denormalised projection of the two, written *only* by
 *     `resolveEffective()`. Rebuildable at any time, never hand-edited. A test
 *     asserts every stored row equals that function's output.
 */
export const transactions = pgTable(
  'transactions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    currentFactId: uuid('current_fact_id')
      .notNull()
      .references(() => transactionsProvider.id),

    // --- effective projection ------------------------------------------------
    /** `COALESCE(authorized_date, posted_date)` — the swipe is when it was felt (04 §2.4). */
    effectiveDate: dateColumn('effective_date').notNull(),
    effectiveAmountMinor: amountMinorColumn('effective_amount_minor').notNull(),
    effectiveCurrency: currencyColumn('effective_currency').notNull(),
    effectiveName: text('effective_name').notNull(),
    effectiveMerchantId: uuid('effective_merchant_id').references(() => merchants.id, {
      onDelete: 'set null',
    }),
    pending: flagColumn('pending').notNull(),

    // --- user overlay --------------------------------------------------------
    userNote: text('user_note'),
    userExcluded: flagColumn('user_excluded').notNull().default(false),
    /**
     * Opaque on purpose. `@ctx/categorization` owns `categories`; a foreign key
     * here would be Ledger reaching into another context's table (decision D8),
     * and Ledger must not care what a category *is*.
     */
    userCategoryId: uuid('user_category_id'),
    userMerchantName: text('user_merchant_name'),

    // --- ledger-derived ------------------------------------------------------
    isTransfer: flagColumn('is_transfer').notNull().default(false),
    transferLinkId: uuid('transfer_link_id'),
    /**
     * A refund *hint*, never an automatic net. Marking a refund and silently
     * subtracting it are different products, and the second one loses a user's
     * trust the first time it guesses wrong.
     */
    refundOfId: uuid('refund_of_id'),
    refundConfidence: confidenceColumn('refund_confidence'),
    /** Cross-provider duplicate: this row duplicates that one. Marked, never deleted. */
    supersededById: uuid('superseded_by_id'),
    supersededReason: text('superseded_reason').$type<'duplicate' | 'merged'>(),
    /**
     * Provider tombstone. Soft, because `removed[]` and the `added[]` that
     * supersedes it are not ordered relative to each other — a hard delete here
     * destroys an overlay a later page was about to reclaim.
     */
    removedAt: instantColumn('removed_at'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // One user-facing row per provider fact. This is what makes the apply path
    // idempotent at the identity level: re-pointing is an UPDATE, never a second
    // INSERT.
    uniqueIndex('transactions_current_fact_idx').on(table.currentFactId),
    index('transactions_feed_idx').on(table.userId, table.effectiveDate, table.id),
    index('transactions_account_feed_idx').on(table.accountId, table.effectiveDate, table.id),
    index('transactions_merchant_idx').on(
      table.userId,
      table.effectiveMerchantId,
      table.effectiveDate,
    ),
    index('transactions_pending_idx').on(table.userId, table.effectiveDate),
    index('transactions_effective_name_trgm_idx').on(table.effectiveName),
    index('transactions_refund_of_idx').on(table.refundOfId),
    index('transactions_superseded_idx').on(table.supersededById),
  ],
);

/**
 * A user's division of one transaction across several categories.
 *
 * Pure user intent; sync never writes here. Splits must sum to the parent, and
 * `Money.allocate` (largest remainder) is what makes a three-way split of $10 come
 * out 3.34 / 3.33 / 3.33 with no cent lost. The sum is enforced in the application
 * rather than by a trigger: a per-row trigger would make an intermediate state of
 * a legitimate multi-row edit illegal.
 */
export const transactionSplits = pgTable(
  'transaction_splits',
  {
    id: idColumn(),
    userId: userIdColumn(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    amountMinor: amountMinorColumn('amount_minor').notNull(),
    currency: currencyColumn().notNull(),
    /** Opaque, same reasoning as `transactions.userCategoryId`. */
    userCategoryId: uuid('user_category_id'),
    note: text('note'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('transaction_splits_position_idx').on(table.transactionId, table.position),
    index('transaction_splits_transaction_idx').on(table.transactionId),
  ],
);

export type TransactionProviderRow = typeof transactionsProvider.$inferSelect;
export type NewTransactionProviderRow = typeof transactionsProvider.$inferInsert;
export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;
export type TransactionSplitRow = typeof transactionSplits.$inferSelect;
export type NewTransactionSplitRow = typeof transactionSplits.$inferInsert;
