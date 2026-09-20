// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import {
  getRecurringForecastOptions,
  getRecurringUpcomingOptions,
  getSafeToSpendOptions,
  listRecurringCandidatesOptions,
  listRecurringSeriesOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Card, CardDescription } from '../../components/ui/card.tsx';
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import { CandidatesQueue } from './CandidatesQueue.tsx';
import { buildForecastBand } from './forecast-series.ts';
import { ForecastBandChart } from './ForecastBandChart.tsx';
import { SeriesList } from './SeriesList.tsx';
import { UpcomingCalendar } from './UpcomingCalendar.tsx';
import { useMerchantNames } from './useMerchantNames.ts';

/**
 * `/recurring` (02-phase-2-dispatch.md §3 WP 2.10): the candidate inbox, the
 * confirmed/detected series list, the 30-day upcoming calendar, and the
 * forward cash-flow band + safe-to-spend figure, all over `@ctx/recurring`'s
 * REST surface (docs/evidence/phase-2/wp2.r-routes.md §1).
 */
export function RecurringScreen() {
  const candidatesQuery = useQuery(listRecurringCandidatesOptions({ query: {} }));
  const seriesQuery = useQuery(listRecurringSeriesOptions({ query: {} }));
  const upcomingQuery = useQuery(getRecurringUpcomingOptions({ query: { days: 30 } }));
  const forecastQuery = useQuery(getRecurringForecastOptions({ query: { days: 30 } }));
  const safeToSpendQuery = useQuery(getSafeToSpendOptions({ query: {} }));

  const merchantIds = [
    ...(candidatesQuery.data?.candidates.map((c) => c.merchantId) ?? []),
    ...(seriesQuery.data?.series.map((s) => s.merchantId) ?? []),
    ...(upcomingQuery.data?.days.flatMap((d) => d.charges.map((c) => c.merchantId)) ?? []),
  ];
  const { nameOf } = useMerchantNames(merchantIds);

  const isLoading = candidatesQuery.isLoading || seriesQuery.isLoading || upcomingQuery.isLoading;

  if (isLoading) return <SkeletonText lines={8} />;

  const candidates = candidatesQuery.data?.candidates ?? [];
  const series = seriesQuery.data?.series ?? [];
  const forecast = forecastQuery.data;
  const safeToSpend = safeToSpendQuery.data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {candidates.length > 0 && (
        <section aria-labelledby="recurring-candidates-heading">
          <h2 id="recurring-candidates-heading" className="text-h3 text-text-primary">
            Needs your confirmation
          </h2>
          <p className="mt-1 text-small text-text-muted">
            {candidates.length} pattern{candidates.length === 1 ? '' : 's'} we haven't asked you
            about yet.
          </p>
          <div className="mt-3">
            <CandidatesQueue candidates={candidates} nameOf={nameOf} />
          </div>
        </section>
      )}

      <Card padding="default">
        {/* A raw `<h2>` rather than `CardTitle` (which renders an `<h3>`):
            when there are no candidates, "Needs your confirmation" above
            does not render, and this would be the first heading under the
            route's own `<h1>` — an h3 there would skip a level. */}
        <h2 className="text-h2 text-text-primary">Forward cash flow</h2>
        <CardDescription className="mb-4">
          The next 30 days, projected from your confirmed and detected streams. The shaded band is
          the detector's own uncertainty, not a guess drawn for effect.
        </CardDescription>
        {forecast === undefined ? (
          <SkeletonText lines={3} />
        ) : (
          <>
            <div className="flex flex-wrap gap-6">
              <StatTile
                label="Safe to spend"
                value={
                  safeToSpend === undefined ? (
                    <SkeletonText lines={1} />
                  ) : (
                    <Money value={safeToSpend.safe} colorBySign />
                  )
                }
                size="hero"
              />
              <StatTile label="Expected net (30 days)" value={<Money value={forecast.net} />} />
              <StatTile
                label="Worst case"
                value={<Money value={forecast.netLow} colorBySign={false} />}
              />
            </div>
            <ForecastBandChart
              data={buildForecastBand(forecast.from, forecast.to, forecast.charges)}
              className="mt-4"
            />
          </>
        )}
      </Card>

      <Tabs defaultValue="series">
        <TabsList aria-label="Recurring sections">
          <TabsTab value="series">Subscriptions &amp; bills</TabsTab>
          <TabsTab value="upcoming">Upcoming</TabsTab>
          <TabsIndicator />
        </TabsList>
        <TabsPanel value="series">
          <SeriesList series={series} nameOf={nameOf} />
        </TabsPanel>
        <TabsPanel value="upcoming">
          {upcomingQuery.data === undefined ? (
            <SkeletonText lines={4} />
          ) : (
            <UpcomingCalendar calendar={upcomingQuery.data} nameOf={nameOf} />
          )}
        </TabsPanel>
      </Tabs>
    </div>
  );
}
