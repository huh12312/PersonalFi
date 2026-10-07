// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import type { RiskProfile } from '../../api/generated/types.gen.ts';
import { ProjectionProblem } from '../plan/ProjectionProblem.tsx';
import { useRiskProfileQuery } from './api.ts';
import { LIQUIDITY_LABELS, TOLERANCE_LABELS } from './labels.ts';

/** The one line that states a stored profile: tolerance, when it was answered, and the two answers beside it. */
export function describeProfile(profile: RiskProfile): string {
  return `${TOLERANCE_LABELS[profile.tolerance]} risk tolerance, answered ${profile.answeredAt.slice(0, 10)}. Time horizon ${String(profile.horizonYears)} years; need for cash: ${LIQUIDITY_LABELS[profile.liquidityNeed].split(':')[0]?.toLowerCase() ?? profile.liquidityNeed}.`;
}

/**
 * What the plan screen reads from the risk questionnaire (WP 9.7, C-10): the holder's current
 * tolerance, from `GET /risk-profile`, and a link to take or retake it. It states what the
 * projection does and does not do with it: the engine's glidepath is chosen in the baseline plan,
 * so this is shown beside the plan to be compared with it, not fed into it.
 */
export function RiskProfileSummary() {
  const query = useRiskProfileQuery();
  return (
    <section
      aria-labelledby="plan-risk-heading"
      className="flex flex-col gap-1 rounded-md border border-border-hairline p-4"
      data-testid="plan-risk-profile"
    >
      <h2 id="plan-risk-heading" className="text-small font-semibold text-text-primary">
        Your risk profile
      </h2>
      {query.isLoading && <p className="text-small text-text-muted">Loading…</p>}
      {query.isError && (
        <ProjectionProblem error={query.error} onRetry={() => void query.refetch()} />
      )}
      {query.isSuccess && query.data.current === null && (
        <p className="text-small text-text-secondary">
          You have not answered the risk questionnaire yet.{' '}
          <Link
            to="/goals"
            hash="risk-profile"
            className="text-text-primary underline underline-offset-4"
          >
            Take the questionnaire
          </Link>
          .
        </p>
      )}
      {query.isSuccess && query.data.current !== null && (
        <>
          <p className="text-small text-text-primary" data-testid="plan-risk-profile-text">
            {describeProfile(query.data.current)}
          </p>
          <p className="text-caption text-text-muted">
            The projection does not use this: its glidepath is set in your baseline plan. It is
            shown here so you can compare the two.{' '}
            <Link
              to="/goals"
              hash="risk-profile"
              className="text-text-primary underline underline-offset-4"
            >
              Review or retake the questionnaire
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}
