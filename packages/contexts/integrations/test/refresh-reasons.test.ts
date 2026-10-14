// SPDX-License-Identifier: MIT
/**
 * WP 10.5 — the refresh says why, and the two adapters look back for the
 * latest close instead of asking about a day that has none.
 *
 * Every unpriced security carries a reason (`unpriced`), every FX pair that was
 * planned and not fetched is named (`fxUnfetched`, including "no FRED key",
 * which used to be a silent `break`), and the per-provider tallies the run
 * records are returned. Tiingo's window is the week ending on the day asked
 * about and FRED's two weeks, still one request each, so a Saturday, a holiday
 * or a pre-close 03:45 prices from the last session rather than `no_data`.
 */
import { fixedClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { createFakePriceSource, createFakeTransport, jsonResponse } from '../src/adapters/fake.ts';
import { createFredSource, FRED_LOOKBACK_DAYS } from '../src/adapters/fred.ts';
import { createTiingoPriceSource, TIINGO_LOOKBACK_DAYS } from '../src/adapters/tiingo.ts';
import { policyFor } from '../src/egress.ts';
import { createProviderClient } from '../src/http.ts';
import {
  createPriceRefreshJob,
  inMemoryMarketDataWriter,
  inMemoryRunRecorder,
  type RefreshPlan,
} from '../src/market-data.ts';
import { apiKeyOf } from '../src/secrets.ts';

const NOW = new Date('2026-10-10T07:45:00.000Z'); // a Saturday, 03:45 EDT
const PUBLIC = () => Promise.resolve(['93.184.216.34']);
const KEY = apiKeyOf('x', 'a-long-enough-test-key-000000'); // gitleaks:allow — synthetic
const OUTBOX = {
  execute: () => Promise.resolve({ rows: [{ out_seq: 1, out_recorded_at: NOW }] }),
} as never;

const ID = {
  vti: '01920000-0000-7000-8000-000000000001',
  btc: '01920000-0000-7000-8000-000000000002',
  bond: '01920000-0000-7000-8000-000000000003',
  euf: '01920000-0000-7000-8000-000000000004',
} as const;

const PLAN: RefreshPlan = {
  asOfDate: '2026-10-10',
  securities: [
    {
      securityId: ID.vti,
      kind: 'etf',
      subject: { kind: 'ticker', symbol: 'VTI', mic: null },
      currency: 'USD',
    },
    {
      securityId: ID.btc,
      kind: 'crypto',
      subject: { kind: 'coin_id', coinId: 'bitcoin' },
      currency: 'USD',
    },
    {
      securityId: ID.bond,
      kind: 'bond',
      subject: { kind: 'ticker', symbol: 'XB', mic: null },
      currency: 'USD',
    },
    {
      securityId: ID.euf,
      kind: 'etf',
      subject: { kind: 'ticker', symbol: 'EUF', mic: null },
      currency: 'USD',
    },
  ],
  fxPairs: [{ base: 'EUR', quote: 'USD' }],
};

function job(sources: Parameters<typeof createPriceRefreshJob>[0]['sources']) {
  const writer = inMemoryMarketDataWriter();
  const recorder = inMemoryRunRecorder();
  return {
    writer,
    recorder,
    job: createPriceRefreshJob({
      userId: '01920000-0000-7000-8000-000000000900',
      sources,
      writer,
      recorder,
      outbox: OUTBOX,
      correlationId: '01920000-0000-7000-8000-0000000000c3',
      clock: fixedClock(NOW),
    }),
  };
}

describe('WP 10.5 — the refresh names every security it did not price, and why', () => {
  it('no provider for the kind, no key for the provider, and no data are three different reasons', async () => {
    const { job: run, recorder } = job([
      createFakePriceSource({ provider: 'tiingo', prices: { 'VTI|2026-10-10|USD': '268.40' } }),
    ]);
    const result = await run.run(PLAN);

    expect(result.securitiesPriced).toEqual([ID.vti]);
    expect(result.unpriced).toEqual([
      { securityId: ID.btc, provider: 'coingecko', reason: 'source_not_configured', detail: null },
      { securityId: ID.bond, provider: null, reason: 'no_provider_for_kind', detail: null },
      expect.objectContaining({ securityId: ID.euf, provider: 'tiingo', reason: 'no_data' }),
    ]);
    // Every unpriced id has exactly one reason.
    expect(result.unpriced.map((entry) => entry.securityId).sort()).toEqual(
      [...result.securitiesUnpriced].sort(),
    );
    // No FRED source: the pair is named, not silently skipped.
    expect(result.fxUnfetched).toEqual([
      { base: 'EUR', quote: 'USD', reason: 'source_not_configured', detail: null },
    ]);
    // The tallies are the numbers market_data_runs records.
    expect(result.tallies).toEqual([
      {
        provider: 'tiingo',
        operation: 'price_refresh',
        requestsMade: 2,
        symbolsAsked: 2,
        outcome: 'ok',
      },
    ]);
    expect(recorder.runs.map((run) => [run.provider, run.requestsMade])).toEqual([['tiingo', 2]]);
  });

  it('an adapter failure is reported with its own reason and redacted detail', async () => {
    const { job: run } = job([
      createFakePriceSource({
        provider: 'coingecko',
        outcome: { kind: 'rate_limited', retryAfterMs: 60_000, detail: 'budget spent' },
      }),
    ]);
    const result = await run.run({ ...PLAN, securities: PLAN.securities.slice(1, 2), fxPairs: [] });
    expect(result.unpriced).toEqual([
      { securityId: ID.btc, provider: 'coingecko', reason: 'rate_limited', detail: 'budget spent' },
    ]);
  });
});

describe('WP 10.5 — the adapters look back for the latest close', () => {
  it(`Tiingo asks for the ${String(TIINGO_LOOKBACK_DAYS)} days to the date in one request and keeps the latest bar, marked stale`, async () => {
    const fake = createFakeTransport(() =>
      jsonResponse([
        { date: '2026-10-08T00:00:00.000Z', close: 266.1 },
        { date: '2026-10-09T00:00:00.000Z', close: 268.4 },
      ]),
    );
    const source = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: fake.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now: () => NOW,
    });
    const outcome = await source.price({
      subject: { kind: 'ticker', symbol: 'VTI', mic: null },
      date: '2026-10-10',
      currency: 'USD',
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.destination.path).toContain('startDate=2026-10-03');
    expect(fake.requests[0]?.destination.path).toContain('endDate=2026-10-10');
    expect(outcome).toMatchObject({
      kind: 'ok',
      value: { date: '2026-10-09', close: '268.4', stale: true },
    });
  });

  it('Tiingo still answers no_data when the week has no bar, and a bar after the date is never used', async () => {
    const fake = createFakeTransport(() =>
      jsonResponse([{ date: '2026-10-11T00:00:00.000Z', close: 1 }]),
    );
    const source = createTiingoPriceSource({
      client: createProviderClient({
        provider: 'tiingo',
        policy: policyFor('tiingo'),
        transport: fake.transport,
        resolve: PUBLIC,
      }),
      key: KEY,
      now: () => NOW,
    });
    const outcome = await source.price({
      subject: { kind: 'ticker', symbol: 'VTI', mic: null },
      date: '2026-10-10',
      currency: 'USD',
    });
    expect(outcome.kind).toBe('no_data');
  });

  it(`FRED asks for the ${String(FRED_LOOKBACK_DAYS)} days to the date, newest first, and skips a holiday's "."`, async () => {
    const fake = createFakeTransport(() =>
      jsonResponse({
        observations: [
          { date: '2026-10-09', value: '.' },
          { date: '2026-10-08', value: '1.0921' },
        ],
      }),
    );
    const source = createFredSource({
      client: createProviderClient({
        provider: 'fred',
        policy: policyFor('fred'),
        transport: fake.transport,
        resolve: PUBLIC,
        keys: [KEY],
      }),
      key: KEY,
      now: () => NOW,
    });
    const outcome = await source.fxRate('EUR', 'USD', '2026-10-10');
    expect(fake.requests).toHaveLength(1);
    const path = fake.requests[0]?.destination.path ?? '';
    expect(path).toContain('observation_start=2026-09-26');
    expect(path).toContain('observation_end=2026-10-10');
    expect(path).toContain('sort_order=desc');
    expect(outcome).toMatchObject({
      kind: 'ok',
      value: { base: 'EUR', quote: 'USD', date: '2026-10-08', rate: '1.0921' },
    });
  });
});
