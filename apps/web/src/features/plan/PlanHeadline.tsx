// SPDX-License-Identifier: MIT
import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import type { RunPlanProjectionResponse } from '../../api/generated/types.gen.ts';
import { isProbabilistic, SINGLE_PATH_OUTCOME_WORDS, singlePathOutcome } from './engine.ts';

export interface PlanHeadlineProps {
  /** The projection query has no answer yet and has not failed. */
  readonly loading: boolean;
  /** The projection query failed; its words are in `ProjectionProblem`. */
  readonly failed: boolean;
  readonly projection: RunPlanProjectionResponse | undefined;
}

/**
 * The one sentence at the top of `/plan` (WP 9.7, G4-10, G4-13).
 *
 * It says "Projecting your plan…" only while the projection is genuinely on its
 * way: an error and an empty answer each get a sentence of their own. It is
 * phrased by the engine that produced the run — a share of simulated paths for
 * Monte Carlo, an outcome for a deterministic path, which has no probability to
 * quote — and a stored run that is stale is labelled before anything else is
 * said about it. Every figure is a field of the response; nothing is computed
 * here (`docs/CONVENTIONS.md`: no client-side money math beyond formatting).
 */
export function PlanHeadline({ loading, failed, projection }: PlanHeadlineProps) {
  const run = projection?.run ?? null;
  const percentiles = projection?.percentiles ?? [];
  const lastRow = percentiles[percentiles.length - 1];
  const stale = projection?.status === 'stale';

  let body;
  if (run !== null && lastRow !== undefined) {
    const balance = (
      <Money
        value={lastRow.p50}
        signDisplay="auto"
        colorBySign={false}
        data-testid="plan-headline-amount"
      />
    );
    body = isProbabilistic(run) ? (
      <>
        Median projected balance {balance} at age {lastRow.age} —{' '}
        <Percent
          value={Number(run.successProbability)}
          signDisplay="never"
          data-testid="plan-headline-probability"
        />{' '}
        of simulated paths succeed.
      </>
    ) : (
      <>
        On this one path the balance is {balance} at age {lastRow.age}, and the plan{' '}
        <span data-testid="plan-headline-outcome">
          {SINGLE_PATH_OUTCOME_WORDS[singlePathOutcome(run)]}
        </span>
        .
      </>
    );
  } else if (failed) {
    body = 'Your plan could not be projected. The reason is below.';
  } else if (loading) {
    body = 'Projecting your plan…';
  } else {
    body = 'There is no stored projection to show yet.';
  }

  return (
    <p className="text-body text-text-secondary" data-testid="plan-headline">
      {stale && run !== null && lastRow !== undefined && (
        <strong className="font-semibold text-text-primary">Out of date, as last computed: </strong>
      )}
      {body}
    </p>
  );
}
