// SPDX-License-Identifier: MIT
/**
 * Tiingo — equity, ETF and mutual-fund end-of-day. **D17's default.**
 *
 * 01 §4.3 gives the four reasons, and the first is the one that matters here:
 * *"Its free-tier ToS language ('your own personal use… may not display or
 * share') is an almost exact description of our deployment model — a single
 * self-hoster, own API key, own data."* The consequence is recorded in
 * `attribution.ts` as `redistribution: 'forbidden'`, and it is the reason a
 * future "share my portfolio" feature has to consult that field before it
 * ships. Tiingo requires no badge; it requires that the numbers stay here.
 *
 * ## Endpoint
 *
 * `GET /tiingo/daily/{ticker}/prices?startDate=&endDate=` returns an array of
 * daily bars. We ask for exactly one day and read `close` — **not** `adjClose`.
 * That is a deliberate choice with a reason: adjusted closes are rewritten
 * retroactively every time a split or dividend happens, so a chart built from
 * them silently changes shape months later, which is exactly the "a past net
 * worth changes" failure the Phase 3 risk table calls out. Corporate actions
 * are WP 3.2's job, applied forward to quantity and basis; the price series
 * stays as-traded.
 *
 * ## Key handling
 *
 * `Authorization: Token <key>`. Tiingo also accepts `?token=`, and we
 * deliberately do not use it: a key in a query string reaches access logs,
 * `Referer` headers and error bodies. See `secrets.ts` for why FRED is the one
 * provider that leaves us no choice.
 *
 * ## Budget
 *
 * 50 requests/hour **and** 1,000/day, both enforced client-side before the
 * socket opens (`TIINGO_WINDOWS`). `test/rate-limit.test.ts` → *'the Tiingo
 * adapter refuses its own 1,001st call of a day rather than being refused'*.
 */
import { ATTRIBUTIONS } from '../attribution.ts';
import { arrayOf, decimalAt, plainDecimal, stringAt } from '../json.ts';
import type { ProviderClient } from '../http.ts';
import { createRateBudget, TIINGO_WINDOWS, type RateBudget } from '../rate-limit.ts';
import type { ApiKey } from '../secrets.ts';
import {
  unsupported,
  type FxQuote,
  type PriceRequest,
  type PriceSource,
  type PriceQuote,
  type SearchHit,
  type SourceOutcome,
} from '../price-source.ts';
import { budgetReport, callJson, isIsoDate, type CallContext } from './common.ts';

export interface TiingoOptions {
  readonly client: ProviderClient;
  readonly key: ApiKey;
  readonly now: () => Date;
  /** Injected so a restart can be primed from `market_data_runs`. */
  readonly budget?: RateBudget;
}

export function createTiingoPriceSource(options: TiingoOptions): PriceSource {
  const budget = options.budget ?? createRateBudget(TIINGO_WINDOWS);
  const context: CallContext = {
    client: options.client,
    key: options.key,
    budget,
    now: options.now,
  };
  const attribution = ATTRIBUTIONS.tiingo;

  return {
    provider: 'tiingo',
    attribution,
    hasKey: options.key.present,
    capabilities: { prices: true, fx: false, macro: false, search: true },
    budget: (now) => budgetReport(budget, now),

    async price(request: PriceRequest): Promise<SourceOutcome<PriceQuote>> {
      if (request.subject.kind !== 'ticker') {
        return {
          kind: 'no_data',
          detail: `tiingo prices securities by ticker; asked for a ${request.subject.kind}`,
        };
      }
      if (!isIsoDate(request.date)) {
        return { kind: 'error', detail: `${request.date} is not a YYYY-MM-DD date` };
      }
      // Tiingo quotes US securities in USD. A request for another currency is
      // answered `no_data` rather than converted: converting here would hide an
      // FX rate inside a price, and D4 requires the rate to be stored and dated
      // on its own.
      if (request.currency !== 'USD') {
        return {
          kind: 'no_data',
          detail: `tiingo quotes in USD; ${request.currency} would require an FX conversion, ` +
            'which belongs in fx_rates with its own date (D4)',
        };
      }

      const symbol = encodeURIComponent(request.subject.symbol.toLowerCase());
      const call = await callJson(context, {
        method: 'GET',
        path: `/tiingo/daily/${symbol}/prices`,
        query: { startDate: request.date, endDate: request.date, format: 'json' },
        headers: { authorization: `Token ${options.key.reveal()}` },
      });
      if (!call.ok) return call.outcome;

      const bars = arrayOf(call.body);
      if (bars === null) {
        return { kind: 'error', detail: 'tiingo answered something other than an array of bars' };
      }
      const bar = bars[0];
      if (bar === undefined) {
        // A market holiday, a delisting, or a symbol Tiingo does not carry.
        // All three are "no close for that day", which is a fact, not a fault.
        return {
          kind: 'no_data',
          detail: `tiingo has no bar for ${request.subject.symbol} on ${request.date}`,
        };
      }
      const close = decimalAt(bar, 'close');
      if (close === null) {
        return { kind: 'error', detail: 'tiingo bar carried no usable close' };
      }
      // The date Tiingo stamped the bar with, which is the authority on whether
      // this is the day we asked for. An ISO instant; we keep the calendar day.
      const barDate = (stringAt(bar, 'date') ?? request.date).slice(0, 10);

      return {
        kind: 'ok',
        value: {
          subject: request.subject,
          date: barDate,
          close: plainDecimal(close),
          currency: 'USD',
          provider: 'tiingo',
          // Tiingo answered for a different day than we asked about: it served
          // the nearest bar, which is a carry-forward, and the row says so.
          stale: barDate !== request.date,
          observedAt: options.now(),
          attribution,
        },
      };
    },

    fxRate(): Promise<SourceOutcome<FxQuote>> {
      // Tiingo's free tier has no FX endpoint. FRED is the FX source (D17), and
      // saying so is 08 §2.6's "degrade honestly" rather than throwing.
      return Promise.resolve(unsupported<FxQuote>('tiingo', 'FX rates on the free tier'));
    },

    async search(symbol: string): Promise<SourceOutcome<readonly SearchHit[]>> {
      const call = await callJson(context, {
        method: 'GET',
        path: '/tiingo/utilities/search',
        query: { query: symbol },
        headers: { authorization: `Token ${options.key.reveal()}` },
      });
      if (!call.ok) return call.outcome;
      const rows = arrayOf(call.body);
      if (rows === null) return { kind: 'error', detail: 'tiingo search answered no array' };
      const hits: SearchHit[] = [];
      for (const row of rows) {
        const ticker = stringAt(row, 'ticker');
        if (ticker === null) continue;
        hits.push({
          symbol: ticker,
          name: stringAt(row, 'name'),
          kind: stringAt(row, 'assetType'),
          provider: 'tiingo',
        });
      }
      return { kind: 'ok', value: hits };
    },
  };
}
