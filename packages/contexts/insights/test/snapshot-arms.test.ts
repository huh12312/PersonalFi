// SPDX-License-Identifier: MIT
/**
 * WP 3.10a — the four `#blockFor` arms, driven through the real `SnapshotBuilder`.
 *
 * ## Why this file exists rather than more rows in `scope-minimization.test.ts`
 *
 * That suite asserts minimisation over `seedSnapshot`, which — for three of the
 * four blocks — still *merges* `test/fixtures/portfolio.ts` rather than letting
 * the builder produce them (`test/advisors/seed.ts` explains the one thing
 * blocking the deletion: `advisor-golden.test.ts` pins insight keys containing
 * the fixture's `LIAB_…` literals). A minimisation test over a fixture proves
 * the fixture is minimal. It cannot prove the *arm* is, and the arm is what
 * ships.
 *
 * So every test here goes through `new SnapshotBuilder(ports).build(...)` over
 * the real `SnapshotPorts` types, and asserts on the emitted block. The two are
 * complementary and both are kept: the fixture suite pins the shape a rule
 * consumes, this one pins what the builder is willing to emit.
 *
 * ## The shape of each assertion
 *
 * Where a field must **not** cross, the test asserts against the serialised
 * block rather than against a named key — `expect(json).not.toContain('sec-1')`.
 * A key-by-key assertion only catches the leak somebody thought of; serialising
 * catches it wherever it lands, including nested inside `lots[]` or added by a
 * later edit to a type this file does not import. Each such fixture therefore
 * uses an identifier that could not occur by chance (`sec-…`, `acct-…`), which
 * is what makes `not.toContain` meaningful rather than lucky.
 */
import { DateOnly, Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { SnapshotBuilder, MARKET_RATE_FRESH_DAYS } from '../src/snapshot/builder.ts';
import {
  PERCENT_PER_ANNUM,
  inMemoryBudgetPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryPlanningPort,
  inMemoryRecurringPort,
  type InsightsGoal,
  type InsightsPlanProjection,
  type PlanningPort,
  type InsightsHoldings,
  type InsightsLiabilities,
  type InsightsMarketRates,
  type InvestmentsPort,
  type SnapshotPorts,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';

const TODAY = DateOnly.parse('2026-09-19');
const USER_ID = '01930000-0000-7000-8000-0000000000aa';
const TOKEN_KEY = deriveTokenKey('wp-3-10a-arms', USER_ID);
const usd = (minor: bigint) => Money.of(minor, 'USD');

/**
 * The exact sentence 01 §4.3 makes a licence condition.
 *
 * Duplicated as a literal here on purpose: `@ctx/insights` does not depend on
 * `@ctx/integrations` (the lint layer denies `@ctx/*` → `@ctx/*`), so this side
 * can only prove the builder carries **whatever the port gave it, byte for
 * byte**. That the port gives it `ATTRIBUTIONS.fred.text` is the adapter's
 * claim and is asserted where the adapter lives — `apps/api/test/db/
 * phase3-advisors.test.ts`, which compares the emitted block against the
 * constant itself. Neither test alone is the proof; the pair is.
 */
const FRED_TEXT =
  'This product uses the FRED® API but is not endorsed or certified by the ' +
  'Federal Reserve Bank of St. Louis.';

/**
 * A portfolio carrying every shape the two holdings arms must handle at once.
 *
 * `US_BOND` is targeted at 25% and **not** held — §7.1's zero-weight row. `sec-3`
 * has no symbol, so it must vanish from both blocks. `BTC`'s basis is unknown,
 * so its `cost_basis` and `unrealized` must be `null` together rather than zero.
 */
function holdings(): InsightsHoldings {
  return {
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
          securityId: 'sec-vti-0001',
          symbol: 'VTI',
          value: usd(700_000n),
          weight: 0.7,
          assetClass: 'US_EQUITY',
          employerStock: false,
          isCrypto: false,
        },
        {
          securityId: 'sec-btc-0002',
          symbol: 'BTC',
          value: usd(280_000n),
          weight: 0.28,
          assetClass: 'CRYPTO',
          employerStock: false,
          isCrypto: true,
        },
        {
          securityId: 'sec-none-0003',
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
        securityId: 'sec-vti-0001',
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
        securityId: 'sec-btc-0002',
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
        securityId: 'sec-none-0003',
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
}

function liabilities(): InsightsLiabilities {
  return {
    currency: 'USD',
    liabilities: [
      {
        id: 'acct-card-abcdef01',
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
        minimumOnlyMonths: 7,
      },
    ],
  };
}

function rates(): InsightsMarketRates {
  return {
    attribution: FRED_TEXT,
    attributionUrl: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html',
    observations: [
      {
        seriesId: 'DGS3MO',
        kind: 'short_term_risk_free',
        observationDate: DateOnly.parse('2026-09-18'),
        value: '5.12',
        units: PERCENT_PER_ANNUM,
        // Answered today: inside the ladder, so not stale.
        observedOn: TODAY,
      },
      {
        seriesId: 'MORTGAGE30US',
        kind: 'mortgage_30y',
        observationDate: DateOnly.parse('2026-09-12'),
        value: '6.34',
        // Answered three days ago: strictly past the ladder, so stale.
        units: PERCENT_PER_ANNUM,
        observedOn: DateOnly.addDays(TODAY, -(MARKET_RATE_FRESH_DAYS + 2)),
      },
      {
        // An index, not a rate. Refused rather than converted (§7.1 duty 1).
        seriesId: 'CPIAUCSL',
        kind: 'other',
        observationDate: DateOnly.parse('2026-09-01'),
        value: '318.4',
        units: 'index_1982_1984_100',
        observedOn: TODAY,
      },
    ],
  };
}

/** Phase 2's three ports carry nothing: this file is only about the Phase 3 four. */
function portsWith(overrides: Partial<SnapshotPorts>): SnapshotPorts {
  return {
    ledger: inMemoryLedgerPort({
      accounts: [],
      netWorthTrend: [],
      cashflow: [],
      categorySpend: [],
      merchants: [],
      transactions: [],
    }),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort([]),
    investments: inMemoryInvestmentsPort({}),
    marketData: inMemoryMarketDataPort(null),
    ...overrides,
  };
}

async function buildWith(ports: SnapshotPorts, grantedScopes: readonly string[]) {
  return new SnapshotBuilder(ports).build({
    userId: USER_ID,
    kind: 'builtin',
    grantedScopes: grantedScopes as never,
    today: TODAY,
    baseCurrency: 'USD',
    tokenKey: TOKEN_KEY,
  });
}

const withPortfolio = () =>
  portsWith({
    investments: inMemoryInvestmentsPort({ holdings: holdings(), liabilities: liabilities() }),
    marketData: inMemoryMarketDataPort(rates()),
  });

describe('#holdingsAggregate', () => {
  it('emits no securityId, no account id, no quantity and no cost basis', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.aggregate']);
    const block = built.snapshot.holdings_aggregate;
    expect(block).toBeDefined();

    // The positive half first: a block that failed to render would pass every
    // `not.toContain` below for the wrong reason.
    const json = JSON.stringify(block);
    expect(json).toContain('VTI');

    // 08 §4.2's drops, asserted over the whole serialised block rather than
    // key by key — a leak nested in a later-added field is still a leak.
    for (const identifier of ['sec-vti-0001', 'sec-btc-0002', 'sec-none-0003', 'acct-']) {
      expect(json, `${identifier} crossed into holdings.aggregate`).not.toContain(identifier);
    }
    expect(json).not.toContain('securityId');
    expect(json).not.toContain('security_id');
    // An aggregate is weights and values. A share count or a basis would make
    // it a position report, which is `holdings.detail`'s grant and not this one.
    expect(json).not.toContain('quantity');
    expect(json).not.toContain('cost_basis');
    expect(json).not.toContain('holding_count');
  });

  it('emits a targeted asset class the holder owns none of as a zero-weight row', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.aggregate']);
    const slices = (built.snapshot.holdings_aggregate as { by_asset_class: readonly unknown[] })
      .by_asset_class as readonly { asset_class: string; weight: number }[];

    const bond = slices.find((slice) => slice.asset_class === 'US_BOND');
    // Without this row I1 cannot cite a ref for a class targeted at 25% and
    // held at 0% — the largest drift there is — so it skips it silently. The
    // row is the fix, and it lives here rather than in the rule because a
    // second rule reading the block would otherwise need the same special case.
    expect(bond, 'a targeted-but-unheld asset class must still cross').toBeDefined();
    expect(bond?.weight).toBe(0);

    // And it is additive, not a replacement: the held classes are all still here.
    expect(slices.map((slice) => slice.asset_class)).toEqual([
      'US_EQUITY',
      'CRYPTO',
      'UNCLASSIFIED',
      'US_BOND',
    ]);
  });

  it('drops a position with no symbol, because an advisor cannot cite one', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.aggregate']);
    const positions = (built.snapshot.holdings_aggregate as { top_positions: readonly unknown[] })
      .top_positions as readonly { symbol: string }[];
    expect(positions.map((position) => position.symbol)).toEqual(['VTI', 'BTC']);
  });

  it('omits idle_cash and crypto_custody as keys when the reader has neither', async () => {
    const bare = holdings();
    const ports = portsWith({
      investments: inMemoryInvestmentsPort({
        holdings: {
          ...bare,
          aggregate: { ...bare.aggregate, idleCash: null, cryptoCustody: null },
        },
      }),
    });
    const built = await buildWith(ports, ['holdings.aggregate']);
    // Absent, not `undefined` and not zero: `Object.keys` and `JSON.stringify`
    // must agree, and a zeroed idle-cash block would have C1 reason about a
    // cushion nobody measured.
    expect(Object.keys(built.snapshot.holdings_aggregate as object)).not.toContain('idle_cash');
    expect(Object.keys(built.snapshot.holdings_aggregate as object)).not.toContain(
      'crypto_custody',
    );
  });

  it('yields no key at all when the portfolio reader returns null', async () => {
    const built = await buildWith(portsWith({}), ['holdings.aggregate']);
    expect(Object.keys(built.snapshot)).not.toContain('holdings_aggregate');
    expect(built.emittedScopes).not.toContain('holdings.aggregate');
    // The grant is still recorded: the user did grant it.
    expect(built.grantedScopes).toContain('holdings.aggregate');
  });
});

describe('#holdingsDetail', () => {
  it('carries a lot as an age and never as a date', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.detail']);
    const block = built.snapshot.holdings_detail;
    const json = JSON.stringify(block);

    const positions = (block as { positions: readonly unknown[] }).positions as readonly {
      symbol: string;
      oldest_lot_days: number;
      lots: readonly { opened_days: number }[];
    }[];
    expect(positions[0]?.oldest_lot_days).toBe(800);
    expect(positions[0]?.lots[0]?.opened_days).toBe(800);

    // No ISO date anywhere in `positions`. A lot's open date is the one field
    // that turns an age into a transaction timestamp, and the schema has
    // nowhere to put it — this is the test that keeps it that way.
    //
    // Scanned over `positions` rather than the whole block on purpose: `as_of`
    // is a date and is *supposed* to be one — it is the snapshot's own instant,
    // the thing every age is measured against, and it identifies nothing. The
    // first draft of this test scanned `json` whole and went red on `as_of`,
    // which is the assertion being wrong rather than the builder.
    const positionsJson = JSON.stringify(positions);
    expect(positionsJson).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    expect(json).not.toContain('opened_date');
    expect(json).not.toContain('open_date');
    expect(json).not.toContain('holding_period_start');
  });

  it('nulls cost_basis and unrealized together, never zero', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.detail']);
    const positions = (built.snapshot.holdings_detail as { positions: readonly unknown[] })
      .positions as readonly {
      symbol: string;
      cost_basis: unknown;
      unrealized: unknown;
      basis_known: boolean;
      lots: readonly { cost_basis: unknown; unrealized: unknown }[];
    }[];

    const btc = positions.find((position) => position.symbol === 'BTC');
    expect(btc?.cost_basis).toBeNull();
    // A zero here would make the unrealised gain wrong by the whole position,
    // and X6's entire subject is the difference between unknown and zero.
    expect(btc?.unrealized).toBeNull();
    expect(btc?.basis_known).toBe(false);
    expect(btc?.lots[0]?.cost_basis).toBeNull();
    expect(btc?.lots[0]?.unrealized).toBeNull();

    const vti = positions.find((position) => position.symbol === 'VTI');
    expect(vti?.basis_known).toBe(true);
    expect(vti?.cost_basis).toEqual({ minor: '500000', currency: 'USD' });
  });

  it('carries a quantity as a decimal string and never as a JSON number', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.detail']);
    const json = JSON.stringify(built.snapshot.holdings_detail);
    // `0.5` as a double is a rounding waiting to happen, and D3's own rule is
    // that a quantity crosses at the kernel's scale or not at all.
    expect(json).toContain('"quantity":"0.500000000000000000"');
    expect(json).not.toMatch(/"quantity":\s*[\d.]/u);
  });

  it('names an account only by its tax treatment', async () => {
    const built = await buildWith(withPortfolio(), ['holdings.detail']);
    const json = JSON.stringify(built.snapshot.holdings_detail);
    expect(json).toContain('"account_type":"taxable"');
    expect(json).not.toContain('acct-');
    expect(json).not.toContain('account_id');
    for (const identifier of ['sec-vti-0001', 'sec-btc-0002', 'sec-none-0003']) {
      expect(json, `${identifier} crossed into holdings.detail`).not.toContain(identifier);
    }
  });

  it('values the portfolio once for both blocks', async () => {
    // Two grants over one valuation. Valuing twice in one snapshot could answer
    // twice differently if a price refresh landed in between, and an advisor
    // handed two disagreeing views of one portfolio has no way to notice.
    let calls = 0;
    const counting: InvestmentsPort = {
      holdings(input) {
        calls += 1;
        return inMemoryInvestmentsPort({ holdings: holdings() }).holdings(input);
      },
      liabilities(input) {
        return inMemoryInvestmentsPort({ liabilities: liabilities() }).liabilities(input);
      },
    };
    const built = await buildWith(portsWith({ investments: counting }), [
      'holdings.aggregate',
      'holdings.detail',
    ]);
    expect(Object.keys(built.snapshot).sort()).toEqual(['holdings_aggregate', 'holdings_detail']);
    expect(calls, 'the holdings read must be memoised for the life of one build').toBe(1);
  });
});

describe('#liabilitiesTerms', () => {
  it('identifies a liability by a token and never by an account id', async () => {
    const built = await buildWith(withPortfolio(), ['liabilities.terms']);
    const json = JSON.stringify(built.snapshot.liabilities_terms);

    const rows = (built.snapshot.liabilities_terms as { liabilities: readonly unknown[] })
      .liabilities as readonly {
      liability_ref: string;
      apr: number;
      minimum_only_months: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.liability_ref).toBeTruthy();
    expect(rows[0]?.apr).toBe(0.2399);
    expect(rows[0]?.minimum_only_months).toBe(7);

    // The account id is the only identifier the port type carries, and it
    // exists solely so the builder can mint a ref from it. It must stop here.
    expect(json, 'the account id crossed into liabilities.terms').not.toContain(
      'acct-card-abcdef01',
    );
    expect(rows[0]?.liability_ref).not.toContain('acct-card-abcdef01');
    // No lender, no institution, no mask — there is nowhere in the type to put
    // one, and this asserts that stays true of the emitted block too.
    expect(json).not.toContain('mask');
    expect(json).not.toContain('institution');
  });

  it('mints the same ref twice for the same liability, and a different one per user', async () => {
    const first = await buildWith(withPortfolio(), ['liabilities.terms']);
    const second = await buildWith(withPortfolio(), ['liabilities.terms']);
    const refOf = (built: Awaited<ReturnType<typeof buildWith>>) =>
      (
        (built.snapshot.liabilities_terms as { liabilities: readonly { liability_ref: string }[] })
          .liabilities[0] as { liability_ref: string }
      ).liability_ref;
    // Stable within a token key, so a rule can key an insight on it and a
    // second run recognises the same debt rather than proposing it twice.
    expect(refOf(first)).toBe(refOf(second));

    const other = await new SnapshotBuilder(withPortfolio()).build({
      userId: USER_ID,
      kind: 'builtin',
      grantedScopes: ['liabilities.terms'] as never,
      today: TODAY,
      baseCurrency: 'USD',
      tokenKey: deriveTokenKey('wp-3-10a-arms', '01930000-0000-7000-8000-0000000000bb'),
    });
    const otherRef = (
      (other.snapshot.liabilities_terms as { liabilities: readonly { liability_ref: string }[] })
        .liabilities[0] as { liability_ref: string }
    ).liability_ref;
    expect(otherRef).not.toBe(refOf(first));
  });

  it('yields no key when the holder has no liabilities', async () => {
    const ports = portsWith({
      investments: inMemoryInvestmentsPort({ liabilities: { currency: 'USD', liabilities: [] } }),
    });
    const built = await buildWith(ports, ['liabilities.terms']);
    expect(Object.keys(built.snapshot)).not.toContain('liabilities_terms');
  });
});

describe('#marketRates', () => {
  it('converts percent to a ratio and records what it converted from', async () => {
    const built = await buildWith(withPortfolio(), ['market.rates']);
    const rows = (built.snapshot.market_rates as { rates: readonly unknown[] }).rates as readonly {
      series_id: string;
      kind: string;
      rate: number;
      units: string;
    }[];

    const short = rows.find((row) => row.kind === 'short_term_risk_free');
    // `"5.12"` → `0.0512` exactly. A point shift, not a divide: `5.12 / 100`
    // is two roundings and prints figures a reviewer cannot tell from a bug.
    expect(short?.rate).toBe(0.0512);
    expect(String(short?.rate)).toBe('0.0512');
    // What we converted *from*, so the conversion is auditable rather than
    // inferable from the size of the number.
    expect(short?.units).toBe(PERCENT_PER_ANNUM);
  });

  it('refuses a series whose units are not percent-per-annum', async () => {
    const built = await buildWith(withPortfolio(), ['market.rates']);
    const rows = (built.snapshot.market_rates as { rates: readonly unknown[] }).rates as readonly {
      series_id: string;
    }[];
    // The CPI index is dropped rather than divided by 100 into a plausible
    // 3.184 "rate". This is the one reinterpretation in the whole snapshot and
    // §7.1 requires it to fail closed.
    expect(rows.map((row) => row.series_id)).toEqual(['DGS3MO', 'MORTGAGE30US']);
  });

  it('emits no key at all when every series is refused', async () => {
    const onlyIndex: InsightsMarketRates = {
      ...rates(),
      observations: rates().observations.filter((row) => row.units !== PERCENT_PER_ANNUM),
    };
    const built = await buildWith(portsWith({ marketData: inMemoryMarketDataPort(onlyIndex) }), [
      'market.rates',
    ]);
    // Not `rates: []`. An advisor reads an empty list as "the market pays
    // nothing", which is a claim, where an absent block is silence.
    expect(Object.keys(built.snapshot)).not.toContain('market_rates');
  });

  it('computes stale against the freshness ladder rather than reading it', async () => {
    const built = await buildWith(withPortfolio(), ['market.rates']);
    const rows = (built.snapshot.market_rates as { rates: readonly unknown[] }).rates as readonly {
      kind: string;
      stale: boolean;
    }[];

    // WP 3.4 §5.1's ladder is about when *we were told*, not when the market
    // last printed — a business-day series is not stale on a Monday.
    expect(rows.find((row) => row.kind === 'short_term_risk_free')?.stale).toBe(false);
    expect(rows.find((row) => row.kind === 'mortgage_30y')?.stale).toBe(true);
  });

  it('carries the attribution verbatim, and emits nothing without one', async () => {
    const built = await buildWith(withPortfolio(), ['market.rates']);
    const block = built.snapshot.market_rates as {
      attribution: string;
      attribution_url: string | null;
    };
    // Byte for byte, ® included. A paraphrase of a licence condition is a new
    // licence condition.
    expect(block.attribution).toBe(FRED_TEXT);
    expect(block.attribution).toContain('®');
    expect(block.attribution_url).toBe('https://fred.stlouisfed.org/docs/api/terms_of_use.html');

    const unattributed = await buildWith(
      portsWith({ marketData: inMemoryMarketDataPort({ ...rates(), attribution: '' }) }),
      ['market.rates'],
    );
    // A rate a surface cannot lawfully print is worse than no rate.
    expect(Object.keys(unattributed.snapshot)).not.toContain('market_rates');
  });
});

// ---------------------------------------------------------------------------
// WP 4.9 — the three planning arms
// ---------------------------------------------------------------------------

function planGoal(overrides: Partial<InsightsGoal> = {}): InsightsGoal {
  return {
    id: 'goal-0001-never-crosses',
    name: 'House deposit',
    target: usd(2_000_000n),
    monthsRemaining: 12,
    fundedRatio: '0.1',
    status: 'off_track',
    requiredMonthly: usd(150_000n),
    plannedMonthly: usd(50_000n),
    ...overrides,
  };
}

function planProjection(overrides: Partial<InsightsPlanProjection> = {}): InsightsPlanProjection {
  return {
    asOfYear: 2026,
    currency: 'USD',
    method: 'monte_carlo',
    paths: 10_000,
    assumptionsVersion: `sha256:${'0f'.repeat(32)}`,
    stale: false,
    successProbability: '0.713000',
    successTarget: '0.80',
    terminal: {
      age: 95,
      calendarYear: 2055,
      p5: usd(49_999n),
      p50: usd(41_250_000n),
      p95: usd(187_349_999n),
    },
    ages: { current: 66, retirement: 65, planEnd: 95 },
    savingsRate: { plan: '0.15', observed: '0.085', planSource: 'stated' },
    rmd: { startAge: 75, startYear: 2035, taxDeferredShare: '0.62' },
    socialSecurity: { claimAgeYears: 67, claimAgeMonths: 0, claimFactor: '1', factorAt70: '1.24' },
    guardrail: {
      withdrawalRate: '0.0612',
      referenceRate: '0.045',
      lower: '0.036',
      upper: '0.054',
      position: 'above',
    },
    ...overrides,
  };
}

/** A planning port that counts its calls, so "no code path" is observable. */
function countingPlanning(inner: PlanningPort): { port: PlanningPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      goals(input) {
        calls.push('goals');
        return inner.goals(input);
      },
      riskProfile(input) {
        calls.push('riskProfile');
        return inner.riskProfile(input);
      },
      projection(input) {
        calls.push('projection');
        return inner.projection(input);
      },
    },
  };
}

describe('the planning arms (WP 4.9)', () => {
  it('an ungranted planning scope reads nothing and emits no key', async () => {
    const counted = countingPlanning(
      inMemoryPlanningPort({ goals: [planGoal()], projection: planProjection() }),
    );
    const built = await buildWith(portsWith({ planning: counted.port }), ['holdings.aggregate']);
    expect(counted.calls).toEqual([]);
    expect(built.snapshot.goals_list).toBeUndefined();
    expect(built.snapshot.plan_projection).toBeUndefined();
  });

  it('a granted planning scope with no port, or a null answer, emits no key — never an empty block', async () => {
    const scopes = ['goals.list', 'risk.profile', 'plan.projection'];
    const noPort = await buildWith(portsWith({}), scopes);
    expect(noPort.snapshot).toEqual({});
    expect(noPort.emittedScopes).toEqual([]);

    const nothing = await buildWith(portsWith({ planning: inMemoryPlanningPort({}) }), scopes);
    expect(nothing.snapshot).toEqual({});

    const empty = await buildWith(portsWith({ planning: inMemoryPlanningPort({ goals: [] }) }), [
      'goals.list',
    ]);
    expect(empty.snapshot.goals_list).toBeUndefined();
  });

  it('#goalsList drops the id, the date and every malformed row, and caps progress at one', async () => {
    const built = await buildWith(
      portsWith({
        planning: inMemoryPlanningPort({
          goals: [
            planGoal(),
            planGoal({
              id: 'goal-0002',
              name: 'Past target',
              fundedRatio: '1.25',
              status: 'on_track',
            }),
            planGoal({ id: 'goal-0003', name: '   ' }),
            planGoal({ id: 'goal-0004', fundedRatio: 'NaN' }),
            planGoal({ id: 'goal-0005', monthsRemaining: -1 }),
            planGoal({ id: 'goal-0006', plannedMonthly: Money.of(50_000n, 'EUR') }),
          ],
        }),
      }),
      ['goals.list'],
    );
    const goals = built.snapshot.goals_list?.goals ?? [];
    expect(goals.map((goal) => goal.name)).toEqual(['House deposit', 'Past target']);
    const json = JSON.stringify(built.snapshot);
    expect(json).not.toContain('goal-0001-never-crosses');
    expect(json).not.toContain('goal-0002');
    expect(goals[0]?.goal_ref).toMatch(/^GOAL_[0-9a-f]{12}$/u);
    expect(goals[0]?.pace).toEqual({
      status: 'off_track',
      required_monthly: { minor: '150000', currency: 'USD' },
      planned_monthly: { minor: '50000', currency: 'USD' },
    });
    // Funded past the target reads as complete; the verdict keeps the truth.
    expect(goals[1]?.progress).toBe(1);
    expect(goals[1]?.pace?.status).toBe('on_track');
  });

  it('#planProjection rounds the band to $1,000 and passes every ratio through as a string', async () => {
    const built = await buildWith(
      portsWith({ planning: inMemoryPlanningPort({ projection: planProjection() }) }),
      ['plan.projection'],
    );
    const block = built.snapshot.plan_projection;
    expect(block).toBeDefined();
    // $499.99 → $0; $412,500.00 → $412,000 (half-even); $1,873,499.99 → $1,873,000.
    expect(block?.terminal.p5).toEqual({ minor: '0', currency: 'USD' });
    expect(block?.terminal.p50).toEqual({ minor: '41200000', currency: 'USD' });
    expect(block?.terminal.p95).toEqual({ minor: '187300000', currency: 'USD' });
    expect(block?.success_probability).toBe('0.713000');
    expect(block?.guardrail?.position).toBe('above');
    expect(block?.savings_rate?.plan_source).toBe('stated');
  });

  it('#planProjection refuses a malformed core field whole, and drops only a malformed sub-block', async () => {
    const floatLike = await buildWith(
      portsWith({
        planning: inMemoryPlanningPort({
          projection: planProjection({ successProbability: '7.13e-1' }),
        }),
      }),
      ['plan.projection'],
    );
    expect(floatLike.snapshot.plan_projection).toBeUndefined();

    const badBand = await buildWith(
      portsWith({
        planning: inMemoryPlanningPort({
          projection: planProjection({
            terminal: {
              age: 95,
              calendarYear: 2055,
              p5: null,
              p50: Money.of(1n, 'EUR'),
              p95: null,
            },
          }),
        }),
      }),
      ['plan.projection'],
    );
    expect(badBand.snapshot.plan_projection).toBeUndefined();

    const badRails = await buildWith(
      portsWith({
        planning: inMemoryPlanningPort({
          projection: planProjection({
            guardrail: {
              withdrawalRate: '-0.01',
              referenceRate: '0.045',
              lower: '0.036',
              upper: '0.054',
              position: 'below',
            },
          }),
        }),
      }),
      ['plan.projection'],
    );
    expect(badRails.snapshot.plan_projection).toBeDefined();
    expect(badRails.snapshot.plan_projection?.guardrail).toBeUndefined();
    expect(badRails.snapshot.plan_projection?.rmd).toBeDefined();
  });

  it('every emitted planning block validates against the published schema', async () => {
    const { AdvisorSnapshotSchema } = await import('../src/contract/snapshot.ts');
    const built = await buildWith(
      portsWith({
        planning: inMemoryPlanningPort({
          goals: [planGoal()],
          riskProfile: {
            tolerance: 'moderate',
            horizonYears: 20,
            taxBracketBand: '22-24',
            liquidityNeed: 'low',
          },
          projection: planProjection(),
        }),
      }),
      ['goals.list', 'risk.profile', 'plan.projection'],
    );
    expect(built.emittedScopes).toEqual(['goals.list', 'risk.profile', 'plan.projection']);
    expect(AdvisorSnapshotSchema.safeParse(built.snapshot).success).toBe(true);
  });
});
