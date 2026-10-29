// SPDX-License-Identifier: MIT
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Bot, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import {
  ADVISOR_DISCLAIMER,
  NO_MODEL_REASONS,
  UNAVAILABLE_FALLBACK_WORDS,
  egressWords,
  isWorking,
  outcomeWords,
  runsOnLabel,
  stepWords,
  type AdvisorOverview,
} from './advisor-words.ts';
import { AdvisorHistory } from './AdvisorHistory.tsx';
import { SessionView } from './SessionView.tsx';
import { StartForm } from './StartForm.tsx';
import { useAdvisor } from './useAdvisor.ts';

function Engine({ engine }: { readonly engine: NonNullable<AdvisorOverview['engine']> }) {
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border-hairline bg-bg-subtle p-3"
      data-testid="advisor-engine"
      data-egress={engine.egress}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="accent"
          icon={<Bot size={12} aria-hidden="true" className="shrink-0" />}
          className="max-w-full rounded-md [overflow-wrap:anywhere]"
          data-testid="advisor-engine-badge"
        >
          {runsOnLabel(engine)}
        </Badge>
      </div>
      <p className="text-small text-text-secondary" data-testid="advisor-engine-egress">
        {egressWords(engine)}
      </p>
      {engine.hostedFallback !== null && (
        <p className="text-small text-text-secondary" data-testid="advisor-engine-fallback">
          The hosted provider is not in use right now: {engine.hostedFallback}
        </p>
      )}
    </div>
  );
}

function Unavailable({ availability }: { readonly availability: AdvisorOverview['availability'] }) {
  const reason = availability.reason;
  return (
    <div
      className="rounded-md border border-border-hairline bg-bg-subtle p-3"
      data-testid="advisor-unavailable"
      data-reason={reason ?? undefined}
    >
      <p className="text-small font-medium text-text-primary">
        Advisor sessions are not available right now.
      </p>
      <p className="mt-1 text-small text-text-secondary" data-testid="advisor-unavailable-message">
        {availability.message ?? UNAVAILABLE_FALLBACK_WORDS}
      </p>
      <p className="mt-1 text-small text-text-secondary">
        Each step of the advisor is approved on its own in Advisor management.
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

export interface AdvisorScreenProps {
  /** How often a going session is read; tests shorten it. */
  readonly pollMs?: number;
}

/**
 * `/advisor` (WP 11.5d, advisor mode): the holder brings a question about their own money; the advisor restates
 * it, asks at most two questions, gathers the figures it needs from the app's own calculations, sets out options
 * each with what it gains and what it costs, and - once the holder picks one - writes steps that link to screens
 * of this app. The pick is followed in the Brief. Nothing is done for the holder, nothing is asked of a model until
 * a question is sent, and every state carries the disclaimer and names the provider and model it runs on.
 */
export function AdvisorScreen({ pollMs }: AdvisorScreenProps = {}) {
  // WP 11.5e: `?finding=&week=` starts one session about a finding; `?session=` opens one. The finding is shed from
  // the URL as soon as the api has answered (the session replaces it, a refusal just removes it), so a refresh
  // never posts again.
  const search = useSearch({ strict: false }) as {
    finding?: string;
    week?: string;
    session?: string;
  };
  const navigate = useNavigate();
  const advisor = useAdvisor({
    ...(pollMs === undefined ? {} : { pollMs }),
    finding: search.finding,
    week: search.week,
    session: search.session,
    onUrlSession: (id) => {
      void navigate({
        to: '/advisor',
        search: id === null ? {} : { session: id },
        replace: true,
      });
    },
  });
  const { overview, session } = advisor;
  const sectionRef = useRef<HTMLElement>(null);

  const working = session !== null && isWorking(session);
  // A state the holder asked for (or picked) takes focus as it lands, so keyboard and screen-reader users arrive on
  // it; one that was only resumed on opening the screen does not.
  const settledKey =
    session !== null && !working
      ? `${session.id}:${session.status}:${session.clarification === null ? 'x' : 'c'}`
      : null;
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!advisor.touched || settledKey === null || focused.current === settledKey) return;
    focused.current = settledKey;
    sectionRef.current?.focus();
  }, [advisor.touched, settledKey]);

  // Continue, a pick and Close remove the control that has focus once the session moves on; focus goes to the
  // session itself first, so it is never dropped on the page.
  function keepFocus(): void {
    sectionRef.current?.focus();
  }

  const live = advisor.sending
    ? { text: 'Sending…', visible: true }
    : session !== null && working
      ? { text: stepWords(session), visible: true }
      : session !== null && advisor.touched
        ? { text: outcomeWords(session), visible: false }
        : { text: '', visible: false };

  const unavailable = overview?.availability.state === 'unavailable';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-h2 text-text-primary">Advisor</h2>
        <p className="mt-1 text-small text-text-secondary">
          Bring a question about your own money. The advisor restates it, may ask up to two
          questions, gathers your figures from the app&apos;s own calculations and sets out options,
          each with what it gains and what it costs. Choosing is up to you.
        </p>
        <p className="mt-1 text-caption text-text-muted" data-testid="advisor-disclaimer">
          {overview?.disclaimer ?? ADVISOR_DISCLAIMER}
        </p>
      </div>

      {overview === undefined ? (
        advisor.overviewError ? (
          <div role="alert" className="text-small text-text-secondary">
            Could not load the Advisor.
          </div>
        ) : (
          <SkeletonText lines={6} />
        )
      ) : (
        <>
          {overview.engine !== null && <Engine engine={overview.engine} />}
          {unavailable && <Unavailable availability={overview.availability} />}

          <StartForm
            maxLength={overview.maxQuestionLength}
            examples={overview.examples}
            unavailable={unavailable}
            busy={advisor.sending || working}
            error={advisor.error}
            onStart={(question, clear) => advisor.start(question, clear)}
          />

          <div
            role="status"
            aria-live="polite"
            className="min-h-5 text-small text-text-muted"
            data-testid="advisor-live"
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
            <SessionView
              ref={sectionRef}
              session={session}
              maxAnswerLength={overview.maxAnswerLength}
              busy={advisor.sending}
              onAnswer={(answers) => {
                keepFocus();
                advisor.answer(answers);
              }}
              onPick={(optionId) => {
                keepFocus();
                advisor.pick(optionId);
              }}
              onClose={() => {
                keepFocus();
                advisor.close();
              }}
            />
          )}

          <p className="text-caption text-text-muted" data-testid="advisor-budget">
            Each session has a budget of {overview.tokenBudget.toLocaleString('en-US')} tokens.
          </p>

          <AdvisorHistory
            sessions={overview.sessions}
            selectedId={session?.id ?? null}
            onSelect={advisor.select}
          />
        </>
      )}
    </div>
  );
}
