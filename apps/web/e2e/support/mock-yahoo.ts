// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 12.6: Yahoo Finance in Settings › Market data, in the response shapes `apps/api/src/routes/market-data.ts`
 * really sends (`YahooFinanceSettings`), with real state.
 *
 * Two uses:
 *
 *   - `defaultYahooSettings()` - the `yahoo` field every other mock of `GET /market-data/settings` carries
 *     (operator half off, no consent, no placements, nothing asked yet), so those specs keep working.
 *   - `installYahooRoutes()` - the stateful mock `yahoo-finance.spec.ts` runs against. Register it AFTER a base
 *     mock (`installNetworthMocks` for the Settings screen, `installInvestmentsMocks` for the Investments one);
 *     it answers the market-data routes first and `fallback()`s on everything else.
 *
 * Synthetic data only: the symbol is PFTEST, the consent text is the mock's own words (the real text is the
 * api's, rendered verbatim by the card), and nothing here comes from Yahoo.
 */

export const YAHOO_ATTRIBUTION = {
  provider: 'yfinance',
  required: true,
  text: 'Yahoo Finance via yfinance — unofficial, best effort',
  linkUrl: null,
  logoRequired: false,
  surfaces: ['any_price', 'settings'],
  clause: 'Yahoo Finance via yfinance: unofficial and best effort; no licence has been granted.',
  redistribution: 'forbidden',
};

// The api's own words (apps/api/src/yahoo-consent.ts, `yahoo-consent/1`), verbatim, so the
// evidence screenshots show what a holder is actually asked to tick.
export const MOCK_CONSENT_TEXT =
  'Use Yahoo Finance, through the yfinance library, for prices on this install. I understand that: it is unofficial — Yahoo does not offer or support it; Yahoo’s terms prohibit automated collection of its data; it is for my personal use only; it is best effort and may stop working at any time without notice; and the data is not licensed for redistribution, so I will not share it. What leaves this machine: the ticker symbols and dates asked for, sent by the yahoo sidecar to Yahoo — never your name, an account, a quantity or an amount.';
export const MOCK_WHAT_LEAVES =
  'the ticker symbols and dates asked for, sent by the yahoo sidecar to Yahoo — never your name, an account, a quantity or an amount';

export function defaultYahooSettings() {
  return {
    operatorEnabled: false,
    consent: { given: false, consentedAt: null, version: null },
    consentVersion: 'yahoo-consent/1',
    consentText: MOCK_CONSENT_TEXT,
    consentSha256: 'sha256:b9b043cbf9ecf05061d08f729849e7f688745f227895408df69ec703fadc9e89',
    whatLeaves: MOCK_WHAT_LEAVES,
    ready: false,
    notReady: 'operator_disabled',
    placements: [] as {
      securityKind: string;
      rung: number;
      position: number;
      of: number;
    }[],
    lastOutcome: null as null | Record<string, unknown>,
    budget: [{ label: 'requests/hour', used: 0, limit: 60 }],
    attribution: YAHOO_ATTRIBUTION,
  };
}

type Ladders = Record<string, string[]>;

export interface YahooMockOptions {
  readonly operatorEnabled?: boolean;
  readonly consented?: boolean;
  /** Equity ladder with Yahoo already placed after Tiingo. */
  readonly placedEquity?: boolean;
  readonly lastOutcome?: Record<string, unknown> | null;
  readonly budgetUsed?: number;
  /** Serve `GET /holdings` with one Yahoo-priced PFTEST holding (the Investments screen). */
  readonly yahooHolding?: boolean;
}

export interface YahooMockState {
  consented: boolean;
  ladders: Ladders;
  /** `METHOD path` of every write the mock answered, in order. */
  calls: string[];
}

const BASE_LADDER = ['user_override', 'exchange_fill', 'tiingo', 'last_known'];

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function problem(status: number, code: string, detail: string) {
  return json(
    { type: 'about:blank', title: code, status, code, detail, correlationId: 'corr_y' },
    status,
  );
}

export async function installYahooRoutes(
  page: Page,
  options: YahooMockOptions = {},
): Promise<YahooMockState> {
  const state: YahooMockState = {
    consented: options.consented ?? false,
    ladders: {
      equity: options.placedEquity
        ? ['user_override', 'exchange_fill', 'tiingo', 'yfinance', 'last_known']
        : [...BASE_LADDER],
      etf: [...BASE_LADDER],
      mutual_fund: [...BASE_LADDER],
      crypto: ['user_override', 'coingecko', 'last_known'],
    },
    calls: [],
  };
  const operatorEnabled = options.operatorEnabled ?? true;
  const consentedAt = '2026-11-02T15:00:00.000Z';
  let steppedUp = false;

  function yahoo() {
    const placements = Object.entries(state.ladders)
      .filter(([, sources]) => sources.includes('yfinance'))
      .map(([securityKind, sources]) => ({
        securityKind,
        rung: sources.indexOf('yfinance') + 1,
        position: sources.indexOf('yfinance') + 1,
        of: sources.length,
      }));
    return {
      ...defaultYahooSettings(),
      operatorEnabled,
      consent: state.consented
        ? { given: true, consentedAt, version: 'yahoo-consent/1' }
        : { given: false, consentedAt: null, version: null },
      ready: operatorEnabled && state.consented,
      notReady: !operatorEnabled
        ? 'operator_disabled'
        : state.consented
          ? null
          : 'consent_required',
      placements,
      lastOutcome: options.lastOutcome === undefined ? null : options.lastOutcome,
      budget: [{ label: 'requests/hour', used: options.budgetUsed ?? 0, limit: 60 }],
    };
  }

  function settings() {
    const quiet = (provider: string) => ({
      provider,
      required: false,
      text: '',
      linkUrl: null,
      logoRequired: false,
      surfaces: [],
      clause: `${provider}: no attribution required.`,
      redistribution: 'forbidden',
    });
    return {
      providers: [
        {
          provider: 'tiingo',
          keyPresent: true,
          keySource: 'file',
          registered: true,
          capabilities: { prices: true, fx: false, macro: false, search: false },
          budget: [{ label: 'requests/day', used: 3, limit: 500 }],
          attribution: quiet('tiingo'),
        },
        {
          provider: 'yfinance',
          keyPresent: false,
          keySource: 'none',
          registered: operatorEnabled,
          capabilities: { prices: true, fx: false, macro: false, search: false },
          budget: yahoo().budget,
          attribution: YAHOO_ATTRIBUTION,
        },
      ],
      ladders: Object.entries(state.ladders).map(([securityKind, sources]) => ({
        securityKind,
        sources: sources.map((source, index) => ({
          source,
          rung: source === 'last_known' ? 99 : index + 1,
        })),
      })),
      settingsAttributions: [YAHOO_ATTRIBUTION],
      allowedHostsNarrowed: false,
      yahoo: yahoo(),
    };
  }

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/api/auth/step-up/verify') {
      steppedUp = true;
      return route.fallback();
    }

    if (path === '/api/market-data/settings' && method === 'GET') {
      return route.fulfill(json(settings()));
    }

    if (path === '/api/market-data/providers/yfinance/consent') {
      if (method !== 'PUT' && method !== 'DELETE') return route.fallback();
      if (!steppedUp) return route.fulfill(problem(403, 'step_up_required', 'Step-up required.'));
      state.calls.push(`${method} ${path}`);
      if (method === 'PUT') {
        const body = request.postDataJSON() as { consentVersion?: string };
        if (body.consentVersion !== 'yahoo-consent/1') {
          return route.fulfill(
            problem(409, 'market_data.consent_version_unknown', 'Unknown consent text version.'),
          );
        }
        state.consented = true;
      } else {
        state.consented = false;
        for (const kind of Object.keys(state.ladders)) {
          state.ladders[kind] = (state.ladders[kind] ?? []).filter((s) => s !== 'yfinance');
        }
      }
      return route.fulfill(json(yahoo()));
    }

    if (path === '/api/market-data/priority' && method === 'PUT') {
      if (!steppedUp) return route.fulfill(problem(403, 'step_up_required', 'Step-up required.'));
      const body = request.postDataJSON() as { securityKind: string; sources: string[] };
      if (body.sources.includes('yfinance') && !state.consented) {
        return route.fulfill(
          problem(
            409,
            'market_data.consent_required',
            'Yahoo Finance cannot be placed in a ladder until you have given consent to its current text.',
          ),
        );
      }
      state.calls.push(`PUT ${path} ${body.securityKind}`);
      state.ladders[body.securityKind] = body.sources;
      return route.fulfill(json({ securityKind: body.securityKind, sources: [] }));
    }

    if (path === '/api/holdings' && method === 'GET' && options.yahooHolding === true) {
      const usd = (minor: string) => ({ minor, currency: 'USD' });
      return route.fulfill(
        json({
          asOf: '2026-11-02',
          basis: 'last_known',
          currency: 'USD',
          total: usd('123450'),
          unclassifiedPct: '0',
          holdings: [
            {
              securityId: 'sec-pftest',
              symbol: 'PFTEST',
              name: 'PF Test Corp (synthetic)',
              securityType: 'equity',
              assetClass: 'US_EQUITY',
              region: 'US',
              sector: 'UNKNOWN',
              classificationSource: 'provider',
              quantity: '10.000000',
              accountCount: 1,
              marketValue: usd('123450'),
              costBasis: usd('100000'),
              unrealized: { status: 'available', gain: usd('23450'), reason: null, warning: null },
              weight: '1',
              price: {
                close: '123.45',
                currency: 'USD',
                priceDate: '2026-11-02',
                rung: 'provider',
                source: 'yfinance',
                carriedForward: false,
                providerCarriedForward: false,
                observedAt: '2026-11-02T20:00:00.000Z',
                staleness: 'FRESH',
                includeInAsOfNowDeltas: true,
              },
              stale: false,
            },
          ],
          excluded: [],
          unresolved: [],
        }),
      );
    }

    return route.fallback();
  });

  return state;
}
