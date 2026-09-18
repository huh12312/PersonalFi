// SPDX-License-Identifier: MIT
/**
 * Cadence inference (07 §2.3), which is calendar arithmetic and not division.
 *
 * `round(mean_gap / 30)` is wrong three ways and each one is a real bug:
 *
 *  1. **Drift.** Adding 30 days repeatedly loses five days a year, so a
 *     `next_expected_date` slowly decorrelates from the bill (04 §5.1). Month
 *     steps are `DateOnly.addMonths` from the *anchor*, with end-of-month
 *     clamping, so a Jan-31 stream predicts Feb 28, Mar 31, Apr 30 — and Mar 31,
 *     not Mar 28. Clamping from the anchor rather than from the previous
 *     prediction is what stops Feb 28 from pinning the rest of the year.
 *  2. **Sparseness.** Three monthly hits also "fit" as a weekly schedule that
 *     missed three quarters of its slots. A mean gap cannot tell them apart; a
 *     coverage term can, and the tie-break below finishes the job by preferring
 *     the **longest** cadence among near-ties.
 *  3. **Weekends.** Many billers post on the next business day, so a Saturday
 *     slot lands on Monday. Tolerance is therefore widened **asymmetrically**,
 *     forward only, by `WEEKEND_FORWARD_TOLERANCE_DAYS` when the predicted date
 *     is a Saturday or Sunday. Widening it symmetrically would also accept a
 *     charge two days *early*, which is not a thing that happens and is
 *     precision spent for nothing.
 *
 * Every function here is pure and takes dates only. It cannot see an amount, a
 * merchant or a descriptor.
 */

import { DateOnly } from '@core/kernel';
import { madNumber, meanNumber } from './stats.ts';
import type { Cadence, CadenceOrUnknown } from './types.ts';

export interface CadenceSpec {
  readonly cadence: Cadence;
  /** Nominal length in days. Only ever used to order cadences and to size grace. */
  readonly periodDays: number;
  readonly toleranceDays: number;
  /** 07 §2.3 `min_n`: fewer occurrences than this and the cadence is not scored. */
  readonly minOccurrences: number;
  readonly periodsPerYear: number;
  /** Month-stepped cadences advance with `addMonths`; day-stepped ones with `addDays`. */
  readonly step: { readonly unit: 'days' | 'months' | 'semimonthly'; readonly size: number };
}

export const CADENCES: readonly CadenceSpec[] = Object.freeze([
  {
    cadence: 'WEEKLY',
    periodDays: 7,
    toleranceDays: 2,
    minOccurrences: 3,
    periodsPerYear: 52,
    step: { unit: 'days', size: 7 },
  },
  {
    cadence: 'BIWEEKLY',
    periodDays: 14,
    toleranceDays: 3,
    minOccurrences: 3,
    periodsPerYear: 26,
    step: { unit: 'days', size: 14 },
  },
  {
    cadence: 'SEMIMONTHLY',
    periodDays: 15,
    toleranceDays: 3,
    minOccurrences: 3,
    periodsPerYear: 24,
    step: { unit: 'semimonthly', size: 1 },
  },
  {
    cadence: 'MONTHLY',
    periodDays: 30,
    toleranceDays: 4,
    minOccurrences: 2,
    periodsPerYear: 12,
    step: { unit: 'months', size: 1 },
  },
  {
    cadence: 'BIMONTHLY',
    periodDays: 61,
    toleranceDays: 5,
    minOccurrences: 3,
    periodsPerYear: 6,
    step: { unit: 'months', size: 2 },
  },
  {
    cadence: 'QUARTERLY',
    periodDays: 91,
    toleranceDays: 7,
    minOccurrences: 2,
    periodsPerYear: 4,
    step: { unit: 'months', size: 3 },
  },
  {
    cadence: 'SEMIANNUAL',
    periodDays: 182,
    toleranceDays: 10,
    minOccurrences: 2,
    periodsPerYear: 2,
    step: { unit: 'months', size: 6 },
  },
  {
    cadence: 'ANNUAL',
    periodDays: 365,
    toleranceDays: 15,
    minOccurrences: 2,
    periodsPerYear: 1,
    step: { unit: 'months', size: 12 },
  },
] as const);

const BY_CADENCE = new Map<Cadence, CadenceSpec>(CADENCES.map((spec) => [spec.cadence, spec]));

export function specOf(cadence: Cadence): CadenceSpec {
  const spec = BY_CADENCE.get(cadence);
  if (spec === undefined) throw new Error(`unknown cadence ${cadence}`);
  return spec;
}

export function periodsPerYear(cadence: Cadence): number {
  return specOf(cadence).periodsPerYear;
}

export function periodDaysOf(cadence: Cadence): number {
  return specOf(cadence).periodDays;
}

/** Billers post on the next business day; they do not post two days early. */
export const WEEKEND_FORWARD_TOLERANCE_DAYS = 2;

/**
 * The maximum `0.5·coverage + 0.3·tightness − 0.4·extras` can reach.
 *
 * 07 §2.3's formula tops out at **0.8**, but §2.4 then feeds the result in as
 * `x1 = cadence_score  # 0..1 from §2.3` and §2.3's own typing table asks for
 * `≥ 0.75`. Those three statements are only consistent if the score is
 * normalised to its own maximum, so it is: a flawless schedule scores 1.0, and
 * `SUBSCRIPTION_FLOOR` means "three quarters of perfect" rather than "94% of the
 * best score reachable", which is what 0.75 against an 0.8 ceiling meant — one
 * prorated month in eight was enough to lose the word "subscription".
 */
export const MAX_RAW_SCORE = 0.8;

/** 07 §2.3: near-ties inside this band are resolved by preferring the longest. */
export const TIE_BAND = 0.05;

/** How many leading dates are tried as schedule anchors (07 §2.3). */
export const MAX_ANCHORS = 3;

function isWeekend(date: DateOnly): boolean {
  const dow = DateOnly.dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/**
 * The `k`-th slot of a schedule anchored at `anchor`.
 *
 * Always measured from the anchor, never from the previous slot: iterating
 * `addMonths(previous, 1)` from Jan 31 gives Jan 31, Feb 28, **Mar 28** — the
 * clamp becomes permanent and the schedule quietly walks backwards.
 */
export function slotOf(
  anchor: DateOnly,
  spec: CadenceSpec,
  index: number,
  dayOfMonthPair?: readonly [number, number] | null,
): DateOnly {
  switch (spec.step.unit) {
    case 'days':
      return DateOnly.addDays(anchor, spec.step.size * index);
    case 'months':
      return DateOnly.addMonths(anchor, spec.step.size * index);
    case 'semimonthly': {
      const pair = dayOfMonthPair ?? [DateOnly.day(anchor), DateOnly.day(anchor)];
      const monthOffset = Math.floor(index / 2);
      const which = index % 2;
      const base = DateOnly.addMonths(DateOnly.startOfMonth(anchor), monthOffset);
      const target = (which === 0 ? pair[0] : pair[1]) as number;
      const limit = DateOnly.daysInMonth(DateOnly.year(base), DateOnly.month(base));
      return DateOnly.of(DateOnly.year(base), DateOnly.month(base), Math.min(target, limit));
    }
  }
}

/**
 * Every slot from `anchor` through `until`, inclusive, **carrying its own
 * index**.
 *
 * The index matters and is not the array position. A semimonthly schedule
 * anchored on the 2nd starts its month at the 1st, so the first generated slot
 * is dropped for being before the anchor and array position `0` is slot index
 * `1` from then on. Handing the array position back to `slotOf` — which is what
 * a plain `DateOnly[]` invites — recomputed every semimonthly residual half a
 * month out and predicted a next-due date that had already happened.
 */
export function generateSlots(
  anchor: DateOnly,
  spec: CadenceSpec,
  until: DateOnly,
  dayOfMonthPair?: readonly [number, number] | null,
): Array<{ readonly index: number; readonly date: DateOnly }> {
  const slots: Array<{ index: number; date: DateOnly }> = [];
  // A generous ceiling: the longest realistic history (40 years of weekly) is
  // ~2,100 slots, and the loop breaks on `until` long before that.
  for (let index = 0; index < 4_000; index += 1) {
    const date = slotOf(anchor, spec, index, dayOfMonthPair);
    if (DateOnly.isAfter(date, until)) break;
    if (!DateOnly.isBefore(date, anchor)) slots.push({ index, date });
  }
  return slots;
}

/** The dates of `generateSlots`, for callers that do not need the indices. */
export function generateSchedule(
  anchor: DateOnly,
  spec: CadenceSpec,
  until: DateOnly,
  dayOfMonthPair?: readonly [number, number] | null,
): DateOnly[] {
  return generateSlots(anchor, spec, until, dayOfMonthPair).map((slot) => slot.date);
}

/** The two most common days of the month, which is what a semimonthly bill is. */
export function dayOfMonthPairOf(dates: readonly DateOnly[]): [number, number] | null {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const dom = DateOnly.day(date);
    counts.set(dom, (counts.get(dom) ?? 0) + 1);
  }
  if (counts.size < 2) return null;
  const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] - b[0]));
  const first = ranked[0]?.[0] as number;
  const second = ranked[1]?.[0] as number;
  return first <= second ? [first, second] : [second, first];
}

export interface CadenceFit {
  readonly score: number;
  readonly anchorDate: DateOnly;
  readonly matchedCount: number;
  readonly expectedCount: number;
  readonly coverage: number;
  readonly unexplained: number;
  readonly tightness: number;
  /** Signed residual in days per matched slot: actual − predicted. */
  readonly residualDays: readonly number[];
  /**
   * Each residual divided by the tolerance **its own slot** was allowed.
   *
   * A Saturday slot is allowed `tol + 2`, so a charge that posts the following
   * Monday is not two days sloppy — it is a biller doing exactly what billers
   * do. Normalising per slot rather than by the nominal tolerance is what keeps
   * a weekend-heavy stream scoring as the tight schedule it is.
   */
  readonly normalisedResiduals: readonly number[];
  /** `null` for every slot the dates do not explain, aligned with the schedule. */
  readonly matchedIndexByDate: ReadonlyMap<string, number>;
  readonly dayOfMonthPair: readonly [number, number] | null;
}

/**
 * 07 §2.3 `score_cadence`, one anchor.
 *
 * `0.5·coverage + 0.3·tightness − 0.4·extras`. Coverage is what refuses a sparse
 * weekly reading of three monthly hits; the extras term is what refuses a
 * schedule that explains four of a merchant's forty charges.
 */
export function fitCadence(
  dates: readonly DateOnly[],
  spec: CadenceSpec,
  anchor: DateOnly,
  dayOfMonthPair: readonly [number, number] | null,
): CadenceFit {
  const last = dates[dates.length - 1] as DateOnly;
  // The horizon runs one tolerance window past the final charge, not to the
  // charge itself. A stream whose last hit arrived two days *early* otherwise
  // loses the slot that explains it — the slot is generated, found to be after
  // `last`, and dropped — which reads as a missing period plus an unexplained
  // charge and costs the score twice. Three annual occurrences scored 0.657
  // instead of 0.78 that way, which is the difference between a subscription
  // and nothing at all.
  const horizon = DateOnly.addDays(last, spec.toleranceDays + WEEKEND_FORWARD_TOLERANCE_DAYS);
  const schedule = generateSlots(anchor, spec, horizon, dayOfMonthPair);
  const used = new Set<number>();
  const residuals: number[] = [];
  const normalised: number[] = [];
  const matchedIndexByDate = new Map<string, number>();

  for (const { index: slotIndex, date: slot } of schedule) {
    const forward = spec.toleranceDays + (isWeekend(slot) ? WEEKEND_FORWARD_TOLERANCE_DAYS : 0);
    let bestIndex = -1;
    let bestResidual = Number.POSITIVE_INFINITY;
    for (const [dateIndex, date] of dates.entries()) {
      if (used.has(dateIndex)) continue;
      const residual = DateOnly.differenceInDays(slot, date);
      if (residual < -spec.toleranceDays || residual > forward) continue;
      if (Math.abs(residual) < Math.abs(bestResidual)) {
        bestResidual = residual;
        bestIndex = dateIndex;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      residuals.push(bestResidual);
      normalised.push(Math.abs(bestResidual) / (bestResidual > 0 ? forward : spec.toleranceDays));
      matchedIndexByDate.set(dates[bestIndex] as string, slotIndex);
    }
  }

  const expectedCount = Math.max(1, schedule.length);
  const matchedCount = used.size;
  const coverage = matchedCount / expectedCount;
  const unexplained = (dates.length - matchedCount) / dates.length;
  const tightness = normalised.length === 0 ? 0 : 1 - meanNumber(normalised);

  return {
    score: (0.5 * coverage + 0.3 * tightness - 0.4 * unexplained) / MAX_RAW_SCORE,
    anchorDate: anchor,
    matchedCount,
    expectedCount: schedule.length,
    coverage,
    unexplained,
    tightness,
    residualDays: residuals,
    normalisedResiduals: normalised,
    matchedIndexByDate,
    dayOfMonthPair,
  };
}

/** The best anchor for one cadence. 07 §2.3 tries the first few, for a late start. */
export function scoreCadence(dates: readonly DateOnly[], spec: CadenceSpec): CadenceFit | null {
  if (dates.length < spec.minOccurrences) return null;
  const pair = spec.step.unit === 'semimonthly' ? dayOfMonthPairOf(dates) : null;
  if (spec.step.unit === 'semimonthly' && pair === null) return null;

  let best: CadenceFit | null = null;
  let fallback: CadenceFit | null = null;
  for (const anchor of dates.slice(0, Math.min(MAX_ANCHORS, dates.length))) {
    const fit = fitCadence(dates, spec, anchor, pair);
    if (fallback === null) fallback = fit;
    // A degenerate anchor near the end of the history produces a schedule with
    // one slot, matches it, and scores coverage 1.0 — which let three monthly
    // charges score 0.533 as "weekly" by anchoring on the last of them. A
    // schedule shorter than the cadence's own `min_n` is not a schedule.
    if (fit.expectedCount < spec.minOccurrences) continue;
    if (best === null || fit.score > best.score) best = fit;
  }
  return best ?? fallback;
}

export interface CadenceInference {
  readonly cadence: CadenceOrUnknown;
  readonly score: number;
  readonly fit: CadenceFit | null;
  /** Every cadence that scored, for evidence and for the tie-break's audit. */
  readonly considered: ReadonlyArray<{ readonly cadence: Cadence; readonly score: number }>;
}

/**
 * Pick a cadence.
 *
 * The tie-break is the load-bearing line: among everything within `TIE_BAND` of
 * the best score, take the **longest** period. Three monthly hits score well as
 * "weekly with 75% of its slots missing" only if coverage is ignored, and they
 * score *identically* to monthly under a scheme that rewards tightness alone.
 * Inverting this one comparison is the sabotage recorded in the evidence file:
 * it takes the golden corpus from precision 1.00 to below the gate.
 */
export function inferCadence(
  dates: readonly DateOnly[],
  options: { readonly preferLongest?: boolean } = {},
): CadenceInference {
  const preferLongest = options.preferLongest ?? true;
  if (dates.length < 2) {
    return { cadence: 'UNKNOWN', score: 0, fit: null, considered: [] };
  }

  const scored: Array<{ spec: CadenceSpec; fit: CadenceFit }> = [];
  for (const spec of CADENCES) {
    const fit = scoreCadence(dates, spec);
    if (fit !== null) scored.push({ spec, fit });
  }
  if (scored.length === 0) {
    return { cadence: 'UNKNOWN', score: 0, fit: null, considered: [] };
  }

  const bestScore = Math.max(...scored.map((entry) => entry.fit.score));
  const ties = scored.filter((entry) => entry.fit.score >= bestScore - TIE_BAND);
  const chosen = ties.reduce((left, right) =>
    preferLongest
      ? right.spec.periodDays > left.spec.periodDays
        ? right
        : left
      : right.spec.periodDays < left.spec.periodDays
        ? right
        : left,
  );

  return {
    cadence: chosen.spec.cadence,
    score: chosen.fit.score,
    fit: chosen.fit,
    considered: scored.map((entry) => ({ cadence: entry.spec.cadence, score: entry.fit.score })),
  };
}

/** 07 §2.5: `ceil(1.5 × MAD(residuals))`, clamped into `[1, tolerance]`. */
export function uncertaintyDays(residuals: readonly number[], spec: CadenceSpec): number {
  if (residuals.length === 0) return spec.toleranceDays;
  const raw = Math.ceil(1.5 * madNumber(residuals));
  return Math.min(spec.toleranceDays, Math.max(1, raw));
}
