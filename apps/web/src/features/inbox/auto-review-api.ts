// SPDX-License-Identifier: MIT
/**
 * WP 11.2b: the Inbox's "Auto-categorised, unreviewed" section - its rows and its one preference.
 *
 * The rows are the normal transaction list, filtered on the server (`autoReview=true`): the rows an automatic tier
 * placed in the last 30 days that neither a rule nor the holder has since decided. "Looks right" and "Change" are the
 * normal pick (`useTransactionOverlayMutation`), so both teach the learning tiers server-side and the row leaves the
 * section when the list is read again. The preference is the holder's, stored on their account and read back whole.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getInboxPreferencesOptions,
  listTransactionsOptions,
  putInboxPreferencesMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { InboxPreferences } from '../../api/generated/types.gen.ts';

/** One page: the section is bounded, and says so when there is more. */
export const AUTO_REVIEW_LIMIT = 50;

/** `GET /inbox/preferences`. Undefined while loading; `retry: false` so an older api degrades to "shown". */
export function useInboxPreferences() {
  return useQuery({ ...getInboxPreferencesOptions(), staleTime: 60_000, retry: false });
}

/** `PUT /inbox/preferences`, applied to the cache at once and put back if the write fails. */
export function useSetInboxPreferences() {
  const queryClient = useQueryClient();
  const key = getInboxPreferencesOptions().queryKey;
  return useMutation({
    ...putInboxPreferencesMutation(),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InboxPreferences>(key);
      queryClient.setQueryData<InboxPreferences>(key, variables.body);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
    },
  });
}

/** The first page of the review rows. `enabled` follows the preference: a hidden section asks for nothing. */
export function useAutoReviewRows(enabled: boolean) {
  return useQuery({
    ...listTransactionsOptions({ query: { autoReview: 'true', limit: AUTO_REVIEW_LIMIT } }),
    enabled,
  });
}
