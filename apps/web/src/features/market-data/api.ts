// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteMarketDataConsentMutation,
  getMarketDataSettingsOptions,
  putMarketDataConsentMutation,
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
 * A provider's attribution, sourced from `GET /market-data/settings` rather
 * than duplicated — the "any_price" obligation every screen showing a price
 * from that provider must render. `undefined` while loading or if the
 * provider isn't in the response.
 */
export function useProviderAttribution(provider: string): Attribution | undefined {
  const settingsQuery = useMarketDataSettingsQuery();
  return settingsQuery.data?.providers.find((row) => row.provider === provider)?.attribution;
}

/** The CoinGecko attribution (see {@link useProviderAttribution}); behaviour unchanged. */
export function useCoinGeckoAttribution(): Attribution | undefined {
  return useProviderAttribution('coingecko');
}

/** `PUT /market-data/providers/yfinance/consent` — step-up gated; records the holder's consent to the Yahoo Finance text. */
export function useGiveYahooConsentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...putMarketDataConsentMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: getMarketDataSettingsOptions().queryKey }),
  });
}

/** `DELETE /market-data/providers/yfinance/consent` — step-up gated; the server also removes Yahoo from every ladder. */
export function useWithdrawYahooConsentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...deleteMarketDataConsentMutation(),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: getMarketDataSettingsOptions().queryKey }),
  });
}
