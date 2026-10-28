// SPDX-License-Identifier: MIT
import { Bot } from 'lucide-react';
import { forwardRef } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import {
  FAILED_FALLBACK_WORDS,
  NARRATE_REFUSED_WORDS,
  REFUSED_FALLBACK_WORDS,
  answeredByLabel,
  isInFlight,
  type AskSession,
} from './ask-words.ts';
import { LookedAt, ScreenLink } from './LookedAt.tsx';

export interface AnswerViewProps {
  readonly session: AskSession;
}

/**
 * One session as the holder reads it. The answer is plain text (never Markdown) under a badge naming the provider
 * and model and a visible "AI-assisted wording" label; the evidence line follows every outcome that has one. A
 * refusal, an out-of-scope question or a failure says so in the api's own words; when results exist and no answer
 * is shown (`fallback`) the arithmetic is shown open, never nothing. Takes focus when it lands (the caller's ref).
 */
export const AnswerView = forwardRef<HTMLElement, AnswerViewProps>(function AnswerView(
  { session },
  ref,
) {
  const { status, answer, lookedAt, refusal, unanswerable, failure, fallback } = session;
  const headingId = `ask-answer-${session.id}`;
  const showsAnswer = status === 'shown' && answer !== null;

  let message: string | null = null;
  if (status === 'refused') {
    message =
      refusal?.message ??
      (refusal?.step === 'narrate' ? NARRATE_REFUSED_WORDS : REFUSED_FALLBACK_WORDS);
  } else if (status === 'unanswerable') {
    message = unanswerable?.message ?? REFUSED_FALLBACK_WORDS;
  } else if (status === 'failed' || status === 'cancelled') {
    message =
      failure?.message ??
      (status === 'cancelled' ? 'The question was cancelled.' : FAILED_FALLBACK_WORDS);
  } else if (status === 'shown' && answer === null) {
    message = REFUSED_FALLBACK_WORDS;
  }

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="rounded-md border border-border-hairline bg-bg-subtle p-3"
      data-testid="ask-answer"
      data-state={status}
    >
      <h3
        id={headingId}
        className="text-small font-medium text-text-primary [overflow-wrap:anywhere]"
      >
        {session.question}
      </h3>

      {showsAnswer && (
        <>
          <p
            className="mt-2 text-small whitespace-pre-line text-text-primary"
            data-testid="ask-answer-text"
          >
            {answer.text}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              variant="accent"
              icon={<Bot size={12} aria-hidden="true" className="shrink-0" />}
              className="max-w-full rounded-md [overflow-wrap:anywhere]"
              data-testid="ask-answer-badge"
            >
              {answeredByLabel(answer)}
            </Badge>
            <span
              className="text-caption font-medium text-text-secondary"
              data-testid="ask-answer-ai-label"
            >
              AI-assisted wording
            </span>
          </div>
        </>
      )}

      {message !== null && (
        <p className="mt-2 text-small text-text-primary" data-testid="ask-message">
          {message}
        </p>
      )}

      {status === 'refused' && refusal !== null && refusal.class !== '' && (
        <p className="mt-1 text-caption text-text-muted" data-testid="ask-refusal-class">
          Stopped at the {refusal.step} step: {refusal.class}
        </p>
      )}

      {status === 'unanswerable' && unanswerable !== null && (
        <p className="mt-2 text-small text-text-secondary" data-testid="ask-nearest-screen">
          The closest screen is{' '}
          <ScreenLink
            path={unanswerable.nearestScreen.path}
            label={unanswerable.nearestScreen.label}
          />
          .
        </p>
      )}

      {!isInFlight(status) && lookedAt !== null && (
        <>
          {fallback && lookedAt.items.length > 0 && (
            <p
              className="mt-3 text-small font-medium text-text-primary"
              data-testid="ask-arithmetic-heading"
            >
              The arithmetic, without the prose
            </p>
          )}
          <LookedAt lookedAt={lookedAt} defaultOpen={fallback} />
        </>
      )}

      {showsAnswer && (
        <p className="mt-2 text-caption text-text-muted">
          The wording is checked against these calculations; every figure is the app&apos;s own
          arithmetic.
        </p>
      )}
    </section>
  );
});
