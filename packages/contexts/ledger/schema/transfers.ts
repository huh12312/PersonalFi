// SPDX-License-Identifier: MIT
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { confidenceColumn } from './confidence.ts';
import { accounts } from './accounts.ts';
import { transactions } from './transactions.ts';

/** How a pair was matched. Kept so the confidence score is explicable to a user. */
export const TRANSFER_MATCH_KINDS = [
  'exact_amount_same_day',
  'exact_amount_near_date',
  'amount_within_tolerance',
  'user_confirmed',
] as const;
export type TransferMatchKind = (typeof TRANSFER_MATCH_KINDS)[number];

/**
 * A paired internal transfer.
 *
 * Money moving between two accounts you own is double-counted by construction
 * when both are linked: once as an outflow, once as an inflow. Phase 1's exit
 * criterion is "spend totals contain zero internal transfers", and this is how.
 *
 * The evidence for the match is stored alongside it, because the honest answer to
 * "why did you decide these two rows were one movement?" is a product requirement,
 * not a debugging nicety.
 */
export const transferLinks = pgTable(
  'transfer_links',
  {
    id: idColumn(),
    userId: userIdColumn(),
    outflowTransactionId: uuid('outflow_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    inflowTransactionId: uuid('inflow_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    /** The magnitude moved, stored positive: a transfer as a whole has no direction. */
    amountMinor: amountMinorColumn('amount_minor').notNull(),
    currency: currencyColumn().notNull(),
    dayGap: integer('day_gap').notNull(),
    confidence: confidenceColumn('confidence').notNull(),
    howMatched: text('how_matched').$type<TransferMatchKind>().notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    // A transaction belongs to at most one pair, on either side. Two unique
    // indexes rather than application discipline: "already paired" is the
    // precondition the pairing algorithm is most likely to get wrong.
    uniqueIndex('transfer_links_outflow_idx').on(table.outflowTransactionId),
    uniqueIndex('transfer_links_inflow_idx').on(table.inflowTransactionId),
    index('transfer_links_user_idx').on(table.userId),
  ],
);

/**
 * The user said no, and it must stay no.
 *
 * Without this table the heuristic re-proposes the pair it was told to drop on
 * every single sync, which is the most annoying behaviour a finance app can have.
 * A negative decision is data. The pair is stored in canonical (lower, higher) id
 * order so "did they reject this?" is one index lookup rather than two.
 */
export const rejectedTransferPairs = pgTable(
  'rejected_transfer_pairs',
  {
    id: idColumn(),
    userId: userIdColumn(),
    lowTransactionId: uuid('low_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    highTransactionId: uuid('high_transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    rejectedAt: instantColumn('rejected_at').notNull(),
  },
  (table) => [
    uniqueIndex('rejected_transfer_pairs_key_idx').on(
      table.userId,
      table.lowTransactionId,
      table.highTransactionId,
    ),
  ],
);

/**
 * A provider-agnostic fingerprint, for spotting the same real-world transaction
 * arriving through two different providers.
 *
 * Provider ids are provider-specific, so a bank linked through both Plaid and a
 * CSV import produces two rows for one purchase and every aggregate is wrong. The
 * key deliberately excludes the provider and the provider id: date, amount,
 * currency, normalised name. The hash is a bucketing device that makes the lookup
 * one fixed-width index probe; the components are stored beside it so a candidate
 * is verified exactly rather than trusted on a hash match.
 *
 * Detection *marks* (`transactions.supersededById`); it never merges. 01 §5.2 is
 * explicit: under-merging is a UI annoyance, over-merging is data loss.
 */
export const ledgerDedupKeys = pgTable(
  'ledger_dedup_keys',
  {
    id: idColumn(),
    userId: userIdColumn(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** `sha256(postedDate | amountMinor | currency | nameKey)`, first 16 bytes hex. */
    dedupKey: text('dedup_key').notNull(),
    nameKey: text('name_key').notNull(),
    postedDate: dateColumn('posted_date').notNull(),
    amountMinor: amountMinorColumn('amount_minor').notNull(),
    currency: currencyColumn().notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('ledger_dedup_keys_transaction_idx').on(table.transactionId),
    index('ledger_dedup_keys_lookup_idx').on(table.userId, table.dedupKey),
  ],
);

export type TransferLinkRow = typeof transferLinks.$inferSelect;
export type NewTransferLinkRow = typeof transferLinks.$inferInsert;
export type RejectedTransferPairRow = typeof rejectedTransferPairs.$inferSelect;
export type LedgerDedupKeyRow = typeof ledgerDedupKeys.$inferSelect;
export type NewLedgerDedupKeyRow = typeof ledgerDedupKeys.$inferInsert;
