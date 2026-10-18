// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

import { getHealthScoreOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { Card } from '../../components/ui/card.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';

/**
 * The Brief's health-score section (WP 5.11), since WP 10.12 a link to `/health`: the score, its six pillars as
 * cards, their zones and the daily history live on the Financial health screen now. Here, only the week's score as
 * the weekly job stored it (`GET /insights/health-score`) — or "not computed yet" — and the way there.
 */
export function HealthScoreSection() {
  const query = useQuery(getHealthScoreOptions());
  const problem = query.error as Problem | null;

  let line: string | null;
  if (query.isLoading) line = null;
  else if (problem?.code === 'insights.health_score_not_computed')
    line = 'This week’s score: not computed yet. It is calculated along with your weekly Brief.';
  else if (query.isError || query.data === undefined)
    line = 'This week’s score could not be loaded.';
  else
    line =
      query.data.healthScore.overall === null
        ? 'This week’s score: not enough data to compute.'
        : `This week’s score: ${String(query.data.healthScore.overall)} / 100.`;

  return (
    <Card padding="default" data-testid="health-score-link">
      <h2 className="text-h3 text-text-primary">Financial health score</h2>
      {line === null ? (
        <SkeletonText lines={1} />
      ) : (
        <p className="mt-1 text-small text-text-secondary" data-testid="health-score-overall">
          {line}
        </p>
      )}
      <p className="mt-1 text-small text-text-secondary">
        Your score as a gauge, its six pillars and how it has moved are on the Financial health
        screen.
      </p>
      <Link
        to="/health"
        className="mt-2 inline-flex min-h-6 items-center gap-0.5 text-small font-medium text-accent-text underline-offset-4 hover:underline"
      >
        Open Financial health
        <ChevronRight size={14} aria-hidden="true" />
      </Link>
    </Card>
  );
}
