// SPDX-License-Identifier: MIT
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The account types the ledger models. `manual` is a first-class citizen, not a
 * fallback: a paid-off car, a savings bond and a loan from a relative all belong
 * in net worth and none of them has a provider.
 */
export const ACCOUNT_TYPES = [
  'depository',
  'credit',
  'loan',
  'investment',
  'crypto',
  'manual',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Which side of net worth an account contributes to. */
export const ACCOUNT_CLASSIFICATIONS = ['asset', 'liability'] as const;
export type AccountClassification = (typeof ACCOUNT_CLASSIFICATIONS)[number];

/** Where a balance observation came from. `derived` is a reconstruction, and says so. */
export const BALANCE_SOURCES = ['provider', 'manual', 'derived'] as const;
export type BalanceSource = (typeof BALANCE_SOURCES)[number];

/**
 * What money sits in, wherever it came from.
 *
 * `connectionId` is nullable and carries no foreign key. Nullable because a manual
 * account has no provider behind it; no FK because `connections` is owned by
 * `@ctx/connections` and a context may not constrain another context's table.
 * Ledger has no idea Plaid exists, and that asymmetry is what makes "swap the
 * aggregator" a one-context change (08 §1.3).
 */
export const accounts = pgTable(
  'accounts',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** NULL for a manual account. Opaque here; owned by `@ctx/connections`. */
    connectionId: uuid('connection_id'),
    provider: text('provider').notNull(),
    /** The provider's natural key, kept separate from our UUIDv7 id (decision D10). */
    providerAccountId: text('provider_account_id').notNull(),
    name: text('name').notNull(),
    officialName: text('official_name'),
    type: text('type').$type<AccountType>().notNull(),
    /** Provider vocabulary (`checking`, `401k`, ...). Unconstrained: it changes without notice. */
    subtype: text('subtype'),
    classification: text('classification').$type<AccountClassification>().notNull(),
    currency: currencyColumn().notNull(),
    /** Last 2-4 digits. Never the full number; it is neither needed nor safe to hold. */
    mask: text('mask'),
    closedAt: instantColumn('closed_at'),
    includeInNetWorth: flagColumn('include_in_net_worth').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('accounts_provider_key_idx').on(
      table.userId,
      table.provider,
      table.providerAccountId,
    ),
    index('accounts_user_open_idx').on(table.userId),
    index('accounts_connection_idx').on(table.connectionId),
  ],
);

/**
 * Point-in-time balances, append-only.
 *
 * Not a mutable `current_balance` column on `accounts`, for three reasons that
 * each cost a bug the first time they are ignored: every balance in the UI has to
 * answer "as of when?" (04 §4.5); a net-worth series is built from observations,
 * not from whatever the last sync left behind; and a provider reporting a stale
 * figure must not silently overwrite a fresher manual one.
 *
 * Sign: `currentMinor` is the account's *contribution to net worth*, so a credit
 * card you owe $420 on stores `-42000n`. `limitMinor` is a magnitude and stays
 * positive — a credit limit is not money you have or owe.
 */
export const accountBalances = pgTable(
  'account_balances',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    currentMinor: amountMinorColumn('current_minor').notNull(),
    availableMinor: amountMinorColumn('available_minor'),
    limitMinor: amountMinorColumn('limit_minor'),
    currency: currencyColumn().notNull(),
    asOf: instantColumn('as_of').notNull(),
    source: text('source').$type<BalanceSource>().notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    // Replaying a sync page must be a no-op (04 §4.4, idempotency layer 1).
    uniqueIndex('account_balances_observation_idx').on(table.accountId, table.asOf, table.source),
    index('account_balances_latest_idx').on(table.accountId, table.asOf),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
export type AccountBalanceRow = typeof accountBalances.$inferSelect;
export type NewAccountBalanceRow = typeof accountBalances.$inferInsert;
