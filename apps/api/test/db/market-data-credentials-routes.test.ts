// SPDX-License-Identifier: MIT
/**
 * WP 10.4 — a holder's market-data keys through the product, end to end
 * against Postgres: `GET/PUT/DELETE /market-data/providers/:provider/credentials`.
 *
 * The provider is `@ctx/integrations`' `createFakeTransport` under the real
 * adapters (`marketDataTransport`, the network seam), answering 200 for a good
 * key, 401 for a key whose text says `rejected`, and 503 for one that says
 * `down`: the validation call is real code over a fake socket, never a live
 * provider. The worker side is composed the way `worker.ts` composes it — the
 * same `createStoredMarketDataKeys` reader and the real `appModules()` consumer
 * behind a real `createConsumerPump`.
 *
 * Every key below is synthetic and distinctive, so an absence assertion cannot
 * pass by accident.
 */
import { systemClock } from '@core/kernel';
import {
  createConsumerPump,
  platformExecutor,
  silentLogger,
  type TransportRequest,
} from '@core/platform';
import { createFakeTransport, jsonResponse } from '@ctx/integrations';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDomainRuntime,
  createInvestmentSyncPort,
  createMarketDataRuntime,
  createMarketDataRunRecorder,
  createMarketDataWriter,
  createConnectorRegistry,
} from '../../src/domain.ts';
import { createStoredMarketDataKeys } from '../../src/market-data-keys.ts';
import { appModules } from '../../src/modules.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const GOOD_KEY = 'canaryT11ngoGoodKey000000000000000009f2c'; // gitleaks:allow — synthetic canary, not a credential
const REPLACEMENT_KEY = 'canaryT11ngoReplacement000000000000000beef'; // gitleaks:allow — synthetic canary, not a credential
const REJECTED_KEY = 'rejected-canary-key-00000000000000000001'; // gitleaks:allow — synthetic canary, not a credential
const DOWN_KEY = 'down-canary-key-000000000000000000000002'; // gitleaks:allow — synthetic canary, not a credential
const FILE_KEY = 'operator-file-key-0000000000000000000003'; // gitleaks:allow — synthetic canary, not a credential

/** A session cookie nobody issued (the CSRF pair matches, so the session check is what answers). */
const NO_SESSION = { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false };

const url = (provider: string): string => `/market-data/providers/${provider}/credentials`;

/** The key a request carried: a header for three providers, FRED's query string for the fourth. */
function keyOf(request: TransportRequest): string {
  return `${JSON.stringify(request.headers)} ${JSON.stringify(request.destination)}`;
}

describe.skipIf(NO_DATABASE)('market-data keys through the product (WP 10.4)', () => {
  let h: ApiHarness;
  let logs = '';
  const logStream = { write: (chunk: string) => void (logs += chunk) };
  const rowCountsAtValidation: number[] = [];

  async function rowCount(): Promise<number> {
    const result = await h.database.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM provider_credentials WHERE provider <> 'plaid'",
    );
    return result.rows[0]?.n ?? 0;
  }

  const fake = createFakeTransport(async (request) => {
    rowCountsAtValidation.push(await rowCount());
    const carried = keyOf(request);
    if (carried.includes('rejected-canary')) return jsonResponse({ detail: 'Invalid token.' }, 401);
    if (carried.includes('down-canary')) return jsonResponse({ detail: 'unavailable' }, 503);
    if (request.destination.host === 'api.openfigi.com') {
      return jsonResponse([{ warning: 'No identifier found.' }]);
    }
    if (request.destination.host === 'api.stlouisfed.org') {
      return jsonResponse({ observations: [] });
    }
    return jsonResponse([]);
  });

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp104mdkeys',
      marketDataTransport: fake.transport,
      logStream,
      env: { LOG_LEVEL: 'trace' },
    });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  const put = (provider: string, body: unknown, session = h.fresh) =>
    h.request({ method: 'PUT', url: url(provider), session, body });
  const get = (provider: string, session = h.stale) =>
    h.request({ method: 'GET', url: url(provider), session });
  const remove = (provider: string, session = h.fresh) =>
    h.request({ method: 'DELETE', url: url(provider), session });

  async function auditRows() {
    const result = await h.database.pool.query<{
      kind: string;
      outcome: string;
      detail: Record<string, unknown>;
    }>(
      "SELECT kind, outcome, detail FROM security_events WHERE kind LIKE 'provider_credentials.%' ORDER BY occurred_at, id",
    );
    return result.rows;
  }

  it('PUT needs a fresh step-up, validates with the provider before sealing, and GET never returns the key', async () => {
    const none = await get('tiingo');
    expectStatus(none, 200);
    expect(none.json()).toEqual({
      provider: 'tiingo',
      purpose: 'Equity, ETF and fund end-of-day closes.',
      source: 'none',
      configured: false,
      anonymous: false,
      keyHint: null,
      storedAt: null,
      rotatedAt: null,
      narrowedOut: false,
    });
    // OpenFIGI with no key says the anonymous tier is in use.
    expect((await get('openfigi')).json()).toMatchObject({ source: 'none', anonymous: true });

    // No session: 401. No step-up: 403. Nothing stored, nothing asked.
    expect(
      (
        await h.request({
          method: 'PUT',
          url: url('tiingo'),
          body: { key: GOOD_KEY },
          session: NO_SESSION,
        })
      ).statusCode,
    ).toBe(401);
    const stale = await put('tiingo', { key: GOOD_KEY }, h.stale);
    expectStatus(stale, 403);
    expect(problemOf(stale)['code']).toBe('step_up_required');
    expect((await remove('tiingo', h.stale)).statusCode).toBe(403);
    expect(await rowCount()).toBe(0);
    expect(fake.requests).toHaveLength(0);

    // Shape: 400, never echoed. Too short (the hint would exceed a quarter), a space, a quote.
    for (const bad of ['short-key-123', 'has a space in it 0000000', '"quoted-key-000000000"']) {
      const response = await put('tiingo', { key: bad });
      expectStatus(response, 400);
      expect(response.body).not.toContain(bad);
    }
    // An unknown provider is a 400 too.
    expectStatus(await put('yfinance', { key: GOOD_KEY }), 400);

    // The provider refuses: 422, nothing sealed, no echo.
    const rejected = await put('tiingo', { key: REJECTED_KEY });
    expectStatus(rejected, 422);
    expect(problemOf(rejected)['code']).toBe('provider_credentials.rejected');
    expect(rejected.body).not.toContain(REJECTED_KEY);
    expect(await rowCount()).toBe(0);

    // The provider is down: 502, nothing sealed.
    const down = await put('coingecko', { key: DOWN_KEY });
    expectStatus(down, 502);
    expect(problemOf(down)['code']).toBe('provider_credentials.provider_unavailable');
    expect(await rowCount()).toBe(0);

    // A good key: asked first (no row existed when the provider was asked), then sealed.
    rowCountsAtValidation.length = 0;
    const ok = await put('tiingo', { key: GOOD_KEY });
    expectStatus(ok, 200);
    expect(rowCountsAtValidation).toEqual([0]);
    expect(ok.json()).toMatchObject({
      provider: 'tiingo',
      source: 'stored',
      configured: true,
      keyHint: '9f2c',
      rotatedAt: null,
    });
    expect(ok.body).not.toContain(GOOD_KEY);
    const status = await get('tiingo');
    expect(status.body).not.toContain(GOOD_KEY);
    expect(status.json()).toMatchObject({ source: 'stored', keyHint: '9f2c' });
    expect((status.json() as { storedAt: string | null }).storedAt).not.toBeNull();

    // The settings screen reports the stored key as in force, by source, with no value.
    const settings = await h.request({
      method: 'GET',
      url: '/market-data/settings',
      session: h.stale,
    });
    expectStatus(settings, 200);
    const tiingo = (
      settings.json() as {
        providers: {
          provider: string;
          keyPresent: boolean;
          keySource: string;
          registered: boolean;
        }[];
      }
    ).providers.find((row) => row.provider === 'tiingo');
    expect(tiingo).toMatchObject({ keyPresent: true, keySource: 'stored', registered: true });
    expect(settings.body).not.toContain(GOOD_KEY);

    // Replacing rotates.
    const rotated = await put('tiingo', { key: REPLACEMENT_KEY });
    expectStatus(rotated, 200);
    expect(rotated.json()).toMatchObject({ keyHint: 'beef' });
    expect((rotated.json() as { rotatedAt: string | null }).rotatedAt).not.toBeNull();

    // DELETE: gone, idempotent.
    expect((await remove('tiingo')).json()).toMatchObject({ source: 'none', keyHint: null });
    expectStatus(await remove('tiingo'), 200);
    expect(await rowCount()).toBe(0);

    // The audit trail names the provider and never a key or a hint.
    const audit = await auditRows();
    expect(audit.map((row) => `${row.kind}:${row.outcome}`)).toEqual([
      'provider_credentials.set:failure',
      'provider_credentials.set:failure',
      'provider_credentials.set:success',
      'provider_credentials.rotated:success',
      'provider_credentials.removed:success',
    ]);
    for (const row of audit) {
      expect(Object.keys(row.detail).sort()).toEqual(
        row.outcome === 'success' ? ['provider'] : ['provider', 'reason'],
      );
    }
    const dump = JSON.stringify(audit);
    for (const key of [GOOD_KEY, REPLACEMENT_KEY, REJECTED_KEY, DOWN_KEY]) {
      expect(dump).not.toContain(key);
    }

    // Each check was spent against the run ledger like a test fetch.
    const runs = await h.database.pool.query<{ provider: string; outcome: string }>(
      "SELECT provider, outcome FROM market_data_runs WHERE operation = 'test_fetch' ORDER BY started_at",
    );
    expect(runs.rows.map((row) => `${row.provider}:${row.outcome}`)).toEqual([
      'tiingo:refused',
      'coingecko:failed',
      'tiingo:ok',
      'tiingo:ok',
    ]);
  }, 120_000);

  it('a key never reaches a log line, on any path', async () => {
    expectStatus(await put('fred', { key: GOOD_KEY }), 200);
    expectStatus(await put('fred', { key: REJECTED_KEY }), 422);
    expectStatus(await put('fred', { key: DOWN_KEY }), 502);
    expectStatus(await get('fred'), 200);
    expectStatus(await remove('fred'), 200);
    expect(logs.length).toBeGreaterThan(1000);
    for (const key of [GOOD_KEY, REJECTED_KEY, DOWN_KEY]) {
      expect(logs, `a log line contains ${key.slice(0, 12)}…`).not.toContain(key);
    }
  });

  it("operator's file wins over a stored key, and the GET says so", async () => {
    const files = await createApiHarness({
      suite: 'wp104mdfiles',
      marketDataTransport: fake.transport,
      extraSecrets: { tiingo_api_key: FILE_KEY },
    });
    try {
      const status = await files.request({
        method: 'GET',
        url: url('tiingo'),
        session: files.stale,
      });
      expectStatus(status, 200);
      expect(status.json()).toMatchObject({ source: 'file', configured: true, keyHint: null });
      expect(status.body).not.toContain(FILE_KEY);
      const refused = await files.request({
        method: 'PUT',
        url: url('tiingo'),
        session: files.fresh,
        body: { key: GOOD_KEY },
      });
      expectStatus(refused, 409);
      expect(problemOf(refused)['code']).toBe('provider_credentials.managed_by_files');
      const stored = await files.database.pool.query(
        "SELECT 1 FROM provider_credentials WHERE provider = 'tiingo'",
      );
      expect(stored.rowCount).toBe(0);
      // Another provider without a file is still storable on the same install.
      const other = await files.request({
        method: 'PUT',
        url: url('coingecko'),
        session: files.fresh,
        body: { key: GOOD_KEY },
      });
      expectStatus(other, 200);
    } finally {
      await files.close();
    }
  }, 120_000);

  it('after PUT the worker uses the key within its cache, and at once when the event reaches its consumer', async () => {
    const userId = h.userId;
    // --- the worker side, composed the way worker.ts composes it -------------
    const runtime = createMarketDataRuntime({
      secrets: h.config.secrets,
      allowedHosts: [],
      clock: systemClock,
      transport: fake.transport,
      resolve: () => Promise.resolve(['93.184.216.34']),
      storedKeys: createStoredMarketDataKeys({
        database: h.database.db,
        secretBox: () => h.security.requireSecretBox(),
      }),
    });
    const logger = pino({ level: 'silent' });
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const registry = createConnectorRegistry();
    const modules = appModules({
      advisorsEnabled: true,
      localModelConfigured: false,
      database: h.database.db,
      userId,
      connectorRegistry: registry,
      orchestrator: createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger,
        registry,
        secretBox: h.security.requireSecretBox(),
      }).orchestrator,
      timezone: 'America/New_York',
      clock: systemClock,
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: denyAll }),
        smtp: createSmtpChannel({ policy: denyAll }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(h.database.db),
      marketData: {
        runtime,
        writer: createMarketDataWriter(h.database.db),
        recorder: createMarketDataRunRecorder(h.database.db),
      },
    });
    const consumers = modules.find((m) => m.flagKey === 'module.connections')?.consumers ?? [];
    expect(consumers.map((c) => c.name)).toEqual(['connections.provider_credentials_cache@v1']);
    const pump = createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      clock: systemClock,
      logger: silentLogger,
      consumers,
    });
    await pump.drain();

    // Before: no CoinGecko for this holder, and that answer is now cached.
    expect((await runtime.forUser(userId)).keySources.coingecko).toBe('none');

    // The holder saves a key in Settings; no restart.
    expectStatus(await put('coingecko', { key: GOOD_KEY }), 200);
    expect((await runtime.forUser(userId)).keySources.coingecko, 'cached until the event').toBe(
      'none',
    );
    await pump.drain();
    const view = await runtime.forUser(userId);
    expect(view.keySources.coingecko).toBe('stored');
    expect(view.sources.map((source) => source.provider)).toContain('coingecko');

    // And removal reaches it the same way.
    expectStatus(await remove('coingecko'), 200);
    expect((await runtime.forUser(userId)).keySources.coingecko).toBe('stored');
    await pump.drain();
    expect((await runtime.forUser(userId)).keySources.coingecko).toBe('none');
  }, 120_000);

  it('a stored key never appears in an export bundle', async () => {
    expectStatus(await put('openfigi', { key: GOOD_KEY }), 200);
    const response = await h.request({ method: 'GET', url: '/export', session: h.fresh });
    expectStatus(response, 200);
    expect(response.body.length).toBeGreaterThan(100);
    expect(response.body).not.toContain(GOOD_KEY);
    expect(response.body).not.toContain('secret_sealed');
    expect(response.body).not.toContain('unresolved_holdings');
  });
});
