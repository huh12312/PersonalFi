// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getMarketDataSettingsOptions,
  putMarketDataPriorityMutation,
  testMarketDataFetchMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Attribution } from '../../api/generated/types.gen.ts';

/** `GET /market-data/settings` — provider key presence, budgets, priority ladders, attribution. */
export function useMarketDataSettingsQuery() {
  return useQuery({ ...getMarketDataSettingsOptions(), staleTime: 30_000 });
}

/** `PUT /market-data/priority` — step-up gated (it decides which provider's number becomes the price of everything the user owns). */
export function useSetMarketDataPriorityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...putMarketDataPriorityMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: getMarketDataSettingsOptions().queryKey }),
  });
}

/** `POST /market-data/test-fetch` — step-up gated; the one route here that leaves the machine and spends a real provider budget. */
export function useTestMarketDataFetchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...testMarketDataFetchMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: getMarketDataSettingsOptions().queryKey }),
  });
}

/**
 * The CoinGecko attribution, sourced from `GET /market-data/settings` rather
 * than duplicated — this is the "any_price" obligation every crypto-price
 * screen must render. `undefined` while loading or if the provider isn't in
 * the response yet (a deployment with no key still registers the provider
 * row per `wp3.9-routes.md`, but a caller should not assume that).
 */
export function useCoinGeckoAttribution(): Attribution | undefined {
  const settingsQuery = useMarketDataSettingsQuery();
  return settingsQuery.data?.providers.find((provider) => provider.provider === 'coingecko')
    ?.attribution;
}
