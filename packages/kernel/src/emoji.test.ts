// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  CATEGORY_DEFAULT_EMOJI,
  MAX_EMOJI_CODE_POINTS,
  defaultEmojiForKey,
  isSingleEmoji,
} from './emoji.ts';

describe('isSingleEmoji (WP 10.14)', () => {
  it.each([
    ['a plain pictograph', '🛒'],
    ['a pictograph with VS16', '🍽️'],
    ['a skin-tone modifier', '👍🏽'],
    ['a ZWJ profession with a skin tone', '👩🏽‍💻'],
    ['a four-person ZWJ family', '👨‍👩‍👧‍👦'],
    ['a ZWJ flag', '🏳️‍🌈'],
    ['a regional-indicator flag', '🇨🇦'],
    ['a tag-sequence flag', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
    ['a keycap', '1️⃣'],
  ])('accepts %s', (_name, value) => {
    expect(isSingleEmoji(value)).toBe(true);
  });

  it.each([
    ['the empty string', ''],
    ['two letters', 'ab'],
    ['one letter', 'a'],
    ['a digit', '1'],
    ['two emoji', '🛒🛒'],
    ['an emoji and a letter', '🛒a'],
    ['a leading space', ' 🛒'],
    ['a pictograph with a combining accent', '🛒́'],
    ['three regional indicators', '🇨🇦🇺'],
    ['a lone ZWJ', '‍'],
    ['two skin-tone modifiers with no base', '\u{1F3FD}\u{1F3FD}'],
  ])('rejects %s', (_name, value) => {
    expect(isSingleEmoji(value)).toBe(false);
  });

  it('rejects a single grapheme longer than the column allows', () => {
    // kiss: person, person, skin tones — 10 code points, one grapheme
    const kiss = '🧑🏻‍❤️‍💋‍🧑🏼';
    expect([...kiss].length).toBeGreaterThan(MAX_EMOJI_CODE_POINTS);
    expect(isSingleEmoji(kiss)).toBe(false);
  });
});

describe('CATEGORY_DEFAULT_EMOJI', () => {
  it('holds only values isSingleEmoji accepts', () => {
    for (const [key, value] of Object.entries(CATEGORY_DEFAULT_EMOJI)) {
      expect(isSingleEmoji(value), key).toBe(true);
    }
  });

  it('names the brief’s table', () => {
    expect(defaultEmojiForKey('groceries')).toBe('🛒');
    expect(defaultEmojiForKey('dining')).toBe('🍽️');
    expect(defaultEmojiForKey('transport')).toBe('🚗');
    expect(defaultEmojiForKey('housing.rent')).toBe('🏠');
    expect(defaultEmojiForKey('utilities')).toBe('💡');
    expect(defaultEmojiForKey('subscriptions')).toBe('📺');
    expect(defaultEmojiForKey('health')).toBe('🩺');
    expect(defaultEmojiForKey('shopping')).toBe('🛍️');
    expect(defaultEmojiForKey('travel')).toBe('✈️');
    expect(defaultEmojiForKey('income.salary')).toBe('💰');
    expect(defaultEmojiForKey('transfers')).toBe('🔁');
    expect(defaultEmojiForKey('shopping.gifts')).toBe('🎁');
    expect(defaultEmojiForKey('insurance')).toBe('🛡️');
    expect(defaultEmojiForKey('education')).toBe('🎓');
    expect(defaultEmojiForKey('fees_and_services')).toBe('🧾');
    expect(defaultEmojiForKey('uncategorised')).toBe('❔');
  });

  it('has no default for a custom key, including an inherited property name', () => {
    expect(defaultEmojiForKey('custom.my_thing')).toBeNull();
    expect(defaultEmojiForKey('toString')).toBeNull();
  });
});
