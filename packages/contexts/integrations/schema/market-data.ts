// SPDX-License-Identifier: MIT
/**
 * `market_data_runs` — migration `0015_market_data.sql`.
 *
 * One row per outbound market-data call: what we asked a provider for, what it
 * cost against that provider's *published* budget, and what came back. See the
 * migration's header for why the spend has to be durable (a budget that resets
 * on a worker restart is a budget that hammers a provider at 03:46) and why no
 * column here holds a credential.
 *
 * This file is the query surface, not the DDL: the `CHECK` constraints live in
 * the migration.
 */
import { createdAtColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

/** Every provider this context may speak to. One host each; see `src/egress.ts`. */
export const MARKET_DATA_PROVIDERS = [
  'tiingo',
  'fred',
  'coingecko',
  'openfigi',
  'yfinance',
] as const;
export type MarketDataProvider = (typeof MARKET_DATA_PROVIDERS)[number];

/** What a run was for. `test_fetch` is the settings screen's "does my key work?". */
export const MARKET_DATA_OPERATIONS = [
  'price_refresh',
  'fx_refresh',
  'macro_series',
  'symbol_search',
  'figi_map',
  'test_fetch',
] as const;
export type MarketDataOperation = (typeof MARKET_DATA_OPERATIONS)[number];

/**
 * How a run ended.
 *
 * `skipped_no_key` is a first-class outcome rather than a failure: §6 of the
 * dispatch says every adapter "degrades to 'no price, stale flag, visible'
 * without its key", so an install with no Tiingo key is *configured that way*,
 * not broken, and a dashboard that coloured it red would be lying.
 *
 * `refused` is the egress guard saying no, and it is deliberately not folded
 * into `failed`: a provider being down and our own guard stopping us are
 * different facts with different responses, and only one of them is a security
 * event worth waking up for.
 */
export const MARKET_DATA_OUTCOMES = [
  'ok',
  'partial',
  'failed',
  'refused',
  'rate_limited',
  'skipped_no_key',
] as const;
export type MarketDataOutcome = (typeof MARKET_DATA_OUTCOMES)[number];

export const marketDataRuns = pgTable('market_data_runs', {
  id: idColumn(),
  userId: userIdColumn(),
  provider: text('provider').$type<MarketDataProvider>().notNull(),
  operation: text('operation').$type<MarketDataOperation>().notNull(),
  startedAt: instantColumn('started_at').notNull(),
  finishedAt: instantColumn('finished_at'),
  outcome: text('outcome').$type<MarketDataOutcome>().notNull(),
  /** HTTP requests issued. */
  requestsMade: integer('requests_made').notNull().default(0),
  /** The provider's own billing unit where it differs: CoinGecko credits, OpenFIGI jobs. */
  unitsSpent: integer('units_spent').notNull().default(0),
  symbolsAsked: integer('symbols_asked').notNull().default(0),
  rowsWritten: integer('rows_written').notNull().default(0),
  /** `@core/platform`'s `RefusalCode`, when the egress guard said no. */
  refusalCode: text('refusal_code'),
  /** Redacted before write. Never the raw provider body. */
  errorMessage: text('error_message'),
  retryAfterMs: integer('retry_after_ms'),
  createdAt: createdAtColumn(),
});

export type MarketDataRunRow = typeof marketDataRuns.$inferSelect;
export type NewMarketDataRunRow = typeof marketDataRuns.$inferInsert;
