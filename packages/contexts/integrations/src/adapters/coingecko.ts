// SPDX-License-Identifier: MIT
/**
 * CoinGecko Demo — crypto prices, **with a licence condition attached**.
 *
 * 01 §3.6, as a recommendation with a warning inside it: *"CoinGecko Demo. 10k
 * credits/month is enormous for daily revaluation of one person's holdings.
 * Budget the attribution UI element from the start — it's a hard license
 * condition, not a courtesy."*
 *
 * Every quote this adapter returns carries `ATTRIBUTIONS.coingecko`, whose
 * `required` is `true`, whose `text` is *"Data provided by CoinGecko"*, and
 * whose `logoRequired` is `true`. That is not decoration on the response: it is
 * how a screen three packages away can know it owes an obligation it was never
 * told about in prose. `test/attribution.test.ts` → *'the CoinGecko read model
 * carries the attribution requirement'* is this side of that seam; WP 3.12's
 * e2e assertion on the rendered page is the other.
 *
 * ## Endpoint, and why the dated one
 *
 * `GET /api/v3/coins/{id}/history?date=DD-MM-YYYY` returns the snapshot **at
 * UTC 00:00 on that day**, which is exactly 07 §6.1's reporting convention:
 * *"UTC 00:00 daily close for all historical charts (mixed timezones across
 * exchanges otherwise produce phantom volatility in the net-worth chart)."*
 * `/simple/price` would be cheaper and would answer "now", which is a different
 * question and produces a chart that wobbles for reasons that are not the
 * market.
 *
 * Note the date format: `DD-MM-YYYY`, not ISO. Getting this backwards silently
 * returns the price from a *different day* whenever both components are ≤ 12,
 * which is a bug that hides for two thirds of the month. `coinGeckoDate` is
 * exported and tested on its own for that reason.
 *
 * ## Identity, not symbols
 *
 * CoinGecko keys on a coin *id* ("ethereum"), not a ticker. That is a feature:
 * a ticker is not an identity (WP 3.1's whole argument), and there are at least
 * four tokens trading as "ETH". `CHAIN_NATIVE_COIN_IDS` maps the native assets
 * WP 3.1 already normalises; anything else needs a `coin_id` the resolver
 * supplied, and asking by bare ticker answers `no_data` rather than guessing.
 */
import { ATTRIBUTIONS } from '../attribution.ts';
import { decimalAt, plainDecimal, recordOf } from '../json.ts';
import type { ProviderClient } from '../http.ts';
import { COINGECKO_WINDOWS, createRateBudget, type RateBudget } from '../rate-limit.ts';
import type { ApiKey } from '../secrets.ts';
import {
  unsupported,
  type FxQuote,
  type PriceQuote,
  type PriceRequest,
  type PriceSource,
  type PriceSubject,
  type SearchHit,
  type SourceOutcome,
} from '../price-source.ts';
import { budgetReport, callJson, isIsoDate, type CallContext } from './common.ts';

/**
 * The chains WP 3.1's `NATIVE_ASSETS` knows, mapped to CoinGecko's coin ids.
 *
 * Only native assets. A token contract needs a lookup we do not have offline,
 * and inventing one from a symbol is how ETH-the-asset and ETH-the-wrapper end
 * up sharing a price.
 */
export const CHAIN_NATIVE_COIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  bitcoin: 'bitcoin',
  ethereum: 'ethereum',
  solana: 'solana',
});

/**
 * `YYYY-MM-DD` → CoinGecko's `DD-MM-YYYY`.
 *
 * Exported because it is the kind of function that is either right or silently
 * wrong for two thirds of every month, and a test on it is cheaper than the bug.
 */
export function coinGeckoDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  if (year === undefined || month === undefined || day === undefined) {
    throw new TypeError(`${isoDate} is not a YYYY-MM-DD date`);
  }
  return `${day}-${month}-${year}`;
}

export interface CoinGeckoOptions {
  readonly client: ProviderClient;
  readonly key: ApiKey;
  readonly now: () => Date;
  readonly budget?: RateBudget;
}

export function createCoinGeckoPriceSource(options: CoinGeckoOptions): PriceSource {
  const budget = options.budget ?? createRateBudget(COINGECKO_WINDOWS);
  const context: CallContext = {
    client: options.client,
    key: options.key,
    budget,
    now: options.now,
  };
  const attribution = ATTRIBUTIONS.coingecko;

  function coinIdOf(subject: PriceSubject): string | null {
    if (subject.kind === 'coin_id') return subject.coinId;
    if (subject.kind === 'chain_contract' && subject.contract === 'native') {
      // `contract = 'native'` is WP 3.1's sentinel for a chain's own coin.
      return CHAIN_NATIVE_COIN_IDS[subject.chain] ?? null;
    }
    return null;
  }

  return {
    provider: 'coingecko',
    attribution,
    hasKey: options.key.present,
    capabilities: { prices: true, fx: false, macro: false, search: true },
    budget: (now) => budgetReport(budget, now),

    async price(request: PriceRequest): Promise<SourceOutcome<PriceQuote>> {
      const coinId = coinIdOf(request.subject);
      if (coinId === null) {
        return {
          kind: 'no_data',
          detail:
            'coingecko prices by coin id. A bare ticker is not an identity — there are several ' +
            'assets trading as "ETH" — so the resolver must supply the id (WP 3.1).',
        };
      }
      if (!isIsoDate(request.date)) {
        return { kind: 'error', detail: `${request.date} is not a YYYY-MM-DD date` };
      }

      const call = await callJson(context, {
        method: 'GET',
        path: `/api/v3/coins/${encodeURIComponent(coinId)}/history`,
        query: { date: coinGeckoDate(request.date), localization: 'false' },
        headers: { 'x-cg-demo-api-key': options.key.reveal() },
      });
      if (!call.ok) return call.outcome;

      const marketData = recordOf(recordOf(call.body)?.['market_data']);
      if (marketData === null) {
        // CoinGecko answers 200 with no `market_data` for a date before the
        // coin existed. That is "no price", not an error.
        return {
          kind: 'no_data',
          detail: `coingecko has no market data for ${coinId} on ${request.date}`,
        };
      }
      const currency = request.currency.toLowerCase();
      const close = decimalAt(recordOf(marketData['current_price']), currency);
      if (close === null) {
        return {
          kind: 'no_data',
          detail: `coingecko does not quote ${coinId} in ${request.currency}`,
        };
      }

      return {
        kind: 'ok',
        value: {
          subject: request.subject,
          date: request.date,
          close: plainDecimal(close),
          currency: request.currency.toUpperCase(),
          provider: 'coingecko',
          // The `/history` endpoint answers the UTC-00:00 snapshot for the day
          // asked about, so a successful answer is never a carry-forward.
          stale: false,
          observedAt: options.now(),
          attribution,
        },
      };
    },

    fxRate(): Promise<SourceOutcome<FxQuote>> {
      // CoinGecko quotes crypto in fiat, which is not the same as publishing a
      // fiat pair, and using it as an FX source would put a crypto exchange's
      // spread into a currency conversion. FRED is the FX source (D17).
      return Promise.resolve(unsupported<FxQuote>('coingecko', 'fiat FX rates'));
    },

    async search(symbol: string): Promise<SourceOutcome<readonly SearchHit[]>> {
      const call = await callJson(context, {
        method: 'GET',
        path: '/api/v3/search',
        query: { query: symbol },
        headers: { 'x-cg-demo-api-key': options.key.reveal() },
      });
      if (!call.ok) return call.outcome;
      const coins = recordOf(call.body)?.['coins'];
      const rows = Array.isArray(coins) ? coins : [];
      const hits: SearchHit[] = [];
      for (const row of rows) {
        const record = recordOf(row);
        const id = record?.['id'];
        if (typeof id !== 'string') continue;
        const name = record?.['name'];
        hits.push({
          symbol: id,
          name: typeof name === 'string' ? name : null,
          kind: 'crypto',
          provider: 'coingecko',
        });
      }
      return { kind: 'ok', value: hits };
    },
  };
}
