// SPDX-License-Identifier: MIT
/** Test fixtures for `POST /market-data/refresh` (WP 10.5): the response shape, one field at a time. */
import type { PriceRefreshSummary } from '../../api/generated/types.gen.ts';

type Unpriced = PriceRefreshSummary['unpriced'][number];

export function unpriced(overrides: Partial<Unpriced> = {}): Unpriced {
  return {
    securityId: 'sec_btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    kind: 'crypto',
    provider: 'coingecko',
    reason: 'source_not_configured',
    detail: null,
    ...overrides,
  };
}

export function summary(overrides: Partial<PriceRefreshSummary> = {}): PriceRefreshSummary {
  const unpricedItems = overrides.unpriced ?? [];
  const pricedCount = overrides.counts?.priced ?? 12;
  return {
    asOfDate: '2026-10-14',
    counts: {
      held: pricedCount + unpricedItems.length,
      priceable: pricedCount + unpricedItems.length,
      priced: pricedCount,
      unpriced: unpricedItems.length,
      notPricedByProvider: 0,
    },
    priced: [],
    unpriced: unpricedItems,
    notPricedByProvider: [],
    fx: { rowsWritten: 0, pairs: [] },
    priceRowsWritten: pricedCount,
    requests: [],
    budgets: [],
    nextRefreshAt: '2026-10-14T09:10:00.000Z',
    ...overrides,
  };
}
