// SPDX-License-Identifier: MIT
/**
 * WP 12.6 — Yahoo Finance through the `yahoo` sidecar, opt-in (D33).
 *
 * Every test here drives the real adapter against a fake **sidecar** — the
 * JSON shapes `docker/yahoo/server.py` answers, with invented numbers and an
 * invented symbol (PFTEST). Nothing here reaches Yahoo, and nothing here could:
 * the adapter has no Yahoo host to dial (`policyFor('yfinance')` throws), and
 * its one transport is the fake below, which records every request that would
 * have left.
 *
 * The four claims, each with a test that fails if the control is removed:
 *   1. **Both halves before every request.** Operator off, or holder consent
 *      missing ⇒ `refused`, and the transport saw nothing.
 *   2. **The api and worker never reach Yahoo.** MARKET_DATA_ALLOWED_HOSTS
 *      names neither query host, the context policy refuses both, and the
 *      only direct-egress constructor for `yfinance` throws.
 *   3. **Budget and 429.** The 61st call of an hour never leaves; a 429 is
 *      `rate_limited` with a growing backoff during which nothing leaves.
 *   4. **Failure is an outcome and every quote is labelled.**
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  guardLocalEndpoint,
  guardUrl,
  type LocalEndpointRequest,
  type LocalEndpointResponse,
} from '@core/platform';
import { fixedClock, mutableClock } from '@core/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTRIBUTIONS } from '../src/attribution.ts';
import { createFakePriceSource } from '../src/adapters/fake.ts';
import {
  createYfinancePriceSource,
  YFINANCE_BACKOFF_BASE_MS,
  YFINANCE_GATE_CODES,
  type YahooSidecarTransport,
} from '../src/adapters/yfinance.ts';
import {
  createMarketDataEgressPolicy,
  MARKET_DATA_ALLOWED_HOSTS,
  NoDirectEgressError,
  baseUrlFor,
  policyFor,
  YAHOO_SIDECAR_ENDPOINT,
  YAHOO_SIDECAR_UPSTREAM_HOSTS,
} from '../src/egress.ts';
import {
  createPriceRefreshJob,
  inMemoryMarketDataWriter,
  inMemoryRunRecorder,
  providersForKind,
  type RefreshPlan,
} from '../src/market-data.ts';
import { createRateBudget, YFINANCE_WINDOWS } from '../src/rate-limit.ts';
import type { PriceSource } from '../src/price-source.ts';

const NOW = new Date('2026-10-30T07:45:00.000Z');
const TICKER = { kind: 'ticker', symbol: 'PFTEST', mic: null } as const;
const QUOTE = { symbol: 'PFTEST', date: '2026-10-29', close: 102.5, currency: 'USD', stale: false };

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A sidecar that answers from a function and records every request that reached it. */
function fakeSidecar(
  answer: (request: LocalEndpointRequest) => Answer = () => ({
    status: 200,
    body: QUOTE,
  }),
): YahooSidecarTransport & { readonly requests: LocalEndpointRequest[] } {
  const requests: LocalEndpointRequest[] = [];
  return {
    requests,
    request(request): Promise<LocalEndpointResponse> {
      requests.push(request);
      const { status, body } = answer(request);
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return Promise.resolve({ status, body: text, bytesRead: text.length, address: '172.30.0.2' });
    },
  };
}

function adapter(
  transport: YahooSidecarTransport,
  overrides: {
    operatorEnabled?: boolean;
    consentHolds?: () => Promise<boolean>;
    now?: () => Date;
  } = {},
): PriceSource {
  return createYfinancePriceSource({
    transport,
    now: overrides.now ?? (() => NOW),
    operatorEnabled: overrides.operatorEnabled ?? true,
    consentHolds: overrides.consentHolds ?? (() => Promise.resolve(true)),
  });
}

const ask = (source: PriceSource, date = '2026-10-29') =>
  source.price({ subject: TICKER, date, currency: 'USD' });

// ---------------------------------------------------------------------------
// 1. The two halves
// ---------------------------------------------------------------------------

describe('yfinance: both halves must hold for a single sidecar request', () => {
  it('with both halves a request leaves, and the quote is labelled', async () => {
    const sidecar = fakeSidecar();
    const outcome = await ask(adapter(sidecar));
    expect(outcome).toMatchObject({
      kind: 'ok',
      value: { date: '2026-10-29', close: '102.5', currency: 'USD', provider: 'yfinance' },
    });
    expect(sidecar.requests).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/quote',
        query: { symbol: 'PFTEST', date: '2026-10-29' },
      }),
    ]);
  });

  it('a request never leaves with the operator half missing', async () => {
    const sidecar = fakeSidecar();
    let consentAsked = 0;
    const source = adapter(sidecar, {
      operatorEnabled: false,
      consentHolds: () => {
        consentAsked += 1;
        return Promise.resolve(true);
      },
    });
    for (const outcome of [
      await ask(source),
      await source.fxRate('EUR', 'USD', '2026-10-29'),
      await source.search('PF'),
    ]) {
      expect(outcome).toMatchObject({ kind: 'refused', code: YFINANCE_GATE_CODES.operator });
    }
    expect(sidecar.requests).toHaveLength(0);
    expect(consentAsked).toBe(0);
  });

  it('a request never leaves with the holder consent missing', async () => {
    const sidecar = fakeSidecar();
    const source = adapter(sidecar, { consentHolds: () => Promise.resolve(false) });
    for (const outcome of [
      await ask(source),
      await source.fxRate('EUR', 'USD', '2026-10-29'),
      await source.search('PF'),
    ]) {
      expect(outcome).toMatchObject({ kind: 'refused', code: YFINANCE_GATE_CODES.consent });
    }
    expect(sidecar.requests).toHaveLength(0);
  });

  it('a consent read that fails is not a consent', async () => {
    const sidecar = fakeSidecar();
    const source = adapter(sidecar, { consentHolds: () => Promise.reject(new Error('db down')) });
    expect(await ask(source)).toMatchObject({ kind: 'refused', code: YFINANCE_GATE_CODES.consent });
    expect(sidecar.requests).toHaveLength(0);
  });

  it('the consent is asked before every request, so withdrawing it stops the next one', async () => {
    const sidecar = fakeSidecar();
    let consented = true;
    const source = adapter(sidecar, { consentHolds: () => Promise.resolve(consented) });
    expect((await ask(source)).kind).toBe('ok');
    consented = false; // the holder unticks between two calls of one refresh
    expect(await ask(source)).toMatchObject({ kind: 'refused', code: YFINANCE_GATE_CODES.consent });
    expect(sidecar.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. No direct egress to Yahoo
// ---------------------------------------------------------------------------

describe('yfinance: the api and worker processes cannot reach Yahoo', () => {
  it('MARKET_DATA_ALLOWED_HOSTS names neither Yahoo query host, and the four it did', () => {
    expect([...MARKET_DATA_ALLOWED_HOSTS].sort()).toEqual([
      'api.coingecko.com',
      'api.openfigi.com',
      'api.stlouisfed.org',
      'api.tiingo.com',
    ]);
    for (const host of YAHOO_SIDECAR_UPSTREAM_HOSTS) {
      expect(MARKET_DATA_ALLOWED_HOSTS).not.toContain(host);
    }
  });

  it('the context-wide egress policy refuses both Yahoo hosts before resolving', async () => {
    const policy = createMarketDataEgressPolicy();
    let resolved = 0;
    const resolve = () => {
      resolved += 1;
      return Promise.resolve(['93.184.216.34']);
    };
    for (const host of [...YAHOO_SIDECAR_UPSTREAM_HOSTS, 'fc.yahoo.com', 'finance.yahoo.com']) {
      const decision = await guardUrl(`https://${host}/v8/finance/chart/PFTEST`, policy, resolve);
      expect(decision, host).toMatchObject({ ok: false, code: 'host_not_allowed' });
    }
    expect(resolved).toBe(0);
  });

  it('there is no direct-egress policy or base URL for yfinance at all', () => {
    expect(() => policyFor('yfinance')).toThrow(NoDirectEgressError);
    expect(() => baseUrlFor('yfinance')).toThrow(NoDirectEgressError);
  });

  it("the adapter's one destination is the sidecar's compose name, and only if it resolves privately", async () => {
    const policy = createLocalEndpointPolicy({ endpoint: YAHOO_SIDECAR_ENDPOINT });
    expect({ scheme: policy.scheme, host: policy.host, port: policy.port }).toEqual({
      scheme: 'http',
      host: 'yahoo',
      port: 8000,
    });
    // Even a DNS that pointed `yahoo` at Yahoo's own public address is refused.
    expect(
      await guardLocalEndpoint(policy, () => Promise.resolve(['87.248.119.252'])),
    ).toMatchObject({
      ok: false,
      code: 'public_address',
    });
    // And the local-endpoint policy cannot be built for a dotted (remote) name.
    expect(() =>
      createLocalEndpointPolicy({ endpoint: 'https://query1.finance.yahoo.com' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Budget and 429
// ---------------------------------------------------------------------------

describe('yfinance: the 60/hour budget and 429 backoff', () => {
  it('the budget is YFINANCE_WINDOWS, and the 61st call of an hour never leaves', async () => {
    expect(YFINANCE_WINDOWS.map((w) => [w.limit, w.windowMs])).toEqual([[60, 3_600_000]]);
    const clock = mutableClock(NOW);
    const sidecar = fakeSidecar();
    const source = createYfinancePriceSource({
      transport: sidecar,
      now: () => clock.now(),
      budget: createRateBudget(YFINANCE_WINDOWS),
      operatorEnabled: true,
      consentHolds: () => Promise.resolve(true),
    });
    for (let index = 0; index < 60; index += 1) {
      expect((await ask(source)).kind).toBe('ok');
      clock.advanceMs(1_000);
    }
    const sixtyFirst = await ask(source);
    expect(sixtyFirst).toMatchObject({ kind: 'rate_limited' });
    expect(sidecar.requests).toHaveLength(60);
    expect(source.budget(clock.now())).toEqual([
      { label: YFINANCE_WINDOWS[0]?.label, used: 60, limit: 60 },
    ]);
  });

  it('a 429 is rate_limited with the reason, backs off exponentially, and nothing leaves meanwhile', async () => {
    const clock = mutableClock(NOW);
    let status = 429;
    const sidecar = fakeSidecar(() =>
      status === 429
        ? {
            status: 429,
            body: {
              error: 'rate_limited',
              detail: 'Yahoo answered 429 Too Many Requests; backing off',
              retryAfterSeconds: 60,
            },
          }
        : { status: 200, body: QUOTE },
    );
    const source = adapter(sidecar, { now: () => clock.now() });

    const first = await ask(source);
    expect(first).toMatchObject({ kind: 'rate_limited', retryAfterMs: YFINANCE_BACKOFF_BASE_MS });
    expect(first.kind === 'rate_limited' && first.detail).toMatch(/429/);
    expect((await ask(source)).kind).toBe('rate_limited'); // inside the backoff
    expect(sidecar.requests).toHaveLength(1);

    clock.advanceMs(YFINANCE_BACKOFF_BASE_MS + 1);
    expect(await ask(source)).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 2 * YFINANCE_BACKOFF_BASE_MS, // doubled
    });
    expect(sidecar.requests).toHaveLength(2);

    clock.advanceMs(2 * YFINANCE_BACKOFF_BASE_MS + 1);
    status = 200;
    expect((await ask(source)).kind).toBe('ok'); // and a success resets it
    status = 429;
    expect(await ask(source)).toMatchObject({ retryAfterMs: YFINANCE_BACKOFF_BASE_MS });
  });

  it("the sidecar's own spent budget is rate_limited without a backoff of ours", async () => {
    const clock = mutableClock(NOW);
    const sidecar = fakeSidecar(() => ({
      status: 429,
      body: { error: 'budget_spent', detail: 'spent', retryAfterSeconds: 5 },
    }));
    const source = adapter(sidecar, { now: () => clock.now() });
    expect(await ask(source)).toMatchObject({ kind: 'rate_limited', retryAfterMs: 5_000 });
    clock.advanceMs(5_001);
    await ask(source);
    expect(sidecar.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Failure is an outcome; every quote is labelled
// ---------------------------------------------------------------------------

describe('yfinance: outcomes and labels', () => {
  it('a shape change is an error outcome with the reason, never a throw', async () => {
    for (const answer of [
      { status: 502, body: { error: 'shape_changed', detail: "KeyError: 'indicators'" } },
      { status: 200, body: { symbol: 'PFTEST', date: '2026-10-29' } }, // no close
      { status: 200, body: { ...QUOTE, close: 'about 100' } },
      { status: 200, body: { ...QUOTE, currency: 'dollars' } },
      { status: 200, body: { ...QUOTE, date: '2026-10-30' } }, // after the day asked
      { status: 200, body: 'not json at all' },
    ] as const) {
      const outcome = await ask(adapter(fakeSidecar(() => answer)));
      expect(outcome.kind, JSON.stringify(answer)).toBe('error');
      expect(outcome.kind === 'error' && outcome.detail, JSON.stringify(answer)).toMatch(
        /shape changed/,
      );
    }
  });

  it('no data, an upstream error and a sidecar that is down are outcomes too', async () => {
    expect(
      await ask(
        adapter(fakeSidecar(() => ({ status: 404, body: { error: 'no_data', detail: 'none' } }))),
      ),
    ).toMatchObject({ kind: 'no_data' });
    expect(
      await ask(
        adapter(
          fakeSidecar(() => ({ status: 502, body: { error: 'upstream_error', detail: 'x' } })),
        ),
      ),
    ).toMatchObject({ kind: 'error' });
    expect(
      await ask(
        adapter(fakeSidecar(() => ({ status: 502, body: { error: 'host_refused', detail: 'x' } }))),
      ),
    ).toMatchObject({ kind: 'refused', code: 'upstream_host_refused' });
    const down = createYfinancePriceSource({
      transport: {
        request: () =>
          Promise.reject(
            Object.assign(new Error('refused'), { name: 'LocalEndpointRefusedError' }),
          ),
      },
      now: () => NOW,
      operatorEnabled: true,
      consentHolds: () => Promise.resolve(true),
    });
    expect((await ask(down)).kind).toBe('error');
  });

  it('every quote carries the best-effort label, and redistribution is forbidden', async () => {
    const outcome = await ask(adapter(fakeSidecar()));
    expect(outcome.kind === 'ok' && outcome.value.attribution).toEqual(ATTRIBUTIONS.yfinance);
    expect(ATTRIBUTIONS.yfinance).toMatchObject({
      required: true,
      text: 'Yahoo Finance via yfinance — unofficial, best effort',
      redistribution: 'forbidden',
    });
    expect(ATTRIBUTIONS.yfinance.surfaces).toEqual(['any_price', 'settings']);
    const fx = await adapter(
      fakeSidecar(() => ({
        status: 200,
        body: { from: 'EUR', to: 'USD', date: '2026-10-29', rate: 1.0812, stale: false },
      })),
    ).fxRate('EUR', 'USD', '2026-10-29');
    expect(fx).toMatchObject({
      kind: 'ok',
      value: { rate: '1.0812', attribution: ATTRIBUTIONS.yfinance },
    });
  });

  it('a coin id, or another currency, is no_data without a request', async () => {
    const sidecar = fakeSidecar();
    const source = adapter(sidecar);
    expect(
      await source.price({
        subject: { kind: 'coin_id', coinId: 'bitcoin' },
        date: '2026-10-29',
        currency: 'USD',
      }),
    ).toMatchObject({ kind: 'no_data' });
    expect(sidecar.requests).toHaveLength(0);
    expect(
      await source.price({ subject: TICKER, date: '2026-10-29', currency: 'EUR' }),
    ).toMatchObject({
      kind: 'no_data',
    });
  });

  it('a weekend is a carry-forward and says so; search names symbols', async () => {
    const source = adapter(
      fakeSidecar((request) =>
        request.path === '/search'
          ? {
              status: 200,
              body: { results: [{ symbol: 'PFTEST', name: 'PersonalFi Test', kind: 'EQUITY' }] },
            }
          : { status: 200, body: { ...QUOTE, date: '2026-10-30', stale: true } },
      ),
    );
    expect(await ask(source, '2026-11-01')).toMatchObject({
      kind: 'ok',
      value: { date: '2026-10-30', stale: true },
    });
    expect(await source.search('PF')).toEqual({
      kind: 'ok',
      value: [{ symbol: 'PFTEST', name: 'PersonalFi Test', kind: 'EQUITY', provider: 'yfinance' }],
    });
  });
});

// ---------------------------------------------------------------------------
// The real transport, against a loopback stand-in for the sidecar
// ---------------------------------------------------------------------------

describe('yfinance over the local-endpoint transport', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    servers.length = 0;
  });

  it('asks the sidecar at /quote with an encoded query and nothing else', async () => {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(`${request.method ?? '?'} ${request.url ?? '?'} ${request.headers.host ?? '?'}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ...QUOTE, symbol: 'EURUSD=X' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = createLocalEndpointTransport(
      createLocalEndpointPolicy({ endpoint: `http://yahoo:${String(port)}` }),
      { resolve: () => Promise.resolve(['127.0.0.1']) },
    );
    const outcome = await adapter(transport).price({
      subject: { kind: 'ticker', symbol: 'EURUSD=X', mic: null },
      date: '2026-10-29',
      currency: 'USD',
    });
    expect(outcome.kind).toBe('ok');
    expect(seen).toEqual([`GET /quote?symbol=EURUSD%3DX&date=2026-10-29 yahoo:${String(port)}`]);
  });
});

// ---------------------------------------------------------------------------
// The refresh uses Yahoo only as the holder ranked it
// ---------------------------------------------------------------------------

describe('the nightly refresh and the holder’s ranking', () => {
  const USER = '01920000-0000-7000-8000-000000000900';
  const OUTBOX = {
    execute: () => Promise.resolve({ rows: [{ out_seq: 1, out_recorded_at: NOW }] }),
  } as never;
  const ID = {
    a: '01920000-0000-7000-8000-000000000001',
    b: '01920000-0000-7000-8000-000000000002',
  } as const;
  const PLAN: RefreshPlan = {
    asOfDate: '2026-10-29',
    securities: [
      {
        securityId: ID.a,
        kind: 'equity',
        subject: { kind: 'ticker', symbol: 'AAA', mic: null },
        currency: 'USD',
      },
      {
        securityId: ID.b,
        kind: 'etf',
        subject: { kind: 'ticker', symbol: 'BBB', mic: null },
        currency: 'USD',
      },
    ],
    fxPairs: [],
  };
  const BOTH = { 'AAA|2026-10-29|USD': '10', 'BBB|2026-10-29|USD': '10' };
  const DEFAULT = ['user_override', 'exchange_fill', 'tiingo', 'last_known'];
  const AFTER = ['user_override', 'exchange_fill', 'tiingo', 'yfinance', 'last_known'];
  const BEFORE = ['user_override', 'exchange_fill', 'yfinance', 'tiingo', 'last_known'];

  function run(
    sources: readonly PriceSource[],
    ladders?: Readonly<Record<string, readonly string[]>>,
  ) {
    const writer = inMemoryMarketDataWriter();
    const recorder = inMemoryRunRecorder();
    const job = createPriceRefreshJob({
      userId: USER,
      sources,
      writer,
      recorder,
      outbox: OUTBOX,
      correlationId: '01920000-0000-7000-8000-000000000126',
      clock: fixedClock(NOW),
      ...(ladders === undefined ? {} : { ladders }),
    });
    return { writer, recorder, result: job.run(PLAN) };
  }

  it('providersForKind: never inserted; placed where the holder placed it', () => {
    expect(providersForKind('equity', undefined)).toEqual(['tiingo']);
    expect(providersForKind('equity', DEFAULT)).toEqual(['tiingo']);
    expect(providersForKind('equity', AFTER)).toEqual(['tiingo', 'yfinance']);
    expect(providersForKind('equity', BEFORE)).toEqual(['yfinance', 'tiingo']);
    expect(providersForKind('equity', ['user_override', 'last_known'])).toEqual(['tiingo']);
    expect(providersForKind('bond', ['yfinance'])).toEqual([]);
  });

  it('a registered, consented Yahoo is never asked unless the holder placed it', async () => {
    const yahoo = fakeSidecar();
    const tiingo = createFakePriceSource({ provider: 'tiingo', prices: BOTH });
    const { result } = run([tiingo, adapter(yahoo)], { equity: DEFAULT, etf: DEFAULT });
    expect((await result).securitiesPriced).toHaveLength(2);
    expect(yahoo.requests).toHaveLength(0);
  });

  it('placed after Tiingo, Yahoo answers only what Tiingo could not', async () => {
    const yahoo = fakeSidecar((request) => ({
      status: 200,
      body: { ...QUOTE, symbol: request.query?.['symbol'] },
    }));
    // Tiingo carries BBB and not AAA.
    const tiingo = createFakePriceSource({
      provider: 'tiingo',
      prices: { 'BBB|2026-10-29|USD': '10' },
    });
    const { writer, result } = run([tiingo, adapter(yahoo)], { equity: AFTER, etf: AFTER });
    const done = await result;
    expect(done.pricedBy).toEqual([
      { securityId: ID.a, provider: 'yfinance' },
      { securityId: ID.b, provider: 'tiingo' },
    ]);
    expect(yahoo.requests.map((r) => r.query?.['symbol'])).toEqual(['AAA']);
    expect(writer.prices.map((row) => row.source)).toEqual(['yfinance', 'tiingo']);
    expect(done.attributionRequirements.map((a) => a.provider)).toContain('yfinance');
  });

  it('placed before Tiingo, Yahoo is asked first', async () => {
    const yahoo = fakeSidecar();
    const tiingo = createFakePriceSource({ provider: 'tiingo', prices: BOTH });
    const done = await run([tiingo, adapter(yahoo)], { equity: BEFORE, etf: DEFAULT }).result;
    expect(done.pricedBy).toEqual([
      { securityId: ID.a, provider: 'yfinance' },
      { securityId: ID.b, provider: 'tiingo' },
    ]);
  });

  it('a Tiingo outage is not a burst of Yahoo requests', async () => {
    const yahoo = fakeSidecar();
    const tiingo = createFakePriceSource({
      provider: 'tiingo',
      outcome: { kind: 'error', detail: 'tiingo is down' },
    });
    const done = await run([tiingo, adapter(yahoo)], { equity: AFTER, etf: AFTER }).result;
    expect(yahoo.requests).toHaveLength(0);
    expect(done.unpriced.map((u) => u.reason)).toEqual(['error', 'error']);
  });

  it('a Yahoo 429 mid-refresh is recorded with its reason; nothing crashes and no row is written', async () => {
    const yahoo = fakeSidecar(() => ({
      status: 429,
      body: { error: 'rate_limited', detail: 'Yahoo answered 429', retryAfterSeconds: 60 },
    }));
    const { writer, recorder, result } = run([adapter(yahoo)], { equity: BEFORE, etf: BEFORE });
    const done = await result;
    expect(done.securitiesPriced).toEqual([]);
    expect(done.unpriced.map((u) => [u.provider, u.reason])).toEqual([
      ['yfinance', 'rate_limited'],
      // Tiingo is not registered here: the walk ends at Yahoo's 429.
      ['yfinance', 'rate_limited'],
    ]);
    expect(writer.prices).toEqual([]); // the ladder's last_known answers for the day
    expect(recorder.runs).toEqual([
      expect.objectContaining({ provider: 'yfinance', outcome: 'rate_limited' }),
    ]);
    expect(yahoo.requests).toHaveLength(1); // the second was inside the backoff
  });
});
