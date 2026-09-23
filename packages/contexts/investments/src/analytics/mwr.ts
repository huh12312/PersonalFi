// SPDX-License-Identifier: MIT
/**
 * Money-weighted return — the XIRR of a portfolio's own cash flows, wrapped in
 * the shape that keeps it away from a benchmark.
 *
 * 07 §4.2's table is the whole design:
 *
 * | Question | Metric | Where |
 * |---|---|---|
 * | "How much did I actually make?" | **MWR (XIRR)** | Headline on the portfolio page |
 * | "Did my *investments* do well, vs the index?" | **TWR** | Next to any benchmark |
 *
 * An MWR includes the user's own timing — deposit before a rally and it is
 * high, deposit before a drawdown and it is low, with the same underlying
 * investments. That makes it the honest answer to "how did *I* do" and a
 * meaningless thing to put beside an index return, because the index had no
 * deposits. `MoneyWeightedReturn` therefore declares `benchmark?: never` and
 * `benchmarkComparable: false`; there is no field to attach the comparison to.
 *
 * ## Sign convention, converted once, here
 *
 * The portfolio's own convention is **positive = into the portfolio** (a
 * deposit), matching `twr.ts`. XIRR's convention is the investor's: money
 * leaving the investor's pocket is **negative**, money coming back is
 * positive. They are opposite, so this file inverts exactly once, at this
 * boundary, and says so — two files each inverting "just to be safe" is the
 * top-three financial-app bug 04 §2.3 names.
 *
 * The opening value becomes a negative flow (capital already committed at the
 * start) and the closing value a positive one (what could be realised at the
 * end). Without the closing value a portfolio that only ever received deposits
 * has no sign change and the answer is `n/a` — which is correct, and is what
 * `'flows with no sign change return n/a rather than a number'` pins.
 *
 * ## Never annualised under a year
 *
 * An XIRR *is* an annual rate: discounting on `days/365` is what makes it one.
 * So for a span under {@link MIN_ANNUALIZATION_DAYS} the solve is done on the
 * **period** instead (`periodDays = spanDays`), which yields the return of
 * that period and nothing else. `annualized` is `null`,
 * `annualizationWithheld` says why, and there is no code path that compounds a
 * nine-month 8% into 10.8%.
 */
import { DateOnly, Money, Quantity, type Money as MoneyType } from '@core/kernel';
import type { DatedValuation, ExternalFlow } from './twr.ts';
import {
  AnalyticsInputError,
  DAYS_PER_YEAR,
  MIN_ANNUALIZATION_DAYS,
  annualizationWithheldFor,
  decimalPow,
  ratio,
  type MoneyWeightedReturn,
  type Ratio,
} from './types.ts';
import { xirr, type DatedCashFlow, type XirrOptions } from './xirr.ts';

export interface MwrInput {
  /** What the portfolio was worth at the start. Omit for an account opened empty. */
  readonly openingValue?: DatedValuation;
  /** External flows, **positive = into the portfolio**, as `twr.ts` takes them. */
  readonly flows: readonly ExternalFlow[];
  /** What the portfolio is worth at the end. Required: without it there is no return. */
  readonly closingValue: DatedValuation;
}

/**
 * The money-weighted return of one portfolio.
 *
 * Takes the same two inputs as {@link timeWeightedReturn} — valuations and
 * flows — so a caller can hand both engines the same portfolio and get the two
 * different, both-correct answers `'the same flows give a materially different
 * MWR'` demonstrates.
 */
export function moneyWeightedReturn(
  input: MwrInput,
  options: Pick<XirrOptions, 'guess'> = {},
): MoneyWeightedReturn {
  const cashFlows = cashFlowsOf(input);
  const first = cashFlows[0];
  const last = cashFlows[cashFlows.length - 1];
  if (first === undefined || last === undefined) {
    throw new AnalyticsInputError('a money-weighted return needs at least one dated value');
  }
  const from = first.date;
  const to = last.date;
  const spanDays = DateOnly.differenceInDays(from, to);
  if (spanDays <= 0) {
    throw new AnalyticsInputError('the closing valuation must be later than the first cash flow');
  }

  const annualise = spanDays >= MIN_ANNUALIZATION_DAYS;
  const solverOptions: XirrOptions = annualise
    ? { ...options }
    : { ...options, periodDays: spanDays };
  const outcome = xirr(cashFlows, solverOptions);

  if (outcome.status === 'unavailable') {
    return {
      kind: 'money_weighted',
      status: 'unavailable',
      reason: outcome.reason,
      detail: outcome.detail,
      spanDays,
      benchmarkComparable: false,
    };
  }

  // Above a year the solved rate *is* the annual rate, and the period return is
  // that rate compounded over the span. Below a year the solved rate is the
  // period return and there is no annual rate to report at all.
  const periodReturn = annualise ? annualizedToPeriod(outcome.rate, spanDays) : outcome.rate;
  return {
    kind: 'money_weighted',
    status: 'available',
    periodReturn,
    annualized: annualise ? outcome.rate : null,
    annualizationWithheld: annualizationWithheldFor(spanDays),
    spanDays,
    from,
    to,
    diagnostics: outcome.diagnostics,
    benchmarkComparable: false,
  };
}

/**
 * The portfolio's flows in XIRR's sign convention, ordered by date.
 *
 * Exported because the evidence note walks the exact series that produced the
 * reported rate, and reconstructing it by hand from prose is how an evidence
 * table stops matching the code.
 */
export function cashFlowsOf(input: MwrInput): readonly DatedCashFlow[] {
  const currency = input.closingValue.value.currency;
  const flows: DatedCashFlow[] = [];

  if (input.openingValue !== undefined) {
    assertCurrency(input.openingValue.value, currency);
    flows.push({ date: input.openingValue.date, amount: Money.negate(input.openingValue.value) });
  }
  for (const flow of input.flows) {
    assertCurrency(flow.amount, currency);
    // The one inversion: into the portfolio is out of the investor's pocket.
    flows.push({ date: flow.date, amount: Money.negate(flow.amount) });
  }
  flows.push({ date: input.closingValue.date, amount: input.closingValue.value });

  return flows.sort((a, b) => DateOnly.compare(a.date, b.date));
}

function assertCurrency(amount: MoneyType, currency: string): void {
  if (amount.currency !== currency) {
    throw new AnalyticsInputError(
      `a ${amount.currency} amount cannot join a ${currency} money-weighted return`,
    );
  }
}

/**
 * `(1 + annual)^(span/365) − 1` — the annual rate expressed over the span it
 * was measured on.
 *
 * Reported beside the annual rate rather than instead of it, because "you made
 * 21% over the fourteen months" and "that is a 17.8% annual rate" are both
 * true and a reader given only one of them will assume the other.
 */
function annualizedToPeriod(annualRate: Ratio, spanDays: number): Ratio {
  const growth = Quantity.add(Quantity.of('1'), Quantity.of(annualRate));
  if (Quantity.isNegative(growth) || Quantity.isZero(growth)) return annualRate;
  const exponent = Quantity.divide(Quantity.of(String(spanDays)), String(DAYS_PER_YEAR));
  return ratio(Quantity.subtract(Quantity.of(decimalPow(growth, exponent)), Quantity.of('1')));
}
