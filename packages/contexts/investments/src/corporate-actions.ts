// SPDX-License-Identifier: MIT
/**
 * Splits and reverse splits: quantity scales, per-unit basis scales the other
 * way, **total basis does not move**.
 *
 * A 4:1 split on 10 shares with a $1,000 basis gives 40 shares with a $1,000
 * basis. Per-unit basis goes from $100 to $25. Nothing is realised, no holding
 * period restarts, and the sum over the portfolio is unchanged to the cent —
 * which is the test's name, and the reason this is worth its own file rather
 * than being a multiplication inlined at the call site.
 *
 * ## Why the ratio is two integers and not a decimal
 *
 * A 3:2 split is 1.5, and 1.5 is exactly the kind of number that arrives as a
 * float and leaves as `1.4999999999999998`. So a ratio is `{ numerator,
 * denominator }` as `bigint`s: a 4:1 split is `4n/1n`, a 1:10 reverse split is
 * `1n/10n`. The quantity multiplication is then exact in `Quantity`'s decimal
 * arithmetic, and the basis is not multiplied at all — it is *kept*.
 *
 * ## Keeping the basis rather than recomputing it
 *
 * The naive implementation recomputes per-unit basis and multiplies back up.
 * That rounds, and it rounds once per lot per split, so a portfolio with a long
 * corporate-action history drifts by cents that reconcile to nothing. Here the
 * lot's `basis` and `basisConsumed` are carried across untouched and only
 * `quantity` and `quantityRemaining` change, so "total basis unchanged" is a
 * structural property of the function rather than an arithmetic coincidence.
 * Per-unit basis is derived when somebody asks for it (`remainingBasisPerUnit`)
 * and never stored.
 *
 * ## What a split does to a wash sale and a holding period
 *
 * Nothing. A split is not an acquisition: `openDate`,
 * `holdingPeriodStartDate`, `basisSource` and `washSaleAdjustment` all survive.
 * `acquisitionType` is *not* rewritten to `SPLIT` on an existing lot either —
 * that member exists for a lot a corporate action *creates* (a spin-off share),
 * and relabelling a lot the user bought would lose how it was acquired.
 */
import {
  Money,
  Quantity,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import { LotError, type Lot } from './lots.ts';

/** `4:1` is `{ numerator: 4n, denominator: 1n }`; `1:10` is a reverse split. */
export interface SplitRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface SplitInput {
  readonly securityId: string;
  readonly ratio: SplitRatio;
  /** Informational; a split does not move a holding period. */
  readonly effectiveDate?: string;
}

export function splitRatio(numerator: bigint, denominator: bigint): SplitRatio {
  if (numerator <= 0n || denominator <= 0n) {
    throw new LotError('split.ratio_not_positive', 'a split ratio is two positive integers');
  }
  return { numerator, denominator };
}

export function isReverseSplit(ratio: SplitRatio): boolean {
  return ratio.numerator < ratio.denominator;
}

/** Scale one quantity by the ratio, exactly, in decimal. */
export function scaleQuantity(value: QuantityType, ratio: SplitRatio): QuantityType {
  return Quantity.divide(
    Quantity.multiply(value, ratio.numerator.toString()),
    ratio.denominator.toString(),
  );
}

export interface SplitResult {
  readonly lots: readonly Lot[];
  /** Lots the split touched, for the event payload and for evidence. */
  readonly adjustedLotIds: readonly string[];
}

/**
 * Apply a split to every lot in one security, leaving every other lot alone.
 *
 * Total basis is invariant by construction — `basis` and `basisConsumed` are
 * copied, not recomputed. `'a 4:1 split quadruples quantity, quarters per-unit
 * basis and leaves total basis unchanged to the cent'` asserts all three.
 */
export function applySplit(lots: readonly Lot[], input: SplitInput): SplitResult {
  const adjustedLotIds: string[] = [];
  const next = lots.map((lot) => {
    if (lot.securityId !== input.securityId) return lot;
    adjustedLotIds.push(lot.id);
    return {
      ...lot,
      quantity: scaleQuantity(lot.quantity, input.ratio),
      quantityRemaining: scaleQuantity(lot.quantityRemaining, input.ratio),
      // Deliberately untouched: basis, basisConsumed, openDate,
      // holdingPeriodStartDate, basisSource, acquisitionType,
      // washSaleAdjustment. See the file header.
    };
  });
  return { lots: next, adjustedLotIds };
}

/**
 * Total basis across a set of lots, or `null` if any of it is unknown.
 *
 * Used by the split test to state the invariant directly rather than through
 * `costBasisOf`'s richer union, which would make the assertion about the union.
 */
export function totalBasisOf(lots: readonly Lot[]): MoneyType | null {
  let total: MoneyType | null = null;
  for (const lot of lots) {
    if (lot.basis === null) return null;
    // `Money.add` rather than a raw object literal: it refuses to add two
    // currencies, which is the whole reason `Money` is a type and not a bigint.
    total = total === null ? lot.basis : Money.add(total, lot.basis);
  }
  return total;
}
