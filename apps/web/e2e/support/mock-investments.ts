// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 3.11's own network mock for `e2e/investments.spec.ts`, entirely separate
 * from `e2e/support/mock-api.ts` — this work package's rules forbid editing
 * that shared file, the same collision-avoidance reasoning
 * `mock-budget.ts` and `mock-recurring-insights.ts` give for their own forks
 * (WP 3.12 is building `features/networth` at the same time). A single
 * `page.route('**\/*')` handler backed by in-memory fixtures: no live
 * `apps/api`, no database.
 *
 * ## The portfolio these fixtures serve is the committed spreadsheet fixture
 *
 * Every holding, price and allocation slice below is transcribed from
 * `packages/contexts/investments/test/fixtures/allocation-portfolio.csv` and
 * its expectations from `allocation-expected.csv` (WP 3.3, computed with an
 * independent decimal implementation — `wp3.3-analytics.md` §4). The
 * `'the allocation donut totals match the committed spreadsheet fixture'`
 * test then re-reads that CSV **from disk at run time** and compares it
 * against what the browser painted, so the check is "the UI renders the
 * project's own ground truth without mangling it" rather than "the UI agrees
 * with a number somebody typed into a spec".
 *
 * Deliberate contents carried over from the CSV, because each one is a UI
 * rule under test: `h-06` (BTC) has an **empty** `cost_basis` — unknown, not
 * zero; `h-10` (OLDCO) is **STALE**; `h-09` (XYZQ) is **UNCLASSIFIED** so
 * `unclassifiedPct` is non-zero; `sec-vti` is held in **two accounts** so the
 * per-account expansion has something to expand.
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

function usd(minor: string): { minor: string; currency: string } {
  return { minor, currency: 'USD' };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const AS_OF = '2026-09-23';

function account(id: string, name: string, type: 'investment' | 'crypto', mask: string) {
  return {
    id,
    connectionId: 'conn_1',
    provider: 'manual',
    name,
    officialName: null,
    type,
    subtype: null,
    classification: 'asset',
    currency: 'USD',
    mask,
    closedAt: null,
    includeInNetWorth: true,
    balance: null,
  };
}

const ACCOUNTS = [
  account('acct-taxable', 'Taxable brokerage', 'investment', '1234'),
  account('acct-ira', 'Traditional IRA', 'investment', '5678'),
  account('acct-crypto', 'Coinbase', 'crypto', '9012'),
];

function price(close: string, staleness: 'FRESH' | 'STALE', priceDate: string, source = 'tiingo') {
  return {
    close,
    currency: 'USD',
    priceDate,
    rung: staleness === 'STALE' ? 'last_known' : 'provider',
    source,
    carriedForward: staleness === 'STALE',
    providerCarriedForward: false,
    observedAt: `${priceDate}T20:00:00.000Z`,
    staleness,
    includeInAsOfNowDeltas: staleness === 'FRESH',
  };
}

const FRESH = (close: string, source = 'tiingo') => price(close, 'FRESH', AS_OF, source);
const STALE = (close: string) => price(close, 'STALE', '2026-09-11');

/**
 * The CoinGecko attribution, shaped exactly like `GET /market-data/settings`'s
 * `providers[].attribution` (`ATTRIBUTIONS.coingecko`,
 * `packages/contexts/integrations/src/attribution.ts`) — `mock-networth.ts`
 * carries the same literal object for its own settings-screen coverage;
 * duplicated here (not imported) because that module is WP 3.12's own fork,
 * off limits per the collision rules this file's own header documents.
 * `wp3.14-carryovers.md` item 1: BTC (`sec-btc`) is priced `source:
 * 'coingecko'` below so every investments screen showing it has something
 * real to derive the attribution obligation from.
 */
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

function marketDataSettingsResponse() {
  return {
    providers: [
      {
        provider: 'coingecko',
        keyPresent: false,
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
    ],
    settingsAttributions: [COINGECKO_ATTRIBUTION],
    allowedHostsNarrowed: true,
  };
}

interface HoldingSeed {
  securityId: string;
  symbol: string;
  name: string;
  securityType: 'equity' | 'etf' | 'mutual_fund' | 'crypto' | 'bond' | 'cash' | 'other';
  assetClass: string;
  region: string;
  sector: string;
  quantity: string;
  accountCount: number;
  marketValueMinor: string;
  costBasisMinor: string | null;
  weight: string;
  price: ReturnType<typeof price>;
  stale: boolean;
}

/**
 * `GET /holdings`, aggregated by security. `VTI` sums `h-01` ($40,892.61) and
 * `h-11` ($12,791.39) into $53,684.00 over two accounts — the CSV's own
 * "one security held in two accounts" case.
 */
const HOLDINGS: HoldingSeed[] = [
  {
    securityId: 'sec-vti',
    symbol: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    securityType: 'etf',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'Diversified',
    quantity: '200.000000',
    accountCount: 2,
    marketValueMinor: '5368400',
    costBasisMinor: '4335000',
    weight: '0.3041877',
    price: FRESH('268.42'),
    stale: false,
  },
  {
    securityId: 'sec-bnd',
    symbol: 'BND',
    name: 'Vanguard Total Bond Market ETF',
    securityType: 'etf',
    assetClass: 'US_BOND',
    region: 'US',
    sector: 'Diversified',
    quantity: '480.000000',
    accountCount: 1,
    marketValueMinor: '3463200',
    costBasisMinor: '3599040',
    weight: '0.1962157',
    price: FRESH('72.15'),
    stale: false,
  },
  {
    securityId: 'sec-aapl',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'equity',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'Information Technology',
    quantity: '90.000000',
    accountCount: 1,
    marketValueMinor: '2056680',
    costBasisMinor: '900450',
    weight: '0.1165260',
    price: FRESH('228.52'),
    stale: false,
  },
  {
    securityId: 'sec-vxus',
    symbol: 'VXUS',
    name: 'Vanguard Total International Stock ETF',
    securityType: 'etf',
    assetClass: 'INTL_DEV_EQUITY',
    region: 'DEV_EX_US',
    sector: 'Diversified',
    quantity: '310.500000',
    accountCount: 1,
    marketValueMinor: '1905538',
    costBasisMinor: '1780025',
    weight: '0.1079627',
    price: FRESH('61.37'),
    stale: false,
  },
  {
    securityId: 'sec-btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    securityType: 'crypto',
    assetClass: 'CRYPTO',
    region: 'GLOBAL',
    sector: 'UNKNOWN',
    quantity: '0.314159260',
    accountCount: 1,
    marketValueMinor: '1987060',
    // The CSV's empty `cost_basis` cell: unknown, and never a zero.
    costBasisMinor: null,
    weight: '0.1125815',
    price: FRESH('63250.10', 'coingecko'),
    stale: false,
  },
  {
    securityId: 'sec-usd-cash',
    symbol: 'CASH',
    name: 'US dollar',
    securityType: 'cash',
    assetClass: 'CASH',
    region: 'US',
    sector: 'UNKNOWN',
    quantity: '12500.000000',
    accountCount: 1,
    marketValueMinor: '1250000',
    costBasisMinor: '1250000',
    weight: '0.0708216',
    price: FRESH('1.00'),
    stale: false,
  },
  {
    securityId: 'sec-vnq',
    symbol: 'VNQ',
    name: 'Vanguard Real Estate ETF',
    securityType: 'etf',
    assetClass: 'REAL_ESTATE',
    region: 'US',
    sector: 'Real Estate',
    quantity: '60.000000',
    accountCount: 1,
    marketValueMinor: '553980',
    costBasisMinor: '510000',
    weight: '0.0313870',
    price: FRESH('92.33'),
    stale: false,
  },
  {
    securityId: 'sec-vwo',
    symbol: 'VWO',
    name: 'Vanguard FTSE Emerging Markets ETF',
    securityType: 'etf',
    assetClass: 'EM_EQUITY',
    region: 'EM',
    sector: 'Diversified',
    quantity: '125.250000',
    accountCount: 1,
    marketValueMinor: '552102',
    costBasisMinor: '501275',
    weight: '0.0312806',
    price: FRESH('44.08'),
    stale: false,
  },
  {
    securityId: 'sec-xyzq',
    symbol: 'XYZQ',
    name: 'Unclassified Holdings Trust',
    securityType: 'other',
    assetClass: 'UNCLASSIFIED',
    region: 'UNKNOWN',
    sector: 'UNKNOWN',
    quantity: '200.000000',
    accountCount: 1,
    marketValueMinor: '308000',
    costBasisMinor: '340000',
    weight: '0.0174504',
    price: FRESH('15.40'),
    stale: false,
  },
  {
    securityId: 'sec-oldco',
    symbol: 'OLDCO',
    name: 'Oldco Industrials',
    securityType: 'equity',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'Industrials',
    quantity: '40.000000',
    accountCount: 1,
    marketValueMinor: '205000',
    costBasisMinor: '180000',
    weight: '0.0116147',
    price: STALE('51.25'),
    stale: true,
  },
];

function unrealized(marketMinor: string, basisMinor: string | null) {
  if (basisMinor === null) {
    return {
      status: 'unavailable' as const,
      gain: null,
      reason: 'basis_unknown' as const,
      warning: 'No cost basis has been recorded for this position.',
    };
  }
  return {
    status: 'available' as const,
    gain: usd((BigInt(marketMinor) - BigInt(basisMinor)).toString()),
    reason: null,
    warning: null,
  };
}

function holdingsResponse() {
  return {
    asOf: AS_OF,
    basis: 'last_known',
    currency: 'USD',
    // `last_known,portfolio,TOTAL` in allocation-expected.csv.
    total: usd('17649960'),
    unclassifiedPct: '0.0174504645',
    holdings: HOLDINGS.map((holding) => ({
      securityId: holding.securityId,
      symbol: holding.symbol,
      name: holding.name,
      securityType: holding.securityType,
      assetClass: holding.assetClass,
      region: holding.region,
      sector: holding.sector,
      classificationSource: 'provider',
      quantity: holding.quantity,
      accountCount: holding.accountCount,
      marketValue: usd(holding.marketValueMinor),
      costBasis: holding.costBasisMinor === null ? null : usd(holding.costBasisMinor),
      unrealized: unrealized(holding.marketValueMinor, holding.costBasisMinor),
      weight: holding.weight,
      price: holding.price,
      stale: holding.stale,
    })),
    excluded: [],
    unresolved: [],
  };
}

interface PositionSeed {
  holdingId: string;
  securityId: string;
  symbol: string;
  name: string;
  assetClass: string;
  quantity: string;
  marketValueMinor: string;
  costBasisMinor: string | null;
  costBasisSource: string | null;
  basisMethod: 'FIFO' | 'LIFO' | 'HIFO' | 'SPECIFIC_ID' | 'AVERAGE_COST';
  price: ReturnType<typeof price>;
  stale: boolean;
  lots: {
    lotId: string;
    openDate: string;
    ageDays: number;
    longTerm: boolean;
    quantityRemaining: string;
    basisMinor: string | null;
    basisSource: string;
    basisWarning: string | null;
  }[];
}

const POSITIONS: Record<string, { totalMinor: string; positions: PositionSeed[] }> = {
  'acct-taxable': {
    totalMinor: '9648499',
    positions: [
      {
        holdingId: 'h-01',
        securityId: 'sec-vti',
        symbol: 'VTI',
        name: 'Vanguard Total Stock Market ETF',
        assetClass: 'US_EQUITY',
        quantity: '152.345600',
        marketValueMinor: '4089261',
        costBasisMinor: '3215000',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('268.42'),
        stale: false,
        lots: [
          {
            lotId: 'lot-vti-1',
            openDate: '2023-02-14',
            ageDays: 1317,
            longTerm: true,
            quantityRemaining: '100.000000',
            basisMinor: '2100000',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
          {
            lotId: 'lot-vti-2',
            openDate: '2026-04-02',
            ageDays: 174,
            longTerm: false,
            quantityRemaining: '52.345600',
            basisMinor: '1115000',
            basisSource: 'computed',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-05',
        securityId: 'sec-aapl',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        assetClass: 'US_EQUITY',
        quantity: '90.000000',
        marketValueMinor: '2056680',
        costBasisMinor: '900450',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('228.52'),
        stale: false,
        lots: [
          {
            lotId: 'lot-aapl-1',
            openDate: '2019-06-03',
            ageDays: 2669,
            longTerm: true,
            quantityRemaining: '90.000000',
            basisMinor: '900450',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-10',
        securityId: 'sec-oldco',
        symbol: 'OLDCO',
        name: 'Oldco Industrials',
        assetClass: 'US_EQUITY',
        quantity: '40.000000',
        marketValueMinor: '205000',
        costBasisMinor: '180000',
        costBasisSource: 'computed',
        basisMethod: 'FIFO',
        price: STALE('51.25'),
        stale: true,
        lots: [
          {
            lotId: 'lot-oldco-1',
            openDate: '2021-10-19',
            ageDays: 1800,
            longTerm: true,
            quantityRemaining: '40.000000',
            basisMinor: '180000',
            basisSource: 'computed',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-09',
        securityId: 'sec-xyzq',
        symbol: 'XYZQ',
        name: 'Unclassified Holdings Trust',
        assetClass: 'UNCLASSIFIED',
        quantity: '200.000000',
        marketValueMinor: '308000',
        costBasisMinor: '340000',
        costBasisSource: 'computed',
        basisMethod: 'FIFO',
        price: FRESH('15.40'),
        stale: false,
        lots: [
          {
            lotId: 'lot-xyzq-1',
            openDate: '2024-03-11',
            ageDays: 926,
            longTerm: true,
            quantityRemaining: '200.000000',
            basisMinor: '340000',
            basisSource: 'computed',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-07',
        securityId: 'sec-usd-cash',
        symbol: 'CASH',
        name: 'US dollar',
        assetClass: 'CASH',
        quantity: '12500.000000',
        marketValueMinor: '1250000',
        costBasisMinor: '1250000',
        costBasisSource: 'computed',
        basisMethod: 'FIFO',
        price: FRESH('1.00'),
        stale: false,
        lots: [],
      },
      {
        holdingId: 'h-02',
        securityId: 'sec-vxus',
        symbol: 'VXUS',
        name: 'Vanguard Total International Stock ETF',
        assetClass: 'INTL_DEV_EQUITY',
        quantity: '310.500000',
        marketValueMinor: '1905538',
        costBasisMinor: '1780025',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('61.37'),
        stale: false,
        lots: [
          {
            lotId: 'lot-vxus-1',
            openDate: '2022-08-08',
            ageDays: 1507,
            longTerm: true,
            quantityRemaining: '310.500000',
            basisMinor: '1780025',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
        ],
      },
    ],
  },
  'acct-ira': {
    totalMinor: '5341421',
    positions: [
      {
        holdingId: 'h-03',
        securityId: 'sec-bnd',
        symbol: 'BND',
        name: 'Vanguard Total Bond Market ETF',
        assetClass: 'US_BOND',
        quantity: '480.000000',
        marketValueMinor: '3463200',
        costBasisMinor: '3599040',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('72.15'),
        stale: false,
        lots: [
          {
            lotId: 'lot-bnd-1',
            openDate: '2021-01-05',
            ageDays: 2087,
            longTerm: true,
            quantityRemaining: '480.000000',
            basisMinor: '3599040',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-11',
        securityId: 'sec-vti',
        symbol: 'VTI',
        name: 'Vanguard Total Stock Market ETF',
        assetClass: 'US_EQUITY',
        quantity: '47.654400',
        marketValueMinor: '1279139',
        costBasisMinor: '1120000',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('268.42'),
        stale: false,
        lots: [
          {
            lotId: 'lot-vti-3',
            openDate: '2022-12-01',
            ageDays: 1392,
            longTerm: true,
            quantityRemaining: '47.654400',
            basisMinor: '1120000',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-04',
        securityId: 'sec-vwo',
        symbol: 'VWO',
        name: 'Vanguard FTSE Emerging Markets ETF',
        assetClass: 'EM_EQUITY',
        quantity: '125.250000',
        marketValueMinor: '552102',
        costBasisMinor: '501275',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('44.08'),
        stale: false,
        lots: [
          {
            lotId: 'lot-vwo-1',
            openDate: '2023-07-20',
            ageDays: 1161,
            longTerm: true,
            quantityRemaining: '125.250000',
            basisMinor: '501275',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
        ],
      },
      {
        holdingId: 'h-08',
        securityId: 'sec-vnq',
        symbol: 'VNQ',
        name: 'Vanguard Real Estate ETF',
        assetClass: 'REAL_ESTATE',
        quantity: '60.000000',
        marketValueMinor: '553980',
        costBasisMinor: '510000',
        costBasisSource: 'provider_supplied',
        basisMethod: 'FIFO',
        price: FRESH('92.33'),
        stale: false,
        lots: [
          {
            lotId: 'lot-vnq-1',
            openDate: '2020-05-15',
            ageDays: 2322,
            longTerm: true,
            quantityRemaining: '60.000000',
            basisMinor: '510000',
            basisSource: 'provider_supplied',
            basisWarning: null,
          },
        ],
      },
    ],
  },
  'acct-crypto': {
    totalMinor: '1987060',
    positions: [
      {
        holdingId: 'h-06',
        securityId: 'sec-btc',
        symbol: 'BTC',
        name: 'Bitcoin',
        assetClass: 'CRYPTO',
        quantity: '0.314159260',
        marketValueMinor: '1987060',
        // Unknown, not zero — the CSV's empty `cost_basis` cell.
        costBasisMinor: null,
        costBasisSource: null,
        basisMethod: 'FIFO',
        price: FRESH('63250.10', 'coingecko'),
        stale: false,
        lots: [
          {
            lotId: 'lot-btc-1',
            openDate: '2024-11-08',
            ageDays: 684,
            longTerm: true,
            quantityRemaining: '0.314159260',
            basisMinor: null,
            basisSource: 'unknown',
            basisWarning: 'Transferred in without a basis; the exchange did not supply one.',
          },
        ],
      },
    ],
  },
};

function accountHoldingsResponse(accountId: string) {
  const seed = POSITIONS[accountId];
  if (seed === undefined) return null;
  return {
    accountId,
    asOf: AS_OF,
    basis: 'last_known',
    currency: 'USD',
    total: usd(seed.totalMinor),
    unclassifiedPct: accountId === 'acct-taxable' ? '0.0319219' : '0.0000000',
    positions: seed.positions.map((position) => ({
      holdingId: position.holdingId,
      securityId: position.securityId,
      symbol: position.symbol,
      name: position.name,
      assetClass: position.assetClass,
      quantity: position.quantity,
      marketValue: usd(position.marketValueMinor),
      costBasis: position.costBasisMinor === null ? null : usd(position.costBasisMinor),
      costBasisSource: position.costBasisSource,
      basisMethod: position.basisMethod,
      unrealized: unrealized(position.marketValueMinor, position.costBasisMinor),
      price: position.price,
      stale: position.stale,
      lots: position.lots.map((lot) => ({
        lotId: lot.lotId,
        openDate: lot.openDate,
        ageDays: lot.ageDays,
        longTerm: lot.longTerm,
        quantityRemaining: lot.quantityRemaining,
        basis: lot.basisMinor === null ? null : usd(lot.basisMinor),
        basisSource: lot.basisSource,
        basisWarning: lot.basisWarning,
      })),
    })),
    excluded: [],
    unresolved: [],
  };
}

/**
 * `GET /investments/allocation`. Slice values and weights are
 * `allocation-expected.csv`'s `last_known` block, verbatim (dollars × 100 for
 * the minor units, the exact ten-decimal Ratio strings for the weights).
 */
const ALLOCATION_SLICES = {
  asset_class: [
    { key: 'US_EQUITY', minor: '7630080', weight: '0.4323001299' },
    { key: 'US_BOND', minor: '3463200', weight: '0.1962157421' },
    { key: 'CRYPTO', minor: '1987060', weight: '0.1125815583' },
    { key: 'INTL_DEV_EQUITY', minor: '1905538', weight: '0.1079627376' },
    { key: 'CASH', minor: '1250000', weight: '0.0708216902' },
    { key: 'REAL_ESTATE', minor: '553980', weight: '0.0313870400' },
    { key: 'EM_EQUITY', minor: '552102', weight: '0.0312806375' },
    { key: 'UNCLASSIFIED', minor: '308000', weight: '0.0174504645' },
  ],
  region: [
    { key: 'US', minor: '12897260', weight: '0.7307246022' },
    { key: 'GLOBAL', minor: '1987060', weight: '0.1125815583' },
    { key: 'DEV_EX_US', minor: '1905538', weight: '0.1079627376' },
    { key: 'EM', minor: '552102', weight: '0.0312806375' },
    { key: 'UNKNOWN', minor: '308000', weight: '0.0174504645' },
  ],
  sector: [
    { key: 'Diversified', minor: '11289240', weight: '0.6396184467' },
    { key: 'UNKNOWN', minor: '3545060', weight: '0.2008537130' },
    { key: 'Information Technology', minor: '2056680', weight: '0.1165260431' },
    { key: 'Real Estate', minor: '553980', weight: '0.0313870400' },
    { key: 'Industrials', minor: '205000', weight: '0.0116147572' },
  ],
} as const;

const UNCLASSIFIED = {
  asset_class: { pct: '0.0174504645', minor: '308000' },
  region: { pct: '0.0174504645', minor: '308000' },
  sector: { pct: '0.2008537130', minor: '3545060' },
} as const;

function allocationReport(dimension: 'asset_class' | 'region' | 'sector') {
  return {
    dimension,
    basis: 'last_known',
    currency: 'USD',
    total: usd('17649960'),
    slices: ALLOCATION_SLICES[dimension].map((slice) => ({
      key: slice.key,
      value: usd(slice.minor),
      weight: slice.weight,
    })),
    unclassifiedPct: UNCLASSIFIED[dimension].pct,
    unclassifiedValue: usd(UNCLASSIFIED[dimension].minor),
    excluded: [],
    unresolved: [],
    includesCash: true,
    lookThrough: 'fund_level_only',
  };
}

function allocationResponse() {
  return {
    asOf: AS_OF,
    byAssetClass: allocationReport('asset_class'),
    byRegion: allocationReport('region'),
    bySector: allocationReport('sector'),
  };
}

const BAND_POINTS = '5.0000';

/**
 * `GET /investments/drift`. With no `?target` the real route answers
 * `targetsSet: false`, `rows: []`, and still returns `unclassifiedPct`
 * (`wp3.9-routes.md` §8 item 1) — reproduced exactly, because the
 * `'drift renders nothing when no target is set'` test is only meaningful if
 * the mock behaves the way the route does.
 */
function driftResponse(targets: readonly string[]) {
  const base = {
    asOf: AS_OF,
    bandPoints: BAND_POINTS,
    total: usd('17649960'),
    unclassifiedPct: '0.0174504645',
    noisy: false,
    proposalsWithheld: null,
    allocation: allocationReport('asset_class'),
    excluded: [],
    unresolved: [],
  };
  if (targets.length === 0) {
    return { ...base, targetsSet: false, rows: [] };
  }
  return {
    ...base,
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

function performanceResponse(from: string) {
  return {
    from,
    to: AS_OF,
    currency: 'USD',
    timeWeighted: {
      kind: 'time_weighted',
      periodReturn: '0.1142',
      annualized: '0.1142',
      annualizationWithheld: null,
      spanDays: 365,
      from,
      to: AS_OF,
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
      from,
      to: AS_OF,
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
    valuationDates: [from, AS_OF],
  };
}

export interface MockInvestmentsState {
  /** The body of the last `PUT /investments/basis-method`, for the election assertions. */
  lastBasisMethodBody: unknown;
  /** Whether that call arrived only after a step-up assertion. */
  basisMethodRequiredStepUp: boolean;
}

export async function installInvestmentsMocks(page: Page): Promise<MockInvestmentsState> {
  const state: MockInvestmentsState = {
    lastBasisMethodBody: null,
    basisMethodRequiredStepUp: false,
  };
  let authenticated = false;
  let steppedUp = false;

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

    if (path === '/api/categories' && method === 'GET') {
      return route.fulfill(json({ categories: [] }));
    }

    if (path === '/api/accounts' && method === 'GET') {
      return route.fulfill(json({ accounts: ACCOUNTS }));
    }

    if (path === '/api/insights' && method === 'GET') {
      return route.fulfill(json({ dashboard: [], list: [], overflow: [], belowFloor: [] }));
    }

    if (path === '/api/holdings' && method === 'GET') {
      return route.fulfill(json(holdingsResponse()));
    }

    const accountHoldings = /^\/api\/accounts\/([^/]+)\/holdings$/.exec(path);
    if (accountHoldings !== null && method === 'GET') {
      const body = accountHoldingsResponse(accountHoldings[1] ?? '');
      if (body === null) {
        return route.fulfill(json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404));
      }
      return route.fulfill(json(body));
    }

    if (path === '/api/investments/allocation' && method === 'GET') {
      return route.fulfill(json(allocationResponse()));
    }

    if (path === '/api/investments/drift' && method === 'GET') {
      return route.fulfill(json(driftResponse(url.searchParams.getAll('target'))));
    }

    if (path === '/api/investments/performance' && method === 'GET') {
      return route.fulfill(json(performanceResponse(url.searchParams.get('from') ?? '2025-09-23')));
    }

    // `useCoinGeckoAttribution` (`features/market-data/api.ts`), fired by
    // `InvestmentsScreen` on every mount — `wp3.14-carryovers.md` item 1.
    if (path === '/api/market-data/settings' && method === 'GET') {
      return route.fulfill(json(marketDataSettingsResponse()));
    }

    if (path === '/api/investments/basis-method' && method === 'PUT') {
      const body = request.postDataJSON() as {
        accountId: string;
        securityId: string;
        method: string;
      };
      if (!steppedUp) {
        // D21: the election restates a tax position and is one-way.
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Step-up required',
              status: 403,
              code: 'step_up_required',
              correlationId: 'corr_basis_method',
            },
            403,
          ),
        );
      }
      state.basisMethodRequiredStepUp = true;
      state.lastBasisMethodBody = body;
      const seed = HOLDINGS.find((holding) => holding.securityId === body.securityId);
      if (body.method === 'AVERAGE_COST' && seed?.securityType !== 'mutual_fund') {
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Unprocessable Content',
              status: 422,
              code: 'investments.average_cost_ineligible',
              detail: `AVERAGE_COST is available for mutual_fund only; this security is a ${
                seed?.securityType ?? 'unknown'
              }.`,
            },
            422,
          ),
        );
      }
      return route.fulfill(
        json({
          accountId: body.accountId,
          securityId: body.securityId,
          method: body.method,
          sticky: body.method === 'AVERAGE_COST',
        }),
      );
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    return route.continue();
  });

  return state;
}
