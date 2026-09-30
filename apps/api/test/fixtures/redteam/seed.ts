// SPDX-License-Identifier: MIT
/**
 * WP 5.4 — the red-team seed: one holder's data, built into a real snapshot by
 * the real `SnapshotBuilder`, with a corpus payload injected **at its source**.
 *
 * Written for this package rather than borrowed from `@ctx/insights`' test
 * seed (which a file in `apps/api` may not import across a package root). It
 * is shaped after that seed's `drift` case on purpose — the same subscription
 * price rise ($15.99 → $18.99 on 2026-06-01, about $36.00 a year: 05 §1's
 * worked finding) and the same $5,400.00 monthly income (the real snapshot
 * figure WP 5.3's evidence used as its traceable-but-wrong number) — so a
 * reader of both evidence files is reading about the same figures.
 *
 * ## Where each payload goes in
 *
 * Every source is a field a port carries today, filled the way the real
 * adapter fills it, **plus the worst case the real adapter does not do**:
 *
 *   * `merchant.descriptor` / `transaction.memo` — the ledger's `name`,
 *     `merchant_name`, `original_description` and a memo never cross the
 *     ledger port (`createInsightsLedgerPort` maps id, date, merchantId, slug,
 *     amount, accountId only). The seed therefore plants the payload in the
 *     two places a future regression would put it: as extra properties on
 *     every transaction (`descriptor`, `name`, `memo`, `originalDescription`)
 *     **and as the merchant id itself** (a first-seen merchant's charge, a
 *     recurring stream, a merchant-spend row) — the one merchant string the
 *     port does carry. The builder must tokenise the id and drop the rest.
 *   * `crypto.symbol` — a crypto position's symbol (provider/chain-controlled,
 *     ≤ 16 characters, `contract/snapshot.ts`'s `symbol`), with no basis so
 *     `crypto.missing_basis` quotes it.
 *   * `category.slug` — seven charges in one category (six ordinary, one far
 *     above them), so `transactions.anomalies` flags the spike and S1 quotes
 *     the slug in its title and summary; also the cashflow and category-spend
 *     rows.
 *   * `goal.name` — the off-pace goal R6 quotes (the holder's own text, ≤ 96).
 *   * `market.attribution` — the market-rate provider's attribution sentence,
 *     carried verbatim by the builder and quoted as a caveat by the cash rules.
 *     Not in the dispatch's list: a third-party string that enters the
 *     snapshot unmodified.
 *   * `holdings.account_type_mix.key` — the one record in the snapshot whose
 *     **keys** are data.
 */
import { DateOnly, Money } from '@core/kernel';
import {
  ADVISOR_SCOPES,
  SnapshotBuilder,
  deriveTokenKey,
  inMemoryBudgetPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryRecurringPort,
  type AdvisorSnapshot,
  type InsightsHoldings,
  type InsightsPosition,
  type InsightsRecurringStream,
  type InsightsTransaction,
  type MonthlyCashflowRow,
  type SnapshotPorts,
} from '@ctx/insights';

export const TODAY = '2026-09-19';
export const REDTEAM_USER_ID = '01930000-0000-7000-8000-00000000f54a';
const USD = 'USD';

/** Where a payload is injected. Each is a field a port carries (see the header). */
export const INJECTION_SOURCES = [
  'merchant.descriptor',
  'transaction.memo',
  'crypto.symbol',
  'category.slug',
  'goal.name',
  'market.attribution',
  'holdings.account_type_mix.key',
] as const;
export type InjectionSource = (typeof INJECTION_SOURCES)[number];

export interface Injection {
  readonly source: InjectionSource;
  readonly payload: string;
}

const usd = (minor: number): Money => Money.of(BigInt(minor), USD);
const date = (text: string): DateOnly => DateOnly.parse(text);

/** The baseline strings each source replaces. */
export const BASELINE = {
  slug: 'dining.restaurants',
  goalName: 'House deposit',
  // A real token symbol with a digit in it (Coin98). The identifier-digit
  // hypothesis (the evidence file's §0 item 1) needs one in the clean seed too.
  symbol: 'C98',
  attribution:
    'Source: FRED®, Federal Reserve Bank of St. Louis. This product uses the FRED® API but is ' +
    'not endorsed or certified by the Federal Reserve Bank of St. Louis.',
} as const;

function months(from: string, count: number): string[] {
  const out: string[] = [];
  let [year, month] = from.split('-').map(Number) as [number, number];
  for (let index = 0; index < count; index += 1) {
    out.push(`${String(year)}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function cashflow(slug: string): MonthlyCashflowRow[] {
  return months('2025-06', 16).map((month) => ({
    month,
    // $5,400.00 of income every month: the real snapshot figure 05 §1's
    // misattribution quotes under the wrong label.
    income: usd(month === '2026-09' ? 300_000 : 540_000),
    expense: usd(month === '2026-09' ? 215_000 : 350_000),
    byCategory: [
      { categoryId: 'cat-rent', slug: 'housing.rent', amount: usd(200_000) },
      { categoryId: 'cat-groceries', slug: 'groceries.supermarkets', amount: usd(130_000) },
      { categoryId: 'cat-target', slug, amount: usd(20_000) },
    ],
  }));
}

function transactions(injection: Injection | null, slug: string): InsightsTransaction[] {
  const descriptor =
    injection?.source === 'merchant.descriptor' ? injection.payload : 'SQ *BLUE BOTTLE COFFEE #12';
  const memo = injection?.source === 'transaction.memo' ? injection.payload : 'lunch';
  // The worst case the real adapter does not do: the descriptor or memo *as*
  // the merchant id, the one merchant string the port carries.
  const newMerchant =
    injection?.source === 'merchant.descriptor' || injection?.source === 'transaction.memo'
      ? injection.payload
      : 'merchant-software-new';
  const rows: InsightsTransaction[] = [];
  const ordinary = [3_900, 4_000, 4_100, 4_000, 4_200, 3_800];
  ordinary.forEach((minor, index) => {
    rows.push({
      id: `txn-ordinary-${String(index)}`,
      date: date(`2026-0${String(index + 2)}-12`),
      merchantId: 'merchant-bistro',
      categorySlug: slug,
      amount: usd(-minor),
      accountId: 'acct-checking',
    });
  });
  // The spike S1 flags: ten times the category's usual charge.
  rows.push({
    id: 'txn-spike',
    date: date('2026-09-10'),
    merchantId: 'merchant-bistro',
    categorySlug: slug,
    amount: usd(-40_000),
    accountId: 'acct-checking',
  });
  // S5: a first-time charge over $250 at a merchant never seen before.
  rows.push({
    id: 'txn-new-merchant',
    date: date('2026-09-05'),
    merchantId: newMerchant,
    categorySlug: 'shopping.software',
    amount: usd(-59_900),
    accountId: 'acct-checking',
  });
  // The descriptor and memo ride on every row as properties the port type
  // does not have — the shape a leaking adapter would produce.
  return rows.map(
    (row) =>
      ({
        ...row,
        descriptor,
        name: descriptor,
        originalDescription: descriptor,
        memo,
      }) as InsightsTransaction,
  );
}

function streams(injection: Injection | null): InsightsRecurringStream[] {
  const merchant =
    injection?.source === 'merchant.descriptor' || injection?.source === 'transaction.memo'
      ? injection.payload
      : 'merchant-stream-a';
  return [
    {
      id: 'series-stream-a',
      merchantId: merchant,
      cadence: 'MONTHLY',
      type: 'SUBSCRIPTION',
      status: 'ACTIVE',
      userConfirmed: true,
      confidence: 0.94,
      typicalAmount: usd(1_899),
      observedMin: usd(1_599),
      observedMax: usd(1_899),
      nextDueDate: date('2026-10-01'),
      firstSeen: date('2025-06-01'),
      lastSeen: date('2026-09-01'),
      periodsPerYear: 12,
      eligibleForImpact: true,
      priceChanges: [
        {
          effectiveDate: date('2026-06-01'),
          direction: 'INCREASE',
          previousAmount: usd(1_599),
          newAmount: usd(1_899),
          annualImpact: usd(3_600),
        },
      ],
    },
  ];
}

function position(symbol: string, id: string, minor: number): InsightsPosition {
  return {
    securityId: id,
    symbol,
    assetClass: 'crypto',
    accountType: 'taxable',
    quantity: '10',
    costBasis: null,
    marketValue: usd(minor),
    unrealized: null,
    oldestLotDays: 400,
    isCrypto: true,
    isStablecoin: false,
    employerStock: false,
    expenseRatio: null,
    peerExpenseRatio: null,
    annualFeeCost: null,
    highFee: false,
    lots: [],
  };
}

function holdings(injection: Injection | null): InsightsHoldings {
  const injected = injection?.source === 'crypto.symbol' ? injection.payload : 'SOL';
  const positions = [
    position(BASELINE.symbol, 'sec-c98', 123_400),
    position(injected, 'sec-injected', 250_000),
  ];
  const total = positions.reduce((sum, row) => sum + row.marketValue.minor, 0n);
  const mixKey =
    injection?.source === 'holdings.account_type_mix.key' ? injection.payload : 'taxable';
  return {
    currency: USD,
    positions,
    aggregate: {
      investableTotal: Money.of(total, USD),
      unclassifiedPct: 0,
      byAssetClass: [{ assetClass: 'crypto', value: Money.of(total, USD), weight: 1 }],
      positions: positions.map((row) => ({
        securityId: row.securityId,
        symbol: row.symbol,
        value: row.marketValue,
        weight: Number(row.marketValue.minor) / Number(total),
        assetClass: row.assetClass,
        employerStock: false,
        isCrypto: true,
      })),
      targets: [],
      accountTypeMix: { [mixKey]: 1 },
      idleCash: null,
      cryptoCustody: {
        exchangeValue: Money.of(total, USD),
        selfCustodyValue: Money.zero(USD),
        unknownValue: Money.zero(USD),
      },
    },
  };
}

/** The ports for one injection (or none: the clean baseline). */
export function redteamPorts(injection: Injection | null): SnapshotPorts {
  const slug = injection?.source === 'category.slug' ? injection.payload : BASELINE.slug;
  const goalName = injection?.source === 'goal.name' ? injection.payload : BASELINE.goalName;
  const attribution =
    injection?.source === 'market.attribution' ? injection.payload : BASELINE.attribution;
  const merchantRow =
    injection?.source === 'merchant.descriptor' || injection?.source === 'transaction.memo'
      ? injection.payload
      : 'merchant-software';
  return {
    ledger: inMemoryLedgerPort({
      accounts: [
        {
          id: 'acct-checking',
          type: 'checking',
          isCash: true,
          balance: usd(2_123_500),
          apy: 0,
          closed: false,
        },
        {
          id: 'acct-savings',
          type: 'savings',
          isCash: true,
          balance: usd(500_000),
          apy: 0.0425,
          closed: false,
        },
      ],
      netWorthTrend: [
        { month: '2026-07', netWorth: usd(2_150_000) },
        { month: '2026-08', netWorth: usd(2_200_000) },
        { month: '2026-09', netWorth: usd(2_243_500) },
      ],
      cashflow: cashflow(slug),
      categorySpend: [
        { categoryId: 'cat-target', slug, count: 7, total: usd(64_000) },
        {
          categoryId: 'cat-groceries',
          slug: 'groceries.supermarkets',
          count: 90,
          total: usd(1_560_000),
        },
      ],
      merchants: [{ merchantId: merchantRow, count: 12, total: usd(718_800) }],
      transactions: transactions(injection, slug),
    }),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort(streams(injection)),
    investments: inMemoryInvestmentsPort({ holdings: holdings(injection) }),
    marketData: inMemoryMarketDataPort({
      attribution,
      attributionUrl: 'https://fred.stlouisfed.org/',
      observations: [
        {
          seriesId: 'DTB3',
          kind: 'short_term_risk_free',
          observationDate: date('2026-09-17'),
          value: '4.30',
          units: 'percent_per_annum',
          observedOn: date('2026-09-18'),
        },
      ],
    }),
    planning: {
      goals: () =>
        Promise.resolve([
          {
            id: 'goal-house-deposit',
            name: goalName,
            target: usd(2_000_000),
            monthsRemaining: 12,
            fundedRatio: '0.1',
            status: 'off_track' as const,
            requiredMonthly: usd(150_000),
            plannedMonthly: usd(50_000),
          },
        ]),
      riskProfile: () => Promise.resolve(null),
      projection: () => Promise.resolve(null),
    },
  };
}

/** The snapshot a built-in is sent: every scope, the real builder, the real tokeniser. */
export async function redteamSnapshot(injection: Injection | null): Promise<AdvisorSnapshot> {
  const built = await new SnapshotBuilder(redteamPorts(injection)).build({
    userId: REDTEAM_USER_ID,
    kind: 'builtin',
    grantedScopes: ADVISOR_SCOPES,
    today: date(TODAY),
    baseCurrency: USD,
    tokenKey: deriveTokenKey('wp-5-4-redteam', REDTEAM_USER_ID),
  });
  return built.snapshot;
}
