// SPDX-License-Identifier: MIT
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../lib/cn.ts';
import { problemDetail } from '../narrator/narrator-api.ts';
import { useTransactionOverlayMutation } from '../transactions/useTransactionOverlay.ts';
import {
  invalidateExplanations,
  useRejectSuggestionMutation,
  type CategorySuggestion,
} from './suggestion-api.ts';

export interface SuggestionChipProps {
  readonly transactionId: string;
  readonly suggestion: CategorySuggestion;
  /** Called once the confirmed pick is saved (the Inbox resolves its row then). */
  readonly onConfirmed?: () => void;
  /** `list`: the transaction list's compact chip, inside a grid row. */
  readonly variant?: 'inbox' | 'list';
}

/** The row this chip sits in: the Inbox's list item or the transaction grid's row. Focus goes there afterwards. */
function hostOf(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>('[role="row"], li') ?? null;
}

/**
 * Enter and Space on a chip button are the button's own; the row and the grid around it open the transaction's
 * detail on Enter, so the key stops here (the button's click still happens).
 */
function keepKeyHere(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

/**
 * WP 11.2: "Suggested by the model: <category> — <reason>", the model's reason verbatim and the source always said,
 * with **Confirm** and **Not this**. It is visibly a suggestion, never an assignment: a dashed outline, and the row
 * beside it still reads uncategorised. Nothing is applied until the holder presses Confirm, which is the normal
 * pick (`PATCH /transactions/{id}` with the suggested category, through the same optimistic overlay mutation the
 * category picker uses). Not this records a rejection and assigns nothing; the explanations are read again, so the
 * chip leaves every row of that merchant.
 *
 * The buttons are never `disabled` while a request runs (`aria-disabled`), so focus stays on them; once the chip
 * goes, focus goes to its row rather than the document body (2.4.3).
 */
export function SuggestionChip({
  transactionId,
  suggestion,
  onConfirmed,
  variant = 'inbox',
}: SuggestionChipProps) {
  const queryClient = useQueryClient();
  const overlay = useTransactionOverlayMutation();
  const reject = useRejectSuggestionMutation();
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  const busy = overlay.isPending || reject.isPending;
  const label = suggestion.categoryLabel;

  if (hidden) return null;

  async function confirm(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (busy) return;
    setError(null);
    const host = hostOf(rootRef.current);
    // In the transaction list the pick is applied to the cached row at once (optimistic), which removes this chip
    // before the request returns: focus moves to the row first.
    if (variant === 'list') host?.focus();
    try {
      await overlay.mutateAsync({
        path: { transactionId },
        body: { categoryId: suggestion.categoryId },
      });
      onConfirmed?.();
      void invalidateExplanations(queryClient);
    } catch (cause) {
      setError(problemDetail(cause, `Could not file it under ${label}. Nothing was changed.`));
    }
  }

  async function notThis(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (busy) return;
    setError(null);
    const host = hostOf(rootRef.current);
    try {
      await reject.mutateAsync({ path: { transactionId } });
      host?.focus();
      setHidden(true);
    } catch (cause) {
      setError(problemDetail(cause, 'Could not record that. The suggestion is still shown.'));
    }
  }

  const list = variant === 'list';
  return (
    <div
      ref={rootRef}
      data-testid="suggestion-chip"
      data-category-id={suggestion.categoryId}
      className={cn(
        'flex flex-wrap items-center gap-x-3 rounded-md border border-dashed border-border-strong bg-bg-subtle',
        list ? 'gap-y-1 px-2 py-1' : 'gap-y-2 px-2.5 py-2',
      )}
    >
      <p
        id={textId}
        className={cn(
          'flex min-w-0 flex-1 basis-48 items-start gap-1.5 text-text-secondary [overflow-wrap:anywhere]',
          list ? 'text-caption' : 'text-small',
        )}
      >
        <Sparkles size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
        <span data-testid="suggestion-chip-text">
          Suggested by the model:{' '}
          <span className="font-medium text-text-primary">{suggestion.categoryLabel}</span> —{' '}
          {suggestion.reason}
        </span>
      </p>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Confirm ${label}`}
          aria-describedby={textId}
          aria-disabled={busy}
          onKeyDown={keepKeyHere}
          onClick={(event) => void confirm(event)}
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-describedby={textId}
          aria-disabled={busy}
          onKeyDown={keepKeyHere}
          onClick={(event) => void notThis(event)}
        >
          Not this
        </Button>
      </div>
      {error !== null && (
        <p className="basis-full text-small text-status-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
