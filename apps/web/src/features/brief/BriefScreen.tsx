// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';

import { getCurrentBriefOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { HealthScoreSection } from '../health/HealthScoreSection.tsx';
import { AttentionStrip } from './AttentionStrip.tsx';
import { BriefItemCard } from './BriefItemCard.tsx';
import { BRIEF_DISCLAIMER } from './disclaimer.ts';
import type { BriefItemWithNarration } from './types.ts';

/**
 * The Brief's own five-card cap (05-phase-5-dispatch.md §3 WP 5.6/5.11:
 * "at most five cards"). The backend already enforces this
 * (`brief/ranking.ts#selectRanked`, `wp5.6-brief.md` §4) — this is a second,
 * independent enforcement in the view itself, which is deliberate: it is
 * what lets this screen prove the cap rather than merely trust it (the
 * sabotage this work package's own evidence names: "the five-card cap
 * removed → red").
 */
const MAX_RANKED_CARDS = 5;

/**
 * `/brief` (05-phase-5-dispatch.md §3 WP 5.11): the Weekly Advisory Brief —
 * at most five ranked actions, the attention strip above them, the
 * nothing-material and cold-start states, 07 §7.2's disclaimer, and the
 * health score beneath.
 */
export function BriefScreen() {
  const briefQuery = useQuery(getCurrentBriefOptions());

  if (briefQuery.isLoading) {
    return <SkeletonText lines={8} />;
  }

  if (briefQuery.isError) {
    const problem = briefQuery.error as Problem;
    if (problem.code === 'insights.brief_not_found') {
      return (
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <EmptyState
            icon={CalendarClock}
            headline="Your first Brief hasn't run yet"
            description="The Weekly Advisory Brief publishes every Sunday morning. Check back after the first run."
          />
          <HealthScoreSection />
        </div>
      );
    }
    return (
      <div role="alert" className="mx-auto max-w-3xl text-small text-text-secondary">
        Could not load this week's Brief.
      </div>
    );
  }

  const brief = briefQuery.data?.brief;
  if (brief === undefined) {
    return <SkeletonText lines={8} />;
  }
  const attention: BriefItemWithNarration[] = brief.items.filter(
    (item) => item.section === 'attention',
  );
  const ranked: BriefItemWithNarration[] = brief.items
    .filter((item) => item.section === 'ranked')
    .slice(0, MAX_RANKED_CARDS);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-h2 text-text-primary">This week's Brief</h1>
        <p className="mt-1 text-caption text-text-muted" data-testid="brief-disclaimer">
          {BRIEF_DISCLAIMER}
        </p>
      </div>

      {brief.coldStart && brief.coldStartNote !== null && (
        <div
          role="status"
          data-testid="brief-cold-start"
          className="rounded-md border border-border-hairline bg-bg-subtle p-3 text-small text-text-secondary"
        >
          {brief.coldStartNote}
        </div>
      )}

      <AttentionStrip items={attention} />

      {brief.nothingMaterial ? (
        <EmptyState
          icon={CalendarClock}
          headline="Nothing material this week"
          description="No finding cleared the Brief's bar this week. Check back next Sunday."
        />
      ) : (
        <ul
          aria-label="This week's ranked actions"
          data-testid="brief-ranked-list"
          className="flex flex-col gap-3"
        >
          {ranked.map((item) => (
            <BriefItemCard key={item.id} item={item} />
          ))}
        </ul>
      )}

      <HealthScoreSection />
    </div>
  );
}
