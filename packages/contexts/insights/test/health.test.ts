// SPDX-License-Identifier: MIT
/**
 * `computeHealthScore` (05-phase-5-dispatch.md §3 WP 5.8; 09 ADV-7, §4
 * benchmark row 20), pure — no database. `test/db/health.test.ts` proves
 * persistence and the direction-of-travel claim over a real one.
 *
 * A hand-built snapshot rather than `test/advisors/seed.ts`'s real-builder
 * seeds: those seeds carry no `liabilities.terms` block at all (that file's
 * own header explains why — the block was never moved onto the real
 * builder), and this suite needs all seven blocks `score.ts` reads present
 * and exact, with arithmetic worked by hand below so a reviewer can check
 * every band without re-running the function.
 */
import { describe, expect, it } from 'vitest';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import * as D from '../src/validate/decimal.ts';
import { HEALTH_COMPONENT_IDS, type HealthComponentId } from '../src/health/thresholds.ts';
import { computeHealthScore, type PreviousComponentScore } from '../src/health/score.ts';

const USD = 'USD';
const TODAY = '2026-09-19';

function money(minor: string) {
  return { minor, currency: USD };
}

/**
 * Every component computable, each landing on a different band so the
 * worked arithmetic (this file's header, and `wp5.8-health.md` §1) exercises
 * more than one branch of `classifyDecimal`:
 *
 *   * `emergency_fund_months = 4` — between the 3/6-month boundaries → `good` (75)
 *   * `savings_rate = 0.12` (from `plan_projection`, preferred over `cashflow`) — between 0.10/0.15 → `good` (75)
 *   * `debt_to_income = 900 ÷ 6000 = 0.15` — below the 0.20 boundary → `excellent` (100)
 *   * `subscription_load = 1200 ÷ 72000 ≈ 0.016667` — below the 0.02 boundary → `excellent` (100)
 *   * `diversification = 0.08` — between 0.05/0.10 → `good` (75)
 *   * `fee_drag = $30.00` — between $25/$50 → `good` (75)
 *
 * Base weights (`BASE_WEIGHT`, out of `1_000_000`): 200000, 200000, 200000,
 * 150000, 150000, 100000 — all six computable, so renormalisation is a
 * no-op and the weights are exactly 0.2, 0.2, 0.2, 0.15, 0.15, 0.1.
 *
 *   overall = 0.2·75 + 0.2·75 + 0.2·100 + 0.15·100 + 0.15·75 + 0.1·75
 *           = 15 + 15 + 20 + 15 + 11.25 + 7.5 = 83.75
 */
function fullSnapshot(): AdvisorSnapshot {
  return {
    cash_summary: {
      as_of: TODAY,
      total: money('1000000'),
      account_count: 1,
      blended_apy: 0.01,
      emergency_fund_months: 4,
      accounts: [
        {
          account_ref: '01930000-0000-7000-8000-00000000c1a1',
          type: 'checking',
          balance: money('1000000'),
          apy: 0.01,
        },
      ],
    },
    // $6,000 income / $4,500 expense in each of two months — monthly average
    // income $6,000, which debt_to_income and subscription_load both divide into.
    cashflow_monthly: {
      from_month: '2026-08',
      to_month: '2026-09',
      currency: USD,
      months: [
        {
          month: '2026-08',
          income: money('600000'),
          expense: money('450000'),
          net: money('150000'),
          by_category: [],
        },
        {
          month: '2026-09',
          income: money('600000'),
          expense: money('450000'),
          net: money('150000'),
          by_category: [],
        },
      ],
    },
    plan_projection: {
      as_of_year: 2026,
      currency: USD,
      method: 'deterministic',
      paths: 1,
      assumptions_version: 'sha256:test-assumptions',
      stale: false,
      success_probability: '1',
      success_target: '0.80',
      terminal: { age: 90, calendar_year: 2071, p5: null, p50: money('100000000'), p95: null },
      ages: { current: 45, retirement: 65, plan_end: 90 },
      savings_rate: { plan: '0.10', observed: '0.12', plan_source: 'derived' },
    },
    // One liability, $900/month minimum — 900 ÷ 6000 = 0.15 debt-to-income.
    liabilities_terms: {
      as_of: TODAY,
      currency: USD,
      liabilities: [
        {
          liability_ref: 'LIAB_a1b2c3d4e5f6',
          kind: 'credit_card',
          apr: 0.1999,
          promo_apr: null,
          promo_apr_end_date: null,
          credit_limit: money('500000'),
          statement_balance: money('90000'),
          current_balance: money('90000'),
          minimum_payment: money('90000'),
          payment_due_date: null,
          last_payment_date: null,
          last_payment_amount: null,
          minimum_only_months: null,
        },
      ],
    },
    // One $100/month stream, $1,200/year — 1200 ÷ 72000 (annualised income) ≈ 0.016667.
    recurring_list: {
      as_of: TODAY,
      currency: USD,
      streams: [
        {
          series_ref: '01930000-0000-7000-8000-00000000c1b1',
          merchant_ref: 'MERCHANT_a7f31c9d0e42',
          cadence: 'MONTHLY',
          type: 'SUBSCRIPTION',
          status: 'ACTIVE',
          user_confirmed: true,
          confidence: 0.9,
          typical_amount: money('10000'),
          observed_min: money('10000'),
          observed_max: money('10000'),
          next_due_date: '2026-10-01',
          first_seen: '2025-10-01',
          last_seen: '2026-09-01',
          periods_per_year: 12,
          eligible_for_impact: true,
          price_changes: [],
        },
      ],
    },
    // One position at 8% of the investable total.
    holdings_aggregate: {
      as_of: TODAY,
      currency: USD,
      investable_total: money('1000000'),
      unclassified_pct: 0,
      by_asset_class: [],
      top_positions: [
        {
          symbol: 'AAPL',
          weight: 0.08,
          value: money('80000'),
          asset_class: 'equity',
          employer_stock: false,
          is_crypto: false,
        },
      ],
      target_allocation: [],
      account_type_mix: {},
    },
    // $30.00 of avoidable fees, no expense-ratio drag.
    fees_summary: {
      as_of: TODAY,
      currency: USD,
      window_months: 12,
      by_type: [{ type: 'overdraft', avoidable: true, count: 1, total: money('3000') }],
      by_account: [],
      expense_ratio_drag: null,
    },
  };
}

/** `fullSnapshot()` with `liabilities_terms` dropped entirely — no scope granted. */
function snapshotMissingLiabilities(): AdvisorSnapshot {
  const { liabilities_terms: _dropped, ...rest } = fullSnapshot();
  return rest;
}

function sumWeights(result: ReturnType<typeof computeHealthScore>): bigint {
  let sum: D.Decimal = 0n;
  for (const component of result.components) {
    const parsed = D.parseDecimal(component.weight);
    expect(parsed).not.toBeNull();
    const added = D.add(sum, parsed ?? 0n);
    expect(added).not.toBeNull();
    sum = added ?? sum;
  }
  return sum;
}

describe('computeHealthScore', () => {
  it('the score decomposes into six named components, each with value, weight and direction', () => {
    const result = computeHealthScore(fullSnapshot(), null);

    expect(result.excluded).toEqual([]);
    expect(result.components).toHaveLength(6);
    expect(result.components.map((component) => component.component)).toEqual([
      ...HEALTH_COMPONENT_IDS,
    ]);
    for (const component of result.components) {
      expect(typeof component.value === 'string' || typeof component.value === 'object').toBe(true);
      expect(typeof component.weight).toBe('string');
      expect(component.direction).toBe('no_previous_data'); // no previous week given
      expect(component.score).toBeGreaterThanOrEqual(0);
      expect(component.score).toBeLessThanOrEqual(100);
    }

    // The worked arithmetic in this file's header, band by band.
    const byComponent = new Map(result.components.map((c) => [c.component, c]));
    expect(byComponent.get('emergency_fund_months')?.band).toBe('good');
    expect(byComponent.get('savings_rate')?.band).toBe('good');
    expect(byComponent.get('debt_to_income')?.band).toBe('excellent');
    expect(byComponent.get('subscription_load')?.band).toBe('excellent');
    expect(byComponent.get('diversification')?.band).toBe('good');
    expect(byComponent.get('fee_drag')?.band).toBe('good');

    expect(result.overall).toBe(83.75);
  });

  it('a component with no data is excluded and named, never scored as zero', () => {
    const result = computeHealthScore(snapshotMissingLiabilities(), null);

    expect(result.excluded).toEqual([
      {
        component: 'debt_to_income',
        reason: expect.stringContaining('liabilities.terms'),
      },
    ]);
    expect(result.components).toHaveLength(5);
    expect(result.components.some((c) => c.component === 'debt_to_income')).toBe(false);
    // Never scored as zero: it does not appear among the computed components at all.
    expect(result.components.map((c) => c.score)).not.toContain(0);
  });

  it('the weights sum to one over the computable components', () => {
    const full = computeHealthScore(fullSnapshot(), null);
    expect(sumWeights(full)).toBe(1_000_000n);

    const missingOne = computeHealthScore(snapshotMissingLiabilities(), null);
    expect(sumWeights(missingOne)).toBe(1_000_000n);

    // The degenerate case: every component excluded still sums to one —
    // vacuously, over zero components — and overall reads null rather than zero.
    const empty = computeHealthScore({}, null);
    expect(empty.components).toHaveLength(0);
    expect(empty.excluded).toHaveLength(6);
    expect(empty.overall).toBeNull();
  });

  it('the same snapshot always yields the same score', () => {
    const snapshot = fullSnapshot();
    const first = computeHealthScore(snapshot, null);
    const second = computeHealthScore(snapshot, null);
    expect(second).toEqual(first);

    // Also deterministic with a previous-week map supplied.
    const previous = new Map<HealthComponentId, PreviousComponentScore>([
      ['emergency_fund_months', { score: 50 }],
    ]);
    const thirdA = computeHealthScore(snapshot, previous);
    const thirdB = computeHealthScore(snapshot, previous);
    expect(thirdB).toEqual(thirdA);
  });

  it('direction reads against the given previous-week map, and improved/worsened/unchanged all occur', () => {
    const previous = new Map<HealthComponentId, PreviousComponentScore>([
      ['emergency_fund_months', { score: 50 }], // was fair, now good(75) -> improved
      ['savings_rate', { score: 100 }], // was excellent, now good(75) -> worsened
      ['debt_to_income', { score: 100 }], // unchanged at excellent(100)
    ]);
    const result = computeHealthScore(fullSnapshot(), previous);
    const byComponent = new Map(result.components.map((c) => [c.component, c]));
    expect(byComponent.get('emergency_fund_months')?.direction).toBe('improved');
    expect(byComponent.get('savings_rate')?.direction).toBe('worsened');
    expect(byComponent.get('debt_to_income')?.direction).toBe('unchanged');
    expect(byComponent.get('subscription_load')?.direction).toBe('no_previous_data');
  });
});
