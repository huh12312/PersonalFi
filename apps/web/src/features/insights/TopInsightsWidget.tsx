// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import { listInsightsFeedOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { Card } from '../../components/ui/card.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { headlineImpactOf } from './severity.ts';

/**
 * The dashboard's top-5 insight widget (02-phase-2-dispatch.md §3): a small,
 * isolated read-only component — one query, no mutations, no dialogs — so
 * `_app.index.tsx` only ever needs the one import line this file's own
 * consumer adds. `feed.dashboard` is already the alert-budget-limited slice
 * (`@ctx/insights`' `applyAlertBudget`, 5 on the dashboard); this component
 * does not re-slice or re-rank it.
 */
export function TopInsightsWidget() {
  const feedQuery = useQuery(listInsightsFeedOptions({ query: { statuses: ['pending_review'] } }));
  const insights = feedQuery.data?.dashboard ?? [];

  if (feedQuery.isLoading || insights.length === 0) return null;

  return (
    <Card padding="default">
      {/* A raw `<h2>` rather than `CardTitle` (which renders an `<h3>`):
          this is the first heading under the dashboard's own `<h1>`
          (`app/shell/TopBar.tsx`'s page title), and nothing above it on
          `/` renders an intervening h2 — axe's `heading-order` rule flags
          an h1->h3 skip. */}
      <h2 className="mb-4 text-h2 text-text-primary">Top insights</h2>
      <ul className="flex flex-col gap-2">
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
    </Card>
  );
}
