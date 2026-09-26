// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { StatTile } from '../components/finance/StatTile.tsx';
import { Card } from '../components/ui/card.tsx';
import { Money } from '../components/finance/Money.tsx';
import { useNetWorthSeriesQuery } from '../features/networth/api.ts';
import { NetWorthDashboardSection } from '../features/networth/NetWorthChart.tsx';
import { netWorthSearchSchema } from '../features/networth/search.ts';
import { latestValued } from '../features/networth/series.ts';
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
 * The hero net-worth figure, read from the same `GET /net-worth/series`
 * response the chart below draws (`'p90d'` — the compact chart's window — so
 * TanStack Query serves both from one request).
 *
 * Phase 3 gate finding G3-2 (docs/evidence/phase-3/gate-security-review.md):
 * until this was fixed the hero rendered two scaffold literals from WP 0.x —
 * `$88,904.00` and "+$4,210.00 2.1% this month" — on every install, above a
 * chart drawn from real data. A net worth the app did not compute is the one
 * number this screen must never show, so there is deliberately no fallback
 * here: no value yet reads as "—", and no month-over-month delta is shown at
 * all until one can be computed from two real points.
 */
export function NetWorthHero() {
  const seriesQuery = useNetWorthSeriesQuery('p90d');
  const latest = latestValued(seriesQuery.data?.points ?? []);

  return (
    <StatTile
      label="Net worth"
      size="hero"
      value={
        latest?.netWorth != null ? (
          <Money value={latest.netWorth} colorBySign={false} />
        ) : (
          <span aria-label="No net worth recorded yet">—</span>
        )
      }
      delta={
        <span className="text-text-muted">
          {latest === undefined
            ? seriesQuery.isLoading
              ? 'Loading…'
              : 'No net worth recorded yet'
            : `As of ${latest.asOfDate}${latest.sealed ? '' : ' · live, may still change'}`}
        </span>
      }
    />
  );
}

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
        <NetWorthHero />
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
