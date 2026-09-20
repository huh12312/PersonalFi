// SPDX-License-Identifier: MIT
/**
 * What every built-in rule is made of: a context, a formatter, a derivation
 * builder, an insight constructor, and the impact ceiling.
 *
 * ## The shape of a rule, and why it is not `(snapshot) => Insight[]` exactly
 *
 * A rule is a **pure function of its inputs** and nothing else. Those inputs are
 * the snapshot *and* the three envelope fields a rule is allowed to know:
 * `today` (computed in the user's zone by the platform — 08 §4.1: "the advisor
 * must not read a clock"), the period it is reasoning about, and the base
 * currency. Passing `today` in rather than reading it is what makes the
 * determinism property in `advisor-golden.test.ts` meaningful: two calls
 * with the same `RuleContext` produce byte-identical insights forever, which is
 * also what makes a nightly re-run an upsert rather than a new row.
 *
 * A rule returns insights **and warnings**. Warnings are the operational
 * channel: `AdvisorResponse.diagnostics.warnings` is stored on `advisor_runs`,
 * and it is the one place a figure may appear that is *not* traced, because it
 * is not shown to the user. That is where a clamped outlier is logged.
 *
 * ## Every numeral is either a snapshot value or declared arithmetic
 *
 * WP 2.6's validator traces every numeral in every rendered field back to the
 * snapshot or to a `derivation` it re-computes itself (`validate/numerals.ts`,
 * `validate/derivations.ts`). A built-in has no privileged path around that — it
 * goes through the same seven steps a Phase 6 sidecar will. So the builders
 * below exist to make the *only* convenient way to write a rule also the correct
 * one:
 *
 *   * `formatMinor` renders a money figure from a decimal the validator can
 *     reach under its `÷100` rendering;
 *   * `formatPercent` renders a ratio the validator reaches under `×100`;
 *   * `sumOf` / `sumProducts` / `averageDelta` / `yieldSpread` each return a
 *     `Derivation` **and** the value they computed, so the two can never
 *     disagree — the copy is formatted from the same decimal that goes into
 *     `derivation.value`.
 *
 * Where a figure cannot be expressed that way, the rule says it in **words**
 * ("three months", "the last year"). A word is not a numeral, and inventing a
 * threshold constant to print would be inventing a number. That constraint is
 * load-bearing rather than annoying: it is why `spending.uncategorised` does not
 * print a count (see `rules-spending.ts`).
 *
 * ## Arithmetic here must match the validator's, exactly
 *
 * The builders evaluate with `validate/decimal.ts` — the same scale-6, half-even
 * `bigint` module the validator's parser uses — and in the same association
 * order the parser walks (`parseTerm` before `parseExpression`, left to right).
 * `catalog.test.ts` closes the loop by running every emitted insight through the
 * real `validateResponse`: if an evaluation order ever drifted from the parser's,
 * that suite goes red rather than a user seeing a figure we cannot defend.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { AdvisorManifest } from '../contract/manifest.ts';
import type { AdvisorRequest } from '../contract/request.ts';
import {
  type Derivation,
  type Evidence,
  type Insight,
  type ProposedAction,
  type Severity,
} from '../contract/response.ts';
import type { AdvisorSnapshot, MoneyJson } from '../contract/snapshot.ts';
import * as decimal from '../validate/decimal.ts';
import { numericValueOf } from '../validate/derivations.ts';
import { resolveSourceRef } from '../validate/evidence.ts';

// ---------------------------------------------------------------------------
// The rule shape
// ---------------------------------------------------------------------------

/** Everything a rule is allowed to know. No clock, no database, no network. */
export interface RuleContext {
  readonly snapshot: AdvisorSnapshot;
  /** `YYYY-MM-DD`, computed in the user's zone by the platform. */
  readonly today: string;
  /** The period an insight is *about* by default. `YYYY-MM`. */
  readonly period: string;
  readonly baseCurrency: string;
}

export interface RuleOutput {
  readonly insights: readonly Insight[];
  /** Operational notes for `diagnostics.warnings`. Never shown to the user. */
  readonly warnings: readonly string[];
}

/** A built-in rule: a manifest, and one pure function. */
export interface BuiltinRule {
  readonly manifest: AdvisorManifest;
  evaluate(context: RuleContext): RuleOutput;
}

/** The `RuleContext` a request carries. The period defaults to today's month. */
export function contextOf(request: AdvisorRequest): RuleContext {
  return {
    snapshot: request.snapshot,
    today: request.today,
    period: request.today.slice(0, 7),
    baseCurrency: request.base_currency,
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Days from `from` to `to`, or `null` when either is not a date.
 *
 * A local epoch-day conversion rather than `DateOnly.differenceInDays`, because
 * the kernel's helpers take a *branded* `DateOnly` and everything in a snapshot
 * is a plain string that arrived over a contract. Validating the shape here and
 * refusing anything else keeps a malformed date a skipped rule rather than a
 * thrown worker — rules are on the totality path with the validator.
 */
export function daysBetween(from: string, to: string): number | null {
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) return null;
  const left = Date.parse(`${from}T00:00:00Z`);
  const right = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return Math.round((right - left) / 86_400_000);
}

/** `YYYY-MM` of a `YYYY-MM-DD`, or `null`. */
export function monthOf(date: string): string | null {
  return DATE_PATTERN.test(date) ? date.slice(0, 7) : null;
}

/**
 * The months before the one `today` falls in, newest last.
 *
 * Every trailing average in the catalogue is over **complete** months. A
 * part-month looks like a collapse in spending on the 3rd and a spike on the
 * 30th, and a rule that averaged it would fire on the calendar rather than on
 * the user's behaviour.
 */
export function completeMonths<T extends { readonly month: string }>(
  months: readonly T[],
  today: string,
): readonly T[] {
  const current = monthOf(today);
  if (current === null) return [];
  return months.filter((row) => row.month < current);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const HUNDRED = decimal.parseDecimal('100') as decimal.Decimal;

/** `2123500` minor → `21,235.00`. `null` when the decimal will not render. */
export function majorOf(value: decimal.Decimal): string | null {
  const major = decimal.divide(decimal.absolute(value), HUNDRED);
  if (major === null) return null;
  const rendered = decimal.render(major, 2);
  if (rendered === null) return null;
  const dot = rendered.indexOf('.');
  const whole = dot === -1 ? rendered : rendered.slice(0, dot);
  const fraction = dot === -1 ? '' : rendered.slice(dot);
  return `${group(whole)}${fraction}`;
}

function group(whole: string): string {
  const out: string[] = [];
  for (let index = whole.length; index > 0; index -= 3) {
    out.unshift(whole.slice(Math.max(0, index - 3), index));
  }
  return out.join(',');
}

/**
 * A money figure for the copy: `$21,235.00`, always the magnitude.
 *
 * The magnitude, because "you spent $612.40 more than you earned" reads from a
 * `net` of `-61240`, and `absolute` is one of the six renderings the numeral
 * tracer accepts — so the sign convention (negative = outflow) never has to leak
 * into a sentence to stay traceable.
 */
export function formatMinor(value: decimal.Decimal): string | null {
  const major = majorOf(value);
  return major === null ? null : `$${major}`;
}

/** A money figure straight from a snapshot `{ minor, currency }`. */
export function formatMoneyJson(money: MoneyJson): string | null {
  const parsed = decimal.parseDecimal(money.minor);
  return parsed === null ? null : formatMinor(parsed);
}

/**
 * A ratio as a percentage: `0.0425` → `4.25%`.
 *
 * Trailing zeros are trimmed because `4.20%` reads like a measurement and
 * `4.2%` reads like a rate; both trace, since the tracer renders a candidate at
 * *the numeral's own* number of decimals.
 */
export function formatPercent(ratio: number): string | null {
  const value = decimal.fromNumber(ratio);
  if (value === null) return null;
  const scaled = decimal.multiply(value, HUNDRED);
  if (scaled === null) return null;
  const rendered = decimal.render(scaled, 2);
  if (rendered === null) return null;
  const trimmed = rendered.includes('.')
    ? rendered.replace(/0+$/, '').replace(/\.$/, '')
    : rendered;
  return `${trimmed}%`;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** A derivation and the value we computed for it. They cannot disagree. */
export interface BuiltDerivation {
  readonly derivation: Derivation;
  readonly value: decimal.Decimal;
}

export function snapshotRef(path: string): string {
  return `snapshot:${path}`;
}

/** Resolve a ref to a number the way the validator will. `null` if it will not. */
export function numericAt(snapshot: AdvisorSnapshot, ref: string): decimal.Decimal | null {
  const resolution = resolveSourceRef(snapshot, ref);
  return resolution.ok ? numericValueOf(resolution.value) : null;
}

function resolveAll(
  snapshot: AdvisorSnapshot,
  refs: readonly string[],
): readonly decimal.Decimal[] | null {
  const values: decimal.Decimal[] = [];
  for (const ref of refs) {
    const value = numericAt(snapshot, ref);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

/**
 * The claimed value, rendered at the precision the validator will compare at.
 *
 * Scale 6 — the whole of what the decimal module carries — so the claim is the
 * computation and not a rounding of it. Display rounding happens in the copy,
 * where `formatMinor` does it and the tracer allows it.
 */
function claim(value: decimal.Decimal): string | null {
  return decimal.render(value, decimal.DECIMAL_SCALE);
}

function built(
  id: string,
  expression: string,
  inputs: readonly string[],
  note: string,
  value: decimal.Decimal | null,
): BuiltDerivation | null {
  if (value === null) return null;
  const rendered = claim(value);
  if (rendered === null) return null;
  return {
    derivation: { id, expression, inputs: [...inputs], value: rendered, note },
    value,
  };
}

/** `$0 + $1 + …`. Left-associative, like the parser. */
export function sumOf(
  snapshot: AdvisorSnapshot,
  id: string,
  refs: readonly string[],
  note: string,
): BuiltDerivation | null {
  const values = resolveAll(snapshot, refs);
  if (values === null || values.length === 0 || values.length > 16) return null;
  let total: decimal.Decimal | null = values[0] ?? null;
  for (const value of values.slice(1)) {
    if (total === null) return null;
    total = decimal.add(total, value);
  }
  const expression = values.map((_, index) => `$${String(index)}`).join(' + ');
  return built(id, expression, refs, note, total);
}

/** `($0 + $1 + …) / n`, where `n` is a literal the allow-list already carries. */
export function averageOf(
  snapshot: AdvisorSnapshot,
  id: string,
  refs: readonly string[],
  divisor: number,
  note: string,
): BuiltDerivation | null {
  const total = sumOf(snapshot, `${id}.sum`, refs, note);
  if (total === null) return null;
  const divisorDecimal = decimal.parseDecimal(String(divisor));
  if (divisorDecimal === null) return null;
  const value = decimal.divide(total.value, divisorDecimal);
  const inner = total.derivation.expression;
  return built(id, `(${inner}) / ${String(divisor)}`, refs, note, value);
}

/** `$0 * $1 + $2 * $3 + …` — an amount times its periods, summed. */
export function sumProducts(
  snapshot: AdvisorSnapshot,
  id: string,
  pairs: readonly (readonly [string, string])[],
  note: string,
): BuiltDerivation | null {
  const refs = pairs.flatMap((pair) => [pair[0], pair[1]]);
  const values = resolveAll(snapshot, refs);
  if (values === null || pairs.length === 0 || refs.length > 16) return null;

  let total: decimal.Decimal | null = null;
  for (let index = 0; index < pairs.length; index += 1) {
    const left = values[index * 2];
    const right = values[index * 2 + 1];
    if (left === undefined || right === undefined) return null;
    const product = decimal.multiply(left, right);
    if (product === null) return null;
    total = total === null ? product : decimal.add(total, product);
  }
  const expression = pairs
    .map((_, index) => `$${String(index * 2)} * $${String(index * 2 + 1)}`)
    .join(' + ');
  return built(id, expression, refs, note, total);
}

/** `($0 + $1 + $2) / n * 12` — a monthly average taken out to a year. */
export function annualisedAverage(
  snapshot: AdvisorSnapshot,
  id: string,
  refs: readonly string[],
  divisor: number,
  note: string,
): BuiltDerivation | null {
  const average = averageOf(snapshot, `${id}.average`, refs, divisor, note);
  if (average === null) return null;
  const twelve = decimal.parseDecimal('12');
  if (twelve === null) return null;
  const value = decimal.multiply(average.value, twelve);
  return built(id, `${average.derivation.expression} * 12`, refs, note, value);
}

/** `($0 * $1 + …) / 12` — annual figures brought back to a month. */
export function monthlyFromAnnual(
  snapshot: AdvisorSnapshot,
  id: string,
  pairs: readonly (readonly [string, string])[],
  note: string,
): BuiltDerivation | null {
  const annual = sumProducts(snapshot, `${id}.annual`, pairs, note);
  if (annual === null) return null;
  const twelve = decimal.parseDecimal('12');
  if (twelve === null) return null;
  const value = decimal.divide(annual.value, twelve);
  return built(id, `(${annual.derivation.expression}) / 12`, annual.derivation.inputs, note, value);
}

/**
 * `($0 + … ) / r − ($r + …) / b` — a recent average against a longer one.
 *
 * The two windows overlap by construction (07 §3.3 S2 compares a trailing three
 * months with a trailing twelve that contains them), and a ref may therefore
 * appear in `inputs` twice. That is fine: `inputs[n]` is positional, the
 * validator resolves each independently, and the alternative — de-duplicating —
 * would make the expression's indices depend on which months happened to repeat.
 */
export function averageDelta(
  snapshot: AdvisorSnapshot,
  id: string,
  recent: readonly string[],
  recentDivisor: number,
  baseline: readonly string[],
  baselineDivisor: number,
  note: string,
): BuiltDerivation | null {
  const refs = [...recent, ...baseline];
  const values = resolveAll(snapshot, refs);
  if (values === null || refs.length > 16 || recent.length === 0 || baseline.length === 0) {
    return null;
  }
  const recentAverage = averageOfValues(values.slice(0, recent.length), recentDivisor);
  const baselineAverage = averageOfValues(values.slice(recent.length), baselineDivisor);
  if (recentAverage === null || baselineAverage === null) return null;
  const value = decimal.subtract(recentAverage, baselineAverage);

  const recentTerms = recent.map((_, index) => `$${String(index)}`).join(' + ');
  const baselineTerms = baseline.map((_, index) => `$${String(recent.length + index)}`).join(' + ');
  const expression =
    `(${recentTerms}) / ${String(recentDivisor)} - ` +
    `(${baselineTerms}) / ${String(baselineDivisor)}`;
  return built(id, expression, refs, note, value);
}

/** The same delta, annualised: `((…)/r − (…)/b) * 12`. */
export function annualisedDelta(
  snapshot: AdvisorSnapshot,
  id: string,
  recent: readonly string[],
  recentDivisor: number,
  baseline: readonly string[],
  baselineDivisor: number,
  note: string,
): BuiltDerivation | null {
  const delta = averageDelta(
    snapshot,
    `${id}.delta`,
    recent,
    recentDivisor,
    baseline,
    baselineDivisor,
    note,
  );
  if (delta === null) return null;
  const twelve = decimal.parseDecimal('12');
  if (twelve === null) return null;
  const value = decimal.multiply(delta.value, twelve);
  return built(id, `(${delta.derivation.expression}) * 12`, delta.derivation.inputs, note, value);
}

/**
 * `$0 * $1 − $0 * $2` — one balance at two rates the user already holds.
 *
 * The rate on both sides is a snapshot field, never a market constant. A
 * market-rate comparison is what 07 §3.3 C1/C2 ask for, and it is the one thing
 * this catalogue cannot do honestly: there is no price feed in a self-hosted
 * install, and a hardcoded "4%" would be a number nothing in the snapshot could
 * account for — which the validator would reject, correctly. Comparing the
 * user's own accounts is weaker advice and a figure that is entirely theirs.
 */
export function yieldSpread(
  snapshot: AdvisorSnapshot,
  id: string,
  balanceRef: string,
  highRateRef: string,
  lowRateRef: string,
  note: string,
): BuiltDerivation | null {
  const refs = [balanceRef, highRateRef, lowRateRef];
  const values = resolveAll(snapshot, refs);
  if (values === null) return null;
  const [balance, high, low] = values;
  if (balance === undefined || high === undefined || low === undefined) return null;
  const atHigh = decimal.multiply(balance, high);
  const atLow = decimal.multiply(balance, low);
  if (atHigh === null || atLow === null) return null;
  return built(id, '$0 * $1 - $0 * $2', refs, note, decimal.subtract(atHigh, atLow));
}

function averageOfValues(
  values: readonly decimal.Decimal[],
  divisor: number,
): decimal.Decimal | null {
  let total: decimal.Decimal | null = decimal.parseDecimal('0');
  for (const value of values) {
    if (total === null) return null;
    total = decimal.add(total, value);
  }
  if (total === null) return null;
  const divisorDecimal = decimal.parseDecimal(String(divisor));
  if (divisorDecimal === null) return null;
  return decimal.divide(total, divisorDecimal);
}

// ---------------------------------------------------------------------------
// The impact ceiling (07 §3.2)
// ---------------------------------------------------------------------------

/**
 * The sanity ceiling, in major units of the base currency.
 *
 * 07 §3.2: "Cap any single insight's displayed impact at a sanity ceiling and
 * log outliers — a data bug that claims '$1.4M savings available' is the fastest
 * way to lose all credibility."
 */
export const IMPACT_CEILING_MAJOR = 100_000;

const CEILING_MINOR = decimal.parseDecimal(String(IMPACT_CEILING_MAJOR * 100)) as decimal.Decimal;

export type ImpactVerdict =
  | { readonly kind: 'kept'; readonly money: MoneyJson }
  | { readonly kind: 'withheld'; readonly warning: string; readonly caveat: string };

/**
 * Apply the ceiling, and say what happened.
 *
 * **The outlier is withheld, not rewritten to the ceiling**, and that is a
 * deliberate reading of "clamp". Printing `$100,000` for a computed `$1,412,000`
 * would put a number on the screen that is in neither the snapshot nor any
 * declared arithmetic — the validator would reject it at step 7, and it would
 * deserve to: a clamped figure is a figure the app made up to avoid admitting it
 * had a data bug. So the headline is dropped, a caveat says so in words, and the
 * real figure goes into `diagnostics.warnings`, where it is stored on
 * `advisor_runs` for whoever investigates and is never rendered.
 *
 * The insight itself survives. The finding ("two streams in one taxonomy node")
 * may well be true even when its arithmetic has been poisoned by one bad row,
 * and dropping it entirely would hide the evidence that leads to the bug.
 */
export function clampImpact(value: decimal.Decimal, currency: string, what: string): ImpactVerdict {
  const magnitude = decimal.absolute(value);
  if (magnitude > CEILING_MINOR) {
    const rendered = decimal.render(magnitude, 2) ?? 'unrenderable';
    return {
      kind: 'withheld',
      warning:
        `impact ceiling: ${what} computed ${rendered} minor units, over the ` +
        `${String(IMPACT_CEILING_MAJOR)} major-unit ceiling; figure withheld`,
      caveat:
        'The saving this rule computed was too large to be plausible, so the ' +
        'figure is withheld pending review of the underlying data.',
    };
  }
  const minor = decimal.render(magnitude, 0);
  if (minor === null) {
    return {
      kind: 'withheld',
      warning: `impact ceiling: ${what} produced an unrenderable figure`,
      caveat: 'The saving this rule computed could not be rendered exactly, so it is withheld.',
    };
  }
  return { kind: 'kept', money: { minor, currency } };
}

// ---------------------------------------------------------------------------
// Constructing an insight
// ---------------------------------------------------------------------------

export function metric(label: string, ref: string, value: string | null): Evidence {
  return { kind: 'metric', label, value, source_ref: ref, url: null };
}

export function seriesEvidence(label: string, ref: string, value: string | null): Evidence {
  return { kind: 'series', label, value, source_ref: ref, url: null };
}

export function transactionEvidence(label: string, ref: string, value: string | null): Evidence {
  return { kind: 'transaction', label, value, source_ref: ref, url: null };
}

export function suggest(label: string, rationale: string): ProposedAction {
  return { kind: 'suggest_only', label, rationale_md: rationale, url: null };
}

export function ruleDraft(label: string, rationale: string): ProposedAction {
  return { kind: 'create_rule_draft', label, rationale_md: rationale, url: null };
}

export interface InsightDraft {
  readonly key: string;
  readonly period: string;
  readonly type: string;
  readonly severity: Severity;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly horizon: Insight['horizon'];
  readonly annualized?: MoneyJson | null;
  readonly oneTime?: MoneyJson | null;
  readonly basis: string;
  readonly derivationId?: string | null;
  readonly evidence: readonly Evidence[];
  readonly derivations?: readonly Derivation[];
  readonly actions?: readonly ProposedAction[];
  readonly caveats?: readonly string[];
}

/**
 * The one constructor every rule uses.
 *
 * `confidence_basis` is `'deterministic'` and `requires_review` is `true` with
 * no way to say otherwise — the first is a claim the pipeline checks against the
 * manifest *and* the advisor's kind, and the second is a literal in the schema.
 * Neither is a choice a rule author gets to make, which is the point of having
 * exactly one constructor.
 */
export function insightOf(draft: InsightDraft): Insight {
  return {
    key: draft.key,
    period: draft.period,
    type: draft.type,
    severity: draft.severity,
    title: draft.title,
    summary_md: draft.summary,
    confidence: clampRatio(draft.confidence),
    confidence_basis: 'deterministic',
    horizon: draft.horizon,
    requires_review: true,
    impact: {
      annualized: draft.annualized ?? null,
      one_time: draft.oneTime ?? null,
      basis: draft.basis,
      derivation_id: draft.derivationId ?? null,
    },
    evidence: [...draft.evidence],
    derivations: [...(draft.derivations ?? [])],
    proposed_actions: [...(draft.actions ?? [])],
    caveats: [...(draft.caveats ?? [])],
    expires_at: null,
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** `Money` for the ranking layer, from the wire's `{ minor, currency }`. */
export function moneyOf(value: MoneyJson | null): MoneyType | null {
  if (value === null) return null;
  try {
    return Money.fromJSON(value);
  } catch {
    // A currency code the kernel does not know. The feed is a read path; a bad
    // row is an unranked row, never a 500.
    return null;
  }
}
