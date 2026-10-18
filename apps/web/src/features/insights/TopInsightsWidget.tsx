// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import { listInsightsFeedOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Insight } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { headlineImpactOf } from './severity.ts';

/**
 * The dashboard's top-5 insights (02-phase-2-dispatch.md §3): one query, no mutations, no dialogs.
 * `feed.dashboard` is already the alert-budget-limited slice (`@ctx/insights`' `applyAlertBudget`, 5 on the
 * dashboard); nothing here re-slices or re-ranks it. WP 10.9 split the old self-framed card into the query and the
 * list, so the dashboard's widget frame (`features/dashboard/DashboardWidgetCard.tsx`) owns the title, the "See
 * all" link and the empty state.
 */
export function useTopInsightsQuery() {
  return useQuery(listInsightsFeedOptions({ query: { statuses: ['pending_review'] } }));
}

export function TopInsightsList({ insights }: { readonly insights: readonly Insight[] }) {
  return (
    <ul className="flex flex-col gap-2" data-testid="top-insights">
      {insights.map((insight) => {
        const impact = headlineImpactOf(insight);
        return (
          <li key={insight.id} className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <SeverityBadge severity={insight.severity} />
              <span className="truncate text-small text-text-secondary">{insight.title}</span>
            </div>
            {impact !== null && <Money value={impact.money} className="shrink-0 text-small" />}
          </li>
        );
      })}
    </ul>
  );
}
