// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

import { createMarketDataKeysState, handleMarketDataKeys } from './mock-market-data-keys.ts';
import { bucketsFor, pointsFor, splitDay, stackedDays } from './networth-buckets.ts';

/**
 * WP 3.12's own mock module, entirely separate from `mock-api.ts` — the
 * dispatch forbids both UI work packages (3.11, 3.12) from editing that
 * shared fixture, and `mock-budget.ts`/`mock-recurring-insights.ts` already
 * establish the pattern this file follows: one `page.route('**\/*')`
 * handler, backed by in-memory state, entirely client-side.
 *
 * Covers what `e2e/networth.spec.ts` and `e2e/market-data.spec.ts` drive:
 * login, the dashboard's net-worth chart and full view (`GET
 * /net-worth/series`), Settings' "Market data" tab (`GET
 * /market-data/settings`, `PUT /market-data/priority`,
 * `POST /market-data/test-fetch`) and "Crypto" tab (`GET /connectors`), and
 * the dashboard's own `GET /insights` landing widget.
 *
 * ## The re-sync fixture, on purpose
 *
 * `net_worth_daily` rows are gapless and dated **2026-09-0{1..5}** —
 * deliberately fixed, not relative to whatever day the suite actually runs
 * on, the same choice `mock-budget.ts` makes for its own periods. Day 5
 * (`2026-09-05`) is the only **unsealed** row (`sealed: false`) and its
 * value is derived from a call counter that increments on every
 * `GET /net-worth/series` — so clicking "Refresh" (a real re-fetch, not a
 * cached response) produces a **different** live-day figure while every
 * sealed day's figure stays byte-for-byte identical. That is the whole
 * mechanism `'a past date on the chart is unchanged after a re-sync'`
 * exercises: a mock that just returned the same canned JSON every time could
 * not tell a working seal apart from a route that never re-fetches at all.
 *
 * Day 3 (`2026-09-03`) is priced in **CAD**, everything else in **USD** —
 * `'two currencies render as two series and never one sum'`'s fixture. USD
 * total + CAD total (`100000 + 800000 = 900000`) must never appear anywhere
 * on screen; the test asserts that negatively as well as asserting the two
 * currency labels positively.
 */

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'totp',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

/** A synthetic value shaped like a real provider key — never a real secret. Planted so the settings screen's "never a key value" property is checked against an actual (fake) leak candidate, not merely against a field name. */
export const SYNTHETIC_KEY_MARKER = 'pfi-synthetic-tiingo-key-do-not-use-9f3c1a77';

const COINGECKO_ATTRIBUTION = {
  provider: 'coingecko',
  required: true,
  text: 'Data provided by CoinGecko',
  linkUrl: 'https://www.coingecko.com',
  logoRequired: true,
  surfaces: ['any_price', 'settings'],
  clause:
    'CoinGecko Demo (free tier): "Attribution required even on free tier — must display ' +
    "'Data provided by CoinGecko' with logo + hyperlink\" — a hard license condition, not a courtesy.",
  redistribution: 'permitted_with_attribution',
};

const FRED_ATTRIBUTION = {
  provider: 'fred',
  required: true,
  text: 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
  linkUrl: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html',
  logoRequired: false,
  surfaces: ['any_macro_figure', 'settings'],
  clause: 'FRED API terms: the exact sentence is a licence condition, not a paraphrase.',
  redistribution: 'permitted_with_attribution',
};

const TIINGO_ATTRIBUTION = {
  provider: 'tiingo',
  required: false,
  text: '',
  linkUrl: null,
  logoRequired: false,
  surfaces: [],
  clause: 'Tiingo forbids redistribution; no badge required.',
  redistribution: 'forbidden',
};

interface SeriesDay {
  asOfDate: string;
  currency: string | null;
  minor: string | null;
  sealed: boolean;
  source: string | null;
}

const SERIES_DAYS: SeriesDay[] = [
  { asOfDate: '2026-09-01', currency: 'USD', minor: '100000', sealed: true, source: 'observed' },
  {
    asOfDate: '2026-09-02',
    currency: 'USD',
    minor: '100200',
    sealed: true,
    source: 'interpolated',
  },
  { asOfDate: '2026-09-03', currency: 'CAD', minor: '800000', sealed: true, source: 'observed' },
  { asOfDate: '2026-09-04', currency: 'USD', minor: '101000', sealed: true, source: 'observed' },
  { asOfDate: '2026-09-05', currency: 'USD', minor: null, sealed: false, source: null }, // live — filled per-call below
];

function money(minor: string, currency: string) {
  return { minor, currency };
}

function seriesResponse(callCount: number, bucket: string | null) {
  const liveMinor = String(105000 + callCount * 100); // changes every call — proves a real re-fetch happened
  return {
    from: SERIES_DAYS[0]!.asOfDate,
    to: SERIES_DAYS.at(-1)!.asOfDate,
    baseCurrency: 'USD',
    points: SERIES_DAYS.map((day) => {
      const isLive = day.asOfDate === '2026-09-05';
      const minor = isLive ? liveMinor : day.minor;
      const currency = isLive ? 'USD' : day.currency;
      return {
        asOfDate: day.asOfDate,
        netWorth: minor !== null && currency !== null ? money(minor, currency) : null,
        assets: null,
        liabilities: null,
        liquid: null,
        investable: null,
        onBudget: null,
        sealed: day.sealed,
        sealedAt: day.sealed ? `${day.asOfDate}T23:59:59.000Z` : null,
        revision: 1,
        source: day.source,
        stalePrice: false,
        dirty: !day.sealed,
        accountsCounted: 2,
        accountsUnvalued: 0,
        correctionReason: null,
      };
    }),
    // WP 10.13: the same five days as buckets (each split into cash, investments and liabilities that sum to it).
    bucketing: bucket,
    buckets:
      bucket === null
        ? null
        : bucketsFor(
            SERIES_DAYS.flatMap((day) => {
              const isLive = day.asOfDate === '2026-09-05';
              const minor = isLive ? liveMinor : day.minor;
              const currency = isLive ? 'USD' : day.currency;
              return minor === null || currency === null
                ? []
                : [
                    splitDay(
                      day.asOfDate,
                      Number(minor),
                      currency,
                      day.sealed,
                      day.source ?? 'observed',
                    ),
                  ];
            }),
            SERIES_DAYS[0]!.asOfDate,
            SERIES_DAYS.at(-1)!.asOfDate,
            bucket,
          ),
  };
}

/** WP 10.13: the stacked holder (`networth-buckets.ts`) over the requested window; `to` is today and live. */
function stackedSeriesResponse(url: URL) {
  const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
  const from =
    url.searchParams.get('from') ??
    new Date(Date.parse(`${to}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
  const bucket = url.searchParams.get('bucket');
  const days = stackedDays(from, to, to);
  return {
    from,
    to,
    baseCurrency: 'USD',
    points: pointsFor(days, from, to),
    lastSnapshotFailure: null,
    bucketing: bucket,
    buckets: bucket === null ? null : bucketsFor(days, from, to, bucket),
  };
}

/** The stacked holder's one milestone: $200,000, crossed three days ago. */
function stackedMilestone() {
  const crossedOn = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  return {
    id: '01920000-0000-7000-8000-00000000d013',
    milestone: { minor: '20000000', currency: 'USD' },
    direction: 'up',
    crossedOn,
    previous: { minor: '19990000', currency: 'USD' },
    latest: { minor: '20010000', currency: 'USD' },
  };
}

function marketDataSettingsResponse() {
  return {
    providers: [
      {
        provider: 'tiingo',
        keyPresent: true,
        keySource: 'file',
        registered: true,
        capabilities: { prices: true, fx: false, macro: false, search: false },
        budget: [{ label: 'requests/day', used: 12, limit: 1000 }],
        attribution: TIINGO_ATTRIBUTION,
        // A defensive-in-depth field a buggy backend might one day add — the
        // settings screen must never surface it regardless of field name.
        debugApiKey: SYNTHETIC_KEY_MARKER,
      },
      {
        provider: 'fred',
        keyPresent: false,
        keySource: 'none',
        registered: true,
        capabilities: { prices: false, fx: false, macro: true, search: false },
        budget: [{ label: 'requests/min', used: 0, limit: 120 }],
        attribution: FRED_ATTRIBUTION,
      },
      {
        provider: 'coingecko',
        keyPresent: false,
        keySource: 'none',
        registered: true,
        capabilities: { prices: true, fx: false, macro: false, search: false },
        budget: [{ label: 'requests/min', used: 3, limit: 100 }],
        attribution: COINGECKO_ATTRIBUTION,
      },
    ],
    ladders: [
      {
        securityKind: 'crypto',
        sources: [
          { source: 'user_override', rung: 1 },
          { source: 'coingecko', rung: 2 },
          { source: 'last_known', rung: 3 },
        ],
      },
      {
        securityKind: 'equity',
        sources: [
          { source: 'user_override', rung: 1 },
          { source: 'tiingo', rung: 2 },
          { source: 'last_known', rung: 3 },
        ],
      },
    ],
    settingsAttributions: [COINGECKO_ATTRIBUTION, FRED_ATTRIBUTION],
    allowedHostsNarrowed: true,
  };
}

export const COINBASE_CONNECTOR = {
  provider: 'coinbase',
  displayName: 'Coinbase (read-only)',
  description: 'A read-only Coinbase Advanced Trade key.',
  iconKey: 'crypto',
  linkKind: 'credential_form',
};

export const WALLETRPC_CONNECTOR = {
  provider: 'wallet_rpc',
  displayName: 'Bitcoin / Ethereum wallet (watch-only)',
  description: 'A public address or extended public key.',
  iconKey: 'crypto',
  linkKind: 'credential_form',
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

export interface MockNetworthState {
  seriesCallCount: number;
  lastPriorityBody: unknown;
  lastTestFetchBody: unknown;
  /** The body of the last `POST /connections` that actually went through (after any step-up retry) — `wp3.14-carryovers.md` item 2. */
  lastConnectionBody: unknown;
  /** Whether that call arrived only after a step-up assertion, same shape as `mock-investments.ts`'s basis-method state. */
  connectionRequiredStepUp: boolean;
  /** WP 10.13: every `POST /net-worth/milestones/dismiss` body's ids, in order. */
  dismissedMilestones: string[];
}

export interface NetworthMockOptions {
  /**
   * WP 10.13: serve the stacked holder (every account type, two years of days up to the requested `to`) and one
   * undismissed milestone, instead of WP 3.12's five-day fixture. Dismissal is remembered for the page's life.
   */
  readonly stacked?: boolean;
}

export async function installNetworthMocks(
  page: Page,
  options: NetworthMockOptions = {},
): Promise<MockNetworthState> {
  const state: MockNetworthState = {
    seriesCallCount: 0,
    lastPriorityBody: null,
    lastTestFetchBody: null,
    lastConnectionBody: null,
    connectionRequiredStepUp: false,
    dismissedMilestones: [],
  };
  let authenticated = false;
  let steppedUp = false;
  const marketDataKeys = createMarketDataKeysState();

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/auth/session') {
      if (!authenticated) {
        return route.fulfill(
          json({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
        );
      }
      return route.fulfill(json(SESSION));
    }

    if (path === '/api/auth/login/options' && method === 'POST') {
      return route.fulfill(json({ options: {} }));
    }

    if (path === '/api/auth/totp/verify' && method === 'POST') {
      authenticated = true;
      return route.fulfill(json({ ok: true }));
    }

    if (path === '/api/auth/step-up/options' && method === 'POST') {
      return route.fulfill(
        json({
          options: {
            challenge: 'dGVzdC1jaGFsbGVuZ2U',
            rpId: 'localhost',
            timeout: 60_000,
            userVerification: 'preferred',
          },
        }),
      );
    }

    if (path === '/api/auth/step-up/verify' && method === 'POST') {
      steppedUp = true;
      return route.fulfill(json({ freshUntil: new Date(Date.now() + 300_000).toISOString() }));
    }

    if (path === '/api/insights' && method === 'GET') {
      return route.fulfill(json({ items: [] }));
    }

    if (path === '/api/net-worth/series' && method === 'GET') {
      state.seriesCallCount += 1;
      return route.fulfill(
        json(
          options.stacked === true
            ? stackedSeriesResponse(url)
            : seriesResponse(state.seriesCallCount, url.searchParams.get('bucket')),
        ),
      );
    }

    if (path === '/api/net-worth/milestones' && method === 'GET') {
      const milestone = stackedMilestone();
      const listed =
        options.stacked === true && !state.dismissedMilestones.includes(milestone.id)
          ? [milestone]
          : [];
      return route.fulfill(json({ milestones: listed }));
    }

    if (path === '/api/net-worth/milestones/dismiss' && method === 'POST') {
      const body = request.postDataJSON() as { ids: string[] };
      state.dismissedMilestones.push(...body.ids);
      return route.fulfill(json({ dismissed: body.ids.length }));
    }

    // WP 10.4: Settings › Market data now opens with the key cards; answered here so this
    // spec's screens never fall through to the Vite proxy.
    if (await handleMarketDataKeys(route, path, method, marketDataKeys, () => steppedUp)) return;

    if (path === '/api/market-data/settings' && method === 'GET') {
      return route.fulfill(json(marketDataSettingsResponse()));
    }

    if (path === '/api/market-data/priority' && method === 'PUT') {
      state.lastPriorityBody = request.postDataJSON();
      const body = state.lastPriorityBody as { securityKind: string; sources: string[] };
      return route.fulfill(
        json({
          securityKind: body.securityKind,
          sources: body.sources.map((source, index) => ({ source, rung: index + 1 })),
        }),
      );
    }

    if (path === '/api/market-data/test-fetch' && method === 'POST') {
      const body = request.postDataJSON() as { provider: string; symbol?: string };
      state.lastTestFetchBody = body;
      if (body.provider === 'coingecko') {
        return route.fulfill(
          json({
            provider: 'coingecko',
            operation: 'test_fetch',
            outcome: 'ok',
            quote: {
              date: '2026-09-24',
              value: '64000.12',
              currency: 'USD',
              attribution: COINGECKO_ATTRIBUTION,
            },
            detail: null,
            refusalCode: null,
            retryAfterMs: null,
            budget: [{ label: 'requests/min', used: 4, limit: 100 }],
          }),
        );
      }
      return route.fulfill(
        json({
          provider: body.provider,
          operation: 'test_fetch',
          outcome: 'skipped_no_key',
          quote: null,
          detail: 'No key configured for this provider.',
          refusalCode: null,
          retryAfterMs: null,
          budget: [],
        }),
      );
    }

    if (path === '/api/connectors' && method === 'GET') {
      return route.fulfill(json({ connectors: [COINBASE_CONNECTOR, WALLETRPC_CONNECTOR] }));
    }

    if (path === '/api/connections' && method === 'GET') {
      return route.fulfill(json({ connections: [] }));
    }

    if (path === '/api/connections' && method === 'POST') {
      // Step-up gated, same as `mock-investments.ts`'s basis-method route —
      // `useStepUpRetry` (`src/lib/step-up.ts`) retries once after a
      // `step_up_required` refusal.
      if (!steppedUp) {
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Step-up required',
              status: 403,
              code: 'step_up_required',
              correlationId: 'corr_add_connection',
            },
            403,
          ),
        );
      }
      state.connectionRequiredStepUp = true;
      state.lastConnectionBody = request.postDataJSON();
      return route.fulfill(
        json(
          {
            connectionId: 'conn_new',
            relinked: false,
            accountIds: [],
            syncJobId: null,
            syncRunId: null,
          },
          201,
        ),
      );
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    return route.fallback();
  });

  return state;
}
