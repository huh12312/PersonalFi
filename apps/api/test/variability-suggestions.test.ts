// SPDX-License-Identifier: MIT
/** The pure half of the variability suggestion (WP 10.11, `src/reports/variability-suggestions.ts`). */
import { DateOnly, Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  isSuggestingSeries,
  suggestFixedCategories,
  suggestionWindow,
  type SuggestionSeries,
} from '../src/reports/variability-suggestions.ts';

const series = (over: Partial<SuggestionSeries> = {}): SuggestionSeries => ({
  id: 's1',
  merchantId: 'm1',
  state: 'ACTIVE',
  status: 'ACTIVE',
  sign: 'OUTFLOW',
  firstSeen: '2026-07-01',
  lastSeen: '2026-10-01',
  ...over,
});

const row = (
  over: Partial<{
    date: string;
    minor: bigint;
    categoryId: string | null;
    merchantId: string;
    isTransfer: boolean;
    excluded: boolean;
  }> = {},
) => ({
  date: DateOnly.parse(over.date ?? '2026-08-01'),
  amount: Money.of(over.minor ?? -1599n, 'USD'),
  categoryId: over.categoryId === undefined ? 'cat-a' : over.categoryId,
  merchantId: over.merchantId ?? 'm1',
  isTransfer: over.isTransfer ?? false,
  excluded: over.excluded ?? false,
});

const cats = [
  { id: 'cat-a', kind: 'expense' as const, variability: null, archivedAt: null },
  { id: 'cat-b', kind: 'expense' as const, variability: null, archivedAt: null },
  { id: 'cat-fixed', kind: 'expense' as const, variability: 'flexible' as const, archivedAt: null },
  { id: 'cat-income', kind: 'income' as const, variability: null, archivedAt: null },
];

describe('variability suggestions (pure)', () => {
  it('only an active, still-projecting outflow stream suggests', () => {
    expect(isSuggestingSeries(series())).toBe(true);
    expect(isSuggestingSeries(series({ state: 'CANDIDATE' }))).toBe(false);
    expect(isSuggestingSeries(series({ state: 'ARCHIVED' }))).toBe(false);
    expect(isSuggestingSeries(series({ status: 'CANCELED' }))).toBe(false);
    expect(isSuggestingSeries(series({ status: 'LIKELY_CANCELED' }))).toBe(false);
    expect(isSuggestingSeries(series({ sign: 'INFLOW' }))).toBe(false);
    for (const status of ['EARLY_DETECTION', 'AT_RISK', 'MIGRATED']) {
      expect(isSuggestingSeries(series({ status }))).toBe(true);
    }
  });

  it('the modal category of the merchant’s outflows inside the stream’s span; ties break on id', () => {
    const rows = [
      row({ categoryId: 'cat-b' }),
      row({ categoryId: 'cat-a' }),
      row({ categoryId: 'cat-a', date: '2026-09-01' }),
      row({ categoryId: 'cat-b', date: '2026-06-01' }), // before firstSeen
      row({ categoryId: 'cat-b', isTransfer: true }),
      row({ categoryId: 'cat-b', excluded: true }),
      row({ categoryId: 'cat-b', minor: 1599n }), // a refund is not the stream's spend
      row({ categoryId: 'cat-b', merchantId: 'm2' }),
    ];
    expect(suggestFixedCategories({ series: [series()], rows, categories: cats })).toEqual([
      { categoryId: 'cat-a', variability: 'fixed', seriesIds: ['s1'] },
    ]);
    expect(
      suggestFixedCategories({
        series: [series()],
        rows: [row({ categoryId: 'cat-b' }), row({ categoryId: 'cat-a' })],
        categories: cats,
      })[0]?.categoryId,
    ).toBe('cat-a');
  });

  it('never suggests a classified, an income, an unknown or an uncategorised category', () => {
    for (const categoryId of ['cat-fixed', 'cat-income', 'cat-unknown', null]) {
      expect(
        suggestFixedCategories({
          series: [series()],
          rows: [row({ categoryId })],
          categories: cats,
        }),
      ).toEqual([]);
    }
  });

  it('two streams into one category are one suggestion with both ids', () => {
    const rows = [row(), row({ merchantId: 'm2' })];
    expect(
      suggestFixedCategories({
        series: [series({ id: 's2', merchantId: 'm2' }), series()],
        rows,
        categories: cats,
      }),
    ).toEqual([{ categoryId: 'cat-a', variability: 'fixed', seriesIds: ['s1', 's2'] }]);
  });

  it('the read window is the streams’ span clipped to the lookback, or none without a stream', () => {
    const today = DateOnly.parse('2026-10-18');
    expect(suggestionWindow([], today)).toBeNull();
    expect(suggestionWindow([series({ state: 'CANDIDATE' })], today)).toBeNull();
    expect(suggestionWindow([series()], today)).toEqual({ from: '2026-07-01', to: '2026-10-18' });
    expect(suggestionWindow([series({ firstSeen: '2020-01-01' })], today)?.from).toBe('2025-09-13');
  });
});
