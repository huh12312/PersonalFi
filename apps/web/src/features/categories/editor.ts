// SPDX-License-Identifier: MIT
import { CATEGORY_DEFAULT_EMOJI, CHART_HUES, isSingleEmoji, type ChartHue } from '@core/kernel';

import type { Category, CategoryVariability } from '../../api/generated/types.gen.ts';

/**
 * The category editor's rules (WP 10.14), pure so they are tested without a dialog.
 *
 * **Only what the holder changed is sent.** An unchanged emoji is never in the PATCH body — in particular the shipped
 * default the icon *displays* for a system category is never written (the column stays NULL, and a later change to
 * the default table still reaches it). Clearing sends `emoji: null`.
 */

/** The picker's grid: every distinct emoji of the default table, in table order, at most `limit`. */
export function emojiChoices(limit = 48): readonly string[] {
  const seen = new Set<string>();
  for (const value of Object.values(CATEGORY_DEFAULT_EMOJI)) {
    if (seen.size >= limit) break;
    seen.add(value);
  }
  return [...seen];
}

export type EmojiInputCheck =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly message: string };

/** The free-text field: blank is "no change from the grid", one emoji is a choice, anything else is refused. */
export function checkEmojiInput(text: string): EmojiInputCheck {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (isSingleEmoji(trimmed)) return { ok: true, value: trimmed };
  return { ok: false, message: 'Enter exactly one emoji — no letters, digits or second emoji.' };
}

export interface EditorDraft {
  readonly label: string;
  /** null = no emoji of its own (the default or the initials show). */
  readonly emoji: string | null;
  /** null = not chosen (a new category: the server seeds it from the id). */
  readonly hue: ChartHue | null;
  readonly variability: CategoryVariability | null;
}

export function draftOf(category: Category | null, initialLabel: string): EditorDraft {
  if (category === null) return { label: initialLabel, emoji: null, hue: null, variability: null };
  return {
    label: category.label,
    emoji: category.emoji ?? null,
    hue: category.hue,
    variability: category.variability ?? null,
  };
}

export interface CategoryPatch {
  label?: string;
  emoji?: string | null;
  hue?: ChartHue;
  variability?: CategoryVariability | null;
}

/** The PATCH body for an edit: the fields that differ from the stored category, and nothing else. */
export function patchOf(category: Category, draft: EditorDraft): CategoryPatch {
  const patch: CategoryPatch = {};
  const label = draft.label.trim();
  if (label !== '' && label !== category.label) patch.label = label;
  if (draft.emoji !== (category.emoji ?? null)) patch.emoji = draft.emoji;
  if (draft.hue !== null && draft.hue !== category.hue) patch.hue = draft.hue;
  if (category.kind === 'expense' && draft.variability !== (category.variability ?? null)) {
    patch.variability = draft.variability;
  }
  return patch;
}

export const HUE_LABEL: Record<ChartHue, string> = Object.fromEntries(
  CHART_HUES.map((hue) => [hue, hue.charAt(0).toUpperCase() + hue.slice(1)]),
) as Record<ChartHue, string>;

/** Roving focus over a radio grid: arrows move (and select), Home/End jump. Null = not a key the grid owns. */
export function moveInGrid(count: number, current: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
