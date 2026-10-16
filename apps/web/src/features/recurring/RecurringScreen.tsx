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
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.tsx';
import { CandidatesQueue } from './CandidatesQueue.tsx';
import { ForwardCashFlowCard } from './ForwardCashFlowCard.tsx';
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
    ...(forecastQuery.data?.charges.map((c) => c.merchantId) ?? []),
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

      <ForwardCashFlowCard
        forecast={forecast}
        safeToSpend={safeToSpend}
        series={series}
        nameOf={nameOf}
      />

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
