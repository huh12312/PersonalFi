// SPDX-License-Identifier: MIT
/**
 * Next-due prediction with an uncertainty band (07 §2.5).
 *
 * ```
 * next_date_raw = add_cadence(last_date, cadence)
 * next_date     = shift_to_business_day(next_date_raw)  if the merchant posts on business days
 * uncertainty   = ceil(1.5 * MAD(residuals)) clamped to [1, cadence.tol_days]
 * ```
 *
 * Three details that matter more than the formula:
 *
 *  * The next slot is taken from the **schedule anchored at the stream's
 *    anchor**, not from `last + period`. A stream that was three days late once
 *    must not have that lateness baked into every future prediction; the anchor
 *    is the thing the biller is actually working from.
 *  * The business-day shift is **learned, not assumed**: if the stream has ever
 *    posted on a Saturday or Sunday, this merchant evidently does, and shifting
 *    would make the forecast worse. Only streams that have never been seen on a
 *    weekend get shifted.
 *  * A band, not a point (07 §2.5, and 04's forecast requirement). The band is
 *    MAD-based so one retry three days late widens it by a day rather than
 *    doubling it.
 *
 * Expected amount follows the amount model: `FIXED` repeats the last amount;
 * `VARIABLE` takes the median of the last three and, with 13 months of history,
 * applies the same-month-last-year seasonality ratio (07 §2.5) — computed as an
 * exact decimal string and applied with `Money.multiplyByDecimal`, so no float
 * ever reaches an amount.
 */

import { DateOnly, Money } from '@core/kernel';
import { slotOf, specOf, uncertaintyDays } from './cadence.ts';
import { medianMinor } from './stats.ts';
import type { AmountModel, Cadence, NextDue, Occurrence } from './types.ts';

function isWeekend(date: DateOnly): boolean {
  const dow = DateOnly.dayOfWeek(date);
  return dow === 0 || dow === 6;
}

function shiftToBusinessDay(date: DateOnly): DateOnly {
  let shifted = date;
  while (isWeekend(shifted)) shifted = DateOnly.addDays(shifted, 1);
  return shifted;
}

/** The first scheduled slot strictly after `after`. */
export function nextSlotAfter(
  anchor: DateOnly,
  cadence: Cadence,
  after: DateOnly,
  dayOfMonthPair: readonly [number, number] | null,
): DateOnly {
  const spec = specOf(cadence);
  for (let index = 0; index < 4_000; index += 1) {
    const slot = slotOf(anchor, spec, index, dayOfMonthPair);
    if (DateOnly.isAfter(slot, after)) return slot;
  }
  // Unreachable for any real history; a schedule always overtakes its own last hit.
  return DateOnly.addDays(after, spec.periodDays);
}

/** Ratio of two magnitudes as an exact decimal string with six places. */
function ratioString(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  const scaled = (numerator * 1_000_000n) / denominator;
  if (scaled <= 0n) return null;
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function expectedAmount(
  occurrences: readonly Occurrence[],
  model: AmountModel,
  nextDate: DateOnly,
): Money {
  const series = [...occurrences].sort((a, b) => DateOnly.compare(a.date, b.date));
  const last = series[series.length - 1] as Occurrence;
  if (model === 'FIXED') return last.amount;

  const code = last.amount.currency;
  const recent = series.slice(-3).map((occurrence) => occurrence.amount.minor);
  const base = Money.of(medianMinor(recent), code);

  const spanDays = DateOnly.differenceInDays((series[0] as Occurrence).date, last.date);
  if (spanDays < 396) return base;

  // 07 §2.5 seasonality: this month last year, relative to last year's median.
  const targetMonth = DateOnly.month(nextDate);
  const windowStart = DateOnly.addMonths(nextDate, -24);
  const lastYear = series.filter(
    (occurrence) =>
      DateOnly.isAfter(occurrence.date, windowStart) &&
      DateOnly.differenceInDays(occurrence.date, nextDate) >= 300,
  );
  const sameMonth = lastYear.filter(
    (occurrence) => DateOnly.month(occurrence.date) === targetMonth,
  );
  if (sameMonth.length === 0 || lastYear.length < 6) return base;

  const ratio = ratioString(
    magnitude(medianMinor(sameMonth.map((occurrence) => occurrence.amount.minor))),
    magnitude(medianMinor(lastYear.map((occurrence) => occurrence.amount.minor))),
  );
  return ratio === null ? base : Money.multiplyByDecimal(base, ratio, 'half-even');
}

export interface NextDueInputs {
  readonly occurrences: readonly Occurrence[];
  readonly cadence: Cadence;
  readonly anchorDate: DateOnly;
  readonly dayOfMonthPair: readonly [number, number] | null;
  readonly residualDays: readonly number[];
  readonly amountModel: AmountModel;
  /**
   * Which schedule slot the last occurrence matched, when the fit knows.
   *
   * Without it, a charge that posted a day *early* makes "the first slot after
   * the last charge" the slot that charge already paid: a stream last seen on
   * 2026-08-25 against a 26th-of-the-month schedule would be reported as next
   * due 2026-08-26, a day in the past, for the period it had already settled.
   */
  readonly lastMatchedSlotIndex?: number | null;
}

export function predictNextDue(inputs: NextDueInputs): NextDue | null {
  if (inputs.occurrences.length === 0) return null;
  const series = [...inputs.occurrences].sort((a, b) => DateOnly.compare(a.date, b.date));
  const last = series[series.length - 1] as Occurrence;

  const raw =
    inputs.lastMatchedSlotIndex === undefined || inputs.lastMatchedSlotIndex === null
      ? nextSlotAfter(inputs.anchorDate, inputs.cadence, last.date, inputs.dayOfMonthPair)
      : slotOf(
          inputs.anchorDate,
          specOf(inputs.cadence),
          inputs.lastMatchedSlotIndex + 1,
          inputs.dayOfMonthPair,
        );
  const postsOnWeekends = series.some((occurrence) => isWeekend(occurrence.date));
  const date = postsOnWeekends ? raw : shiftToBusinessDay(raw);

  return {
    date,
    uncertaintyDays: uncertaintyDays(inputs.residualDays, specOf(inputs.cadence)),
    expectedAmount: expectedAmount(series, inputs.amountModel, date),
  };
}
