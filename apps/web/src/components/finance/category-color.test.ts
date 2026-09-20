// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { categorySeriesVar } from './category-color.ts';

describe('categorySeriesVar', () => {
  it('is stable for the same category id', () => {
    expect(categorySeriesVar('cat_groceries')).toBe(categorySeriesVar('cat_groceries'));
  });

  it('returns the neutral token for null/uncategorised', () => {
    expect(categorySeriesVar(null)).toBe('var(--money-neutral)');
  });

  it('returns one of the eight fixed series tokens for a real id', () => {
    expect(categorySeriesVar('cat_dining')).toMatch(/^var\(--series-[1-8]\)$/);
  });
});
