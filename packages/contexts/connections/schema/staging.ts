// SPDX-License-Identifier: MIT
/**
 * `connection_staged_facts` — migration `0008_connections_staging.sql`.
 *
 * See that file's header for the design: one table, a `kind` discriminant that
 * splits it into upserted state (`account`, `balance`) and an append-only log
 * (`transaction_added`/`transaction_modified`/`transaction_removed`), and why
 * the dedupe key is `provider_transaction_id` rather than `fingerprint`.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db';
import { bigserial, index, jsonb, text, pgTable, uuid } from 'drizzle-orm/pg-core';

export const STAGED_FACT_KINDS = [
  'account',
  'balance',
  'transaction_added',
  'transaction_modified',
  'transaction_removed',
] as const;

export type StagedFactKind = (typeof STAGED_FACT_KINDS)[number];

export const connectionStagedFacts = pgTable(
  'connection_staged_facts',
  {
    /** Total order across every kind — the cursor `entriesAfter` reads against. */
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    id: idColumn(),
    userId: userIdColumn(),
    connectionId: uuid('connection_id').notNull(),
    kind: text('kind').$type<StagedFactKind>().notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    providerTransactionId: text('provider_transaction_id'),
    fingerprint: text('fingerprint'),
    amountMinor: amountMinorColumn('amount_minor'),
    amountCurrency: currencyColumn('amount_currency'),
    availableMinor: amountMinorColumn('available_minor'),
    availableCurrency: currencyColumn('available_currency'),
    limitMinor: amountMinorColumn('limit_minor'),
    limitCurrency: currencyColumn('limit_currency'),
    asOf: instantColumn('as_of'),
    fact: jsonb('fact').notNull().default({}),
    createdAt: createdAtColumn(),
  },
  (table) => [
    // The two partial unique indexes (added-dedupe, account/balance state) are
    // deliberately not declared here: this file is the query surface, not the
    // DDL (see the module comment on `schema/connections.ts`), and Drizzle's
    // query builder needs no index metadata to filter on `kind`. The migration
    // is where those constraints actually live and are enforced.
    index('connection_staged_facts_connection_seq_idx').on(table.connectionId, table.seq),
    index('connection_staged_facts_user_idx').on(table.userId),
  ],
);

export type ConnectionStagedFactRow = typeof connectionStagedFacts.$inferSelect;
export type NewConnectionStagedFactRow = typeof connectionStagedFacts.$inferInsert;
