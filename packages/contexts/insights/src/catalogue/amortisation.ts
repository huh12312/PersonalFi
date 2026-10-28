// SPDX-License-Identifier: MIT
/**
 * The payoff schedule D1 never had (WP 11.5b; 07 §3.3 D1, 12 §2.1's
 * `debt.payoff_plan`). WP 11.5a found that the debt built-in states the
 * ordering fact and withholds the months and the interest, because "a
 * repayment schedule is not arithmetic it can show" through the derivation
 * grammar. This is that arithmetic, done once, deterministically, in integer
 * cents, so the catalogue can show it with its inputs.
 *
 * ## The method, month by month
 *
 *   1. **Interest accrues** on every open balance at its rate for the month:
 *      `balance × APR ÷ 12`, rounded half-even to the cent (a promotional rate
 *      applies to a month that starts before the promotion ends). Exact: the
 *      rate is a decimal string, the balance integer minor units, and the one
 *      division is an integer division with its remainder rounded — no float.
 *   2. **Every open debt gets its minimum** (or its whole balance, if smaller).
 *   3. **What is left of the monthly budget goes to one debt at a time**, in
 *      the chosen order: the first open debt takes all of it, and whatever that
 *      debt does not need flows to the next in the same month.
 *
 * The monthly budget is fixed for the whole schedule at **the sum of every
 * included debt's minimum, plus the extra**. That is the **rollover**: when a
 * debt is cleared, the minimum it no longer needs stays in the budget and goes
 * to the next debt in line, which is what makes the snowball and the avalanche
 * accelerate. A schedule that lets the freed minimum leave the budget is a
 * different (and slower) plan, and the reference cases in
 * `test/catalogue-amortisation.test.ts` would show it.
 *
 * A schedule still open after `MAX_SCHEDULE_MONTHS` (fifty years) is reported
 * `not_paid_off` — a minimum below the interest it accrues never clears, and
 * the honest answer is that, not a number.
 */

/** Fifty years. A schedule that has not cleared by then is not a payoff plan. */
export const MAX_SCHEDULE_MONTHS = 600;

export interface AmortisedDebt {
  /** The snapshot's `liability_ref`. */
  readonly ref: string;
  readonly balanceMinor: bigint;
  /** The APR as a decimal string ratio: `'0.2399'` is 23.99%. */
  readonly apr: string;
  /** A promotional APR in force until `endDate` (exclusive), when one is. */
  readonly promo: { readonly apr: string; readonly endDate: string } | null;
  readonly minimumMinor: bigint;
}

export interface DebtPayoff {
  readonly ref: string;
  /** 1-based month of the schedule in which the balance reached zero; `null` if it never did. */
  readonly payoffMonthIndex: number | null;
  readonly interestMinor: bigint;
}

export interface AmortisationResult {
  readonly status: 'paid_off' | 'not_paid_off';
  /** Months until the last balance cleared; `null` when it did not within the horizon. */
  readonly months: number | null;
  readonly totalInterestMinor: bigint;
  readonly totalPaidMinor: bigint;
  /** The fixed monthly budget: Σ minimums + extra. */
  readonly monthlyBudgetMinor: bigint;
  readonly debts: readonly DebtPayoff[];
}

const RATE = /^(\d{1,3})(?:\.(\d{1,12}))?$/;

/** `balance × rate ÷ 12`, half-even to the minor unit. `rate` is a non-negative decimal string. */
export function monthlyInterestMinor(balanceMinor: bigint, rate: string): bigint {
  const match = RATE.exec(rate);
  if (match === null) throw new Error(`not a rate: ${JSON.stringify(rate)}`);
  const [, whole = '0', fraction = ''] = match;
  const unscaled = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length) * 12n;
  const numerator = balanceMinor * unscaled;
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** `YYYY-MM-DD` of the first day of the month `index` months after `startMonth` (`YYYY-MM`). */
export function monthStart(startMonth: string, index: number): string {
  const [year = '0', month = '1'] = startMonth.split('-');
  const zeroBased = Number.parseInt(year, 10) * 12 + (Number.parseInt(month, 10) - 1) + index;
  const y = Math.floor(zeroBased / 12);
  const m = (zeroBased % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

function rateFor(debt: AmortisedDebt, firstDay: string): string {
  if (debt.promo !== null && firstDay < debt.promo.endDate) return debt.promo.apr;
  return debt.apr;
}

/**
 * Run the schedule. `order` is the priority the extra goes in (refs; every
 * debt must appear once). `startMonth` is the as-of month (`YYYY-MM`); month 1
 * of the schedule is the month after it.
 */
export function amortise(input: {
  readonly debts: readonly AmortisedDebt[];
  readonly extraMinor: bigint;
  readonly order: readonly string[];
  readonly startMonth: string;
}): AmortisationResult {
  if (input.extraMinor < 0n) throw new Error('the extra payment cannot be negative');
  const byRef = new Map(input.debts.map((debt) => [debt.ref, debt]));
  if (input.order.length !== input.debts.length || input.order.some((ref) => !byRef.has(ref))) {
    throw new Error('the payoff order must name every debt exactly once');
  }
  const balance = new Map(input.debts.map((debt) => [debt.ref, debt.balanceMinor]));
  const interest = new Map(input.debts.map((debt) => [debt.ref, 0n]));
  const payoff = new Map<string, number | null>(input.debts.map((debt) => [debt.ref, null]));
  let totalInterest = 0n;
  let totalPaid = 0n;

  // The rollover: fixed at the start, never reduced when a debt clears.
  let monthlyBudget = input.extraMinor;
  for (const debt of input.debts) monthlyBudget += debt.minimumMinor;

  const open = (): boolean => [...balance.values()].some((minor) => minor > 0n);
  if (!open()) {
    return {
      status: 'paid_off',
      months: 0,
      totalInterestMinor: 0n,
      totalPaidMinor: 0n,
      monthlyBudgetMinor: monthlyBudget,
      debts: input.debts.map((debt) => ({ ref: debt.ref, payoffMonthIndex: 0, interestMinor: 0n })),
    };
  }

  for (let month = 1; month <= MAX_SCHEDULE_MONTHS; month += 1) {
    const firstDay = monthStart(input.startMonth, month);
    // 1. Interest.
    for (const debt of input.debts) {
      const owed = balance.get(debt.ref) ?? 0n;
      if (owed <= 0n) continue;
      const accrued = monthlyInterestMinor(owed, rateFor(debt, firstDay));
      balance.set(debt.ref, owed + accrued);
      interest.set(debt.ref, (interest.get(debt.ref) ?? 0n) + accrued);
      totalInterest += accrued;
    }
    // 2. Every minimum.
    let pool = monthlyBudget;
    for (const debt of input.debts) {
      const owed = balance.get(debt.ref) ?? 0n;
      if (owed <= 0n) continue;
      const paid = debt.minimumMinor < owed ? debt.minimumMinor : owed;
      balance.set(debt.ref, owed - paid);
      pool -= paid;
      totalPaid += paid;
    }
    // 3. The rest, one debt at a time, in the chosen order.
    for (const ref of input.order) {
      if (pool <= 0n) break;
      const owed = balance.get(ref) ?? 0n;
      if (owed <= 0n) continue;
      const paid = pool < owed ? pool : owed;
      balance.set(ref, owed - paid);
      pool -= paid;
      totalPaid += paid;
    }
    for (const debt of input.debts) {
      if (payoff.get(debt.ref) === null && (balance.get(debt.ref) ?? 0n) <= 0n) {
        payoff.set(debt.ref, month);
      }
    }
    if (!open()) {
      return {
        status: 'paid_off',
        months: month,
        totalInterestMinor: totalInterest,
        totalPaidMinor: totalPaid,
        monthlyBudgetMinor: monthlyBudget,
        debts: input.debts.map((debt) => ({
          ref: debt.ref,
          payoffMonthIndex: payoff.get(debt.ref) ?? null,
          interestMinor: interest.get(debt.ref) ?? 0n,
        })),
      };
    }
  }
  return {
    status: 'not_paid_off',
    months: null,
    totalInterestMinor: totalInterest,
    totalPaidMinor: totalPaid,
    monthlyBudgetMinor: monthlyBudget,
    debts: input.debts.map((debt) => ({
      ref: debt.ref,
      payoffMonthIndex: payoff.get(debt.ref) ?? null,
      interestMinor: interest.get(debt.ref) ?? 0n,
    })),
  };
}

function compareRates(left: string, right: string): number {
  // Both are non-negative decimal strings; compare exactly by padding the fractions.
  const [lw = '0', lf = ''] = left.split('.');
  const [rw = '0', rf = ''] = right.split('.');
  const width = Math.max(lf.length, rf.length);
  const l = BigInt(`${lw}${lf.padEnd(width, '0')}`);
  const r = BigInt(`${rw}${rf.padEnd(width, '0')}`);
  return l === r ? 0 : l > r ? 1 : -1;
}

/** Highest APR first; on a tie the smaller balance, then the input order. */
export function avalancheOrder(debts: readonly AmortisedDebt[]): readonly string[] {
  return debts
    .map((debt, index) => ({ debt, index }))
    .sort(
      (a, b) =>
        -compareRates(a.debt.apr, b.debt.apr) ||
        (a.debt.balanceMinor === b.debt.balanceMinor
          ? 0
          : a.debt.balanceMinor < b.debt.balanceMinor
            ? -1
            : 1) ||
        a.index - b.index,
    )
    .map((row) => row.debt.ref);
}

/** Smallest balance first; on a tie the higher APR, then the input order. */
export function snowballOrder(debts: readonly AmortisedDebt[]): readonly string[] {
  return debts
    .map((debt, index) => ({ debt, index }))
    .sort(
      (a, b) =>
        (a.debt.balanceMinor === b.debt.balanceMinor
          ? 0
          : a.debt.balanceMinor < b.debt.balanceMinor
            ? -1
            : 1) ||
        -compareRates(a.debt.apr, b.debt.apr) ||
        a.index - b.index,
    )
    .map((row) => row.debt.ref);
}
