// SPDX-License-Identifier: MIT
/**
 * Ready to Assign — 07 §1.2, and a correction to it.
 *
 * ## What the memo says
 *
 * 07 §1.2 lines 73–80:
 *
 * > **Ready to Assign (RTA)** — the "to be budgeted" number. Do not compute it
 * > by summing income; that drifts. Compute it from the balance-sheet identity:
 * >
 * > ```
 * > RTA(p) = Σ_a balance(a)                   # a ∈ on-budget accounts; credit balances are negative
 * >        − Σ_c available(c, p)              # includes credit-card payment categories
 * >        − Σ_{p' > p} Σ_c assigned(c, p')   # money pre-assigned to future periods
 * > ```
 *
 * and lines 82–88:
 *
 * > **Invariant to assert in tests (this is the single most valuable test in the
 * > budgeting module):**
 * >
 * > ```
 * > Σ_c available(c, p) + RTA(p) + future_assignments == Σ_a balance(a)   for all p
 * > ```
 * >
 * > If that identity breaks, a rollover or credit-card rule is wrong. Assert it
 * > after every mutation in dev.
 *
 * The "do not sum income" instruction is taken literally and is the reason
 * `budget_periods.income_minor` exists but is *not* an input here: income is
 * needed for `PCT_OF_INCOME` goals and the 50/30/20 layer, and for nothing else.
 *
 * ## The correction: which categories the sum is over
 *
 * The memo's two inline annotations contradict each other, and the contradiction
 * is worth a paragraph because it is exactly the sort of thing that would be
 * discovered six months later as "the budget is off by the size of one credit
 * card".
 *
 * Take a household with $100 in checking, nothing on the card, $80 assigned to
 * Groceries and $20 unassigned. `Σ balance = 100`, `Σ available = 80`,
 * `RTA = 20`, and `80 + 20 = 100`. The identity holds.
 *
 * Now put $50 of groceries on the credit card. 07 §1.3's funding rule moves $50
 * out of Groceries and $50 into `CCP[card]`; the card's balance becomes −$50.
 * Nothing about the household changed except which piece of plastic was used, so
 * RTA must still be $20. But with **both** annotations applied —
 * credit balances in `Σ balance`, CCP envelopes in `Σ available` —
 *
 * ```
 * Σ balance  = 100 + (−50) = 50
 * Σ available = 30 (Groceries) + 50 (CCP) = 80
 * RTA        = 50 − 80 = −30
 * ```
 *
 * The $50 is booked twice: once as a debt on the card, once as cash earmarked in
 * the CCP envelope. Dropping *either* annotation fixes it, and they are not
 * equivalent — dropping the credit balance gives a cash-only identity that needs
 * an extra "outstanding credit overspend" term to close, while dropping CCP from
 * the left keeps the memo's right-hand side exactly as written. So:
 *
 * ```
 * RTA(p) = Σ_{a ∈ on-budget} balance(a)              # credit balances negative
 *        − Σ_{c : kind = 'category'} available(c, p) # CCP lines excluded
 *        − Σ_{p' > p} Σ_c assigned(c, p')
 * ```
 *
 * The CCP envelopes are not unaccounted for — they are pinned by identity II in
 * `src/credit.ts`, against the card's own balance. Worked in full, with the
 * algebra that shows the two forms are equivalent, in
 * `docs/evidence/phase-2/wp2.1-budgeting.md` §1.5.
 *
 * ## What this buys, for free
 *
 * 07 §1.3 line 99 says `RTA(p+1) -= |cash_overspend(p)|` at the roll. Under this
 * definition nobody has to do that. A cash-overspent envelope carries 0 forward
 * (`ROLLOVER`), so `Σ available` is higher next period by exactly the overspend
 * that was discarded, so RTA is lower by exactly that amount. The subtraction
 * falls out of the identity; applying it *as well* would double-count it, which
 * is why `rollovers.absorbed_by_rta_minor` is described in the migration as
 * "recorded, not applied".
 */
import { Money, type Money as MoneyType } from '@core/kernel';

export interface ReadyToAssignInput {
  /**
   * Working balances of every on-budget account, house sign convention: a credit
   * card you owe $50 on contributes −5000 minor units.
   *
   * 07 §1.4 rule 3: "RTA uses `working_balance`" — every observation, pending
   * included — not the cleared balance. An envelope that ignores a pending
   * charge lies to you for the two or three days when you are most likely to
   * overspend.
   */
  readonly onBudgetBalances: readonly MoneyType[];
  /** `available` for every line of period `p` **with `kind = 'category'`**. */
  readonly categoryAvailable: readonly MoneyType[];
  /** `assigned` on every line of every period after `p`. */
  readonly futureAssignments: readonly MoneyType[];
  readonly currency: string;
}

export function readyToAssign(input: ReadyToAssignInput): MoneyType {
  const balances = Money.sum(input.onBudgetBalances, input.currency);
  const available = Money.sum(input.categoryAvailable, input.currency);
  const future = Money.sum(input.futureAssignments, input.currency);
  return Money.subtract(Money.subtract(balances, available), future);
}

/**
 * The invariant, as a predicate, so the service can assert it after every
 * mutation and the test can assert it from independently read terms.
 *
 * Deliberately *not* implemented as `readyToAssign(...) === rta`: that would be
 * a tautology dressed as a check. The value is in the caller passing an `rta`
 * that was persisted at some earlier moment and balances that were read from the
 * ledger just now — which is what catches a dirty-flag cascade that failed to
 * fire, the failure mode 07 §1.4 rule 6 exists to warn about.
 */
export function identityHolds(input: ReadyToAssignInput, rta: MoneyType): boolean {
  const left = Money.add(
    Money.add(Money.sum(input.categoryAvailable, input.currency), rta),
    Money.sum(input.futureAssignments, input.currency),
  );
  return Money.equals(left, Money.sum(input.onBudgetBalances, input.currency));
}
