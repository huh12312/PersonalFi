// SPDX-License-Identifier: MIT
import { defaultEmojiForKey, isChartHue, isSingleEmoji, type ChartHue } from '@core/kernel';

import { categoryHue, type FillHue } from './chart-hue.ts';

/**
 * What a category's icon shows (WP 10.14, V7; Monarch's equivalent): the holder's emoji when one is stored, else
 * the shipped default for a system category's key (`CATEGORY_DEFAULT_EMOJI`, `@core/kernel`), else the two-letter
 * initials of its name. **The default is a display fallback only** — nothing here, and nothing in the editor, ever
 * writes it to the row: the editor sends `emoji` only when the holder picks or clears one.
 */

/** The fields a category icon reads. Structural, so a breakdown row or a picker option can pass what it has. */
export interface CategoryIconSource {
  readonly id: string | null;
  readonly label: string;
  readonly key?: string | null;
  readonly hue?: string | null;
  readonly emoji?: string | null;
  readonly isSystem?: boolean;
}

/** Two-letter initials for an avatar: "Corner Grocery" → "CG", "Rent" → "RE", "7-Eleven" → "7E". */
export function initialsOf(label: string): string {
  const words = label
    .replace(/\(.*\)/u, '')
    .split(/[\s\-/&]+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '').charAt(0)}${(words[1] ?? '').charAt(0)}`.toUpperCase();
}

export type CategoryGlyph =
  | { readonly kind: 'emoji'; readonly text: string; readonly source: 'stored' | 'default' }
  | { readonly kind: 'initials'; readonly text: string };

/**
 * The glyph to draw: the stored emoji (when it is one — a value the server would refuse is never drawn), else the
 * default for a **system** category's key, else the initials. A custom category never borrows a default, even if
 * its key happened to match one.
 */
export function categoryGlyph(source: CategoryIconSource): CategoryGlyph {
  const stored = source.emoji ?? null;
  if (stored !== null && isSingleEmoji(stored))
    return { kind: 'emoji', text: stored, source: 'stored' };
  if (source.isSystem !== false && source.key !== undefined && source.key !== null) {
    const fallback = defaultEmojiForKey(source.key);
    if (fallback !== null) return { kind: 'emoji', text: fallback, source: 'default' };
  }
  return { kind: 'initials', text: initialsOf(source.label) };
}

/** The hue the circle is tinted by: the persisted hue, else the seed; a row with no id is neutral. */
export function iconHue(source: CategoryIconSource): FillHue {
  if (source.id === null) return isChartHue(source.hue) ? source.hue : 'neutral';
  return categoryHue(source.id, source.hue ?? null);
}

/**
 * The circle's roles (docs/design/tokens.md, "CategoryIcon"): the wash `--chart-event-bg-<hue>` behind the glyph,
 * the initials in `--chart-event-fg-<hue>` (the event roles' text-on-wash pair, validated 4.5:1 by contrast.test.ts);
 * the neutral row uses `--bg-secondary` and `--text-secondary`.
 */
export function iconRoles(hue: FillHue): { readonly background: string; readonly color: string } {
  if (hue === 'neutral')
    return { background: 'var(--bg-secondary)', color: 'var(--text-secondary)' };
  const named: ChartHue = hue;
  return {
    background: `var(--chart-event-bg-${named})`,
    color: `var(--chart-event-fg-${named})`,
  };
}
