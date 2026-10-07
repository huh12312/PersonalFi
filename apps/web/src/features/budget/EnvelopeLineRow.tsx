// SPDX-License-Identifier: MIT
import { useEffect, useReducer, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import type { BudgetLine } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { Input } from '../../components/ui/input.tsx';
import { cn } from '../../lib/cn.ts';
import { parseWireMoney } from '../../lib/money.ts';
import { useUpdateBudgetLineMutation } from './api.ts';
import {
  assignEditorReducer,
  CLOSED_ASSIGN_EDITOR,
  isDraftValid,
  parseDraft,
} from './assign-editor.ts';
import {
  availableToneOf,
  goalProgressOf,
  neededHintOf,
  overspendToneOf,
} from './envelope-display.ts';
import { GoalPolicyEditor } from './GoalPolicyEditor.tsx';

export interface EnvelopeLineRowProps {
  line: BudgetLine;
  categoryLabel: string;
}

const AVAILABLE_TONE_CLASS: Record<string, string> = {
  positive: 'text-money-pos-text',
  negative: 'text-money-neg-text',
  zero: 'text-text-secondary',
};

const OVERSPEND_BADGE: Record<'cash' | 'credit', { label: string; className: string }> = {
  cash: { label: 'Cash overspend', className: 'bg-danger text-on-danger' },
  credit: { label: 'Credit overspend', className: 'bg-status-warning text-on-status-warning' },
};

/**
 * One envelope row: assigned (editable), activity, available (colour by
 * sign, cash-red vs credit-yellow overspend badge — 07 §1.3, 05 §2.2), the
 * "assign $X more to stay on track" hint, a goal-progress bar, and the
 * goal/rollover editor. Assigning is inline, keyboard-first
 * (`assign-editor.ts`'s own module header explains the key bindings).
 *
 * **`kind: 'credit_card_payment'` lines are read-only in this UI.** The API
 * does not technically refuse a direct `assigned`/goal write to a CCP line
 * (`wp2.r-routes.md` §4's `PATCH` is one generic path for both kinds), but a
 * CCP envelope's balance is a *consequence* of the funding rule (07 §1.3:
 * "only the funded part moves" from a category into `CCP[card]` on a card
 * charge) — a user typing a number into it directly could desynchronise it
 * from the very identity (`owed = available(CCP) + unfundedDebt`) the
 * budgeting context enforces server-side. This is a UI-level conservatism,
 * not an API contract; recorded as an open item in
 * `docs/evidence/phase-2/wp2.9-budget-ui.md`.
 */
export function EnvelopeLineRow({ line, categoryLabel }: EnvelopeLineRowProps) {
  const [editor, dispatch] = useReducer(assignEditorReducer, CLOSED_ASSIGN_EDITOR);
  const update = useUpdateBudgetLineMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const currency = line.assigned.currency;

  // Focus the field the moment editing opens, without `autoFocus` (banned by
  // `jsx-a11y/no-autofocus` — a page-load autofocus steals attention from
  // wherever the user actually was; this is scoped to a state transition the
  // user themselves just triggered by clicking/activating the amount cell,
  // which is the accepted exception the rule's own rationale carves out).
  useEffect(() => {
    if (editor.draft !== null) inputRef.current?.focus();
  }, [editor.draft]);

  const readOnly = line.kind === 'credit_card_payment';
  const overspend = overspendToneOf(line);
  const tone = availableToneOf(line);
  const hint = neededHintOf(line);
  const progress = goalProgressOf(line);

  function commit(): void {
    if (editor.draft === null || !isDraftValid(editor.draft, currency)) {
      dispatch({ type: 'close' });
      return;
    }
    const money = parseDraft(editor.draft, currency);
    update.mutate(
      {
        path: { lineId: line.id },
        body: { assigned: { minor: money.minor.toString(), currency } },
      },
      { onSuccess: () => dispatch({ type: 'close' }) },
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      dispatch({
        type: 'step',
        direction: event.key === 'ArrowUp' ? 1 : -1,
        big: event.shiftKey,
        currency,
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dispatch({ type: 'close' });
      inputRef.current?.blur();
    }
  }

  return (
    <li className="grid grid-cols-[1fr_repeat(3,minmax(0,7rem))_auto] items-center gap-3 rounded-md border border-border-hairline bg-bg-surface p-3">
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-text-primary">{categoryLabel}</p>
        {readOnly && (
          <p className="text-caption text-text-muted">Card payment — funded automatically</p>
        )}
        {hint !== null && !readOnly && (
          <p className="text-caption text-status-warning">
            Assign <Money value={{ minor: hint.amount.minor.toString(), currency }} /> more to stay
            on track
          </p>
        )}
        {progress !== null && (
          <progress
            className="mt-1 h-1.5 w-full max-w-40 [accent-color:var(--accent)]"
            value={progress}
            max={1}
            aria-label={`Goal progress for ${categoryLabel}`}
          />
        )}
      </div>

      <div className="text-right">
        {readOnly ? (
          <Money value={line.assigned} className="tabular-nums" />
        ) : editor.draft === null ? (
          <button
            type="button"
            className="w-full rounded px-2 py-1 text-right tabular-nums hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`Assign amount for ${categoryLabel}`}
            onClick={() => dispatch({ type: 'open', initial: parseWireMoney(line.assigned) })}
          >
            <Money value={line.assigned} />
          </button>
        ) : (
          <Input
            ref={inputRef}
            aria-label={`Assign amount for ${categoryLabel}`}
            inputMode="decimal"
            className="h-9 text-right tabular-nums"
            value={editor.draft}
            aria-invalid={!isDraftValid(editor.draft, currency)}
            onChange={(event) => dispatch({ type: 'type', text: event.target.value })}
            onKeyDown={handleKeyDown}
            onBlur={commit}
          />
        )}
      </div>

      <div className="text-right">
        <Money value={line.activity} />
      </div>

      <div className="text-right">
        <span className={cn('tabular-nums', AVAILABLE_TONE_CLASS[tone])}>
          <Money value={line.available} colorBySign={false} />
        </span>
        {overspend !== 'none' && (
          <span
            className={cn(
              'ml-2 inline-block rounded px-1.5 py-0.5 text-caption font-medium',
              OVERSPEND_BADGE[overspend].className,
            )}
          >
            {OVERSPEND_BADGE[overspend].label}
          </span>
        )}
      </div>

      {readOnly ? <span aria-hidden="true" /> : <GoalPolicyEditor line={line} />}
    </li>
  );
}
