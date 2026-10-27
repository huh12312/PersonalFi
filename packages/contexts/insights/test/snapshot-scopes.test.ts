// SPDX-License-Identifier: MIT
/**
 * `SnapshotBuilder` — the single implementation point for data minimisation.
 *
 * The two exit tests the plan names are the first two below. Both are claims
 * about *absence*, which is the hard kind to test, so each one asserts two
 * things: that the key is gone, and that the builder would have produced it had
 * the scope been granted. Without the second half, a builder that emitted
 * nothing at all would pass.
 *
 * **Sabotage record.** `'an ungranted scope yields no key in the snapshot'` was
 * run once with the builder's loop changed to iterate `SCOPE_CATALOGUE` instead
 * of the effective grant; `'transactions.raw is never emitted for an external
 * advisor'` was run once with `externalAllowed` ignored in
 * `scopesPermittedForKind`. Both red on the first try; both restored. Recorded
 * in docs/evidence/phase-2/wp2.6-insights.md §4.
 */
import { DateOnly, Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { SCOPE_CATALOGUE, scopesPermittedForKind } from '../src/contract/scopes.ts';
import { AdvisorSnapshotSchema } from '../src/contract/snapshot.ts';
import { SnapshotBuilder, bucketOf, roundToMultiple } from '../src/snapshot/builder.ts';
import {
  PERCENT_PER_ANNUM,
  inMemoryBudgetPort,
  inMemoryCategorizationPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryRecurringPort,
  type InsightsHoldings,
  type InsightsLiabilities,
  type InsightsMarketRates,
  type SnapshotPorts,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';

const TODAY = DateOnly.parse('2026-09-19');
const usd = (minor: bigint) => Money.of(minor, 'USD');
const TOKEN_KEY = deriveTokenKey('test-secret', '01930000-0000-7000-8000-000000000001');

// ---------------------------------------------------------------------------
// WP 3.10a — the Phase 3 port fixtures
// ---------------------------------------------------------------------------

/**
 * One portfolio, carrying every shape the two holdings arms have to handle.
 *
 * `US_BOND` is in `targets` and **not** in `byAssetClass`: the holder targets
 * 25% bonds and owns none, which is the case §7.1 says must cross as a
 * zero-weight row rather than be omitted.
 *
 * `sec-3` has no symbol, so it must not appear in either block — a position an
 * advisor cannot name is a position it cannot cite.
 */
const HOLDINGS: InsightsHoldings = {
  currency: 'USD',
  aggregate: {
    investableTotal: usd(1_000_000n),
    unclassifiedPct: 0.02,
    byAssetClass: [
      { assetClass: 'US_EQUITY', value: usd(700_000n), weight: 0.7 },
      { assetClass: 'CRYPTO', value: usd(280_000n), weight: 0.28 },
      { assetClass: 'UNCLASSIFIED', value: usd(20_000n), weight: 0.02 },
    ],
    positions: [
      {
        securityId: 'sec-1',
        symbol: 'VTI',
        value: usd(700_000n),
        weight: 0.7,
        assetClass: 'US_EQUITY',
        employerStock: false,
        isCrypto: false,
      },
      {
        securityId: 'sec-2',
        symbol: 'BTC',
        value: usd(280_000n),
        weight: 0.28,
        assetClass: 'CRYPTO',
        employerStock: false,
        isCrypto: true,
      },
      {
        securityId: 'sec-3',
        symbol: null,
        value: usd(20_000n),
        weight: 0.02,
        assetClass: 'UNCLASSIFIED',
        employerStock: false,
        isCrypto: false,
      },
    ],
    targets: [
      { assetClass: 'US_EQUITY', weight: 0.6 },
      { assetClass: 'US_BOND', weight: 0.25 },
    ],
    accountTypeMix: { taxable: 0.72, tax_deferred: 0.28 },
    idleCash: {
      total: usd(1_200_000n),
      floor: usd(100_000n),
      minDays: 14,
      longestIdleDays: 47,
    },
    cryptoCustody: {
      exchangeValue: usd(180_000n),
      selfCustodyValue: usd(100_000n),
      unknownValue: usd(0n),
    },
  },
  positions: [
    {
      securityId: 'sec-1',
      symbol: 'VTI',
      assetClass: 'US_EQUITY',
      accountType: 'taxable',
      quantity: '25.000000000000000000',
      costBasis: usd(500_000n),
      marketValue: usd(700_000n),
      unrealized: usd(200_000n),
      oldestLotDays: 800,
      isCrypto: false,
      isStablecoin: false,
      employerStock: false,
      expenseRatio: 0.0003,
      peerExpenseRatio: 0.0003,
      annualFeeCost: usd(210n),
      highFee: false,
      lots: [
        {
          openedDays: 800,
          quantity: '25.000000000000000000',
          costBasis: usd(500_000n),
          marketValue: usd(700_000n),
          unrealized: usd(200_000n),
          longTerm: true,
        },
      ],
    },
    {
      // No basis. `cost_basis` and `unrealized` must be null *together*.
      securityId: 'sec-2',
      symbol: 'BTC',
      assetClass: 'CRYPTO',
      accountType: 'taxable',
      quantity: '0.500000000000000000',
      costBasis: null,
      marketValue: usd(280_000n),
      unrealized: null,
      oldestLotDays: 120,
      isCrypto: true,
      isStablecoin: false,
      employerStock: false,
      expenseRatio: null,
      peerExpenseRatio: null,
      annualFeeCost: null,
      highFee: false,
      lots: [
        {
          openedDays: 120,
          quantity: '0.500000000000000000',
          costBasis: null,
          marketValue: usd(280_000n),
          unrealized: null,
          longTerm: false,
        },
      ],
    },
    {
      securityId: 'sec-3',
      symbol: null,
      assetClass: 'UNCLASSIFIED',
      accountType: 'unknown',
      quantity: '1.000000000000000000',
      costBasis: null,
      marketValue: usd(20_000n),
      unrealized: null,
      oldestLotDays: 10,
      isCrypto: false,
      isStablecoin: false,
      employerStock: false,
      expenseRatio: null,
      peerExpenseRatio: null,
      annualFeeCost: null,
      highFee: false,
      lots: [],
    },
  ],
};

const LIABILITIES: InsightsLiabilities = {
  currency: 'USD',
  liabilities: [
    {
      id: 'acct-card',
      kind: 'credit_card',
      apr: 0.2399,
      promoApr: null,
      promoAprEndDate: null,
      creditLimit: usd(1_500_000n),
      statementBalance: usd(482_000n),
      currentBalance: usd(482_000n),
      minimumPayment: usd(14_500n),
      paymentDueDate: DateOnly.parse('2026-10-05'),
      lastPaymentDate: DateOnly.parse('2026-09-05'),
      lastPaymentAmount: usd(14_500n),
      minimumOnlyMonths: null,
    },
  ],
};

const FRED_ATTRIBUTION =
  'This product uses the FRED\u00ae API but is not endorsed or certified by the ' +
  'Federal Reserve Bank of St. Louis.';

const RATES: InsightsMarketRates = {
  attribution: FRED_ATTRIBUTION,
  attributionUrl: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html',
  observations: [
    {
      seriesId: 'DGS3MO',
      kind: 'short_term_risk_free',
      observationDate: DateOnly.parse('2026-09-18'),
      value: '5.12',
      units: PERCENT_PER_ANNUM,
      observedOn: DateOnly.parse('2026-09-19'),
    },
    {
      // Observed three days ago: strictly more than one day, so stale.
      seriesId: 'MORTGAGE30US',
      kind: 'mortgage_30y',
      observationDate: DateOnly.parse('2026-09-12'),
      value: '6.34',
      units: PERCENT_PER_ANNUM,
      observedOn: DateOnly.parse('2026-09-16'),
    },
    {
      // An index, not a rate. Refused rather than converted (§7.1 duty 1).
      seriesId: 'CPIAUCSL',
      kind: 'other',
      observationDate: DateOnly.parse('2026-09-01'),
      value: '318.4',
      units: 'index_1982_1984_100',
      observedOn: DateOnly.parse('2026-09-19'),
    },
  ],
};

/** Every Phase-2-sourced block has real data behind it, so absence is a choice. */
function fullPorts(): SnapshotPorts {
  return {
    ledger: inMemoryLedgerPort({
      accounts: [
        {
          id: 'acct-1',
          type: 'checking',
          isCash: true,
          balance: usd(212_350n),
          apy: 0,
          closed: false,
        },
        {
          id: 'acct-2',
          type: 'savings',
          isCash: true,
          balance: usd(200_000n),
          apy: 0.0425,
          closed: false,
        },
        {
          id: 'acct-3',
          type: 'other',
          isCash: false,
          balance: usd(-150_000n),
          apy: null,
          closed: false,
        },
      ],
      netWorthTrend: [
        { month: '2026-08', netWorth: usd(250_000n) },
        { month: '2026-09', netWorth: usd(262_350n) },
      ],
      cashflow: [
        {
          month: '2026-09',
          income: usd(500_000n),
          expense: usd(310_000n),
          byCategory: [{ categoryId: 'cat-1', slug: 'food.dining', amount: usd(42_000n) }],
        },
      ],
      categorySpend: [{ categoryId: 'cat-1', slug: 'food.dining', count: 14, total: usd(42_000n) }],
      merchants: [{ merchantId: 'merch-1', count: 12, total: usd(22_788n) }],
      transactions: [
        {
          id: 'txn-1',
          date: DateOnly.parse('2026-09-01'),
          merchantId: 'merch-1',
          categorySlug: 'entertainment.streaming',
          amount: usd(-1899n),
        },
      ],
    }),
    budget: inMemoryBudgetPort({
      startDate: DateOnly.parse('2026-09-01'),
      endDate: DateOnly.parse('2026-10-01'),
      kind: 'CALENDAR_MONTH',
      currency: 'USD',
      readyToAssign: usd(15_000n),
      lines: [
        {
          id: 'line-1',
          categoryId: 'cat-1',
          categorySlug: 'food.dining',
          kind: 'CATEGORY',
          assigned: usd(40_000n),
          activity: usd(-42_000n),
          available: usd(-2000n),
          cashOverspend: usd(2000n),
          creditOverspend: usd(0n),
          neededThisPeriod: usd(40_000n),
          underfunded: usd(2000n),
        },
      ],
    }),
    recurring: inMemoryRecurringPort([
      {
        id: 'series-1',
        merchantId: 'merch-1',
        cadence: 'MONTHLY',
        type: 'SUBSCRIPTION',
        status: 'ACTIVE',
        userConfirmed: true,
        confidence: 0.94,
        typicalAmount: usd(1899n),
        observedMin: usd(1899n),
        observedMax: usd(1899n),
        nextDueDate: DateOnly.parse('2026-10-01'),
        firstSeen: DateOnly.parse('2025-10-01'),
        lastSeen: DateOnly.parse('2026-09-01'),
        periodsPerYear: 12,
        eligibleForImpact: true,
        priceChanges: [],
      },
    ]),
    // WP 3.10a. The four Phase 3 scopes get real data here for the same reason
    // the Phase 2 ones do: this suite's whole argument is that a *missing* key
    // is a decision, and a block that could not have been filled proves
    // nothing about the decision not to fill it.
    investments: inMemoryInvestmentsPort({
      holdings: HOLDINGS,
      liabilities: LIABILITIES,
    }),
    marketData: inMemoryMarketDataPort(RATES),
    // WP 11.1, for the same reason: `categorization.rule_candidates` is
    // filled here, so the whole-catalogue schema check below covers it.
    categorization: inMemoryCategorizationPort([
      {
        merchantId: 'merchant-1',
        categoryId: 'cat-pets',
        categorySlug: 'shopping.pets',
        confirmations: 3,
        transactionIds: ['txn-3', 'txn-2', 'txn-1'],
        coveredByRule: false,
        lockedDefault: false,
      },
    ]),
  };
}

async function build(
  kind: 'builtin' | 'local_model' | 'external',
  grantedScopes: readonly string[],
) {
  return new SnapshotBuilder(fullPorts()).build({
    userId: '01930000-0000-7000-8000-000000000001',
    kind,
    grantedScopes: grantedScopes as never,
    today: TODAY,
    baseCurrency: 'USD',
    tokenKey: TOKEN_KEY,
  });
}

describe('snapshot scopes', () => {
  it('an ungranted scope yields no key in the snapshot', async () => {
    const withBudget = await build('builtin', ['budgets.status', 'cash.summary']);
    // The positive half: the builder *can* produce this block from these ports.
    expect(Object.keys(withBudget.snapshot)).toContain('budgets_status');

    const withoutBudget = await build('builtin', ['cash.summary']);
    expect(Object.keys(withoutBudget.snapshot)).not.toContain('budgets_status');
    expect(Object.keys(withoutBudget.snapshot)).toEqual(['cash_summary']);
    // Not `null`, not `{}` — no key at all. An advisor cannot tell a `null`
    // block from an empty one and would reason about zero.
    expect('budgets_status' in withoutBudget.snapshot).toBe(false);
  });

  it('transactions.raw is never emitted for an external advisor', async () => {
    const builtin = await build('builtin', ['transactions.raw']);
    expect(Object.keys(builtin.snapshot)).toContain('transactions_raw');

    // Granted, explicitly, and still absent. The per-kind ceiling is applied to
    // the grant itself, so the request the advisor receives does not even claim
    // the scope.
    const external = await build('external', ['transactions.raw', 'cash.summary']);
    expect(Object.keys(external.snapshot)).not.toContain('transactions_raw');
    expect(external.grantedScopes).not.toContain('transactions.raw');
    expect(scopesPermittedForKind('external')).not.toContain('transactions.raw');
    expect(scopesPermittedForKind('external')).not.toContain('institutions.names');
  });

  it('categorization.rule_candidates: no key ungranted, none for an external advisor', async () => {
    // WP 11.1. The positive half first: these ports can fill the block.
    const builtin = await build('builtin', ['categorization.rule_candidates', 'cash.summary']);
    expect(Object.keys(builtin.snapshot)).toContain('rule_candidates');

    const ungranted = await build('builtin', ['cash.summary']);
    expect('rule_candidates' in ungranted.snapshot).toBe(false);

    const external = await build('external', ['categorization.rule_candidates', 'cash.summary']);
    expect('rule_candidates' in external.snapshot).toBe(false);
    expect(external.grantedScopes).not.toContain('categorization.rule_candidates');
    expect(scopesPermittedForKind('external')).not.toContain('categorization.rule_candidates');
  });

  it('a granted scope with no source behind it yields no key either', async () => {
    // `goals.list` and `risk.profile` are `@ctx/planning`'s and Phase 4's. A
    // granted-but-unsourced scope must be indistinguishable from an ungranted
    // one, because an empty block is a block an advisor will reason about.
    //
    // This used to be `holdings.aggregate`'s test. WP 3.10a gave that scope a
    // reader, so the example moved to a scope that still has none rather than
    // the assertion being deleted — the property is about the *mechanism*, and
    // it would stop being tested the moment every scope in the example had a
    // source.
    const built = await build('builtin', ['risk.profile', 'goals.list', 'cash.summary']);
    expect(Object.keys(built.snapshot)).toEqual(['cash_summary']);
    expect(built.emittedScopes).toEqual(['cash.summary']);
    // The *grant* still names them: the user did grant them, and the request
    // should not pretend otherwise.
    expect(built.grantedScopes).toContain('goals.list');
  });

  it('a merchant is always tokenised, for every advisor kind', async () => {
    for (const kind of ['builtin', 'local_model', 'external'] as const) {
      const built = await build(kind, ['recurring.list']);
      const streams = (built.snapshot.recurring_list?.streams ?? []) as readonly {
        merchant_ref: string;
      }[];
      expect(streams[0]?.merchant_ref, kind).toMatch(/^MERCHANT_[0-9a-f]{12}$/);
      expect(streams[0]?.merchant_ref, kind).not.toContain('merch-1');
    }
  });

  it('an external advisor gets tokens where an in-process one gets uuids', async () => {
    const builtin = await build('builtin', ['cash.summary']);
    const external = await build('external', ['cash.summary']);
    expect(builtin.snapshot.cash_summary?.accounts[0]?.account_ref).toBe('acct-1');
    expect(external.snapshot.cash_summary?.accounts[0]?.account_ref).toMatch(/^ACCT_[0-9a-f]{12}$/);
  });

  it('networth.summary rounds to $100 and transactions.raw buckets the amount', async () => {
    const built = await build('builtin', ['networth.summary', 'transactions.raw']);
    // 212350 + 200000 = 412350 assets, 150000 liabilities ⇒ 262350 net worth.
    // Rounded to a multiple of 10_000 minor units, half-even: 260000.
    expect(built.snapshot.networth_summary?.net_worth.minor).toBe('260000');
    expect(built.snapshot.transactions_raw?.rows[0]?.amount_bucket).toBe('10-50');
    // The exact figure is not in the block at all.
    expect(JSON.stringify(built.snapshot.transactions_raw)).not.toContain('1899');
  });

  it('the emitted snapshot validates against the published schema', async () => {
    const built = await build(
      'builtin',
      SCOPE_CATALOGUE.map((definition) => definition.scope),
    );
    expect(built.snapshot.rule_candidates?.merchants).toHaveLength(1);
    const parsed = AdvisorSnapshotSchema.safeParse(built.snapshot);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('two builds of the same data produce the same digest', async () => {
    // `input_digest` is how "show me exactly what we sent" stays answerable
    // without keeping the payload, so the builder has to be deterministic —
    // including its property order, which `canonicalJson` normalises.
    const first = await build('builtin', ['cash.summary', 'recurring.list']);
    const second = await build('builtin', ['recurring.list', 'cash.summary']);
    expect(first.inputDigest).toBe(second.inputDigest);
    expect(first.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a different user gets different merchant tokens for the same merchant', async () => {
    const mine = await build('builtin', ['recurring.list']);
    const theirs = await new SnapshotBuilder(fullPorts()).build({
      userId: '01930000-0000-7000-8000-000000000002',
      kind: 'builtin',
      grantedScopes: ['recurring.list'],
      today: TODAY,
      baseCurrency: 'USD',
      tokenKey: deriveTokenKey('test-secret', '01930000-0000-7000-8000-000000000002'),
    });
    expect(mine.snapshot.recurring_list?.streams[0]?.merchant_ref).not.toBe(
      theirs.snapshot.recurring_list?.streams[0]?.merchant_ref,
    );
  });

  it('emergency_fund_months is null unless cashflow.monthly was also granted', async () => {
    // A figure derived from another scope's data obeys that scope's grant. A
    // user who granted only `cash.summary` would otherwise be telling the
    // advisor their monthly burn, one division later.
    const cashOnly = await build('builtin', ['cash.summary']);
    expect(cashOnly.snapshot.cash_summary?.emergency_fund_months).toBeNull();

    const both = await build('builtin', ['cash.summary', 'cashflow.monthly']);
    expect(both.snapshot.cash_summary?.emergency_fund_months).not.toBeNull();
  });
});

describe('the minimisation levers', () => {
  it('rounds half-even, so a trend does not slope because of its rounding', () => {
    expect(roundToMultiple(15_000n, 10_000n)).toBe(20_000n);
    expect(roundToMultiple(25_000n, 10_000n)).toBe(20_000n);
    expect(roundToMultiple(-15_000n, 10_000n)).toBe(-20_000n);
    expect(roundToMultiple(1234n, 1n)).toBe(1234n);
  });

  it('buckets on magnitude, exhaustively, with no upper bound on the last rung', () => {
    expect(bucketOf(usd(999n))).toBe('0-10');
    expect(bucketOf(usd(-4500n))).toBe('10-50');
    expect(bucketOf(usd(5000n))).toBe('50-200');
    expect(bucketOf(usd(99_999_999n))).toBe('5000+');
  });

  it('every catalogue row that mentions merchants tokenises them', () => {
    for (const definition of SCOPE_CATALOGUE) {
      if (!/merchant/i.test(definition.yields + definition.drops)) continue;
      expect(definition.minimisation.tokeniseMerchants, definition.scope).toBe(true);
    }
  });
});
