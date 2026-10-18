// SPDX-License-Identifier: MIT
import { TopInsightsList, useTopInsightsQuery } from '../../insights/TopInsightsWidget.tsx';
import { DashboardWidgetCard, type WidgetState } from '../DashboardWidgetCard.tsx';

/** Top insights (WP 10.9): the existing top-five list, in the widget frame. */
export function TopInsightsDashboardWidget() {
  const query = useTopInsightsQuery();
  const insights = query.data?.dashboard ?? [];
  const state: WidgetState = query.isLoading
    ? { kind: 'loading' }
    : query.isError
      ? { kind: 'error', message: "Insights aren't available right now." }
      : insights.length === 0
        ? {
            kind: 'empty',
            message: 'No insights are waiting for you.',
            fix: { to: '/insights', label: 'Open insights' },
          }
        : { kind: 'ready' };
  return (
    <DashboardWidgetCard
      id="top-insights"
      title="Top insights"
      seeAll={{ to: '/insights', label: 'See all' }}
      state={state}
    >
      <TopInsightsList insights={insights} />
    </DashboardWidgetCard>
  );
}
