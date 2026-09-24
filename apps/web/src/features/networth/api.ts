// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';

import { getNetWorthSeriesOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
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
