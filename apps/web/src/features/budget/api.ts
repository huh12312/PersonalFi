// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createBudgetLineMutation,
  getCurrentBudgetPeriodOptions,
  listBudgetPeriodsOptions,
  rollBudgetPeriodMutation,
  updateBudgetLineMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

/**
 * `GET /budgets/current` — lazily opens the default budget/period on the
 * server the first time anyone asks (`wp2.r-routes.md` §1's own note); this
 * screen never has to special-case "no budget exists yet" against a 404,
 * only "the period it opened has zero lines yet" (`BudgetScreen.tsx`'s empty
 * state).
 */
export function useCurrentBudgetPeriodQuery() {
  return useQuery({ ...getCurrentBudgetPeriodOptions(), staleTime: 10_000 });
}

/** `GET /budgets/periods` — the period picker's history list (summaries only; see `PeriodPicker.tsx`'s module comment for why no route returns another period's lines). */
export function useBudgetPeriodsQuery(budgetId: string | undefined) {
  return useQuery({
    ...listBudgetPeriodsOptions({ query: { budgetId: budgetId ?? '' } }),
    enabled: budgetId !== undefined,
    staleTime: 10_000,
  });
}

function invalidateBudget(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: getCurrentBudgetPeriodOptions().queryKey });
  // `listBudgetPeriodsOptions` requires a `budgetId` we may not have handy at
  // every call site, and the generated key format is `[{ _id, ...params }]`
  // (`createQueryKey` above) rather than a `['id', params]` tuple — a partial
  // key of `[{ _id: '...' }]` still matches every `query.budgetId` variant
  // because TanStack's partial-match only checks the keys present in the
  // filter object, not the ones it omits.
  void queryClient.invalidateQueries({ queryKey: [{ _id: 'listBudgetPeriods' }] });
}

/** `POST /budgets/lines` — create (or re-open) one category's envelope in the current period. */
export function useCreateBudgetLineMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...createBudgetLineMutation(),
    onSuccess: () => invalidateBudget(queryClient),
  });
}

/**
 * `PATCH /budgets/lines/{id}` — both halves (`wp2.r-routes.md` §4): assign an
 * amount, or edit the goal/rollover-policy/priority/class. Every write
 * recomputes the dirty cascade server-side, so invalidating and refetching
 * `GET /budgets/current` is the only way the screen's `available`/RTA ever
 * reflect the edit — there is no optimistic local recompute of envelope math
 * in this screen (the evidence promise: "no client-side money math beyond
 * formatting").
 */
export function useUpdateBudgetLineMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...updateBudgetLineMutation(),
    onSuccess: () => invalidateBudget(queryClient),
  });
}

/** `POST /budgets/periods/roll` — closes the given period and opens the next one. */
export function useRollBudgetPeriodMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...rollBudgetPeriodMutation(),
    onSuccess: () => invalidateBudget(queryClient),
  });
}
