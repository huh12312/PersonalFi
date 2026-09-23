// SPDX-License-Identifier: MIT
/**
 * 07 §6.1's ladder and its two structural rules.
 *
 *   * *'a carry-forward is a label, never a written row'* — because a
 *     carry-forward written back as an observation would be found by tomorrow's
 *     refresh, carried forward again, and within a week the chart would be a
 *     flat line made of one real print. 07 §6.1: *"never recompute history from
 *     today's price."*
 *   * *'a price older than 24 h is STALE and excluded from as-of-now deltas'* —
 *     computed against the clock at read time, because staleness is a
 *     statement about *now* and a stored boolean is correct for a day and
 *     then silently wrong forever.
 *
 * The ladder itself is walked rung by rung below, one price answered by each,
 * which is what the evidence doc records.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LADDERS,
  PRICE_STALE_AFTER_MS,
  createPriceReader,
  inMemoryPriceStore,
  ladderRows,
  priceStalenessOf,
  type PriceRecord,
} from './prices.ts';
import type { PriceSourceName } from '../schema/index.ts';

const USER = '01920000-0000-7000-8000-000000000001';
const SECURITY = '01920000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-09-21T12:00:00.000Z');

function record(partial: Partial<PriceRecord> = {}): PriceRecord {
  return {
    securityId: SECURITY,
    priceDate: '2026-09-21',
    close: '232.3500000000',
    currency: 'USD',
    source: 'tiingo',
    stale: false,
    observedAt: new Date('2026-09-21T03:45:00.000Z'),
    ...partial,
  };
}

function readerOver(
  records: readonly PriceRecord[],
  kind = 'equity',
  ladders: Readonly<Record<string, readonly PriceSourceName[]>> = {},
) {
  return createPriceReader({
    store: inMemoryPriceStore(records, ladders),
    userId: USER,
    kindOf: () => Promise.resolve(kind),
    clock: fixedClock(NOW),
  });
}

describe('the price ladder (07 §6.1)', () => {
  it('walks user override > exchange fill > provider > last known', async () => {
    // One price answered by each rung, strongest first, by removing the rung
    // above it each time. This is the walk the evidence records.
    const all: readonly PriceRecord[] = [
      record({ source: 'user_override', close: '250.0000000000' }),
      record({ source: 'exchange_fill', close: '240.0000000000' }),
      record({ source: 'tiingo', close: '232.3500000000' }),
    ];

    // Rung 1 — the user looked at the position and disagreed.
    expect((await readerOver(all).price(SECURITY, '2026-09-21', 'USD'))?.rung).toBe(
      'user_override',
    );
    expect((await readerOver(all).price(SECURITY, '2026-09-21', 'USD'))?.close).toBe(
      '250.0000000000',
    );

    // Rung 2 — a price we actually paid. Not an estimate of anything.
    const noOverride = all.filter((r) => r.source !== 'user_override');
    expect((await readerOver(noOverride).price(SECURITY, '2026-09-21', 'USD'))?.rung).toBe(
      'exchange_fill',
    );

    // Rung 3 — the provider, in D17's order.
    const providerOnly = all.filter((r) => r.source === 'tiingo');
    const fromProvider = await readerOver(providerOnly).price(SECURITY, '2026-09-21', 'USD');
    expect(fromProvider?.rung).toBe('tiingo');
    expect(fromProvider?.carriedForward).toBe(false);

    // Rung 4 — nothing for today, so yesterday's print is carried forward and
    // labelled.
    const yesterdayOnly = [record({ priceDate: '2026-09-18', close: '230.0000000000' })];
    const carried = await readerOver(yesterdayOnly).price(SECURITY, '2026-09-21', 'USD');
    expect(carried?.rung).toBe('last_known');
    expect(carried?.carriedForward).toBe(true);
    expect(carried?.priceDate).toBe('2026-09-18');
    expect(carried?.close).toBe('230.0000000000');
  });

  it('a carry-forward is a label, never a written row', async () => {
    // The structural rule. `last_known` is not a member of `prices.source`'s
    // CHECK, so the database refuses it; the in-memory store enforces the same
    // thing so a unit test cannot pass on a row Postgres would reject.
    const store = inMemoryPriceStore([]);
    expect(() => store.put(record({ source: 'last_known' as never }))).toThrow(
      /prices_source_is_an_observation/,
    );

    // And the carry-forward that *is* produced carries the source of the row
    // it came from, so the provenance is not lost by labelling it.
    const carried = await readerOver([record({ priceDate: '2026-09-18', source: 'tiingo' })]).price(
      SECURITY,
      '2026-09-21',
      'USD',
    );
    expect(carried?.rung).toBe('last_known');
    expect(carried?.source).toBe('tiingo');
  });

  it('crypto goes to CoinGecko and equities to Tiingo (D17)', async () => {
    // The ladder is per security kind, which is why it is rows rather than an
    // ORDER BY: a token's ladder ends at CoinGecko, an ETF's at Tiingo.
    const crypto = await readerOver(
      [record({ source: 'coingecko', close: '3421.5500000000' })],
      'crypto',
    ).price(SECURITY, '2026-09-21', 'USD');
    expect(crypto?.rung).toBe('coingecko');

    // A Tiingo row does not answer for a crypto holding: `tiingo` is not on
    // the crypto ladder at all, so it falls through to `last_known` — and with
    // nothing earlier, to null.
    const wrongSource = await readerOver([record({ source: 'tiingo' })], 'crypto').price(
      SECURITY,
      '2026-09-21',
      'USD',
    );
    expect(wrongSource).toBeNull();

    expect(DEFAULT_LADDERS['crypto']).toContain('coingecko');
    expect(DEFAULT_LADDERS['equity']).toContain('tiingo');
    expect(DEFAULT_LADDERS['equity']).not.toContain('coingecko');
  });

  it('a user-edited ladder overrides the default', async () => {
    // §6 of the dispatch makes the ladder user-editable. A user who disables
    // the provider rung gets the carry-forward rather than the quote.
    const records = [
      record({ priceDate: '2026-09-18', close: '230.0000000000' }),
      record({ source: 'tiingo', close: '232.3500000000' }),
    ];
    const edited = await readerOver(records, 'equity', {
      equity: ['user_override', 'last_known'],
    }).price(SECURITY, '2026-09-21', 'USD');

    expect(edited?.rung).toBe('last_known');
    expect(edited?.close).toBe('230.0000000000');
  });

  it('returns null when no rung can answer', async () => {
    // Different from a missing FX rate, which throws. A security with no price
    // yet is an ordinary state on a fresh install and 08 §3.7's net-worth seal
    // has to render "no price" rather than fail.
    expect(await readerOver([]).price(SECURITY, '2026-09-21', 'USD')).toBeNull();
    // A different currency is a different question, not a conversion.
    expect(await readerOver([record()]).price(SECURITY, '2026-09-21', 'EUR')).toBeNull();
  });

  it('the ladder rows pin the two rungs the migration CHECKs', () => {
    const rows = ladderRows(USER, 'equity', DEFAULT_LADDERS['equity'] ?? []);
    // `price_source_priority_override_is_first` and
    // `..._last_known_is_last`. An override that is not first is not an
    // override; a carry-forward that is not last would shadow a real quote.
    expect(rows.find((r) => r.source === 'user_override')?.rung).toBe(1);
    expect(rows.find((r) => r.source === 'last_known')?.rung).toBe(99);
    // One source per rung within a kind: a ladder with two second places is
    // not a ladder.
    expect(new Set(rows.map((r) => r.rung)).size).toBe(rows.length);
  });
});

describe('staleness (07 §6.1)', () => {
  it('a price older than 24 h is STALE and excluded from as-of-now deltas', async () => {
    // 25 hours before `NOW`.
    const stale = await readerOver([
      record({ observedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }),
    ]).price(SECURITY, '2026-09-21', 'USD');

    expect(stale?.staleness).toBe('STALE');
    // The consequence, computed once here rather than re-derived by five
    // callers: a stale price may still be displayed and may still seal a
    // net-worth snapshot (08 §3.7, flagged `stale_price`), but it may not
    // contribute to an "as of now" delta — the delta would be measuring the
    // passage of time rather than a change in value.
    expect(stale?.includeInAsOfNowDeltas).toBe(false);

    const fresh = await readerOver([
      record({ observedAt: new Date(NOW.getTime() - 60 * 60 * 1000) }),
    ]).price(SECURITY, '2026-09-21', 'USD');
    expect(fresh?.staleness).toBe('FRESH');
    expect(fresh?.includeInAsOfNowDeltas).toBe(true);
  });

  it('the boundary is *older than* 24 hours, not 24 hours', () => {
    const exactly = new Date(NOW.getTime() - PRICE_STALE_AFTER_MS);
    expect(priceStalenessOf(exactly, NOW)).toBe('FRESH');
    expect(priceStalenessOf(new Date(exactly.getTime() - 1), NOW)).toBe('STALE');
  });

  it('staleness is computed against the clock, not read from a column', async () => {
    // The same row, two different "now"s. A stored boolean could not do this,
    // which is exactly why it is not stored.
    const row = record({ observedAt: new Date('2026-09-21T03:45:00.000Z') });

    const soon = createPriceReader({
      store: inMemoryPriceStore([row]),
      userId: USER,
      kindOf: () => Promise.resolve('equity'),
      clock: fixedClock('2026-09-21T12:00:00.000Z'),
    });
    const later = createPriceReader({
      store: inMemoryPriceStore([row]),
      userId: USER,
      kindOf: () => Promise.resolve('equity'),
      clock: fixedClock('2026-09-23T12:00:00.000Z'),
    });

    expect((await soon.price(SECURITY, '2026-09-21', 'USD'))?.staleness).toBe('FRESH');
    expect((await later.price(SECURITY, '2026-09-21', 'USD'))?.staleness).toBe('STALE');
  });

  it('the provider carry-forward flag is not the 24-hour rule', async () => {
    // `prices.stale` is a narrower, different fact: the *provider* served a
    // carry-forward rather than a close for the day asked about. A fresh row
    // can carry it; a stale row need not. Conflating them would mean a market
    // holiday looked like an outage.
    const point = await readerOver([record({ stale: true })]).price(SECURITY, '2026-09-21', 'USD');
    expect(point?.providerCarriedForward).toBe(true);
    expect(point?.staleness).toBe('FRESH');
    expect(point?.includeInAsOfNowDeltas).toBe(true);
  });

  it('a clock skew into the future is FRESH, not an error', () => {
    // Policing clocks is not this function's job, and treating skew as
    // staleness would hide prices that had just arrived.
    expect(priceStalenessOf(new Date(NOW.getTime() + 60_000), NOW)).toBe('FRESH');
  });

  it('SABOTAGE: a stored staleness boolean goes wrong the next day', async () => {
    // The negative control for "computed, not stored". A boolean written at
    // insert time reads as authoritative forever; the computed rule flips
    // exactly when it should.
    const observedAt = new Date('2026-09-21T03:45:00.000Z');
    const storedFlagWrittenAtInsert = false; // "fresh", as of insert time

    const twoDaysLater = new Date('2026-09-23T12:00:00.000Z');
    // The stored flag still says fresh, 56 hours on.
    expect(storedFlagWrittenAtInsert).toBe(false);
    // The computed rule does not.
    expect(priceStalenessOf(observedAt, twoDaysLater)).toBe('STALE');
  });
});
