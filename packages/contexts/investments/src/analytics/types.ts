// SPDX-License-Identifier: MIT
/**
 * The numeric type portfolio analytics answers in, and the return *shapes* that
 * make 07 §4.2's rule — *"Never put a TWR next to a dollar gain, and never
 * benchmark an MWR. That's the whole rule."* — a fact about the type system
 * rather than a note in a review checklist.
 *
 * ## Why a rule about UI layout is enforced here
 *
 * A TWR asks "did my investments do well?" and deliberately removes the effect
 * of when money arrived. A dollar gain asks "how much money did I make?" and is
 * entirely a function of when money arrived. Rendered side by side they invite
 * exactly one inference — *"my portfolio returned 8%, so my $100,000 made
 * $8,000"* — and that inference is false whenever a cash flow happened, which
 * is always. The same goes the other way: benchmarking an MWR against the S&P
 * compares a number that includes the user's deposit timing against one that
 * cannot contain it, and the difference is attributed to skill.
 *
 * A comment cannot stop that. A route handler that spreads two engines'
 * outputs into one response object can, and it looks reasonable while doing
 * it. So `TimeWeightedReturn` declares `gain?: never`, `MoneyWeightedReturn`
 * declares `benchmark?: never` and `DollarGain` declares `periodReturn?: never`
 * — with `exactOptionalPropertyTypes` on, an object carrying both fails to
 * type-check whether it was written as a literal or assembled by a spread.
 * `src/analytics/types.test.ts` → `'a TWR and a dollar gain cannot be placed in
 * the same return shape'` pins it with `@ts-expect-error`, which `tsc -b` — not
 * vitest — is what actually checks.
 *
 * ## The numeric type decision (D3)
 *
 * D3 is about *stored values*: `BIGINT` minor units for money, `NUMERIC(38,18)`
 * for quantities, no floats anywhere near either. Analytics returns neither:
 * it returns ratios. The decision, recorded here because every consumer
 * inherits it:
 *
 *   * **Money stays `Money`.** Fee drag, a dollar gain, a rebalance trade size
 *     — all `Money` (bigint minor units), rounded once, half-even, at the
 *     boundary. No analytics function returns a `number` for an amount.
 *   * **Ratios are `Ratio`: a plain decimal string at a stated scale of
 *     {@link RATIO_SCALE} (10 decimal places).** Not a `number`. 04 §2.3 says
 *     floats are *correct* for allocation ratios, and it is right that the
 *     precision is not needed — but a `number` here is a `number` that gets
 *     multiplied by a portfolio value two calls later, and the boundary rule
 *     ("floats may never flow back into a `*_minor` column") is far easier to
 *     enforce when there is no float to flow. A decimal string costs nothing
 *     and removes the question.
 *   * **Percentage *points* are `Points`**, a separate branded decimal string
 *     at {@link POINTS_SCALE}. `0.051` and `5.1` are both "the drift" and a
 *     function that takes the wrong one is off by 100× while still looking
 *     sane. The 5-point drift band is compared against `Points`, never a ratio.
 *   * **`number` appears in exactly two places**, both named so at the call
 *     site: {@link ratioToNumberApproximate} / {@link pointsToNumberApproximate}
 *     (charting and other display; documented as lossy, never re-entrant into a
 *     Money or Quantity), and whole counts of days, lots and holdings, which
 *     are counts.
 *
 * ## Decimal arithmetic without a second decimal library
 *
 * `@core/kernel`'s `Quantity` is already an arbitrary-precision decimal with
 * the repo's rounding policy baked in, so ratio arithmetic runs on it rather
 * than on a new dependency. `Quantity` has no `pow`, and TWR annualisation and
 * XIRR discounting both need a fractional one, so {@link decimalPow} builds it
 * out of `ln` and `exp` series over the same type. `Math.pow` is not used, and
 * no intermediate is ever a float.
 */
import {
  DateOnly,
  Money,
  Quantity,
  type Brand,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import type { AssetClass, Region } from '../../schema/index.ts';
import type { LotPrice } from '../basis.ts';
import type { PriceStaleness } from '../prices.ts';

// ---------------------------------------------------------------------------
// Ratio and Points
// ---------------------------------------------------------------------------

/**
 * A dimensionless ratio as a plain decimal string: `'0.0812340000'` is 8.1234%.
 *
 * Always exactly {@link RATIO_SCALE} decimal places, so two ratios are equal
 * iff their strings are equal and a snapshot test cannot pass by accident of
 * formatting. Never a `number`; never money.
 */
export type Ratio = Brand<string, 'Ratio'>;

/**
 * A difference between two ratios, in percentage points: `'5.1000'` is 5.1pp.
 *
 * A separate type from {@link Ratio} because the 5-point drift band, the 10%
 * unclassified suppression threshold and the 20% concentration trigger are all
 * quoted in points in 07, and a 100× unit error between them is arithmetically
 * silent.
 */
export type Points = Brand<string, 'Points'>;

/** Decimal places every {@link Ratio} carries. 1e-10 is ~1e-8 of a point. */
export const RATIO_SCALE = 10;

/** Decimal places every {@link Points} value carries. */
export const POINTS_SCALE = 4;

const PLAIN_DECIMAL = /^[+-]?\d+(\.\d+)?$/;

/**
 * Round a plain decimal string to `scale` places, half-even, and pad to exactly
 * that many places. Pure string and `bigint` work — no float, no rounding of a
 * rounding.
 */
export function roundDecimalString(text: string, scale: number): string {
  const value = text.trim();
  if (!PLAIN_DECIMAL.test(value)) {
    throw new AnalyticsInputError(`expected a plain decimal string, got ${JSON.stringify(text)}`);
  }
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [wholeText = '0', fractionText = ''] = unsigned.split('.');
  const kept = fractionText.slice(0, scale).padEnd(scale, '0');
  const dropped = fractionText.slice(scale).replace(/0+$/, '');

  let units = BigInt(wholeText + kept);
  if (dropped.length > 0) {
    const half = '5'.padEnd(dropped.length, '0');
    const comparison = dropped < half ? -1 : dropped > half ? 1 : 0;
    if (comparison > 0 || (comparison === 0 && units % 2n === 1n)) units += 1n;
  }

  const digits = units.toString().padStart(scale + 1, '0');
  const sign = negative && units !== 0n ? '-' : '';
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${sign}${body}`;
}

/** Build a ratio from a plain decimal string. `'0.05'` → `'0.0500000000'`. */
export function ratio(value: string): Ratio {
  return roundDecimalString(value, RATIO_SCALE) as Ratio;
}

/** Build a points value from a plain decimal string. `'5.1'` → `'5.1000'`. */
export function points(value: string): Points {
  return roundDecimalString(value, POINTS_SCALE) as Points;
}

export const RATIO_ZERO: Ratio = ratio('0');
export const RATIO_ONE: Ratio = ratio('1');
export const POINTS_ZERO: Points = points('0');

/** The decimal engine: kernel `Quantity`, 18 places, half-even. */
function dec(value: string): QuantityType {
  return Quantity.of(value);
}

/** `numerator / denominator` as a ratio. Division by zero is the caller's bug. */
export function ratioOfQuotient(numerator: string, denominator: string): Ratio {
  if (Quantity.isZero(dec(denominator))) {
    throw new AnalyticsInputError('a ratio with a zero denominator is undefined, not zero');
  }
  return ratio(Quantity.divide(dec(numerator), dec(denominator)));
}

/**
 * `part / whole`, both money, same currency.
 *
 * Computed on minor units, which is exact: the scale cancels, so there is no
 * conversion to decimal dollars and no place for a rounding to hide.
 */
export function ratioOfMoney(part: MoneyType, whole: MoneyType): Ratio {
  assertSameCurrency(part, whole);
  return ratioOfQuotient(part.minor.toString(), whole.minor.toString());
}

export function addRatio(a: Ratio, b: Ratio): Ratio {
  return ratio(Quantity.add(dec(a), dec(b)));
}

export function subtractRatio(a: Ratio, b: Ratio): Ratio {
  return ratio(Quantity.subtract(dec(a), dec(b)));
}

export function multiplyRatio(a: Ratio, b: Ratio): Ratio {
  return ratio(Quantity.multiply(dec(a), dec(b)));
}

export function compareRatio(a: Ratio, b: Ratio): -1 | 0 | 1 {
  return Quantity.compare(dec(a), dec(b));
}

export function sumRatios(values: Iterable<Ratio>): Ratio {
  let total = Quantity.zero;
  for (const value of values) total = Quantity.add(total, dec(value));
  return ratio(total);
}

/** A ratio as percentage points: `'0.0512'` → `'5.1200'`. */
export function ratioToPoints(value: Ratio): Points {
  return points(Quantity.multiply(dec(value), '100'));
}

/** `actual − target` in percentage points, signed. The drift primitive. */
export function pointsBetween(actual: Ratio, target: Ratio): Points {
  return ratioToPoints(subtractRatio(actual, target));
}

export function absolutePoints(value: Points): Points {
  return value.startsWith('-') ? (value.slice(1) as Points) : value;
}

export function comparePoints(a: Points, b: Points): -1 | 0 | 1 {
  return Quantity.compare(dec(a), dec(b));
}

/**
 * Lossy, and named so. Charts, sliders and confidence bars only; the result
 * must never flow back into a `Ratio`, a `Quantity` or a `Money`.
 */
export function ratioToNumberApproximate(value: Ratio): number {
  return Number(value);
}

/** Lossy, and named so. See {@link ratioToNumberApproximate}. */
export function pointsToNumberApproximate(value: Points): number {
  return Number(value);
}

/** `money × ratio`, rounded once, half-even, into minor units. */
export function scaleMoney(amount: MoneyType, factor: Ratio | string): MoneyType {
  return Money.multiplyByDecimal(amount, factor, 'half-even');
}

function assertSameCurrency(a: MoneyType, b: MoneyType): void {
  if (a.currency !== b.currency) {
    throw new AnalyticsInputError(`currency mismatch: ${a.currency} and ${b.currency}`);
  }
}

/**
 * Thrown for inputs analytics cannot answer *about* — a zero denominator, a
 * currency it was not given, dates out of order.
 *
 * Deliberately distinct from an *unavailable answer*: a missing basis, a
 * non-bracketing NPV and a stale price are all returned as data, because they
 * are facts about the portfolio the user needs to see. A thrown error here
 * means the caller built the question wrong.
 */
export class AnalyticsInputError extends Error {
  readonly code = 'investments.analytics_input';

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// ---------------------------------------------------------------------------
// Fractional powers, built from Quantity
// ---------------------------------------------------------------------------

/**
 * `ln 2` to 18 places — the reduction constant for both series below.
 *
 * Written out rather than computed because computing it needs the series it is
 * used to condition, and an 18-place constant is checkable by eye against any
 * reference.
 */
const LN2 = '0.693147180559945309';

/**
 * The largest exponent {@link decimalExp} will evaluate before saturating.
 *
 * `e^25 ≈ 7.2e10`, which leaves ten integer digits of headroom inside
 * `NUMERIC(38,18)` for the cash flow it multiplies. XIRR evaluates its NPV at
 * `r = -0.9999`, where the true discount factors overflow any fixed type; only
 * the *sign* of that evaluation is used (it is a bracket endpoint), and
 * saturating preserves it. Recorded in the evidence note rather than left as a
 * magic number.
 */
export const MAX_DECIMAL_EXPONENT = 25;

function decimalLn(value: QuantityType): QuantityType {
  if (Quantity.isNegative(value) || Quantity.isZero(value)) {
    throw new AnalyticsInputError('ln is undefined at or below zero');
  }
  // Range reduction: ln x = k·ln2 + ln(x/2^k), with x/2^k pulled into
  // [2/3, 4/3] where the atanh series converges in ~25 terms.
  let k = 0;
  let m = value;
  while (Quantity.compare(m, dec('1.333333333333333333')) > 0) {
    m = Quantity.divide(m, '2');
    k += 1;
  }
  while (Quantity.compare(m, dec('0.666666666666666666')) < 0) {
    m = Quantity.multiply(m, '2');
    k -= 1;
  }

  // ln m = 2·atanh(z), z = (m−1)/(m+1).
  const z = Quantity.divide(Quantity.subtract(m, dec('1')), Quantity.add(m, dec('1')));
  const zSquared = Quantity.multiply(z, z);
  let term = z;
  let total = z;
  for (let n = 1; n < 80; n += 1) {
    term = Quantity.multiply(term, zSquared);
    const contribution = Quantity.divide(term, String(2 * n + 1));
    if (Quantity.isZero(contribution)) break;
    total = Quantity.add(total, contribution);
  }
  const lnMantissa = Quantity.multiply(total, '2');
  return Quantity.add(Quantity.multiply(dec(LN2), String(k)), lnMantissa);
}

function powerOfTwo(exponent: number): QuantityType {
  let result = dec('1');
  const magnitude = Math.abs(exponent);
  for (let i = 0; i < magnitude; i += 1) {
    result = exponent > 0 ? Quantity.multiply(result, '2') : Quantity.divide(result, '2');
  }
  return result;
}

function decimalExp(value: QuantityType): QuantityType {
  // Saturate rather than overflow `NUMERIC(38,18)`; see MAX_DECIMAL_EXPONENT.
  const ceiling = dec(String(MAX_DECIMAL_EXPONENT));
  const floor = Quantity.negate(ceiling);
  const clamped =
    Quantity.compare(value, ceiling) > 0
      ? ceiling
      : Quantity.compare(value, floor) < 0
        ? floor
        : value;

  // Range reduction: e^y = 2^k · e^r with r = y − k·ln2, |r| ≤ ln2/2.
  const k = Number(roundToIntegerString(Quantity.divide(clamped, LN2)));
  const remainder = Quantity.subtract(clamped, Quantity.multiply(dec(LN2), String(k)));

  let term = dec('1');
  let total = dec('1');
  for (let n = 1; n < 80; n += 1) {
    term = Quantity.divide(Quantity.multiply(term, remainder), String(n));
    if (Quantity.isZero(term)) break;
    total = Quantity.add(total, term);
  }
  return Quantity.multiply(total, powerOfTwo(k));
}

function roundToIntegerString(value: QuantityType): string {
  return roundDecimalString(value, 0);
}

/**
 * `base ^ exponent` for `base > 0`, over decimal strings.
 *
 * `(1 + TWR)^(365/days)` and `(1 + r)^(-days/365)` are the only two callers,
 * and both need a fractional exponent no integer power can serve. Accurate to
 * better than 1e-15 relative, which is five orders of magnitude finer than
 * {@link RATIO_SCALE}; `src/analytics/types.test.ts` pins it against exact
 * cases (`1.21^0.5 = 1.1`) and against `x^1 = x`.
 */
export function decimalPow(base: string, exponent: string): string {
  const b = dec(base);
  const e = dec(exponent);
  if (Quantity.isZero(e)) return '1';
  if (Quantity.isZero(b)) return '0';
  return decimalExp(Quantity.multiply(decimalLn(b), e));
}

/**
 * `(1 + rate)^years`, the growth factor both return engines discount with.
 *
 * `years` may be negative (a discount factor); the saturation in
 * {@link decimalExp} applies and is deliberate.
 */
export function growthFactor(onePlusRate: string, years: string): string {
  return decimalPow(onePlusRate, years);
}

/** ACT/365 fixed, as 07 §4.2's formulas are written. */
export const DAYS_PER_YEAR = 365;

/** Years between two dates on ACT/365, as a decimal string. */
export function yearsBetween(from: DateOnlyType, to: DateOnlyType): string {
  return Quantity.divide(dec(String(DateOnly.differenceInDays(from, to))), String(DAYS_PER_YEAR));
}

// ---------------------------------------------------------------------------
// The return shapes
// ---------------------------------------------------------------------------

/** Why an annualised figure was withheld. Never a silent absence. */
export const ANNUALIZATION_WITHHELD_REASONS = ['period_under_one_year'] as const;
export type AnnualizationWithheldReason = (typeof ANNUALIZATION_WITHHELD_REASONS)[number];

/**
 * 07 §4.2, verbatim: *"account opened this month (annualizing a 3-week return
 * to 400% is a classic embarrassing bug — **do not annualize < 1 year**)"*.
 *
 * One constant, one comparison, two engines. The sabotage that proves it is
 * live — deleting this guard — turns `'a nine-month return is not annualized'`
 * red.
 */
export const MIN_ANNUALIZATION_DAYS = 365;

export function annualizationWithheldFor(spanDays: number): AnnualizationWithheldReason | null {
  return spanDays < MIN_ANNUALIZATION_DAYS ? 'period_under_one_year' : null;
}

/** One linked sub-period of a TWR, kept so the number can be audited. */
export interface SubPeriodReturn {
  readonly from: DateOnlyType;
  readonly to: DateOnlyType;
  readonly beginValue: MoneyType;
  readonly endValue: MoneyType;
  /** The external flow that closes this sub-period. Positive = into the portfolio. */
  readonly flow: MoneyType;
  readonly returnRatio: Ratio;
}

export const TWR_WARNING_CODES = [
  'zero_base_subperiod',
  'modified_dietz_fallback',
  'valuation_dates_missing',
] as const;
export type TwrWarningCode = (typeof TWR_WARNING_CODES)[number];

export interface AnalyticsWarning {
  readonly code: TwrWarningCode;
  readonly detail: string;
}

/**
 * "Did my investments do well, and against what?" — comparable to a benchmark,
 * blind to when money arrived, **and carrying no dollar amount at all.**
 *
 * The `never` fields are the enforcement. They are not documentation.
 */
export interface TimeWeightedReturn {
  readonly kind: 'time_weighted';
  readonly periodReturn: Ratio;
  /** `null` below one year. 07 §4.2 forbids the alternative. */
  readonly annualized: Ratio | null;
  readonly annualizationWithheld: AnnualizationWithheldReason | null;
  readonly spanDays: number;
  readonly from: DateOnlyType;
  readonly to: DateOnlyType;
  /** Sub-period linking, or the flagged Modified Dietz fallback. */
  readonly method: 'sub_period_linking' | 'modified_dietz';
  /** 07 §4.2: Modified Dietz is *"flagged `approximate` in the UI"*. */
  readonly approximate: boolean;
  readonly subPeriods: readonly SubPeriodReturn[];
  readonly warnings: readonly AnalyticsWarning[];
  /** Always true, and the only shape for which it is. */
  readonly benchmarkComparable: true;
  /** 07 §4.2: never beside a dollar gain. Structurally impossible, not advised. */
  readonly gain?: never;
  readonly dollarGain?: never;
  readonly marketValue?: never;
  readonly costBasis?: never;
}

export const MWR_UNAVAILABLE_REASONS = [
  'no_sign_change_in_flows',
  'no_bracket',
  'did_not_converge',
  'single_flow',
] as const;
export type MwrUnavailableReason = (typeof MWR_UNAVAILABLE_REASONS)[number];

/** Which solver produced the accepted iterate. Reported, not inferred. */
export type XirrSolver = 'newton' | 'bisection';

export interface XirrDiagnostics {
  readonly solver: XirrSolver;
  readonly newtonSteps: number;
  readonly bisectionSteps: number;
  /**
   * A Newton step left the bracket (or the derivative vanished) and was
   * replaced by a bisection step. 07 §4.2: *"Newton alone diverges on
   * sign-flipping flows."*
   */
  readonly newtonDiverged: boolean;
  /** `|NPV(r)|` at the answer, in the flows' currency, as a decimal string. */
  readonly residual: string;
}

/**
 * "How much did I actually make, given when I put money in?" — **not**
 * comparable to a benchmark, and carrying no dollar amount either.
 *
 * `benchmark?: never` is the second half of 07 §4.2's rule: a caller cannot
 * attach an index return to this object, so no chart can draw the comparison
 * the rule forbids.
 */
export type MoneyWeightedReturn =
  | {
      readonly kind: 'money_weighted';
      readonly status: 'available';
      readonly periodReturn: Ratio;
      /** `null` below one year — an XIRR *is* an annual rate, so it is withheld. */
      readonly annualized: Ratio | null;
      readonly annualizationWithheld: AnnualizationWithheldReason | null;
      readonly spanDays: number;
      readonly from: DateOnlyType;
      readonly to: DateOnlyType;
      readonly diagnostics: XirrDiagnostics;
      readonly benchmarkComparable: false;
      readonly benchmark?: never;
      readonly gain?: never;
      readonly dollarGain?: never;
    }
  | {
      readonly kind: 'money_weighted';
      /** 07 §4.2: *"no sign change: undefined, show 'n/a'"* — never a 0. */
      readonly status: 'unavailable';
      readonly reason: MwrUnavailableReason;
      readonly detail: string;
      readonly spanDays: number;
      readonly benchmarkComparable: false;
      readonly benchmark?: never;
      readonly periodReturn?: never;
      readonly annualized?: never;
      readonly gain?: never;
    };

export const GAIN_UNAVAILABLE_REASONS = [
  'basis_unknown',
  'price_unknown',
  'currency_mismatch',
] as const;
export type GainUnavailableReason = (typeof GAIN_UNAVAILABLE_REASONS)[number];

/**
 * "How many dollars?" — money, never a ratio, and never benchmarkable.
 *
 * Propagates WP 3.2's rule unchanged: one position without a basis makes the
 * portfolio gain `unavailable`, carrying the market value (which *is* knowable)
 * and the ids that caused it. A zero would be a fabricated gain of the entire
 * position, and would look exactly like a real one.
 */
export type DollarGain =
  | {
      readonly kind: 'dollar_gain';
      readonly status: 'available';
      readonly gain: MoneyType;
      readonly marketValue: MoneyType;
      readonly costBasis: MoneyType;
      readonly periodReturn?: never;
      readonly annualized?: never;
      readonly benchmarkComparable?: never;
    }
  | {
      readonly kind: 'dollar_gain';
      readonly status: 'unavailable';
      readonly reason: GainUnavailableReason;
      readonly warning: string;
      /** Knowable even when the cost is not. `null` only when a price is missing. */
      readonly marketValue: MoneyType | null;
      readonly positionIds: readonly string[];
      readonly gain?: never;
      readonly costBasis?: never;
      readonly periodReturn?: never;
      readonly benchmarkComparable?: never;
    };

/**
 * The three answers, in three fields.
 *
 * WP 3.9 serialises this shape; because the shapes are disjoint, the wire
 * format inherits the rule without re-stating it.
 */
export interface PerformanceReport {
  readonly timeWeighted: TimeWeightedReturn;
  readonly moneyWeighted: MoneyWeightedReturn;
  readonly dollarGain: DollarGain;
}

export const UNKNOWN_BASIS_PORTFOLIO_WARNING =
  'Some positions have no cost basis, so this portfolio gain is unavailable rather than computed from zero.';

export const UNKNOWN_PRICE_PORTFOLIO_WARNING =
  'Some positions have no price, so this portfolio value and gain are unavailable.';

/** A valued position, as every analytics function consumes it. */
export interface ValuedPosition {
  readonly id: string;
  /** `null` when no usable price existed — never a zero. */
  readonly marketValue: MoneyType | null;
  /** `null` when the basis is unknown — WP 3.2's rule, carried. */
  readonly costBasis: MoneyType | null;
}

/**
 * Portfolio-level dollar gain, with WP 3.2's never-zero rule propagated.
 *
 * `src/analytics/types.test.ts` → `'an unavailable basis makes the gain
 * unavailable, not zero'`.
 */
export function portfolioDollarGain(
  positions: readonly ValuedPosition[],
  currency: CurrencyCode,
): DollarGain {
  const unpriced = positions.filter((position) => position.marketValue === null);
  if (unpriced.length > 0) {
    return {
      kind: 'dollar_gain',
      status: 'unavailable',
      reason: 'price_unknown',
      warning: UNKNOWN_PRICE_PORTFOLIO_WARNING,
      marketValue: null,
      positionIds: unpriced.map((position) => position.id),
    };
  }

  let marketValue = Money.zero(currency);
  for (const position of positions) {
    const value = position.marketValue;
    if (value === null) continue;
    if (value.currency !== currency) {
      return {
        kind: 'dollar_gain',
        status: 'unavailable',
        reason: 'currency_mismatch',
        warning: `A position is denominated in ${value.currency}, not ${currency}.`,
        marketValue: null,
        positionIds: [position.id],
      };
    }
    marketValue = Money.add(marketValue, value);
  }

  const withoutBasis = positions.filter((position) => position.costBasis === null);
  if (withoutBasis.length > 0) {
    return {
      kind: 'dollar_gain',
      status: 'unavailable',
      reason: 'basis_unknown',
      warning: UNKNOWN_BASIS_PORTFOLIO_WARNING,
      marketValue,
      positionIds: withoutBasis.map((position) => position.id),
    };
  }

  let costBasis = Money.zero(currency);
  for (const position of positions) {
    const basis = position.costBasis;
    if (basis === null) continue;
    if (basis.currency !== currency) {
      return {
        kind: 'dollar_gain',
        status: 'unavailable',
        reason: 'currency_mismatch',
        warning: `A cost basis is denominated in ${basis.currency}, not ${currency}.`,
        marketValue,
        positionIds: [position.id],
      };
    }
    costBasis = Money.add(costBasis, basis);
  }

  return {
    kind: 'dollar_gain',
    status: 'available',
    gain: Money.subtract(marketValue, costBasis),
    marketValue,
    costBasis,
  };
}

// ---------------------------------------------------------------------------
// The holding vocabulary allocation, drift, fees, concentration and cash share
// ---------------------------------------------------------------------------

/**
 * One holding, as analytics needs it: already resolved, already classified,
 * already priced by WP 3.4's ladder.
 *
 * Nothing here reads a database or a price source. Every field a decision
 * depends on — including *how stale the price is* — is an explicit input, which
 * is what makes the whole module testable against a committed spreadsheet.
 */
export interface AnalyticsHolding {
  readonly holdingId: string;
  readonly accountId: string;
  readonly securityId: string;
  /** For display and for `'{ticker} is {p}% of your portfolio'`. */
  readonly symbol: string | null;
  readonly quantity: QuantityType;
  /** `null` when the ladder had no answer at all. Never a zero. */
  readonly price: LotPrice | null;
  /** WP 3.4's read-time verdict, passed in rather than re-derived here. */
  readonly staleness: PriceStaleness;
  readonly assetClass: AssetClass;
  readonly region: Region;
  readonly sector: string;
  /** Decimal string, e.g. `'0.0003'` for 3bp. `null` = unknown, never 0. */
  readonly expenseRatio: string | null;
  readonly isCashEquivalent: boolean;
  /** 07 §4.1's fourth boolean: the concentration denominator. */
  readonly isInvestable: boolean;
  /** `null` when WP 3.2 could not derive one. Carried, never zeroed. */
  readonly costBasis: MoneyType | null;
}

/** Why a holding was left out of an allocation denominator. */
export const EXCLUSION_REASONS = ['stale_price', 'price_unknown', 'currency_mismatch'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExcludedHolding {
  readonly holdingId: string;
  readonly symbol: string | null;
  readonly reason: ExclusionReason;
}

/**
 * Which clock a number is answered against.
 *
 * `as_of_now` honours 07 §6.1 — *"if last price > 24h old, mark the holding
 * STALE and exclude from 'as of now' deltas"* — and therefore drops STALE
 * holdings from both numerator and denominator, reporting them in `excluded`.
 * `last_known` keeps them, which is what a sealed net-worth day does (08 §3.7),
 * and flags them instead.
 */
export type ValuationBasis = 'as_of_now' | 'last_known';

/** Minor-unit scale of the reporting currency, passed in rather than assumed. */
export interface ValuationOptions {
  readonly currency: CurrencyCode;
  readonly scale: number;
  readonly basis: ValuationBasis;
}
