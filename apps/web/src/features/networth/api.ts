// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  dismissNetWorthMilestonesMutation,
  getNetWorthSeriesOptions,
  listNetWorthMilestonesOptions,
  setManualFxRateMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { BUCKETING_FOR_PERIOD } from './stacked.ts';
import {
  PERIOD_FOR_RANGE,
  type DashboardPeriod,
  type NetWorthRange,
  windowForPeriod,
} from './search.ts';

/** Today, UTC, date-only — matches `apps/api/src/routes/investments.ts`'s `todayFor` shape closely enough for a client-side default window. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `GET /net-worth/series` for the full view's URL range — the same request as the dashboard period it maps to
 * (`PERIOD_FOR_RANGE`), buckets included. `staleTime` is short: a "Refresh" action (the re-sync affordance in
 * `NetWorthFullView`) should be able to pull a genuinely new response rather than serve a cached one.
 */
export function useNetWorthSeriesQuery(range: NetWorthRange) {
  return useNetWorthSeriesPeriodQuery(PERIOD_FOR_RANGE[range]);
}

/**
 * `GET /net-worth/series` for one dashboard period (WP 10.9), with the period's buckets by account type
 * (WP 10.13: by day for 1M, by week for 3M and 6M, by month for 1Y and All). The widget's hero, its chart and
 * the full view at the same period are one request.
 */
export function useNetWorthSeriesPeriodQuery(period: DashboardPeriod) {
  const { from, to } = windowForPeriod(period, todayIso());
  return useQuery({
    ...getNetWorthSeriesOptions({ query: { from, to, bucket: BUCKETING_FOR_PERIOD[period] } }),
    staleTime: 10_000,
  });
}

/** `GET /net-worth/milestones` (WP 10.13): round figures crossed and not yet dismissed, newest first. */
export function useNetWorthMilestonesQuery() {
  return useQuery({ ...listNetWorthMilestonesOptions(), staleTime: 60_000 });
}

/** `POST /net-worth/milestones/dismiss` — remembered on the server; the notice never returns. */
export function useDismissNetWorthMilestonesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...dismissNetWorthMilestonesMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listNetWorthMilestonesOptions().queryKey });
    },
  });
}

/**
 * `POST /net-worth/fx-rates` — 08 §6.6's manual-entry affordance (C-9,
 * G3-12): the form `NetWorthFullView` shows when `lastSnapshotFailure` names
 * a missing rate. Invalidates every `GET /net-worth/series` query (not just
 * the caller's own range) so a re-fetched window picks up the new rate on
 * the very next scheduled or manually retried snapshot, whichever range the
 * user is looking at.
 */
export function useSetManualFxRateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...setManualFxRateMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getNetWorthSeriesOptions().queryKey });
    },
  });
}
