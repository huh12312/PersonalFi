// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/planning`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — this file
 * is the *type*, `0017_net_worth_daily.sql` is the *schema*, and
 * `pnpm lint:schema-ownership` is what keeps one table from being claimed by two
 * packages.
 *
 * `net_worth_daily` here; WP 4.1's four goal tables in `goals.ts`; WP 4.2's
 * `plan_assumptions` in `assumptions.ts`. `plan_scenarios`, `projection_runs` and the rest of
 * Planning's claims in OWNERSHIP.md are Phase 4's, and are still claims.
 */
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
import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Daily net worth, one row per user x date x revision.
 *
 * The constraints that carry the load — the sealed-row trigger, the partial
 * unique index on the open day, and `net_worth_breakdown_is_well_formed` — live
 * in the migration and have no Drizzle expression. That asymmetry is why the
 * migration is hand-written: a CHECK calling an IMMUTABLE function over a JSONB
 * array is not something an ORM should be inventing, and the trigger is not
 * something it can express at all.
 */
export const netWorthDaily = pgTable('net_worth_daily', {
  id: idColumn(),
  userId: userIdColumn(),
  asOfDate: dateColumn('as_of_date').notNull(),
  revision: integer('revision').notNull().default(1),
  baseCurrency: currencyColumn('base_currency').notNull(),
  assetsMinor: amountMinorColumn('assets_minor').notNull(),
  liabilitiesMinor: amountMinorColumn('liabilities_minor').notNull(),
  netWorthMinor: amountMinorColumn('net_worth_minor').notNull(),
  liquidMinor: amountMinorColumn('liquid_minor').notNull(),
  investableMinor: amountMinorColumn('investable_minor').notNull(),
  onBudgetMinor: amountMinorColumn('on_budget_minor').notNull(),
  breakdown: jsonb('breakdown').notNull(),
  source: text('source').notNull(),
  stalePrice: flagColumn('stale_price').notNull().default(false),
  accountsCounted: integer('accounts_counted').notNull(),
  accountsUnvalued: integer('accounts_unvalued').notNull(),
  dirty: flagColumn('dirty').notNull().default(false),
  sealedAt: instantColumn('sealed_at'),
  supersedesId: uuid('supersedes_id'),
  correctionReason: text('correction_reason'),
  computedAt: instantColumn('computed_at').notNull().defaultNow(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

/** `observed` | `interpolated` | `corrected` (04 §5.4, 08 §3.5). */
export const NET_WORTH_SOURCES = ['observed', 'interpolated', 'corrected'] as const;
export type NetWorthSource = (typeof NET_WORTH_SOURCES)[number];

export * from './goals.ts';
export * from './assumptions.ts';
export * from './projections.ts';
