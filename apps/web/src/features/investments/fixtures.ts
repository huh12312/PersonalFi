// SPDX-License-Identifier: MIT
/**
 * Wire-shaped fixtures for this feature's unit tests, built from the
 * **committed spreadsheet fixture**
 * `packages/contexts/investments/test/fixtures/allocation-portfolio.csv` and
 * its `allocation-expected.csv` companion (WP 3.3, `wp3.3-analytics.md` §4).
 *
 * Using the same numbers the analytics engine is pinned against means a unit
 * test that asserts "$40,892.61 appears beside VTI" is asserting against the
 * project's own ground truth rather than an invented figure, and the e2e
 * suite (`e2e/support/mock-investments.ts`) serves the same portfolio so the
 * two layers cannot drift into describing different worlds.
 *
 * Test-only: imported by `*.test.tsx` in this directory and by nothing the
 * bundle reaches.
 */
import type {
  AggregatedHolding,
  Attribution,
  AllocationReport,
  GetAllocationResponse,
  GetDriftResponse,
  GetMarketDataSettingsResponse,
  GetPerformanceResponse,
  ListAccountHoldingsResponse,
  ListHoldingsResponse,
  PriceQuote,
} from '../../api/generated/types.gen.ts';

export function usd(minor: string): { minor: string; currency: string } {
  return { minor, currency: 'USD' };
}

export function freshPrice(close: string, priceDate = '2026-09-23'): PriceQuote {
  return {
    close,
    currency: 'USD',
    priceDate,
    rung: 'provider',
    source: 'tiingo',
    carriedForward: false,
    providerCarriedForward: false,
    observedAt: `${priceDate}T20:00:00.000Z`,
    staleness: 'FRESH',
    includeInAsOfNowDeltas: true,
  };
}

export function stalePrice(close: string, priceDate = '2026-09-19'): PriceQuote {
  return { ...freshPrice(close, priceDate), staleness: 'STALE', carriedForward: true };
}

/**
 * A crypto price sourced from CoinGecko — `wp3.14-carryovers.md` item 1's
 * fixture: `holdings[].price.source === 'coingecko'` is the per-row signal
 * every investments screen derives its attribution obligation from (the
 * holdings/price wire shape carries no `attribution` field of its own; see
 * `wp3.9-routes.md`).
 */
export function coinGeckoPrice(close: string, priceDate = '2026-09-23'): PriceQuote {
  return { ...freshPrice(close, priceDate), source: 'coingecko' };
}

/**
 * `Attribution` for CoinGecko, shaped exactly like `GET /market-data/settings`'s
 * `providers[].attribution` (`ATTRIBUTIONS.coingecko` in
 * `@ctx/integrations/src/attribution.ts`) — the object `useCoinGeckoAttribution`
 * (`features/market-data/api.ts`) resolves at runtime, reproduced here so a
 * unit test can stub the same route without importing a backend package.
 */
export function coinGeckoAttribution(): Attribution {
  return {
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
}

/** `GET /market-data/settings`, just enough for `useCoinGeckoAttribution` to resolve. */
export function marketDataSettingsResponse(): GetMarketDataSettingsResponse {
  return {
    providers: [
      {
        provider: 'coingecko',
        keyPresent: false,
        registered: true,
        capabilities: { prices: true, fx: false, macro: false, search: false },
        budget: [{ label: 'requests/min', used: 3, limit: 100 }],
        attribution: coinGeckoAttribution(),
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
    ],
    settingsAttributions: [coinGeckoAttribution()],
    allowedHostsNarrowed: true,
  };
}

export function aggregatedHolding(
  overrides: Partial<AggregatedHolding> & Pick<AggregatedHolding, 'securityId'>,
): AggregatedHolding {
  return {
    symbol: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    securityType: 'etf',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'Diversified',
    classificationSource: 'provider',
    quantity: '152.345600',
    accountCount: 1,
    marketValue: usd('4089261'),
    costBasis: usd('3215000'),
    unrealized: { status: 'available', gain: usd('874261'), reason: null, warning: null },
    weight: '0.2316',
    price: freshPrice('268.42'),
    stale: false,
    ...overrides,
  };
}

/** `GET /holdings`, the spreadsheet portfolio's `last_known` totals. */
export function holdingsResponse(
  holdings: readonly AggregatedHolding[] = SPREADSHEET_HOLDINGS,
): ListHoldingsResponse {
  return {
    asOf: '2026-09-23',
    basis: 'as_of_now',
    currency: 'USD',
    total: usd('17649960'),
    unclassifiedPct: '0.0174504645',
    holdings: [...holdings],
    excluded: [],
  };
}

/**
 * Three positions out of the committed portfolio: a priced ETF, the
 * unknown-basis crypto position (`h-06`, whose `cost_basis` column is empty
 * in the CSV — "Empty cost_basis = the basis is unknown. It is not zero"),
 * and the deliberately STALE `OLDCO` position (`h-10`).
 */
export const SPREADSHEET_HOLDINGS: readonly AggregatedHolding[] = [
  aggregatedHolding({ securityId: 'sec-vti', accountCount: 2, weight: '0.3043' }),
  aggregatedHolding({
    securityId: 'sec-btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    securityType: 'crypto',
    assetClass: 'CRYPTO',
    region: 'GLOBAL',
    sector: 'UNKNOWN',
    quantity: '0.314159260',
    marketValue: usd('1987060'),
    costBasis: null,
    unrealized: {
      status: 'unavailable',
      gain: null,
      reason: 'basis_unknown',
      warning: 'No cost basis has been recorded for this position.',
    },
    weight: '0.1125815583',
    price: coinGeckoPrice('63250.10'),
  }),
  aggregatedHolding({
    securityId: 'sec-oldco',
    symbol: 'OLDCO',
    name: 'Oldco Industrials',
    securityType: 'equity',
    sector: 'Industrials',
    quantity: '40.000000',
    marketValue: usd('205000'),
    costBasis: usd('180000'),
    unrealized: { status: 'available', gain: usd('25000'), reason: null, warning: null },
    weight: '0.0116147572',
    price: stalePrice('51.25'),
    stale: true,
  }),
];

/** `GET /accounts/{id}/holdings` for the taxable account, with lots. */
export function accountHoldingsResponse(
  overrides: Partial<ListAccountHoldingsResponse> = {},
): ListAccountHoldingsResponse {
  return {
    accountId: 'acct-taxable',
    asOf: '2026-09-23',
    basis: 'as_of_now',
    currency: 'USD',
    total: usd('6076321'),
    unclassifiedPct: '0.0174504645',
    positions: [
      {
        holdingId: 'h-01',
        securityId: 'sec-vti',
        symbol: 'VTI',
        name: 'Vanguard Total Stock Market ETF',
        assetClass: 'US_EQUITY',
        quantity: '152.345600',
        marketValue: usd('4089261'),
        costBasis: usd('3215000'),
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        unrealized: { status: 'available', gain: usd('874261'), reason: null, warning: null },
        price: freshPrice('268.42'),
        stale: false,
        lots: [
          {
            lotId: 'lot-1',
            openDate: '2023-02-14',
            ageDays: 1317,
            longTerm: true,
            quantityRemaining: '100.000000',
            basis: usd('2100000'),
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
          {
            lotId: 'lot-2',
            openDate: '2026-04-02',
            ageDays: 174,
            longTerm: false,
            quantityRemaining: '52.345600',
            basis: usd('1115000'),
            basisSource: 'computed',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-06',
        securityId: 'sec-btc',
        symbol: 'BTC',
        name: 'Bitcoin',
        assetClass: 'CRYPTO',
        quantity: '0.314159260',
        marketValue: usd('1987060'),
        costBasis: null,
        costBasisSource: null,
        basisMethod: 'FIFO',
        unrealized: {
          status: 'unavailable',
          gain: null,
          reason: 'basis_unknown',
          warning: 'No cost basis has been recorded for this position.',
        },
        price: coinGeckoPrice('63250.10'),
        stale: false,
        lots: [
          {
            lotId: 'lot-btc-1',
            openDate: '2024-11-08',
            ageDays: 684,
            longTerm: true,
            quantityRemaining: '0.314159260',
            basis: null,
            basisSource: 'unknown',
            basisWarning: 'Transferred in without a basis; the exchange did not supply one.',
          },
        ],
      },
    ],
    excluded: [],
    ...overrides,
  };
}

function report(
  dimension: AllocationReport['dimension'],
  slices: readonly { key: string; minor: string; weight: string }[],
  unclassified: { pct: string; minor: string },
): AllocationReport {
  return {
    dimension,
    basis: 'last_known',
    currency: 'USD',
    total: usd('17649960'),
    slices: slices.map((slice) => ({
      key: slice.key,
      value: usd(slice.minor),
      weight: slice.weight,
    })),
    unclassifiedPct: unclassified.pct,
    unclassifiedValue: usd(unclassified.minor),
    excluded: [],
    includesCash: true,
    lookThrough: 'fund_level_only',
  };
}

/**
 * `GET /investments/allocation`, transcribed row-for-row from
 * `allocation-expected.csv`'s `last_known` block (dollars × 100 = minor).
 */
export function allocationResponse(): GetAllocationResponse {
  return {
    asOf: '2026-09-23',
    byAssetClass: report(
      'asset_class',
      [
        { key: 'US_EQUITY', minor: '7630080', weight: '0.4323001299' },
        { key: 'US_BOND', minor: '3463200', weight: '0.1962157421' },
        { key: 'CRYPTO', minor: '1987060', weight: '0.1125815583' },
        { key: 'INTL_DEV_EQUITY', minor: '1905538', weight: '0.1079627376' },
        { key: 'CASH', minor: '1250000', weight: '0.0708216902' },
        { key: 'REAL_ESTATE', minor: '553980', weight: '0.0313870400' },
        { key: 'EM_EQUITY', minor: '552102', weight: '0.0312806375' },
        { key: 'UNCLASSIFIED', minor: '308000', weight: '0.0174504645' },
      ],
      { pct: '0.0174504645', minor: '308000' },
    ),
    byRegion: report(
      'region',
      [
        { key: 'US', minor: '12897260', weight: '0.7307246022' },
        { key: 'GLOBAL', minor: '1987060', weight: '0.1125815583' },
        { key: 'DEV_EX_US', minor: '1905538', weight: '0.1079627376' },
        { key: 'EM', minor: '552102', weight: '0.0312806375' },
        { key: 'UNKNOWN', minor: '308000', weight: '0.0174504645' },
      ],
      { pct: '0.0174504645', minor: '308000' },
    ),
    bySector: report(
      'sector',
      [
        { key: 'Diversified', minor: '11289240', weight: '0.6396184467' },
        { key: 'UNKNOWN', minor: '3545060', weight: '0.2008537130' },
        { key: 'Information Technology', minor: '2056680', weight: '0.1165260431' },
        { key: 'Real Estate', minor: '553980', weight: '0.0313870400' },
        { key: 'Industrials', minor: '205000', weight: '0.0116147572' },
      ],
      { pct: '0.2008537130', minor: '3545060' },
    ),
  };
}

/** `GET /investments/drift` with no `?target` — the suppress-not-invent answer. */
export function driftWithoutTargets(): GetDriftResponse {
  return {
    asOf: '2026-09-23',
    targetsSet: false,
    bandPoints: '5.0000',
    total: usd('17649960'),
    unclassifiedPct: '0.0174504645',
    noisy: false,
    proposalsWithheld: null,
    rows: [],
    allocation: allocationResponse().byAssetClass,
    excluded: [],
  };
}

export function driftWithTargets(): GetDriftResponse {
  return {
    ...driftWithoutTargets(),
    targetsSet: true,
    rows: [
      {
        assetClass: 'US_EQUITY',
        actualWeight: '0.4323001299',
        targetWeight: '0.6000000000',
        actualValue: usd('7630080'),
        gapPoints: '-16.7699',
        insideBand: false,
        proposal: { direction: 'increase', amount: usd('2959896') },
      },
      {
        assetClass: 'US_BOND',
        actualWeight: '0.1962157421',
        targetWeight: '0.3000000000',
        actualValue: usd('3463200'),
        gapPoints: '-10.3784',
        insideBand: false,
        proposal: { direction: 'increase', amount: usd('1831788') },
      },
      {
        assetClass: 'CASH',
        actualWeight: '0.0708216902',
        targetWeight: '0.1000000000',
        actualValue: usd('1250000'),
        gapPoints: '-2.9178',
        insideBand: true,
        proposal: null,
      },
    ],
  };
}

/** `GET /investments/performance` — the three answers under three keys. */
export function performanceResponse(
  overrides: Partial<GetPerformanceResponse> = {},
): GetPerformanceResponse {
  return {
    from: '2025-09-23',
    to: '2026-09-23',
    currency: 'USD',
    timeWeighted: {
      kind: 'time_weighted',
      periodReturn: '0.1142',
      annualized: '0.1142',
      annualizationWithheld: null,
      spanDays: 365,
      from: '2025-09-23',
      to: '2026-09-23',
      method: 'sub_period_linking',
      approximate: false,
      warnings: [],
      benchmarkComparable: true,
    },
    moneyWeighted: {
      kind: 'money_weighted',
      status: 'available',
      periodReturn: '0.0931',
      annualized: '0.0931',
      annualizationWithheld: null,
      spanDays: 365,
      from: '2025-09-23',
      to: '2026-09-23',
      solver: 'newton',
      newtonDiverged: false,
      benchmarkComparable: false,
    },
    dollarGain: {
      kind: 'dollar_gain',
      status: 'available',
      gain: usd('1824210'),
      marketValue: usd('17649960'),
      costBasis: usd('15825750'),
    },
    unvaluedTransfers: 0,
    valuationDates: ['2025-09-23', '2026-09-23'],
    ...overrides,
  };
}
