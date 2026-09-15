// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getNetWorthOptions,
  listAccountsOptions,
  updateAccountMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

/** `GET /accounts` — closed accounts included so the "closed" section can render them. */
export function useAccountsQuery() {
  return useQuery({
    ...listAccountsOptions({ query: { includeClosed: 'true' } }),
    staleTime: 30_000,
  });
}

/** `GET /net-worth` — per-currency totals plus the audit trail of every account's inclusion. */
export function useNetWorthQuery() {
  return useQuery({ ...getNetWorthOptions(), staleTime: 30_000 });
}

/**
 * `PATCH /accounts/{id}` — the only two writable fields in Phase 1
 * (`includeInNetWorth`, `closed`; wp1.5-api.md §7.3 notes there is no
 * nickname column yet). Invalidates both accounts and net worth: toggling
 * either field changes what `/net-worth` sums.
 */
export function useUpdateAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...updateAccountMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listAccountsOptions().queryKey });
      void queryClient.invalidateQueries({ queryKey: getNetWorthOptions().queryKey });
    },
  });
}
