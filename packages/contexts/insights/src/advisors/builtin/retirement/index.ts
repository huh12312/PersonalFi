// SPDX-License-Identifier: MIT
/**
 * The retirement & goals family, in 07 §3.3 order — WP 4.9, and 07 §7.4's
 * week-four wave. **Six of seven ship; R5 is a gap.**
 *
 * | Rule | Reads | Claims a figure | Why not, when not |
 * | --- | --- | --- | --- |
 * | R1 savings rate below the plan's | `plan.projection` | no | the gap is in points; no income crosses |
 * | R2 success below target | `plan.projection` | no | probability points, never dollars (dispatch) |
 * | R3 RMD conversion window | `plan.projection` | no | a conversion's value is a forecast |
 * | R4 claiming at seventy | `plan.projection` | no | PV needs a discount rate and a lifespan |
 * | R5 402(g) true-up trap | — | — | **gap**: no YTD deferral, cadence or plan terms (§6 Q4) |
 * | R6 goal pace | `goals.list` | **yes** | — |
 * | R7 withdrawal guardrail | `plan.projection` | no | Δspend is a spending change, not a saving |
 *
 * `test/no-compounding.test.ts` holds the whole family to 07 §3.2: no
 * derivation here has a rate of return in it, and none reads the projected
 * band.
 */
import type { BuiltinRule } from '../../support.ts';
import { retirementClaimingAge } from './claiming.ts';
import { retirementGoalPace } from './goals.ts';
import { retirementWithdrawalGuardrail } from './guardrail.ts';
import { retirementRmdWindow } from './rmd.ts';
import { retirementSavingsRate } from './savings.ts';
import { retirementSuccessProbability } from './success.ts';

export { retirementClaimingAge } from './claiming.ts';
export { retirementGoalPace } from './goals.ts';
export { retirementWithdrawalGuardrail } from './guardrail.ts';
export { retirementRmdWindow } from './rmd.ts';
export { retirementSavingsRate } from './savings.ts';
export { retirementSuccessProbability } from './success.ts';
export { ADVISORY_DISCLAIMER } from './shared.ts';

/** In 07 §3.3 order: R1, R2, R3, R4, R6, R7. R5 is `CATALOGUE_GAPS`'. */
export const RETIREMENT_RULES: readonly BuiltinRule[] = Object.freeze([
  retirementSavingsRate,
  retirementSuccessProbability,
  retirementRmdWindow,
  retirementClaimingAge,
  retirementGoalPace,
  retirementWithdrawalGuardrail,
]);
