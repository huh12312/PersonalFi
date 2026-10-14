// SPDX-License-Identifier: MIT
import type { Route } from '@playwright/test';

/**
 * WP 10.4: `/api/market-data/providers/{provider}/credentials` (GET, PUT, DELETE), in the response shape
 * `apps/api/src/routes/market-data.ts` really sends (`MarketDataCredentialsStatus`), with real state - shared by
 * `mock-api.ts` (the walkthrough, the a11y sweep and keyboard journeys through `mock-sweep.ts`, and
 * `market-data-keys.spec.ts`) and `mock-networth.ts` (`market-data.spec.ts`), so Settings › Market data never
 * falls through to the Vite proxy.
 *
 * The four providers start as a mix, one of each state the cards draw:
 *
 *   - tiingo: `file` - the operator's secret file supplies it (read-only).
 *   - fred: `none`.
 *   - coingecko: `stored`, ending in `9f2c`.
 *   - openfigi: `none`, anonymous tier in use.
 *
 * `PUT` and `DELETE` need a fresh step-up (`isFresh()`, the caller's own flag set by its step-up verify
 * handler), exactly as `requireFreshSession` does. A `PUT` whose key contains `rejected` is refused with the
 * api's `422 provider_credentials.rejected` and its fixed detail; any other key is "accepted" and stored, and
 * only its last four characters come back. The key itself is never in any response.
 */

export type MarketDataKeyProvider = 'tiingo' | 'fred' | 'coingecko' | 'openfigi';

export interface MarketDataKeyStatus {
  provider: MarketDataKeyProvider;
  purpose: string;
  source: 'file' | 'stored' | 'none';
  configured: boolean;
  anonymous: boolean;
  keyHint: string | null;
  storedAt: string | null;
  rotatedAt: string | null;
  narrowedOut: boolean;
}

export interface MarketDataKeysMockState {
  statuses: Record<MarketDataKeyProvider, MarketDataKeyStatus>;
  /** `METHOD /api/...` of every credentials call, in order (GETs included). */
  calls: string[];
  /** Every `PUT` body that arrived after a step-up. */
  putBodies: unknown[];
}

const PURPOSE: Record<MarketDataKeyProvider, string> = {
  tiingo: 'Equity, ETF and fund end-of-day closes.',
  fred: 'Macro series and FX rates.',
  coingecko: 'Crypto prices (Demo plan).',
  openfigi:
    'Symbol-to-FIGI mapping. Answers anonymously without a key, at 10 jobs per batch instead of 100.',
};

function base(provider: MarketDataKeyProvider): MarketDataKeyStatus {
  return {
    provider,
    purpose: PURPOSE[provider],
    source: 'none',
    configured: false,
    anonymous: provider === 'openfigi',
    keyHint: null,
    storedAt: null,
    rotatedAt: null,
    narrowedOut: false,
  };
}

export function initialMarketDataKeyStatuses(): Record<MarketDataKeyProvider, MarketDataKeyStatus> {
  return {
    tiingo: { ...base('tiingo'), source: 'file', configured: true },
    fred: base('fred'),
    coingecko: {
      ...base('coingecko'),
      source: 'stored',
      configured: true,
      keyHint: '9f2c',
      storedAt: '2026-09-01T12:00:00.000Z',
      rotatedAt: null,
    },
    openfigi: base('openfigi'),
  };
}

export function createMarketDataKeysState(): MarketDataKeysMockState {
  return { statuses: initialMarketDataKeyStatuses(), calls: [], putBodies: [] };
}

const PATH = /^\/api\/market-data\/providers\/(tiingo|fred|coingecko|openfigi)\/credentials$/u;

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const STEP_UP_REQUIRED = {
  type: 'about:blank',
  title: 'Step-up required',
  status: 403,
  code: 'step_up_required',
  correlationId: 'corr_market_data_keys',
};

/**
 * Answers the request when `path` is a credentials route and returns `true`; returns `false` (and touches
 * nothing) for any other path, so the caller's own routing carries on.
 */
export async function handleMarketDataKeys(
  route: Route,
  path: string,
  method: string,
  state: MarketDataKeysMockState,
  isFresh: () => boolean,
): Promise<boolean> {
  const match = PATH.exec(path);
  if (match === null) return false;
  const provider = match[1] as MarketDataKeyProvider;
  state.calls.push(`${method} ${path}`);

  if (method === 'GET') {
    await route.fulfill(json(state.statuses[provider]));
    return true;
  }
  if (method !== 'PUT' && method !== 'DELETE') {
    await route.fulfill(
      json({ type: 'about:blank', title: 'Method Not Allowed', status: 405 }, 405),
    );
    return true;
  }
  if (!isFresh()) {
    await route.fulfill(json(STEP_UP_REQUIRED, 403));
    return true;
  }

  if (method === 'DELETE') {
    state.statuses[provider] = base(provider);
    await route.fulfill(json(state.statuses[provider]));
    return true;
  }

  if (state.statuses[provider].source === 'file') {
    await route.fulfill(
      json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'provider_credentials.managed_by_files',
          detail: `The ${provider} key is supplied by the operator's secret file, which takes precedence. Empty ${provider}_api_key in the secrets directory to use a stored key.`,
        },
        409,
      ),
    );
    return true;
  }
  const body = route.request().postDataJSON() as { key: string };
  state.putBodies.push(body);
  if (body.key.includes('rejected')) {
    await route.fulfill(
      json(
        {
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          code: 'provider_credentials.rejected',
          detail: `${provider} did not accept this key (HTTP 401). Check that it is the whole key, copied from your account with the provider. Nothing was saved.`,
        },
        422,
      ),
    );
    return true;
  }
  const previous = state.statuses[provider];
  const now = new Date('2026-10-14T09:00:00.000Z').toISOString();
  state.statuses[provider] = {
    ...base(provider),
    source: 'stored',
    configured: true,
    anonymous: false,
    keyHint: body.key.slice(-4),
    storedAt: previous.source === 'stored' ? previous.storedAt : now,
    rotatedAt: previous.source === 'stored' ? now : null,
  };
  await route.fulfill(json(state.statuses[provider]));
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// WP 10.5: POST /api/market-data/refresh ("Refresh prices")
// ---------------------------------------------------------------------------------------------------------

export interface MarketDataRefreshMockState {
  /** How many `POST /market-data/refresh` calls have arrived. */
  calls: number;
  /**
   * Calls after this many are answered `409 market_data.refresh_too_soon`, as the api does for a second
   * refresh inside ten minutes. `Infinity` accepts every call.
   */
  acceptCalls: number;
  /** How long the answer is held back, in ms - so a spec can see the busy state. Default 0. */
  delayMs: number;
}

export function createMarketDataRefreshState(): MarketDataRefreshMockState {
  return { calls: 0, acceptCalls: 1, delayMs: 0 };
}

/**
 * The refresh summary in the shape `PriceRefreshSummary` has: 13 held, 12 priced, one unpriced (BTC, for want of a
 * CoinGecko key) and one cash position no provider prices.
 */
export function refreshSummary(): unknown {
  const pricedNames = [
    ['VTI', 'Vanguard Total Stock Market ETF', 'etf'],
    ['VXUS', 'Vanguard Total International Stock ETF', 'etf'],
    ['BND', 'Vanguard Total Bond Market ETF', 'etf'],
    ['AAPL', 'Apple Inc.', 'equity'],
    ['MSFT', 'Microsoft Corporation', 'equity'],
    ['GOOGL', 'Alphabet Inc.', 'equity'],
    ['AMZN', 'Amazon.com, Inc.', 'equity'],
    ['VFIAX', 'Vanguard 500 Index Fund Admiral', 'mutual_fund'],
    ['SCHD', 'Schwab US Dividend Equity ETF', 'etf'],
    ['QQQ', 'Invesco QQQ Trust', 'etf'],
    ['VNQ', 'Vanguard Real Estate ETF', 'etf'],
    ['ETH', 'Ethereum', 'crypto'],
  ] as const;
  return {
    asOfDate: '2026-10-14',
    counts: { held: 14, priceable: 13, priced: 12, unpriced: 1, notPricedByProvider: 1 },
    priced: pricedNames.map(([symbol, name, kind], index) => ({
      securityId: `sec_priced_${String(index)}`,
      symbol,
      name,
      kind,
      provider: kind === 'crypto' ? 'coingecko' : 'tiingo',
    })),
    unpriced: [
      {
        securityId: 'sec_btc',
        symbol: 'BTC',
        name: 'Bitcoin',
        kind: 'crypto',
        provider: 'coingecko',
        reason: 'source_not_configured',
        detail: 'No CoinGecko key is set for this install, so no request was made.',
      },
    ],
    notPricedByProvider: [
      { securityId: 'sec_cash', symbol: null, name: 'US Dollar cash', kind: 'cash' },
    ],
    fx: { rowsWritten: 0, pairs: [] },
    priceRowsWritten: 12,
    requests: [
      {
        provider: 'tiingo',
        operation: 'price_refresh',
        requestsMade: 1,
        symbolsAsked: 11,
        outcome: 'ok',
      },
    ],
    budgets: [{ provider: 'tiingo', label: 'requests/hour', used: 1, limit: 50 }],
    nextRefreshAt: '2026-10-14T09:10:00.000Z',
  };
}

/** Answers `POST /api/market-data/refresh` and returns `true`; any other request is left alone (`false`). */
export async function handleMarketDataRefresh(
  route: Route,
  path: string,
  method: string,
  state: MarketDataRefreshMockState,
): Promise<boolean> {
  if (path !== '/api/market-data/refresh' || method !== 'POST') return false;
  state.calls += 1;
  if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  if (state.calls > state.acceptCalls) {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      headers: { 'Retry-After': '540' },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'market_data.refresh_too_soon',
        detail:
          'Prices were refreshed less than ten minutes ago. Try again after 2026-10-14T09:10:00.000Z.',
      }),
    });
    return true;
  }
  await route.fulfill(json(refreshSummary()));
  return true;
}
