// SPDX-License-Identifier: MIT
/**
 * *'a 25-hour-old price marks the holding STALE'* — the dispatch's exit test,
 * stated at the level it actually matters: the **holding**.
 *
 * 07 §6.1: *"if last price > 24h old, mark the holding STALE and exclude from
 * 'as of now' deltas."* The rule is about a position on a screen, not about a
 * row in a table, and the consequence it names is a consequence for a *number
 * the user is shown*. `src/prices.test.ts` proves the rule; this file proves
 * the consequence reaches the thing 07 §6.1 talks about.
 *
 * Why 25 hours and not 24: the boundary has to fall somewhere, and "older than
 * 24h" is the reading that leaves a price taken at yesterday's close still
 * fresh at today's. 25 hours is unambiguously past it.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  createPriceReader,
  inMemoryPriceStore,
  priceStalenessOf,
  type PriceRecord,
} from '../src/prices.ts';

const USER = '01920000-0000-7000-8000-000000000001';
const APPLE = '01920000-0000-7000-8000-0000000000aa';
const ETHER = '01920000-0000-7000-8000-0000000000bb';
const NOW = new Date('2026-09-21T12:00:00.000Z');

/** A holding as a screen would render it: a quantity and whatever price we have. */
interface HoldingView {
  readonly securityId: string;
  readonly quantity: string;
  readonly close: string | null;
  readonly status: 'PRICED' | 'STALE' | 'UNPRICED';
  readonly countsTowardAsOfNowDelta: boolean;
}

function record(partial: Partial<PriceRecord> = {}): PriceRecord {
  return {
    securityId: APPLE,
    priceDate: '2026-09-21',
    close: '232.3500000000',
    currency: 'USD',
    source: 'tiingo',
    stale: false,
    observedAt: NOW,
    ...partial,
  };
}

/**
 * The composition every net-worth or holdings screen performs.
 *
 * Deliberately tiny and written here rather than imported: the claim under test
 * is that `PricePoint` carries *enough* for a caller to mark a holding STALE
 * without re-deriving the 24-hour rule. If it did not, this function could not
 * be written without a clock of its own.
 */
async function viewOf(
  securityId: string,
  quantity: string,
  records: readonly PriceRecord[],
  kind = 'equity',
  now: Date = NOW,
): Promise<HoldingView> {
  const reader = createPriceReader({
    store: inMemoryPriceStore(records),
    userId: USER,
    kindOf: () => Promise.resolve(kind),
    clock: fixedClock(now),
  });
  const point = await reader.price(securityId, '2026-09-21', 'USD');
  if (point === null) {
    return {
      securityId,
      quantity,
      close: null,
      status: 'UNPRICED',
      countsTowardAsOfNowDelta: false,
    };
  }
  return {
    securityId,
    quantity,
    close: point.close,
    status: point.staleness === 'STALE' ? 'STALE' : 'PRICED',
    countsTowardAsOfNowDelta: point.includeInAsOfNowDeltas,
  };
}

describe('holding staleness', () => {
  it('a 25-hour-old price marks the holding STALE', async () => {
    const observedAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const view = await viewOf(APPLE, '10', [record({ observedAt })]);

    expect(view.status).toBe('STALE');
    // 07 §6.1's second half, which is the part that changes a number on screen:
    // the holding is excluded from "as of now" deltas. A delta computed from a
    // 25-hour-old price measures the passage of time, not a change in value.
    expect(view.countsTowardAsOfNowDelta).toBe(false);
    // The price is still *shown*. 08 §3.7 seals net worth with the last known
    // price flagged `stale_price` — excluding it from the balance entirely
    // would understate net worth, which is a worse lie than a stale number.
    expect(view.close).toBe('232.3500000000');
  });

  it('a 23-hour-old price does not', async () => {
    const view = await viewOf(APPLE, '10', [
      record({ observedAt: new Date(NOW.getTime() - 23 * 60 * 60 * 1000) }),
    ]);
    expect(view.status).toBe('PRICED');
    expect(view.countsTowardAsOfNowDelta).toBe(true);
  });

  it('staleness is per holding, not per portfolio', async () => {
    // A crypto position refreshed an hour ago and an equity nobody could price
    // since Friday are two different facts. Marking the whole portfolio stale
    // because one row is would train the user to ignore the flag.
    const fresh = await viewOf(
      ETHER,
      '2.5',
      [
        record({
          securityId: ETHER,
          source: 'coingecko',
          close: '3421.5500000000',
          observedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        }),
      ],
      'crypto',
    );
    const stale = await viewOf(APPLE, '10', [
      record({ observedAt: new Date(NOW.getTime() - 49 * 60 * 60 * 1000) }),
    ]);

    expect(fresh.status).toBe('PRICED');
    expect(stale.status).toBe('STALE');
  });

  it('a holding with no price at all is UNPRICED, not STALE', async () => {
    // Three states, not two. "We have never had a price for this" and "our
    // price is old" call for different words on screen and different fixes.
    const view = await viewOf(APPLE, '10', []);
    expect(view.status).toBe('UNPRICED');
    expect(view.close).toBeNull();
    expect(view.countsTowardAsOfNowDelta).toBe(false);
  });

  it('a carried-forward price goes stale on the clock like any other', async () => {
    // A Friday close read on Monday is both carried forward *and* stale, and
    // the two flags are independent: the carry-forward is about which day the
    // observation belongs to, staleness about how long ago we learned it.
    const friday = new Date('2026-09-18T20:00:00.000Z');
    const view = await viewOf(APPLE, '10', [
      record({ priceDate: '2026-09-18', observedAt: friday }),
    ]);
    expect(view.status).toBe('STALE');
    expect(priceStalenessOf(friday, NOW)).toBe('STALE');
  });

  it('SABOTAGE: raising the threshold past 25 hours hides the stale holding', async () => {
    // The negative control. A 48-hour threshold — the plausible "fix" for a
    // dashboard that shows too many stale badges — would report this holding
    // as priced and let it into an as-of-now delta.
    const observedAt = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const sabotaged = NOW.getTime() - observedAt.getTime() > 48 * 60 * 60 * 1000;
    expect(sabotaged).toBe(false); // the sabotage reports FRESH

    // The real rule does not.
    expect(priceStalenessOf(observedAt, NOW)).toBe('STALE');
    expect((await viewOf(APPLE, '10', [record({ observedAt })])).status).toBe('STALE');
  });
});
