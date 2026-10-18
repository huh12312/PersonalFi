// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { toTransactionsSearch } from './drill-through.ts';

describe('toTransactionsSearch', () => {
  it('maps categoryIds/from/to straight through, unchanged', () => {
    expect(
      toTransactionsSearch({
        categoryIds: ['cat_groceries', 'cat_dining'],
        from: '2026-08-01',
        to: '2026-09-01',
      }),
    ).toEqual({
      categoryIds: ['cat_groceries', 'cat_dining'],
      from: '2026-08-01',
      to: '2026-09-01',
    });
  });

  it('omits categoryIds entirely when the drill-through carries none (e.g. an income node)', () => {
    expect(toTransactionsSearch({ from: '2026-08-01', to: '2026-09-01' })).toEqual({
      from: '2026-08-01',
      to: '2026-09-01',
    });
  });

  it('omits categoryIds when the array is present but empty', () => {
    expect(toTransactionsSearch({ categoryIds: [], from: '2026-08-01', to: '2026-09-01' })).toEqual(
      { from: '2026-08-01', to: '2026-09-01' },
    );
  });

  it('carries merchantIds and uncategorized through (WP 10.10 closed the open item)', () => {
    expect(
      toTransactionsSearch({ merchantIds: ['merch_1'], from: '2026-08-01', to: '2026-09-01' }),
    ).toEqual({ merchantIds: ['merch_1'], from: '2026-08-01', to: '2026-09-01' });
    expect(
      toTransactionsSearch({ uncategorized: true, from: '2026-08-01', to: '2026-09-01' }),
    ).toEqual({ uncategorized: true, from: '2026-08-01', to: '2026-09-01' });
    expect(
      toTransactionsSearch({ uncategorized: false, from: '2026-08-01', to: '2026-09-01' }),
    ).toEqual({ from: '2026-08-01', to: '2026-09-01' });
  });
});
