// SPDX-License-Identifier: MIT
import { CATEGORY_DEFAULT_EMOJI, isSingleEmoji } from '@core/kernel';
import { describe, expect, it } from 'vitest';

// The shipped taxonomy, read as text (`?raw`, the AllocationDonut test's pattern): the web cannot import a context,
// but it can hold its own fallback table to the taxonomy's keys.
import TAXONOMY_SOURCE from '../../../../../packages/contexts/categorization/src/taxonomy.ts?raw';
import { categoryGlyph, iconHue, iconRoles, initialsOf } from './category-icon.ts';

function taxonomyKeys(): string[] {
  const keys = [...TAXONOMY_SOURCE.matchAll(/\bkey: '([a-z_.]+)'/gu)].map((match) => match[1]!);
  // `uncategorised` is declared through UNCATEGORISED_KEY, not a literal.
  if (TAXONOMY_SOURCE.includes("UNCATEGORISED_KEY = 'uncategorised'")) keys.push('uncategorised');
  return keys;
}

describe('the fallback icon table (WP 10.14)', () => {
  it('has an emoji for every system category in the shipped taxonomy', () => {
    const keys = taxonomyKeys();
    expect(keys.length).toBeGreaterThan(150);
    const missing = keys.filter((key) => !Object.hasOwn(CATEGORY_DEFAULT_EMOJI, key));
    expect(missing).toEqual([]);
    for (const key of keys) {
      const glyph = categoryGlyph({ id: 'x', key, label: 'Any', isSystem: true, emoji: null });
      expect(glyph.kind, key).toBe('emoji');
    }
  });

  it('holds no key the taxonomy lacks, and only single emoji', () => {
    const keys = new Set(taxonomyKeys());
    expect(Object.keys(CATEGORY_DEFAULT_EMOJI).filter((key) => !keys.has(key))).toEqual([]);
    for (const value of Object.values(CATEGORY_DEFAULT_EMOJI))
      expect(isSingleEmoji(value)).toBe(true);
  });
});

describe('categoryGlyph', () => {
  it('draws the stored emoji first', () => {
    expect(
      categoryGlyph({ id: 'a', key: 'groceries', label: 'Groceries', isSystem: true, emoji: '🥑' }),
    ).toEqual({ kind: 'emoji', text: '🥑', source: 'stored' });
  });

  it('falls back to the default for a system key when nothing is stored', () => {
    expect(
      categoryGlyph({ id: 'a', key: 'groceries', label: 'Groceries', isSystem: true, emoji: null }),
    ).toEqual({ kind: 'emoji', text: '🛒', source: 'default' });
  });

  it('gives a custom category its initials, never a default', () => {
    expect(
      categoryGlyph({
        id: 'a',
        key: 'groceries',
        label: 'Dog grooming',
        isSystem: false,
        emoji: null,
      }),
    ).toEqual({ kind: 'initials', text: 'DG' });
    expect(categoryGlyph({ id: 'a', key: 'custom.x', label: 'Rent', emoji: null })).toEqual({
      kind: 'initials',
      text: 'RE',
    });
  });

  it('never draws a stored value the server would refuse', () => {
    expect(
      categoryGlyph({ id: 'a', key: 'custom.x', label: 'Fun money', isSystem: false, emoji: 'ab' }),
    ).toEqual({ kind: 'initials', text: 'FM' });
  });

  it('keeps the initials rule it moved from the cash-flow avatar', () => {
    expect(initialsOf('Corner Grocery')).toBe('CG');
    expect(initialsOf('!!')).toBe('?');
  });
});

describe('the circle roles', () => {
  it('tints by the persisted hue through the event roles', () => {
    expect(iconHue({ id: 'a', label: 'x', hue: 'pink' })).toBe('pink');
    expect(iconRoles('pink')).toEqual({
      background: 'var(--chart-event-bg-pink)',
      color: 'var(--chart-event-fg-pink)',
    });
  });

  it('draws a row with no category neutral', () => {
    expect(iconHue({ id: null, label: 'Uncategorized' })).toBe('neutral');
    expect(iconRoles('neutral')).toEqual({
      background: 'var(--bg-secondary)',
      color: 'var(--text-secondary)',
    });
  });
});
