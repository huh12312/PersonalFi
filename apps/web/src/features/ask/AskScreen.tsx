// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { AnswerView } from './AnswerView.tsx';
import { AskHistory } from './AskHistory.tsx';
import {
  ASK_DISCLAIMER,
  NO_MODEL_REASONS,
  UNAVAILABLE_FALLBACK_WORDS,
  isInFlight,
  outcomeWords,
  stepWords,
  type AskOverview,
} from './ask-words.ts';
import { QuestionForm } from './QuestionForm.tsx';
import { useAsk } from './useAsk.ts';

function Unavailable({ availability }: { readonly availability: AskOverview['availability'] }) {
  const reason = availability.reason;
  return (
    <div
      className="rounded-md border border-border-hairline bg-bg-subtle p-3"
      data-testid="ask-unavailable"
      data-reason={reason ?? undefined}
    >
      <p className="text-small font-medium text-text-primary">
        Questions are not available right now.
      </p>
      <p className="mt-1 text-small text-text-secondary" data-testid="ask-unavailable-message">
        {availability.message ?? UNAVAILABLE_FALLBACK_WORDS}
      </p>
      <p className="mt-1 text-small text-text-secondary">
        The two query types, ask.compile and ask.narrate, are approved in Advisor management.
      </p>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-small">
        <Link to="/settings/advisors" className="text-accent-text underline underline-offset-2">
          Advisor management
        </Link>
        {reason !== null && NO_MODEL_REASONS.has(reason) && (
          <Link to="/settings" className="text-accent-text underline underline-offset-2">
            Settings › Language model
          </Link>
        )}
      </p>
    </div>
  );
}

export interface AskScreenProps {
  /** How often a going question is read; tests shorten it. */
  readonly pollMs?: number;
}

/**
 * `/ask` (WP 11.5c, reporting mode): the holder asks a question about their own money in words; the app turns it
 * into calculations it already has (typed, scoped, versioned functions over the engines), runs them, and a
 * language model words the results - or the arithmetic is shown without the prose. Every answer carries the
 * provider and model badge, "AI-assisted wording", and an "I looked at" line naming the calculations behind it.
 * Nothing is asked of a model until the holder sends a question; this is information, not advice.
 */
export function AskScreen({ pollMs }: AskScreenProps = {}) {
  const ask = useAsk(pollMs === undefined ? {} : { pollMs });
  const { overview, session } = ask;
  const answerRef = useRef<HTMLElement>(null);

  const going = session !== null && isInFlight(session.status);
  const finishedKey = session !== null && !going ? `${session.id}:${session.status}` : null;

  // An answer the holder asked for (or picked) takes focus as it lands, so keyboard and screen-reader users arrive
  // on it; one that was only resumed on opening the screen does not.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!ask.touched || finishedKey === null || focused.current === finishedKey) return;
    focused.current = finishedKey;
    answerRef.current?.focus();
  }, [ask.touched, finishedKey]);

  const live = ask.sending
    ? { text: stepWords('compiling'), visible: true }
    : going
      ? { text: stepWords(session.status), visible: true }
      : session !== null && ask.touched
        ? { text: outcomeWords(session.status), visible: false }
        : { text: '', visible: false };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-h2 text-text-primary">Ask PersonalFi</h2>
        <p className="mt-1 text-small text-text-secondary">
          Ask about your own money in plain words. The app works the answer out from the
          calculations it already has, and a language model puts the results into words.
        </p>
        <p className="mt-1 text-caption text-text-muted" data-testid="ask-disclaimer">
          {ASK_DISCLAIMER}
        </p>
      </div>

      {overview === undefined ? (
        ask.overviewError ? (
          <div role="alert" className="text-small text-text-secondary">
            Could not load Ask PersonalFi.
          </div>
        ) : (
          <SkeletonText lines={6} />
        )
      ) : (
        <>
          {overview.availability.state === 'unavailable' && (
            <Unavailable availability={overview.availability} />
          )}

          <QuestionForm
            maxLength={overview.maxQuestionLength}
            examples={overview.examples}
            unavailable={overview.availability.state === 'unavailable'}
            busy={ask.sending || going}
            error={ask.error}
            onSend={(question, clear) => ask.send(question, clear)}
          />

          <div
            role="status"
            aria-live="polite"
            className="min-h-5 text-small text-text-muted"
            data-testid="ask-live"
          >
            {live.visible ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
                {live.text}
              </span>
            ) : (
              <span className="sr-only">{live.text}</span>
            )}
          </div>

          {session !== null && (
            <div>
              {going ? (
                <section
                  aria-label="Question in progress"
                  className="rounded-md border border-border-hairline bg-bg-subtle p-3"
                  data-testid="ask-answer"
                  data-state={session.status}
                >
                  <p className="text-small font-medium text-text-primary [overflow-wrap:anywhere]">
                    {session.question}
                  </p>
                </section>
              ) : (
                <AnswerView ref={answerRef} session={session} />
              )}
            </div>
          )}

          <AskHistory
            sessions={overview.sessions}
            selectedId={session?.id ?? null}
            onSelect={ask.select}
          />
        </>
      )}
    </div>
  );
}
