// SPDX-License-Identifier: MIT
import { Bot } from 'lucide-react';

import type { BriefNarration } from '../../api/generated/types.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import type { NarratedBy } from './types.ts';

const PROVIDER_NAMES: Readonly<Record<NarratedBy['provider'], string>> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};

/**
 * WP 11.4: who wrote the Brief's own wording — "Worded by the local model qwen2.5:7b-instruct", "Worded by Anthropic
 * claude-sonnet-5-5" — or plain "Worded by a language model" when the response does not say.
 */
export function wordedByLabel(narratedBy: NarratedBy | null | undefined): string {
  if (narratedBy === null || narratedBy === undefined) return 'Worded by a language model';
  if (narratedBy.provider === 'ollama') return `Worded by the local model ${narratedBy.model}`;
  return `Worded by ${PROVIDER_NAMES[narratedBy.provider]} ${narratedBy.model}`;
}

function AiBadge({ narratedBy, testId }: { narratedBy: NarratedBy | null; testId: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Badge
        variant="accent"
        icon={<Bot size={12} aria-hidden="true" className="shrink-0" />}
        className="max-w-full rounded-md [overflow-wrap:anywhere]"
        data-testid={`${testId}-badge`}
      >
        {wordedByLabel(narratedBy)}
      </Badge>
      <span
        className="text-caption font-medium text-text-secondary"
        data-testid={`${testId}-ai-label`}
      >
        AI-assisted wording
      </span>
    </div>
  );
}

/** A response that predates WP 11.4 carries neither field; it reads as no opening and no narration. */
export interface BriefNarrationFields {
  readonly opening?: string;
  readonly narration?: BriefNarration;
}

/**
 * WP 11.4: "Your week" — the one-paragraph recap a language model wrote over the Brief's own overview. Shown only
 * when the api says the composition passed its checks (`state: 'shown'`), as plain text (never Markdown), under a
 * badge naming the provider and model and a visible "AI-assisted wording" label. A labelled region, not a heading:
 * the screen's heading outline is the same with or without it.
 */
export function BriefRecap({ narration }: { narration: BriefNarration | undefined }) {
  if (narration?.state !== 'shown' || narration.recap === null) return null;
  return (
    <section
      aria-label="Your week"
      data-testid="brief-recap"
      className="mt-3 rounded-md border border-border-hairline bg-bg-subtle p-3"
    >
      <p className="text-caption font-medium text-text-secondary">Your week</p>
      <p
        className="mt-1 text-small whitespace-pre-line text-text-primary"
        data-testid="brief-recap-text"
      >
        {narration.recap}
      </p>
      <AiBadge narratedBy={narration.narratedBy} testId="brief-recap" />
    </section>
  );
}

/**
 * WP 11.4 (G5-15): the Brief's deterministic opening — always — and under it the composed narration of the week's
 * ranked actions, in the states the api names:
 *
 *   * `shown` — the text as plain text, the provider and model badge, "AI-assisted wording";
 *   * `refused` — the api's words, visibly; the opening above stands and nothing else is invented;
 *   * `pending` / `unavailable` — the api's words, muted.
 *
 * Nothing here animates.
 */
export function BriefNarrationHeader({ opening, narration }: BriefNarrationFields) {
  const state = narration?.state ?? 'unavailable';
  return (
    <>
      {opening !== undefined && opening.length > 0 && (
        <p className="mt-3 text-small text-text-primary" data-testid="brief-opening">
          {opening}
        </p>
      )}
      {narration !== undefined && (
        <div className="mt-2" data-testid="brief-narration" data-state={state}>
          {state === 'shown' && narration.text !== null ? (
            <>
              <p
                className="text-small whitespace-pre-line text-text-secondary"
                data-testid="brief-narration-text"
              >
                {narration.text}
              </p>
              <AiBadge narratedBy={narration.narratedBy} testId="brief-narration" />
            </>
          ) : state === 'refused' ? (
            narration.message !== null && (
              <p className="text-caption text-text-secondary" data-testid="brief-narration-message">
                {narration.message}
              </p>
            )
          ) : (
            narration.message !== null && (
              <p className="text-caption text-text-muted" data-testid="brief-narration-message">
                {narration.message}
              </p>
            )
          )}
        </div>
      )}
    </>
  );
}
