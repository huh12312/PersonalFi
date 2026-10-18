// SPDX-License-Identifier: MIT
/**
 * WP 10.13 (V6): the pure halves of net worth by account type — the bucketing rule, the account-type
 * mapping and the milestone ladder. The database halves (the one read, segment-sum equality, the
 * idempotent insert) are `test/db/net-worth-buckets.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { bucketSpine, bucketStartOf, segmentKindOf } from '../src/buckets.ts';
import { milestonesCrossed } from '../src/milestones.ts';

const K = 100_000n; // $1,000.00 in minor units

describe('bucketStartOf', () => {
  it('a day is its own bucket', () => {
    expect(bucketStartOf('2026-10-03', 'day')).toBe('2026-10-03');
  });

  it('weeks run Monday to Sunday (ISO): Sunday belongs to the week that began six days before', () => {
    // 2026-10-05 is a Monday.
    expect(bucketStartOf('2026-10-05', 'week')).toBe('2026-10-05');
    expect(bucketStartOf('2026-10-06', 'week')).toBe('2026-10-05');
    expect(bucketStartOf('2026-10-11', 'week')).toBe('2026-10-05'); // Sunday
    expect(bucketStartOf('2026-10-12', 'week')).toBe('2026-10-12'); // the next Monday
    expect(bucketStartOf('2026-10-04', 'week')).toBe('2026-09-28'); // the Sunday before
  });

  it('a week straddling a month and a year end keeps its Monday', () => {
    // 2026-12-28 is a Monday; 2027-01-03 the Sunday after.
    expect(bucketStartOf('2027-01-01', 'week')).toBe('2026-12-28');
    expect(bucketStartOf('2027-01-03', 'week')).toBe('2026-12-28');
    expect(bucketStartOf('2027-01-04', 'week')).toBe('2027-01-04');
  });

  it('months start on the 1st, month ends and leap days included', () => {
    expect(bucketStartOf('2026-01-31', 'month')).toBe('2026-01-01');
    expect(bucketStartOf('2026-02-28', 'month')).toBe('2026-02-01');
    expect(bucketStartOf('2028-02-29', 'month')).toBe('2028-02-01');
    expect(bucketStartOf('2026-03-01', 'month')).toBe('2026-03-01');
  });
});

describe('bucketSpine', () => {
  it('cuts the first and last week at the window edges and leaves no day uncovered', () => {
    // Thursday 2026-10-01 … Wednesday 2026-10-21.
    const spine = bucketSpine('2026-10-01', '2026-10-21', 'week');
    expect(spine).toEqual([
      { key: '2026-09-28', start: '2026-10-01', end: '2026-10-04' },
      { key: '2026-10-05', start: '2026-10-05', end: '2026-10-11' },
      { key: '2026-10-12', start: '2026-10-12', end: '2026-10-18' },
      { key: '2026-10-19', start: '2026-10-19', end: '2026-10-21' },
    ]);
  });

  it('months: end on the month’s own last day (28, 30, 31), cut at the window', () => {
    const spine = bucketSpine('2026-01-15', '2026-04-10', 'month');
    expect(spine.map((b) => [b.start, b.end])).toEqual([
      ['2026-01-15', '2026-01-31'],
      ['2026-02-01', '2026-02-28'],
      ['2026-03-01', '2026-03-31'],
      ['2026-04-01', '2026-04-10'],
    ]);
  });

  it('days: one bucket per calendar day, 30 for a 30-day window', () => {
    const spine = bucketSpine('2026-09-19', '2026-10-18', 'day');
    expect(spine).toHaveLength(30);
    expect(spine[0]).toEqual({ key: '2026-09-19', start: '2026-09-19', end: '2026-09-19' });
  });
});

describe('segmentKindOf', () => {
  it('the side decides first: every liability-side entry is a liability, whatever its type', () => {
    expect(segmentKindOf({ kind: 'credit', side: 'liability' })).toBe('liabilities');
    expect(
      segmentKindOf({ kind: 'loan', side: 'liability' }, { type: 'manual', subtype: 'home' }),
    ).toBe('liabilities');
  });

  it('the ledger type and subtype tell crypto from a brokerage and a house from a bond', () => {
    expect(
      segmentKindOf({ kind: 'investment', side: 'asset' }, { type: 'crypto', subtype: null }),
    ).toBe('crypto');
    expect(
      segmentKindOf({ kind: 'investment', side: 'asset' }, { type: 'investment', subtype: '401k' }),
    ).toBe('investments');
    expect(
      segmentKindOf(
        { kind: 'manual_asset', side: 'asset' },
        { type: 'manual', subtype: 'real_estate' },
      ),
    ).toBe('property');
    expect(
      segmentKindOf({ kind: 'manual_asset', side: 'asset' }, { type: 'manual', subtype: 'bond' }),
    ).toBe('other');
    expect(
      segmentKindOf({ kind: 'cash', side: 'asset' }, { type: 'depository', subtype: null }),
    ).toBe('cash');
  });

  it('an account the ledger no longer lists falls back to the breakdown’s own class', () => {
    expect(segmentKindOf({ kind: 'cash', side: 'asset' })).toBe('cash');
    expect(segmentKindOf({ kind: 'investment', side: 'asset' })).toBe('investments');
    expect(segmentKindOf({ kind: 'manual_asset', side: 'asset' })).toBe('other');
  });
});

describe('milestonesCrossed', () => {
  it('crossing up one rung', () => {
    expect(milestonesCrossed(48n * K, 51n * K)).toEqual([
      { milestoneMinor: 50n * K, direction: 'up' },
    ]);
  });

  it('landing exactly on a rung crosses it; starting on one does not cross it again', () => {
    expect(milestonesCrossed(49n * K, 50n * K)).toEqual([
      { milestoneMinor: 50n * K, direction: 'up' },
    ]);
    expect(milestonesCrossed(50n * K, 60n * K)).toEqual([]);
  });

  it('a jump across two milestones crosses both, lowest first', () => {
    expect(milestonesCrossed(20n * K, 60n * K)).toEqual([
      { milestoneMinor: 25n * K, direction: 'up' },
      { milestoneMinor: 50n * K, direction: 'up' },
    ]);
  });

  it('above $100k, every $100k', () => {
    expect(milestonesCrossed(99n * K, 301n * K)).toEqual([
      { milestoneMinor: 100n * K, direction: 'up' },
      { milestoneMinor: 200n * K, direction: 'up' },
      { milestoneMinor: 300n * K, direction: 'up' },
    ]);
    expect(milestonesCrossed(150n * K, 199n * K)).toEqual([]);
  });

  it('crossing down through zero is a milestone; falling under $50k is not', () => {
    expect(milestonesCrossed(3n * K, -2n * K)).toEqual([{ milestoneMinor: 0n, direction: 'down' }]);
    expect(milestonesCrossed(0n, -1n)).toEqual([{ milestoneMinor: 0n, direction: 'down' }]);
    expect(milestonesCrossed(51n * K, 49n * K)).toEqual([]);
  });

  it('crossing up through zero, and on past $10k in one step', () => {
    expect(milestonesCrossed(-5n * K, 12n * K)).toEqual([
      { milestoneMinor: 0n, direction: 'up' },
      { milestoneMinor: 10n * K, direction: 'up' },
    ]);
  });

  it('no movement, no milestone', () => {
    expect(milestonesCrossed(25n * K, 25n * K)).toEqual([]);
    expect(milestonesCrossed(-3n * K, -1n * K)).toEqual([]);
  });
});
