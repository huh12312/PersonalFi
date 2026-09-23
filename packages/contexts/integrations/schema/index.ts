// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/integrations`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — here,
 * `0015_market_data.sql`.
 *
 * One table so far. Note what is *absent*: `prices` and `fx_rates`. This
 * context fetches them and this context is refused them — 08 §1.3 #7 gives
 * those to `@ctx/investments`, whose `PriceReader`/`FxReader` are the published
 * ports over them, and `lint:schema-ownership` fails the build if a table is
 * defined in a package that does not own it. What crosses the seam is an
 * injected writer port, not a table handle.
 */
export {
  MARKET_DATA_OPERATIONS,
  MARKET_DATA_OUTCOMES,
  MARKET_DATA_PROVIDERS,
  marketDataRuns,
  type MarketDataOperation,
  type MarketDataOutcome,
  type MarketDataProvider,
  type MarketDataRunRow,
  type NewMarketDataRunRow,
} from './market-data.ts';
