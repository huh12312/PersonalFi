// SPDX-License-Identifier: MIT
/**
 * `holdings` and `holdings_snapshots` — migration `0014_lots.sql`.
 *
 * See that file's header for the design. The one thing worth repeating here,
 * because it is the difference between a correct number and a confident wrong
 * one: `costBasisMinor` is **nullable and a NULL is not a zero**. 04 §5.5 —
 * "where basis is unknown, report unrealized gain as *unavailable* rather than
 * computing it from a zero basis" — and Plaid's basis is, per that same
 * section, "frequently absent or wrong after an ACATS transfer".
 *
 * This file is the *query surface*, not the DDL. Indexes and CHECK constraints
 * live in the migration; the `unique()` markers below exist only because
 * Drizzle's `onConflictDoUpdate` needs a target expression.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  flagColumn,
  idColumn,
  quantityColumn,
  rateColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Where a cost basis came from.
 *
 * `BROKER` is the provider's own exact figure. `IMPORTED` is a CSV export —
 * which the measured R6 verdict (docs/evidence/phase-3/wp3.5-coinbase.md §1)
 * makes the *plan of record* for every Coinbase movement that is not an
 * Advanced Trade fill, so it is a first-class source and not a fallback.
 * `USER` is a correction a sync may never overwrite. `ESTIMATED` is the honest
 * admission that nobody knows, and it always travels with a warning.
 * `SAFE_HARBOR_ALLOC` is Rev. Proc. 2024-28's allocation of previously-universal
 * digital-asset basis to a specific wallet — a provenance in its own right,
 * because recording it as `USER` would lose the one fact that makes the
 * allocation defensible.
 */
export const BASIS_SOURCES = [
  'BROKER',
  'IMPORTED',
  'USER',
  'ESTIMATED',
  'SAFE_HARBOR_ALLOC',
] as const;
export type BasisSource = (typeof BASIS_SOURCES)[number];

export const holdings = pgTable(
  'holdings',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** Opaque. `@ctx/ledger` owns `accounts`; this context may not join it. */
    accountId: uuid('account_id').notNull(),
    securityId: uuid('security_id').notNull(),

    /** Signed: a short position is negative. `NUMERIC(38,18)`, a decimal string. */
    quantity: quantityColumn('quantity').notNull(),

    /** What the institution says the position is worth. An assertion, not a computation. */
    institutionValueMinor: amountMinorColumn('institution_value_minor').notNull(),
    currency: currencyColumn().notNull(),

    /** NULL = the provider reported no basis. Not zero. See the file header. */
    costBasisMinor: amountMinorColumn('cost_basis_minor'),
    costBasisPerUnit: rateColumn('cost_basis_per_unit'),
    /** 04 §5.5: a sync may never overwrite the row when this is true. */
    costBasisIsUserSupplied: flagColumn('cost_basis_is_user_supplied').notNull(),
    costBasisSource: text('cost_basis_source').$type<BasisSource>(),

    asOfDate: dateColumn('as_of_date').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('holdings_user_account_security_uniq').on(
      table.userId,
      table.accountId,
      table.securityId,
    ),
  ],
);

export const holdingsSnapshots = pgTable(
  'holdings_snapshots',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id').notNull(),
    securityId: uuid('security_id').notNull(),

    asOfDate: dateColumn('as_of_date').notNull(),
    quantity: quantityColumn('quantity').notNull(),
    institutionValueMinor: amountMinorColumn('institution_value_minor').notNull(),
    currency: currencyColumn().notNull(),
    costBasisMinor: amountMinorColumn('cost_basis_minor'),

    createdAt: createdAtColumn(),
  },
  (table) => [
    unique('holdings_snapshots_day_uniq').on(
      table.userId,
      table.accountId,
      table.securityId,
      table.asOfDate,
    ),
  ],
);

export type HoldingRow = typeof holdings.$inferSelect;
export type NewHoldingRow = typeof holdings.$inferInsert;
export type HoldingSnapshotRow = typeof holdingsSnapshots.$inferSelect;
export type NewHoldingSnapshotRow = typeof holdingsSnapshots.$inferInsert;
