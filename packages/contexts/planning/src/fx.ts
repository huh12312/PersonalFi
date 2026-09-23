// SPDX-License-Identifier: MIT
/**
 * D4, applied on the aggregate and never on read.
 *
 * > "dual native+base storage with a historical FX rate on aggregates"
 *
 * The bug this file exists to prevent is subtle enough to be worth spelling
 * out. If `net_worth_daily` stored only a native amount and the API converted
 * at read time, then a CAD balance from March 2024 would be worth whatever CAD
 * is worth *today* — so the March point on the chart would move every time the
 * currency market did, and the "trend" the user is looking at would be partly a
 * trend in the exchange rate. Storing `baseMinor` together with the `fxRate`
 * and `fxRateDate` that produced it makes the March point a fact about March.
 *
 * The second rule is 08 §6.6's, and it is the one with teeth: **a missing rate
 * is never 1.0.** `FxRateUnavailable` propagates out of this module untouched —
 * there is no `catch` in this file and no default parameter anywhere that could
 * become one. `'a missing rate raises FxRateUnavailable and never returns 1.0'`
 * is the §5 exit criterion, and it is sabotage-tested twice: once by removing
 * the rate, and once by handing the engine a reader that *answers* 1.0 for a
 * cross pair, which `assertRateIsAnObservation` below refuses.
 */
import { FxRateUnavailable } from '@ctx/investments';
import { Money, money } from '@core/kernel';
import type { FxQuote, FxReader } from './ports.ts';

/**
 * One account's contribution, in both currencies, with the provenance that
 * connects them. This is exactly the D4 half of a `breakdown` entry.
 */
export interface ConvertedAmount {
  /** The account's own currency. */
  readonly currency: string;
  /** Minor units in `currency`. */
  readonly nativeMinor: bigint;
  /** The same amount in the snapshot's base currency. */
  readonly baseMinor: bigint;
  /** The rate used, as an exact decimal string. */
  readonly fxRate: string;
  /** The date of the observation the rate came from — **not** the date asked for. */
  readonly fxRateDate: string;
}

/**
 * Refuse a quote that is a tautology dressed as an observation.
 *
 * `@ctx/investments`' reader answers `source: 'identity'` only when the two
 * currency codes are literally equal, and that is the one legitimate 1.0 in the
 * system. Any *other* reader — a fake, a future adapter, a well-meaning
 * fallback somebody adds in a hurry — claiming the identity for a genuine cross
 * pair is the exact failure D4 names, so it dies here by name rather than
 * becoming a number in a chart.
 *
 * This is deliberately a check on the *provenance* and not on the value. A
 * genuine EUR/CHF observation of exactly 1.0 is possible and is fine; a
 * USD/CAD conversion that no row backs is not, whatever number it carries.
 */
export function assertRateIsAnObservation(quote: FxQuote, from: string, to: string): void {
  if (from === to) return;
  if (quote.source === 'identity') {
    throw new FxRateUnavailable(from, to, quote.rateDate, [
      `${from}/${to}`,
      `${to}/${from} (inverted)`,
    ]);
  }
}

/**
 * Convert one account's native amount into the snapshot's base currency.
 *
 * @throws {FxRateUnavailable} when the pair has no observation on or before
 *   `date`, in either direction. The caller does not catch it: 08 §6.6's
 *   affordance is a manual rate entry in the UI, and a day written with one
 *   account silently missing would be worse than a day not written.
 */
export async function convertToBase(
  fx: FxReader,
  input: {
    readonly nativeMinor: bigint;
    readonly currency: string;
    readonly baseCurrency: string;
    readonly date: string;
  },
): Promise<ConvertedAmount> {
  const from = input.currency.trim().toUpperCase();
  const to = input.baseCurrency.trim().toUpperCase();

  const quote = await fx.rate(from, to, input.date);
  assertRateIsAnObservation(quote, from, to);

  // `Money.multiplyByDecimal` is exact decimal over bigint — the factor is
  // parsed into an unscaled integer and a scale, never into a float — so a rate
  // like 0.7412 cannot introduce the half-cent drift that `Number(rate) * minor`
  // would. Banker's rounding is the default and is what the rest of the app
  // uses; a net worth is a sum of many conversions and half-even is the one
  // mode that does not bias the total upward.
  const base = Money.multiplyByDecimal(money(input.nativeMinor, from), quote.rate);

  return {
    currency: from,
    nativeMinor: input.nativeMinor,
    baseMinor: base.minor,
    fxRate: quote.rate,
    // The date of the *observation*, per D4 and `FxRate.rateDate`'s own doc:
    // recording `input.date` would make a Friday rate claim to be a Sunday one.
    fxRateDate: quote.rateDate,
  };
}

export { FxRateUnavailable, isFxRateUnavailable } from '@ctx/investments';
