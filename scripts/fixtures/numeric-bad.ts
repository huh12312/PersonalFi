// SPDX-License-Identifier: MIT
/**
 * A fixture that must FAIL `scripts/check-numeric-boundaries.ts`.
 *
 * Every declaration below is a way a float has actually reached a monetary or
 * quantity boundary in a real codebase, written out so the check is observed
 * catching each one rather than asserted to. This file is never imported by
 * anything that runs: it is input to the check's own `--self-test`, and it is
 * deliberately **outside** the scanned tree (`packages/**`, `apps/api/src/**`)
 * so it cannot poison the real run.
 *
 * It still typechecks and lints, on purpose — a fixture that `tsc` rejects
 * would prove the compiler catches this, which it does not.
 */

/** 1. The canonical case, and the exit test's name: a float assigned to a price. */
export const price = 268.4;

/** 2. A property typed `number` on an interface — the 08 §6.5 rule, verbatim. */
export interface BadHolding {
  readonly quantity: number;
  readonly costBasis: number | null;
  readonly marketValue: number;
}

/** 3. A parameter. The boundary a caller crosses. */
export function creditAccount(balanceMinor: number): string {
  return String(balanceMinor);
}

/** 4. An object literal with a float where a price goes. */
export const quote = { symbol: 'VTI', price: 268.42 };

/** 5. An array of amounts. */
export interface BadBatch {
  readonly amounts: readonly number[];
}

/** 6. A return type. */
export function totalValue(): number {
  return 0;
}

/** 7. `toFixed` manufacturing digits from a float — the Phase 1 `toFixed(18)` bug. */
export function quantityString(rawQuantity: number): string {
  return rawQuantity.toFixed(18);
}
