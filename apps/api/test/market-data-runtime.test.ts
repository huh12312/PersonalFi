// SPDX-License-Identifier: MIT
/**
 * WP 10.4 — `createMarketDataRuntime` with keys from two places, the anonymous
 * OpenFIGI tier wired, and the key-validation call. No database, no network:
 * every adapter talks to `@ctx/integrations`' `createFakeTransport`, and DNS is
 * a fixed public address so the egress guard passes.
 *
 * The keys below are synthetic and never leave this file.
 */
import { redact } from '@core/config';
import { createFakeTransport, jsonResponse, type FakeHandler } from '@ctx/integrations';
import type { TransportRequest } from '@core/platform';
import { describe, expect, it } from 'vitest';
import {
  createMarketDataRuntime,
  hydrateMarketDataBudgets,
  type MarketDataKeyedProvider,
} from '../src/domain.ts';
import { validateMarketDataKey } from '../src/market-data-keys.ts';

const FILE_KEY = 'file-key-0000000000000000000000AAAA'; // gitleaks:allow — synthetic
const STORED_KEY = 'stored-key-111111111111111111111BBBB'; // gitleaks:allow — synthetic
const PUBLIC = (): Promise<string[]> => Promise.resolve(['93.184.216.34']);
const NO_SECRETS = {
  tiingo_api_key: undefined,
  fred_api_key: undefined,
  coingecko_api_key: undefined,
  openfigi_api_key: undefined,
} as const;

/** A fixed clock the runtime and its cache read. */
function clockAt(iso: string): { now(): Date; nowMs(): number; advance(ms: number): void } {
  let at = new Date(iso).getTime();
  return {
    now: () => new Date(at),
    nowMs: () => at,
    advance(ms) {
      at += ms;
    },
  };
}

/** Answers OpenFIGI with one empty result per job, and everything else with `[]`. */
function answering(status = 200): ReturnType<typeof createFakeTransport> {
  const handler: FakeHandler = (request) => {
    if (status !== 200) return jsonResponse({ error: 'synthetic refusal' }, status);
    if (request.destination.host === 'api.openfigi.com') {
      const jobs = JSON.parse(request.body ?? '[]') as unknown[];
      return jsonResponse(jobs.map(() => ({ warning: 'No identifier found.' })));
    }
    if (request.destination.host === 'api.stlouisfed.org') {
      return jsonResponse({ observations: [] });
    }
    return jsonResponse([]);
  };
  return createFakeTransport(handler);
}

function storedPort(
  keys: Partial<Record<MarketDataKeyedProvider, string>>,
  calls: { count: number } = { count: 0 },
) {
  return async (userId: string) => {
    void userId;
    calls.count += 1;
    return new Map(
      Object.entries(keys).map(([provider, key]) => [
        provider as MarketDataKeyedProvider,
        { key: () => key },
      ]),
    );
  };
}

function headerValues(requests: readonly TransportRequest[]): string[] {
  return requests.flatMap((request) => Object.values(request.headers));
}

describe('WP 10.4 — the market-data runtime', () => {
  it('with no OpenFIGI key the mapper exists, anonymously: 25 requests a minute, 10 jobs a request', async () => {
    const fake = answering();
    const runtime = createMarketDataRuntime({
      secrets: NO_SECRETS,
      allowedHosts: [],
      transport: fake.transport,
      resolve: PUBLIC,
    });
    expect(runtime.figi, 'C-8: the anonymous tier is wired, not absent').toBeDefined();
    const window = runtime.budgets.get('openfigi')?.spent(new Date())[0]?.window;
    expect(window?.limit).toBe(25);
    expect(window?.unit).toBe('request');

    // 25 jobs anonymously are three requests (10 + 10 + 5), and no key header is sent.
    const jobs = Array.from({ length: 25 }, (_, index) => ({
      idType: 'ID_ISIN' as const,
      idValue: `US00000000${String(index).padStart(2, '0')}`,
      micCode: null,
    }));
    await runtime.figi?.map(jobs);
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.every((request) => !('x-openfigi-apikey' in request.headers))).toBe(true);
    expect(runtime.keySources.openfigi).toBe('none');
  });

  it('with an OpenFIGI key the keyed path is unchanged: 25 000 jobs a minute, 100 jobs a request', async () => {
    const fake = answering();
    const runtime = createMarketDataRuntime({
      secrets: { ...NO_SECRETS, openfigi_api_key: redact(FILE_KEY) },
      allowedHosts: [],
      transport: fake.transport,
      resolve: PUBLIC,
    });
    const window = runtime.budgets.get('openfigi')?.spent(new Date())[0]?.window;
    expect(window?.limit).toBe(25_000);
    expect(window?.unit).toBe('job');
    const jobs = Array.from({ length: 25 }, (_, index) => ({
      idType: 'ID_ISIN' as const,
      idValue: `US00000000${String(index).padStart(2, '0')}`,
      micCode: null,
    }));
    await runtime.figi?.map(jobs);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers['x-openfigi-apikey']).toBe(FILE_KEY);
  });

  it('MARKET_DATA_ALLOWED_HOSTS that excludes OpenFIGI leaves no mapper, keyed or not', () => {
    const runtime = createMarketDataRuntime({
      secrets: NO_SECRETS,
      allowedHosts: ['api.tiingo.com'],
      resolve: PUBLIC,
    });
    expect(runtime.figi).toBeUndefined();
  });

  it("a holder's stored key is used where the file is empty, and reported as stored", async () => {
    const fake = answering();
    const runtime = createMarketDataRuntime({
      secrets: NO_SECRETS,
      allowedHosts: [],
      transport: fake.transport,
      resolve: PUBLIC,
      storedKeys: storedPort({ tiingo: STORED_KEY }),
    });
    expect(runtime.sources, 'the operator view has no Tiingo').toHaveLength(0);
    const view = await runtime.forUser('user-a');
    expect(view.keySources.tiingo).toBe('stored');
    const tiingo = view.sources.find((source) => source.provider === 'tiingo');
    expect(tiingo).toBeDefined();
    await tiingo?.price({
      subject: { kind: 'ticker', symbol: 'SPY', mic: null },
      date: '2026-10-13',
      currency: 'USD',
    });
    expect(headerValues(fake.requests)).toContain(`Token ${STORED_KEY}`);
  });

  it("the operator's non-empty file wins over a stored key, provider by provider", async () => {
    const fake = answering();
    const runtime = createMarketDataRuntime({
      secrets: { ...NO_SECRETS, tiingo_api_key: redact(FILE_KEY) },
      allowedHosts: [],
      transport: fake.transport,
      resolve: PUBLIC,
      storedKeys: storedPort({ tiingo: STORED_KEY, coingecko: STORED_KEY }),
    });
    const view = await runtime.forUser('user-a');
    expect(view.keySources.tiingo).toBe('file');
    expect(view.keySources.coingecko).toBe('stored');
    await view.sources
      .find((source) => source.provider === 'tiingo')
      ?.price({
        subject: { kind: 'ticker', symbol: 'SPY', mic: null },
        date: '2026-10-13',
        currency: 'USD',
      });
    const sent = headerValues(fake.requests);
    expect(sent).toContain(`Token ${FILE_KEY}`);
    expect(sent).not.toContain(`Token ${STORED_KEY}`);
  });

  it('caches a view for 30 s, invalidate() drops it, and a read in flight across an invalidation is not cached', async () => {
    const clock = clockAt('2026-10-14T12:00:00.000Z');
    const calls = { count: 0 };
    let keys: Partial<Record<MarketDataKeyedProvider, string>> = {};
    let release: (() => void) | undefined;
    let gate: Promise<void> = Promise.resolve();
    const runtime = createMarketDataRuntime({
      secrets: NO_SECRETS,
      allowedHosts: [],
      clock: { now: clock.now, nowMs: clock.nowMs },
      resolve: PUBLIC,
      storedKeys: async (userId) => {
        await gate;
        return storedPort(keys, calls)(userId);
      },
    });

    expect((await runtime.forUser('u')).keySources.fred).toBe('none');
    keys = { fred: STORED_KEY };
    expect((await runtime.forUser('u')).keySources.fred, 'cached inside the window').toBe('none');
    expect(calls.count).toBe(1);
    clock.advance(30_001);
    expect((await runtime.forUser('u')).keySources.fred, 'the window expired').toBe('stored');
    expect(calls.count).toBe(2);

    keys = {};
    runtime.invalidate();
    expect((await runtime.forUser('u')).keySources.fred, 'invalidate drops it at once').toBe(
      'none',
    );

    // The race: a read starts, the key changes and the cache is invalidated
    // while it is in flight; its (stale) answer must not be cached.
    runtime.invalidate();
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const inFlight = runtime.forUser('u');
    keys = { fred: STORED_KEY };
    runtime.invalidate();
    release?.();
    await inFlight;
    gate = Promise.resolve();
    expect((await runtime.forUser('u')).keySources.fred).toBe('stored');
  });

  it('allBudgets carries every provider, both OpenFIGI tiers, so a stored key spends against a primed budget', async () => {
    const runtime = createMarketDataRuntime({ secrets: NO_SECRETS, allowedHosts: [] });
    const providers = runtime.allBudgets.map(([provider]) => provider);
    expect(providers).toEqual(['tiingo', 'fred', 'coingecko', 'openfigi', 'openfigi']);
    // The operator's view with no files has only the anonymous OpenFIGI budget in force.
    expect([...runtime.budgets.keys()]).toEqual(['openfigi']);
    // And the stored view reuses the same budget objects, so nothing resets.
    const withStored = createMarketDataRuntime({
      secrets: NO_SECRETS,
      allowedHosts: [],
      storedKeys: storedPort({ tiingo: STORED_KEY }),
    });
    const view = await withStored.forUser('u');
    const tiingoBudget = withStored.allBudgets.find(([provider]) => provider === 'tiingo')?.[1];
    expect(view.budgets.get('tiingo')).toBe(tiingoBudget);
    // `hydrateMarketDataBudgets` accepts that list (no database is touched for an empty one).
    expect(await hydrateMarketDataBudgets({} as never, 'u', [])).toBe(0);
  });

  it('a stored key never reaches a log line', async () => {
    const lines: string[] = [];
    const logger = {
      info: (...args: unknown[]) => lines.push(JSON.stringify(args)),
      warn: (...args: unknown[]) => lines.push(JSON.stringify(args)),
      error: (...args: unknown[]) => lines.push(JSON.stringify(args)),
      debug: (...args: unknown[]) => lines.push(JSON.stringify(args)),
    };
    const runtime = createMarketDataRuntime({
      secrets: { ...NO_SECRETS, fred_api_key: redact(FILE_KEY) },
      allowedHosts: [],
      logger: logger as never,
      storedKeys: storedPort({ tiingo: STORED_KEY, openfigi: STORED_KEY }),
    });
    const view = await runtime.forUser('u');
    lines.push(JSON.stringify(view));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(STORED_KEY);
      expect(line).not.toContain(FILE_KEY);
    }
  });
});

describe('WP 10.4 — validating a key before it is stored', () => {
  const clock = clockAt('2026-10-14T12:00:00.000Z');
  const providers: readonly MarketDataKeyedProvider[] = ['tiingo', 'fred', 'coingecko', 'openfigi'];

  for (const provider of providers) {
    it(`${provider}: an answer accepts, 401/403/400 rejects, 5xx is unavailable — one call each`, async () => {
      const ok = answering(200);
      expect(
        await validateMarketDataKey({
          provider,
          key: STORED_KEY,
          allowedHosts: [],
          clock,
          transport: ok.transport,
          resolve: PUBLIC,
        }),
      ).toEqual({ verdict: 'accepted' });
      expect(ok.requests, 'one cheap call').toHaveLength(1);
      // The key travelled in the header (or FRED's query), so it is the one checked.
      const carried =
        provider === 'fred'
          ? (ok.requests[0]?.destination.path ?? '') + JSON.stringify(ok.requests[0])
          : headerValues(ok.requests).join(' ');
      expect(carried).toContain(STORED_KEY);

      for (const status of [400, 401, 403]) {
        const refusing = answering(status);
        expect(
          await validateMarketDataKey({
            provider,
            key: STORED_KEY,
            allowedHosts: [],
            clock,
            transport: refusing.transport,
            resolve: PUBLIC,
          }),
        ).toEqual({ verdict: 'rejected', status });
      }

      const down = answering(503);
      expect(
        await validateMarketDataKey({
          provider,
          key: STORED_KEY,
          allowedHosts: [],
          clock,
          transport: down.transport,
          resolve: PUBLIC,
        }),
      ).toEqual({ verdict: 'unavailable' });
    });
  }

  it('a provider narrowed out by MARKET_DATA_ALLOWED_HOSTS is never called', async () => {
    const fake = answering();
    expect(
      await validateMarketDataKey({
        provider: 'coingecko',
        key: STORED_KEY,
        allowedHosts: ['api.tiingo.com'],
        clock,
        transport: fake.transport,
        resolve: PUBLIC,
      }),
    ).toEqual({ verdict: 'narrowed_out' });
    expect(fake.requests).toHaveLength(0);
  });
});
