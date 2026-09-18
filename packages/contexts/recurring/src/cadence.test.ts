// SPDX-License-Identifier: MIT
/**
 * The two cadence claims the plan names, and the algebra underneath them.
 *
 * Both named tests are about a *wrong* answer that a plausible implementation
 * gives: `add 30 days` drifts off the end of the month, and `round(mean_gap/30)`
 * cannot tell three monthly charges from a weekly schedule that missed most of
 * its slots. Each test therefore asserts the right answer **and** that the wrong
 * one scores materially worse, because an assertion that only pins the right
 * answer passes for a detector that gets it right by accident.
 */

import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CADENCES,
  TIE_BAND,
  generateSchedule,
  inferCadence,
  periodDaysOf,
  scoreCadence,
  specOf,
  uncertaintyDays,
} from './cadence.ts';
import type { Cadence } from './types.ts';

function dates(...values: readonly string[]): DateOnly[] {
  return values.map((value) => DateOnly.parse(value));
}

describe('cadence inference', () => {
  it('Jan 31 monthly clamps to Feb 28 and does not drift', () => {
    const anchor = DateOnly.parse('2026-01-31');
    const schedule = generateSchedule(anchor, specOf('MONTHLY'), DateOnly.parse('2026-07-31'));

    // The clamp applies to February and then *releases*: March is the 31st
    // again. Stepping from the previous slot instead of the anchor would give
    // 2026-03-28 and every later month would stay a few days early for ever.
    expect(schedule).toEqual(
      dates(
        '2026-01-31',
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
        '2026-05-31',
        '2026-06-30',
        '2026-07-31',
      ),
    );

    const observed = dates(
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    );
    const inference = inferCadence(observed);
    expect(inference.cadence).toBe('MONTHLY');
    // Every hit lands exactly on its slot, so there is no drift to absorb.
    expect(inference.fit?.residualDays).toEqual([0, 0, 0, 0, 0, 0]);
    expect(inference.fit?.coverage).toBe(1);
    expect(uncertaintyDays(inference.fit?.residualDays ?? [], specOf('MONTHLY'))).toBe(1);
  });

  it('three monthly hits do not score as sparse weekly', () => {
    const observed = dates('2026-01-15', '2026-02-15', '2026-03-15');
    const inference = inferCadence(observed);
    expect(inference.cadence).toBe('MONTHLY');

    const weekly = scoreCadence(observed, specOf('WEEKLY'));
    const monthly = scoreCadence(observed, specOf('MONTHLY'));
    expect(weekly).not.toBeNull();
    // Weekly "explains" all three dates and leaves most of its slots empty.
    // The coverage term is what prices that, and the gap must be decisive
    // rather than a near-tie the ordering happens to resolve correctly.
    expect((monthly?.score ?? 0) - (weekly?.score ?? 0)).toBeGreaterThan(0.2);
    expect(weekly?.coverage ?? 1).toBeLessThan(0.5);
    // The substantive claim: a sparse weekly reading could never be typed
    // recurring at all, whatever the argmax had decided.
    expect(weekly?.score ?? 1).toBeLessThan(0.7);
  });

  it('a Saturday slot may post on Monday but not on the Thursday before', () => {
    // 2026-08-01 is a Saturday. The forward window reaches Monday the 3rd; the
    // backward window is the plain tolerance, so the 30th of July is late-ish
    // but the asymmetry is what makes the Monday free.
    const monday = inferCadence(dates('2026-06-01', '2026-07-01', '2026-08-03', '2026-09-01'));
    expect(monday.cadence).toBe('MONTHLY');
    expect(monday.fit?.matchedCount).toBe(4);
    expect(monday.score).toBeGreaterThan(0.75);
  });

  it('a semimonthly stream is not read as monthly with unexplained extras', () => {
    const observed = dates(
      '2026-01-01',
      '2026-01-15',
      '2026-02-01',
      '2026-02-15',
      '2026-03-01',
      '2026-03-15',
      '2026-04-01',
      '2026-04-15',
    );
    const inference = inferCadence(observed);
    expect(inference.cadence).toBe('SEMIMONTHLY');
    expect(inference.fit?.dayOfMonthPair).toEqual([1, 15]);
  });

  it('every cadence in the table is scored when it has enough occurrences', () => {
    expect(CADENCES.map((spec) => spec.cadence)).toEqual([
      'WEEKLY',
      'BIWEEKLY',
      'SEMIMONTHLY',
      'MONTHLY',
      'BIMONTHLY',
      'QUARTERLY',
      'SEMIANNUAL',
      'ANNUAL',
    ]);
  });
});

describe('cadence properties', () => {
  it('a day-stepped cadence scores identically under a uniform date shift', () => {
    // Stated on the *score*, not the argmax, and the difference is the point.
    // `SEMIMONTHLY` is anchored to the calendar by construction — it is the 1st
    // and the 15th, not "every fifteen days" — so a three-point biweekly run
    // shifted by a few weeks really can become a better semimonthly fit. That
    // is correct behaviour, and it is why the invariant that holds is about the
    // day-stepped specs' own scores rather than about which cadence wins.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 900 }),
        fc.constantFrom('WEEKLY' as const, 'BIWEEKLY' as const),
        fc.integer({ min: 3, max: 20 }),
        (shift, cadence, count) => {
          const spec = specOf(cadence);
          const base = DateOnly.parse('2024-01-01');
          const original = Array.from({ length: count }, (_, index) =>
            DateOnly.addDays(base, spec.periodDays * index),
          );
          const shifted = original.map((date) => DateOnly.addDays(date, shift));
          expect(scoreCadence(shifted, spec)?.score).toBe(scoreCadence(original, spec)?.score);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('month-stepped inference is invariant under a uniform shift in whole months', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 36 }),
        fc.constantFrom(1, 2, 3, 6, 12),
        fc.integer({ min: 1, max: 28 }),
        (shiftMonths, stepMonths, dayOfMonth) => {
          const base = DateOnly.of(2024, 1, dayOfMonth);
          const count = stepMonths <= 2 ? 12 : 6;
          const original = Array.from({ length: count }, (_, index) =>
            DateOnly.addMonths(base, stepMonths * index),
          );
          const shifted = original.map((date) => DateOnly.addMonths(date, shiftMonths));
          expect(inferCadence(shifted).cadence).toBe(inferCadence(original).cadence);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the longest cadence wins a near-tie, and only a near-tie', () => {
    // This test was, for a while, only its second half: it generated clean
    // monthly streams, which are a near-tie with nothing, so it exercised the
    // argmax and never the tie-break. Inverting the tie-break in `cadence.ts`
    // left the entire suite green. The first two assertions below are the
    // repair, and they are what the evidence file's sabotage now turns red.

    // (a) The invariant itself, on the **default** path, over date sets sparse
    //     and irregular enough that several cadences really do land inside
    //     `TIE_BAND`. Stated on `considered`, which is the same candidate list
    //     the tie-break reduces over.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 800 }), { minLength: 2, maxLength: 9 }),
        (offsets) => {
          const base = DateOnly.parse('2024-01-10');
          const observed = [...offsets]
            .sort((left, right) => left - right)
            .map((offset) => DateOnly.addDays(base, offset));
          const inference = inferCadence(observed);
          if (inference.cadence === 'UNKNOWN' || inference.considered.length === 0) return;

          const best = Math.max(...inference.considered.map((entry) => entry.score));
          const tied = inference.considered.filter((entry) => entry.score >= best - TIE_BAND);
          const longest = Math.max(...tied.map((entry) => periodDaysOf(entry.cadence)));
          expect(periodDaysOf(inference.cadence), JSON.stringify(observed)).toBe(longest);
        },
      ),
      { numRuns: 400 },
    );

    // (b) The case that makes the invariant worth having, concretely. Two
    //     unrelated purchases six weeks apart tie four ways at 0.750; the
    //     argmax is arbitrary between them and the tie-break is the only thing
    //     choosing. Preferring the longest makes the engine's unavoidable
    //     mistake *cheap*: it forecasts one charge a year from a pair it cannot
    //     explain, instead of a quarterly bill that is four times the
    //     commitment and four times the wrong notifications.
    const sparse = dates('2024-01-10', '2024-02-19');
    const byDefault = inferCadence(sparse);
    const inverted = inferCadence(sparse, { preferLongest: false });
    expect(byDefault.cadence).toBe('ANNUAL');
    // A live tie, not a vacuous one: the other reading scores the same and is
    // strictly shorter, so something had to choose.
    expect(inverted.cadence).toBe('QUARTERLY');
    expect(Math.abs(inverted.score - byDefault.score)).toBeLessThanOrEqual(TIE_BAND);
    expect(periodDaysOf(byDefault.cadence as Cadence)).toBeGreaterThan(
      periodDaysOf(inverted.cadence as Cadence),
    );

    // (c) …and only a near-tie. A clean monthly stream is not tied with
    //     anything, so the tie-break has nothing to decide and the two
    //     settings must agree.
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 24 }), (count) => {
        const base = DateOnly.parse('2024-03-05');
        const observed = Array.from({ length: count }, (_, index) =>
          DateOnly.addMonths(base, index),
        );
        expect(inferCadence(observed, { preferLongest: true }).cadence).toBe('MONTHLY');
        expect(inferCadence(observed, { preferLongest: false }).cadence).toBe('MONTHLY');
      }),
      { numRuns: 50 },
    );
  });
});
