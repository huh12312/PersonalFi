// SPDX-License-Identifier: MIT
/**
 * The payoff schedule (`catalogue/amortisation.ts`, WP 11.5b) against
 * schedules worked by hand, cent by cent. Each case's month-by-month working is
 * in `docs/evidence/phase-11/wp11.5b-advisory-catalogue.md` §3; the figures
 * below are the hand results, not the code's output pasted back.
 */
import { describe, expect, it } from 'vitest';
import {
  amortise,
  avalancheOrder,
  monthlyInterestMinor,
  monthStart,
  snowballOrder,
  type AmortisedDebt,
} from '../src/catalogue/amortisation.ts';

function debt(
  ref: string,
  balanceMinor: bigint,
  apr: string,
  minimumMinor: bigint,
  promo: AmortisedDebt['promo'] = null,
): AmortisedDebt {
  return { ref, balanceMinor, apr, minimumMinor, promo };
}

describe('the payoff schedule, against hand-worked cases', () => {
  it('rounds one month’s interest half-even to the cent', () => {
    // $819.10 at 12%: 81910 × 0.12 ÷ 12 = 819.1 minor → 819.
    expect(monthlyInterestMinor(81_910n, '0.12')).toBe(819n);
    // $634.56 at 12%: 634.56 minor → 635.
    expect(monthlyInterestMinor(63_456n, '0.12')).toBe(635n);
    // A tie rounds to even: 250 × 0.12 ÷ 12 = 2.5 → 2; 350 × 0.12 ÷ 12 = 3.5 → 4.
    expect(monthlyInterestMinor(250n, '0.12')).toBe(2n);
    expect(monthlyInterestMinor(350n, '0.12')).toBe(4n);
    expect(monthlyInterestMinor(100_000n, '0')).toBe(0n);
  });

  it('A — one debt, $1,000 at 12%, $100 a month: 11 months, $58.98 of interest', () => {
    const result = amortise({
      debts: [debt('L_A', 100_000n, '0.12', 10_000n)],
      extraMinor: 0n,
      order: ['L_A'],
      startMonth: '2026-10',
    });
    expect(result.status).toBe('paid_off');
    expect(result.months).toBe(11);
    expect(result.totalInterestMinor).toBe(5_898n);
    expect(result.totalPaidMinor).toBe(105_898n);
    expect(result.monthlyBudgetMinor).toBe(10_000n);
    expect(monthStart('2026-10', result.months ?? 0).slice(0, 7)).toBe('2027-09');
  });

  it('B — no interest: $1,000 at 0%, $100 minimum plus $50 extra: 7 months, $0 interest', () => {
    const result = amortise({
      debts: [debt('L_A', 100_000n, '0', 10_000n)],
      extraMinor: 5_000n,
      order: ['L_A'],
      startMonth: '2026-10',
    });
    expect(result.months).toBe(7);
    expect(result.totalInterestMinor).toBe(0n);
    expect(result.totalPaidMinor).toBe(100_000n);
  });

  describe('C — two debts where the orders differ, and the rollover', () => {
    // $300 at 24% and $100 at 12%, $20 minimum each, $60 extra: a fixed $100 a month.
    const debts = [debt('L_A', 30_000n, '0.24', 2_000n), debt('L_B', 10_000n, '0.12', 2_000n)];

    it('avalanche clears the 24% balance first: 5 months, $18.03 of interest', () => {
      expect(avalancheOrder(debts)).toEqual(['L_A', 'L_B']);
      const result = amortise({
        debts,
        extraMinor: 6_000n,
        order: avalancheOrder(debts),
        startMonth: '2026-10',
      });
      expect(result.months).toBe(5);
      expect(result.totalInterestMinor).toBe(1_803n);
      expect(result.totalPaidMinor).toBe(41_803n);
      expect(result.debts).toEqual([
        { ref: 'L_A', payoffMonthIndex: 4, interestMinor: 1_500n },
        { ref: 'L_B', payoffMonthIndex: 5, interestMinor: 303n },
      ]);
    });

    it('snowball clears the $100 balance first: 5 months, $19.92 of interest — $1.89 more', () => {
      expect(snowballOrder(debts)).toEqual(['L_B', 'L_A']);
      const result = amortise({
        debts,
        extraMinor: 6_000n,
        order: snowballOrder(debts),
        startMonth: '2026-10',
      });
      expect(result.months).toBe(5);
      expect(result.totalInterestMinor).toBe(1_992n);
      expect(result.debts).toEqual([
        { ref: 'L_A', payoffMonthIndex: 5, interestMinor: 1_871n },
        { ref: 'L_B', payoffMonthIndex: 2, interestMinor: 121n },
      ]);
      const avalanche = amortise({
        debts,
        extraMinor: 6_000n,
        order: avalancheOrder(debts),
        startMonth: '2026-10',
      });
      expect(result.totalInterestMinor - avalanche.totalInterestMinor).toBe(189n);
    });

    it('the freed minimum rolls to the next debt: the budget stays $100 after the first clears', () => {
      // Month 3 of the snowball: B is gone; A takes its own $20 minimum and the whole $80 left.
      // Without the rollover A would get only the $60 extra, and the interest would be $21.13.
      const result = amortise({
        debts,
        extraMinor: 6_000n,
        order: ['L_B', 'L_A'],
        startMonth: '2026-10',
      });
      expect(result.monthlyBudgetMinor).toBe(10_000n);
      expect(result.totalInterestMinor).toBe(1_992n);
      expect(result.months).toBe(5);
    });
  });

  it('D — a promotional rate applies to a month that starts before it ends', () => {
    // $300, 0% until 2026-12-01, then 12%; $100 a month from 2026-11: 4 months, $3.05.
    const result = amortise({
      debts: [debt('L_P', 30_000n, '0.12', 10_000n, { apr: '0', endDate: '2026-12-01' })],
      extraMinor: 0n,
      order: ['L_P'],
      startMonth: '2026-10',
    });
    expect(result.months).toBe(4);
    expect(result.totalInterestMinor).toBe(305n);
  });

  it('E — a minimum that only covers the interest never clears, and says so', () => {
    // $1,000 at 24% accrues $20 a month; a $20 minimum pays exactly that.
    const result = amortise({
      debts: [debt('L_N', 100_000n, '0.24', 2_000n)],
      extraMinor: 0n,
      order: ['L_N'],
      startMonth: '2026-10',
    });
    expect(result.status).toBe('not_paid_off');
    expect(result.months).toBeNull();
    expect(result.debts[0]?.payoffMonthIndex).toBeNull();
  });

  it('refuses an order that does not name every debt once, and a negative extra', () => {
    const debts = [debt('L_A', 1_000n, '0.1', 100n), debt('L_B', 1_000n, '0.1', 100n)];
    expect(() =>
      amortise({ debts, extraMinor: 0n, order: ['L_A'], startMonth: '2026-10' }),
    ).toThrow();
    expect(() =>
      amortise({ debts, extraMinor: -1n, order: ['L_A', 'L_B'], startMonth: '2026-10' }),
    ).toThrow();
  });

  it('is deterministic: the same inputs give the same schedule, field for field', () => {
    const debts = [debt('L_A', 30_000n, '0.24', 2_000n), debt('L_B', 10_000n, '0.12', 2_000n)];
    const run = () =>
      amortise({ debts, extraMinor: 6_000n, order: snowballOrder(debts), startMonth: '2026-10' });
    expect(run()).toEqual(run());
  });
});
