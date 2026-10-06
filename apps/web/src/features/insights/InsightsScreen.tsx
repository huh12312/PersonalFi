// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { KeyRound, Lightbulb } from 'lucide-react';
import { useState } from 'react';

import {
  listAdvisorsOptions,
  listInsightsFeedOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { AdvisorHealth } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { InsightCard } from './InsightCard.tsx';

/**
 * `/insights` (02-phase-2-dispatch.md §3 WP 2.10): the ranked feed with a
 * full evidence panel behind every card. The standing educational
 * disclaimer lives on each card (`EvidencePanel.tsx`'s closing line) rather
 * than once at the top, so it is visible at the exact moment someone is
 * deciding what to do with a number.
 *
 * The advisor settings section (enable/disable, manual run, scope grants,
 * run inspector, payload preview) moved to `/settings/advisors`
 * (`docs/plan/05-phase-5-dispatch.md` §3 WP 5.12 —
 * `features/advisors/AdvisorManagementScreen.tsx`); this screen no longer
 * mounts it.
 *
 * **Why an empty feed can be about consent (G4-18, WP 9.6 item 6).** An advisor
 * reads only the scopes the holder has granted it, and the default is none: an
 * install where nothing has been granted runs every advisor on an empty
 * snapshot and the feed is empty for that reason, not because nothing is wrong.
 * "You're all caught up" would then be a false comfort, so an empty feed asks
 * the advisor list whether any enabled advisor holds a grant, and says so when
 * none does. If the advisor list cannot be read, the screen does not guess: it
 * shows the ordinary empty state.
 */

/** Enabled, un-quarantined advisors split by whether the holder has granted them anything. */
export function consentCounts(advisors: readonly AdvisorHealth[]): {
  readonly active: number;
  readonly withoutAccess: number;
} {
  const active = advisors.filter((advisor) => advisor.enabled && advisor.quarantinedAt === null);
  return {
    active: active.length,
    withoutAccess: active.filter((advisor) => advisor.grantedScopes.length === 0).length,
  };
}

export function InsightsScreen() {
  const feedQuery = useQuery(listInsightsFeedOptions({ query: { statuses: ['pending_review'] } }));
  const advisorsQuery = useQuery(listAdvisorsOptions());
  const [cooldownNotice, setCooldownNotice] = useState<string | null>(null);

  if (feedQuery.isLoading) return <SkeletonText lines={6} />;

  const feed = feedQuery.data;
  const insights = feed?.list ?? [];
  const overflowCount = feed?.overflow.length ?? 0;
  const belowFloorCount = feed?.belowFloor.length ?? 0;
  const consent =
    advisorsQuery.data === undefined ? null : consentCounts(advisorsQuery.data.advisors);
  const consentIsWhy =
    consent !== null && consent.active > 0 && consent.withoutAccess === consent.active;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {cooldownNotice !== null && (
        <div
          role="status"
          data-testid="cooldown-notice"
          className="rounded-md border border-border-hairline bg-bg-subtle p-3 text-small text-text-secondary"
        >
          {cooldownNotice}
        </div>
      )}

      {insights.length === 0 && consentIsWhy ? (
        <EmptyState
          icon={KeyRound}
          headline="No advisor has been given access to your data"
          description="Advisors read only what you grant them, and nothing is granted yet, so there is nothing to find. This is not the same as being all caught up."
        >
          <Link
            to="/settings/advisors"
            className="text-small text-accent-text underline"
            data-testid="insights-consent-link"
          >
            Choose what advisors can read
          </Link>
        </EmptyState>
      ) : insights.length === 0 ? (
        <>
          <EmptyState
            icon={Lightbulb}
            headline="You're all caught up"
            description="Insights about spending, price increases, and budgets will appear here as they're found."
          />
          {consent !== null && consent.withoutAccess > 0 && (
            <p className="text-caption text-text-muted" data-testid="insights-consent-partial">
              {String(consent.withoutAccess)} of {String(consent.active)} advisors have not been
              given access to any of your data, so they cannot have found anything.{' '}
              <Link to="/settings/advisors" className="text-accent-text underline">
                Advisor management
              </Link>
            </p>
          )}
        </>
      ) : (
        <>
          <ul aria-label="Insights" className="flex flex-col gap-3">
            {insights.map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onReviewed={(action, result) => {
                  if (action !== 'dismiss') {
                    setCooldownNotice(null);
                    return;
                  }
                  setCooldownNotice(
                    result.permanent
                      ? 'Dismissed. After three dismissals this finding is suppressed for good.'
                      : result.suppressedUntil === null
                        ? 'Dismissed.'
                        : `Dismissed until ${new Date(result.suppressedUntil).toLocaleDateString()}.`,
                  );
                }}
              />
            ))}
          </ul>
          {(overflowCount > 0 || belowFloorCount > 0) && (
            <p className="mt-3 text-caption text-text-muted">
              {overflowCount > 0 &&
                `${String(overflowCount)} more insight${overflowCount === 1 ? '' : 's'} past the list's alert budget. `}
              {belowFloorCount > 0 &&
                `${String(belowFloorCount)} below the minimum dollar impact to surface.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
