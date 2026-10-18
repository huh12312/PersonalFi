// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { HealthHistoryEntry } from '../../api/generated/types.gen.ts';
import { canDrawSparkline, deltaVs30Days, pillarValueSeries, scoreSeries } from './history.ts';
import { HISTORY } from './test-fixtures.ts';

const day = (asOfDate: string, score: number | null): HealthHistoryEntry => ({
  asOfDate,
  score,
  pillars: [],
});

describe('score history (WP 10.12)', () => {
  it('the delta against the latest scored day on or before 30 days ago, in points and words', () => {
    expect(deltaVs30Days(HISTORY, '2026-10-18', 75)).toEqual({
      kind: 'delta',
      points: 4.5,
      baseDate: '2026-09-15',
      baseScore: 70.5,
      words: 'Up 4.5 points from 30 days ago',
    });
  });

  it('down, one point, unchanged, and exactly 30 days back', () => {
    const history = [day('2026-09-18', 80), day('2026-10-18', 70)];
    expect(deltaVs30Days(history, '2026-10-18', 70).words).toBe('Down 10 points from 30 days ago');
    expect(deltaVs30Days([day('2026-09-18', 74)], '2026-10-18', 75).words).toBe(
      'Up 1 point from 30 days ago',
    );
    expect(deltaVs30Days([day('2026-09-18', 75.02)], '2026-10-18', 75).words).toBe(
      'Unchanged from 30 days ago',
    );
  });

  it('withheld when nothing is that old, when that day was not scored, or when there is no score today', () => {
    expect(deltaVs30Days([day('2026-09-19', 70)], '2026-10-18', 75)).toEqual({
      kind: 'withheld',
      words: 'No score from 30 days ago yet.',
    });
    expect(deltaVs30Days([day('2026-09-10', null)], '2026-10-18', 75).kind).toBe('withheld');
    expect(deltaVs30Days(HISTORY, '2026-10-18', null).kind).toBe('withheld');
  });

  it('the sparkline needs two scored days; an unscored day is a gap, not a zero', () => {
    expect(canDrawSparkline(scoreSeries([day('2026-10-18', 75)]))).toBe(false);
    expect(canDrawSparkline(scoreSeries([day('2026-10-17', null), day('2026-10-18', 75)]))).toBe(
      false,
    );
    expect(canDrawSparkline(scoreSeries([day('2026-10-17', 70), day('2026-10-18', 75)]))).toBe(
      true,
    );
    expect(scoreSeries([day('2026-10-18', 75), day('2026-10-17', null)])).toEqual([
      { date: '2026-10-18', value: 75 },
    ]);
  });

  it('a pillar’s metric per day, oldest first', () => {
    expect(pillarValueSeries(HISTORY, 'emergency_fund_months').map((p) => p.value)).toEqual([
      3.6, 4, 4.2,
    ]);
    expect(pillarValueSeries(HISTORY, 'diversification')).toEqual([]);
  });
});
