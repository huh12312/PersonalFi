// SPDX-License-Identifier: MIT
/**
 * `activity(c, p)` — the one place in the app where a budget total is computed.
 *
 * 07 §1.2 line 60 defines it in one line:
 *
 * ```
 * activity(c, p) = Σ txn.amount WHERE category=c AND budget_date ∈ p   # outflows negative
 * ```
 *
 * and the v0.8 rung (dispatch §1) adds the two exclusions: **budgets exclude
 * transfers and net refunds.** Both are applied here and nowhere else. A rule
 * applied in two places is a rule applied inconsistently in one of them, and the
 * shape that keeps recurring in this project's gates is a control computed on
 * the half somebody was looking at and hardcoded on the half they were not.
 *
 * ## Excluded versus netted — not the same operation
 *
 * * A **transfer** is *excluded*: both legs are dropped and contribute zero.
 *   Dropping both rather than relying on them to cancel is what makes it exact
 *   across a pair whose legs differ — an FX conversion, a wire fee taken out of
 *   the receiving leg, a card payment that posts a day apart. 07 §1.3 line 120
 *   states the card-payment case directly: "balances move naturally via the
 *   transfer; no category activity".
 * * A **refund** is *netted*: it stays in the sum with its own sign, so a $40
 *   refund of a $100 purchase leaves $60 of activity in the envelope. That is
 *   arithmetic the signed convention does for free — the work is making sure the
 *   refund lands in the **same envelope as the purchase it reverses**, which is
 *   the part that goes wrong. A refund the categoriser left uncategorised, or
 *   put in "Income", nets against nothing and leaves the envelope showing $100
 *   of spending that was $60.
 *
 * `transferExcludedCount` and `refundNettedCount` are recorded per line so that
 * both are *observable* rather than merely claimed: a month with a card payment
 * in it that reports "0 transfers excluded" is a bug with a visible symptom
 * instead of a total that is quietly wrong.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { EnvelopeTransaction } from './envelope.ts';
import type { BudgetAccount, BudgetTransaction } from './ledger-port.ts';

export interface ActualsInput {
  /** Every row in `[startDate, endDate)`, unfiltered. */
  readonly transactions: readonly BudgetTransaction[];
  readonly accounts: readonly BudgetAccount[];
  /**
   * The purchase each refund reverses, when it lies *outside* this period.
   *
   * A refund almost always posts later than its purchase and frequently in the
   * next period. Netting it against the envelope the purchase was in would
   * rewrite a closed period; netting it against nothing would lose it. So it
   * nets into the refund's *own* period, against the *purchase's* envelope —
   * which is why this map exists and is passed in by the caller, who can see
   * across periods and this function cannot.
   */
  readonly categoryOfPurchase: ReadonlyMap<string, string | null>;
  readonly currency: string;
}

export interface LineActivity {
  /** `null` is the uncategorised envelope — real money with no envelope yet. */
  readonly categoryId: string | null;
  readonly transactions: readonly EnvelopeTransaction[];
  readonly transactionCount: number;
  readonly transferExcludedCount: number;
  readonly refundNettedCount: number;
  readonly refund: MoneyType;
}

export interface ActualsResult {
  readonly byCategory: ReadonlyMap<string | null, LineActivity>;
  /**
   * Signed transfer-leg totals per credit account: the statement payments that
   * feed `CCP[card].payments`. Positive = the card balance went down.
   */
  readonly cardPayments: ReadonlyMap<string, MoneyType>;
  /** On-budget inflows, transfers excluded. `PCT_OF_INCOME`'s denominator only. */
  readonly income: MoneyType;
  readonly transferExcludedCount: number;
}

/**
 * Split a period's rows into per-envelope activity.
 *
 * Returns *transactions*, not sums, because 07 §1.3's funding rule is
 * order-dependent — `fundable = min(|amt|, max(0, available))` reads the
 * envelope as it stands when each row lands — so `runEnvelope` has to see them
 * individually. A pre-summed `activity` would produce the right `available` and
 * the wrong cash/credit split, which is the half of §1.3 that decides whether
 * the user sees red or yellow.
 */
export function computeActuals(input: ActualsInput): ActualsResult {
  const zero = Money.zero(input.currency);
  const roleOf = new Map(input.accounts.map((account) => [account.id, account] as const));

  const byCategory = new Map<
    string | null,
    {
      categoryId: string | null;
      transactions: EnvelopeTransaction[];
      transactionCount: number;
      transferExcludedCount: number;
      refundNettedCount: number;
      refund: MoneyType;
    }
  >();
  const cardPayments = new Map<string, MoneyType>();
  let income = zero;
  let transferExcludedCount = 0;

  const bucket = (categoryId: string | null) => {
    const existing = byCategory.get(categoryId);
    if (existing !== undefined) return existing;
    const fresh = {
      categoryId,
      transactions: [] as EnvelopeTransaction[],
      transactionCount: 0,
      transferExcludedCount: 0,
      refundNettedCount: 0,
      refund: zero,
    };
    byCategory.set(categoryId, fresh);
    return fresh;
  };

  for (const row of input.transactions) {
    const account = roleOf.get(row.accountId);
    // An account the budget does not consider on-budget contributes nothing to
    // any envelope, and neither does a row the user explicitly excluded.
    if (account === undefined || account.role === 'OFF_BUDGET' || row.excluded) continue;

    // --- transfers: excluded, both legs, counted ---------------------------
    //
    // `transferLinkId` is the paired case and the strong one. `isTransfer`
    // without a pair is `@ctx/ledger`'s own flag — the provider said so, or the
    // user did — and excluding it too is the conservative reading of "budgets
    // exclude transfers": an unpaired leg included in a total is a phantom
    // expense or a phantom paycheque, and both are worse than a total that is
    // missing a movement between accounts the user owns.
    if (row.transferLinkId !== null || row.isTransfer) {
      transferExcludedCount += 1;
      bucket(resolveCategory(row, input.categoryOfPurchase)).transferExcludedCount += 1;
      if (account.role === 'CREDIT') {
        cardPayments.set(
          row.accountId,
          Money.add(cardPayments.get(row.accountId) ?? zero, row.amount),
        );
      }
      continue;
    }

    const categoryId = resolveCategory(row, input.categoryOfPurchase);
    const target = bucket(categoryId);
    target.transactions.push({
      id: row.id,
      budgetDate: row.budgetDate,
      amount: row.amount,
      funding: row.funding,
      creditAccountId: account.role === 'CREDIT' ? row.accountId : null,
    });
    target.transactionCount += 1;
    if (row.refundOfId !== null) {
      target.refundNettedCount += 1;
      target.refund = Money.add(target.refund, Money.absolute(row.amount));
    }
    if (Money.isPositive(row.amount) && row.refundOfId === null) {
      income = Money.add(income, row.amount);
    }
  }

  return {
    byCategory: new Map(
      [...byCategory.entries()].map(([key, value]) => [
        key,
        {
          categoryId: value.categoryId,
          transactions: value.transactions,
          transactionCount: value.transactionCount,
          transferExcludedCount: value.transferExcludedCount,
          refundNettedCount: value.refundNettedCount,
          refund: value.refund,
        },
      ]),
    ),
    cardPayments,
    income,
    transferExcludedCount,
  };
}

/**
 * Which envelope a row belongs in.
 *
 * Its own effective category, unless it is a refund with none — in which case it
 * inherits the envelope of the purchase it reverses, so that the netting lands
 * where the spending did. A refund of an uncategorised purchase stays
 * uncategorised, which is honest: there is no envelope to net against yet, and
 * categorising the purchase later will move both through the dirty cascade.
 */
function resolveCategory(
  row: BudgetTransaction,
  categoryOfPurchase: ReadonlyMap<string, string | null>,
): string | null {
  if (row.categoryId !== null) return row.categoryId;
  if (row.refundOfId === null) return null;
  return categoryOfPurchase.get(row.refundOfId) ?? null;
}
