// SPDX-License-Identifier: MIT
/**
 * The debt family, in 07 §3.3 order. **All six ship.**
 *
 * `liabilities.terms` is the one block that unblocked the whole family at once
 * — every reason WP 2.7 gave for leaving U8, C5, C6 and D1–D6 unwritten named
 * the same three fields, an APR, a credit limit and a statement balance, and
 * this scope is them.
 *
 * Three of the six carry no dollar figure, and each refusal has the same shape:
 * 07's formula needs a **repayment schedule**, which is a loop, and the
 * derivation grammar cannot express one. D1's avalanche-versus-snowball
 * comparison and D3's payoff time both land there; D5's is different — its
 * missing term is a forecast, and forecasts are forbidden rather than merely
 * inexpressible. What each would need is recorded in the evidence doc.
 *
 * | Rule | Claims a figure | What it needs that it does not have |
 * | --- | --- | --- |
 * | D1 payoff order | no | a repayment schedule the validator could replay |
 * | D2 rate above market | **yes** | — |
 * | D3 minimum only | no | the same schedule |
 * | D4 promo ending | **yes** | — |
 * | D5 principal vs market | no | an expected-return assumption, which is a forecast |
 * | D6 missed payment | no | the lender's late fee |
 *
 * **U8, C5 and C6 are now unblocked and are not implemented here.** They are
 * cash and subscription rules, this work package's brief is the I, D and X
 * families, and writing them would be a different wave's release decision.
 * `CATALOGUE_GAPS` is updated to say "unblocked, not yet written" rather than
 * continuing to claim the data does not exist, because that claim is no longer
 * true and a stale gap reason is worse than none.
 */
import type { BuiltinRule } from '../../support.ts';
import { debtMinimumOnly, debtMissedPayment } from './payments.ts';
import { debtPayoffOrder, debtPrincipalAgainstMarket } from './payoff.ts';
import { debtPromoEnding, debtRateAboveMarket } from './rates.ts';

export { debtMinimumOnly, debtMissedPayment } from './payments.ts';
export { debtPayoffOrder, debtPrincipalAgainstMarket } from './payoff.ts';
export { debtPromoEnding, debtRateAboveMarket } from './rates.ts';
export { isRevolving, kindLabel } from './labels.ts';

/** In 07 §3.3 order: D1, D2, D3, D4, D5, D6. */
export const DEBT_RULES: readonly BuiltinRule[] = Object.freeze([
  debtPayoffOrder,
  debtRateAboveMarket,
  debtMinimumOnly,
  debtPromoEnding,
  debtPrincipalAgainstMarket,
  debtMissedPayment,
]);
