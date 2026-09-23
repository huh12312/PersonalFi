// SPDX-License-Identifier: MIT
/**
 * Time-weighted return: 07 §4.2's sub-period linking, with Modified Dietz as
 * the explicitly-flagged `approximate` fallback.
 *
 * ```
 * Split [t0, t1] at each external cash flow date into sub-periods j.
 * r_j = (MV_end,j − CF_j) / MV_begin,j − 1
 * TWR = Π_j (1 + r_j) − 1
 * Annualized: (1 + TWR)^(365 / days) − 1     # only for periods >= 1 year
 * ```
 *
 * ## What TWR is for, and the one thing it must not be beside
 *
 * TWR answers *"did my investments do well?"* by removing the effect of when
 * money arrived — which is exactly why it is the number you may compare to an
 * index, and exactly why it must never sit next to a dollar gain. That rule is
 * enforced by the shape this function returns, not by this comment: see
 * `types.ts`.
 *
 * ## The cash-flow convention, stated once
 *
 * `r_j = (MV_end,j − CF_j)/MV_begin,j − 1` subtracts the flow from the *end*
 * value, so the flow is treated as landing at the **end of the sub-period it
 * closes**, after that date's valuation. Concretely: a $100,000 deposit on
 * 1 July, with the portfolio worth $120,000 before it, means the 1 July
 * valuation is **$220,000** and `CF = +$100,000`. The sub-period return is
 * `(220,000 − 100,000)/100,000 − 1 = 20%` — the deposit contributes nothing,
 * which is the entire point of the metric and what
 * `'a mid-period deposit does not change TWR'` asserts.
 *
 * Sign: **positive = into the portfolio** (a deposit), negative = a withdrawal.
 * That is the house convention (04 §2.3, "negative = outflow") read from the
 * portfolio's side, and it is asserted at this boundary rather than assumed.
 *
 * ## When the daily prices are not there
 *
 * Sub-period linking needs a valuation on every flow date. A CSV-imported
 * account has monthly statements and a deposit on the 12th, so it cannot have
 * one. 07 §4.2's answer is Modified Dietz —
 * `R = (EMV − BMV − ΣCF) / (BMV + Σ w_i·CF_i)`, `w_i = (D − d_i)/D` — *"only
 * when daily prices are missing; flag the number `approximate` in the UI."*
 * So the fallback is automatic, it is labelled `method: 'modified_dietz'` and
 * `approximate: true`, and it carries a warning naming the dates that forced
 * it. A caller that would rather fail than approximate passes
 * `allowApproximateFallback: false` and gets an `AnalyticsInputError`.
 */
import {
  DateOnly,
  Money,
  Quantity,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import {
  AnalyticsInputError,
  DAYS_PER_YEAR,
  MIN_ANNUALIZATION_DAYS,
  annualizationWithheldFor,
  decimalPow,
  ratio,
  type AnalyticsWarning,
  type Ratio,
  type SubPeriodReturn,
  type TimeWeightedReturn,
} from './types.ts';

/** A portfolio valuation on a date. `NUMERIC`-backed money, never a float. */
export interface DatedValuation {
  readonly date: DateOnlyType;
  readonly value: MoneyType;
}

/** An external cash flow. **Positive = into the portfolio.** */
export interface ExternalFlow {
  readonly date: DateOnlyType;
  readonly amount: MoneyType;
}

export interface TwrInput {
  /** At least two, including one on the first and last date of the period. */
  readonly valuations: readonly DatedValuation[];
  /** May be empty. Flows on the same date are netted before linking. */
  readonly flows: readonly ExternalFlow[];
}

export interface TwrOptions {
  /**
   * Whether a missing valuation on a flow date may fall back to Modified
   * Dietz. Default `true`, flagged `approximate` when it happens.
   */
  readonly allowApproximateFallback?: boolean;
}

/**
 * Time-weighted return over the span the valuations cover.
 *
 * Throws `AnalyticsInputError` only for a malformed question (fewer than two
 * valuations, mixed currencies, a flow outside the period, two different
 * valuations for one date). Everything else is answered as data.
 */
export function timeWeightedReturn(input: TwrInput, options: TwrOptions = {}): TimeWeightedReturn {
  const valuations = sortedValuations(input.valuations);
  const first = valuations[0];
  const last = valuations[valuations.length - 1];
  if (first === undefined || last === undefined || valuations.length < 2) {
    throw new AnalyticsInputError('a time-weighted return needs at least two valuations');
  }
  const currency = first.value.currency;
  for (const valuation of valuations) {
    if (valuation.value.currency !== currency) {
      throw new AnalyticsInputError(
        `valuations mix ${currency} and ${valuation.value.currency}; convert before measuring return`,
      );
    }
  }

  const from = first.date;
  const to = last.date;
  const spanDays = DateOnly.differenceInDays(from, to);
  if (spanDays <= 0) {
    throw new AnalyticsInputError('the last valuation must be later than the first');
  }

  const netFlows = netFlowsByDate(input.flows, { from, to, currency });
  const valuationByDate = new Map(valuations.map((valuation) => [valuation.date, valuation.value]));

  const missing = [...netFlows.keys()].filter((date) => !valuationByDate.has(date));
  if (missing.length > 0) {
    if (options.allowApproximateFallback === false) {
      throw new AnalyticsInputError(
        `no valuation on flow date(s) ${missing.join(', ')}; pass allowApproximateFallback to accept Modified Dietz`,
      );
    }
    return modifiedDietzReturn(
      { valuations, flows: input.flows },
      {
        code: 'valuation_dates_missing',
        detail: `no valuation on ${missing.join(', ')}, so the linked calculation is unavailable`,
      },
    );
  }

  const boundaries = [...netFlows.keys()].sort(DateOnly.compare);
  if (boundaries[boundaries.length - 1] !== to) boundaries.push(to);

  const warnings: AnalyticsWarning[] = [];
  const subPeriods: SubPeriodReturn[] = [];
  let linked = Quantity.of('1');
  let beginDate = from;

  for (const boundary of boundaries) {
    const beginValue = valuationByDate.get(beginDate);
    const endValue = valuationByDate.get(boundary);
    if (beginValue === undefined || endValue === undefined) {
      // Unreachable: every boundary is a flow date (checked above) or `to`.
      throw new AnalyticsInputError(`no valuation for sub-period boundary ${boundary}`);
    }
    const flow = netFlows.get(boundary) ?? Money.zero(currency);

    const subPeriodReturn = subPeriodReturnOf(beginValue, endValue, flow, warnings, {
      from: beginDate,
      to: boundary,
    });
    subPeriods.push({
      from: beginDate,
      to: boundary,
      beginValue,
      endValue,
      flow,
      returnRatio: subPeriodReturn,
    });
    linked = Quantity.multiply(
      linked,
      Quantity.add(Quantity.of('1'), Quantity.of(subPeriodReturn)),
    );
    beginDate = boundary;
  }

  const periodReturn = ratio(Quantity.subtract(linked, Quantity.of('1')));
  return {
    kind: 'time_weighted',
    periodReturn,
    annualized: annualizedOf(periodReturn, spanDays),
    annualizationWithheld: annualizationWithheldFor(spanDays),
    spanDays,
    from,
    to,
    method: 'sub_period_linking',
    approximate: false,
    subPeriods,
    warnings,
    benchmarkComparable: true,
  };
}

/**
 * `(1 + TWR)^(365/days) − 1`, **and only for a period of at least one year.**
 *
 * 07 §4.2: *"annualizing a 3-week return to 400% is a classic embarrassing
 * bug — do not annualize < 1 year."* Below the threshold the answer is `null`
 * and the caller is told why by `annualizationWithheld`; there is no
 * compounding path that can produce the 400%.
 */
export function annualizedOf(periodReturn: Ratio, spanDays: number): Ratio | null {
  if (spanDays < MIN_ANNUALIZATION_DAYS) return null;
  const growth = Quantity.add(Quantity.of('1'), Quantity.of(periodReturn));
  if (Quantity.isNegative(growth) || Quantity.isZero(growth)) {
    // A portfolio that went to zero or below has no annualised rate to state.
    return null;
  }
  const exponent = Quantity.divide(Quantity.of(String(DAYS_PER_YEAR)), String(spanDays));
  return ratio(Quantity.subtract(Quantity.of(decimalPow(growth, exponent)), Quantity.of('1')));
}

/**
 * Modified Dietz: `R = (EMV − BMV − ΣCF) / (BMV + Σ w_i·CF_i)`, `w_i = (D − d_i)/D`.
 *
 * Exported so the fallback can be exercised (and shown in the evidence note)
 * directly rather than only through a portfolio that happens to be missing a
 * valuation. Always returns `approximate: true`: there is no input for which
 * this function's answer is the exact time-weighted return, and a number
 * flagged only sometimes is a number nobody checks the flag on.
 */
export function modifiedDietzReturn(
  input: TwrInput,
  cause: AnalyticsWarning = {
    code: 'modified_dietz_fallback',
    detail: 'requested directly; daily valuations were not used',
  },
): TimeWeightedReturn {
  const valuations = sortedValuations(input.valuations);
  const first = valuations[0];
  const last = valuations[valuations.length - 1];
  if (first === undefined || last === undefined || valuations.length < 2) {
    throw new AnalyticsInputError('Modified Dietz needs a beginning and an ending valuation');
  }
  const currency = first.value.currency;
  const from = first.date;
  const to = last.date;
  const spanDays = DateOnly.differenceInDays(from, to);
  if (spanDays <= 0) {
    throw new AnalyticsInputError('the ending valuation must be later than the beginning one');
  }

  const netFlows = netFlowsByDate(input.flows, { from, to, currency });
  const beginValue = first.value;
  const endValue = last.value;

  let totalFlow = Money.zero(currency);
  let weightedFlow = Quantity.zero;
  for (const [date, amount] of netFlows) {
    totalFlow = Money.add(totalFlow, amount);
    const elapsed = DateOnly.differenceInDays(from, date);
    const weight = Quantity.divide(Quantity.of(String(spanDays - elapsed)), String(spanDays));
    weightedFlow = Quantity.add(
      weightedFlow,
      Quantity.multiply(Quantity.of(amount.minor.toString()), weight),
    );
  }

  const numerator = Quantity.of((endValue.minor - beginValue.minor - totalFlow.minor).toString());
  const denominator = Quantity.add(Quantity.of(beginValue.minor.toString()), weightedFlow);
  const warnings: AnalyticsWarning[] = [
    cause,
    {
      code: 'modified_dietz_fallback',
      detail:
        'Modified Dietz approximates the time-weighted return; it is exact only when no flow moved the portfolio between valuations.',
    },
  ];

  let periodReturn = ratio('0');
  if (Quantity.isZero(denominator)) {
    warnings.push({
      code: 'zero_base_subperiod',
      detail: 'the weighted beginning value is zero, so no return can be stated; reported as 0',
    });
  } else {
    periodReturn = ratio(Quantity.divide(numerator, denominator));
  }

  return {
    kind: 'time_weighted',
    periodReturn,
    annualized: annualizedOf(periodReturn, spanDays),
    annualizationWithheld: annualizationWithheldFor(spanDays),
    spanDays,
    from,
    to,
    method: 'modified_dietz',
    approximate: true,
    subPeriods: [
      {
        from,
        to,
        beginValue,
        endValue,
        flow: totalFlow,
        returnRatio: periodReturn,
      },
    ],
    warnings,
    benchmarkComparable: true,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function subPeriodReturnOf(
  beginValue: MoneyType,
  endValue: MoneyType,
  flow: MoneyType,
  warnings: AnalyticsWarning[],
  span: { readonly from: DateOnlyType; readonly to: DateOnlyType },
): Ratio {
  if (beginValue.minor === 0n) {
    // No capital was at risk, so the sub-period earned no *rate* — whatever the
    // flow did. Linking a 0% here is the only answer that leaves the product
    // unchanged; the alternative is a division by zero dressed up as a return.
    warnings.push({
      code: 'zero_base_subperiod',
      detail: `${span.from}..${span.to} began with a zero valuation; linked as 0%`,
    });
    return ratio('0');
  }
  // Minor units throughout: the currency scale cancels in the quotient, so
  // there is no decimal conversion and nowhere for a rounding to hide.
  const numerator = Quantity.of((endValue.minor - flow.minor).toString());
  const denominator = Quantity.of(beginValue.minor.toString());
  return ratio(Quantity.subtract(Quantity.divide(numerator, denominator), Quantity.of('1')));
}

function sortedValuations(valuations: readonly DatedValuation[]): readonly DatedValuation[] {
  const sorted = [...valuations].sort((a, b) => DateOnly.compare(a.date, b.date));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.date === current.date && !Money.equals(previous.value, current.value)) {
      throw new AnalyticsInputError(`two different valuations for ${current.date}`);
    }
  }
  return sorted;
}

/**
 * Net the flows per date and assert they fall inside the period.
 *
 * A flow on the first date would need a sub-period of zero length to land in,
 * and a flow after the last valuation has no valuation to be measured against;
 * both are questions about a period other than the one asked for.
 */
function netFlowsByDate(
  flows: readonly ExternalFlow[],
  period: { readonly from: DateOnlyType; readonly to: DateOnlyType; readonly currency: string },
): Map<DateOnlyType, MoneyType> {
  const netted = new Map<DateOnlyType, MoneyType>();
  for (const flow of flows) {
    if (flow.amount.currency !== period.currency) {
      throw new AnalyticsInputError(
        `a ${flow.amount.currency} flow cannot be linked into a ${period.currency} portfolio`,
      );
    }
    if (
      DateOnly.compare(flow.date, period.from) <= 0 ||
      DateOnly.compare(flow.date, period.to) > 0
    ) {
      throw new AnalyticsInputError(
        `flow dated ${flow.date} is outside (${period.from}, ${period.to}]`,
      );
    }
    const existing = netted.get(flow.date);
    netted.set(flow.date, existing === undefined ? flow.amount : Money.add(existing, flow.amount));
  }
  return new Map([...netted].sort(([a], [b]) => DateOnly.compare(a, b)));
}
