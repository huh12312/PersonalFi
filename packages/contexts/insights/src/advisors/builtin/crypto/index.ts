// SPDX-License-Identifier: MIT
/**
 * The crypto family, in 07 §3.3 order. **Five of six ship.**
 *
 * | Rule | Ships | Why |
 * | --- | --- | --- |
 * | X1 share of net worth | yes, P0 | `holdings.aggregate` + `networth.summary` |
 * | X2 exchange custody | yes | the custody split, with no venue named |
 * | X3 idle stablecoins | yes | `holdings.detail` + `market.rates` |
 * | X4 staking receipts | **no** | needs wallet transactions: a receipt, its date and its value at receipt |
 * | X5 lot at a loss | yes | per-lot unrealised P&L |
 * | X6 missing basis | yes | `basis_known` on the position |
 *
 * X4 is the only gap and it is a clean one: it needs an *inflow event*, and
 * every scope in this work package's brief describes a **position**, not a
 * movement. `holdings.detail` could say a lot exists; it cannot say the lot
 * arrived as a staking reward rather than a purchase, and that distinction is
 * the entire rule. `CATALOGUE_GAPS` records the field.
 */
import type { BuiltinRule } from '../../support.ts';
import { cryptoExchangeCustody, cryptoNetWorthShare } from './exposure.ts';
import { cryptoIdleStablecoins, cryptoLossLot, cryptoMissingBasis } from './positions.ts';

export { cryptoExchangeCustody, cryptoNetWorthShare } from './exposure.ts';
export { cryptoIdleStablecoins, cryptoLossLot, cryptoMissingBasis } from './positions.ts';

/** In 07 §3.3 order: X1, X2, X3, X5, X6. */
export const CRYPTO_RULES: readonly BuiltinRule[] = Object.freeze([
  cryptoNetWorthShare,
  cryptoExchangeCustody,
  cryptoIdleStablecoins,
  cryptoLossLot,
  cryptoMissingBasis,
]);
