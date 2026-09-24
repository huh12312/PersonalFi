// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { Percent } from '../components/finance/Percent.tsx';
import { StatTile } from '../components/finance/StatTile.tsx';
import { Card } from '../components/ui/card.tsx';
import { Money } from '../components/finance/Money.tsx';
import { NetWorthDashboardSection } from '../features/networth/NetWorthChart.tsx';
import { netWorthSearchSchema } from '../features/networth/search.ts';
import { TopInsightsWidget } from '../features/insights/TopInsightsWidget.tsx';

/**
 * `/` — Dashboard. `validateSearch` adds `netWorthRange` (WP 3.12), the one
 * piece of URL state the net-worth full view needs to round-trip — the same
 * `validateSearch` + `Route.useSearch()`/`Route.useNavigate()` shape as
 * `_app.transactions.tsx`'s own search schema.
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: netWorthSearchSchema,
  component: DashboardRoute,
});

/**
 * The hero net-worth stat and the net-worth chart (compact here, with a
 * "View full history" dialog for the range-selectable full view), which
 * together prove the visx pipeline end to end against the real
 * `GET /net-worth/series`. The cash-flow card, needs-attention strip and
 * upcoming bills wait on features that read real data.
 */
function DashboardRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <Card padding="default">
        <StatTile
          label="Net worth"
          size="hero"
          value={<Money value={{ minor: '8890400', currency: 'USD' }} colorBySign={false} />}
          delta={
            <span className="inline-flex items-center gap-1.5">
              <Money value={{ minor: '421000', currency: 'USD' }} />
              <Percent value={0.021} colorBySign />
              <span className="text-text-muted">this month</span>
            </span>
          }
        />
        <NetWorthDashboardSection
          className="mt-4"
          range={search.netWorthRange}
          onRangeChange={(range) =>
            void navigate({ search: { ...search, netWorthRange: range }, replace: true })
          }
        />
      </Card>
      <TopInsightsWidget />
    </div>
  );
}
