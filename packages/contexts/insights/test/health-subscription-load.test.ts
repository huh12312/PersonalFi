// SPDX-License-Identifier: MIT
/**
 * G5-12 (Phase 5 gate, C5-9): "Subscription load" counts subscriptions.
 *
 * The gate's walk showed 57.3 % "Poor" for a holder whose subscriptions came to
 * about $87 a month, because `subscriptionLoad` summed every `recurring.list`
 * stream: rent, power and groceries too. The thresholds are U7's ("Σ
 * subscription annual > 10% of take-home"), so the figure is the sum of
 * *subscription* streams that are still charging, over take-home.
 */
import { describe, expect, it } from 'vitest';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { computeHealthScore } from '../src/health/score.ts';

const USD = 'USD';
const TODAY = '2026-09-19';

function money(minor: string) {
  return { minor, currency: USD };
}

function stream(
  id: string,
  type: string,
  status: string,
  minor: string,
  periodsPerYear: number,
): NonNullable<AdvisorSnapshot['recurring_list']>['streams'][number] {
  return {
    series_ref: `01930000-0000-7000-8000-0000000000${id}`,
    merchant_ref: `MERCHANT_a7f31c9d0e${id}`,
    cadence: 'MONTHLY',
    type,
    status,
    user_confirmed: true,
    confidence: 0.9,
    typical_amount: money(minor),
    observed_min: money(minor),
    observed_max: money(minor),
    next_due_date: '2026-10-01',
    first_seen: '2025-10-01',
    last_seen: '2026-09-01',
    periods_per_year: periodsPerYear,
    eligible_for_impact: true,
    price_changes: [],
  };
}

/** $6,000 a month take-home ($72,000 a year) and the given recurring streams. */
function snapshotWith(
  streams: NonNullable<AdvisorSnapshot['recurring_list']>['streams'],
): AdvisorSnapshot {
  return {
    cashflow_monthly: {
      from_month: '2026-08',
      to_month: '2026-09',
      currency: USD,
      months: ['2026-08', '2026-09'].map((month) => ({
        month,
        income: money('600000'),
        expense: money('450000'),
        net: money('150000'),
        by_category: [],
      })),
    },
    recurring_list: { as_of: TODAY, currency: USD, streams: [...streams] },
  };
}

function loadOf(snapshot: AdvisorSnapshot): string {
  const component = computeHealthScore(snapshot, null).components.find(
    (item) => item.component === 'subscription_load',
  );
  if (component === undefined || typeof component.value !== 'string') {
    throw new Error('subscription_load was not computed');
  }
  return component.value;
}

describe('subscription_load (G5-12)', () => {
  it('counts subscriptions only: rent, power and income streams are not subscriptions', () => {
    const load = loadOf(
      snapshotWith([
        stream('01', 'SUBSCRIPTION', 'ACTIVE', '4700', 12), // $47/mo
        stream('02', 'SUBSCRIPTION', 'ACTIVE', '4000', 12), // $40/mo
        stream('03', 'RECURRING_BILL', 'ACTIVE', '145000', 12), // rent
        stream('04', 'RECURRING_BILL', 'ACTIVE', '20000', 12), // power
        stream('05', 'LOAN_PAYMENT', 'ACTIVE', '60000', 12),
        stream('06', 'RECURRING_INCOME', 'ACTIVE', '300000', 12),
      ]),
    );
    // ($47 + $40) × 12 ÷ $72,000 = 1044 ÷ 72000 = 0.0145
    expect(load).toBe('0.014500');
  });

  it('a subscription that has stopped charging no longer counts', () => {
    const load = loadOf(
      snapshotWith([
        stream('01', 'SUBSCRIPTION', 'ACTIVE', '4700', 12),
        stream('02', 'SUBSCRIPTION', 'CANCELED', '4000', 12),
        stream('03', 'SUBSCRIPTION', 'LIKELY_CANCELED', '4000', 12),
      ]),
    );
    // $47 × 12 ÷ $72,000 = 564 ÷ 72000
    expect(load).toBe('0.007833');
  });

  it('a holder with no subscription streams has a load of zero, not an exclusion', () => {
    expect(loadOf(snapshotWith([stream('03', 'RECURRING_BILL', 'ACTIVE', '145000', 12)]))).toBe(
      '0.000000',
    );
  });
});
