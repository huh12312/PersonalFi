// SPDX-License-Identifier: MIT
/**
 * WP 11.6: a local model's display-name suggestion for a merchant the bank sent as noise ("PAYPAL *EBAYINC" ->
 * "Ebay"). Nothing here renames anything on its own: **Accept** is the one write
 * (`POST /merchants/name-suggestions/{id}/accept`, which writes the holder's payee-name overlay on every
 * transaction of the merchant the holder has not renamed - the same overlay a manual rename writes), **Dismiss**
 * records that the name is not wanted. Both are session-only, so no step-up.
 *
 * The list is read **once** for the transactions screen (`useMerchantNameIndex`), and the rows and the detail
 * sheet look their merchant up in it; no row asks the api anything.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query, QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  acceptMerchantNameSuggestionMutation,
  dismissMerchantNameSuggestionMutation,
  listMerchantNameSuggestionsOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type {
  ListMerchantNameSuggestionsResponse,
  MerchantNameAvailability,
  MerchantNameSuggestion,
  Transaction,
} from '../../api/generated/types.gen.ts';

export type { MerchantNameAvailability, MerchantNameSuggestion };
export type MerchantNameUnavailableReason = NonNullable<MerchantNameAvailability['reason']>;

interface GeneratedQueryKeyHead {
  readonly _id?: string;
}

function isQuery(...ids: string[]): (query: Query) => boolean {
  return (query) =>
    ids.includes((query.queryKey[0] as GeneratedQueryKeyHead | undefined)?._id ?? '');
}

/** `GET /merchants/name-suggestions`. `retry: false`: an api without the route degrades to no chips and no notes. */
export function useMerchantNameSuggestionsQuery() {
  return useQuery({
    ...listMerchantNameSuggestionsOptions(),
    staleTime: 30_000,
    retry: false,
  });
}

/** Reads the suggestions again. */
export function invalidateMerchantNameSuggestions(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: isQuery('listMerchantNameSuggestions') });
}

/** Reads every transaction list page and detail again: an accepted name renames rows the cache holds. */
export function invalidateTransactionReads(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: isQuery('listTransactions', 'getTransaction'),
  });
}

/** `POST /merchants/name-suggestions/{id}/accept`, then the transactions and the suggestions are read again. */
export function useAcceptMerchantNameMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...acceptMerchantNameSuggestionMutation(),
    onSettled: () => {
      void invalidateTransactionReads(queryClient);
      void invalidateMerchantNameSuggestions(queryClient);
    },
  });
}

/** `POST /merchants/name-suggestions/{id}/dismiss`, then the suggestions are read again. */
export function useDismissMerchantNameMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...dismissMerchantNameSuggestionMutation(),
    onSettled: () => {
      void invalidateMerchantNameSuggestions(queryClient);
    },
  });
}

/** The list, indexed by merchant for the rows. */
export interface MerchantNameIndex {
  /** `null` until the list has loaded (or when the api has none to give). */
  readonly availability: MerchantNameAvailability | null;
  readonly byMerchant: ReadonlyMap<string, MerchantNameSuggestion>;
  /** Noise merchants not asked about yet. */
  readonly pending: ReadonlySet<string>;
}

export const EMPTY_MERCHANT_NAME_INDEX: MerchantNameIndex = {
  availability: null,
  byMerchant: new Map(),
  pending: new Set(),
};

export function indexMerchantNames(
  data: ListMerchantNameSuggestionsResponse | undefined,
): MerchantNameIndex {
  if (data === undefined) return EMPTY_MERCHANT_NAME_INDEX;
  const byMerchant = new Map<string, MerchantNameSuggestion>();
  for (const item of data.items) {
    if (item.merchantId === null) continue;
    const kept = byMerchant.get(item.merchantId);
    // An open suggestion outranks an accepted one for the same merchant: it is the one still waiting for an answer.
    if (kept === undefined || (kept.status === 'accepted' && item.status === 'suggested')) {
      byMerchant.set(item.merchantId, item);
    }
  }
  return {
    availability: data.availability,
    byMerchant,
    pending: new Set(data.pending.map((entry) => entry.merchantId)),
  };
}

/** The list for the whole transactions screen, indexed. Stable between renders while the data is. */
export function useMerchantNameIndex(): MerchantNameIndex {
  const query = useMerchantNameSuggestionsQuery();
  return useMemo(() => indexMerchantNames(query.data), [query.data]);
}

/**
 * The suggestion a row carries a chip for: its merchant has one (suggested, or accepted - a row that arrived after
 * the accept still reads the bank's text, and Accept applies the name to it), and the row does not already read
 * that name.
 */
export function suggestionFor(
  index: MerchantNameIndex,
  transaction: Pick<Transaction, 'merchantId' | 'name'>,
): MerchantNameSuggestion | null {
  if (transaction.merchantId === null) return null;
  const suggestion = index.byMerchant.get(transaction.merchantId) ?? null;
  if (suggestion === null || transaction.name === suggestion.displayName) return null;
  return suggestion;
}

/**
 * Why nothing is suggested for a row, when its merchant is one the pass has not asked about yet and cannot ask
 * now; otherwise `null` (a merchant that can still be asked about needs no note).
 */
export function unavailableReasonFor(
  index: MerchantNameIndex,
  transaction: Pick<Transaction, 'merchantId'>,
): MerchantNameUnavailableReason | null {
  const availability = index.availability;
  if (availability === null || availability.available) return null;
  if (transaction.merchantId === null || !index.pending.has(transaction.merchantId)) return null;
  return availability.reason ?? 'off';
}
