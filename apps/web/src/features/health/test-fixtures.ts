// SPDX-License-Identifier: MIT
/**
 * Test-only (WP 10.12): a `HealthOverview` as `GET /insights/health` serves it — five pillars scored, one withheld
 * (diversification: no investments), the thresholds exactly as `@ctx/insights`' `HEALTH_BAND_THRESHOLDS`, and
 * three days of history including one more than 30 days back.
 */
import type {
  HealthHistoryEntry,
  HealthOverview,
  HealthPillar,
  HealthThreshold,
} from '../../api/generated/types.gen.ts';

export const THRESHOLDS: HealthThreshold[] = [
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
];

const usd = (minor: string) => ({ minor, currency: 'USD' });

export const PILLARS: HealthPillar[] = [
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
    ],
    livingCover: {
      status: 'withheld',
      reason: 'No category is classified as fixed or non-monthly yet.',
      unlock: 'Classify your categories on the Budget screen.',
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
    inputs: [],
  },
  {
    component: 'subscription_load',
    status: 'scored',
    value: '0.031000',
    band: 'good',
    weight: '0.176471',
    score: 75,
    inputs: [],
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
    inputs: [],
  },
];

function entry(
  asOfDate: string,
  score: number | null,
  emergency: string | null,
): HealthHistoryEntry {
  return {
    asOfDate,
    score,
    pillars: PILLARS.map((pillar) => ({
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
}

export const HISTORY: HealthHistoryEntry[] = [
  entry('2026-09-15', 70.5, '3.6'),
  entry('2026-10-17', 73.5, '4.0'),
  entry('2026-10-18', 75, '4.2'),
];

export function overviewFixture(overrides: Partial<HealthOverview> = {}): HealthOverview {
  return {
    asOfDate: '2026-10-18',
    today: '2026-10-18',
    computedAt: '2026-10-18T08:10:00.000Z',
    score: 75,
    pillars: PILLARS,
    history: HISTORY,
    thresholds: THRESHOLDS,
    writtenNow: false,
    ...overrides,
  };
}
