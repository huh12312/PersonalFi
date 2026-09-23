// SPDX-License-Identifier: MIT
/**
 * `@ctx/integrations` — Integrations.
 *
 * The anti-corruption layer for every external process — the Vibe-Trading sidecar, a local LLM, a future tax tool. Each is spoken to over the versioned Advisor contract, never over our internal ports, and must not be able to read Ledger, Connections, or Identity.
 *
 * This file is the context's *only* public surface. Everything else under `src/`
 * is internal, and no other context may import from it.
 *
 * ## What WP 3.4 ships
 *
 * Market data and FX behind **one** `PriceSource` port, with four adapters
 * under it and the WP 2.4 egress allow-list — *reused, not reimplemented* —
 * between every one of them and the network:
 *
 *   * `PriceSource` — `price`, `fxRate`, `search`, plus declared
 *     `capabilities` so a caller never discovers a gap by catching. Every
 *     failure is a *value* (`SourceOutcome`), because a missing key, a spent
 *     budget, an egress refusal and a bank holiday mean four different things
 *     and are recorded four different ways in `market_data_runs`.
 *   * Adapters: Tiingo (equity/ETF/fund EOD, D17's default), CoinGecko Demo
 *     (crypto, **with a mandatory attribution obligation on every quote**),
 *     FRED (macro series and FX), OpenFIGI (WP 3.1's `FigiMapper`, batched).
 *   * `createMarketDataEgressPolicy` / `policyFor` — one host per adapter, so
 *     a buggy Tiingo adapter cannot reach `api.coingecko.com`, let alone
 *     `db:5432`.
 *   * Client-side rate budgets with the published numbers in the code, so the
 *     1,001st Tiingo call of a day is refused *here* rather than by Tiingo.
 *   * `ATTRIBUTIONS` — licence obligations as data that travels with the
 *     number, because a UI cannot render an obligation it was never told about.
 *   * The 03:45 refresh job, which writes no price row itself: `prices` and
 *     `fx_rates` are `@ctx/investments`' tables and rows cross that seam
 *     through `MarketDataWriter`.
 */

/** Stable identifier used by feature flags (`module.integrations`) and event metadata. */
export const CONTEXT_ID = 'integrations' as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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
} from '../schema/index.ts';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export {
  INTEGRATIONS_EVENTS,
  PRICE_SOURCE_UNAVAILABLE_REASONS,
  PriceSourceUnavailable,
  PricesUpdated,
  type PriceSourceUnavailableReason,
} from './events.ts';

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export {
  unsupported,
  type FxQuote,
  type MacroObservation,
  type PriceQuote,
  type PriceRequest,
  type PriceSource,
  type PriceSourceCapabilities,
  type PriceSubject,
  type SearchHit,
  type SourceOutcome,
} from './price-source.ts';

// ---------------------------------------------------------------------------
// Egress, transport and credentials
// ---------------------------------------------------------------------------

export {
  MARKET_DATA_ALLOWED_HOSTS,
  MARKET_DATA_ALLOWED_PORTS,
  MARKET_DATA_MAX_RESPONSE_BYTES,
  MARKET_DATA_TIMEOUT_MS,
  PROVIDER_HOSTS,
  baseUrlFor,
  createMarketDataEgressPolicy,
  policyFor,
} from './egress.ts';

export {
  HEADER_NAMES,
  USER_AGENT,
  createProviderClient,
  type HeaderName,
  type ProviderClient,
  type ProviderClientOptions,
  type ProviderRequest,
  type ProviderResponse,
} from './http.ts';

export { apiKeyOf, missingKey, redactSecrets, redactedMessageOf, type ApiKey } from './secrets.ts';

// ---------------------------------------------------------------------------
// Rate budgets — the published numbers, in the code (dispatch §3)
// ---------------------------------------------------------------------------

export {
  COINGECKO_WINDOWS,
  FRED_WINDOWS,
  OPENFIGI_WINDOWS,
  RateLimitExceededError,
  TIINGO_WINDOWS,
  YFINANCE_WINDOWS,
  createRateBudget,
  isRateLimitExceededError,
  type RateBudget,
  type RateUnit,
  type RateVerdict,
  type RateWindow,
} from './rate-limit.ts';

// ---------------------------------------------------------------------------
// Attribution — a licence condition, not a courtesy
// ---------------------------------------------------------------------------

export {
  ATTRIBUTIONS,
  attributionRequirementsOf,
  forbidsRedistribution,
  type Attribution,
  type AttributionSurface,
} from './attribution.ts';

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export { createTiingoPriceSource, type TiingoOptions } from './adapters/tiingo.ts';
export {
  CHAIN_NATIVE_COIN_IDS,
  coinGeckoDate,
  createCoinGeckoPriceSource,
  type CoinGeckoOptions,
} from './adapters/coingecko.ts';
export {
  FRED_FX_SERIES,
  FRED_MACRO_SERIES,
  createFredSource,
  type FredOptions,
  type FredSource,
} from './adapters/fred.ts';
export {
  OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST,
  OPENFIGI_MAX_JOBS_PER_REQUEST,
  createOpenFigiMapper,
  type FigiMapJob,
  type FigiMapOutcome,
  type FigiMapper,
  type FigiMapping,
  type OpenFigiMapper,
  type OpenFigiOptions,
} from './adapters/openfigi.ts';

export {
  createFakePriceSource,
  createFakeTransport,
  fakePriceKey,
  jsonResponse,
  redirectResponse,
  type FakeHandler,
  type FakePriceSource,
  type FakePriceSourceOptions,
  type FakeTransport,
} from './adapters/fake.ts';

// ---------------------------------------------------------------------------
// The 03:45 refresh
// ---------------------------------------------------------------------------

export {
  PROVIDER_FOR_KIND,
  createPriceRefreshJob,
  inMemoryMarketDataWriter,
  inMemoryRunRecorder,
  newRunId,
  type FxRowToWrite,
  type MarketDataRun,
  type MarketDataRunRecorder,
  type MarketDataWriter,
  type PriceRefreshOptions,
  type PriceRefreshResult,
  type PriceRowToWrite,
  type RefreshFxPair,
  type RefreshPlan,
  type RefreshSubject,
} from './market-data.ts';
