// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { ReportCategoryMonthCell } from '../../api/generated/types.gen.ts';
import { lastCalendarMonthRange, planSeedLines } from './seed-from-last-month.ts';

function cell(overrides: Partial<ReportCategoryMonthCell>): ReportCategoryMonthCell {
  return {
    month: '2026-08',
    categoryId: 'cat_groceries',
    amount: { minor: '-10000', currency: 'USD' },
    transactionCount: 1,
    transferExcludedCount: 0,
    refundNettedCount: 0,
    drillThrough: { from: '2026-08-01', to: '2026-09-01', categoryIds: ['cat_groceries'] },
    ...overrides,
  };
}

describe('planSeedLines', () => {
  it('assigns the exact absolute spend for a category that netted negative', () => {
    const lines = planSeedLines([cell({})], 'USD');
    expect(lines).toEqual([
      { categoryId: 'cat_groceries', assign: { minor: 10000n, currency: 'USD' } },
    ]);
  });

  it('folds multiple cells for the same category across months, bigint-exact', () => {
    const lines = planSeedLines(
      [
        cell({ month: '2026-07', amount: { minor: '-3000', currency: 'USD' } }),
        cell({ month: '2026-08', amount: { minor: '-4500', currency: 'USD' } }),
      ],
      'USD',
    );
    expect(lines[0]?.assign.minor).toBe(7500n);
  });

  it('skips the null (uncategorised) bucket', () => {
    const lines = planSeedLines([cell({ categoryId: null })], 'USD');
    expect(lines).toEqual([]);
  });

  it('skips a category that netted positive (refunds outweighing spend)', () => {
    const lines = planSeedLines([cell({ amount: { minor: '500', currency: 'USD' } })], 'USD');
    expect(lines).toEqual([]);
  });

  it('skips a category exactly at zero', () => {
    const lines = planSeedLines([cell({ amount: { minor: '0', currency: 'USD' } })], 'USD');
    expect(lines).toEqual([]);
  });

  it('drops a cell in a currency other than the budget currency', () => {
    const lines = planSeedLines([cell({ amount: { minor: '-10000', currency: 'EUR' } })], 'USD');
    expect(lines).toEqual([]);
  });
});

describe('lastCalendarMonthRange', () => {
  it('returns the [first-of-last-month, first-of-this-month) half-open bound', () => {
    expect(lastCalendarMonthRange(new Date(Date.UTC(2026, 8, 20)))).toEqual({
      from: '2026-08-01',
      to: '2026-09-01',
    });
  });

  it('crosses a year boundary correctly', () => {
    expect(lastCalendarMonthRange(new Date(Date.UTC(2026, 0, 15)))).toEqual({
      from: '2025-12-01',
      to: '2026-01-01',
    });
  });
});
