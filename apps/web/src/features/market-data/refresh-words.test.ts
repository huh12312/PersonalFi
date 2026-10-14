// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { PriceRefreshSummary } from '../../api/generated/types.gen.ts';
import {
  describeRefresh,
  isRefreshTooSoon,
  reasonWords,
  tooSoonWords,
  type RefreshReason,
} from './refresh-words.ts';
import { summary, unpriced } from './refresh-fixtures.ts';

type Unpriced = PriceRefreshSummary['unpriced'][number];

describe('reasonWords (WP 10.5)', () => {
  const cases: [RefreshReason, Unpriced['provider'], string][] = [
    ['source_not_configured', 'coingecko', 'no CoinGecko key'],
    ['source_not_configured', 'tiingo', 'no Tiingo key'],
    ['skipped_no_key', 'tiingo', 'no Tiingo key'],
    ['no_ticker', 'tiingo', 'no ticker'],
    ['no_coin_id', 'coingecko', 'no CoinGecko coin id'],
    ['no_data', 'tiingo', 'Tiingo had no price'],
    ['rate_limited', 'coingecko', 'CoinGecko request budget used up'],
    ['refused', 'tiingo', 'blocked by the egress guard'],
    ['error', 'fred', 'FRED did not answer'],
    ['no_provider_for_kind', null, 'no provider prices this kind'],
  ];
  it.each(cases)('%s from %s reads "%s"', (reason, provider, words) => {
    expect(reasonWords(reason, provider)).toBe(words);
  });

  it('does not invent a provider name when the api names none', () => {
    expect(reasonWords('source_not_configured', null)).toBe('no key for the provider');
    expect(reasonWords('error', null)).toBe('the provider did not answer');
  });
});

describe('describeRefresh (WP 10.5)', () => {
  it('says everything was priced', () => {
    expect(describeRefresh(summary()).text).toBe('Priced 12 of 12.');
  });

  it('names the provider whose key is missing', () => {
    const described = describeRefresh(summary({ unpriced: [unpriced()] }));
    expect(described.headline).toBe('Priced 12 of 13; 1 unpriced: no CoinGecko key.');
  });

  it('groups several reasons with their counts, most common first', () => {
    const described = describeRefresh(
      summary({
        counts: { held: 13, priceable: 13, priced: 10, unpriced: 3, notPricedByProvider: 0 },
        unpriced: [
          unpriced({ securityId: 'a', reason: 'no_ticker', provider: 'tiingo', symbol: null }),
          unpriced({ securityId: 'b' }),
          unpriced({ securityId: 'c', reason: 'skipped_no_key' }),
        ],
      }),
    );
    expect(described.headline).toBe(
      'Priced 10 of 13; 3 unpriced: no CoinGecko key (2), no ticker (1).',
    );
  });

  it('says there was nothing to price when no holding is one a provider prices', () => {
    const described = describeRefresh(
      summary({
        counts: { held: 2, priceable: 0, priced: 0, unpriced: 0, notPricedByProvider: 2 },
      }),
    );
    expect(described.headline).toBe('Nothing to price: no holdings a provider prices.');
    expect(described.notes).toEqual(['2 cash or other holdings are not priced by a provider.']);
  });

  it('mentions holdings no provider prices only when there are some, and in the singular for one', () => {
    expect(describeRefresh(summary()).notes).toEqual([]);
    const one = describeRefresh(
      summary({
        counts: { held: 13, priceable: 12, priced: 12, unpriced: 0, notPricedByProvider: 1 },
      }),
    );
    expect(one.text).toBe('Priced 12 of 12. 1 cash or other holding is not priced by a provider.');
  });

  it('names a failed FX pair and why, and says nothing of one that was fetched', () => {
    const described = describeRefresh(
      summary({
        fx: {
          rowsWritten: 1,
          pairs: [
            {
              base: 'EUR',
              quote: 'USD',
              fetched: false,
              reason: 'source_not_configured',
              detail: null,
            },
            { base: 'GBP', quote: 'USD', fetched: true, reason: null, detail: null },
          ],
        },
      }),
    );
    expect(described.notes).toEqual(['EUR→USD rate not fetched: no FRED key.']);
  });

  it('groups failed FX pairs that failed for the same reason', () => {
    const failed = { fetched: false, reason: 'source_not_configured', detail: null } as const;
    const described = describeRefresh(
      summary({
        fx: {
          rowsWritten: 0,
          pairs: [
            { base: 'EUR', quote: 'USD', ...failed },
            { base: 'GBP', quote: 'USD', ...failed },
          ],
        },
      }),
    );
    expect(described.notes).toEqual(['EUR→USD, GBP→USD rates not fetched: no FRED key.']);
  });

  it('lists each unpriced security by symbol, else name, with its words and detail', () => {
    const described = describeRefresh(
      summary({
        unpriced: [
          unpriced({ detail: 'COINGECKO_API_KEY is not set.' }),
          unpriced({
            securityId: 'sec_x',
            symbol: null,
            name: 'Mystery Fund',
            provider: 'tiingo',
            reason: 'no_data',
          }),
        ],
      }),
    );
    expect(described.unpriced).toEqual([
      {
        securityId: 'sec_btc',
        label: 'BTC',
        words: 'no CoinGecko key',
        detail: 'COINGECKO_API_KEY is not set.',
      },
      { securityId: 'sec_x', label: 'Mystery Fund', words: 'Tiingo had no price', detail: null },
    ]);
  });
});

describe('the 409 (WP 10.5)', () => {
  const problem = {
    code: 'market_data.refresh_too_soon',
    detail:
      'Prices were refreshed less than ten minutes ago. Try again after 2026-10-14T09:10:00.000Z.',
  };

  it('is recognised by its code, and only by it', () => {
    expect(isRefreshTooSoon(problem)).toBe(true);
    expect(isRefreshTooSoon({ code: 'market_data.other' })).toBe(false);
    expect(isRefreshTooSoon(new Error('x'))).toBe(false);
    expect(isRefreshTooSoon(null)).toBe(false);
  });

  it('shows the instant as a local HH:MM', () => {
    const local = new Date('2026-10-14T09:10:00.000Z').toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    expect(tooSoonWords(problem)).toBe(`Prices were refreshed recently. Try again after ${local}.`);
  });

  it('falls back to the detail text when it holds no instant, and to plain words without a detail', () => {
    expect(tooSoonWords({ detail: 'Try again later.' })).toBe(
      'Prices were refreshed recently. Try again later.',
    );
    expect(tooSoonWords({})).toBe('Prices were refreshed recently. Try again in a few minutes.');
  });
});
