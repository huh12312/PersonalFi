// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { useState } from 'react';

import { listInsightsFeedOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { AdvisorsSettings } from './AdvisorsSettings.tsx';
import { InsightCard } from './InsightCard.tsx';

/**
 * `/insights` (02-phase-2-dispatch.md §3 WP 2.10): the ranked feed with a
 * full evidence panel behind every card, and the advisors settings section
 * (enable/disable + manual run, both step-up gated; the catalogue gaps).
 * The standing educational disclaimer lives on each card
 * (`EvidencePanel.tsx`'s closing line) rather than once at the top, so it is
 * visible at the exact moment someone is deciding what to do with a number.
 */
export function InsightsScreen() {
  const feedQuery = useQuery(listInsightsFeedOptions({ query: { statuses: ['pending_review'] } }));
  const [cooldownNotice, setCooldownNotice] = useState<string | null>(null);

  if (feedQuery.isLoading) return <SkeletonText lines={6} />;

  const feed = feedQuery.data;
  const insights = feed?.list ?? [];
  const overflowCount = feed?.overflow.length ?? 0;
  const belowFloorCount = feed?.belowFloor.length ?? 0;

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

      <Tabs defaultValue="feed">
        <TabsList aria-label="Insights sections">
          <TabsTab value="feed">Feed</TabsTab>
          <TabsTab value="advisors">Advisors</TabsTab>
          <TabsIndicator />
        </TabsList>

        <TabsPanel value="feed">
          {insights.length === 0 ? (
            <EmptyState
              icon={Lightbulb}
              headline="You're all caught up"
              description="Insights about spending, price increases, and budgets will appear here as they're found."
            />
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
        </TabsPanel>

        <TabsPanel value="advisors">
          <AdvisorsSettings />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
