// SPDX-License-Identifier: MIT
import { Bot, ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { cn } from '../../lib/cn.ts';
import type { BriefItemNarration, NarratedBy } from './types.ts';

const PROVIDER_NAMES: Readonly<Record<NarratedBy['provider'], string>> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};

/**
 * The badge's words (WP 10.6): the provider and model that wrote the wording - "Narrated by Anthropic
 * claude-sonnet-5-5", "Narrated by the local model qwen2.5:7b-instruct-q4_K_M" - or, when the response does not
 * say, "AI-assisted wording".
 */
export function narrationBadgeLabel(narratedBy: NarratedBy | null | undefined): string {
  if (narratedBy === null || narratedBy === undefined) return 'AI-assisted wording';
  if (narratedBy.provider === 'ollama') return `Narrated by the local model ${narratedBy.model}`;
  return `Narrated by ${PROVIDER_NAMES[narratedBy.provider]} ${narratedBy.model}`;
}

export interface NarratedSummaryProps {
  /** The builtin's own deterministic wording — always present, always what every figure on the card is traced to. */
  templateSummaryMd: string;
  /** What the response says about this item's narration, or `null` from a client that predates the field. */
  narration: BriefItemNarration | null;
}

/**
 * The Brief item's body text. The built-in's wording is always the item's text;
 * a narrator's alternative wording replaces it on screen only when the response
 * carries it (`summaryMd`, which the api sends only when `NARRATION_TEXT_SHOWN`
 * is set — Phase 5 gate R-2), under an "AI-assisted wording" badge (07 §7.5
 * rule 3) with the template wording one click away. Every figure on the card is
 * the built-in's (05 §3 WP 5.11); nothing here reads a number from the
 * narration.
 *
 * While the text is withheld the badge still says a wording exists, in words —
 * nothing about the withholding is hidden from the holder.
 *
 * WP 10.6: both badges name the provider and model from `narration.narratedBy`
 * (`narrationBadgeLabel`), so the holder can tell a local model's wording from a
 * hosted provider's.
 */
export function NarratedSummary({ templateSummaryMd, narration }: NarratedSummaryProps) {
  const [showTemplate, setShowTemplate] = useState(false);

  const status = narration?.status ?? 'none';
  const text = narration?.summaryMd ?? null;
  const badge = narrationBadgeLabel(narration?.narratedBy);

  if (status === 'narrated' && text !== null) {
    return (
      <div className="mt-1">
        <p className="text-small text-text-secondary">{text}</p>
        <div className="mt-1 flex items-center gap-2">
          <Badge variant="accent" icon={<Bot size={12} aria-hidden="true" />}>
            {badge}
          </Badge>
          <button
            type="button"
            aria-expanded={showTemplate}
            onClick={() => setShowTemplate((prev) => !prev)}
            className="inline-flex min-h-6 items-center gap-1 rounded-sm text-caption text-accent-text hover:underline focus-visible:outline-none"
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

  return (
    <div className="mt-1">
      <p className="text-small text-text-secondary">{templateSummaryMd}</p>
      {status === 'narrated' && (
        <p
          className="mt-1 flex items-center gap-2 text-caption text-text-muted"
          data-testid="narration-withheld"
        >
          <Badge variant="accent" icon={<Bot size={12} aria-hidden="true" />}>
            {badge}
          </Badge>
          An AI-assisted wording of this item exists and is not shown yet.
        </p>
      )}
      {status === 'pending' && (
        <p className="mt-1 text-caption text-text-muted" data-testid="narration-pending">
          An AI-assisted wording may follow; the wording above is the built-in&apos;s.
        </p>
      )}
    </div>
  );
}
