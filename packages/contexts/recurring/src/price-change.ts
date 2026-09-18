// SPDX-License-Identifier: MIT
/**
 * Price change as a **two-sided changepoint** (04 §5.1 stage 3, 07 §2.6).
 *
 * ```
 * Let recent = the last 2 occurrences, prior = the 3 before those.
 * If median(recent) differs from median(prior) by more than the threshold,
 *    and the spread within recent is under tolerance,
 *    and the spread within prior was under tolerance
 * then record a price change and re-baseline.
 * ```
 *
 * Requiring stability on **both** sides is the whole algorithm, and it is what
 * separates "Netflix went up $3" from the four things that look identical to a
 * one-sided rule:
 *
 *  * a **proration** when a plan changes mid-cycle — one odd amount, then the
 *    series resumes at the old price. Two-sided: the recent window contains both
 *    $4.33 and $12.99, its spread blows the tolerance, nothing is emitted.
 *    `price-change.test.ts` is exactly this case.
 *  * a **partial-month** first or last charge, same shape;
 *  * a **refund or credit** netted against one period;
 *  * a **tax change** on one charge only.
 *
 * Two deliberate asymmetries, both precision-first:
 *
 *  1. A change is only emitted once the new level has **two** occurrences. The
 *     single exception is 07 §2.6's escape hatch — a jump larger than
 *     `UNCONFIRMED_FRACTION_PERCENT` of the baseline may be emitted on one
 *     occurrence, marked `confirmed: false`.
 *  2. That escape hatch is available to **increases only**. An unconfirmed large
 *     *drop* is overwhelmingly a proration or a credit, not a price cut, and
 *     waiting one period to say so costs nothing. A symmetric rule would turn
 *     every proration into a "your bill went down!" insight.
 *
 * Amounts are `bigint` magnitudes throughout. `from`, `to`, `delta` and
 * `annualImpact` are all `Money`; `annualImpact` is `delta × periodsPerYear`,
 * an exact integer multiply, never a float scaling.
 */

import { DateOnly, Money, minorUnitScale, type CurrencyCode } from '@core/kernel';
import { periodsPerYear } from './cadence.ts';
import { madMinor, medianMinor } from './stats.ts';
import type { Cadence, Occurrence, PriceChange } from './types.ts';

/** 04 §5.1: "differs by more than 3%". */
export const CHANGE_FRACTION_PERCENT = 3n;
/** 07 §2.6: "…or $1.00", so a 2-cent wobble on a $0.99 plan is not a hike. */
export const CHANGE_FLOOR_MAJOR = 1n;
/** 07 §2.6: a jump this large may be reported before the next occurrence. */
export const UNCONFIRMED_FRACTION_PERCENT = 15n;

/** A move must clear this many MADs of the surrounding amounts. */
export const NOISE_MULTIPLE = 4;

export const PRIOR_WINDOW = 3;
export const RECENT_WINDOW = 2;

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function spread(values: readonly bigint[]): bigint {
  let low = values[0] as bigint;
  let high = values[0] as bigint;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high - low;
}

function floorMinor(code: CurrencyCode): bigint {
  return CHANGE_FLOOR_MAJOR * 10n ** BigInt(minorUnitScale(code));
}

export interface PriceChangeOptions {
  readonly streamKey: string;
  readonly cadence: Cadence;
  /** 04 §5.1 band: `max(5% of median, $1.00)`, supplied by the amount profile. */
  readonly tolerance: Money;
}

/**
 * Every changepoint in a series, oldest first — the price *history*, not just
 * the latest move, because "your Netflix went up twice this year" is the
 * insight and a single latest-vs-baseline comparison cannot produce it.
 */
export function detectPriceChanges(
  occurrences: readonly Occurrence[],
  options: PriceChangeOptions,
): PriceChange[] {
  const series = [...occurrences].sort((a, b) => DateOnly.compare(a.date, b.date));
  if (series.length < PRIOR_WINDOW + 1) return [];

  const code = (series[0] as Occurrence).amount.currency;
  const tolerance = magnitude(options.tolerance.minor);
  const floor = floorMinor(code);
  const changes: PriceChange[] = [];

  let boundary = PRIOR_WINDOW;
  let levelStart = 0;
  while (boundary < series.length) {
    const prior = series.slice(boundary - PRIOR_WINDOW, boundary);
    const recent = series.slice(boundary, boundary + RECENT_WINDOW);
    const priorMinors = prior.map((occurrence) => magnitude(occurrence.amount.minor));
    const recentMinors = recent.map((occurrence) => magnitude(occurrence.amount.minor));

    const priorStable = spread(priorMinors) <= tolerance;
    const recentStable = spread(recentMinors) <= tolerance;
    if (!priorStable || !recentStable) {
      boundary += 1;
      continue;
    }

    const baseline = medianMinor(priorMinors);
    const level = medianMinor(recentMinors);
    const difference = level > baseline ? level - baseline : baseline - level;
    // Three floors, and the move must clear all of them:
    //   3% of the baseline      07 §2.6
    //   $1.00                   07 §2.6, so a 2-cent wobble on a $0.99 plan is quiet
    //   the tolerance band      04 §5.1 — the band the stream is *modelled* within.
    //                           A move inside the band the forecaster already
    //                           treats as "the same amount" cannot be news.
    const relativeThreshold = (baseline * CHANGE_FRACTION_PERCENT) / 100n;
    let threshold = relativeThreshold > floor ? relativeThreshold : floor;
    if (tolerance > threshold) threshold = tolerance;

    if (difference <= threshold) {
      boundary += 1;
      continue;
    }

    // Stability on both sides means stability *relative to the move*. A payroll
    // deposit that varies by $40 either side of $1,420 satisfies "spread within
    // tolerance" on both windows and still shows a $49 gap between their
    // medians — noise, not a raise, and 07 §2.6's 3% floor cannot tell the
    // difference because 3% of $1,420 is $42.
    //
    // So the move must also clear `NOISE_MULTIPLE × MAD` of the noisier of the
    // two windows. Each MAD is computed *within* its own window, so a genuine
    // step leaves both at zero and the 3% floor still governs, exactly as 07
    // intends; it is only the wobbly stream whose bar rises.
    // Dispersion of the *current level* — every occurrence since the previous
    // changepoint, not just the three in the window. Three samples of a noisy
    // stream can look deceptively tight; thirty cannot. Bounded at the previous
    // changepoint so a second genuine rise is not hidden by the first.
    const levelMinors = series
      .slice(levelStart, boundary)
      .map((occurrence) => magnitude(occurrence.amount.minor));
    const priorNoise = madMinor(levelMinors.length >= PRIOR_WINDOW ? levelMinors : priorMinors);
    const recentNoise = madMinor(recentMinors);
    const noise = priorNoise > recentNoise ? priorNoise : recentNoise;
    if (difference <= BigInt(NOISE_MULTIPLE) * noise) {
      boundary += 1;
      continue;
    }

    const direction = level > baseline ? 'INCREASE' : 'DECREASE';
    const confirmed = recent.length >= RECENT_WINDOW;
    const large = difference * 100n > baseline * UNCONFIRMED_FRACTION_PERCENT;
    // Asymmetry (2): an unconfirmed drop waits for the next occurrence.
    if (!confirmed && !(large && direction === 'INCREASE')) {
      boundary += 1;
      continue;
    }

    const delta = Money.of(difference, code);
    changes.push({
      streamKey: options.streamKey,
      direction,
      effectiveDate: (recent[0] as Occurrence).date,
      from: Money.of(baseline, code),
      to: Money.of(level, code),
      delta,
      annualImpact: Money.multiplyByInteger(delta, BigInt(periodsPerYear(options.cadence))),
      confirmed,
      priorTransactionIds: prior.map((occurrence) => occurrence.transactionId),
      recentTransactionIds: recent.map((occurrence) => occurrence.transactionId),
    });

    // Re-baseline: the next changepoint is measured against the new level.
    levelStart = boundary;
    boundary += RECENT_WINDOW;
  }

  return changes;
}
