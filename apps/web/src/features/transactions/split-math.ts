// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import type { Money as MoneyType } from '@core/kernel';

/**
 * Pure split arithmetic, kept apart from `SplitEditor.tsx` so the must-balance
 * invariant (05 §5.5: "Save is disabled until the remainder is zero") and the
 * largest-remainder "split evenly" behaviour are unit-testable without
 * rendering a dialog. Every function here operates on the kernel's exact
 * `Money`, never a `number` — WP 2.1's own rule for anything that reaches a
 * `*_minor` boundary applies just as much to a client that is about to send
 * one over the wire.
 */

/** Every split line's contribution, summed in the transaction's currency. */
export function sumSplits(lines: readonly MoneyType[], currency: string): MoneyType {
  return Money.sum(lines, currency);
}

/** What is left to allocate: `total - Σ lines`. Zero means the set may be saved. */
export function remainder(total: MoneyType, lines: readonly MoneyType[]): MoneyType {
  return Money.subtract(total, sumSplits(lines, total.currency));
}

/** `POST /transactions/{id}/splits` refuses a set that does not sum to the parent, to the cent — this is that same check, run client-side before the round trip. */
export function isBalanced(total: MoneyType, lines: readonly MoneyType[]): boolean {
  return Money.isZero(remainder(total, lines));
}

/**
 * "Split evenly" (05 §5.5): largest-remainder division of the whole total
 * into `count` shares, so they always sum back to the original — `Money.
 * allocateEvenly` is the kernel's own implementation of exactly this
 * (docs/evidence/phase-2/wp2.1-budgeting.md's envelope math uses the same
 * primitive for auto-assign). `$10.00` over 3 lines is `$3.34 / $3.33 /
 * $3.33`, not `$3.33 / $3.33 / $3.34` — the leftover cent goes to the
 * earliest line with the largest fractional remainder, never dropped.
 */
export function splitEvenly(total: MoneyType, count: number): MoneyType[] {
  return Money.allocateEvenly(total, count);
}

/**
 * A split line's amount is entered as a magnitude ("12.40"), never asked to
 * carry its own sign — every line of a split shares the parent transaction's
 * direction (all outflow or all inflow), so a UI that let one line point the
 * other way could produce a set that "sums to the total" while describing
 * money moving in a direction it never did. Any leading `+`/`-` the user
 * typed is stripped before parsing and the parent's sign is re-applied by
 * `applyDirection` below.
 */
export function parseSplitMagnitude(text: string, currency: string): MoneyType {
  const trimmed = text.trim().replace(/^[+-]/, '');
  if (trimmed === '') return Money.zero(currency);
  return Money.absolute(Money.parseAmount(trimmed, currency));
}

/** Re-applies the parent transaction's sign to a magnitude the user typed. */
export function applyDirection(magnitude: MoneyType, total: MoneyType): MoneyType {
  return Money.isNegative(total)
    ? Money.negate(Money.absolute(magnitude))
    : Money.absolute(magnitude);
}
