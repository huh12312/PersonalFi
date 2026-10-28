// SPDX-License-Identifier: MIT
/**
 * The advisory catalogue's fake, already-gated call context (WP 11.5b), shared
 * by `catalogue.test.ts` and WP 11.5c's Ask PersonalFi tests: a fixed snapshot
 * with every block a function reads, fake ports, and the arguments each
 * function is exercised with. Moved here unchanged from `catalogue.test.ts`.
 */
import { fixedClock, type DateOnly } from '@core/kernel';
import { NARRATOR_SCOPES } from '../../src/advisors/local/manifest.ts';
import {
  CATALOGUE,
  CATALOGUE_FUNCTION_NAMES,
  evaluateCatalogueFunction,
} from '../../src/catalogue/catalogue.ts';
import type { CatalogueCallContext } from '../../src/catalogue/definition.ts';
import type { CatalogueResult } from '../../src/catalogue/figures.ts';
import type { CataloguePorts, PortProjection } from '../../src/catalogue/ports.ts';
import { scopeDefinition, type AdvisorScope } from '../../src/contract/scopes.ts';
import type { AdvisorSnapshot } from '../../src/contract/snapshot.ts';
import type { InsightsDatabase } from '../../src/db.ts';
import type { ParameterLookup } from '../../src/knowledge/params.ts';
import { goalRef } from '../../src/snapshot/builder.ts';

export const TODAY = '2026-10-28' as DateOnly;
export const USD = 'USD';
export const money = (minor: string) => ({ minor, currency: USD });
export const TOKEN_KEY = 'test-token-key';
export const GOAL_ID = '01900000-0000-7000-8000-000000000042';

/** A snapshot with every block a catalogue function reads, figures chosen to be checked by hand. */
export function fixtureSnapshot(): AdvisorSnapshot {
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

export function liability(ref: string, balance: string, apr: number | null, minimum: string) {
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

export const PARAMETERS: Readonly<Record<string, { kind: 'money' | 'rate'; value: unknown }>> = {
  'assumptions.market_reference.treasury_bill_3_month': { kind: 'rate', value: '0.0393' },
  'tax.us.2026.retirement.ira_contribution': { kind: 'money', value: money('750000') },
  'tax.us.2026.retirement.ira_catch_up_age_50': { kind: 'money', value: money('110000') },
};

export function parameterLookup(key: string): ParameterLookup {
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

export const PROJECTION: PortProjection = {
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

export function ports(): CataloguePorts {
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

export function contextFor(snapshot: AdvisorSnapshot = fixtureSnapshot()): CatalogueCallContext {
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
export const NO_DATABASE = CATALOGUE_FUNCTION_NAMES.filter((name) => !name.startsWith('insights.'));

export const ARGS: Readonly<Record<string, unknown>> = {
  'debt.payoff_plan': { order: 'avalanche', extra_monthly: money('6000') },
  'goal.required_savings': { goal_ref: goalRef(TOKEN_KEY, GOAL_ID) },
  'plan.compare': { a: 'baseline', b: '01900000-0000-7000-8000-0000000000aa' },
  'retirement.claiming': { ages: [62, 67, 70] },
  'limits.contribution_room': { year: 2026, account_kind: 'ira' },
};

export async function call(
  name: string,
  args: unknown = ARGS[name] ?? {},
): Promise<CatalogueResult> {
  const definition = CATALOGUE[name as keyof typeof CATALOGUE];
  return evaluateCatalogueFunction(name, contextFor(), args, definition.scopes);
}
