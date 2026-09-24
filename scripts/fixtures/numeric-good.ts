// SPDX-License-Identifier: MIT
/**
 * A fixture that must PASS `scripts/check-numeric-boundaries.ts`.
 *
 * Its job is to prove the check discriminates rather than simply banning the
 * word `number` near the word `price`: everything here is either a correct
 * money/quantity representation (`bigint` minor units, decimal strings) or a
 * genuinely dimensionless quantity whose name happens to match the 08 §6.5
 * pattern — a count, a duration, a ratio, a confidence score.
 *
 * A check with no negative fixture is a check that will one day be "fixed" by
 * making it flag everything.
 */

/** Money as `bigint` minor units + a currency, never a float. */
export interface GoodHolding {
  readonly quantity: string;
  readonly costBasisMinor: bigint | null;
  readonly marketValueMinor: bigint;
  readonly currency: string;
}

/** A price as the decimal string a `NUMERIC(20,10)` column round-trips. */
export const closingPrice = '268.4200000000';

/** Cardinalities. A count of prices is not a price. */
export interface GoodStats {
  readonly priceRowsWritten: number;
  readonly amountBuckets: number;
  readonly accountsUnvalued: number;
}

/** Dimensionless statistics over amounts. Not amounts. */
export interface GoodSignals {
  readonly amountCv: number;
  readonly amountStability: number;
  readonly priceChangeRecall: number;
}

/** A confidence score: dimensionless, in [0,1], and explicitly legal per §5. */
export function scoreOf(confidenceValue: number): number {
  return confidenceValue;
}

/** Presentation only, and named so a grep finds every call site. */
export function priceToNumberApproximate(text: string): number {
  return Number(text);
}

/** A duration is not money, however it is spelled. */
export const priceRefreshIntervalMs = 3_600_000;
