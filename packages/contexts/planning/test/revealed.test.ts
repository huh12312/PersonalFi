// SPDX-License-Identifier: MIT
/**
 * WP 4.3's four exit tests (Phase 4 dispatch §3), named exactly as the
 * dispatch names them. Each is written so that exactly one control in
 * `src/revealed.ts` / `src/windows.ts` stands between the fixture and a wrong
 * answer — the evidence (`docs/evidence/phase-4/wp4.3-revealed.md` §5) records
 * each control sabotaged and this file going red.
 *
 * The window throughout is `asOf = 2026-08-31` → 2025-09-01 … 2026-08-31, twelve
 * whole months (365 days), so a derived annual is the observed total exactly and
 * a monthly is that over twelve.
 */
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  deriveRevealedBehavior,
  derivedContributionPlan,
  type DerivedAmount,
  type RevealedBehavior,
} from '../src/revealed.ts';
import type { CashflowInflow, RevealedPorts } from '../src/ports.ts';
import {
  USER,
  account,
  day,
  inflow,
  monthly,
  monthlyPeriods,
  ports,
  usd,
  type LineSpec,
} from './revealed-fixtures.ts';

const AS_OF = day('2026-08-31');

async function derive(bound: RevealedPorts): Promise<RevealedBehavior> {
  return deriveRevealedBehavior(bound, { userId: USER, asOf: AS_OF, baseCurrency: 'USD' });
}

function derived(amount: DerivedAmount): Extract<DerivedAmount, { status: 'derived' }> {
  if (amount.status !== 'derived') {
    throw new Error(
      `expected a derived amount, got ${amount.status}: ${JSON.stringify(amount, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`,
    );
  }
  return amount;
}

const checking = account('acct-checking', 'Everyday Checking', 'cash', 'checking');
const savings = account('acct-savings', 'High-Yield Savings', 'cash', 'savings');
const brokerage = account('acct-brokerage', 'Taxable Brokerage', 'investment', 'brokerage');
const roth = account('acct-roth', 'Roth IRA', 'investment', 'roth');
const workplace = account('acct-401k', 'Workplace 401(k)', 'investment', '401k');
const oldPlan = account('acct-old-401k', 'Former Employer 401(k)', 'investment', '401k');
const rollover = account('acct-ira', 'Rollover IRA', 'investment', 'ira');

/** Twenty months of $3,000 semi-monthly pay, so income history never limits a test. */
const PAYROLL: readonly CashflowInflow[] = [
  ...monthly('pay-a', checking.accountId, '2025-01', 20, 1, '3000.00', null),
  ...monthly('pay-b', checking.accountId, '2025-01', 20, 15, '3000.00', null),
];

describe('revealed behaviour, rolling twelve months', () => {
  it('a $40,000 one-off transfer is excluded and named, and does not move the monthly contribution rate', async () => {
    // $500 a month from checking into the brokerage since January 2025 — the
    // habit — and one $40,000 move from savings in March 2026: 09 E10's
    // house-deposit case. Both are paired transfers from a *cash* account, so
    // neither is an internal transfer; only the one-off rule can tell them apart.
    const habit = monthly(
      'habit',
      brokerage.accountId,
      '2025-01',
      20,
      15,
      '500.00',
      checking.accountId,
    );
    const houseDeposit = inflow({
      id: 'house-deposit',
      accountId: brokerage.accountId,
      date: '2026-03-20',
      amount: '40000.00',
      counterpart: savings.accountId,
      label: 'TRANSFER FROM HIGH-YIELD SAVINGS — HOUSE DEPOSIT',
    });
    const accounts = [checking, savings, brokerage];
    const withDeposit = await derive(ports(accounts, [...PAYROLL, ...habit, houseDeposit]));
    const without = await derive(ports(accounts, [...PAYROLL, ...habit]));

    const taxable = derived(withDeposit.contributions.byBucket.TAXABLE);
    expect(taxable.source).toBe('DERIVED');
    expect(Money.equals(taxable.monthly, usd('500.00'))).toBe(true);
    expect(Money.equals(taxable.annual, usd('6000.00'))).toBe(true);
    expect(taxable.observationCount).toBe(12);
    expect(taxable.window).toMatchObject({
      from: '2025-09-01',
      to: '2026-08-31',
      months: 12,
      monthsObserved: 12,
    });

    // Not moved: identical to the same year without the deposit, to the cent.
    const baseline = derived(without.contributions.byBucket.TAXABLE);
    expect(Money.equals(taxable.monthly, baseline.monthly)).toBe(true);
    expect(
      Money.equals(
        derived(withDeposit.contributions.total).monthly,
        derived(without.contributions.total).monthly,
      ),
    ).toBe(true);
    expect(withDeposit.savingsRate).toEqual(without.savingsRate);
    expect(withDeposit.contributions.oneOffTest.TAXABLE).toBe('applied');

    // Named: the row, the amount, the reason, and why in words.
    const named = withDeposit.exclusions.filter((e) => e.transactionId === 'house-deposit');
    expect(named).toHaveLength(1);
    const exclusion = named[0];
    expect(exclusion).toMatchObject({
      derivation: 'contributions',
      reason: 'one_off',
      date: '2026-03-20',
      accountId: brokerage.accountId,
      taxBucket: 'TAXABLE',
      label: 'TRANSFER FROM HIGH-YIELD SAVINGS — HOUSE DEPOSIT',
    });
    expect(Money.equals(exclusion?.amount ?? usd('0'), usd('40000.00'))).toBe(true);
    expect(exclusion?.explanation).toContain('40000.00 USD is more than 4× the median');
    expect(exclusion?.explanation).toContain('(500.00 USD)');
    expect(exclusion?.explanation).toContain('3σ above their mean');
    // And it is the only one-off: the twelve $500s are the habit, not outliers.
    expect(withDeposit.exclusions.filter((e) => e.reason === 'one_off')).toHaveLength(1);

    // What WP 4.1's DERIVED contribution plan would be written from.
    expect(derivedContributionPlan(taxable, day('2026-09-01'))).toMatchObject({
      cadence: 'monthly',
      source: 'DERIVED',
      derivedAsOf: '2026-08-31',
    });
  });

  it('an internal transfer never counts as a contribution', async () => {
    // Roth IRA: $500 a month from checking (contributions), plus one $500 in
    // May 2026 that Phase 1's pairing matched to an outflow from the *taxable
    // brokerage* — money already saved, changing wrappers. It is the same size
    // as every real contribution, so the one-off rule cannot be what removes it.
    const rothHabit = monthly(
      'roth',
      roth.accountId,
      '2025-01',
      20,
      10,
      '500.00',
      checking.accountId,
    );
    const wrapperMove = inflow({
      id: 'brokerage-to-roth',
      accountId: roth.accountId,
      date: '2026-05-12',
      amount: '500.00',
      counterpart: brokerage.accountId,
      label: 'TRANSFER FROM TAXABLE BROKERAGE',
    });
    // Workplace 401(k): $900 payroll deferrals, unpaired (they never touch checking).
    const deferrals = monthly('deferral', workplace.accountId, '2025-01', 20, 20, '900.00', null);
    // A $25,000 rollover from a former employer's plan into an IRA: paired, both
    // sides TAX_DEFERRED. Big enough to be a one-off too — the reason recorded
    // must be the internal transfer, which is checked first.
    const rolloverMove = inflow({
      id: 'old-401k-rollover',
      accountId: rollover.accountId,
      date: '2026-02-03',
      amount: '25000.00',
      counterpart: oldPlan.accountId,
      label: 'ROLLOVER FROM FORMER EMPLOYER 401K',
    });
    const accounts = [checking, brokerage, roth, workplace, oldPlan, rollover];
    const inflows = [...PAYROLL, ...rothHabit, wrapperMove, ...deferrals, rolloverMove];
    const result = await derive(ports(accounts, inflows));

    const rothAmount = derived(result.contributions.byBucket.ROTH);
    expect(rothAmount.observationCount).toBe(12);
    expect(Money.equals(rothAmount.annual, usd('6000.00'))).toBe(true);
    expect(Money.equals(rothAmount.monthly, usd('500.00'))).toBe(true);

    const deferred = derived(result.contributions.byBucket.TAX_DEFERRED);
    // Twelve deferrals; the rollover is not among them.
    expect(deferred.observationCount).toBe(12);
    expect(Money.equals(deferred.annual, usd('10800.00'))).toBe(true);

    const total = derived(result.contributions.total);
    expect(Money.equals(total.annual, usd('16800.00'))).toBe(true);

    const internal = result.exclusions.filter((e) => e.reason === 'internal_transfer');
    expect(internal.map((e) => e.transactionId).sort()).toEqual([
      'brokerage-to-roth',
      'old-401k-rollover',
    ]);
    const move = internal.find((e) => e.transactionId === 'brokerage-to-roth');
    expect(move).toMatchObject({ derivation: 'contributions', taxBucket: 'ROTH' });
    expect(move?.explanation).toContain('Taxable Brokerage (TAXABLE)');
    expect(move?.explanation).toContain('already saved');
    // The rollover is named as the internal transfer it is, not as a one-off.
    expect(result.exclusions.find((e) => e.transactionId === 'old-401k-rollover')?.reason).toBe(
      'internal_transfer',
    );

    // The control: the identical row paired with *checking* instead is a
    // contribution. The rule is about where the money came from, not about
    // whether the pairing matched it.
    const fromChecking = await derive(
      ports(accounts, [
        ...PAYROLL,
        ...rothHabit,
        { ...wrapperMove, transferCounterpartAccountId: checking.accountId },
        ...deferrals,
      ]),
    );
    expect(derived(fromChecking.contributions.byBucket.ROTH).observationCount).toBe(13);
  });

  it('four months of history returns insufficient_history and not an annualised number', async () => {
    // Accounts linked in May 2026: May, June, July and August are all the
    // ledger holds. $1,000 a month into the brokerage would annualise to
    // $12,000 — a confident number from a third of a year.
    const accounts = [checking, brokerage];
    const lines = (): readonly LineSpec[] => [
      { categoryId: 'rent', name: 'Rent', class: 'NEED', spend: '2000.00' },
      { categoryId: 'dining', name: 'Dining', class: 'WANT', spend: '300.00' },
    ];
    const fourMonths = [
      ...monthly('pay', checking.accountId, '2026-05', 4, 1, '6000.00', null),
      ...monthly('invest', brokerage.accountId, '2026-05', 4, 1, '1000.00', checking.accountId),
    ];
    const result = await derive(ports(accounts, fourMonths, monthlyPeriods('2026-05', 4, lines)));

    for (const answer of [
      result.contributions.total,
      result.contributions.byBucket.TAXABLE,
      result.income.takeHome,
      result.income.total,
      result.savingsRate,
      result.spending.essential,
      result.spending.discretionary,
      result.spending.nonSavings,
    ]) {
      expect(answer.status).toBe('insufficient_history');
      expect(answer.source).toBe('DERIVED');
      expect(answer.window.monthsObserved).toBe(4);
      // No amount to misread: the fields do not exist on this branch.
      expect('annual' in answer).toBe(false);
      expect('monthly' in answer).toBe(false);
      expect('rate' in answer).toBe(false);
      if (answer.status === 'insufficient_history') expect(answer.minimumMonths).toBe(6);
    }
    expect(result.contributions.total.observationCount).toBe(4);
    expect(
      derivedContributionPlan(result.contributions.byBucket.TAXABLE, day('2026-09-01')),
    ).toBeNull();

    // The control: the same habit observed for six months is a rate.
    const sixMonths = [
      ...monthly('pay', checking.accountId, '2026-03', 6, 1, '6000.00', null),
      ...monthly('invest', brokerage.accountId, '2026-03', 6, 1, '1000.00', checking.accountId),
    ];
    const enough = await derive(ports(accounts, sixMonths, monthlyPeriods('2026-03', 6, lines)));
    const rate = derived(enough.contributions.byBucket.TAXABLE);
    expect(rate.window.monthsObserved).toBe(6);
    expect(Money.equals(rate.total, usd('6000.00'))).toBe(true);
    expect(Money.equals(rate.monthly, usd('1000.00'))).toBe(true);
    expect(Money.equals(rate.annual, usd('12000.00'))).toBe(true);
  });

  it('essential spend comes from NEED-class categories and never from a total minus a guess', async () => {
    const lines = (): readonly LineSpec[] => [
      { categoryId: 'rent', name: 'Rent', class: 'NEED', spend: '2000.00' },
      { categoryId: 'groceries', name: 'Groceries', class: 'NEED', spend: '600.00' },
      { categoryId: 'dining', name: 'Dining', class: 'WANT', spend: '300.00' },
      // Nobody classified this one. It is neither essential nor discretionary.
      { categoryId: 'misc', name: 'Miscellaneous', class: null, spend: '150.00' },
      { categoryId: 'efund', name: 'Emergency fund', class: 'SAVINGS', spend: '100.00' },
    ];
    const periods = monthlyPeriods('2025-09', 12, lines);
    // A card-payment line moves money between two of the holder's own
    // accounts; it is not spending in any class.
    const withCard = periods.map((period) => ({
      ...period,
      lines: [
        ...period.lines,
        {
          id: `ccp-${period.id}`,
          kind: 'credit_card_payment' as const,
          categoryId: null,
          name: 'Rewards Visa payment',
          activity: Money.negate(usd('900.00')),
          class: null,
        },
      ],
    }));
    const result = await derive(ports([checking], PAYROLL, withCard));

    const essential = derived(result.spending.essential);
    expect(Money.equals(essential.total, usd('31200.00'))).toBe(true); // 12 × (2,000 + 600)
    expect(Money.equals(essential.annual, usd('31200.00'))).toBe(true);
    expect(Money.equals(essential.monthly, usd('2600.00'))).toBe(true);
    expect(essential.observationCount).toBe(24);
    expect(Money.equals(derived(result.spending.discretionary).annual, usd('3600.00'))).toBe(true);
    expect(Money.equals(derived(result.spending.unclassified).annual, usd('1800.00'))).toBe(true);
    const nonSavings = derived(result.spending.nonSavings);
    expect(Money.equals(nonSavings.annual, usd('36600.00'))).toBe(true);
    expect(Money.equals(derived(result.spending.savingsClass).annual, usd('1200.00'))).toBe(true);

    // "A total minus a guess" would be 36,600 − 3,600 = 33,000: the unclassified
    // $1,800 silently promoted to essential. It is not.
    const totalMinusDiscretionary = Money.subtract(
      nonSavings.annual,
      derived(result.spending.discretionary).annual,
    );
    expect(Money.equals(essential.annual, totalMinusDiscretionary)).toBe(false);
    expect(result.spending.categories.find((c) => c.categoryId === 'misc')).toMatchObject({
      class: null,
    });

    // With no category classified NEED there is no source for essential spend,
    // and the answer says so — never a default share of the total.
    const unclassified = monthlyPeriods('2025-09', 12, () =>
      lines().map((spec) => (spec.class === 'NEED' ? { ...spec, class: null } : spec)),
    );
    const none = await derive(ports([checking], PAYROLL, unclassified));
    expect(none.spending.essential.status).toBe('not_derivable');
    expect(none.spending.essential.source).toBe('DERIVED');
    if (none.spending.essential.status === 'not_derivable') {
      expect(none.spending.essential.reason).toContain('never a total minus a guess');
    }
    expect('annual' in none.spending.essential).toBe(false);
    // Discretionary and the non-savings total still derive; only the floor is missing.
    expect(Money.equals(derived(none.spending.nonSavings).annual, usd('36600.00'))).toBe(true);
  });
});

describe('every row the derivation sets aside is named', () => {
  it('names a user exclusion, a foreign-currency row, a refund and a part-month row, and counts none of them', async () => {
    // The brokerage's history begins mid-August 2025, so August is a part month:
    // the window's first whole observed month is September. Every habit row is a
    // plain $500 from checking; each of the four odd rows is set aside for its
    // own reason and would otherwise have counted.
    const habit = monthly(
      'habit',
      brokerage.accountId,
      '2025-09',
      12,
      15,
      '500.00',
      checking.accountId,
    );
    const odd = [
      inflow({
        id: 'excluded-by-holder',
        accountId: brokerage.accountId,
        date: '2025-11-03',
        amount: '500.00',
        counterpart: checking.accountId,
        userExcluded: true,
      }),
      inflow({
        id: 'in-euros',
        accountId: brokerage.accountId,
        date: '2026-01-07',
        amount: '500.00',
        currency: 'EUR',
        counterpart: checking.accountId,
      }),
      inflow({
        id: 'fee-refund',
        accountId: brokerage.accountId,
        date: '2026-02-09',
        amount: '500.00',
        isRefund: true,
      }),
    ];
    const historyStarts = new Map([
      [checking.accountId, day('2025-01-01')],
      [brokerage.accountId, day('2025-08-20')],
    ]);
    // One row inside the window's first month but before the brokerage's first
    // whole month cannot exist here (the window starts 2025-09-01), so the
    // part-month case is exercised on a later history start instead.
    const lateStart = new Map([
      [checking.accountId, day('2025-01-01')],
      [brokerage.accountId, day('2025-09-10')],
    ]);
    const result = await derive(
      ports([checking, brokerage], [...PAYROLL, ...habit, ...odd], [], historyStarts),
    );
    const taxable = derived(result.contributions.byBucket.TAXABLE);
    expect(taxable.observationCount).toBe(12);
    expect(Money.equals(taxable.total, usd('6000.00'))).toBe(true);
    const reasons = Object.fromEntries(
      result.exclusions
        .filter((e) => e.derivation === 'contributions')
        .map((e) => [e.transactionId, e.reason]),
    );
    expect(reasons).toEqual({
      'excluded-by-holder': 'user_excluded',
      'in-euros': 'currency_mismatch',
      'fee-refund': 'refund',
    });
    expect(result.exclusions.find((e) => e.transactionId === 'in-euros')?.explanation).toContain(
      'rather than converted at a guessed rate',
    );

    // History from 2025-09-10: September is a part month, so the habit's
    // 2025-09-15 row is named `partial_month` and eleven months are observed.
    const partial = await derive(
      ports([checking, brokerage], [...PAYROLL, ...habit], [], lateStart),
    );
    const eleven = derived(partial.contributions.byBucket.TAXABLE);
    expect(eleven.window.monthsObserved).toBe(11);
    expect(eleven.window.observedFrom).toBe('2025-10-01');
    expect(eleven.observationCount).toBe(11);
    expect(Money.equals(eleven.annual, usd('6000.00'))).toBe(true); // 5,500 × 12 / 11
    expect(partial.exclusions.find((e) => e.transactionId === 'habit-2025-09')?.reason).toBe(
      'partial_month',
    );
  });
});
