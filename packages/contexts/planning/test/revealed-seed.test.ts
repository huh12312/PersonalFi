// SPDX-License-Identifier: MIT
/**
 * The twelve-month window walked on the Phase 0/1 demo seed
 * (`generateDemoData(1)`, the household every Phase 1–3 end-to-end proof uses),
 * for `docs/evidence/phase-4/wp4.3-revealed.md` §3.
 *
 * Every expected number here is computed **from the seed's raw rows in this
 * file**, never by calling the derivation twice, and then pinned as a literal
 * so a change in either the seed or the derivation is a visible diff. The seed
 * predates `@ctx/budgeting`, so its spending periods are built by
 * `seedPorts` from the seed's merchant categories with the stated class
 * mapping `SEED_CATEGORY_CLASS`; its transfer pairing is the seed's own ground
 * truth (`labels.transfers`), which is what Phase 1's pairing is graded against.
 */
import { DateOnly, Money } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { describe, expect, it } from 'vitest';
import { deriveRevealedBehavior, type DerivedAmount } from '../src/revealed.ts';
import { ratioToDecimal } from '../src/windows.ts';
import { SEED_CATEGORY_CLASS, USER, day, seedPorts } from './revealed-fixtures.ts';

const FROM = day('2025-09-01');
const TO = day('2026-08-31');

function inWindow(date: DateOnly): boolean {
  return DateOnly.compare(date, FROM) >= 0 && DateOnly.compare(date, TO) <= 0;
}

function totalOf(amount: DerivedAmount): string {
  if (amount.status !== 'derived') throw new Error(`expected derived, got ${amount.status}`);
  return Money.formatAmount(amount.total);
}

describe('revealed behaviour on the demo seed', () => {
  it('walks the twelve-month window to the same numbers the seed gives by hand', async () => {
    const dataset = generateDemoData(1);
    const { ports } = seedPorts(dataset);
    const result = await deriveRevealedBehavior(ports, {
      userId: USER,
      asOf: day('2026-08-31'),
      baseCurrency: 'USD',
    });
    const typeOf = new Map(dataset.accounts.map((a) => [a.id, a.type] as const));
    const posted = dataset.transactions.filter(
      (t) => t.status === 'posted' && inWindow(t.postedOn),
    );
    const minor = (t: (typeof posted)[number]): bigint => BigInt(t.amount.minor);

    // --- income, by hand: the biweekly payroll deposits into checking --------
    const payroll = posted.filter(
      (t) => typeOf.get(t.accountId) === 'checking' && t.kind === 'deposit',
    );
    const payrollMinor = payroll.reduce((sum, t) => sum + minor(t), 0n);
    expect(payroll).toHaveLength(26);
    expect(payrollMinor).toBe(8_060_000n);
    expect(totalOf(result.income.takeHome)).toBe('80600.00');
    expect(result.income.takeHome.observationCount).toBe(26);

    // --- contributions, by hand: transfers into the brokerage ---------------
    const intoBrokerage = posted.filter(
      (t) => typeOf.get(t.accountId) === 'brokerage' && minor(t) > 0n,
    );
    const contributedMinor = intoBrokerage.reduce((sum, t) => sum + minor(t), 0n);
    expect(intoBrokerage.map((t) => t.postedOn)).toEqual(['2025-10-05', '2026-04-05']);
    expect(contributedMinor).toBe(400_000n);
    expect(totalOf(result.contributions.byBucket.TAXABLE)).toBe('4000.00');
    expect(totalOf(result.contributions.total)).toBe('4000.00');
    // The seed has no Roth, 401(k) or HSA: absent, not zero.
    for (const bucket of ['TAX_DEFERRED', 'ROTH', 'HSA'] as const) {
      expect(result.contributions.byBucket[bucket].status).toBe('not_derivable');
    }
    // Two observations is below oneOffMinimumPeers + 1: the detector abstains and says so.
    expect(result.contributions.oneOffTest.TAXABLE).toBe('too_few_peers');

    // --- the savings rate, by hand -------------------------------------------
    // Contributions ÷ (take-home + contributions from outside the linked
    // accounts). Both brokerage transfers came from savings, so the second
    // term is zero: 4,000.00 / 80,600.00 = 0.049627… → 0.0496.
    expect(ratioToDecimal(contributedMinor, payrollMinor, 4)).toBe('0.0496');
    expect(result.savingsRate).toMatchObject({ status: 'derived', rate: '0.0496' });

    // --- every row read is either counted or named ----------------------------
    const cashInflows = posted.filter(
      (t) =>
        (typeOf.get(t.accountId) === 'checking' || typeOf.get(t.accountId) === 'savings') &&
        minor(t) > 0n,
    );
    const incomeExclusions = result.exclusions.filter((e) => e.derivation === 'income');
    expect(cashInflows.length).toBe(payroll.length + incomeExclusions.length);
    expect(incomeExclusions.map((e) => e.reason).sort()).toEqual([
      ...Array<string>(12).fill('internal_transfer'),
      'refund',
      'refund',
    ]);
    expect(result.exclusions.filter((e) => e.derivation === 'contributions')).toEqual([]);

    // --- spending, by hand, reconciled against what was named -----------------
    const categoryOf = new Map(dataset.merchants.map((m) => [m.id, m.category] as const));
    const byClass = { NEED: 0n, WANT: 0n };
    for (const t of posted) {
      if (t.kind !== 'purchase' && t.kind !== 'payment' && t.kind !== 'refund') continue;
      const cls =
        t.merchantId === null ? undefined : SEED_CATEGORY_CLASS[categoryOf.get(t.merchantId) ?? ''];
      if (cls === 'NEED' || cls === 'WANT') byClass[cls] -= minor(t);
    }
    const namedSpend = (cls: 'NEED' | 'WANT'): bigint =>
      result.exclusions
        .filter((e) => e.derivation === 'spending')
        .filter((e) => SEED_CATEGORY_CLASS[(e.categoryId ?? '').replace('category-', '')] === cls)
        .reduce((sum, e) => sum + e.amount.minor, 0n);
    const essential = result.spending.essential;
    const discretionary = result.spending.discretionary;
    if (essential.status !== 'derived' || discretionary.status !== 'derived') {
      throw new Error('seed spending should derive');
    }
    expect(essential.total.minor + namedSpend('NEED')).toBe(byClass.NEED);
    expect(discretionary.total.minor + namedSpend('WANT')).toBe(byClass.WANT);
    expect(byClass.NEED).toBe(4_635_591n);
    expect(byClass.WANT).toBe(1_991_421n);
    expect(totalOf(essential)).toBe('46355.91');
    expect(totalOf(discretionary)).toBe('18983.77');
    expect(totalOf(result.spending.nonSavings)).toBe('65339.68');

    // The one spending one-off on this seed, named.
    const spendingOneOffs = result.exclusions.filter((e) => e.derivation === 'spending');
    expect(spendingOneOffs).toHaveLength(1);
    expect(spendingOneOffs[0]).toMatchObject({
      reason: 'one_off',
      label: 'shopping, 2026-04-01 to 2026-04-30',
      categoryId: 'category-shopping',
    });
    expect(Money.formatAmount(spendingOneOffs[0]?.amount ?? Money.zero('USD'))).toBe('930.44');
    // Insurance is one annual-ish observation: never judged, never struck.
    expect(result.spending.categories.find((c) => c.name === 'insurance')?.oneOffTest).toBe(
      'too_few_peers',
    );
    expect(result.exclusions).toHaveLength(15);
  });
});
