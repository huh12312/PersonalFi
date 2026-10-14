// SPDX-License-Identifier: MIT
/**
 * `unresolved_holdings` — migration `0043_provider_credentials_market_data.sql`
 * (WP 10.4).
 *
 * A position a sync reported whose security the resolver could not identify.
 * `holdings.security_id` is NOT NULL and every reader joins `securities`, so
 * such a position had nowhere to live and was invisible; this is its read
 * model. The lot consumer **replaces** an account's rows (for the run's
 * provider) on every run that reported holdings for the account, so a security
 * that resolves on a later sync is simply not re-inserted and its row is gone.
 *
 * Display only. Never valued from a price, never in allocation or performance;
 * the routes name each row in their `excluded` lists. Not exported (a derived
 * read model the next sync rebuilds).
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  idColumn,
  instantColumn,
  quantityColumn,
  userIdColumn,
} from '@core/db';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/** One tier's abstention, as `@ctx/investments`' `TierAbstention` writes it. */
export interface StoredAbstention {
  readonly tier: string;
  readonly reason: string;
  readonly detail: string | null;
}

export const unresolvedHoldings = pgTable(
  'unresolved_holdings',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** Opaque: `@ctx/ledger` owns `accounts`. */
    accountId: uuid('account_id').notNull(),
    provider: text('provider').notNull(),
    providerSecurityId: text('provider_security_id'),
    name: text('name'),
    ticker: text('ticker'),
    quantity: quantityColumn('quantity').notNull(),
    /** The institution's own figure, as reported. NULL when it gave none. */
    institutionValueMinor: amountMinorColumn('institution_value_minor'),
    currency: currencyColumn().notNull(),
    abstentions: jsonb('abstentions').$type<readonly StoredAbstention[]>().notNull(),
    /** Opaque: `@ctx/connections` owns `sync_runs`. */
    syncRunId: text('sync_run_id'),
    asOfDate: dateColumn('as_of_date').notNull(),
    observedAt: instantColumn('observed_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [index('unresolved_holdings_user_account_idx').on(table.userId, table.accountId)],
);

export type UnresolvedHoldingRow = typeof unresolvedHoldings.$inferSelect;
export type NewUnresolvedHoldingRow = typeof unresolvedHoldings.$inferInsert;
