// SPDX-License-Identifier: MIT
/**
 * WP 10.5 — the planner's routing, without a database: what each `PriceSource`
 * is asked by, and the reason when nothing can be asked. The database half
 * (`test/db/wp105-price-refresh.test.ts`) proves the positions read.
 */
import type { PricingPosition } from '@ctx/investments';
import { describe, expect, it } from 'vitest';
import { subjectOf } from '../src/price-refresh.ts';

function position(fields: Partial<PricingPosition>): PricingPosition {
  return {
    securityId: '01920000-0000-7000-8000-000000000001',
    type: 'equity',
    name: null,
    ticker: null,
    mic: null,
    figi: null,
    chain: null,
    contract: null,
    currency: 'USD',
    positionCurrencies: ['USD'],
    accounts: 1,
    ...fields,
  };
}

describe('WP 10.5 — subjectOf', () => {
  it('Tiingo is asked by ticker, with the MIC when the security has one', () => {
    expect(subjectOf(position({ ticker: 'VTI', mic: 'ARCX' }), 'tiingo')).toEqual({
      outcome: 'subject',
      subject: { kind: 'ticker', symbol: 'VTI', mic: 'ARCX' },
    });
  });

  it('an equity with no ticker is named, not dropped', () => {
    expect(subjectOf(position({ name: 'Private Co' }), 'tiingo')).toMatchObject({
      outcome: 'unplannable',
      reason: 'no_ticker',
    });
  });

  it("CoinGecko is asked by coin id: a chain's own coin through WP 3.4's map", () => {
    for (const [chain, coinId] of [
      ['bitcoin', 'bitcoin'],
      ['ethereum', 'ethereum'],
      ['solana', 'solana'],
    ] as const) {
      expect(
        subjectOf(position({ type: 'crypto', chain, contract: 'native' }), 'coingecko'),
      ).toEqual({ outcome: 'subject', subject: { kind: 'coin_id', coinId } });
    }
  });

  it('a token contract, or a ticker alone, is never guessed into a coin id', () => {
    expect(
      subjectOf(
        position({ type: 'crypto', chain: 'ethereum', contract: '0xabc', ticker: 'USDC' }),
        'coingecko',
      ),
    ).toMatchObject({ outcome: 'unplannable', reason: 'no_coin_id' });
    expect(subjectOf(position({ type: 'crypto', ticker: 'ETH' }), 'coingecko')).toMatchObject({
      outcome: 'unplannable',
      reason: 'no_coin_id',
    });
  });
});
