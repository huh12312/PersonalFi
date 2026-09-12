// SPDX-License-Identifier: MIT
import { ChevronDown, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface InlineInsightProps {
  /** One sentence, `--type-small`. "Spending in Dining is 62% above your 6-month average." */
  headline: ReactNode;
  /** The "Why am I seeing this?" evidence — rendered inline on expand (§5.8). */
  detail?: ReactNode;
  className?: string;
}

/**
 * The "sparkle" affordance for a computed/derived value inline in a card or
 * row — a quiet signal that a number came from analysis rather than a raw
 * balance, with an optional inline "Why am I seeing this?" disclosure (§5.8).
 * Not a full Insight card (`/insights` owns those); this is the compact,
 * embeddable form used next to a stat or a transaction.
 */
export function InlineInsight({ headline, detail, className }: InlineInsightProps) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();

  return (
    <div className={cn('text-small', className)}>
      <div className="flex items-start gap-1.5 text-accent-text">
        <Sparkles size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="text-text-secondary">{headline}</span>
        {detail !== undefined && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((prev) => !prev)}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm text-caption text-text-muted hover:text-text-secondary focus-visible:outline-none"
          >
            Why?
            <ChevronDown
              size={12}
              className={cn(
                'transition-transform duration-fast ease-standard',
                expanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {detail !== undefined && expanded && (
        <div id={detailId} className="mt-2 rounded-md bg-bg-subtle p-3 text-text-secondary">
          {detail}
        </div>
      )}
    </div>
  );
}
