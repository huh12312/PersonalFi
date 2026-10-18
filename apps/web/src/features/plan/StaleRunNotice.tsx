// SPDX-License-Identifier: MIT
import type { ProjectionRun, ProjectionStaleness } from '../../api/generated/types.gen.ts';

export interface StaleRunNoticeProps {
  /** `status` of the projection answer. */
  readonly status: 'computed' | 'cached' | 'stale';
  readonly staleness: ProjectionStaleness | null;
  /** The stored run the answer carries; `null` when the scenario has none yet. */
  readonly run: ProjectionRun | null;
}

interface StaleWords {
  readonly headline: string;
  readonly body: string;
}

/**
 * One sentence per staleness arm of the contract. The `never` default makes a
 * new arm a compile error here; `e2e/plan.spec.ts` reads the arms out of
 * `openapi.json` and fails on one it has no fixture for.
 */
export function staleWords(staleness: ProjectionStaleness, run: ProjectionRun | null): StaleWords {
  const computedOn =
    run === null
      ? 'There is no stored result to show.'
      : `The result below was computed on assumptions version ${run.assumptionsVersion}, from the ${run.asOfDate} balances.`;
  switch (staleness.reason) {
    case 'assumptions_version_retired':
      return {
        headline: 'This result is out of date.',
        body: [
          `It was computed on assumptions version ${staleness.assumptionsVersion}, which this build no longer holds (it holds ${staleness.known.join(', ') || 'no other version'}).`,
          'Nothing was recomputed.',
          run === null ? 'There is no stored result to show.' : '',
          'Re-save your assumption overrides below to move them onto the current file.',
        ]
          .filter((sentence) => sentence !== '')
          .join(' '),
      };
    case 'assumptions_changed':
      return {
        headline: 'This result is out of date.',
        body:
          `It used assumptions version ${staleness.assumptionsVersion}; your assumptions are now version ` +
          `${staleness.currentVersion}. The figures below were not recomputed.`,
      };
    case 'account_overrides_changed':
      return {
        headline: 'This result is out of date.',
        body: `${computedOn} You changed account settings after that. The changes, and the button that recomputes with them, are in the notice above.`,
      };
    default: {
      const unreachable: never = staleness;
      return unreachable;
    }
  }
}

/**
 * A stored projection that is no longer current, named as such with the version
 * it was computed on (WP 9.7, G4-16). The server serves the stored run `stale`
 * and computes nothing; this says so, and never lets the run read as the
 * current answer. The account-settings arm's change list and recompute button
 * are WP 9.2's `ProjectionOverridesNotice` — this component points at it and
 * does not repeat it.
 */
export function StaleRunNotice({ status, staleness, run }: StaleRunNoticeProps) {
  if (staleness === null && status !== 'stale') return null;
  const words =
    staleness === null
      ? {
          headline: 'This result is out of date.',
          body:
            run === null
              ? 'There is no stored result to show.'
              : `It was computed on assumptions version ${run.assumptionsVersion} and was not recomputed.`,
        }
      : staleWords(staleness, run);
  return (
    <div
      role="status"
      data-testid="plan-run-stale"
      data-staleness={staleness?.reason ?? 'unspecified'}
      className="flex flex-col gap-1 rounded-md border border-status-warning-border bg-bg-subtle p-3 text-small text-text-primary"
    >
      <p className="font-semibold">{words.headline}</p>
      <p>{words.body}</p>
    </div>
  );
}
