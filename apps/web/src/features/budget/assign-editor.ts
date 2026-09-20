// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';

type Money = MoneyKernel;

/**
 * The inline-assign cell's own tiny state machine, kept apart from
 * `EnvelopeLineRow.tsx` so "arrow keys step the amount, Enter commits,
 * Escape reverts" is unit-testable without rendering anything — the same
 * split `features/inbox/inbox-reducer.ts` uses for the same reason.
 *
 * 05-frontend-architecture.md §5.6 specs a *drag* handle with ←/→ ±$10,
 * Shift+←/→ ±$100 for the allocation bar; this screen's "inline assign with
 * keyboard" (02-phase-2-dispatch.md §3 WP 2.9) is a plain numeric cell, not a
 * drag rail, so it reuses the same step sizes on ↑/↓ instead of ←/→ (←/→ stay
 * free for text-cursor movement inside the field, which a drag handle has no
 * text to move a cursor through).
 */
export interface AssignEditorState {
  /** `null` when the cell is not being edited — the server's own `assigned` is shown instead. */
  readonly draft: string | null;
}

export const CLOSED_ASSIGN_EDITOR: AssignEditorState = { draft: null };

export type AssignEditorAction =
  | { type: 'open'; initial: Money }
  | { type: 'type'; text: string }
  | { type: 'step'; direction: 1 | -1; big: boolean; currency: string }
  | { type: 'close' };

/** $10 per plain step, $100 with Shift — 05 §5.6's own numbers, reused (see module header). */
const STEP_DOLLARS = 10;
const BIG_STEP_DOLLARS = 100;

function stepAmount(current: Money, direction: 1 | -1, big: boolean, currency: string): Money {
  const scale = MoneyKernel.scaleOf(MoneyKernel.zero(currency));
  const dollars = big ? BIG_STEP_DOLLARS : STEP_DOLLARS;
  const deltaMinor = BigInt(dollars) * 10n ** BigInt(scale) * BigInt(direction);
  return MoneyKernel.add(current, MoneyKernel.of(deltaMinor, currency));
}

export function assignEditorReducer(
  state: AssignEditorState,
  action: AssignEditorAction,
): AssignEditorState {
  switch (action.type) {
    case 'open':
      return { draft: MoneyKernel.formatAmount(action.initial) };
    case 'type':
      return { draft: action.text };
    case 'step': {
      // Stepping from a draft that doesn't parse (e.g. mid-edit "12.") falls
      // back to zero rather than silently discarding the keystroke.
      let base: Money;
      try {
        base =
          state.draft === null
            ? MoneyKernel.zero(action.currency)
            : parseDraft(state.draft, action.currency);
      } catch {
        base = MoneyKernel.zero(action.currency);
      }
      const next = stepAmount(base, action.direction, action.big, action.currency);
      return { draft: MoneyKernel.formatAmount(next) };
    }
    case 'close':
      return CLOSED_ASSIGN_EDITOR;
    default:
      return state;
  }
}

/**
 * Parse the draft text into a `Money` for the commit call — throws
 * `InvalidValueError` (from `@core/kernel`) on malformed input, which the
 * caller turns into "press Escape to cancel" UI rather than a network call.
 */
export function parseDraft(draft: string, currency: string): Money {
  const trimmed = draft.trim();
  return MoneyKernel.parseAmount(trimmed === '' ? '0' : trimmed, currency);
}

/** Whether committing `draft` would even parse — used to disable the "Assign" action, not to swallow the error. */
export function isDraftValid(draft: string, currency: string): boolean {
  try {
    parseDraft(draft, currency);
    return true;
  } catch {
    return false;
  }
}
