// SPDX-License-Identifier: MIT
/**
 * Market-data keys a holder stored in the product (WP 10.4), the market-data
 * twin of `plaid-stored.ts`.
 *
 * Two ways in, one precedence — the same as Plaid's:
 *
 * 1. **The operator's secret files** (`tiingo_api_key`, `fred_api_key`,
 *    `coingecko_api_key`, `openfigi_api_key`). A non-empty file wins, per
 *    provider; the product shows it read-only and refuses to store a second key.
 * 2. **The holder's stored key** (`provider_credentials`, sealed under the KEK),
 *    for any provider whose file is empty. `createMarketDataRuntime(...).forUser`
 *    reads it through the port this file builds, caches the resulting view for
 *    30 s and drops it on `invalidate()`; the worker's
 *    `connections.ProviderCredentialsChanged` consumer calls that. No restart.
 *
 * This is the one place a stored market-data key is turned into bytes outside
 * the adapters that carry it. It is never logged (the log lines name the
 * provider only), never put in an error, never returned by a route.
 *
 * ## The validation call
 *
 * A `PUT` is checked against the provider before anything is sealed, with one
 * cheap live call **through the existing adapter** — so it inherits the
 * one-host egress policy, the timeout, the redaction and a rate budget; no new
 * host is reachable from here:
 *
 * | provider  | call                                               |
 * | --------- | -------------------------------------------------- |
 * | tiingo    | one end-of-day row (`SPY`, today)                  |
 * | coingecko | one simple price (`bitcoin`, today)                |
 * | fred      | one series observation (the USD/EUR FX series)     |
 * | openfigi  | a one-job mapping (Apple's ISIN)                   |
 *
 * An answer — even "no data for that day" — proves the key authenticated. An
 * HTTP 400, 401 or 403 is the provider refusing the key (FRED answers 400 for
 * an unregistered key; the other three 401/403). Anything else — a timeout, a
 * 5xx, the egress guard — is "could not check", and nothing is stored either way.
 */
import { redact } from '@core/config';
import type { Database } from '@core/db';
import { DateOnly, type Clock } from '@core/kernel';
import type { HttpTransport, PlatformLogger, Resolver } from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import { openMarketDataKeys } from '@ctx/connections';
import type { SourceOutcome } from '@ctx/integrations';
import {
  createMarketDataRuntime,
  type MarketDataKeyedProvider,
  type StoredMarketDataKeys,
} from './domain.ts';

/**
 * The port `createMarketDataRuntime` reads stored keys through. A locked box
 * answers "no stored keys" (the operator's view stands); a row that will not
 * open is named by provider in a warning and left out.
 */
export function createStoredMarketDataKeys(options: {
  readonly database: Database;
  /** Resolved fresh on every read: the api's box exists only after unlock. */
  readonly secretBox: () => SecretBox | undefined;
  readonly logger?: PlatformLogger;
}): StoredMarketDataKeys {
  return async (userId) => {
    const box = options.secretBox();
    if (box === undefined) return new Map();
    const { keys, unopenable } = await openMarketDataKeys(options.database, box, userId);
    if (unopenable.length > 0) {
      options.logger?.warn(
        { providers: unopenable },
        'stored market-data keys could not be opened; those providers fall back to the files or to none',
      );
    }
    return keys;
  };
}

export type KeyValidation =
  | { readonly verdict: 'accepted' }
  /** The provider refused the key. `status` is the HTTP status it answered. */
  | { readonly verdict: 'rejected'; readonly status: number }
  /** The provider could not be asked, or did not answer usefully. Nothing is stored. */
  | { readonly verdict: 'unavailable' }
  /** `MARKET_DATA_ALLOWED_HOSTS` excludes the provider's host: no call can be made. */
  | { readonly verdict: 'narrowed_out' };

/** An adapter's `error` detail for an HTTP refusal begins `HTTP <status>:` (`common.ts`). */
const REJECTING_STATUS = /^HTTP (400|401|403)\b/u;

function verdictOf(outcome: SourceOutcome<unknown>): KeyValidation {
  switch (outcome.kind) {
    case 'ok':
    case 'no_data':
      return { verdict: 'accepted' };
    case 'error': {
      const match = REJECTING_STATUS.exec(outcome.detail);
      return match === null
        ? { verdict: 'unavailable' }
        : { verdict: 'rejected', status: Number(match[1]) };
    }
    case 'skipped_no_key':
    case 'rate_limited':
    case 'refused':
      return { verdict: 'unavailable' };
  }
}

/**
 * One cheap authenticated call with `key` for `provider`, through a runtime
 * that holds this key and nothing else (no files, no store), so the answer is
 * about this key alone. Never throws for a provider failure; never puts the key
 * anywhere but the adapter that sends it.
 */
export async function validateMarketDataKey(options: {
  readonly provider: MarketDataKeyedProvider;
  readonly key: string;
  readonly allowedHosts: readonly string[];
  readonly clock: Clock;
  readonly transport?: HttpTransport;
  readonly resolve?: Resolver;
}): Promise<KeyValidation> {
  const secret = redact(options.key);
  const runtime = createMarketDataRuntime({
    secrets: {
      tiingo_api_key: options.provider === 'tiingo' ? secret : undefined,
      fred_api_key: options.provider === 'fred' ? secret : undefined,
      coingecko_api_key: options.provider === 'coingecko' ? secret : undefined,
      openfigi_api_key: options.provider === 'openfigi' ? secret : undefined,
    },
    allowedHosts: options.allowedHosts,
    clock: options.clock,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
  });
  const date = DateOnly.addDays(DateOnly.parse(options.clock.now().toISOString().slice(0, 10)), -1);

  if (options.provider === 'openfigi') {
    if (runtime.figi === undefined) return { verdict: 'narrowed_out' };
    const [outcome] = await runtime.figi.map([
      { idType: 'ID_ISIN', idValue: 'US0378331005', micCode: null },
    ]);
    if (outcome === undefined) return { verdict: 'unavailable' };
    if (outcome.status !== 'error') return { verdict: 'accepted' };
    return verdictOf({ kind: 'error', detail: outcome.message });
  }

  const source = runtime.sources.find((candidate) => candidate.provider === options.provider);
  if (source === undefined) return { verdict: 'narrowed_out' };
  switch (options.provider) {
    case 'tiingo':
      return verdictOf(
        await source.price({
          subject: { kind: 'ticker', symbol: 'SPY', mic: null },
          date,
          currency: 'USD',
        }),
      );
    case 'coingecko':
      return verdictOf(
        await source.price({
          subject: { kind: 'coin_id', coinId: 'bitcoin' },
          date,
          currency: 'USD',
        }),
      );
    case 'fred':
      return verdictOf(await source.fxRate('USD', 'EUR', date));
  }
}
