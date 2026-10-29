// SPDX-License-Identifier: MIT
import { Sparkles } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../lib/cn.ts';
import { problemDetail } from '../narrator/narrator-api.ts';
import {
  useAcceptMerchantNameMutation,
  useDismissMerchantNameMutation,
  type MerchantNameSuggestion,
} from './merchant-name-api.ts';
import { acceptedWords, dismissedWords, provenanceWords } from './merchant-name-words.ts';

export interface MerchantNameChipProps {
  readonly suggestion: MerchantNameSuggestion;
  /** `list`: the transaction list's compact chip, inside a grid row. `detail`: in the detail sheet. */
  readonly variant?: 'list' | 'detail';
  /** What an Accept or a Dismiss did, in words, for the host's status line. */
  readonly onResult?: (message: string) => void;
}

/** The row this chip sits in: the grid's row. Focus goes there afterwards. */
function hostOf(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>('[role="row"]') ?? null;
}

/** Enter and Space on a chip button are the button's own; the row around it opens the detail on Enter. */
function keepKeyHere(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

/**
 * Focus on a chip button must not reach the row's own `onFocus`: that moves the list's roving index, whose effect
 * scrolls the row fully into view. Between a pointer's press and release that scroll moves the button from under the
 * pointer, and the click is lost (it lands on the row instead). The button keeps its own focus ring and the browser
 * scrolls it into view as it does any focused control.
 */
function keepFocusHere(event: FocusEvent): void {
  event.stopPropagation();
}

/**
 * WP 11.6: the local model's name for a merchant the bank sent as noise, beside the bank's own text: the suggested
 * name, a line saying which model made it and from what, and **Accept** / **Dismiss**. It is visibly a suggestion,
 * never an assignment (a dashed outline; the row beside it still reads the bank's text). Nothing is sent when it
 * renders: Accept is the one write, and it renames the merchant's transactions the holder has not renamed.
 *
 * The buttons are never `disabled` while a request runs (`aria-disabled`), so focus stays on them; once the chip
 * goes, focus goes to its row (list) rather than the document body (2.4.3). In the detail sheet the host owns
 * where focus lands, through `onResult`.
 */
export function MerchantNameChip({
  suggestion,
  variant = 'list',
  onResult,
}: MerchantNameChipProps) {
  const accept = useAcceptMerchantNameMutation();
  const dismiss = useDismissMerchantNameMutation();
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textId = useId();
  const busy = accept.isPending || dismiss.isPending;
  const name = suggestion.displayName;
  const list = variant === 'list';

  async function onAccept(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (busy) return;
    setError(null);
    const host = list ? hostOf(rootRef.current) : null;
    try {
      const result = await accept.mutateAsync({ path: { suggestionId: suggestion.id } });
      host?.focus();
      onResult?.(acceptedWords(name, result.renamed));
    } catch (cause) {
      setError(problemDetail(cause, `Could not rename to ${name}. Nothing was changed.`));
    }
  }

  async function onDismiss(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (busy) return;
    setError(null);
    const host = list ? hostOf(rootRef.current) : null;
    try {
      await dismiss.mutateAsync({ path: { suggestionId: suggestion.id } });
      host?.focus();
      onResult?.(dismissedWords(name));
    } catch (cause) {
      setError(problemDetail(cause, 'Could not record that. The suggestion is still shown.'));
    }
  }

  return (
    <div
      ref={rootRef}
      data-testid="merchant-name-chip"
      data-merchant-id={suggestion.merchantId ?? undefined}
      data-status={suggestion.status}
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
        <span>
          <span className="font-medium text-text-primary" data-testid="merchant-name-chip-name">
            {name}
          </span>
          <span className="block" data-testid="merchant-name-chip-provenance">
            {provenanceWords(suggestion)}
          </span>
        </span>
      </p>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Accept the name ${name}`}
          aria-describedby={textId}
          aria-disabled={busy}
          onKeyDown={keepKeyHere}
          onFocus={keepFocusHere}
          onClick={(event) => void onAccept(event)}
        >
          Accept
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Dismiss the name ${name}`}
          aria-describedby={textId}
          aria-disabled={busy}
          onKeyDown={keepKeyHere}
          onFocus={keepFocusHere}
          onClick={(event) => void onDismiss(event)}
        >
          Dismiss
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
