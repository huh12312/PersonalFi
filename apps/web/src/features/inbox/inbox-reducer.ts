// SPDX-License-Identifier: MIT
import type { Transaction } from '../../api/generated/types.gen.ts';

/**
 * The review inbox's item model and its pure state reducer, kept apart from
 * `InboxScreen.tsx` so the "resolving an item removes it and moves focus to
 * its neighbour" behaviour — the thing that makes "twenty items clear with
 * keyboard only" (the e2e exit test) actually true — is unit-testable
 * without rendering anything.
 */
export type InboxItem =
  | { id: string; kind: 'uncategorized'; transaction: Transaction }
  | { id: string; kind: 'transfer'; outflow: Transaction; inflow: Transaction };

export function uncategorizedItem(transaction: Transaction): InboxItem {
  return { id: `uncategorized:${transaction.id}`, kind: 'uncategorized', transaction };
}

export function transferItem(outflow: Transaction, inflow: Transaction): InboxItem {
  return { id: `transfer:${outflow.id}:${inflow.id}`, kind: 'transfer', outflow, inflow };
}

export interface InboxState {
  readonly items: readonly InboxItem[];
  readonly focusedId: string | null;
}

export const EMPTY_INBOX_STATE: InboxState = { items: [], focusedId: null };

export type InboxAction =
  | { type: 'set-items'; items: readonly InboxItem[] }
  | { type: 'resolve'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'focus-delta'; delta: 1 | -1 };

/**
 * `set-items` keeps the current focus if it still names a live item (a
 * background refetch must not yank keyboard focus off whatever the user is
 * looking at); otherwise it focuses the first item, or nothing if the inbox
 * is empty.
 *
 * `resolve` drops the named item and, if it was the focused one, moves focus
 * to what is now in its place — the item that slid up to fill the gap, or the
 * new last item if the resolved row was the last one. This is what lets a
 * user clear a whole queue by repeating one keystroke without ever having to
 * re-find focus.
 */
export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'set-items': {
      const stillFocused = action.items.some((item) => item.id === state.focusedId);
      return {
        items: action.items,
        focusedId: stillFocused ? state.focusedId : (action.items[0]?.id ?? null),
      };
    }
    case 'resolve': {
      const index = state.items.findIndex((item) => item.id === action.id);
      if (index === -1) return state;
      const items = state.items.filter((item) => item.id !== action.id);
      if (state.focusedId !== action.id) return { items, focusedId: state.focusedId };
      const nextFocused = items[index] ?? items[index - 1] ?? null;
      return { items, focusedId: nextFocused?.id ?? null };
    }
    case 'focus':
      return state.items.some((item) => item.id === action.id)
        ? { ...state, focusedId: action.id }
        : state;
    case 'focus-delta': {
      if (state.items.length === 0) return state;
      const index = state.items.findIndex((item) => item.id === state.focusedId);
      const currentIndex = index === -1 ? 0 : index;
      const nextIndex = Math.min(Math.max(currentIndex + action.delta, 0), state.items.length - 1);
      return { ...state, focusedId: state.items[nextIndex]?.id ?? null };
    }
    default:
      return state;
  }
}
