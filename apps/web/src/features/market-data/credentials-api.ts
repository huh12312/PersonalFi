// SPDX-License-Identifier: MIT
/**
 * `/market-data/providers/{provider}/credentials` (WP 10.4): a holder's own market-data keys, kept by the
 * product - the market-data twin of `features/connections/plaid-credentials-api.ts`.
 *
 * **Nothing here can hold a key in a response**: `MarketDataCredentialsStatus` has no field for one, only the
 * last four characters (`keyHint`). The key travels once, in the `PUT` body; the form clears it from its own
 * state before the request is sent, and the mutation is built with `gcTime: 0` so TanStack Query's mutation
 * cache does not keep the variables (the key) around once the form calls `reset()`.
 */
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';

import {
  deleteMarketDataCredentialsMutation,
  getMarketDataCredentialsOptions,
  getMarketDataSettingsOptions,
  putMarketDataCredentialsMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { MarketDataCredentialsStatus } from '../../api/generated/types.gen.ts';

export type MarketDataKeyProvider = MarketDataCredentialsStatus['provider'];

/** The four providers a key can be stored for, in the order the cards are shown. */
export const MARKET_DATA_KEY_PROVIDERS: readonly MarketDataKeyProvider[] = [
  'tiingo',
  'fred',
  'coingecko',
  'openfigi',
];

const PROVIDER_NAMES: Readonly<Record<MarketDataKeyProvider, string>> = {
  tiingo: 'Tiingo',
  fred: 'FRED',
  coingecko: 'CoinGecko',
  openfigi: 'OpenFIGI',
};

export function marketDataProviderName(provider: MarketDataKeyProvider): string {
  return PROVIDER_NAMES[provider];
}

/** The api's own rule for a key (`[A-Za-z0-9_-]`, 16 to 256 characters), checked before anything is sent. */
export const MARKET_DATA_KEY_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;

function statusOptions(provider: MarketDataKeyProvider) {
  return getMarketDataCredentialsOptions({ path: { provider } });
}

/**
 * `GET` for every provider at once. `retry: false`: an api that does not answer this route (an older build
 * during an upgrade) degrades to a card that says so, not a spinner that retries.
 */
export function useMarketDataCredentialsQueries() {
  return useQueries({
    queries: MARKET_DATA_KEY_PROVIDERS.map((provider) => ({
      ...statusOptions(provider),
      staleTime: 30_000,
      retry: false,
    })),
  });
}

/**
 * The status changes, and so does `GET /market-data/settings` (`keyPresent`, `keySource`). The response is
 * the GET shape, so it is written straight into the cache first: the card shows the new state without waiting
 * for the refetch.
 */
function useApplyChange(provider: MarketDataKeyProvider) {
  const queryClient = useQueryClient();
  return async (status: MarketDataCredentialsStatus) => {
    queryClient.setQueryData(statusOptions(provider).queryKey, status);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: statusOptions(provider).queryKey }),
      queryClient.invalidateQueries({ queryKey: getMarketDataSettingsOptions().queryKey }),
    ]);
  };
}

/** `PUT` - step-up gated; the api checks the key with the provider before storing it. */
export function useSaveMarketDataKeyMutation(provider: MarketDataKeyProvider) {
  const apply = useApplyChange(provider);
  return useMutation({
    ...putMarketDataCredentialsMutation(),
    gcTime: 0,
    onSuccess: apply,
  });
}

/** `DELETE` - step-up gated; revokes nothing at the provider. */
export function useRemoveMarketDataKeyMutation(provider: MarketDataKeyProvider) {
  const apply = useApplyChange(provider);
  return useMutation({
    ...deleteMarketDataCredentialsMutation(),
    gcTime: 0,
    onSuccess: apply,
  });
}

/** The api's `detail` (plain words, fixed copy that never repeats a key), or `fallback`. */
export function problemDetail(cause: unknown, fallback: string): string {
  if (typeof cause === 'object' && cause !== null && 'detail' in cause) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return fallback;
}
