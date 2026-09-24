// SPDX-License-Identifier: MIT
/**
 * `connection_sync_facts` — migration `0018_connection_sync_facts.sql`.
 *
 * The sibling of `connection_staged_facts`, and the two are easy to confuse:
 *
 *   * **staged** facts are *inbound and not yet applied* — what a
 *     process-local connector (Manual, CSV/OFX/QIF) accumulated during
 *     `connect()` and has not flushed through `syncTransactions` yet;
 *   * **sync** facts are the opposite end — what a *remote* provider's
 *     `holdings` / `investment_txns` / `liabilities` leg already observed and
 *     recorded, so a consumer in another context and another process can read
 *     it back by `sync_run_id`.
 *
 * One is a pending inbox, the other a published outbox. See the migration
 * header for why the row is keyed on the provider's natural key rather than on
 * the run, and why `sync_run_id` therefore means "last observed by".
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  idColumn,
  instantColumn,
  quantityColumn,
  rateColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { bigserial, index, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const SYNC_FACT_KINDS = ['holding', 'investment_transaction', 'liability'] as const;

export type SyncFactKind = (typeof SYNC_FACT_KINDS)[number];

export const connectionSyncFacts = pgTable(
  'connection_sync_facts',
  {
    /** Total order, the same role `connection_staged_facts.seq` plays. */
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    id: idColumn(),
    userId: userIdColumn(),
    connectionId: uuid('connection_id').notNull(),
    /** The run that *last observed* this fact. Not a provenance chain. */
    syncRunId: uuid('sync_run_id').notNull(),
    kind: text('kind').$type<SyncFactKind>().notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    /** Evidence, never identity (D25). Half of the holding natural key. */
    providerSecurityId: text('provider_security_id'),
    /** Plaid's `investment_transaction_id` — 01 §5.5's idempotency key. */
    providerTransactionId: text('provider_transaction_id'),
    fingerprint: text('fingerprint'),
    /** `NUMERIC(38,18)`, read back as a decimal string. Never a float (D3). */
    quantity: quantityColumn('quantity'),
    /** Unit price, `NUMERIC(20,10)`. This gets multiplied and summed. */
    price: rateColumn('price'),
    /** A percentage as an exact decimal. Not money. */
    apr: numeric('apr', { precision: 9, scale: 6, mode: 'string' }),
    /** The institution's own valuation. Reconciliation only. */
    valueMinor: amountMinorColumn('value_minor'),
    valueCurrency: currencyColumn('value_currency'),
    /** As reported, and a fallback — see the migration header and 01 §5.5. */
    costBasisMinor: amountMinorColumn('cost_basis_minor'),
    costBasisCurrency: currencyColumn('cost_basis_currency'),
    amountMinor: amountMinorColumn('amount_minor'),
    amountCurrency: currencyColumn('amount_currency'),
    feesMinor: amountMinorColumn('fees_minor'),
    feesCurrency: currencyColumn('fees_currency'),
    transactionDate: dateColumn('transaction_date'),
    statementBalanceMinor: amountMinorColumn('statement_balance_minor'),
    statementBalanceCurrency: currencyColumn('statement_balance_currency'),
    minimumPaymentMinor: amountMinorColumn('minimum_payment_minor'),
    minimumPaymentCurrency: currencyColumn('minimum_payment_currency'),
    nextPaymentDue: dateColumn('next_payment_due'),
    asOf: instantColumn('as_of'),
    fact: jsonb('fact').notNull().default({}),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // The three partial unique indexes are deliberately not declared here:
    // this file is the query surface, not the DDL (see `schema/staging.ts`),
    // and Drizzle's `onConflictDoUpdate` names its target columns and a
    // `targetWhere` predicate rather than an index object.
    index('connection_sync_facts_run_idx').on(table.syncRunId, table.kind),
    index('connection_sync_facts_user_idx').on(table.userId),
  ],
);

export type ConnectionSyncFactRow = typeof connectionSyncFacts.$inferSelect;
export type NewConnectionSyncFactRow = typeof connectionSyncFacts.$inferInsert;
