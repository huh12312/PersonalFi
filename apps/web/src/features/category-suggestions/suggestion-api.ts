// SPDX-License-Identifier: MIT
/**
 * WP 11.2: a language model's category suggestion for a transaction the six deterministic tiers abstained on, and
 * Settings › Language model › Category suggestions. Nothing here ever files a transaction on its own: **Confirm** is
 * the normal pick (`PATCH /transactions/{id}` through `useTransactionOverlayMutation`, so the list and the Inbox
 * update exactly as a manual pick does, and the pick teaches the learning tiers server-side), **Not this** records
 * a rejection and assigns nothing.
 *
 * Every settings write needs a fresh session (the passkey step-up, `useStepUpRetry`) and answers with the whole
 * settings shape, which is written straight into the cache.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query, QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  approveCategorySuggestionPayloadMutation,
  getCategorySuggestionSettingsOptions,
  listCategoryExplanationsOptions,
  measureCategorySuggestionsMutation,
  previewCategorySuggestionPayloadOptions,
  rejectCategorySuggestionMutation,
  setCategorySuggestionHostedConsentMutation,
  setCategorySuggestionModelMutation,
  setCategorySuggestionsEnabledMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type {
  CategoryExplanation,
  CategorySuggestionEval,
  CategorySuggestionPreview,
  CategorySuggestionSettings,
} from '../../api/generated/types.gen.ts';

export type { CategoryExplanation, CategorySuggestionEval, CategorySuggestionPreview };
export type SuggestionSettings = CategorySuggestionSettings;
export type SuggestionModel = SuggestionSettings['models'][number];
export type SuggestionModelChoice = SuggestionSettings['modelChoice'];
export type CategorySuggestion = NonNullable<CategoryExplanation['suggestion']>;

/** `GET /transactions/explanations` takes at most this many ids. */
export const MAX_EXPLANATION_IDS = 200;

interface GeneratedQueryKeyHead {
  readonly _id?: string;
}

function isQuery(id: string): (query: Query) => boolean {
  return (query) => (query.queryKey[0] as GeneratedQueryKeyHead | undefined)?._id === id;
}

/** Every cached explanations batch, whatever ids it was asked for. */
export function invalidateExplanations(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: isQuery('listCategoryExplanations') });
}

/**
 * The server's explanation for each of `transactionIds` — **one** batched `GET /transactions/explanations`, keyed
 * by transaction id (WP 11.1's `useInboxExplanations`, moved here so the transaction list shares it). At most
 * `MAX_EXPLANATION_IDS` ids, in a stable order; the previous batch stays in place while a new set loads.
 */
export function useCategoryExplanations(
  transactionIds: readonly string[],
): ReadonlyMap<string, CategoryExplanation> {
  const ids = useMemo(
    () => [...new Set(transactionIds)].sort().slice(0, MAX_EXPLANATION_IDS),
    [transactionIds],
  );
  const query = useQuery({
    ...listCategoryExplanationsOptions({ query: { ids: ids.join(',') } }),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  return useMemo(
    () => new Map((query.data?.items ?? []).map((item) => [item.transactionId, item])),
    [query.data],
  );
}

/** The model's suggestion on an explanation, or `null` (an api that predates WP 11.2 sends none). */
export function suggestionOf(
  explanation: CategoryExplanation | undefined,
): CategorySuggestion | null {
  return explanation?.suggestion ?? null;
}

/** `POST /transactions/{id}/suggestion/reject` ("Not this"), then every explanations batch is read again. */
export function useRejectSuggestionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...rejectCategorySuggestionMutation(),
    onSuccess: () => invalidateExplanations(queryClient),
  });
}

const settingsOptions = () => getCategorySuggestionSettingsOptions();

/** While a measurement runs the settings are read every 2 s (`refetchInterval`), and not otherwise. */
export const MEASURE_POLL_MS = 2_000;
/** A measurement that has not reported back after this long is said to be late, and the polling stops. */
export const MEASURE_GIVE_UP_MS = 10 * 60_000;

/** `GET /categories/suggestions/settings`. `retry: false`: an api without the route degrades to a sentence. */
export function useSuggestionSettingsQuery(polling: boolean) {
  return useQuery({
    ...settingsOptions(),
    staleTime: 30_000,
    retry: false,
    refetchInterval: polling ? MEASURE_POLL_MS : false,
  });
}

/** `GET /categories/suggestions/preview` — invokes nothing; the exact payload a run would send now. */
export function useSuggestionPreviewQuery(enabled: boolean) {
  return useQuery({ ...previewCategorySuggestionPayloadOptions(), enabled, retry: false });
}

function useApplySettings() {
  const queryClient = useQueryClient();
  return (settings: SuggestionSettings) => {
    queryClient.setQueryData(settingsOptions().queryKey, settings);
  };
}

/** Reads the settings again (after a measurement starts, an approval, or a refused write). */
export function useRefreshSuggestionSettings() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: settingsOptions().queryKey });
}

/** `PUT /categories/suggestions/settings` — step-up. */
export function useSetSuggestionModelMutation() {
  const apply = useApplySettings();
  return useMutation({ ...setCategorySuggestionModelMutation(), gcTime: 0, onSuccess: apply });
}

/** `POST /categories/suggestions/enabled` — step-up; 409 below the gate or with no model. */
export function useSetSuggestionsEnabledMutation() {
  const apply = useApplySettings();
  return useMutation({ ...setCategorySuggestionsEnabledMutation(), gcTime: 0, onSuccess: apply });
}

/** `PUT /categories/suggestions/hosted-consent` — step-up. */
export function useSetSuggestionConsentMutation() {
  const apply = useApplySettings();
  return useMutation({
    ...setCategorySuggestionHostedConsentMutation(),
    gcTime: 0,
    onSuccess: apply,
  });
}

/** `POST /categories/suggestions/measure` — step-up; 202, the result arrives in the settings. */
export function useMeasureSuggestionsMutation() {
  return useMutation({ ...measureCategorySuggestionsMutation(), gcTime: 0 });
}

/** `POST /categories/suggestions/approve` — step-up; 409 `insights.shape_changed`. */
export function useApproveSuggestionPayloadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...approveCategorySuggestionPayloadMutation(),
    gcTime: 0,
    onSettled: async () => {
      await queryClient.invalidateQueries({
        predicate: isQuery('previewCategorySuggestionPayload'),
      });
      await queryClient.invalidateQueries({ queryKey: settingsOptions().queryKey });
    },
  });
}
