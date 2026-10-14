// SPDX-License-Identifier: MIT
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { MarketDataKeyCard } from './MarketDataKeyCard.tsx';
import {
  MARKET_DATA_KEY_PROVIDERS,
  marketDataProviderName,
  useMarketDataCredentialsQueries,
} from './credentials-api.ts';

/**
 * Settings › Market data › API keys (WP 10.4): one card per provider whose key a holder can store - Tiingo,
 * FRED, CoinGecko and OpenFIGI - beside the provider list `MarketDataSettingsScreen` already shows.
 *
 * The operator's secret files still win: a provider whose file supplies a key is shown read-only. A card whose
 * status cannot be read says so on its own; the other three still work.
 */
export function MarketDataKeysSection() {
  const queries = useMarketDataCredentialsQueries();

  return (
    <section aria-labelledby="market-data-keys-heading" data-testid="market-data-keys">
      <h2 id="market-data-keys-heading" className="text-h3 text-text-primary">
        API keys
      </h2>
      <p className="mt-1 text-small text-text-muted">
        Add your own key for a provider here, or have the person who runs this install put it in the
        secrets directory — a key in the secrets directory wins and is shown read-only. Saving or
        removing a key asks for your passkey.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {MARKET_DATA_KEY_PROVIDERS.map((provider, index) => {
          const query = queries[index];
          if (query === undefined || query.isLoading) {
            return <SkeletonText key={provider} lines={3} />;
          }
          if (query.data === undefined) {
            return (
              <section
                key={provider}
                aria-label={marketDataProviderName(provider)}
                className="rounded-md border border-border-hairline p-4"
              >
                <h3 className="font-medium text-text-primary">
                  {marketDataProviderName(provider)}
                </h3>
                <p className="mt-1 text-small text-text-secondary">
                  Where this key comes from cannot be read right now. Try again in a moment.
                </p>
              </section>
            );
          }
          return <MarketDataKeyCard key={provider} status={query.data} />;
        })}
      </div>
    </section>
  );
}
