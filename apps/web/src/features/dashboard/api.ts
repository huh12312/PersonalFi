// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getDashboardLayoutOptions,
  getDashboardLayoutQueryKey,
  getSpendingPaceOptions,
  putDashboardLayoutMutation,
  resetDashboardLayoutMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { DashboardLayout } from '../../api/generated/types.gen.ts';
import type { LayoutEntry } from './layout.ts';

/** `GET /reports/spending-pace` for the current month (the server decides "current", in the holder's zone). */
export function useSpendingPaceQuery() {
  return useQuery({ ...getSpendingPaceOptions(), staleTime: 30_000 });
}

/** `GET /dashboard/layout`. */
export function useDashboardLayoutQuery() {
  return useQuery({ ...getDashboardLayoutOptions(), staleTime: 60_000 });
}

/**
 * `PUT /dashboard/layout`, applied to the cache first so the grid moves as the holder presses, and put back from
 * the server's answer (or the previous layout, if the save fails).
 */
export function useSaveDashboardLayout() {
  const queryClient = useQueryClient();
  const key = getDashboardLayoutQueryKey();
  return useMutation({
    ...putDashboardLayoutMutation(),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DashboardLayout>(key);
      queryClient.setQueryData<DashboardLayout>(key, {
        widgets: [...variables.body.widgets],
        customised: true,
      });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      const previous = (context as { previous?: DashboardLayout } | undefined)?.previous;
      if (previous !== undefined) queryClient.setQueryData(key, previous);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
    },
  });
}

/** `DELETE /dashboard/layout` — the default order, everything shown. */
export function useResetDashboardLayout() {
  const queryClient = useQueryClient();
  const key = getDashboardLayoutQueryKey();
  return useMutation({
    ...resetDashboardLayoutMutation(),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
    },
  });
}

export function toWire(layout: readonly LayoutEntry[]): { widgets: LayoutEntry[] } {
  return { widgets: layout.map((entry) => ({ id: entry.id, visible: entry.visible })) };
}
