// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import {
  clearAccountOverridesMutation,
  getAccountValuationOptions,
  getNetWorthOptions,
  listAccountsOptions,
  setAccountOverridesMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

/**
 * `GET /accounts/valuation` — which accounts net worth leaves out (never as a
 * zero) and which it counts at the holder's typed balance (O-2).
 */
export function useAccountValuationQuery() {
  return useQuery({ ...getAccountValuationOptions(), staleTime: 30_000 });
}

/** Everything an override can change: the accounts, the valuation lists, net worth, and the plan. */
function invalidateOverrideDependents(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: listAccountsOptions().queryKey });
  void queryClient.invalidateQueries({ queryKey: getAccountValuationOptions().queryKey });
  void queryClient.invalidateQueries({ queryKey: getNetWorthOptions().queryKey });
  // The plan's projection is keyed `[{ _id: 'runPlanProjection', … }]` (`plan/api.ts`).
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0] as { _id?: unknown } | undefined;
      return head?._id === 'runPlanProjection';
    },
  });
}

/** `PUT /accounts/{id}/overrides` — session only, no step-up: no money moves. */
export function useSetAccountOverridesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...setAccountOverridesMutation(),
    onSuccess: () => invalidateOverrideDependents(queryClient),
  });
}

/** `DELETE /accounts/{id}/overrides` — back to the provider's defaults. */
export function useClearAccountOverridesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...clearAccountOverridesMutation(),
    onSuccess: () => invalidateOverrideDependents(queryClient),
  });
}
