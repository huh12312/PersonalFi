// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { Category } from '../../api/generated/types.gen.ts';
import { checkEmojiInput, draftOf, emojiChoices, moveInGrid, patchOf } from './editor.ts';

const GROCERIES: Category = {
  id: 'c1',
  key: 'groceries',
  parentId: null,
  label: 'Groceries',
  description: '',
  kind: 'expense',
  icon: 'shopping-basket',
  hue: 'teal',
  variability: null,
  emoji: null,
  sort: 0,
  isSystem: true,
  archivedAt: null,
  assignable: false,
};

describe('the emoji field (WP 10.14)', () => {
  it('accepts one emoji, ZWJ sequences and skin tones included', () => {
    expect(checkEmojiInput('🥑')).toEqual({ ok: true, value: '🥑' });
    expect(checkEmojiInput(' 👩🏽‍💻 ')).toEqual({ ok: true, value: '👩🏽‍💻' });
  });

  it.each(['ab', '🛒🛒', '1', 'a🛒'])('refuses %s with a message', (text) => {
    const check = checkEmojiInput(text);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(/exactly one emoji/u);
  });

  it('treats a blank field as no choice, not an error', () => {
    expect(checkEmojiInput('  ')).toEqual({ ok: true, value: null });
  });

  it('offers the default table as a grid, each emoji once', () => {
    const choices = emojiChoices();
    expect(choices.length).toBeGreaterThan(20);
    expect(choices.length).toBeLessThanOrEqual(48);
    expect(new Set(choices).size).toBe(choices.length);
    expect(choices).toContain('🛒');
  });
});

describe('the edit PATCH sends only what changed', () => {
  it('never writes the displayed default: a hue-only edit carries no emoji', () => {
    const draft = { ...draftOf(GROCERIES, ''), hue: 'pink' as const };
    expect(patchOf(GROCERIES, draft)).toEqual({ hue: 'pink' });
  });

  it('sends an emoji the holder chose, and null when they clear one', () => {
    expect(patchOf(GROCERIES, { ...draftOf(GROCERIES, ''), emoji: '🥑' })).toEqual({ emoji: '🥑' });
    const stored = { ...GROCERIES, emoji: '🥑' };
    expect(patchOf(stored, { ...draftOf(stored, ''), emoji: null })).toEqual({ emoji: null });
  });

  it('sends a renamed label trimmed, and variability only for an expense', () => {
    expect(
      patchOf(GROCERIES, { ...draftOf(GROCERIES, ''), label: ' Food ', variability: 'flexible' }),
    ).toEqual({ label: 'Food', variability: 'flexible' });
    const income = { ...GROCERIES, kind: 'income' as const };
    expect(patchOf(income, { ...draftOf(income, ''), variability: 'fixed' })).toEqual({});
  });

  it('is empty when nothing changed', () => {
    expect(patchOf(GROCERIES, draftOf(GROCERIES, ''))).toEqual({});
  });
});

describe('the radio grids', () => {
  it('wrap with the arrows and jump with Home and End', () => {
    expect(moveInGrid(13, 12, 'ArrowRight')).toBe(0);
    expect(moveInGrid(13, 0, 'ArrowLeft')).toBe(12);
    expect(moveInGrid(13, 4, 'ArrowDown')).toBe(5);
    expect(moveInGrid(13, 4, 'Home')).toBe(0);
    expect(moveInGrid(13, 4, 'End')).toBe(12);
    expect(moveInGrid(13, 4, ' ')).toBeNull();
  });
});
