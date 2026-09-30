// SPDX-License-Identifier: MIT
/**
 * The anomaly wave: S1, S5 and the fee hunter (S7's fuller successor), all
 * reading the two scopes WP 5.7 added — `transactions.anomalies` and
 * `fees.summary`. In 07 §3.3 order.
 */
import type { BuiltinRule } from '../../support.ts';
import { spendingCategoryAnomaly, spendingNewMerchantHighCharge } from './anomaly.ts';
import { spendingFeeHunter } from './fees.ts';

export { spendingCategoryAnomaly, spendingNewMerchantHighCharge } from './anomaly.ts';
export { spendingFeeHunter } from './fees.ts';

/** S1, S5, S7 (the fee hunter). */
export const ANOMALY_RULES: readonly BuiltinRule[] = Object.freeze([
  spendingCategoryAnomaly,
  spendingNewMerchantHighCharge,
  spendingFeeHunter,
]);
