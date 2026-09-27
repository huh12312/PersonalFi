// SPDX-License-Identifier: MIT
/**
 * What the retirement family shares: refs into `plan_projection` and
 * `goals_list`, the three derivation builders the family needs that
 * `support.ts` and `builtin/shared.ts` do not have, a formatter for the one
 * kind of number this block carries that no earlier block did, and the two
 * sentences every rule in the family ends with.
 *
 * ## Why a decimal-string formatter
 *
 * Every ratio in `plan.projection` is a **decimal string** (`'0.713000'`), not
 * a JSON number: the Phase 4 gate's "never" list includes *a success
 * probability never crosses the wire as a JSON number*, and the snapshot is a
 * wire. `formatPercent` in `support.ts` takes a `number`, and calling it here
 * would mean `Number('0.713000')` — the one float conversion the contract was
 * shaped to avoid. `formatRatioText` goes decimal string → `validate/decimal.ts`
 * → text, the same module the numeral tracer uses, so the rendered figure and
 * the traced one cannot disagree.
 *
 * ## No rule in this family compounds a return into a headline
 *
 * 07 §3.2: *"Never compound speculative returns into the headline number."*
 * The dispatch: *"no rule may compound a speculative return into a headline
 * dollar figure"*, and R2 *"reports probability points, not dollars"*. The
 * builders below are a subtraction, a ratio of two statutory factors, and a
 * monthly gap times twelve — none has a rate of return in it, and
 * `test/no-compounding.test.ts` checks every derivation the family emits for an
 * exponent, a `(1 + r)` term, or an input ref into the projected band.
 */
import type { AdvisorSnapshot } from '../../../contract/snapshot.ts';
import * as decimal from '../../../validate/decimal.ts';
import { numericAt, snapshotRef, type BuiltDerivation } from '../../support.ts';

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export function projectionRef(field: string): string {
  return snapshotRef(`plan_projection.${field}`);
}

export function goalRef(index: number, field: string): string {
  return snapshotRef(`goals_list.goals[${String(index)}].${field}`);
}

// ---------------------------------------------------------------------------
// The block, read defensively
// ---------------------------------------------------------------------------

export type PlanProjection = NonNullable<AdvisorSnapshot['plan_projection']>;
export type GoalRow = NonNullable<AdvisorSnapshot['goals_list']>['goals'][number];

/**
 * The block, or `null` when it is absent **or is not an object**.
 *
 * Rules are on the totality path with the validator (`advisor-golden.test.ts`
 * feeds every rule arbitrary JSON): a `plan_projection` that arrived as a
 * string must be a silent rule, never a thrown worker.
 */
export function projectionOf(snapshot: AdvisorSnapshot): PlanProjection | null {
  const block = (snapshot as Record<string, unknown>)['plan_projection'];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
  return block as PlanProjection;
}

export function goalsOf(snapshot: AdvisorSnapshot): readonly GoalRow[] {
  const block = (snapshot as Record<string, unknown>)['goals_list'];
  if (typeof block !== 'object' || block === null) return [];
  const goals = (block as Record<string, unknown>)['goals'];
  return Array.isArray(goals) ? (goals as GoalRow[]) : [];
}

/** A decimal string → a `Decimal`, or `null`. Never through a float. */
export function decimalOf(text: unknown): decimal.Decimal | null {
  return typeof text === 'string' ? decimal.parseDecimal(text) : null;
}

/** An integer field, or `null`. */
export function integerOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const HUNDRED = decimal.parseDecimal('100') as decimal.Decimal;
const TWELVE = decimal.parseDecimal('12') as decimal.Decimal;
const ONE = decimal.parseDecimal('1') as decimal.Decimal;

/**
 * `'0.713000'` → `'71.3%'`. Two places at most, trailing zeros trimmed — the
 * same presentation `formatPercent` gives a number, reached without one.
 */
export function formatRatioText(text: unknown): string | null {
  const value = decimalOf(text);
  if (value === null) return null;
  const scaled = decimal.multiply(value, HUNDRED);
  if (scaled === null) return null;
  return trimmedPercent(scaled);
}

/** A value that is already a percentage (a derivation's output) → `'24%'`. */
export function formatPercentValue(value: decimal.Decimal): string | null {
  return trimmedPercent(decimal.absolute(value));
}

function trimmedPercent(value: decimal.Decimal): string | null {
  const rendered = decimal.render(value, 2);
  if (rendered === null) return null;
  const trimmed = rendered.includes('.')
    ? rendered.replace(/0+$/u, '').replace(/\.$/u, '')
    : rendered;
  return `${trimmed}%`;
}

/** A whole count from a derivation (`9`), or `null` if it is not whole. */
export function formatWhole(value: decimal.Decimal): string | null {
  const rendered = decimal.render(value, 0);
  if (rendered === null) return null;
  return decimal.parseDecimal(rendered) === value ? rendered : null;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** A local copy of the private `built`, for the same reason `builtin/shared.ts` gives. */
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

/** `$0 - $1` — a count of years between two ages. */
export function differenceOf(
  snapshot: AdvisorSnapshot,
  id: string,
  leftRef: string,
  rightRef: string,
  note: string,
): BuiltDerivation | null {
  const left = numericAt(snapshot, leftRef);
  const right = numericAt(snapshot, rightRef);
  if (left === null || right === null) return null;
  return built(id, '$0 - $1', [leftRef, rightRef], note, decimal.subtract(left, right));
}

/**
 * `($0 / $1 - 1) * 100` — how much larger one statutory factor is than
 * another, in percent. R4's whole figure: a multiplier on a benefit, never the
 * benefit, so no income-derived dollar amount needs to cross the scope.
 *
 * Evaluated in the order `parseTerm` walks it: the division binds first, then
 * the subtraction inside the parentheses, then the multiplication.
 */
export function factorUplift(
  snapshot: AdvisorSnapshot,
  id: string,
  largerRef: string,
  smallerRef: string,
  note: string,
): BuiltDerivation | null {
  const larger = numericAt(snapshot, largerRef);
  const smaller = numericAt(snapshot, smallerRef);
  if (larger === null || smaller === null) return null;
  const quotient = decimal.divide(larger, smaller);
  if (quotient === null) return null;
  const uplift = decimal.subtract(quotient, ONE);
  if (uplift === null) return null;
  return built(
    id,
    '($0 / $1 - 1) * 100',
    [largerRef, smallerRef],
    note,
    decimal.multiply(uplift, HUNDRED),
  );
}

/**
 * `($0 - $1) * 12` — a monthly gap, taken out to a year. R6's impact: what the
 * goal's plans would have to add in a year to be on pace. Two amounts the
 * planning context already rounded; nothing projected.
 */
export function annualGap(
  snapshot: AdvisorSnapshot,
  id: string,
  requiredRef: string,
  plannedRef: string,
  note: string,
): BuiltDerivation | null {
  const required = numericAt(snapshot, requiredRef);
  const planned = numericAt(snapshot, plannedRef);
  if (required === null || planned === null) return null;
  const gap = decimal.subtract(required, planned);
  if (gap === null) return null;
  return built(
    id,
    '($0 - $1) * 12',
    [requiredRef, plannedRef],
    note,
    decimal.multiply(gap, TWELVE),
  );
}

// ---------------------------------------------------------------------------
// The two sentences every rule in the family ends with
// ---------------------------------------------------------------------------

/**
 * 07 §7.2, verbatim: *"Every advisory surface carries"* this. 211 characters,
 * inside the contract's 240-character caveat.
 */
export const ADVISORY_DISCLAIMER =
  'Educational information generated from your own data. Not investment, tax, or legal ' +
  'advice. Figures are estimates based on assumptions you can review and change. Consider ' +
  'consulting a qualified professional.';

/**
 * The staleness caveat. A run whose assumptions are retired or have since
 * changed reads back as it was (WP 4.6 never recomputes on read), and a figure
 * quoted from it must say so rather than look current.
 */
export const STALE_RUN_CAVEAT =
  'This projection was computed under assumptions that have since changed; the plan screen ' +
  're-runs it on request.';
