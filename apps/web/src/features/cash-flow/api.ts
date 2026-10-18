// SPDX-License-Identifier: MIT
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { getCashFlowOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Timeframe } from './view.ts';

/**
 * `GET /reports/cash-flow` for one timeframe and period (`null` = the period today is in, decided by the server in
 * the holder's zone). Stepping keeps the previous period on screen while the next one loads (dataviz: no skeleton
 * flash on a refetch), and the screen dims it.
 */
export function useCashFlowQuery(timeframe: Timeframe, period: string | null) {
  return useQuery({
    ...getCashFlowOptions({
      query: { timeframe, ...(period === null ? {} : { period }) },
    }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
