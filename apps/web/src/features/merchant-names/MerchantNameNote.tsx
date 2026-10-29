// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import type { FocusEvent, KeyboardEvent, MouseEvent } from 'react';

import { cn } from '../../lib/cn.ts';
import type { MerchantNameUnavailableReason } from './merchant-name-api.ts';
import { unavailableWords } from './merchant-name-words.ts';

export interface MerchantNameNoteProps {
  readonly reason: MerchantNameUnavailableReason;
  readonly className?: string;
}

/** The row around the note opens the transaction on click and Enter; the note's link keeps its own. */
function keepKeyHere(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}
/** Focus on the link must not move the list's roving row (which scrolls it, and can lose a pointer's click). */
function keepFocusHere(event: FocusEvent): void {
  event.stopPropagation();
}
function keepClickHere(event: MouseEvent): void {
  event.stopPropagation();
}

/**
 * WP 11.6: where the chip would be on a row whose merchant the bank sent as noise, one quiet line on why no name is
 * suggested (not approved, a hosted narrator, no local model). It is plain text with a glyph, in the page's reading
 * order, so a screen reader reaches it with the row; the link goes to Advisors where the approval is made.
 */
export function MerchantNameNote({ reason, className }: MerchantNameNoteProps) {
  const words = unavailableWords(reason);
  return (
    <p
      data-testid="merchant-name-note"
      data-reason={reason}
      className={cn(
        'flex items-start gap-1.5 text-caption text-text-muted [overflow-wrap:anywhere]',
        className,
      )}
    >
      <Info size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {words.lead}
        {words.link !== null && (
          <Link
            to="/settings/advisors"
            className="text-accent-text underline"
            onClick={keepClickHere}
            onKeyDown={keepKeyHere}
            onFocus={keepFocusHere}
          >
            {words.link}
          </Link>
        )}
        {words.tail}
      </span>
    </p>
  );
}
