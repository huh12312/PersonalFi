// SPDX-License-Identifier: MIT
/**
 * The advisory catalogue's definitions and its result check (WP 11.5b), with
 * no database: every function is run in a fake, already-gated context over a
 * fixed snapshot and fake ports, through `evaluateCatalogueFunction` — the
 * same parse → run → envelope → check path `callCatalogueByName` takes after
 * its gate. The gate itself (the holder's real grants, the listing, the 403)
 * is proven over a real database in `apps/api/test/db/wp115b-advisor-catalogue.test.ts`.
 */
import { fixedClock, type DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { lintAdviceCopy } from '../src/advisors/copy-lint.ts';
import { NARRATOR_SCOPES } from '../src/advisors/local/manifest.ts';
import {
  CATALOGUE,
  CATALOGUE_FUNCTION_NAMES,
  evaluateCatalogueFunction,
  grantedScopesFor,
} from '../src/catalogue/catalogue.ts';
import type { CatalogueCallContext } from '../src/catalogue/definition.ts';
import {
  CatalogueResultRejected,
  checkCatalogueResult,
  decimalised,
  type CatalogueResult,
} from '../src/catalogue/figures.ts';
import {
  CatalogueRefusal,
  type CataloguePorts,
  type PortProjection,
} from '../src/catalogue/ports.ts';
import { scopeDefinition, type AdvisorScope } from '../src/contract/scopes.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import type { InsightsDatabase } from '../src/db.ts';
import type { ParameterLookup } from '../src/knowledge/params.ts';
import { goalRef } from '../src/snapshot/builder.ts';

const TODAY = '2026-10-28' as DateOnly;
const USD = 'USD';
const money = (minor: string) => ({ minor, currency: USD });
const TOKEN_KEY = 'test-token-key';
const GOAL_ID = '01900000-0000-7000-8000-000000000042';

/** A snapshot with every block a catalogue function reads, figures chosen to be checked by hand. */
function fixtureSnapshot(): AdvisorSnapshot {
  const month = (name: string, expense: string) => ({
    month: name,
    income: money('600000'),
    expense: money(expense),
    net: money(String(600000 - Number(expense))),
    by_category: [],
  });
  return {
    networth_summary: {
      as_of: TODAY,
      assets: money('50000000'),
      liabilities: money('40000'),
      net_worth: money('49960000'),
      trend: [],
    },
    cash_summary: {
      as_of: TODAY,
      total: money('1500000'),
      account_count: 2,
      blended_apy: 0.0041,
      emergency_fund_months: 4.6,
      accounts: [
        { account_ref: 'ACCOUNT_aa', type: 'checking', balance: money('500000'), apy: null },
        { account_ref: 'ACCOUNT_bb', type: 'savings', balance: money('1000000'), apy: 0.0061 },
      ],
    },
    cashflow_monthly: {
      from_month: '2026-07',
      to_month: '2026-10',
      currency: USD,
      months: [
        month('2026-07', '300000'),
        month('2026-08', '320000'),
        month('2026-09', '310000'),
        month('2026-10', '100000'),
      ],
    },
    recurring_list: {
      as_of: TODAY,
      currency: USD,
      streams: [
        {
          series_ref: 'SERIES_1',
          merchant_ref: 'MERCHANT_a7f31c9d0e42',
          cadence: 'monthly',
          type: 'subscription',
          status: 'active',
          user_confirmed: true,
          confidence: 0.95,
          typical_amount: money('1899'),
          observed_min: money('1599'),
          observed_max: money('1899'),
          next_due_date: '2026-11-05',
          first_seen: '2025-01-05',
          last_seen: '2026-10-05',
          periods_per_year: 12,
          eligible_for_impact: true,
          price_changes: [
            {
              effective_date: '2026-09-05',
              direction: 'INCREASE',
              previous_amount: money('1599'),
              new_amount: money('1899'),
              annual_impact: money('3600'),
            },
          ],
        },
      ],
    },
    goals_list: {
      goals: [
        {
          goal_ref: goalRef(TOKEN_KEY, GOAL_ID),
          name: 'House deposit',
          target: money('6000000'),
          horizon_months: 36,
          progress: 0.25,
          pace: {
            status: 'off_track',
            required_monthly: money('125000'),
            planned_monthly: money('100000'),
          },
        },
      ],
    },
    plan_projection: {
      as_of_year: 2026,
      currency: USD,
      method: 'deterministic',
      paths: 1,
      assumptions_version: 'sha256:abc',
      stale: false,
      success_probability: '1',
      success_target: '0.80',
      terminal: { age: 95, calendar_year: 2081, p5: null, p50: money('100000000'), p95: null },
      ages: { current: 40, retirement: 65, plan_end: 95 },
      rmd: { start_age: 75, start_year: 2061, tax_deferred_share: '0.6' },
      social_security: {
        claim_age_years: 67,
        claim_age_months: 0,
        claim_factor: '1',
        factor_at_70: '1.24',
      },
      guardrail: {
        withdrawal_rate: '0.051',
        reference_rate: '0.045',
        lower: '0.036',
        upper: '0.054',
        position: 'within',
      },
    },
    holdings_aggregate: {
      as_of: TODAY,
      currency: USD,
      investable_total: money('20000000'),
      unclassified_pct: 0.02,
      by_asset_class: [
        { asset_class: 'us_equity', weight: 0.7, value: money('14000000') },
        { asset_class: 'us_aggregate_bonds', weight: 0.28, value: money('5600000') },
      ],
      top_positions: [
        {
          symbol: 'VTI',
          weight: 0.45,
          value: money('9000000'),
          asset_class: 'us_equity',
          employer_stock: false,
          is_crypto: false,
        },
        {
          symbol: 'ACME',
          weight: 0.12,
          value: money('2400000'),
          asset_class: 'us_equity',
          employer_stock: true,
          is_crypto: false,
        },
      ],
      target_allocation: [
        { asset_class: 'us_equity', weight: 0.6 },
        { asset_class: 'us_aggregate_bonds', weight: 0.4 },
      ],
      account_type_mix: { taxable: 0.5, tax_deferred: 0.5 },
    },
    holdings_detail: {
      as_of: TODAY,
      currency: USD,
      positions: [
        {
          symbol: 'ABCX',
          asset_class: 'us_equity',
          account_type: 'taxable',
          quantity: '100',
          cost_basis: money('500000'),
          market_value: money('1000000'),
          unrealized: money('500000'),
          oldest_lot_days: 900,
          basis_known: true,
          is_crypto: false,
          is_stablecoin: false,
          employer_stock: false,
          expense_ratio: 0.0095,
          peer_expense_ratio: 0.0003,
          annual_fee_cost: money('9500'),
          high_fee: true,
          lots: [],
        },
      ],
    },
    liabilities_terms: {
      as_of: TODAY,
      currency: USD,
      liabilities: [
        liability('LIABILITY_a', '30000', 0.24, '2000'),
        liability('LIABILITY_b', '10000', 0.12, '2000'),
        liability('LIABILITY_c', '50000', null, '2500'),
      ],
    },
  } as AdvisorSnapshot;
}

function liability(ref: string, balance: string, apr: number | null, minimum: string) {
  return {
    liability_ref: ref,
    kind: 'credit_card',
    apr,
    promo_apr: null,
    promo_apr_end_date: null,
    credit_limit: null,
    statement_balance: null,
    current_balance: money(balance),
    minimum_payment: money(minimum),
    payment_due_date: null,
    last_payment_date: null,
    last_payment_amount: null,
    minimum_only_months: null,
  };
}

const PARAMETERS: Readonly<Record<string, { kind: 'money' | 'rate'; value: unknown }>> = {
  'assumptions.market_reference.treasury_bill_3_month': { kind: 'rate', value: '0.0393' },
  'tax.us.2026.retirement.ira_contribution': { kind: 'money', value: money('750000') },
  'tax.us.2026.retirement.ira_catch_up_age_50': { kind: 'money', value: money('110000') },
};

function parameterLookup(key: string): ParameterLookup {
  const year = /^tax\.us\.(\d{4})\./.exec(key)?.[1];
  if (year !== undefined && year !== '2026') {
    return {
      found: false,
      reason: 'year_unavailable',
      detail: `tax year ${year} is not held (held: 2026)`,
    };
  }
  const node = PARAMETERS[key];
  if (node === undefined) return { found: false, reason: 'unknown', detail: `no parameter ${key}` };
  return {
    found: true,
    citation: {
      key,
      kind: node.kind,
      value: node.value,
      source: 'test source',
      asOf: '2026-01-01',
      parametersVersion: 'sha256:test',
    } as never,
  };
}

const PROJECTION: PortProjection = {
  status: 'served',
  scenarioKind: 'baseline',
  method: 'monte_carlo',
  paths: 10_000,
  seed: '42',
  engineVersion: 'mc/1',
  assumptionsVersion: 'sha256:abc',
  inputDigest: 'sha256:def',
  asOfYear: 2026,
  balancesSealed: true,
  retirementAge: 65,
  retirementYear: 2051,
  planEndAge: 95,
  successProbability: '0.713000',
  years: [
    {
      age: 41,
      calendarYear: 2027,
      p5: money('12345678'),
      p50: money('23450000'),
      p95: money('34549999'),
    },
  ],
};

function ports(): CataloguePorts {
  return {
    snapshot: {} as CataloguePorts['snapshot'],
    parameters: { get: parameterLookup },
    planning: {
      project: async () => PROJECTION,
      compare: async () => ({
        status: 'served',
        a: PROJECTION,
        b: {
          ...PROJECTION,
          successProbability: '0.780000',
          retirementYear: 2052,
          retirementAge: 66,
        },
        seed: '42',
        successProbabilityDelta: '0.067000',
        retirementDeltaMonths: 12,
      }),
      levers: async () => ({
        status: 'served',
        method: 'monte_carlo',
        paths: 10_000,
        seed: '42',
        engineVersion: 'mc/1',
        assumptionsVersion: 'sha256:abc',
        inputDigest: 'sha256:def',
        asOfYear: 2026,
        deadlineMs: 20_000,
        baseSuccessProbability: '0.713000',
        levers: [
          {
            lever: 'retire_age',
            step: 'retire one year later',
            status: 'computed',
            levers: { retire_age: '66' },
            successProbability: '0.783000',
            delta: '0.070000',
          },
          {
            lever: 'glidepath',
            step: 'not moved',
            status: 'skipped',
            reason: 'not_a_magnitude',
            detail: 'a choice',
          },
        ],
      }),
      goalIds: async () => [GOAL_ID],
      requiredSavings: async () => ({
        status: 'served',
        kind: 'required',
        monthly: money('131200'),
        iterations: 7,
      }),
      claimFactors: async ({ ages }) => ({
        status: 'served',
        plannedClaimAge: { years: 67, months: 0 },
        plannedFactor: '1',
        factors: ages.map((age) => ({
          age,
          factor: age === 62 ? '0.7' : age === 70 ? '1.24' : '1',
        })),
      }),
    },
    contributions: {
      contributions: async () => ({
        currency: USD,
        accountsCounted: 1,
        months: [
          { month: '2026-02', total: money('200000') },
          { month: '2026-06', total: money('150000') },
        ],
        excluded: [{ reason: 'transfer_or_rollover', count: 1 }],
      }),
    },
  };
}

function contextFor(snapshot: AdvisorSnapshot = fixtureSnapshot()): CatalogueCallContext {
  return {
    userId: '01900000-0000-7000-8000-000000000001',
    clock: fixedClock('2026-10-28T15:00:00.000Z'),
    correlationId: 'test',
    today: TODAY,
    baseCurrency: USD,
    ports: ports(),
    database: {} as InsightsDatabase,
    ceiling: NARRATOR_SCOPES,
    tokenKey: TOKEN_KEY,
    async snapshot(scopes: readonly AdvisorScope[]) {
      const keys = new Set(scopes.map((scope) => scopeDefinition(scope).key));
      return Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => keys.has(key)),
      ) as AdvisorSnapshot;
    },
  };
}

/** The functions a fake context can answer (the two `insights.*` read the database). */
const NO_DATABASE = CATALOGUE_FUNCTION_NAMES.filter((name) => !name.startsWith('insights.'));

const ARGS: Readonly<Record<string, unknown>> = {
  'debt.payoff_plan': { order: 'avalanche', extra_monthly: money('6000') },
  'goal.required_savings': { goal_ref: goalRef(TOKEN_KEY, GOAL_ID) },
  'plan.compare': { a: 'baseline', b: '01900000-0000-7000-8000-0000000000aa' },
  'retirement.claiming': { ages: [62, 67, 70] },
  'limits.contribution_room': { year: 2026, account_kind: 'ira' },
};

async function call(name: string, args: unknown = ARGS[name] ?? {}): Promise<CatalogueResult> {
  const definition = CATALOGUE[name as keyof typeof CATALOGUE];
  return evaluateCatalogueFunction(name, contextFor(), args, definition.scopes);
}

type Figure = { money?: { minor: string }; decimal?: string; date?: string; source_refs: string[] };
const result = (outcome: CatalogueResult) => outcome.result as Record<string, unknown>;

describe('the catalogue’s definitions', () => {
  it('names nineteen functions, each under its own name', () => {
    expect(CATALOGUE_FUNCTION_NAMES).toHaveLength(19);
    for (const name of CATALOGUE_FUNCTION_NAMES) expect(CATALOGUE[name].name).toBe(name);
  });

  it('declares scopes inside the narrator’s bound, never transactions.raw', () => {
    for (const name of CATALOGUE_FUNCTION_NAMES) {
      const { scopes } = CATALOGUE[name];
      expect(scopes.length, name).toBeGreaterThan(0);
      expect(scopes, name).not.toContain('transactions.raw');
      for (const scope of scopes) expect(NARRATOR_SCOPES, `${name}: ${scope}`).toContain(scope);
    }
  });

  it('every summary and description passes the advice copy-linter', () => {
    for (const name of CATALOGUE_FUNCTION_NAMES) {
      const definition = CATALOGUE[name];
      expect(lintAdviceCopy(definition.summary, 'summary_md'), name).toEqual([]);
      expect(lintAdviceCopy(definition.description, 'summary_md'), name).toEqual([]);
    }
  });

  it('gates `all` on every scope and `any` on one', () => {
    const all = {
      scopes: ['cash.summary', 'cashflow.monthly'] as AdvisorScope[],
      scopeRule: 'all' as const,
    };
    expect(grantedScopesFor(all, ['cash.summary'])).toBeNull();
    expect(grantedScopesFor(all, ['cash.summary', 'cashflow.monthly', 'goals.list'])).toEqual([
      'cash.summary',
      'cashflow.monthly',
    ]);
    const any = {
      scopes: ['cash.summary', 'goals.list'] as AdvisorScope[],
      scopeRule: 'any' as const,
    };
    expect(grantedScopesFor(any, [])).toBeNull();
    expect(grantedScopesFor(any, ['goals.list', 'plan.projection'])).toEqual(['goals.list']);
  });
});

describe('every function, over a fixed snapshot', () => {
  it.each(NO_DATABASE)(
    '%s returns a result whose figures all trace to its inputs',
    async (name) => {
      const outcome = await call(name);
      expect(outcome.catalogue_version).toBe('catalogue/1');
      expect(checkCatalogueResult(outcome)).toEqual([]);
      expect(JSON.stringify(outcome)).not.toMatch(/\d\.\d+[,}\]]/u); // no bare float in the JSON
    },
  );

  it.each(NO_DATABASE)('%s is deterministic: two calls, the same result', async (name) => {
    expect(await call(name)).toEqual(await call(name));
  });

  it('cash.emergency_fund: $3,100 a month, 4.84 months, $5,700 above three months, $200.64 a year', async () => {
    const r = result(await call('cash.emergency_fund'));
    expect((r['monthly_spending'] as Figure).money?.minor).toBe('310000');
    expect((r['months_covered'] as Figure).decimal).toBe('4.84');
    expect((r['target_amount'] as Figure).money?.minor).toBe('930000');
    expect((r['excess'] as Figure).money?.minor).toBe('570000');
    expect((r['shortfall'] as Figure).money?.minor).toBe('0');
    expect((r['yield_spread'] as Figure).decimal).toBe('0.0352');
    expect((r['annual_spread_on_excess'] as Figure).money?.minor).toBe('20064');
    expect((r['monthly_spending'] as Figure).source_refs).toEqual([
      'snapshot:cashflow_monthly.months[0].expense',
      'snapshot:cashflow_monthly.months[1].expense',
      'snapshot:cashflow_monthly.months[2].expense',
    ]);
  });

  it('debt.payoff_plan: reference case C over the snapshot, the no-rate debt named', async () => {
    const outcome = await call('debt.payoff_plan');
    const r = result(outcome);
    const plans = r['plans'] as { order: string; total_interest: Figure; months: Figure }[];
    expect(
      plans.map((plan) => [plan.order, plan.months.decimal, plan.total_interest.money?.minor]),
    ).toEqual([
      ['avalanche', '5', '1803'],
      ['snowball', '5', '1992'],
    ]);
    expect(r['excluded']).toEqual([{ liability_ref: 'LIABILITY_c', reason: 'no_apr' }]);
    const [difference] = r['differences'] as { other: string; interest: Figure }[];
    expect(difference?.other).toBe('snowball');
    expect(difference?.interest.money?.minor).toBe('-189');
    // A rate crosses as the decimal string the inputs carry, never the snapshot's float.
    expect(
      (outcome.inputs['liabilities_terms'] as { liabilities: { apr: unknown }[] }).liabilities[0]
        ?.apr,
    ).toBe('0.24');
  });

  it('debt.payoff_plan: a custom order runs beside the other two', async () => {
    const r = result(
      await call('debt.payoff_plan', {
        order: 'custom',
        extra_monthly: money('6000'),
        custom_order: ['LIABILITY_b'],
      }),
    );
    expect(
      (r['plans'] as { order: string; sequence: string[] }[]).map((plan) => plan.order),
    ).toEqual(['avalanche', 'snowball', 'custom']);
    await expect(
      call('debt.payoff_plan', {
        order: 'custom',
        extra_monthly: money('6000'),
        custom_order: ['NOPE'],
      }),
    ).rejects.toBeInstanceOf(CatalogueRefusal);
  });

  it('limits.contribution_room: the 2026 IRA limit, $3,500 in, $4,000 left, 64 days', async () => {
    const outcome = await call('limits.contribution_room');
    const r = result(outcome);
    expect((r['limit'] as Figure).money?.minor).toBe('750000');
    expect((r['contributed'] as Figure).money?.minor).toBe('350000');
    expect((r['remaining'] as Figure).money?.minor).toBe('400000');
    expect((r['days_left'] as Figure).decimal).toBe('64');
    expect((r['limit'] as Figure).source_refs).toEqual(['snapshot:parameters[0].value']);
    expect((outcome.inputs['parameters'] as { key: string }[])[0]?.key).toBe(
      'tax.us.2026.retirement.ira_contribution', // gitleaks:allow — a parameter key, not a secret
    );
  });

  it('limits.contribution_room: a year the store does not hold is refused, never answered from 2026', async () => {
    const refused = call('limits.contribution_room', { year: 2027, account_kind: 'ira' });
    await expect(refused).rejects.toBeInstanceOf(CatalogueRefusal);
    await expect(refused).rejects.toMatchObject({
      code: 'catalogue.year_unavailable',
      status: 422,
    });
  });

  it('plan.project: money rounded to the scope’s $1,000, the run identity in the inputs', async () => {
    const outcome = await call('plan.project');
    const [year] = result(outcome)['median_path'] as { p5: Figure; p50: Figure; p95: Figure }[];
    expect(year?.p5.money?.minor).toBe('12300000');
    // 234.5 thousands is a tie: half-even keeps the even 234.
    expect(year?.p50.money?.minor).toBe('23400000');
    expect(year?.p95.money?.minor).toBe('34500000');
    expect((outcome.inputs['projection'] as { seed: string }).seed).toBe('42');
  });

  it('goal.required_savings: resolves the goal by its ref; the id never appears', async () => {
    const outcome = await call('goal.required_savings');
    expect((result(outcome)['monthly'] as Figure).money?.minor).toBe('131200');
    expect(JSON.stringify(outcome)).not.toContain(GOAL_ID);
    await expect(
      call('goal.required_savings', { goal_ref: 'GOAL_000000000000' }),
    ).rejects.toMatchObject({
      code: 'catalogue.goal_unknown',
    });
  });

  it('investing.drift: 10 points over on equities, $20,000 to target', async () => {
    const classes = result(await call('investing.drift'))['classes'] as {
      asset_class: string;
      drift: Figure;
      amount_to_target: Figure;
      outside_band: boolean;
    }[];
    expect(classes[0]).toMatchObject({ asset_class: 'us_equity', outside_band: true });
    expect(classes[0]?.drift.decimal).toBe('0.1');
    expect(classes[0]?.amount_to_target.money?.minor).toBe('-2000000');
  });

  it('recurring.waste: U2’s price rise with its annual cost and the refs it rests on', async () => {
    const findings = result(await call('recurring.waste'))['findings'] as {
      rule_id: string;
      annual_impact: Figure | null;
    }[];
    const u2 = findings.find((finding) => finding.rule_id === 'U2');
    expect(u2?.annual_impact?.money?.minor).toBe('3600');
    expect(u2?.annual_impact?.source_refs.length).toBeGreaterThan(0);
  });

  it('investing.tax_location: not available, with the reason, and no figure', async () => {
    const outcome = await call('investing.tax_location');
    expect(outcome.status).toBe('not_available');
    expect(outcome.result).toBeNull();
    expect(outcome.not_available?.code).toBe('engine_not_built');
  });

  it('refuses invalid arguments', async () => {
    await expect(call('retirement.claiming', { ages: [55] })).rejects.toMatchObject({
      code: 'catalogue.invalid_arguments',
      status: 400,
    });
    await expect(call('cash.emergency_fund', { target_months: 3, extra: 1 })).rejects.toMatchObject(
      {
        code: 'catalogue.invalid_arguments',
      },
    );
  });
});

describe('the result check', () => {
  const base = { inputs: { args: { x: '1' }, a: { b: money('100') } } };

  it('accepts a figure whose refs resolve into the inputs', () => {
    expect(
      checkCatalogueResult({
        ...base,
        result: { f: { money: money('100'), source_refs: ['snapshot:a.b'] } },
      }),
    ).toEqual([]);
  });

  it('refuses a figure with no source_ref', () => {
    expect(
      checkCatalogueResult({ ...base, result: { f: { money: money('100'), source_refs: [] } } }),
    ).toEqual([{ kind: 'figure_without_source_ref', path: 'result.result.f' }]);
  });

  it('refuses a ref that does not resolve into the inputs', () => {
    expect(
      checkCatalogueResult({
        ...base,
        result: { f: { decimal: '1', unit: 'count', source_refs: ['snapshot:a.nowhere'] } },
      }),
    ).toEqual([
      { kind: 'unresolved_source_ref', path: 'result.result.f', ref: 'snapshot:a.nowhere' },
    ]);
  });

  it('refuses money and decimals outside a figure', () => {
    expect(
      checkCatalogueResult({ ...base, result: { m: money('5'), d: '0.25' } }).map((p) => p.kind),
    ).toEqual(['bare_money', 'bare_decimal']);
  });

  it('refuses a float anywhere, inputs included', () => {
    expect(
      checkCatalogueResult({ inputs: { a: 0.25 }, result: { n: 3, f: 0.5 } }).map((p) => p.path),
    ).toEqual(['result.inputs.a', 'result.result.f']);
  });

  it('a function whose result does not trace is never returned', async () => {
    const snapshot = fixtureSnapshot();
    // A function that read a float the inputs could not carry is rejected, not returned.
    expect(decimalised({ apr: 0.2399, n: 3 })).toEqual({ apr: '0.2399', n: 3 });
    const context = contextFor(snapshot);
    await expect(
      evaluateCatalogueFunction(
        'investing.allocation',
        {
          ...context,
          async snapshot() {
            const broken = fixtureSnapshot();
            // A block whose value is not money-shaped where a figure expects money.
            (broken.holdings_aggregate as { investable_total: unknown }).investable_total = 12.5;
            return broken;
          },
        },
        {},
        ['holdings.aggregate'],
      ),
    ).rejects.toBeInstanceOf(CatalogueResultRejected);
  });
});
