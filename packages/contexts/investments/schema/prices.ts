// SPDX-License-Identifier: MIT
/**
 * `prices`, `fx_rates` and `price_source_priority` — migration
 * `0015_market_data.sql`.
 *
 * See that file's header for the design: why staleness is not stored, why
 * `last_known` is absent from `prices.source` (07 §6.1 — "never recompute
 * history from today's price"), and why `base_currency <> quote_currency` is
 * the schema's contribution to "a missing FX rate is never a silent 1.0".
 *
 * This file is the *query surface*, not the DDL. Indexes and `CHECK`
 * constraints live in the migration, which is the one ordered, forward-only
 * history of the database; declaring them twice is how the two drift apart.
 * The `unique()` markers below are the exception and exist only because
 * Drizzle's `onConflictDoUpdate` needs a target expression.
 */
import {
  createdAtColumn,
  currencyColumn,
  dateColumn,
  flagColumn,
  idColumn,
  instantColumn,
  rateColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * The rungs of 07 §6.1's ladder, strongest first.
 *
 * Stated once, here, and consumed by `src/prices.ts`. The ordering in this
 * array **is** the default ladder: `user override > exchange fill > provider >
 * last known`, with the provider rungs in D17's order (Tiingo the default for
 * equities and funds, CoinGecko for crypto, `yfinance` last because 01 §4.2
 * says it ships opt-in and best-effort or not at all).
 */
export const PRICE_SOURCES = [
  'user_override',
  'exchange_fill',
  'tiingo',
  'coingecko',
  'fred',
  'yfinance',
  'last_known',
] as const;
export type PriceSourceName = (typeof PRICE_SOURCES)[number];

/**
 * The sources that may appear on a stored `prices` row.
 *
 * `last_known` is absent and that absence is the control. It is a *read-time
 * label* — "no row for this date, so the most recent earlier row was carried
 * forward" — and writing it back would be exactly the "recompute history from
 * today's price" that 07 §6.1 forbids. The CHECK
 * `prices_source_is_an_observation` is the database half; `src/prices.test.ts`
 * → 'a carry-forward is a label, never a written row' is the other.
 *
 * `fred` is absent too, for a duller reason: FRED publishes macro series and FX,
 * not security closes.
 */
export const PRICE_ROW_SOURCES = [
  'user_override',
  'exchange_fill',
  'tiingo',
  'coingecko',
  'yfinance',
] as const;
export type PriceRowSource = (typeof PRICE_ROW_SOURCES)[number];

/** The sources that may appear on a stored `fx_rates` row. FRED is the default. */
export const FX_ROW_SOURCES = ['user_override', 'fred', 'tiingo', 'coingecko'] as const;
export type FxRowSource = (typeof FX_ROW_SOURCES)[number];

/**
 * A daily close per security, per source, per quote currency.
 *
 * `close` is `NUMERIC(20,10)` read back as a decimal string, never a float
 * (D3). `observed_at` — not a stored boolean — is what 07 §6.1's 24-hour
 * staleness rule is computed from, because staleness is a statement about
 * *now* and a boolean written yesterday would still read as authoritative
 * today.
 */
export const prices = pgTable(
  'prices',
  {
    id: idColumn(),
    userId: userIdColumn(),
    securityId: uuid('security_id').notNull(),
    priceDate: dateColumn('price_date').notNull(),
    source: text('source').$type<PriceRowSource>().notNull(),
    close: rateColumn('close').notNull(),
    currency: currencyColumn().notNull(),
    /** The provider served a carry-forward, not a close. Not the 24-hour rule. */
    stale: flagColumn('stale').notNull().default(false),
    /** When the provider answered. The input to the 24-hour rule. */
    observedAt: instantColumn('observed_at').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique().on(table.userId, table.securityId, table.priceDate, table.source, table.currency),
  ],
);

export type PriceRow = typeof prices.$inferSelect;
export type NewPriceRow = typeof prices.$inferInsert;

/**
 * One rate per pair per date per source: **1 `base_currency` = `rate`
 * `quote_currency`**.
 *
 * The direction is stated in the column comment as well as here because getting
 * it backwards is the FX bug that is not caught by any test that only checks
 * "a number came out". `FxReader` inverts a stored pair rather than storing
 * both directions, so there is one row to be wrong about rather than two.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: idColumn(),
    userId: userIdColumn(),
    baseCurrency: currencyColumn('base_currency').notNull(),
    quoteCurrency: currencyColumn('quote_currency').notNull(),
    rateDate: dateColumn('rate_date').notNull(),
    source: text('source').$type<FxRowSource>().notNull(),
    rate: rateColumn('rate').notNull(),
    observedAt: instantColumn('observed_at').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique().on(
      table.userId,
      table.baseCurrency,
      table.quoteCurrency,
      table.rateDate,
      table.source,
    ),
  ],
);

export type FxRateRow = typeof fxRates.$inferSelect;
export type NewFxRateRow = typeof fxRates.$inferInsert;

/**
 * 07 §6.1's ladder as rows, per security kind, user-editable (§6 of the
 * dispatch).
 *
 * Two rungs are pinned by CHECK in the migration rather than by convention here:
 * `user_override` must be rung 1 and `last_known` must be rung 99. A user
 * override that is not first is not an override, and a carry-forward that is
 * not last would shadow a real quote with a stale one.
 */
export const priceSourcePriority = pgTable(
  'price_source_priority',
  {
    id: idColumn(),
    userId: userIdColumn(),
    securityKind: text('security_kind').notNull(),
    rung: smallint('rung').notNull(),
    source: text('source').$type<PriceSourceName>().notNull(),
    enabled: flagColumn('enabled').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [unique().on(table.userId, table.securityKind, table.source)],
);

export type PriceSourcePriorityRow = typeof priceSourcePriority.$inferSelect;
export type NewPriceSourcePriorityRow = typeof priceSourcePriority.$inferInsert;
