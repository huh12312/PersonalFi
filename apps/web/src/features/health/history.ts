// SPDX-License-Identifier: MIT
/**
 * The score's history (WP 10.12): the 90-day sparkline's points and the change against 30 days ago, in points and
 * in words. A day with no snapshot is a gap, never a guessed value; fewer than two scored days draws no line.
 */
import { DateOnly } from '@core/kernel';

import type { HealthHistoryEntry } from '../../api/generated/types.gen.ts';
import type { HealthComponentId } from './types.ts';
import { metricNumber } from './zones.ts';

export interface SeriesPoint {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly value: number;
}

/** The overall score per day, scored days only, oldest first. */
export function scoreSeries(history: readonly HealthHistoryEntry[]): SeriesPoint[] {
  return [...history]
    .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))
    .flatMap((entry) =>
      entry.score === null ? [] : [{ date: entry.asOfDate, value: entry.score }],
    );
}

/** One pillar's score per day, the days it was scored. */
export function pillarScoreSeries(
  history: readonly HealthHistoryEntry[],
  component: HealthComponentId,
): SeriesPoint[] {
  return [...history]
    .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))
    .flatMap((entry) => {
      const pillar = entry.pillars.find((p) => p.component === component);
      return pillar?.score == null ? [] : [{ date: entry.asOfDate, value: pillar.score }];
    });
}

/** One pillar's metric value per day, the days it was scored. */
export function pillarValueSeries(
  history: readonly HealthHistoryEntry[],
  component: HealthComponentId,
): SeriesPoint[] {
  return [...history]
    .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))
    .flatMap((entry) => {
      const pillar = entry.pillars.find((p) => p.component === component);
      return pillar?.value == null
        ? []
        : [{ date: entry.asOfDate, value: metricNumber(pillar.value) }];
    });
}

/** A line needs two points: under two scored days the sparkline is withheld and says why. */
export const MIN_SPARKLINE_POINTS = 2;

export function canDrawSparkline(points: readonly SeriesPoint[]): boolean {
  return points.length >= MIN_SPARKLINE_POINTS;
}

export type Delta =
  | {
      readonly kind: 'delta';
      /** Rounded to one decimal. */
      readonly points: number;
      readonly baseDate: string;
      readonly baseScore: number;
      readonly words: string;
    }
  | { readonly kind: 'withheld'; readonly words: string };

function pointsWord(value: number): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} point${value === 1 ? '' : 's'}`;
}

/**
 * The change since 30 days ago: today's score against the latest scored day on or before `asOf − 30 days`.
 * Withheld (with words) when there is no score today or no scored day that far back.
 */
export function deltaVs30Days(
  history: readonly HealthHistoryEntry[],
  asOfDate: string,
  score: number | null,
): Delta {
  if (score === null) {
    return { kind: 'withheld', words: 'No score today to compare.' };
  }
  const cutoff = DateOnly.addDays(DateOnly.parse(asOfDate), -30);
  const base = scoreSeries(history)
    .filter((point) => point.date <= cutoff)
    .at(-1);
  if (base === undefined) {
    return { kind: 'withheld', words: 'No score from 30 days ago yet.' };
  }
  const points = Math.round((score - base.value) * 10) / 10;
  const words =
    points === 0
      ? 'Unchanged from 30 days ago'
      : `${points > 0 ? 'Up' : 'Down'} ${pointsWord(Math.abs(points))} from 30 days ago`;
  return { kind: 'delta', points, baseDate: base.date, baseScore: base.value, words };
}
