// SPDX-License-Identifier: MIT
/**
 * The seed cases every catalogue proof runs against.
 *
 * Three ports fixtures, each built into a **real snapshot by `SnapshotBuilder`**
 * rather than hand-written as an object literal. That matters more than it
 * looks: every evidence ref a rule emits has to resolve against the snapshot the
 * platform would actually have sent, and a hand-written fixture is a fixture
 * whose shape agrees with the rules because the same person wrote both. Going
 * through the builder means the rounding, the bucketing, the tokenisation and
 * the `null`-block rules are all the production ones.
 *
 * | Case | What it is | What should fire |
 * | --- | --- | --- |
 * | `drift` | Cash-heavy, three subscriptions, a price rise, a creeping category, a month in the red, a $150.00 movie charge miles above four ordinary ones, and a first-time $599.00 software charge; **a 66-year-old retiree** whose plan is below target, drawing above the guardrail band, inside the RMD window and claiming before seventy, with one goal off pace | U2, U3, U7, C1, C2, S1, S2, S3, S5, S6, S7, S9, S10; R2, R3, R4, R6, R7 |
 * | `tight` | One thin current account with two large bills landing inside a fortnight; **a 34-year-old** whose stated plan assumes more saving than is observed | C3, C4, C7; R1 |
 * | `control` | The same person, with none of the problems; a plan on target, contributions derived, every goal on pace | nothing |
 *
 * **WP 4.9.** The planning answers go through `inMemoryPlanningPort` and the
 * real builder, like everything else here — so `goal_ref` is the builder's own
 * `GOAL_` pseudonym, the terminal band is the builder's $1,000 rounding, and a
 * malformed decimal would be refused by the builder before a rule saw it.
 *
 * Two cases rather than one because some of the catalogue is mutually exclusive
 * by construction: C1 fires above six months of cover and C4 below three, and no
 * single balance can do both. The control exists so "fires on the case it was
 * designed for" has a partner — a rule that fired on everything would pass the
 * first half of that test and be useless.
 */
import { DateOnly, Money, newId } from '@core/kernel';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import { SnapshotBuilder } from '../../src/snapshot/builder.ts';
import {
  inMemoryBudgetPort,
  inMemoryCategorizationPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryPlanningPort,
  inMemoryRecurringPort,
  type CategorizationPort,
  type FakeLedgerData,
  type InsightsGoal,
  type InsightsPlanProjection,
  type PlanningPort,
  type InsightsRecurringStream,
  type InsightsTransaction,
  type MonthlyCashflowRow,
  type SnapshotPorts,
} from '../../src/snapshot/ports.ts';
import { deriveTokenKey } from '../../src/snapshot/tokens.ts';
import { ADVISOR_SCOPES } from '../../src/contract/scopes.ts';
import type { AdvisorSnapshot } from '../../src/contract/snapshot.ts';
import { noisyAggregateBlocks, portfolioBlocks } from '../fixtures/portfolio.ts';

export const TODAY = '2026-09-19';
export const USD = 'USD';
const USER_ID = '01930000-0000-7000-8000-0000000000ee';

function usd(minor: number): Money {
  return Money.of(BigInt(minor), USD);
}

function date(text: string): DateOnly {
  return DateOnly.parse(text);
}

// ---------------------------------------------------------------------------
// Cashflow
// ---------------------------------------------------------------------------

interface MonthSpec {
  readonly month: string;
  readonly income: number;
  readonly expense: number;
  readonly categories: readonly (readonly [string, number])[];
}

function cashflowRows(specs: readonly MonthSpec[]): readonly MonthlyCashflowRow[] {
  return specs.map((spec) => ({
    month: spec.month,
    income: usd(spec.income),
    expense: usd(spec.expense),
    byCategory: spec.categories.map(([slug, amount]) => ({
      categoryId: `cat-${slug}`,
      slug,
      amount: usd(amount),
    })),
  }));
}

/** `2025-06` … `2026-09`, inclusive. The window every case shares. */
function monthSequence(from: string, count: number): readonly string[] {
  const months: string[] = [];
  const [yearText = '2026', monthText = '01'] = from.split('-');
  let year = Number(yearText);
  let month = Number(monthText);
  for (let index = 0; index < count; index += 1) {
    months.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Case: drift
// ---------------------------------------------------------------------------

const DRIFT_MONTHS: readonly MonthSpec[] = monthSequence('2025-06', 16).map((month) => {
  if (month === '2026-09') {
    // The part-month. Every trailing average in the catalogue excludes it.
    return {
      month,
      income: 300_000,
      expense: 215_000,
      categories: [
        ['housing.rent', 200_000],
        ['dining.restaurants', 15_000],
      ],
    };
  }
  if (month === '2026-08') {
    // A month in the red, and $2,350 of it uncategorised — which is also why
    // S3 has something to find in `transactions.raw`.
    return {
      month,
      income: 540_000,
      expense: 610_000,
      categories: [
        ['housing.rent', 200_000],
        ['groceries.supermarkets', 130_000],
        ['dining.restaurants', 45_000],
      ],
    };
  }
  const dining = month === '2026-06' || month === '2026-07' ? 45_000 : 20_000;
  return {
    month,
    income: 540_000,
    expense: 330_000 + dining,
    categories: [
      ['housing.rent', 200_000],
      ['groceries.supermarkets', 130_000],
      ['dining.restaurants', dining],
    ],
  };
});

function stream(overrides: Partial<InsightsRecurringStream>): InsightsRecurringStream {
  return {
    id: 'series-placeholder',
    merchantId: 'merchant-placeholder',
    cadence: 'MONTHLY',
    type: 'SUBSCRIPTION',
    status: 'ACTIVE',
    userConfirmed: true,
    confidence: 0.9,
    typicalAmount: usd(1_000),
    observedMin: usd(1_000),
    observedMax: usd(1_000),
    nextDueDate: date('2026-10-01'),
    firstSeen: date('2025-06-01'),
    lastSeen: date('2026-09-01'),
    periodsPerYear: 12,
    eligibleForImpact: true,
    priceChanges: [],
    ...overrides,
  };
}

const DRIFT_STREAMS: readonly InsightsRecurringStream[] = [
  stream({
    id: 'series-stream-a',
    merchantId: 'merchant-stream-a',
    confidence: 0.94,
    typicalAmount: usd(1_899),
    observedMin: usd(1_599),
    observedMax: usd(1_899),
    nextDueDate: date('2026-10-01'),
    priceChanges: [
      {
        effectiveDate: date('2026-06-01'),
        direction: 'INCREASE',
        previousAmount: usd(1_599),
        newAmount: usd(1_899),
        annualImpact: usd(3_600),
      },
    ],
  }),
  stream({
    id: 'series-stream-b',
    merchantId: 'merchant-stream-b',
    typicalAmount: usd(1_499),
    observedMin: usd(1_499),
    observedMax: usd(1_499),
    nextDueDate: date('2026-10-05'),
  }),
  stream({
    id: 'series-software',
    merchantId: 'merchant-software',
    confidence: 0.92,
    typicalAmount: usd(59_900),
    observedMin: usd(59_900),
    observedMax: usd(59_900),
    nextDueDate: date('2026-10-12'),
  }),
  stream({
    id: 'series-insurance',
    merchantId: 'merchant-insurance',
    cadence: 'ANNUAL',
    type: 'UTILITY',
    confidence: 0.88,
    typicalAmount: usd(720_000),
    observedMin: usd(700_000),
    observedMax: usd(720_000),
    nextDueDate: date('2026-11-15'),
    periodsPerYear: 1,
  }),
  stream({
    id: 'series-water',
    merchantId: 'merchant-water',
    cadence: 'SEMIANNUAL',
    type: 'UTILITY',
    confidence: 0.85,
    typicalAmount: usd(45_000),
    observedMin: usd(43_000),
    observedMax: usd(45_000),
    nextDueDate: date('2026-10-20'),
    periodsPerYear: 2,
  }),
];

const DRIFT_TRANSACTIONS: readonly InsightsTransaction[] = [
  ...['2026-07-01', '2026-08-01', '2026-09-01'].map((day, index) => ({
    id: `txn-stream-a-${String(index)}`,
    date: date(day),
    merchantId: 'merchant-stream-a',
    categorySlug: 'entertainment.streaming',
    amount: usd(-1_899),
  })),
  ...['2026-07-05', '2026-08-05', '2026-09-05'].map((day, index) => ({
    id: `txn-stream-b-${String(index)}`,
    date: date(day),
    merchantId: 'merchant-stream-b',
    categorySlug: 'entertainment.streaming',
    amount: usd(-1_499),
  })),
  ...['2026-07-12', '2026-08-12', '2026-09-12'].map((day, index) => ({
    id: `txn-software-${String(index)}`,
    date: date(day),
    merchantId: 'merchant-software',
    categorySlug: 'subscriptions.software',
    amount: usd(-59_900),
  })),
  // The pair S6 is about: one merchant, one band, two days apart.
  {
    id: 'txn-market-first',
    date: date('2026-09-04'),
    merchantId: 'merchant-market',
    categorySlug: 'groceries.supermarkets',
    amount: usd(-8_400),
  },
  {
    id: 'txn-market-second',
    date: date('2026-09-06'),
    merchantId: 'merchant-market',
    categorySlug: 'groceries.supermarkets',
    amount: usd(-8_450),
  },
  // Twelve rows with no category. S3's trigger is a count; its copy is not.
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `txn-unfiled-${String(index)}`,
    date: date(`2026-08-${String(index + 10).padStart(2, '0')}`),
    merchantId: `merchant-unfiled-${String(index)}`,
    categorySlug: null,
    amount: usd(-2_500),
  })),
  // WP 5.7, S1's case: a category needs at least five outflows before
  // `transactions.anomalies` will found a baseline on it (no existing
  // category here had five), and one genuine outlier among them. Four
  // ordinary charges (median 2050, MAD 50) and one at 150.00 — a deviation of
  // 12950, comfortably over `3 × MAD` (150) and the $25 floor (2500).
  {
    id: 'txn-movies-0',
    date: date('2026-06-15'),
    merchantId: 'merchant-movies',
    accountId: 'acct-checking',
    categorySlug: 'entertainment.movies',
    amount: usd(-2_000),
  },
  {
    id: 'txn-movies-1',
    date: date('2026-07-15'),
    merchantId: 'merchant-movies',
    accountId: 'acct-checking',
    categorySlug: 'entertainment.movies',
    amount: usd(-2_100),
  },
  {
    id: 'txn-movies-2',
    date: date('2026-08-15'),
    merchantId: 'merchant-movies',
    accountId: 'acct-checking',
    categorySlug: 'entertainment.movies',
    amount: usd(-1_900),
  },
  {
    id: 'txn-movies-3',
    date: date('2026-09-01'),
    merchantId: 'merchant-movies',
    accountId: 'acct-checking',
    categorySlug: 'entertainment.movies',
    amount: usd(-2_050),
  },
  {
    id: 'txn-movies-outlier',
    date: date('2026-09-15'),
    merchantId: 'merchant-movies',
    accountId: 'acct-checking',
    categorySlug: 'entertainment.movies',
    amount: usd(-15_000),
  },
  // WP 5.7, `fees.summary`'s case: the fee hunter reads raw fee-category rows
  // (`categorySpend`'s aggregate is `builtin.spending.fees`' own source, a
  // different scope). Two ATM fees, months apart — the `0-10` amount band is
  // outside S6's `DUPLICATE_BANDS`, so this pair is not read as a duplicate.
  {
    id: 'txn-atm-fee-0',
    date: date('2026-04-10'),
    merchantId: 'merchant-atm',
    accountId: 'acct-checking',
    categorySlug: 'fees_and_services.atm_fees',
    amount: usd(-350),
  },
  {
    id: 'txn-atm-fee-1',
    date: date('2026-07-10'),
    merchantId: 'merchant-atm',
    accountId: 'acct-checking',
    categorySlug: 'fees_and_services.atm_fees',
    amount: usd(-350),
  },
];

const DRIFT_LEDGER: FakeLedgerData = {
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
    {
      id: 'acct-card',
      type: 'other',
      isCash: false,
      balance: usd(-380_000),
      apy: null,
      closed: false,
    },
  ],
  netWorthTrend: [
    { month: '2026-07', netWorth: usd(2_150_000) },
    { month: '2026-08', netWorth: usd(2_200_000) },
    { month: '2026-09', netWorth: usd(2_243_500) },
  ],
  cashflow: cashflowRows(DRIFT_MONTHS),
  categorySpend: [
    { categoryId: 'cat-dining', slug: 'dining.restaurants', count: 120, total: usd(360_000) },
    {
      categoryId: 'cat-groceries',
      slug: 'groceries.supermarkets',
      count: 90,
      total: usd(1_560_000),
    },
    {
      categoryId: 'cat-bank-fees',
      slug: 'fees_and_services.bank_fees',
      count: 2,
      total: usd(3_500),
    },
    { categoryId: 'cat-atm-fees', slug: 'fees_and_services.atm_fees', count: 4, total: usd(6_000) },
    {
      categoryId: 'cat-foreign-fees',
      slug: 'fees_and_services.foreign_fees',
      count: 3,
      total: usd(8_900),
    },
  ],
  merchants: [
    { merchantId: 'merchant-software', count: 12, total: usd(718_800) },
    { merchantId: 'merchant-market', count: 40, total: usd(336_000) },
  ],
  transactions: DRIFT_TRANSACTIONS,
};

// ---------------------------------------------------------------------------
// Case: tight
// ---------------------------------------------------------------------------

const TIGHT_MONTHS: readonly MonthSpec[] = monthSequence('2025-08', 14).map((month) => {
  if (month === '2026-09') {
    return {
      month,
      income: 180_000,
      expense: 175_000,
      categories: [
        ['housing.rent', 100_000],
        ['groceries.supermarkets', 65_000],
      ],
    };
  }
  return {
    month,
    income: 360_000,
    expense: 350_000,
    categories: [
      ['housing.rent', 200_000],
      ['groceries.supermarkets', 130_000],
      ['dining.restaurants', 20_000],
    ],
  };
});

const TIGHT_LEDGER: FakeLedgerData = {
  accounts: [
    {
      id: 'acct-tight-checking',
      type: 'checking',
      isCash: true,
      balance: usd(188_420),
      apy: 0,
      closed: false,
    },
  ],
  netWorthTrend: [{ month: '2026-09', netWorth: usd(188_420) }],
  cashflow: cashflowRows(TIGHT_MONTHS),
  categorySpend: [
    { categoryId: 'cat-dining', slug: 'dining.restaurants', count: 60, total: usd(240_000) },
  ],
  merchants: [{ merchantId: 'merchant-landlord', count: 12, total: usd(1_740_000) }],
  transactions: [
    {
      id: 'txn-tight-rent',
      date: date('2026-08-24'),
      merchantId: 'merchant-landlord',
      categorySlug: 'housing.rent',
      amount: usd(-145_000),
    },
    {
      id: 'txn-tight-power',
      date: date('2026-08-28'),
      merchantId: 'merchant-power',
      categorySlug: 'utilities.electricity_and_gas',
      amount: usd(-80_000),
    },
    {
      id: 'txn-tight-shop',
      date: date('2026-09-02'),
      merchantId: 'merchant-market',
      categorySlug: 'groceries.supermarkets',
      amount: usd(-6_200),
    },
  ],
};

const TIGHT_STREAMS: readonly InsightsRecurringStream[] = [
  stream({
    id: 'series-rent',
    merchantId: 'merchant-landlord',
    type: 'UTILITY',
    confidence: 0.95,
    typicalAmount: usd(145_000),
    observedMin: usd(145_000),
    observedMax: usd(145_000),
    nextDueDate: date('2026-09-24'),
  }),
  stream({
    id: 'series-power',
    merchantId: 'merchant-power',
    type: 'UTILITY',
    typicalAmount: usd(80_000),
    observedMin: usd(70_000),
    observedMax: usd(90_000),
    nextDueDate: date('2026-09-28'),
  }),
];

// ---------------------------------------------------------------------------
// Case: control
// ---------------------------------------------------------------------------

const CONTROL_MONTHS: readonly MonthSpec[] = monthSequence('2025-06', 16).map((month) => {
  if (month === '2026-09') {
    return {
      month,
      income: 270_000,
      expense: 175_000,
      categories: [
        ['housing.rent', 100_000],
        ['groceries.supermarkets', 65_000],
      ],
    };
  }
  return {
    month,
    income: 540_000,
    expense: 350_000,
    categories: [
      ['housing.rent', 200_000],
      ['groceries.supermarkets', 130_000],
      ['dining.restaurants', 20_000],
    ],
  };
});

const CONTROL_LEDGER: FakeLedgerData = {
  accounts: [
    {
      id: 'acct-ctl-checking',
      type: 'checking',
      isCash: true,
      balance: usd(400_000),
      apy: 0.0425,
      closed: false,
    },
    {
      id: 'acct-ctl-savings',
      type: 'savings',
      isCash: true,
      balance: usd(1_000_000),
      apy: 0.0425,
      closed: false,
    },
  ],
  netWorthTrend: [{ month: '2026-09', netWorth: usd(1_400_000) }],
  cashflow: cashflowRows(CONTROL_MONTHS),
  categorySpend: [
    { categoryId: 'cat-dining', slug: 'dining.restaurants', count: 100, total: usd(240_000) },
    {
      categoryId: 'cat-groceries',
      slug: 'groceries.supermarkets',
      count: 80,
      total: usd(1_560_000),
    },
  ],
  merchants: [{ merchantId: 'merchant-ctl-market', count: 40, total: usd(336_000) }],
  transactions: [
    {
      id: 'txn-ctl-stream',
      date: date('2026-09-01'),
      merchantId: 'merchant-ctl-stream',
      categorySlug: 'entertainment.streaming',
      amount: usd(-1_899),
    },
    {
      id: 'txn-ctl-market',
      date: date('2026-09-03'),
      merchantId: 'merchant-ctl-market',
      categorySlug: 'groceries.supermarkets',
      amount: usd(-9_100),
    },
    {
      id: 'txn-ctl-rent',
      date: date('2026-09-02'),
      merchantId: 'merchant-ctl-landlord',
      categorySlug: 'housing.rent',
      amount: usd(-200_000),
    },
    {
      id: 'txn-ctl-fuel',
      date: date('2026-08-19'),
      merchantId: 'merchant-ctl-fuel',
      categorySlug: 'transport.fuel',
      amount: usd(-5_400),
    },
  ],
};

const CONTROL_STREAMS: readonly InsightsRecurringStream[] = [
  stream({
    id: 'series-ctl-stream',
    merchantId: 'merchant-ctl-stream',
    typicalAmount: usd(1_899),
    observedMin: usd(1_899),
    observedMax: usd(1_899),
    nextDueDate: date('2026-10-01'),
  }),
];

// ---------------------------------------------------------------------------
// Planning — WP 4.9
// ---------------------------------------------------------------------------

/** A fixed assumptions hash. Evidence, not identity; masked verbatim by the tracer. */
export const SEED_ASSUMPTIONS_VERSION = `sha256:${'a1'.repeat(32)}`;

function goal(overrides: Partial<InsightsGoal> & Pick<InsightsGoal, 'id' | 'name'>): InsightsGoal {
  return {
    target: usd(600_000),
    monthsRemaining: 24,
    fundedRatio: '0.5',
    status: 'on_track',
    requiredMonthly: usd(12_500),
    plannedMonthly: usd(15_000),
    ...overrides,
  };
}

function projection(overrides: Partial<InsightsPlanProjection>): InsightsPlanProjection {
  return {
    asOfYear: 2026,
    currency: USD,
    method: 'monte_carlo',
    paths: 10_000,
    assumptionsVersion: SEED_ASSUMPTIONS_VERSION,
    stale: false,
    successProbability: '0.912000',
    successTarget: '0.80',
    terminal: {
      age: 95,
      calendarYear: 2076,
      p5: usd(12_345_678),
      p50: usd(98_765_432),
      p95: usd(301_234_567),
    },
    ages: { current: 45, retirement: 65, planEnd: 95 },
    savingsRate: null,
    rmd: null,
    socialSecurity: null,
    guardrail: null,
    ...overrides,
  };
}

/**
 * `drift`'s holder: 66, retired at 65, born 1960 (so SECURE 2.0's start age is
 * 75, in 2035). The plan survives 71.3% of 10,000 simulations against an 80%
 * target (R2); 62% of what it starts from is tax-deferred, nine years before
 * distributions (R3); it claims at 67, and the factor at seventy is 1.24 (R4);
 * this year it draws 6.12% against a 3.6%–5.4% band (R7). One goal is WP 4.6's
 * own worked R6 case — $20,000 in twelve months, $2,000 funded, $500 a month
 * planned, so $1,500 a month needed — and one is on pace and must stay silent.
 */
const DRIFT_PLANNING: PlanningPort = inMemoryPlanningPort({
  goals: [
    goal({
      id: 'goal-house-deposit',
      name: 'House deposit',
      target: usd(2_000_000),
      monthsRemaining: 12,
      fundedRatio: '0.1',
      status: 'off_track',
      requiredMonthly: usd(150_000),
      plannedMonthly: usd(50_000),
    }),
    goal({ id: 'goal-sabbatical', name: 'Sabbatical' }),
  ],
  riskProfile: {
    tolerance: 'moderate',
    horizonYears: 29,
    taxBracketBand: '22-24',
    liquidityNeed: 'medium',
  },
  projection: projection({
    successProbability: '0.713000',
    terminal: {
      age: 95,
      calendarYear: 2055,
      p5: usd(0),
      p50: usd(41_234_567),
      p95: usd(187_345_678),
    },
    ages: { current: 66, retirement: 65, planEnd: 95 },
    rmd: { startAge: 75, startYear: 2035, taxDeferredShare: '0.62' },
    socialSecurity: {
      claimAgeYears: 67,
      claimAgeMonths: 0,
      claimFactor: '1',
      factorAt70: '1.24',
    },
    guardrail: {
      withdrawalRate: '0.0612',
      referenceRate: '0.045',
      lower: '0.036',
      upper: '0.054',
      position: 'above',
    },
  }),
});

/**
 * `tight`'s holder: 34, accumulating, and the plan they wrote down assumes
 * 15% of income saved where the months observed show 8.5% (R1). Nothing else
 * about the plan is wrong: 91.2% against 80%, no guardrail (not retired), and
 * forty-one years from distributions.
 */
const TIGHT_PLANNING: PlanningPort = inMemoryPlanningPort({
  projection: projection({
    ages: { current: 34, retirement: 65, planEnd: 95 },
    savingsRate: { plan: '0.15', observed: '0.085', planSource: 'stated' },
    rmd: { startAge: 75, startYear: 2067, taxDeferredShare: '0.4' },
    socialSecurity: {
      claimAgeYears: 67,
      claimAgeMonths: 0,
      claimFactor: '1',
      factorAt70: '1.24',
    },
  }),
});

/**
 * The control's plan is healthy in every respect the family reads: on
 * target, contributions derived (so the two rates agree by construction and R1
 * is silent by design, not by threshold), outside the RMD window, claiming at
 * seventy, still accumulating, and every goal on pace.
 */
const CONTROL_PLANNING: PlanningPort = inMemoryPlanningPort({
  goals: [goal({ id: 'goal-ctl-emergency', name: 'Emergency fund top-up' })],
  riskProfile: {
    tolerance: 'moderate',
    horizonYears: 20,
    taxBracketBand: '22-24',
    liquidityNeed: 'low',
  },
  projection: projection({
    savingsRate: { plan: '0.12', observed: '0.12', planSource: 'derived' },
    rmd: { startAge: 75, startYear: 2056, taxDeferredShare: '0.3' },
    socialSecurity: {
      claimAgeYears: 70,
      claimAgeMonths: 0,
      claimFactor: '1.24',
      factorAt70: '1.24',
    },
  }),
});

// ---------------------------------------------------------------------------
// WP 11.1 — `categorization.rule_candidates`
// ---------------------------------------------------------------------------

/**
 * The merchants `drift`'s holder keeps filing by hand. One pair qualifies
 * (the pet store, four times, no rule, not locked); every other pair is a
 * reason the advisor must stay quiet — two confirmations, a rule already
 * filing it, a locked category, and a merchant filed two ways. `tight` and
 * `control` bind no port, so their snapshots carry no key at all.
 */
const DRIFT_CATEGORIZATION: CategorizationPort = inMemoryCategorizationPort([
  {
    merchantId: 'merchant-pet-store',
    categoryId: 'cat-pets',
    categorySlug: 'shopping.pets',
    confirmations: 4,
    transactionIds: ['txn-pets-4', 'txn-pets-3', 'txn-pets-2', 'txn-pets-1'],
    coveredByRule: false,
    lockedDefault: false,
  },
  {
    merchantId: 'merchant-gym',
    categoryId: 'cat-fitness',
    categorySlug: 'health.fitness',
    confirmations: 5,
    transactionIds: ['txn-gym-5', 'txn-gym-4', 'txn-gym-3', 'txn-gym-2', 'txn-gym-1'],
    coveredByRule: true,
    lockedDefault: false,
  },
  {
    merchantId: 'merchant-grocer',
    categoryId: 'cat-groceries',
    categorySlug: 'food.groceries',
    confirmations: 3,
    transactionIds: ['txn-grocer-3', 'txn-grocer-2', 'txn-grocer-1'],
    coveredByRule: false,
    lockedDefault: true,
  },
  {
    merchantId: 'merchant-bigbox',
    categoryId: 'cat-groceries',
    categorySlug: 'food.groceries',
    confirmations: 3,
    transactionIds: ['txn-bigbox-6', 'txn-bigbox-4', 'txn-bigbox-2'],
    coveredByRule: false,
    lockedDefault: false,
  },
  {
    merchantId: 'merchant-bigbox',
    categoryId: 'cat-household',
    categorySlug: 'shopping.household',
    confirmations: 3,
    transactionIds: ['txn-bigbox-5', 'txn-bigbox-3', 'txn-bigbox-1'],
    coveredByRule: false,
    lockedDefault: false,
  },
  {
    merchantId: 'merchant-cafe',
    categoryId: 'cat-coffee',
    categorySlug: 'food.coffee',
    confirmations: 2,
    transactionIds: ['txn-cafe-2', 'txn-cafe-1'],
    coveredByRule: false,
    lockedDefault: false,
  },
]);

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export type SeedCase = 'drift' | 'tight' | 'control';

function portsFor(seedCase: SeedCase): SnapshotPorts {
  switch (seedCase) {
    case 'drift':
      return {
        ledger: inMemoryLedgerPort(DRIFT_LEDGER),
        budget: inMemoryBudgetPort(null),
        recurring: inMemoryRecurringPort(DRIFT_STREAMS),
        // WP 3.10a landed the four portfolio arms, and these seeds still carry
        // no portfolio *through the ports*: see `seedSnapshot` below for the
        // one thing that is still merged and the exact reason it is.
        investments: inMemoryInvestmentsPort({}),
        marketData: inMemoryMarketDataPort(null),
        planning: DRIFT_PLANNING,
        categorization: DRIFT_CATEGORIZATION,
      };
    case 'tight':
      return {
        ledger: inMemoryLedgerPort(TIGHT_LEDGER),
        budget: inMemoryBudgetPort(null),
        recurring: inMemoryRecurringPort(TIGHT_STREAMS),
        // WP 3.10a landed the four portfolio arms, and these seeds still carry
        // no portfolio *through the ports*: see `seedSnapshot` below for the
        // one thing that is still merged and the exact reason it is.
        investments: inMemoryInvestmentsPort({}),
        marketData: inMemoryMarketDataPort(null),
        planning: TIGHT_PLANNING,
      };
    default:
      return {
        ledger: inMemoryLedgerPort(CONTROL_LEDGER),
        budget: inMemoryBudgetPort(null),
        recurring: inMemoryRecurringPort(CONTROL_STREAMS),
        // WP 3.10a landed the four portfolio arms, and these seeds still carry
        // no portfolio *through the ports*: see `seedSnapshot` below for the
        // one thing that is still merged and the exact reason it is.
        investments: inMemoryInvestmentsPort({}),
        marketData: inMemoryMarketDataPort(null),
        planning: CONTROL_PLANNING,
      };
  }
}

/**
 * Build one case's snapshot, for a chosen grant.
 *
 * `scopes` defaults to everything, so a rule that reads a scope it never
 * declared would still work here — which is why `catalog.test.ts` also builds a
 * snapshot from **only each rule's declared scopes** and asserts the rule still
 * produces what it produced. A manifest that under-declares is caught there.
 */
export async function seedSnapshot(
  seedCase: SeedCase,
  scopes: readonly string[] = ADVISOR_SCOPES,
): Promise<AdvisorSnapshot> {
  const built = await new SnapshotBuilder(portsFor(seedCase)).build({
    userId: USER_ID,
    kind: 'builtin',
    grantedScopes: scopes as readonly (typeof ADVISOR_SCOPES)[number][],
    today: date(TODAY),
    baseCurrency: USD,
    tokenKey: deriveTokenKey('wp-2-7-seed', USER_ID),
  });
  // WP 3.10a landed the four arms, so this merge is no longer *load-bearing
  // for the builder* — it is load-bearing for these three seeds, which carry no
  // portfolio through their ports. §7.1 step 3 asks for the merge to be deleted
  // and the blocks produced by `SnapshotBuilder`; three of the four can move
  // today and `liabilities.terms` cannot, which is why none has yet:
  // `advisor-golden.test.ts` pins insight keys containing the fixture's
  // `LIAB_a1b2c3d4e5f6` literals, and a builder-minted `liability_ref` is an
  // HMAC of an account id this fixture does not have. Moving the block means
  // re-pinning every D-family golden in the same change — owed, named here, and
  // deliberately not folded into WP 3.10a's diff.
  //
  // What replaced the merge as the *proof* is `test/snapshot-arms.test.ts`,
  // which drives each arm through the real builder over the real port types,
  // and `apps/api/test/db/phase3-advisors.test.ts`, which drives all four over
  // a real database.
  //
  // **`drift` only.** `control` and `tight` keep no portfolio at all, which is
  // what makes the control half of `advisor-golden.test.ts` mean something for
  // the I, D and X families: a rule that fired on a person with no holdings
  // would pass "it fires" and be useless.
  if (seedCase !== 'drift') return built.snapshot;
  return { ...built.snapshot, ...portfolioBlocks(scopes) };
}

/**
 * The `drift` case with the unclassified share past 07 §4.3's ceiling.
 *
 * Everything else is identical, so the only thing that can explain I1 going
 * quiet between `seedSnapshot('drift')` and this is the suppression itself.
 * `test/i1-suppression.test.ts` is built on that pair.
 */
export async function noisySeedSnapshot(): Promise<AdvisorSnapshot> {
  const snapshot = await seedSnapshot('drift');
  return { ...snapshot, ...noisyAggregateBlocks() };
}

/** No budget exists in any case, so every rule degrades without one (07 §3). */
export const EMPTY_SNAPSHOT: AdvisorSnapshot = {};

/**
 * The request the platform would send this advisor with this snapshot.
 *
 * Here rather than in a test file because three suites need it and a `it`
 * registration imported across files would run twice. The limits are the
 * manifest's own, so a rule that emitted more than it declared fails step 3
 * exactly as it would in production.
 */
export function requestFor(manifest: AdvisorManifest, snapshot: AdvisorSnapshot): AdvisorRequest {
  return {
    contract_version: 1,
    request_id: newId(),
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: manifest.kind,
    generated_at: `${TODAY}T08:15:00.000Z`,
    base_currency: USD,
    time_zone: 'America/New_York',
    today: TODAY,
    granted_scopes: [...manifest.requires_scopes],
    input_digest: `sha256:${'b'.repeat(64)}`,
    limits: {
      max_insights: manifest.limits.max_insights,
      max_response_bytes: manifest.limits.max_response_bytes,
      deadline: `${TODAY}T08:20:00.000Z`,
    },
    snapshot,
  };
}
