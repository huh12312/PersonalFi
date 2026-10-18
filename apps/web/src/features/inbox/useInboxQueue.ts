// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { listTransactionsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import { transferItem, uncategorizedItem, type InboxItem } from './inbox-reducer.ts';
import { findTransferSuggestions } from './transfer-suggestions.ts';

export const TRANSFER_POOL_LIMIT = 200;
export const UNCATEGORIZED_LIMIT = 50;

/**
 * The review inbox's queue (moved out of `InboxScreen.tsx` by WP 10.9, unchanged, so the dashboard's "To review"
 * widget counts exactly the items the inbox shows rather than a second definition of "needs review"): the
 * uncategorised transactions and the client-computed transfer-pair suggestions, a suggested leg never also offered
 * as an uncategorised row.
 *
 * `truncated` is true when the uncategorised read hit its page limit, so a count is "at least" — said, not hidden.
 */
export function useInboxQueue(): {
  readonly items: InboxItem[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly truncated: boolean;
} {
  const uncategorizedQuery = useQuery(
    listTransactionsOptions({ query: { uncategorized: 'true', limit: UNCATEGORIZED_LIMIT } }),
  );
  const poolQuery = useQuery(
    listTransactionsOptions({ query: { transfers: 'exclude', limit: TRANSFER_POOL_LIMIT } }),
  );

  const items = useMemo<InboxItem[]>(() => {
    const rawSuggestions = findTransferSuggestions(poolQuery.data?.items ?? []);
    const suggestions = rawSuggestions.map((s) => transferItem(s.outflow, s.inflow));
    // A transaction offered as one leg of a transfer suggestion is not also
    // offered as a plain "needs a category" row — a transfer is not spend,
    // and showing both would ask the user to resolve the same two rows
    // twice in two different ways.
    const suggestedIds = new Set(rawSuggestions.flatMap((s) => [s.outflow.id, s.inflow.id]));
    const uncategorized = (uncategorizedQuery.data?.items ?? [])
      .filter((t) => !suggestedIds.has(t.id))
      .map(uncategorizedItem);
    return [...suggestions, ...uncategorized];
  }, [poolQuery.data, uncategorizedQuery.data]);

  return {
    items,
    isLoading: uncategorizedQuery.isLoading || poolQuery.isLoading,
    isError: uncategorizedQuery.isError || poolQuery.isError,
    truncated: (uncategorizedQuery.data?.nextCursor ?? null) !== null,
  };
}
