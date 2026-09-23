// SPDX-License-Identifier: MIT
/**
 * What the investing, debt and crypto families share: refs into the four new
 * snapshot blocks, three derivation builders `support.ts` had no need for, and
 * the two constants a rule in this wave is allowed to name.
 *
 * ## Why there are only three new derivation builders
 *
 * `support.ts` already carries the ones Phase 2 needed — sums, averages,
 * annualisations and `yieldSpread`. The portfolio families need exactly three
 * more, and each corresponds to a sentence 07 §3.3 asks for:
 *
 *   * `pointsGap` — `($0 - $1) * 100`, a weight difference in **percentage
 *     points**. I1's whole output, and the reason it is a derivation rather
 *     than a subtraction in a template: "4.2pp" is a numeral a human reads, so
 *     the validator has to be able to re-compute it.
 *   * `productOf` — `$0 * $1`, a balance at a rate. D2, D4 and X3's impact.
 *   * `halfOf` — `$0 * 0.5`, and it exists for X1 alone. See below.
 *
 * ## The one assumption this wave names, and why it is not a projection
 *
 * X1 in 07 §3.3 reads *"a {dd}% drawdown — which has happened repeatedly —
 * would be ${loss}"*. There is no drawdown series in any scope this work
 * package was given, and a hardcoded `dd` would be the hardcoded 4% again: a
 * numeral nothing in the snapshot could account for, rejected at step 7, and
 * rightly.
 *
 * What survives that constraint, and is what the dispatch asks for when it says
 * *"drawdown framing, never a projection"*, is a **stated conditional**: if
 * this holding fell by half, this much of net worth goes with it. `0.5` is on
 * `DERIVATION_LITERALS` already (07 §3.2's one-time weighting put it there), so
 * the arithmetic is declared, re-computed by the validator, and shown to the
 * user in the "how was this computed?" line. It asserts nothing about the
 * future and compounds no return into a headline. It is a stress, not a
 * forecast, and the copy says so in those words.
 */
import type { AdvisorSnapshot } from '../../contract/snapshot.ts';
import * as decimal from '../../validate/decimal.ts';
import { numericAt, snapshotRef, type BuiltDerivation } from '../support.ts';

// ---------------------------------------------------------------------------
// Refs into the four blocks
// ---------------------------------------------------------------------------

export function aggregateRef(field: string): string {
  return snapshotRef(`holdings_aggregate.${field}`);
}

export function assetClassRef(index: number, field: string): string {
  return aggregateRef(`by_asset_class[${String(index)}].${field}`);
}

export function targetRef(index: number, field: string): string {
  return aggregateRef(`target_allocation[${String(index)}].${field}`);
}

export function positionRef(index: number, field: string): string {
  return aggregateRef(`top_positions[${String(index)}].${field}`);
}

export function detailRef(index: number, field: string): string {
  return snapshotRef(`holdings_detail.positions[${String(index)}].${field}`);
}

export function lotRef(position: number, lot: number, field: string): string {
  return detailRef(position, `lots[${String(lot)}].${field}`);
}

export function liabilityRef(index: number, field: string): string {
  return snapshotRef(`liabilities_terms.liabilities[${String(index)}].${field}`);
}

export function rateRef(index: number, field: string): string {
  return snapshotRef(`market_rates.rates[${String(index)}].${field}`);
}

export function netWorthRef(field: string): string {
  return snapshotRef(`networth_summary.${field}`);
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

const HUNDRED = decimal.parseDecimal('100') as decimal.Decimal;
const HALF = decimal.parseDecimal('0.5') as decimal.Decimal;

/**
 * Build a derivation, or nothing.
 *
 * A local copy of `support.ts`'s private `built` rather than an export of it:
 * the association order below has to match the parser's, and a shared helper
 * that hid the order would be the place a future edit silently diverged from
 * `parseTerm`. Every builder here states its own expression and evaluates it in
 * the order the expression is written.
 */
function built(
  id: string,
  expression: string,
  inputs: readonly string[],
  note: string,
  value: decimal.Decimal | null,
): BuiltDerivation | null {
  if (value === null) return null;
  const rendered = decimal.render(value, decimal.DECIMAL_SCALE);
  if (rendered === null) return null;
  return { derivation: { id, expression, inputs: [...inputs], value: rendered, note }, value };
}

/**
 * `($0 - $1) * 100` — a weight difference in percentage points.
 *
 * Parenthesised because `parseTerm` binds `*` tighter than `-`: written flat,
 * `$0 - $1 * 100` would be `actual − (target × 100)`, which is not a drift and
 * is not close to one.
 */
export function pointsGap(
  snapshot: AdvisorSnapshot,
  id: string,
  actualRef: string,
  targetRef_: string,
  note: string,
): BuiltDerivation | null {
  const actual = numericAt(snapshot, actualRef);
  const target = numericAt(snapshot, targetRef_);
  if (actual === null || target === null) return null;
  const gap = decimal.subtract(actual, target);
  if (gap === null) return null;
  return built(
    id,
    '($0 - $1) * 100',
    [actualRef, targetRef_],
    note,
    decimal.multiply(gap, HUNDRED),
  );
}

/** `$0 * $1` — a balance at a rate, a value at a ratio. */
export function productOf(
  snapshot: AdvisorSnapshot,
  id: string,
  leftRef: string,
  rightRef: string,
  note: string,
): BuiltDerivation | null {
  const left = numericAt(snapshot, leftRef);
  const right = numericAt(snapshot, rightRef);
  if (left === null || right === null) return null;
  return built(id, '$0 * $1', [leftRef, rightRef], note, decimal.multiply(left, right));
}

/** `$0 * 0.5` — the stated stress X1 frames its exposure with. Never a forecast. */
export function halfOf(
  snapshot: AdvisorSnapshot,
  id: string,
  ref: string,
  note: string,
): BuiltDerivation | null {
  const value = numericAt(snapshot, ref);
  if (value === null) return null;
  return built(id, '$0 * 0.5', [ref], note, decimal.multiply(value, HALF));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A percentage-point figure, to one decimal: `4.2pp`.
 *
 * One decimal place, and the magnitude: "US equity is 4.2pp over target" and
 * "4.2pp under" are the same number with the direction in the words, which is
 * how the drift band reads on screen and keeps the sign out of a sentence where
 * it would have to be traced.
 */
export function formatPoints(value: decimal.Decimal): string | null {
  const rendered = decimal.render(decimal.absolute(value), 1);
  return rendered === null ? null : `${rendered}pp`;
}

// ---------------------------------------------------------------------------
// The thresholds this wave names
// ---------------------------------------------------------------------------

/**
 * 07 §4.3, normative: *"rule I1 must suppress itself when `unclassified_pct >
 * 10%`."* A drift claim over a portfolio a tenth of which is unclassified is
 * noise dressed as a measurement.
 */
export const UNCLASSIFIED_SUPPRESSION_THRESHOLD = 0.1;

/**
 * §1091 does not currently reach digital assets, **as of this date**.
 *
 * 07 §4.4 is explicit that this belongs in a dated config flag rather than a
 * hardcoded branch, because bills to change it recur: *"encode this as a dated
 * config flag (`wash_sale_applies_to_digital_assets: false # as of 2026-09`),
 * not a hardcoded branch."* X5's caveat quotes the date so a reader can tell a
 * current statement from a stale one.
 */
export const CRYPTO_WASH_SALE_WATCH = Object.freeze({
  appliesToDigitalAssets: false,
  asOf: '2026-09',
});
