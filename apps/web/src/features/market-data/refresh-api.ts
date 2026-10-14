// SPDX-License-Identifier: MIT
/**
 * `POST /market-data/refresh` (WP 10.5): fetch prices for what the holder holds now, instead of waiting for the
 * nightly run. Session only - no step-up, no body.
 *
 * A refresh writes price rows, so every screen that shows a price is stale the moment it succeeds: the holdings
 * (all of them and per account), allocation, drift, performance, net worth and the provider budgets in
 * Settings are invalidated, whichever parameters they were last read with.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  getAllocationQueryKey,
  getDriftQueryKey,
  getMarketDataSettingsQueryKey,
  getNetWorthQueryKey,
  getNetWorthSeriesQueryKey,
  getPerformanceByManagementQueryKey,
  getPerformanceQueryKey,
  listAccountHoldingsQueryKey,
  listHoldingsQueryKey,
  refreshMarketDataMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { problemDetail } from './credentials-api.ts';
import { describeRefresh, isRefreshTooSoon, tooSoonWords } from './refresh-words.ts';
import type { RefreshDescription } from './refresh-words.ts';

/** The generated query ids whose cached answers depend on prices. Matched on id alone, not on parameters. */
const PRICE_DEPENDENT_IDS: ReadonlySet<string> = new Set([
  listHoldingsQueryKey()[0]._id,
  listAccountHoldingsQueryKey({ path: { accountId: '' } })[0]._id,
  getAllocationQueryKey()[0]._id,
  getDriftQueryKey()[0]._id,
  getPerformanceQueryKey({ query: { from: '' } })[0]._id,
  getPerformanceByManagementQueryKey({ query: { from: '' } })[0]._id,
  getNetWorthQueryKey()[0]._id,
  getNetWorthSeriesQueryKey()[0]._id,
  getMarketDataSettingsQueryKey()[0]._id,
]);

export function useRefreshPricesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...refreshMarketDataMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const head: unknown = query.queryKey[0];
          return (
            typeof head === 'object' &&
            head !== null &&
            '_id' in head &&
            typeof head._id === 'string' &&
            PRICE_DEPENDENT_IDS.has(head._id)
          );
        },
      });
    },
  });
}

export type RefreshOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly description: RefreshDescription }
  | { readonly kind: 'too_soon'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

export interface PriceRefresh {
  readonly run: () => void;
  readonly pending: boolean;
  readonly outcome: RefreshOutcome;
}

/** The mutation, and what it did in words - one per place that offers the button, so each keeps its own result. */
export function useRefreshPrices(): PriceRefresh {
  const mutation = useRefreshPricesMutation();
  let outcome: RefreshOutcome = { kind: 'idle' };
  if (mutation.isPending) outcome = { kind: 'pending' };
  else if (mutation.isSuccess)
    outcome = { kind: 'done', description: describeRefresh(mutation.data) };
  else if (mutation.isError) {
    outcome = isRefreshTooSoon(mutation.error)
      ? { kind: 'too_soon', text: tooSoonWords(mutation.error) }
      : { kind: 'error', text: problemDetail(mutation.error, 'Could not refresh prices.') };
  }
  return { run: () => mutation.mutate({}), pending: mutation.isPending, outcome };
}
