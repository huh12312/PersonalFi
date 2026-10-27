// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { Bot, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../lib/cn.ts';
import {
  useExplanation,
  type ExplainEntity,
  type Explanation,
  type InsightExplanationState,
} from './useExplanation.ts';

type ShownExplanation = NonNullable<InsightExplanationState['explanation']>;

/** Said when a refusal carries no message of its own (the api always sends one; this is the same sentence). */
export const EXPLANATION_REFUSED_FALLBACK =
  "The explanation didn't pass the checks; the evidence below is the arithmetic.";
/** Said when `unavailable` carries no message of its own. */
export const EXPLANATION_UNAVAILABLE_FALLBACK = 'An explanation cannot be asked for right now.';

/** The reasons that mean no language model is set up at all: Settings › Language model is the way out. */
const NO_MODEL_REASONS: ReadonlySet<string> = new Set(['off', 'not_configured']);

/**
 * The model as the badge names it: a hosted provider's `provider:model` without the prefix, the local model's
 * `name@sha256:…` with its digest shortened to 12 characters (the full pin is in Advisor management's inspector).
 */
export function explanationModelText(
  provider: ShownExplanation['provider'],
  model: string,
): string {
  let shown = model.startsWith(`${provider}:`) ? model.slice(provider.length + 1) : model;
  const at = shown.indexOf('@sha256:');
  if (at >= 0) {
    const digest = shown.slice(at + '@sha256:'.length);
    shown = `${shown.slice(0, at)}@sha256:${digest.slice(0, 12)}${digest.length > 12 ? '…' : ''}`;
  }
  return shown;
}

/**
 * The badge's words (07 §7.5 rule 3, the Brief's `narrationBadgeLabel` pattern): "Explained by the local model
 * qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…", "Explained by Anthropic claude-sonnet-5-5".
 */
export function explainedByLabel(
  explanation: Pick<ShownExplanation, 'provider' | 'providerName' | 'model'>,
): string {
  const model = explanationModelText(explanation.provider, explanation.model);
  if (explanation.provider === 'ollama') return `Explained by the local model ${model}`;
  return `Explained by ${explanation.providerName} ${model}`;
}

/** What the polite live region says. "Explaining…" is shown; the outcome after a tap is for screen readers. */
function liveWords(explanation: Explanation): { readonly text: string; readonly visible: boolean } {
  if (explanation.status === 'computing') return { text: 'Explaining…', visible: true };
  if (!explanation.asked) return { text: '', visible: false };
  switch (explanation.status) {
    case 'shown':
      return { text: 'The explanation is ready.', visible: false };
    case 'refused':
      return { text: 'The explanation was refused.', visible: false };
    case 'unavailable':
      return { text: 'No explanation is available.', visible: false };
    case 'failed':
      return { text: 'The explanation failed.', visible: false };
    case 'timed_out':
      return { text: 'The explanation is taking longer than usual.', visible: false };
    default:
      return { text: '', visible: false };
  }
}

export interface ExplainButtonProps {
  readonly explanation: Explanation;
  /** What is explained, for the button's accessible name ("Explain this — Savings rate"). */
  readonly subject: string;
  readonly className?: string;
}

/**
 * The "Explain this" button and its polite live region. Offered while nothing is shown (`idle`, `loading`) and,
 * busy, while the worker explains (`computing`): `aria-disabled` and `aria-busy` rather than `disabled`, so focus
 * stays on it while it waits (2.4.3); the spinner turns only under `motion-safe`. Once there is an outcome the
 * button gives way to it (`ExplanationResult`), and "Try again" lives there.
 */
export function ExplainButton({ explanation, subject, className }: ExplainButtonProps) {
  const { status } = explanation;
  const offered = status === 'idle' || status === 'loading' || status === 'computing';
  const busy = status === 'computing';
  const live = liveWords(explanation);
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      {offered && (
        <Button
          variant="secondary"
          size="sm"
          className="gap-1"
          aria-disabled={busy ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
          data-testid="explain-this"
          // The visible words first (2.5.3), then what is explained — an aria-label, not hidden text, so the
          // subject is not a second copy of the card's title in the page's text.
          aria-label={`Explain this — ${subject}`}
          onClick={() => {
            if (!busy) explanation.ask();
          }}
        >
          {busy ? (
            <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <Sparkles size={14} aria-hidden="true" />
          )}
          Explain this
        </Button>
      )}
      <span
        role="status"
        aria-live="polite"
        className="text-caption text-text-muted"
        data-testid="explain-live"
      >
        {live.visible ? live.text : <span className="sr-only">{live.text}</span>}
      </span>
    </span>
  );
}

export interface ExplanationResultProps {
  readonly explanation: Explanation;
  /** What sits beneath the result ("the evidence below", "the inputs below"), for the caption. */
  readonly evidenceWord?: string;
  readonly className?: string;
}

/**
 * The outcome, beneath the button and above the evidence (which is never replaced): the explanation as plain text
 * (never rendered as Markdown) with a badge naming the provider and model and a visible "AI-assisted wording"
 * label; a refusal in the api's own words, never swapped for template wording; why none is available with the way
 * to Advisor management (and Settings › Language model when no model is set up), no retry; a failure, or a wait
 * past three minutes, with "Try again". When the holder asked in this mount the outcome takes focus as it lands
 * (the button it replaces is gone), so keyboard and screen-reader users land on it.
 */
export function ExplanationResult({
  explanation,
  evidenceWord = 'the evidence below',
  className,
}: ExplanationResultProps) {
  const { status, data, message, asked } = explanation;
  const ref = useRef<HTMLDivElement>(null);
  const settled =
    (status === 'shown' && data?.explanation != null) ||
    status === 'refused' ||
    status === 'unavailable' ||
    status === 'failed' ||
    status === 'timed_out';

  useEffect(() => {
    if (asked && settled) ref.current?.focus();
  }, [asked, settled, status]);

  if (!settled) return null;

  const box = cn('rounded-md border border-border-hairline bg-bg-subtle p-3', className);

  if (status === 'shown') {
    const shown = data!.explanation!;
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="group"
        aria-label="Explanation"
        className={box}
        data-testid="explanation"
        data-explanation-state="shown"
      >
        <p
          className="text-small whitespace-pre-line text-text-primary"
          data-testid="explanation-text"
        >
          {shown.text}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge
            variant="accent"
            icon={<Bot size={12} aria-hidden="true" className="shrink-0" />}
            className="max-w-full rounded-md [overflow-wrap:anywhere]"
            data-testid="explanation-badge"
          >
            {explainedByLabel(shown)}
          </Badge>
          <span
            className="text-caption font-medium text-text-secondary"
            data-testid="explanation-ai-label"
          >
            AI-assisted wording
          </span>
        </div>
        <p className="mt-1 text-caption text-text-muted">
          Worded from {evidenceWord}; every figure there is the app&apos;s own arithmetic.
        </p>
      </div>
    );
  }

  if (status === 'refused') {
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="group"
        aria-label="Explanation refused"
        className={box}
        data-testid="explanation"
        data-explanation-state="refused"
      >
        <p className="text-small text-text-primary" data-testid="explanation-refused">
          {message ?? EXPLANATION_REFUSED_FALLBACK}
        </p>
      </div>
    );
  }

  if (status === 'unavailable') {
    const reason = data?.reason ?? null;
    return (
      <div
        ref={ref}
        tabIndex={-1}
        role="group"
        aria-label="Explanation unavailable"
        className={box}
        data-testid="explanation"
        data-explanation-state="unavailable"
        data-reason={reason ?? undefined}
      >
        <p className="text-small text-text-secondary" data-testid="explanation-unavailable">
          {message ?? EXPLANATION_UNAVAILABLE_FALLBACK}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-small">
          <Link to="/settings/advisors" className="text-accent-text underline">
            Advisor management
          </Link>
          {reason !== null && NO_MODEL_REASONS.has(reason) && (
            <Link to="/settings" className="text-accent-text underline">
              Settings › Language model
            </Link>
          )}
        </p>
      </div>
    );
  }

  // `failed` and `timed_out`: the sentence and a retry (which asks again).
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={status === 'failed' ? 'Explanation failed' : 'Explanation still going'}
      className={box}
      data-testid="explanation"
      data-explanation-state={status}
    >
      <p className="text-small text-text-secondary" data-testid="explanation-failed">
        {message ?? 'The explanation failed.'}
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2 gap-1"
        onClick={() => explanation.ask()}
        data-testid="explain-retry"
      >
        <RotateCcw size={14} aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}

export interface ExplainThisProps {
  readonly entity: ExplainEntity;
  readonly subject: string;
  readonly evidenceWord?: string;
  readonly className?: string;
}

/**
 * "Explain this" for one insight or one health pillar (WP 11.3): the button and its outcome, stacked. Rendering
 * reads the state with `GET` only; nothing is asked of a model until the holder taps. The caller draws the
 * evidence beneath it, always.
 */
export function ExplainThis({ entity, subject, evidenceWord, className }: ExplainThisProps) {
  const explanation = useExplanation(entity);
  return (
    <div className={cn('flex flex-col items-start gap-2', className)} data-testid="explain-block">
      <ExplainButton explanation={explanation} subject={subject} />
      <ExplanationResult explanation={explanation} evidenceWord={evidenceWord} className="w-full" />
    </div>
  );
}
