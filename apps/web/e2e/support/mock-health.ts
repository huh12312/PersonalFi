// SPDX-License-Identifier: MIT
import type { Page } from '@playwright/test';

/**
 * `GET /insights/health` (WP 10.12), as a layerable mock: a field-for-field instance of the contract's
 * `HealthOverview`. Five pillars scored and one withheld (diversification — no investments), the emergency fund's
 * living cover computed from classified categories, the thresholds exactly as `@ctx/insights`' scoring rules state
 * them, and 39 days of history with gaps (a day the job did not run has no row), including days more than 30 days
 * before today so the change since 30 days ago is a real figure.
 */

const usd = (minor: string) => ({ minor, currency: 'USD' });

export const HEALTH_THRESHOLDS = [
  {
    component: 'emergency_fund_months',
    unit: 'months',
    higherIsBetter: true,
    boundaries: ['1', '3', '6'],
  },
  {
    component: 'savings_rate',
    unit: 'ratio',
    higherIsBetter: true,
    boundaries: ['0.05', '0.10', '0.15'],
  },
  {
    component: 'debt_to_income',
    unit: 'ratio',
    higherIsBetter: false,
    boundaries: ['0.20', '0.36', '0.43'],
  },
  {
    component: 'subscription_load',
    unit: 'ratio',
    higherIsBetter: false,
    boundaries: ['0.02', '0.05', '0.10'],
  },
  {
    component: 'diversification',
    unit: 'ratio',
    higherIsBetter: false,
    boundaries: ['0.05', '0.10', '0.25'],
  },
  {
    component: 'fee_drag',
    unit: 'usd_per_year',
    higherIsBetter: false,
    boundaries: ['25.00', '50.00', '150.00'],
  },
] as const;

export const HEALTH_PILLARS = [
  {
    component: 'emergency_fund_months',
    status: 'scored',
    value: '4.2',
    band: 'good',
    weight: '0.235294',
    score: 75,
    inputs: [
      {
        key: 'cash_total',
        label: 'Cash in checking and savings',
        kind: 'money',
        value: usd('1260000'),
      },
      { key: 'cash_accounts', label: 'Cash accounts', kind: 'count', value: '2' },
      {
        key: 'monthly_spending',
        label: 'Average monthly spending (last 6 months with spending)',
        kind: 'money',
        value: usd('300000'),
      },
    ],
    livingCover: {
      status: 'computed',
      months: '6.3',
      band: 'excellent',
      livingExpenses: {
        status: 'computed',
        monthly: usd('200000'),
        fixedMonthlyAverage: usd('185000'),
        nonMonthlyMonthlyShare: usd('15000'),
        fixedCategoryCount: 3,
        nonMonthlyCategoryCount: 1,
        fixedWindow: { from: '2026-07', to: '2026-09' },
        nonMonthlyWindow: { from: '2025-10', to: '2026-09' },
      },
    },
  },
  {
    component: 'savings_rate',
    status: 'scored',
    value: '0.080000',
    band: 'fair',
    weight: '0.235294',
    score: 50,
    inputs: [
      { key: 'income_total', label: 'Income over 12 months', kind: 'money', value: usd('9000000') },
      {
        key: 'spending_total',
        label: 'Spending over 12 months',
        kind: 'money',
        value: usd('8280000'),
      },
    ],
  },
  {
    component: 'debt_to_income',
    status: 'scored',
    value: '0.180000',
    band: 'excellent',
    weight: '0.235294',
    score: 100,
    inputs: [
      {
        key: 'minimum_payments',
        label: 'Minimum payments per month',
        kind: 'money',
        value: usd('135000'),
      },
      {
        key: 'debts_with_minimum',
        label: 'Debts with a minimum payment',
        kind: 'count',
        value: '2',
      },
      {
        key: 'monthly_income',
        label: 'Average monthly income (12 months)',
        kind: 'money',
        value: usd('750000'),
      },
    ],
  },
  {
    component: 'subscription_load',
    status: 'scored',
    value: '0.031000',
    band: 'good',
    weight: '0.176471',
    score: 75,
    inputs: [
      {
        key: 'subscriptions_annual',
        label: 'Subscriptions still charging, per year',
        kind: 'money',
        value: usd('279000'),
      },
      {
        key: 'subscriptions_count',
        label: 'Subscriptions still charging',
        kind: 'count',
        value: '6',
      },
      {
        key: 'annual_income',
        label: 'Take-home income per year (average month × 12)',
        kind: 'money',
        value: usd('9000000'),
      },
    ],
  },
  {
    component: 'diversification',
    status: 'withheld',
    reason: 'holdings.aggregate had no investable holdings to assess concentration over',
    unlock: 'Link an investment account whose holdings have prices.',
    inputs: [],
  },
  {
    component: 'fee_drag',
    status: 'scored',
    value: usd('3750'),
    band: 'good',
    weight: '0.117647',
    score: 75,
    inputs: [
      {
        key: 'avoidable_fees',
        label: 'Avoidable fees over 12 months',
        kind: 'money',
        value: usd('3750'),
      },
      {
        key: 'expense_ratio_drag',
        label: 'Fund expense ratios per year',
        kind: 'text',
        value: 'not available',
      },
    ],
  },
] as const;

export const HEALTH_TODAY = '2026-10-18';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 39 days back to today, skipping a few (the job did not run), scores rising 68 → 75. */
export const HEALTH_HISTORY = Array.from({ length: 39 }, (_, index) => 38 - index)
  .filter((back) => back !== 21 && back !== 22 && back !== 9)
  .map((back) => {
    const asOfDate = addDays(HEALTH_TODAY, -back);
    const score = back === 0 ? 75 : Math.round((75 - back * 0.18) * 10) / 10;
    const emergency = back === 0 ? '4.2' : (4.2 - back * 0.02).toFixed(1);
    return {
      asOfDate,
      score,
      pillars: HEALTH_PILLARS.map((pillar) => ({
        component: pillar.component,
        score: pillar.status === 'scored' ? pillar.score : null,
        value:
          pillar.component === 'emergency_fund_months'
            ? emergency
            : pillar.status === 'scored'
              ? pillar.value
              : null,
      })),
    };
  });

export const HEALTH_OVERVIEW = {
  asOfDate: HEALTH_TODAY,
  today: HEALTH_TODAY,
  computedAt: '2026-10-18T08:10:00.000Z',
  score: 75,
  pillars: HEALTH_PILLARS,
  history: HEALTH_HISTORY,
  thresholds: HEALTH_THRESHOLDS,
  writtenNow: false,
};

export interface HealthMockState {
  /** How many times `/insights/health` was asked. */
  requests: number;
}

export async function installHealthMocks(page: Page): Promise<HealthMockState> {
  const state: HealthMockState = { requests: 0 };
  await page.route('**/api/insights/health', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    state.requests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ health: HEALTH_OVERVIEW }),
    });
  });
  return state;
}
