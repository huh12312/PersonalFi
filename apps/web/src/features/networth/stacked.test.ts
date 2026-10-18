// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { milestoneSentence, noticeOf } from './milestones.ts';
import {
  BUCKETING_FOR_PERIOD,
  BUCKETING_RULE,
  PERCENT_WITHHELD_NEGATIVE,
  PERCENT_WITHHELD_ZERO,
  changeBetween,
  groupBucketsByCurrency,
  legendAt,
  moveSelection,
  readoutAt,
  stackOf,
  trimLeadingGaps,
  type StackedBucket,
  type StackedSegment,
} from './stacked.ts';

function bucket(
  start: string,
  net: bigint | null,
  segments: StackedSegment[] = net === null ? [] : [{ kind: 'cash', minor: net }],
  currency = 'USD',
): StackedBucket {
  return {
    start,
    end: start,
    asOfDate: net === null ? null : start,
    currency: net === null ? null : currency,
    netMinor: net,
    segments,
    sealed: true,
    source: net === null ? null : 'observed',
  };
}

describe('the bucketing rule (WP 10.13)', () => {
  it('1M by day, 3M and 6M by week, 1Y and All by month — and the table says so in words', () => {
    expect(BUCKETING_FOR_PERIOD).toEqual({
      '1M': 'day',
      '3M': 'week',
      '6M': 'week',
      '1Y': 'month',
      ALL: 'month',
    });
    expect(BUCKETING_RULE.week).toMatch(/Monday to Sunday/);
    expect(BUCKETING_RULE.month).toMatch(/last recorded day of the month/);
  });
});

describe('stackOf', () => {
  const b = bucket('2026-10-01', 410_000n, [
    { kind: 'cash', minor: 20_000n },
    { kind: 'investments', minor: 300_000n },
    { kind: 'property', minor: 400_000n },
    { kind: 'liabilities', minor: -310_000n },
  ]);

  it('assets go up from zero in the stacking order; liabilities go down, below the line', () => {
    const pieces = stackOf(b);
    expect(pieces.map((p) => [p.kind, p.side, p.from, p.to])).toEqual([
      ['property', 'up', 0, 400_000],
      ['cash', 'up', 400_000, 420_000],
      ['investments', 'up', 420_000, 720_000],
      ['liabilities', 'down', 0, -310_000],
    ]);
    const liability = pieces.find((p) => p.kind === 'liabilities')!;
    expect(liability.to).toBeLessThan(0);
  });

  it('only the topmost positive and the bottommost negative piece is rounded', () => {
    const rounded = stackOf(b)
      .filter((p) => p.rounded)
      .map((p) => p.kind);
    expect(rounded).toEqual(['investments', 'liabilities']);
  });

  it('a negative asset (an overdrawn account) is drawn below the line too; a zero segment draws nothing', () => {
    const pieces = stackOf(
      bucket('2026-10-01', -5_000n, [
        { kind: 'cash', minor: -5_000n },
        { kind: 'investments', minor: 0n },
      ]),
    );
    expect(pieces.map((p) => [p.kind, p.side, p.rounded])).toEqual([['cash', 'down', true]]);
  });
});

describe('the scrub readout', () => {
  const buckets = [
    bucket('2026-09-01', 100_000n),
    bucket('2026-09-08', null),
    bucket('2026-09-15', 110_000n),
    bucket('2026-09-22', 99_000n),
  ];

  it('vs the previous bucket with a figure (a gap is skipped) and vs the first, in money and percent', () => {
    const readout = readoutAt(buckets, 2)!;
    expect(readout.vsPrevious?.changeMinor).toBe(10_000n);
    expect(readout.vsPrevious?.against.start).toBe('2026-09-01');
    expect(readout.vsPrevious?.ratio).toBeCloseTo(0.1);
    expect(readout.vsFirst?.changeMinor).toBe(10_000n);
    const last = readoutAt(buckets, 3)!;
    expect(last.vsPrevious?.changeMinor).toBe(-11_000n);
    expect(last.vsPrevious?.ratio).toBeCloseTo(-0.1);
    expect(last.vsFirst?.changeMinor).toBe(-1_000n);
  });

  it('the first bucket has no change; a gap has no readout', () => {
    expect(readoutAt(buckets, 0)).toEqual({ bucket: buckets[0], vsPrevious: null, vsFirst: null });
    expect(readoutAt(buckets, 1)).toBeNull();
  });

  it('the percent is withheld, with the reason, on a zero base and on a negative base', () => {
    const zero = changeBetween(bucket('a', 0n), bucket('b', 5_000n))!;
    expect(zero).toMatchObject({
      changeMinor: 5_000n,
      ratio: null,
      withheld: PERCENT_WITHHELD_ZERO,
    });
    const negative = changeBetween(bucket('a', -10_000n), bucket('b', -5_000n))!;
    expect(negative).toMatchObject({
      changeMinor: 5_000n,
      ratio: null,
      withheld: PERCENT_WITHHELD_NEGATIVE,
    });
    expect(changeBetween(bucket('a', 1n), bucket('b', 2n))?.withheld).toBeNull();
  });
});

describe('legendAt', () => {
  it('every account type present, with its total at the bucket, assets in stack order then liabilities', () => {
    const legend = legendAt(
      bucket('2026-10-01', 0n, [
        { kind: 'liabilities', minor: -5_000n },
        { kind: 'crypto', minor: 1_000n },
        { kind: 'cash', minor: 4_000n },
      ]),
    );
    expect(legend).toEqual([
      { kind: 'cash', minor: 4_000n },
      { kind: 'crypto', minor: 1_000n },
      { kind: 'liabilities', minor: -5_000n },
    ]);
    expect(legendAt(undefined)).toEqual([]);
  });
});

describe('moveSelection (keyboard)', () => {
  const buckets = [
    bucket('a', null),
    bucket('b', 1n),
    bucket('c', null),
    bucket('d', 2n),
    bucket('e', 3n),
  ];

  it('← → step over gaps; Home and End go to the first and last with a figure', () => {
    expect(moveSelection(buckets, 4, 'ArrowLeft')).toBe(3);
    expect(moveSelection(buckets, 3, 'ArrowLeft')).toBe(1);
    expect(moveSelection(buckets, 1, 'ArrowLeft')).toBe(1);
    expect(moveSelection(buckets, 1, 'ArrowRight')).toBe(3);
    expect(moveSelection(buckets, 4, 'ArrowRight')).toBe(4);
    expect(moveSelection(buckets, 3, 'Home')).toBe(1);
    expect(moveSelection(buckets, 1, 'End')).toBe(4);
  });

  it('from no selection (the latest is shown) ← goes to the one before it, → to the latest; other keys do not move', () => {
    expect(moveSelection(buckets, null, 'ArrowLeft')).toBe(3);
    expect(moveSelection(buckets, null, 'ArrowRight')).toBe(4);
    expect(moveSelection(buckets, 3, 'Enter')).toBeNull();
    expect(moveSelection([bucket('a', null)], null, 'End')).toBeNull();
  });
});

describe('currencies (D4)', () => {
  it('one series per currency, each keeping every position; never summed', () => {
    const groups = groupBucketsByCurrency([
      bucket('a', 100n, undefined, 'USD'),
      bucket('b', 800n, undefined, 'CAD'),
      bucket('c', 101n, undefined, 'USD'),
    ]);
    expect(groups.map((g) => g.currency)).toEqual(['CAD', 'USD']);
    expect(groups[1]!.buckets.map((b) => b.netMinor)).toEqual([100n, null, 101n]);
    expect(groups[0]!.buckets.map((b) => b.netMinor)).toEqual([null, 800n, null]);
  });

  it('All drops the leading buckets before the first snapshot, never one after', () => {
    const trimmed = trimLeadingGaps([bucket('a', null), bucket('b', 1n), bucket('c', null)]);
    expect(trimmed.map((b) => b.start)).toEqual(['b', 'c']);
  });
});

describe('the milestone notice copy', () => {
  const m = (minor: string, direction: 'up' | 'down', id = 'x') => ({
    id,
    milestone: { minor, currency: 'USD' },
    direction,
    crossedOn: '2026-10-03',
    previous: { minor: '0', currency: 'USD' },
    latest: { minor: '0', currency: 'USD' },
  });

  it('names the figure without cents and the day; the zero line in words', () => {
    expect(milestoneSentence(m('5000000', 'up'))).toBe('You crossed $50,000 in net worth on Oct 3');
    expect(milestoneSentence(m('0', 'up'))).toBe('Your net worth rose above zero on Oct 3');
    expect(milestoneSentence(m('0', 'down'))).toBe('Your net worth fell below zero on Oct 3');
  });

  it('the notice names the newest and dismisses every one listed', () => {
    expect(noticeOf([m('5000000', 'up', 'a'), m('2500000', 'up', 'b')])).toEqual({
      sentence: 'You crossed $50,000 in net worth on Oct 3',
      ids: ['a', 'b'],
    });
    expect(noticeOf([])).toBeNull();
  });
});
