// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  hasActiveFilters,
  toTransactionsQuery,
  transactionsSearchSchema,
  type TransactionsSearch,
} from './filters.ts';

describe('transactionsSearchSchema', () => {
  it('accepts an empty search (no filters)', () => {
    expect(transactionsSearchSchema.parse({})).toEqual({});
  });

  it('round-trips through JSON, the shape the router stores in the URL', () => {
    const search: TransactionsSearch = {
      accounts: ['acct_1', 'acct_2'],
      from: '2026-01-01',
      to: '2026-01-31',
      amountMin: '-5000',
      amountMax: '5000',
      q: 'coffee',
      pending: true,
      excluded: false,
      transfers: 'exclude',
      uncategorized: true,
    };
    const roundTripped = transactionsSearchSchema.parse(
      JSON.parse(JSON.stringify(search)) as unknown,
    );
    expect(roundTripped).toEqual(search);
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => transactionsSearchSchema.parse({ from: '01/01/2026' })).toThrow();
  });

  it('rejects an amount that is not a signed integer string', () => {
    expect(() => transactionsSearchSchema.parse({ amountMin: '12.50' })).toThrow();
  });

  it('rejects an unknown transfers value', () => {
    expect(() => transactionsSearchSchema.parse({ transfers: 'sideways' })).toThrow();
  });
});

describe('hasActiveFilters', () => {
  it('is false for an empty search, including an empty query string', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: '' })).toBe(false);
  });

  it('is true once any filter (other than q) is set', () => {
    expect(hasActiveFilters({ accounts: ['a'] })).toBe(true);
    expect(hasActiveFilters({ excluded: false })).toBe(true);
    expect(hasActiveFilters({ transfers: 'only' })).toBe(true);
  });
});

describe('toTransactionsQuery', () => {
  it('maps an empty search to an empty query', () => {
    expect(toTransactionsQuery({})).toEqual({});
  });

  it('renames accounts to accountIds and drops an empty array', () => {
    expect(toTransactionsQuery({ accounts: ['a', 'b'] })).toEqual({ accountIds: ['a', 'b'] });
    expect(toTransactionsQuery({ accounts: [] })).toEqual({});
  });

  it('drops an empty search string rather than sending q=', () => {
    expect(toTransactionsQuery({ q: '' })).toEqual({});
    expect(toTransactionsQuery({ q: 'starbucks' })).toEqual({ q: 'starbucks' });
  });

  it('serialises booleans as the string enum the API expects', () => {
    expect(toTransactionsQuery({ pending: true, excluded: false, uncategorized: true })).toEqual({
      pending: 'true',
      excluded: 'false',
      uncategorized: 'true',
    });
  });

  it('passes date range, amount range and transfers through unchanged', () => {
    expect(
      toTransactionsQuery({
        from: '2026-01-01',
        to: '2026-01-31',
        amountMin: '-100',
        amountMax: '100',
        transfers: 'only',
      }),
    ).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      amountMin: '-100',
      amountMax: '100',
      transfers: 'only',
    });
  });
});
