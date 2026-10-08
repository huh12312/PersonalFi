// SPDX-License-Identifier: MIT
/**
 * WP 9.14 / P-6: `priceHoldings` — the one function `GET /holdings`,
 * `GET /investments/allocation` and the net-worth seal all price a portfolio
 * through — asks the reader for the whole portfolio at once. It used to await
 * `reader.price` once per security, in sequence: 200 positions were ~2.0 s
 * (`wp9.9-perf.md` §9). The route is exercised against the shipped function with
 * a reader that counts how it was asked, because the property is "one batched
 * read", which a latency assertion on a quiet host cannot pin on a loaded one.
 */
import type { PriceReader } from '@ctx/investments';
import { describe, expect, it } from 'vitest';
import { priceHoldings, type HoldingRead } from '../src/routes/investments.ts';

function read(index: number, securityId: string, accountId = 'acct-1'): HoldingRead {
  return {
    holdingId: `holding-${String(index)}`,
    accountId,
    securityId,
    symbol: `S${String(index)}`,
    name: null,
    securityType: 'etf',
    quantity: '10',
    costBasis: null,
    costBasisSource: null,
    asOfDate: '2026-09-21',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'UNKNOWN',
    expenseRatio: null,
    isCashEquivalent: false,
    classificationSource: 'LOCAL_SEED_TABLE',
    overridden: [],
  } as HoldingRead;
}

describe('priceHoldings reads the portfolio in one batch', () => {
  it('asks for every distinct security once, in a single priceMany call, and never one by one', async () => {
    const calls = { price: 0, priceMany: [] as string[][] };
    const reader: PriceReader = {
      price: () => {
        calls.price += 1;
        return Promise.resolve(null);
      },
      priceMany: (securityIds) => {
        calls.priceMany.push([...securityIds]);
        return Promise.resolve(new Map(securityIds.map((id) => [id, null])));
      },
    };
    // 200 holdings over 150 securities: the same ETF in two accounts is one price.
    const reads = Array.from({ length: 200 }, (_, index) =>
      read(index, `sec-${String(index % 150)}`, index % 2 === 0 ? 'acct-1' : 'acct-2'),
    );

    const priced = await priceHoldings(reads, reader, '2026-09-21');

    expect(calls.price, 'no per-security ladder walk').toBe(0);
    expect(calls.priceMany).toHaveLength(1);
    expect(calls.priceMany[0]).toHaveLength(150);
    expect(new Set(calls.priceMany[0]).size).toBe(150);
    expect(priced.holdings).toHaveLength(200);
    // A security with no price still yields a holding, STALE with no price: the
    // batch changed how the prices are fetched, not what an unpriced one means.
    expect(priced.holdings[0]).toMatchObject({ price: null, staleness: 'STALE' });
  });
});
