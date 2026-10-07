// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  answerRiskProfileMutation,
  createGoalContributionMutation,
  createGoalMutation,
  deleteGoalContributionMutation,
  deleteGoalMutation,
  getRiskProfileOptions,
  getRiskProfileQueryKey,
  listGoalContributionsOptions,
  listGoalContributionsQueryKey,
  listGoalsOptions,
  listGoalsQueryKey,
  updateGoalMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

const STALE_TIME_MS = 15_000;

/** `GET /goals` — every goal the holder has, newest facts first as the server orders them. */
export function useGoalsQuery() {
  return useQuery({ ...listGoalsOptions(), staleTime: STALE_TIME_MS });
}

export function useCreateGoalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...createGoalMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: listGoalsQueryKey() }),
  });
}

export function useUpdateGoalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...updateGoalMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: listGoalsQueryKey() }),
  });
}

export function useDeleteGoalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...deleteGoalMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: listGoalsQueryKey() }),
  });
}

/** `GET /goals/{goalId}/contributions` — the plans that fund one goal. Enabled only while the goal's panel is open. */
export function useContributionsQuery(goalId: string, enabled: boolean) {
  return useQuery({
    ...listGoalContributionsOptions({ path: { goalId } }),
    enabled,
    staleTime: STALE_TIME_MS,
  });
}

export function useCreateContributionMutation(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...createGoalContributionMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: listGoalContributionsQueryKey({ path: { goalId } }),
      }),
  });
}

export function useDeleteContributionMutation(goalId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    ...deleteGoalContributionMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: listGoalContributionsQueryKey({ path: { goalId } }),
      }),
  });
}

/** `GET /risk-profile` — the instrument's questions and the holder's current answering, if any. */
export function useRiskProfileQuery() {
  return useQuery({ ...getRiskProfileOptions(), staleTime: STALE_TIME_MS });
}

/**
 * `PUT /risk-profile` — answering is a new fact, never an edit (the table is append-only). Invalidates
 * the read so every screen that shows the profile — this one and the plan's — re-reads it.
 */
export function useAnswerRiskProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...answerRiskProfileMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: getRiskProfileQueryKey() }),
  });
}
