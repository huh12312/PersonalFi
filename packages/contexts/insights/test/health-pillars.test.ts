// SPDX-License-Identifier: MIT
/**
 * WP 10.12 (V5): the health score presented as pillars, a daily snapshot, and living expenses from the
 * budget's variability — pure, no database (`test/db/health-snapshots.test.ts` covers persistence).
 *
 * **The score is unchanged by this package.** `score.ts`, `thresholds.ts` and `snapshot/builder.ts` are
 * byte-identical to 2adcd82 (the dispatch commit); the literal overall figures below were computed at
 * 2adcd82 (83.75 is `test/health.test.ts`'s own hand-worked figure for the same fixture) and the daily
 * record must reproduce them exactly.
 */
import { DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import {
  CLASSIFY_UNLOCK,
  completeMonthsBefore,
  computeLivingExpenses,
  divideHalfEvenMinor,
  livingExpensesReadWindow,
  type LivingExpensesCell,
  type LivingExpensesSource,
} from '../src/health/living-expenses.ts';
import { healthSnapshotRecordOf, livingCoverOf, pillarsOf } from '../src/health/pillars.ts';
import { computeHealthScore } from '../src/health/score.ts';
import { HEALTH_COMPONENT_IDS } from '../src/health/thresholds.ts';

const USD = 'USD';
const TODAY = '2026-09-19';

function money(minor: string) {
  return { minor, currency: USD };
}

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

function withoutLiabilitiesAndHoldings(): AdvisorSnapshot {
  const { liabilities_terms: _l, holdings_aggregate: _h, ...rest } = fullSnapshot();
  return rest;
}

describe('the score is unchanged by WP 10.12', () => {
  it('the full fixture scores 83.75, as at 2adcd82, and the daily record carries it untouched', () => {
    const before = computeHealthScore(fullSnapshot(), null);
    expect(before.overall).toBe(83.75);
    const record = healthSnapshotRecordOf(fullSnapshot());
    expect(record.score).toBe(83.75);
    for (const component of before.components) {
      const pillar = record.pillars.find((p) => p.component === component.component);
      expect(pillar?.status).toBe('scored');
      if (pillar?.status !== 'scored') continue;
      expect([pillar.value, pillar.band, pillar.weight, pillar.score]).toEqual([
        component.value,
        component.band,
        component.weight,
        component.score,
      ]);
    }
  });

  it('a partial fixture (no liabilities, no holdings) scores as at 2adcd82, and the two withheld pillars are not zeros', () => {
    const record = healthSnapshotRecordOf(withoutLiabilitiesAndHoldings());
    // 2adcd82: renormalised over four components (0.2,0.2,0.15,0.1)/0.65 → 80.77.
    expect(computeHealthScore(withoutLiabilitiesAndHoldings(), null).overall).toBe(80.77);
    expect(record.score).toBe(80.77);
    const withheld = record.pillars.filter((p) => p.status === 'withheld');
    expect(withheld.map((p) => p.component)).toEqual(['debt_to_income', 'diversification']);
    for (const pillar of withheld) {
      expect(pillar).not.toHaveProperty('score');
      expect(pillar).not.toHaveProperty('value');
      expect(pillar.status === 'withheld' && pillar.unlock.length).toBeGreaterThan(10);
    }
  });

  it('a living-expenses figure never moves the score', () => {
    const living = computeLivingExpenses(
      source([cell('2026-08', 'rent', -200000n)], { rent: 'fixed' }),
      DateOnly.parse(TODAY),
    );
    expect(healthSnapshotRecordOf(fullSnapshot(), living).score).toBe(83.75);
  });
});

describe('pillars', () => {
  it('six pillars, in catalogue order, each scored or withheld', () => {
    const pillars = pillarsOf(computeHealthScore(fullSnapshot(), null), fullSnapshot());
    expect(pillars.map((p) => p.component)).toEqual([...HEALTH_COMPONENT_IDS]);
  });

  it("every pillar states the data it is built from, and the figures reconcile with the score's", () => {
    const pillars = pillarsOf(computeHealthScore(fullSnapshot(), null), fullSnapshot());
    const byId = new Map(pillars.map((p) => [p.component, p]));
    const inputs = (id: (typeof HEALTH_COMPONENT_IDS)[number]) =>
      Object.fromEntries((byId.get(id)?.inputs ?? []).map((i) => [i.key, i.value]));
    expect(inputs('emergency_fund_months')).toEqual({
      cash_total: money('1000000'),
      cash_accounts: '1',
      monthly_spending: money('450000'),
    });
    expect(inputs('savings_rate')).toEqual({ plan_observed: '0.12' });
    // 900 ÷ 6000 = 0.15, the scored value.
    expect(inputs('debt_to_income')).toEqual({
      minimum_payments: money('90000'),
      debts_with_minimum: '1',
      monthly_income: money('600000'),
    });
    // 1200 ÷ 72000.
    expect(inputs('subscription_load')).toEqual({
      subscriptions_annual: money('120000'),
      subscriptions_count: '1',
      annual_income: money('7200000'),
    });
    expect(inputs('diversification')).toEqual({
      investable_total: money('1000000'),
      largest_position: 'AAPL',
    });
    expect(inputs('fee_drag')).toEqual({
      avoidable_fees: money('3000'),
      expense_ratio_drag: 'not available',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
// The living-expenses rule
// ---------------------------------------------------------------------------------------------------------

function cell(month: string, categoryId: string | null, amountMinor: bigint): LivingExpensesCell {
  return { month, categoryId, amountMinor };
}

function source(
  cells: LivingExpensesCell[],
  classes: Record<string, 'fixed' | 'flexible' | 'non_monthly' | null>,
): LivingExpensesSource {
  return {
    currency: USD,
    categories: Object.entries(classes).map(([id, variability]) => ({ id, variability })),
    cells,
  };
}

const today = DateOnly.parse(TODAY);

describe("living expenses from the budget's variability", () => {
  it("windows: three and twelve complete months before today's month; the read covers the longer", () => {
    expect(completeMonthsBefore(today, 3)).toEqual({ from: '2026-06', to: '2026-08' });
    expect(completeMonthsBefore(today, 12)).toEqual({ from: '2025-09', to: '2026-08' });
    expect(livingExpensesReadWindow(today)).toEqual({ from: '2025-09-01', to: '2026-08-31' });
    expect(completeMonthsBefore(DateOnly.parse('2026-01-01'), 3)).toEqual({
      from: '2025-10',
      to: '2025-12',
    });
  });

  it('fixed is the 3-month average; non-monthly is its 12-month total ÷ 12; flexible and unclassified never count', () => {
    const result = computeLivingExpenses(
      source(
        [
          // Fixed: rent $2,000 × 3 and a phone bill $90 × 3 → $2,090 / month.
          cell('2026-06', 'rent', -200000n),
          cell('2026-07', 'rent', -200000n),
          cell('2026-08', 'rent', -200000n),
          cell('2026-06', 'phone', -9000n),
          cell('2026-07', 'phone', -9000n),
          cell('2026-08', 'phone', -9000n),
          // Outside the fixed window: May, and this (partial) month.
          cell('2026-05', 'rent', -999900n),
          cell('2026-09', 'rent', -999900n),
          // Non-monthly: a $1,200 annual premium inside the 12 months → $100 / month.
          cell('2025-11', 'insurance', -120000n),
          // Non-monthly outside the 12 months: never counted.
          cell('2025-08', 'insurance', -500000n),
          // Flexible and unclassified: never counted.
          cell('2026-07', 'dining', -77700n),
          cell('2026-07', 'gifts', -55500n),
          cell('2026-07', null, -33300n),
        ],
        {
          rent: 'fixed',
          phone: 'fixed',
          insurance: 'non_monthly',
          dining: 'flexible',
          gifts: null,
        },
      ),
      today,
    );
    expect(result).toEqual({
      status: 'computed',
      monthly: money('219000'),
      fixedMonthlyAverage: money('209000'),
      nonMonthlyMonthlyShare: money('10000'),
      fixedCategoryCount: 2,
      nonMonthlyCategoryCount: 1,
      fixedWindow: { from: '2026-06', to: '2026-08' },
      nonMonthlyWindow: { from: '2025-09', to: '2026-08' },
    });
  });

  it('a refund nets inside its category and never below zero; division is half-even in minor units', () => {
    const result = computeLivingExpenses(
      source(
        [
          cell('2026-06', 'rent', -100001n),
          cell('2026-07', 'rent', 0n),
          cell('2026-08', 'rent', 0n),
          // Refunded more than it spent: floors at zero, never subtracts from rent.
          cell('2026-07', 'gym', -5000n),
          cell('2026-08', 'gym', 9000n),
        ],
        { rent: 'fixed', gym: 'fixed' },
      ),
      today,
    );
    // 100001 / 3 = 33333.67 → 33334.
    expect(result.status === 'computed' && result.fixedMonthlyAverage).toEqual(money('33334'));
    expect(divideHalfEvenMinor(5n, 2n)).toBe(2n);
    expect(divideHalfEvenMinor(7n, 2n)).toBe(4n);
    expect(divideHalfEvenMinor(10n, 4n)).toBe(2n);
    expect(divideHalfEvenMinor(11n, 4n)).toBe(3n);
  });

  it('no category classified yet → withheld with the Budget-screen unlock, never zero', () => {
    const none = computeLivingExpenses(
      source([cell('2026-07', 'rent', -200000n)], { rent: null }),
      today,
    );
    expect(none).toEqual({
      status: 'withheld',
      reason: expect.any(String),
      unlock: CLASSIFY_UNLOCK,
    });
    expect(CLASSIFY_UNLOCK).toBe('Classify your categories on the Budget screen.');
    // Only flexible classified: still nothing that is a living expense.
    const flexibleOnly = computeLivingExpenses(
      source([cell('2026-07', 'dining', -200000n)], { dining: 'flexible' }),
      today,
    );
    expect(flexibleOnly.status === 'withheld' && flexibleOnly.unlock).toBe(CLASSIFY_UNLOCK);
  });

  it('classified but no spending in the windows → withheld, not zero', () => {
    const result = computeLivingExpenses(
      source([cell('2026-09', 'rent', -200000n)], { rent: 'fixed' }),
      today,
    );
    expect(result.status).toBe('withheld');
  });

  it('the living cover: cash ÷ living expenses, one decimal, banded on the emergency-fund ladder, not scored', () => {
    const living = computeLivingExpenses(
      source(
        [
          cell('2026-06', 'rent', -300000n),
          cell('2026-07', 'rent', -300000n),
          cell('2026-08', 'rent', -300000n),
        ],
        {
          rent: 'fixed',
        },
      ),
      today,
    );
    // $10,000 ÷ $3,000 = 3.33… → 3.3 months → good (3 ≤ x < 6).
    const cover = livingCoverOf(fullSnapshot(), living);
    expect(cover).toMatchObject({ status: 'computed', months: '3.3', band: 'good' });
    const pillar = healthSnapshotRecordOf(fullSnapshot(), living).pillars[0];
    expect(pillar?.livingCover).toEqual(cover);
    const withheld = livingCoverOf(fullSnapshot(), computeLivingExpenses(source([], {}), today));
    expect(withheld).toMatchObject({ status: 'withheld', unlock: CLASSIFY_UNLOCK });
  });
});
