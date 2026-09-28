// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getNetWorthSeriesOptions,
  setManualFxRateMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { type NetWorthRange, windowForRange } from './search.ts';

/** Today, UTC, date-only — matches `apps/api/src/routes/investments.ts`'s `todayFor` shape closely enough for a client-side default window. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `GET /net-worth/series` for one named range. `staleTime` is short: a
 * "Refresh" action (the re-sync affordance in `NetWorthFullView`) should be
 * able to pull a genuinely new response rather than serve a cached one.
 */
export function useNetWorthSeriesQuery(range: NetWorthRange) {
  const { from, to } = windowForRange(range, todayIso());
  return useQuery({
    ...getNetWorthSeriesOptions({ query: { from, to } }),
    staleTime: 10_000,
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
