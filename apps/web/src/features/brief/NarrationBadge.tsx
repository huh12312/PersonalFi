// SPDX-License-Identifier: MIT
import { Bot, ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { cn } from '../../lib/cn.ts';

export interface NarratedSummaryProps {
  /** The builtin's own deterministic wording — always present, always what every figure on the card is traced to. */
  templateSummaryMd: string;
  /** The narrator's alternative wording, or `null` when this item has none (07 §7.5 rule 1: "fall back to the deterministic template"). */
  narratedSummaryMd: string | null;
}

/**
 * The Brief item's body text: the narrator's wording when one exists, under
 * an "AI-assisted wording" badge (07 §7.5 rule 3), with the deterministic
 * template text one click away — never the reverse, and the figures on the
 * card are never read from here (05-phase-5-dispatch.md §3 WP 5.11: "every
 * figure displayed is the builtin's").
 */
export function NarratedSummary({ templateSummaryMd, narratedSummaryMd }: NarratedSummaryProps) {
  const [showTemplate, setShowTemplate] = useState(false);

  if (narratedSummaryMd === null) {
    return <p className="mt-1 text-small text-text-secondary">{templateSummaryMd}</p>;
  }

  return (
    <div className="mt-1">
      <p className="text-small text-text-secondary">{narratedSummaryMd}</p>
      <div className="mt-1 flex items-center gap-2">
        <Badge variant="accent" icon={<Bot size={12} aria-hidden="true" />}>
          AI-assisted wording
        </Badge>
        <button
          type="button"
          aria-expanded={showTemplate}
          onClick={() => setShowTemplate((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-sm text-caption text-accent-text hover:underline focus-visible:outline-none"
        >
          {showTemplate ? 'Hide the template wording' : 'See the template wording'}
          <ChevronDown
            size={12}
            aria-hidden="true"
            className={cn(
              'transition-transform duration-fast ease-standard',
              showTemplate && 'rotate-180',
            )}
          />
        </button>
      </div>
      {showTemplate && (
        <p data-testid="narration-template-text" className="mt-1 text-caption text-text-muted">
          {templateSummaryMd}
        </p>
      )}
    </div>
  );
}
