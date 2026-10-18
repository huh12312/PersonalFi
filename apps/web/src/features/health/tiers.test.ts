// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { HealthPillar } from '../../api/generated/types.gen.ts';
import { PILLARS, THRESHOLDS } from './test-fixtures.ts';
import { lowestPillar, nextStepOf, tierLineOf, tierOf } from './tiers.ts';

type Scored = Extract<HealthPillar, { status: 'scored' }>;
const threshold = (component: string) => THRESHOLDS.find((t) => t.component === component)!;
const scored = (overrides: Partial<Scored>): Scored => ({
  ...(PILLARS[0] as Scored),
  ...overrides,
});

describe('the tiers (WP 10.12)', () => {
  it('Building under 50, Steady 50 to under 80, Strong from 80', () => {
    expect(tierOf(0).word).toBe('Building');
    expect(tierOf(49.99).word).toBe('Building');
    expect(tierOf(50).word).toBe('Steady');
    expect(tierOf(79.99).word).toBe('Steady');
    expect(tierOf(80).word).toBe('Strong');
    expect(tierOf(100).word).toBe('Strong');
  });

  it('each tier wears a status quartet: warning, success, info', () => {
    expect([tierOf(10).status, tierOf(60).status, tierOf(90).status]).toEqual([
      'warning',
      'success',
      'info',
    ]);
  });

  it('the lowest pillar: the lowest score, then the higher weight, then catalogue order', () => {
    expect(lowestPillar(PILLARS)?.component).toBe('savings_rate');
    const tie: HealthPillar[] = [
      scored({ component: 'fee_drag', score: 50, weight: '0.100000' }),
      scored({ component: 'subscription_load', score: 50, weight: '0.150000' }),
    ];
    expect(lowestPillar(tie)?.component).toBe('subscription_load');
    const sameWeight: HealthPillar[] = [
      scored({ component: 'debt_to_income', score: 25, weight: '0.200000' }),
      scored({ component: 'savings_rate', score: 25, weight: '0.200000' }),
    ];
    expect(lowestPillar(sameWeight)?.component).toBe('savings_rate');
  });

  it('the next step aims at the next-better band edge from the scoring rules', () => {
    const cases: Array<[Scored, string]> = [
      [
        scored({ component: 'emergency_fund_months', band: 'poor' }),
        'build your cash toward 1 month of spending',
      ],
      [
        scored({ component: 'emergency_fund_months', band: 'fair' }),
        'build your cash toward 3 months of spending',
      ],
      [scored({ component: 'savings_rate', band: 'fair' }), 'save 10% of your income'],
      [
        scored({ component: 'debt_to_income', band: 'fair' }),
        'bring minimum payments under 36% of income',
      ],
      [
        scored({ component: 'debt_to_income', band: 'poor' }),
        'bring minimum payments under 43% of income',
      ],
      [
        scored({ component: 'subscription_load', band: 'fair' }),
        'trim subscriptions to under 5% of take-home',
      ],
      [
        scored({ component: 'diversification', band: 'fair' }),
        'bring your largest holding under 10% of your investments',
      ],
      [scored({ component: 'fee_drag', band: 'fair' }), 'cut avoidable fees below $50 a year'],
      [scored({ component: 'fee_drag', band: 'good' }), 'cut avoidable fees below $25 a year'],
    ];
    for (const [pillar, words] of cases) {
      expect(nextStepOf(pillar, threshold(pillar.component))).toBe(words);
    }
    expect(
      nextStepOf(scored({ band: 'excellent' }), threshold('emergency_fund_months')),
    ).toBeNull();
  });

  it('the tier line names the tier and the one thing to do next', () => {
    expect(tierLineOf(75, PILLARS, THRESHOLDS)).toBe(
      'You’re on steady ground. The one thing to do next: save 10% of your income (Savings rate).',
    );
  });

  it('all excellent says so; no score names what would unlock one', () => {
    const allExcellent = PILLARS.map((p) =>
      p.status === 'scored' ? { ...p, band: 'excellent' as const, score: 100 } : p,
    );
    expect(tierLineOf(100, allExcellent, THRESHOLDS)).toBe(
      'You’re in strong shape. Every pillar we can measure is excellent — keep it that way.',
    );
    const withheld = PILLARS.filter((p) => p.status === 'withheld');
    expect(tierLineOf(null, withheld, THRESHOLDS)).toBe(
      'There isn’t enough data to score yet. Link an investment account whose holdings have prices.',
    );
  });
});
