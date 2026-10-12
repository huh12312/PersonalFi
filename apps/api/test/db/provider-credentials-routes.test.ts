// SPDX-License-Identifier: MIT
/**
 * Plaid credentials through the product (WP 10.1), through the real `buildApp`.
 *
 * Nothing here builds a parallel composition (C5-11). The harness hands `buildApp`
 * no registry, so the app builds its own through `createConnectorRegistry` +
 * `withStoredPlaid` exactly as production does; the only substitution is the
 * Plaid *client* (`plaidApiFactory`, the network seam), which returns
 * `FakePlaidApi` from `@connector/plaid/test`, so no request leaves the process
 * and no real credential is involved. The live sandbox check is Chris's first use.
 *
 * The worker half is built the way `worker.ts` builds it: the same
 * `withStoredPlaid(createConnectorRegistry(...), createStoredPlaid(...))`, and the
 * consumers come out of the real `appModules()` given that registry, driven by a
 * real consumer pump over the same database.
 *
 * Every credential below is synthetic (a distinctive canary, so an absence
 * assertion cannot pass by accident).
 */
import {
  FakePlaidApi,
  plaidAxiosError,
  PLAID_ERRORS,
  type PlaidAxiosLikeError,
} from '@connector/plaid/test';
import type { PlaidCredentials } from '@connector/plaid';
import { newId, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor, silentLogger } from '@core/platform';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules } from '../../src/modules.ts';
import {
  createStoredPlaid,
  withStoredPlaid,
  type PlaidApiFactory,
} from '../../src/plaid-stored.ts';
import {
  assertRegistryIsComplete,
  EXEMPT_TABLES,
  TABLE_ORDER,
} from '../../src/reports/export/registry.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

/** Past the CSRF gate (a matching pair) but carrying no session a server ever issued: the route's own 401. */
const NO_SESSION = { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false };
const URL = '/connections/providers/plaid/credentials';

const CLIENT_ID = 'canaryclientid0123456789ab'; // gitleaks:allow — synthetic canary, not a Plaid credential
const SECRET = 'canarysecretZq7f8e7d6c5b4a3928170'; // gitleaks:allow — synthetic canary, not a Plaid credential
const REJECTED_CLIENT_ID = 'rejectedclientid0123456789'; // gitleaks:allow — synthetic canary, not a Plaid credential
const REJECTED_SECRET = 'rejectedsecretQ1w2e3r4t5y6u7i8'; // gitleaks:allow — synthetic canary, not a Plaid credential
const DOWN_CLIENT_ID = 'downclientid0123456789abcde'; // gitleaks:allow — synthetic canary, not a Plaid credential
const REPLACEMENT_SECRET = 'replacementsecretM9n8b7v6c5x4z3'; // gitleaks:allow — synthetic canary, not a Plaid credential

interface StatusBody {
  readonly configured: boolean;
  readonly source: 'files' | 'stored' | 'none';
  readonly env: 'sandbox' | 'production' | null;
  readonly clientIdHint: string | null;
  readonly rotatedAt: string | null;
  readonly productionAllowed: boolean;
}

/** `FakePlaidApi` whose link-token call can reject (as Plaid does a bad key) or be unreachable. */
class ScriptedPlaid extends FakePlaidApi {
  readonly #credentials: PlaidCredentials;
  readonly #mode: 'ok' | 'rejected' | 'down';
  readonly #onValidate: () => Promise<void>;

  constructor(
    credentials: PlaidCredentials,
    mode: 'ok' | 'rejected' | 'down',
    onValidate: () => Promise<void>,
  ) {
    super([]);
    this.#credentials = credentials;
    this.#mode = mode;
    this.#onValidate = onValidate;
  }

  override async linkTokenCreate(
    request: Parameters<FakePlaidApi['linkTokenCreate']>[0],
  ): ReturnType<FakePlaidApi['linkTokenCreate']> {
    await this.#onValidate();
    if (this.#mode === 'rejected') {
      const thrown: PlaidAxiosLikeError = plaidAxiosError(
        'link/token/create',
        {
          error_type: 'INVALID_INPUT',
          error_code: 'INVALID_API_KEYS',
          error_message: 'invalid client_id or secret provided',
          request_id: 'req-invalid-api-keys',
          status: 400,
        },
        request,
      );
      // What the real SDK does: the request config, and so the secret, rides on the error.
      thrown.config.headers['PLAID-SECRET'] = this.#credentials.secret;
      thrown.config.headers['PLAID-CLIENT-ID'] = this.#credentials.clientId;
      throw thrown;
    }
    if (this.#mode === 'down') {
      throw plaidAxiosError('link/token/create', PLAID_ERRORS.PLAID_INTERNAL, request);
    }
    return super.linkTokenCreate(request);
  }
}

function newTracker(rowCount: () => Promise<number>) {
  const created: { credentials: PlaidCredentials; api: ScriptedPlaid }[] = [];
  const rowCountsAtValidation: number[] = [];
  const factory: PlaidApiFactory = (credentials) => {
    const mode = credentials.clientId.startsWith('rejected')
      ? 'rejected'
      : credentials.clientId.startsWith('down')
        ? 'down'
        : 'ok';
    const api = new ScriptedPlaid(credentials, mode, async () => {
      rowCountsAtValidation.push(await rowCount());
    });
    created.push({ credentials: { ...credentials }, api });
    return api;
  };
  return { created, rowCountsAtValidation, factory };
}

async function rowCountOf(h: ApiHarness | undefined): Promise<number> {
  if (h === undefined) return 0;
  const result = await h.database.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM provider_credentials',
  );
  return result.rows[0]?.n ?? 0;
}

describe.skipIf(NO_DATABASE)('plaid credentials through the product (WP 10.1)', () => {
  let h: ApiHarness;
  let logs = '';
  const tracker = newTracker(() => rowCountOf(h));
  const logStream = { write: (chunk: string) => void (logs += chunk) };

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'provcred',
      appBuildsRegistry: true,
      plaidApiFactory: tracker.factory,
      logStream,
      env: { LOG_LEVEL: 'trace' },
    });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  const put = (body: unknown, session = h.fresh) =>
    h.request({ method: 'PUT', url: URL, session, body });
  const get = (session = h.stale) => h.request({ method: 'GET', url: URL, session });
  const remove = (session = h.fresh) => h.request({ method: 'DELETE', url: URL, session });
  const good = { clientId: CLIENT_ID, secret: SECRET, env: 'sandbox' };

  async function events(kindLike: string) {
    const result = await h.database.pool.query<{
      kind: string;
      outcome: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT kind, outcome, detail FROM security_events WHERE kind LIKE $1 ORDER BY occurred_at, id`,
      [kindLike],
    );
    return result.rows;
  }

  async function plaidConnectorListed(): Promise<boolean> {
    const response = await h.request({ method: 'GET', url: '/connectors', session: h.stale });
    expectStatus(response, 200);
    return (response.json() as { connectors: { provider: string }[] }).connectors.some(
      (c) => c.provider === 'plaid',
    );
  }

  it('PUT needs a fresh step-up, validates against Plaid before sealing, and GET never returns the secret', async () => {
    // Nothing is configured on a fresh install.
    const none = await get();
    expectStatus(none, 200);
    expect(none.json()).toEqual({
      configured: false,
      source: 'none',
      env: null,
      clientIdHint: null,
      rotatedAt: null,
      productionAllowed: false,
    });

    // No session: 401. A session without a step-up: 403 step_up_required. Neither stores anything.
    expect(
      (await h.request({ method: 'PUT', url: URL, body: good, session: NO_SESSION })).statusCode,
    ).toBe(401);
    const stale = await put(good, h.stale);
    expectStatus(stale, 403);
    expect(problemOf(stale)['code']).toBe('step_up_required');
    expect((await remove(h.stale)).statusCode).toBe(403);
    expect(await rowCountOf(h)).toBe(0);
    expect(tracker.created).toHaveLength(0);

    // Shape errors are 400 and never echo the value back.
    for (const bad of [
      { ...good, secret: 'has a space in it 12345' },
      { ...good, secret: 'short' },
      { ...good, env: 'development' },
      { clientId: CLIENT_ID },
    ]) {
      const response = await put(bad);
      expectStatus(response, 400);
      expect(response.body).not.toContain(SECRET);
      expect(response.body).not.toContain('has a space in it');
    }

    // Plaid rejects the key: 422, nothing sealed, an audit row, and no echo of the secret.
    const rejected = await put({
      clientId: REJECTED_CLIENT_ID,
      secret: REJECTED_SECRET,
      env: 'sandbox',
    });
    expectStatus(rejected, 422);
    expect(problemOf(rejected)['code']).toBe('provider_credentials.rejected');
    expect(rejected.body).not.toContain(REJECTED_SECRET);
    expect(rejected.body).not.toContain(REJECTED_CLIENT_ID);
    expect(await rowCountOf(h)).toBe(0);

    // Plaid unreachable: 502, nothing sealed.
    const down = await put({ clientId: DOWN_CLIENT_ID, secret: SECRET, env: 'sandbox' });
    expectStatus(down, 502);
    expect(problemOf(down)['code']).toBe('provider_credentials.provider_unavailable');
    expect(await rowCountOf(h)).toBe(0);

    // A good key: validated first (the row did not exist when Plaid was asked), then sealed.
    tracker.rowCountsAtValidation.length = 0;
    const ok = await put(good);
    expectStatus(ok, 200);
    expect(tracker.rowCountsAtValidation).toEqual([0]);
    const body = ok.json() as StatusBody;
    expect(body).toMatchObject({
      configured: true,
      source: 'stored',
      env: 'sandbox',
      clientIdHint: CLIENT_ID.slice(-4),
      rotatedAt: null,
      productionAllowed: false,
    });
    // The validation request carried the submitted credentials to the client factory.
    const validated = tracker.created.find((c) => c.credentials.clientId === CLIENT_ID);
    expect(validated?.credentials).toEqual({
      clientId: CLIENT_ID,
      secret: SECRET,
      environment: 'sandbox',
    });
    expect(validated?.api.countOf('link/token/create')).toBe(1);

    // Neither the PUT nor the GET response can carry the secret or the whole client id.
    for (const text of [ok.body, (await get()).body]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(CLIENT_ID);
    }

    // At rest: ciphertext in both columns, the hint in the clear, nothing else.
    const raw = await h.database.pool.query<{
      client_id_sealed: Buffer;
      secret_sealed: Buffer;
      client_id_hint: string;
      env: string;
    }>('SELECT client_id_sealed, secret_sealed, client_id_hint, env FROM provider_credentials');
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]?.secret_sealed.includes(Buffer.from(SECRET))).toBe(false);
    expect(raw.rows[0]?.client_id_sealed.includes(Buffer.from(CLIENT_ID))).toBe(false);
    expect(raw.rows[0]).toMatchObject({ client_id_hint: CLIENT_ID.slice(-4), env: 'sandbox' });

    // The audit trail: one row per outcome, none with a value.
    const audit = await events('provider_credentials.%');
    expect(audit.map((e) => `${e.kind}:${e.outcome}`)).toEqual([
      'provider_credentials.set:failure', // rejected
      'provider_credentials.set:failure', // unreachable
      'provider_credentials.set:success',
    ]);
    expect(audit[2]?.detail).toEqual({
      provider: 'plaid',
      env: 'sandbox',
      clientIdHint: CLIENT_ID.slice(-4),
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(audit)).not.toContain(REJECTED_SECRET);

    // Replacing is a rotation: audited as such, rotatedAt set, the new secret opens.
    const replaced = await put({ ...good, secret: REPLACEMENT_SECRET });
    expectStatus(replaced, 200);
    expect((replaced.json() as StatusBody).rotatedAt).not.toBeNull();
    expect((await events('provider_credentials.rotated')).map((e) => e.outcome)).toEqual([
      'success',
    ]);
    expect(await rowCountOf(h)).toBe(1);
    const { openProviderCredentials } = await import('@ctx/connections');
    const opened = await openProviderCredentials(
      h.database.db,
      h.security.requireSecretBox(),
      h.userId,
      'plaid',
    );
    expect(opened?.secret()).toBe(REPLACEMENT_SECRET);

    // Remove: step-up again, the row and its key go, the event says so, idempotently.
    const removed = await remove();
    expectStatus(removed, 200);
    expect(removed.json()).toMatchObject({ configured: false, source: 'none', env: null });
    expect(await rowCountOf(h)).toBe(0);
    const keys = await h.database.pool.query<{ retired_at: Date | null }>(
      `SELECT retired_at FROM encryption_keys WHERE scope = $1`,
      [`provider_credentials:${h.userId}.plaid`],
    );
    expect(keys.rows.length).toBeGreaterThan(0);
    expect(keys.rows.every((k) => k.retired_at !== null)).toBe(true);
    expect((await events('provider_credentials.removed')).map((e) => e.outcome)).toEqual([
      'success',
    ]);
    expectStatus(await remove(), 200);
    expect(await events('provider_credentials.removed')).toHaveLength(1);
  }, 90_000);

  it("another holder's stored credentials are invisible and untouchable through the routes", async () => {
    expectStatus(await put(good), 200);
    const otherUser = await h.database.createUser('Second Holder');
    const other = await h.issueSession({ userId: otherUser, fresh: true });

    const theirs = await get(other);
    expectStatus(theirs, 200);
    expect(theirs.json()).toMatchObject({ configured: false, source: 'none', clientIdHint: null });
    // Their DELETE removes nothing of the first holder's.
    expectStatus(await remove(other), 200);
    expect(await rowCountOf(h)).toBe(1);
    const mine = await get();
    expect(mine.json()).toMatchObject({ configured: true, source: 'stored' });
    expectStatus(await remove(), 200);
  }, 60_000);

  it('production is refused without PLAID_ALLOW_PRODUCTION', async () => {
    const before = tracker.created.length;
    const refused = await put({ ...good, env: 'production' });
    expectStatus(refused, 403);
    expect(problemOf(refused)['code']).toBe('provider_credentials.production_refused');
    expect(await rowCountOf(h)).toBe(0);
    // Refused before Plaid is asked anything.
    expect(tracker.created).toHaveLength(before);
    expect((await events('provider_credentials.set')).at(-1)).toMatchObject({
      outcome: 'blocked',
      detail: { reason: 'production_not_allowed' },
    });

    // The use-time gate: a production row that got in anyway (the flag removed after
    // it was stored) registers nothing, and the GET says it is not usable.
    expectStatus(await remove(), 200);
    const { setProviderCredentials } = await import('@ctx/connections');
    await h.database.db.transaction((tx) =>
      setProviderCredentials(
        tx,
        {
          provider: 'plaid',
          clientId: CLIENT_ID,
          secret: SECRET,
          env: 'production',
          secretBox: h.security.requireSecretBox(),
        },
        { userId: h.userId, clock: systemClock, correlationId: newId() },
      ),
    );
    const status = (await get()).json() as StatusBody;
    expect(status).toMatchObject({ source: 'stored', env: 'production', configured: false });
    expect(await plaidConnectorListed()).toBe(false);
    const linkToken = await h.request({
      method: 'POST',
      url: '/connections/plaid/link-token',
      session: h.stale,
    });
    expectStatus(linkToken, 503);
    expectStatus(await remove(), 200);

    // With the flag, production is accepted (a second app, same composition).
    const allowed = await createApiHarness({
      suite: 'provcredprod',
      appBuildsRegistry: true,
      plaidApiFactory: newTracker(() => Promise.resolve(0)).factory,
      env: { PLAID_ALLOW_PRODUCTION: 'true' },
    });
    try {
      const ok = await allowed.request({
        method: 'PUT',
        url: URL,
        session: allowed.fresh,
        body: { ...good, env: 'production' },
      });
      expectStatus(ok, 200);
      expect(ok.json()).toMatchObject({
        configured: true,
        source: 'stored',
        env: 'production',
        productionAllowed: true,
      });
    } finally {
      await allowed.close();
    }
  }, 120_000);

  it('operator files win over stored credentials, and the GET says so', async () => {
    const tracked = newTracker(() => Promise.resolve(0));
    const files = await createApiHarness({
      suite: 'provcredfiles',
      appBuildsRegistry: true,
      plaidApiFactory: tracked.factory,
      extraSecrets: {
        plaid_client_id: 'operatorclientid0123456789',
        plaid_secret: 'operatorsecretA1b2c3d4e5f6a7b8', // gitleaks:allow — synthetic sandbox-shaped fixture, not a credential
        plaid_env: 'sandbox',
      },
    });
    try {
      // A row stored earlier (before the operator wrote the files) is dormant, not used.
      const { setProviderCredentials } = await import('@ctx/connections');
      await files.database.db.transaction((tx) =>
        setProviderCredentials(
          tx,
          {
            provider: 'plaid',
            clientId: CLIENT_ID,
            secret: SECRET,
            env: 'sandbox',
            secretBox: files.security.requireSecretBox(),
          },
          { userId: files.userId, clock: systemClock, correlationId: newId() },
        ),
      );

      const status = await files.request({ method: 'GET', url: URL, session: files.stale });
      expectStatus(status, 200);
      expect(status.json()).toEqual({
        configured: true,
        source: 'files',
        env: 'sandbox',
        clientIdHint: null,
        rotatedAt: null,
        productionAllowed: false,
      });
      expect(status.body).not.toContain('operatorsecret');

      // Plaid is in the connector list through the operator's static registration; the
      // stored path never built a client.
      const connectors = await files.request({
        method: 'GET',
        url: '/connectors',
        session: files.stale,
      });
      expect(
        (connectors.json() as { connectors: { provider: string }[] }).connectors.map(
          (c) => c.provider,
        ),
      ).toContain('plaid');
      expect(tracked.created).toHaveLength(0);

      // A write is refused rather than stored and silently ignored.
      const refused = await files.request({
        method: 'PUT',
        url: URL,
        session: files.fresh,
        body: { ...good, secret: REPLACEMENT_SECRET },
      });
      expectStatus(refused, 409);
      expect(problemOf(refused)['code']).toBe('provider_credentials.managed_by_files');
      expect(tracked.created).toHaveLength(0);
      const rows = await rowCountOf(files);
      expect(rows).toBe(1); // still the dormant row, untouched
      const opened = await files.database.pool.query(
        `SELECT 1 FROM security_events WHERE kind = 'provider_credentials.set'`,
      );
      expect(opened.rowCount).toBe(0);
    } finally {
      await files.close();
    }
  }, 120_000);

  it('after PUT the connector is registered without a restart, on the api and on the worker (the event drops the cache)', async () => {
    expectStatus(await remove(), 200);
    const userId = h.userId;

    // --- the worker side, composed the way worker.ts composes it ---------------
    const workerStored = createStoredPlaid({
      config: h.config,
      database: h.database.db,
      secretBox: () => h.security.requireSecretBox(),
      apiFactory: tracker.factory,
    });
    const workerRegistry = withStoredPlaid(createConnectorRegistry(), workerStored);
    const logger = pino({ level: 'silent' });
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const modules = appModules({
      advisorsEnabled: true,
      localModelConfigured: false,
      database: h.database.db,
      userId,
      connectorRegistry: workerRegistry,
      orchestrator: createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger,
        registry: workerRegistry,
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

    // --- before: Plaid is nowhere, on either process ---------------------------
    expect(await plaidConnectorListed()).toBe(false);
    const before = await h.request({
      method: 'POST',
      url: '/connections/plaid/link-token',
      session: h.stale,
    });
    expectStatus(before, 503);
    expect(await workerRegistry.hasFor('plaid', userId)).toBe(false); // and now cached as "no"

    // --- the holder stores credentials; no restart -----------------------------
    expectStatus(await put(good), 200);

    // api: registered at once (the route dropped its own cache).
    expect(await plaidConnectorListed()).toBe(true);
    const after = await h.request({
      method: 'POST',
      url: '/connections/plaid/link-token',
      session: h.stale,
    });
    expectStatus(after, 200);
    expect((after.json() as { linkToken: string }).linkToken).toMatch(/^link-sandbox-/);
    const built = tracker.created.filter(
      (c) => c.credentials.clientId === CLIENT_ID && c.credentials.secret === SECRET,
    );
    expect(built.length).toBeGreaterThanOrEqual(2); // the validation client and the registered one
    expect(built.at(-1)?.api.countOf('link/token/create')).toBeGreaterThanOrEqual(1);

    // worker: its cached "no" stands until the event reaches its consumer...
    expect(await workerRegistry.hasFor('plaid', userId)).toBe(false);
    await pump.drain();
    // ...and then the next sync resolves the connector built from the sealed row.
    expect(await workerRegistry.hasFor('plaid', userId)).toBe(true);
    const connector = await workerRegistry.connectorFor('plaid', userId);
    expect(connector.provider).toBe('plaid');

    // --- and the other direction: removal reaches both -------------------------
    expectStatus(await remove(), 200);
    expect(await plaidConnectorListed()).toBe(false);
    expect(await workerRegistry.hasFor('plaid', userId)).toBe(true); // cached until the event
    await pump.drain();
    expect(await workerRegistry.hasFor('plaid', userId)).toBe(false);
  }, 120_000);

  it('a stored credential never appears in an export bundle', async () => {
    expectStatus(await put(good), 200);
    const response = await h.request({ method: 'GET', url: '/export', session: h.fresh });
    expectStatus(response, 200);
    const bundle = response.body;
    expect(bundle.length).toBeGreaterThan(100);
    expect(bundle).not.toContain(SECRET);
    expect(bundle).not.toContain(CLIENT_ID);
    expect(bundle).not.toContain('provider_credentials');
    expect(bundle).not.toContain('secret_sealed');
    // The sealed bytes themselves, in any encoding the bundle might use.
    const raw = await h.database.pool.query<{ s: Buffer }>(
      'SELECT secret_sealed AS s FROM provider_credentials',
    );
    const sealed = raw.rows[0]?.s ?? Buffer.alloc(0);
    expect(sealed.length).toBeGreaterThan(0);
    for (const encoded of [
      sealed.toString('base64'),
      sealed.toString('hex'),
      sealed.toString('base64url'),
    ]) {
      expect(bundle).not.toContain(encoded);
    }

    // The registry names the table as a reasoned deferral, and the completeness check passes.
    expect(TABLE_ORDER).not.toContain('provider_credentials');
    expect(EXEMPT_TABLES.get('provider_credentials')).toMatch(/never leaves the install/u);
    await expect(assertRegistryIsComplete(h.database.pool)).resolves.not.toThrow();
    expectStatus(await remove(), 200);
  }, 90_000);

  it('the secret never reaches a log line', async () => {
    // Every path a secret could travel, with the canary on each: accepted, rejected by
    // Plaid (the error carries the secret in its request config, as the real SDK's does),
    // refused for shape, refused for no session, refused for no step-up, replaced, read, removed.
    expectStatus(await put({ ...good, secret: SECRET }), 200);
    expectStatus(await put({ ...good, secret: REPLACEMENT_SECRET }), 200);
    expectStatus(
      await put({ clientId: REJECTED_CLIENT_ID, secret: REJECTED_SECRET, env: 'sandbox' }),
      422,
    );
    expectStatus(await put({ ...good, secret: `${SECRET} with a space` }), 400);
    expect(
      (await h.request({ method: 'PUT', url: URL, body: good, session: NO_SESSION })).statusCode,
    ).toBe(401);
    expectStatus(await put(good, h.stale), 403);
    expectStatus(await get(), 200);
    expectStatus(await remove(), 200);
    // The registered client is built (and logged about) on the next resolve.
    expectStatus(await put(good), 200);
    await plaidConnectorListed();
    expectStatus(await remove(), 200);

    // Not vacuous: the requests, and the registration line, are in the capture.
    expect(logs).toContain('/connections/providers/plaid/credentials');
    expect(logs).toContain('plaid configured from stored credentials; connector registered');
    expect(logs.length).toBeGreaterThan(5_000);

    for (const canary of [
      SECRET,
      REPLACEMENT_SECRET,
      REJECTED_SECRET,
      CLIENT_ID,
      REJECTED_CLIENT_ID,
    ]) {
      expect(logs.includes(canary), `a log line contains ${canary.slice(0, 8)}…`).toBe(false);
      // Nor a substantial fragment of it, which would catch a truncating logger.
      for (let i = 0; i + 12 <= canary.length; i += 6) {
        expect(
          logs.includes(canary.slice(i, i + 12)),
          `a log line contains a fragment of ${canary.slice(0, 8)}…`,
        ).toBe(false);
      }
    }
    expect(logs).not.toMatch(/PLAID-SECRET"?\s*:\s*"[^"[]/u);
  }, 90_000);
});
