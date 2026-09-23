// SPDX-License-Identifier: MIT
/**
 * The investing family, in 07 §3.3 order.
 *
 * **I1–I6 ship. I7–I10 do not**, and the difference is data rather than
 * effort — each of the four names a field that does not exist in any scope
 * this work package was given, and each is recorded in `CATALOGUE_GAPS` with
 * that field so "we forgot I9" and "I9 cannot be written from Phase 3 data"
 * stay distinguishable a year from now.
 *
 * | Rule | Ships | Why |
 * | --- | --- | --- |
 * | I1 drift | yes | `holdings.aggregate` carries weights, targets and coverage |
 * | I2 expense ratio | yes | `holdings.detail` carries the ratio and its comparable |
 * | I3 idle brokerage cash | yes | `holdings.aggregate.idle_cash`, pre-triggered |
 * | I4 concentration | yes | top positions by weight |
 * | I5 employer stock | yes | the user's own `employer_stock` tag |
 * | I6 loss lot | yes | per-lot unrealised P&L in a taxable account |
 * | I7 wash sale | **no** | needs disposals, and needs *every* account including IRAs |
 * | I8 401(k) match | **no** | needs payroll contributions and the plan's match terms |
 * | I9 IRA headroom | **no** | needs contributions to date and a MAGI test |
 * | I10 HSA headroom | **no** | needs an HDHP enrolment flag and contributions to date |
 *
 * I10 is marked P0 in the dispatch. It is a gap here, and that conflict is
 * stated in the evidence doc rather than resolved by writing a rule over data
 * that is not there.
 */
import type { BuiltinRule } from '../../support.ts';
import { investingDrift } from './allocation.ts';
import { investingConcentration, investingEmployerStock } from './concentration.ts';
import { investingExpenseRatio, investingIdleCash } from './costs.ts';
import { investingLossLot } from './lots.ts';

export { investingDrift } from './allocation.ts';
export { investingConcentration, investingEmployerStock } from './concentration.ts';
export { investingExpenseRatio, investingIdleCash } from './costs.ts';
export { investingLossLot } from './lots.ts';

/** In 07 §3.3 order: I1, I2, I3, I4, I5, I6. */
export const INVESTING_RULES: readonly BuiltinRule[] = Object.freeze([
  investingDrift,
  investingExpenseRatio,
  investingIdleCash,
  investingConcentration,
  investingEmployerStock,
  investingLossLot,
]);
