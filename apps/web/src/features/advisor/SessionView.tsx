// SPDX-License-Identifier: MIT
import { Bot } from 'lucide-react';
import { forwardRef } from 'react';

import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  CANCELLED_WORDS,
  FAILED_FALLBACK_WORDS,
  REFUSED_FALLBACK_WORDS,
  directionWords,
  isEnded,
  isWorking,
  judgeWords,
  latestWords,
  originWords,
  pickedOnWords,
  pregatheredWords,
  refusalStepWords,
  REACHED_WORDS,
  runsOnLabel,
  withheldWords,
  type AdvisorJudge,
  type AdvisorSession,
} from './advisor-words.ts';
import { ClarifyForm } from './ClarifyForm.tsx';
import { LookedAt, ScreenLink } from './LookedAt.tsx';
import { OptionsList } from './OptionsList.tsx';

function Plan({ plan }: { readonly plan: NonNullable<AdvisorSession['plan']> }) {
  return (
    <div className="mt-3" data-testid="advisor-plan">
      <h4 className="text-small font-medium text-text-primary">The steps</h4>
      <p className="mt-1 text-caption text-text-muted">
        Each step links to a screen of this app. Nothing is done for you.
      </p>
      <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5">
        {plan.map((step, index) => (
          <li
            key={`${step.href}-${String(index)}`}
            className="text-small text-text-primary [overflow-wrap:anywhere]"
            data-testid="advisor-plan-step"
          >
            <span>{step.text}</span>{' '}
            <ScreenLink path={step.href} label={step.label} testId="advisor-plan-link" />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Tracked({
  tracked,
  completed,
}: {
  readonly tracked: NonNullable<AdvisorSession['tracked']>;
  readonly completed: boolean;
}) {
  const direction = directionWords(tracked.direction);
  const pickedOn = pickedOnWords(tracked.pickedAt);
  return (
    <div
      className="mt-3 rounded-md border border-border-hairline bg-bg-surface p-3"
      data-testid="advisor-tracked"
      data-completed={completed ? 'true' : undefined}
    >
      <h4 className="text-small font-medium text-text-primary">
        {completed ? 'Target reached' : 'Followed in the Brief'}
      </h4>
      <p
        className="mt-1 text-small text-text-primary [overflow-wrap:anywhere]"
        data-testid="advisor-tracked-label"
      >
        {tracked.label}
      </p>
      {pickedOn !== null && (
        <p className="mt-1 text-caption text-text-muted" data-testid="advisor-tracked-picked">
          {pickedOn}
        </p>
      )}
      {tracked.wording !== '' && (
        <p
          className="mt-1 text-small text-text-secondary [overflow-wrap:anywhere]"
          data-testid="advisor-tracked-wording"
        >
          {tracked.wording}
        </p>
      )}
      <p className="mt-1 text-small text-text-secondary" data-testid="advisor-tracked-baseline">
        When you picked it: {tracked.baseline.text}
        {tracked.baseline.asOf !== null && (
          <span className="text-caption text-text-muted"> (as of {tracked.baseline.asOf})</span>
        )}
      </p>
      <p className="mt-1 text-small text-text-secondary" data-testid="advisor-tracked-latest">
        {latestWords(tracked)}
        {tracked.latest?.asOf != null && (
          <span className="text-caption text-text-muted"> (as of {tracked.latest.asOf})</span>
        )}
      </p>
      {tracked.target !== null && (
        <p className="mt-1 text-small text-text-secondary" data-testid="advisor-tracked-target">
          Target: {tracked.target.text}
        </p>
      )}
      {direction !== null && tracked.latest !== null && (
        <p className="mt-1 text-caption text-text-muted" data-testid="advisor-tracked-direction">
          {direction}
        </p>
      )}
      {completed && (
        <p
          className="mt-2 text-small font-medium text-text-primary"
          data-testid="advisor-tracked-reached"
        >
          {REACHED_WORDS}
        </p>
      )}
      {!completed && (
        <p className="mt-2 text-small">
          <ScreenLink
            path={tracked.brief.path}
            label="See it in the Brief"
            testId="advisor-tracked-link"
          />
        </p>
      )}
    </div>
  );
}

function Judge({ judge }: { readonly judge: AdvisorJudge }) {
  const words = judgeWords(judge);
  if (words === null && judge.error === null && judge.score === null) return null;
  return (
    <div className="mt-3 text-small text-text-secondary" data-testid="advisor-judge">
      {words !== null ? (
        <details>
          <summary className="cursor-pointer" data-testid="advisor-judge-line">
            {words}
          </summary>
          <ul className="mt-1 flex flex-col gap-1 pl-4">
            {judge.criteria.map((criterion) => (
              <li key={criterion.criterion} className="[overflow-wrap:anywhere]">
                <span className="font-medium text-text-primary">
                  {criterion.met ? 'Met' : 'Not met'}
                </span>
                : {criterion.criterion}
                {criterion.reason !== '' && (
                  <span className="text-text-muted"> — {criterion.reason}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-caption text-text-muted">
            This check is evidence only; it never holds anything back.
          </p>
        </details>
      ) : (
        <p data-testid="advisor-judge-line">
          {judge.error !== null
            ? `Rubric check did not run: ${judge.error}`
            : `Rubric score: ${judge.score ?? ''}`}
        </p>
      )}
    </div>
  );
}

export interface SessionViewProps {
  readonly session: AdvisorSession;
  readonly maxAnswerLength: number;
  /** A request of the holder's own is on its way. */
  readonly busy: boolean;
  readonly onAnswer: (answers: string[]) => void;
  readonly onPick: (optionId: string) => void;
  readonly onClose: () => void;
}

/**
 * One session as the holder reads it, whatever step it is at: the clarify form, the working states, the options
 * (each with its cost), the plan, what is being followed, or the plain words of a refusal, an out-of-scope
 * question, a failure or a closed session. The engine badge names the provider and model; the "I looked at" line
 * follows whatever figures exist. Takes focus when it lands (the caller's ref).
 */
export const SessionView = forwardRef<HTMLElement, SessionViewProps>(function SessionView(
  { session, maxAnswerLength, busy, onAnswer, onPick, onClose },
  ref,
) {
  const { status, engine, lookedAt, knowledge, refusal, unanswerable, failure, fallback } = session;
  const headingId = `advisor-session-${session.id}`;
  const working = isWorking(session);
  const ended = isEnded(status);
  const picked = session.options?.find((option) => option.id === session.pickedOption) ?? null;

  let heading: string | null = null;
  let message: string | null = null;
  if (status === 'refused') {
    heading = 'Refused';
    message = refusal?.message ?? REFUSED_FALLBACK_WORDS;
  } else if (status === 'unanswerable') {
    heading = 'Outside what the advisor covers';
    message = unanswerable?.message ?? REFUSED_FALLBACK_WORDS;
  } else if (status === 'failed') {
    heading = 'The session failed';
    message = failure?.message ?? FAILED_FALLBACK_WORDS;
  } else if (status === 'cancelled') {
    heading = 'Session closed';
    message = failure?.message ?? CANCELLED_WORDS;
  }

  const withheld = knowledge?.withheld.length ?? 0;
  const pregathered = pregatheredWords(session);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="rounded-md border border-border-hairline bg-bg-subtle p-3"
      data-testid="advisor-session"
      data-state={status}
      data-working={working ? 'true' : undefined}
    >
      {session.origin !== null && (
        <div className="mb-2" data-testid="advisor-origin">
          <p
            className="text-caption font-medium text-text-secondary [overflow-wrap:anywhere]"
            data-testid="advisor-origin-line"
          >
            {originWords(session.origin)}
          </p>
          {pregathered !== null && (
            <p
              className="mt-0.5 text-caption text-text-muted [overflow-wrap:anywhere]"
              data-testid="advisor-pregathered"
            >
              {pregathered}
            </p>
          )}
        </div>
      )}
      <h3
        id={headingId}
        className="text-small font-medium text-text-primary [overflow-wrap:anywhere]"
      >
        {session.question}
      </h3>

      {engine !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge
            variant="accent"
            icon={<Bot size={12} aria-hidden="true" className="shrink-0" />}
            className="max-w-full rounded-md [overflow-wrap:anywhere]"
            data-testid="advisor-session-badge"
          >
            {runsOnLabel(engine)}
          </Badge>
          {session.aiAssisted && (
            <span
              className="text-caption font-medium text-text-secondary"
              data-testid="advisor-ai-label"
            >
              AI-assisted wording
            </span>
          )}
        </div>
      )}

      {working && (
        <p className="mt-2 text-small text-text-muted" data-testid="advisor-working">
          This step is being worked on; the page updates when it is done.
        </p>
      )}

      {status === 'clarifying' && session.clarification !== null && (
        <ClarifyForm
          clarification={session.clarification}
          maxAnswerLength={maxAnswerLength}
          busy={busy}
          onContinue={onAnswer}
        />
      )}

      {status === 'awaiting_pick' && <OptionsList session={session} busy={busy} onPick={onPick} />}

      {(status === 'planning' || status === 'tracked' || status === 'completed') &&
        picked !== null && (
          <p className="mt-2 text-small text-text-primary" data-testid="advisor-picked">
            Picked option: {picked.label}
          </p>
        )}

      {(status === 'tracked' || status === 'completed') &&
        session.plan !== null &&
        session.plan.length > 0 && <Plan plan={session.plan} />}
      {(status === 'tracked' || status === 'completed') && session.tracked !== null && (
        <Tracked tracked={session.tracked} completed={status === 'completed'} />
      )}

      {heading !== null && (
        <h4
          className="mt-2 text-small font-medium text-text-primary"
          data-testid="advisor-state-heading"
        >
          {heading}
        </h4>
      )}
      {message !== null && (
        <p className="mt-1 text-small text-text-primary" data-testid="advisor-message">
          {message}
        </p>
      )}
      {status === 'refused' && refusal !== null && refusal.class !== '' && (
        <p className="mt-1 text-caption text-text-muted" data-testid="advisor-refusal-class">
          Stopped at the {refusalStepWords(refusal.step)} step: {refusal.class}
        </p>
      )}
      {status === 'unanswerable' && unanswerable !== null && (
        <p className="mt-2 text-small text-text-secondary" data-testid="advisor-nearest-screen">
          The closest screen is{' '}
          <ScreenLink
            path={unanswerable.nearestScreen.path}
            label={unanswerable.nearestScreen.label}
            testId="advisor-nearest-link"
          />
          .
        </p>
      )}

      {lookedAt !== null && (
        <>
          {fallback && lookedAt.items.length > 0 && (
            <p
              className="mt-3 text-small font-medium text-text-primary"
              data-testid="advisor-arithmetic-heading"
            >
              The arithmetic, without the prose
            </p>
          )}
          <LookedAt lookedAt={lookedAt} defaultOpen={fallback} />
        </>
      )}

      {withheld > 0 && (
        <p className="mt-2 text-caption text-text-muted" data-testid="advisor-withheld">
          {withheldWords(withheld)}
        </p>
      )}

      {session.judge !== null && <Judge judge={session.judge} />}

      <p className="mt-3 text-caption text-text-muted" data-testid="advisor-tokens">
        Tokens used: {session.tokens.used.toLocaleString('en-US')} of{' '}
        {session.tokens.budget.toLocaleString('en-US')}
        {session.tokens.hostedWindowLeft !== null && (
          <span data-testid="advisor-hosted-left">
            {' '}
            · Hosted calls left this hour: {String(session.tokens.hostedWindowLeft)}
          </span>
        )}
      </p>

      {!ended && (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={busy ? 'true' : undefined}
            onClick={() => {
              if (!busy) onClose();
            }}
            data-testid="advisor-close"
          >
            Close this session
          </Button>
        </div>
      )}
    </section>
  );
});
