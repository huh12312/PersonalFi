// SPDX-License-Identifier: MIT
/**
 * The WP 1.5 route-test harness: a real API over a real database.
 *
 * Every suite under `test/db/` builds the *actual* application — `buildApp`, the
 * real guards, the real CSRF hook, the real error handler, the real Zod response
 * serialisers — against a scratch Postgres, and drives it with `app.inject`.
 * There is no route double anywhere and that is the point: the claims these
 * tests make are claims about HTTP (a 403 with `code: step_up_required`, a
 * cursor that survives a concurrent insert, an overlay that outlives a re-sync),
 * and a handler called directly as a function would prove none of them.
 *
 * ## Data arrives through a connector, never through an INSERT
 *
 * The ledger is filled by linking a `ManualConnector` and running a sync, which
 * is the same path a bank's rows take: `createConnection` → `SyncOrchestrator`
 * → `applyProviderTransactions` → `transactions_provider` → the read model. A
 * suite that seeded with raw SQL would be asserting against rows no production
 * code path can produce, and would keep passing after the apply layer broke.
 *
 * `manualStore` is exposed so a test can append a *second* batch and re-sync,
 * which is how "the user's overlay survives a provider restatement" is tested.
 *
 * ## The clock is injectable
 *
 * `buildApp` takes one, so the SSE heartbeat (15 s) can be tested in two seconds
 * of wall time by advancing a `MutableClock` rather than sleeping. Suites that
 * do not care pass nothing and get `systemClock`.
 */
import { CSV_MANIFEST, CsvImportConnector } from '@connector/csv';
import {
  MANUAL_MANIFEST,
  MANUAL_PROVIDER,
  ManualConnector,
  ManualStore,
  SEED_MANIFEST,
  SeedConnector,
} from '@connector/manual';
import { COINBASE_MANIFEST, type CoinbaseConnector } from '@connector/coinbase';
import { PLAID_MANIFEST, type PlaidConnector } from '@connector/plaid';
import type { PlaidApiFactory } from '../../src/plaid-stored.ts';
import { WALLETRPC_MANIFEST, WalletRpcConnector } from '@connector/walletrpc';
import { loadConfig, type AppConfig } from '@core/config';
import { newId, systemClock, type Clock } from '@core/kernel';
import { silentLogger, type HttpTransport, type Resolver } from '@core/platform';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';
import { ConnectorRegistry, SyncOrchestrator } from '@ctx/connections';
// `InjectOptions`/`LightMyRequestResponse` are re-exported by Fastify itself, so
// the harness does not add `light-my-request` as a direct dependency of the app
// just to name the type of something `app.inject` already returns.
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.ts';
import type { SecurityRuntime } from '../../src/auth/runtime.ts';
import { createWalletRpcRuntime, ledgerWriter } from '../../src/domain.ts';
import { createTempSecrets, type TempSecrets } from './secrets.ts';

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/**
 * The origin every mutation in these suites claims to come from.
 *
 * `loadConfig` refuses a pairing in which no allowed origin could enrol a
 * passkey, so `AUTH_RP_ID` has to be this host and not the `localhost` default.
 */
export const TEST_ORIGIN = 'http://127.0.0.1:8080';

/**
 * One authenticated caller: the session cookie plus a matching CSRF pair.
 *
 * Both halves are needed because the CSRF gate is mounted at the root of the
 * application and applies to `POST /connections` exactly as it does to
 * `POST /auth/logout` — a test that only carried the session cookie would get a
 * 403 from every mutation and would be testing the gate by accident.
 */
export interface TestSession {
  readonly accessToken: string;
  readonly csrf: string;
  /** True when this session carries a step-up assertion from the last 5 minutes. */
  readonly fresh: boolean;
}

export interface ApiRequest {
  // `PUT` joined the list in WP 3.9: `/prices/{id}`, `/investments/basis-method`
  // and `/market-data/priority` are idempotent whole-resource writes, which is
  // what `PUT` means and what `POST` would have misreported.
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  /** Omit to send no session at all, which is how the 401s are tested. */
  readonly session?: TestSession;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Drop the `X-CSRF-Token` header while keeping the cookie, so a test can
   * sabotage the double-submit control specifically rather than by omission.
   */
  readonly omitCsrfHeader?: boolean;
}

export interface ApiHarness {
  readonly app: FastifyInstance;
  /** The configuration the app was built from. */
  readonly config: AppConfig;
  readonly database: TestDatabase;
  readonly security: SecurityRuntime;
  readonly userId: string;
  /** The `manual` provider's staging log. Append here, then re-sync. */
  readonly manualStore: ManualStore;
  /** Registered under `seed`, for the SSE suite's thousand-row backfill. */
  readonly seedConnector: SeedConnector;
  /**
   * The same shape `domain.ts#createDomainRuntime` builds, over this
   * harness's own registry and secret box. Exposed so a suite can run a sync
   * to completion directly — `POST /connections/{id}/sync` only *enqueues*
   * work for a non-process-local provider (Plaid included; see `domain.ts`'s
   * module comment), and nothing in this harness runs the worker that would
   * pick a queued job up. The live Sandbox smoke (wp1.3b-plaid-api.md §5)
   * is the motivating caller: it links through the real HTTP route, then
   * calls `orchestrator.syncConnection(...)` directly to observe a real,
   * completed sync against Plaid Sandbox.
   */
  readonly orchestrator: SyncOrchestrator;
  /** A session with a step-up assertion. Everything works with this one. */
  readonly fresh: TestSession;
  /** A session without one: reads work, `create`/`delete`/`export` do not. */
  readonly stale: TestSession;
  /** Mint another session, e.g. one belonging to a second account holder. */
  issueSession(options?: { fresh?: boolean; userId?: string }): Promise<TestSession>;
  request(options: ApiRequest): Promise<LightMyRequestResponse>;
  /** Listen on an ephemeral port and return the base URL. For the SSE suite. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Becomes part of the scratch database name; keep it short and unique. */
  readonly suite: string;
  readonly clock?: Clock;
  /** Rows per page from the manual adapter. Small values exercise pagination. */
  readonly manualPageSize?: number;
  /**
   * A `PlaidConnector` wired to `FakePlaidApi` (`@connector/plaid/test`), for
   * the `wp1.3b-plaid-api` route suites. Not built via `createConnectorRegistry`
   * (`domain.ts`) — that constructs a real, network-bound client from
   * `AppConfig.plaid`, and a route test must never dial out. Passing one in
   * here is the same seam `seedConnector` already uses.
   */
  readonly plaidConnector?: PlaidConnector;
  /**
   * A `CoinbaseConnector` wired to a fake transport (`@connector/coinbase/test`'s
   * `FakeCoinbaseApi`), for `coinbase-routes.test.ts` (WP 4.12b, C-4). The same
   * seam as `plaidConnector` above, for the same reason: `createConnectorRegistry`
   * (`domain.ts`) always builds a real, network-bound `fetchTransport()` for
   * Coinbase, and a route test must never dial out.
   */
  readonly coinbaseConnector?: CoinbaseConnector;
  /**
   * Extra file secrets under `SECRETS_DIR`, name → contents. WP 3.13's
   * `export-encrypt.test.ts` is the motivating caller: `?encrypt=true`
   * (`routes/export.ts`) reads `age_recipients` from this directory, and
   * there was previously no way for a test to put one there — every other
   * suite either never exercises the encrypted branch or asserts only its
   * absence (`AgeUnavailableError`, mapped to a 503).
   */
  readonly extraSecrets?: Readonly<Record<string, string>>;
  /**
   * WP 3.9: register the watch-only `wallet_rpc` connector, bound to the same
   * `WalletRpcRuntime` this harness hands `buildApp`.
   *
   * Off by default, and not because it is expensive — `connect()` performs no
   * I/O at all. `connections-routes.test.ts` asserts `GET /connectors` against
   * an *exact* sorted provider list, so registering a fifth adapter for every
   * suite would turn that assertion red for a reason unrelated to what it is
   * about. Opting in per suite keeps both claims true.
   *
   * The runtime must be the **same object** the app's `RouteDeps.walletRpc`
   * holds: `routes/connections.ts` drains the store's request-scoped pending
   * map after the link commits (`wp3.w-wiring.md` §10 item 8), and two stores
   * would leave the descriptor staged forever and `wallet_addresses` empty.
   */
  readonly walletRpc?: boolean;
  /**
   * WP 10.1. Let `buildApp` build its **own** connector registry, exactly as
   * production does (`createConnectorRegistry` + `withStoredPlaid`), instead of
   * the harness's hand-built one. The suites that prove Plaid is registered from
   * the holder's stored credentials need the shipped composition (C5-11), not a
   * parallel one. The manual/seed/plaid doubles above are not registered then.
   */
  readonly appBuildsRegistry?: boolean;
  /** WP 10.1. Builds the Plaid client for stored credentials; a test hands back `FakePlaidApi`. */
  readonly plaidApiFactory?: PlaidApiFactory;
  /** WP 10.1. Where the app's request logger writes, so a suite can read every line. */
  readonly logStream?: { write(chunk: string): void };
  /** WP 10.1. Extra environment for `loadConfig` (`PLAID_ALLOW_PRODUCTION`, `LOG_LEVEL`, …). */
  readonly env?: Readonly<Record<string, string>>;
  /** WP 10.4. The socket under the market-data adapters; a test hands `createFakeTransport`'s. */
  readonly marketDataTransport?: HttpTransport;
  /** WP 10.4. DNS for that seam; defaults to a public address so the egress guard passes. */
  readonly marketDataResolve?: Resolver;
}

/**
 * The development KDF floor.
 *
 * Six seconds of Argon2id per suite would dominate the runtime of every test
 * here, and none of them is about key derivation — `secretbox`'s own suite owns
 * that claim and P0-2's evidence comes from a real boot in `log-hygiene`.
 */
const TEST_KDF = {
  KEK_ARGON2_MEMORY_KIB: '8192',
  KEK_ARGON2_TIME_COST: '2',
  KEK_ARGON2_PARALLELISM: '1',
} as const;

function testConfig(
  secrets: TempSecrets,
  databaseUrl: string,
  extraEnv: Readonly<Record<string, string>> = {},
): AppConfig {
  return loadConfig({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: databaseUrl,
      SECRETS_DIR: secrets.dir,
      BASE_URL: TEST_ORIGIN,
      AUTH_ALLOWED_ORIGINS: TEST_ORIGIN,
      AUTH_RP_ID: '127.0.0.1',
      ...TEST_KDF,
      ...extraEnv,
    },
  });
}

export async function createApiHarness(options: HarnessOptions): Promise<ApiHarness> {
  const unique = newId().replaceAll('-', '').slice(-12);
  const database = await createTestDatabase(`personalfi_api_${options.suite}_${unique}`);
  const secrets = createTempSecrets(options.extraSecrets ?? {});

  const manualStore = new ManualStore();
  const seedConnector = new SeedConnector({ pageSize: options.manualPageSize ?? 200 });

  /**
   * The harness builds the registry rather than calling `createConnectorRegistry`.
   *
   * Not to avoid the production wiring but because a test has to *hold* the
   * `ManualStore` it stages rows into, and `createConnectorRegistry` constructs
   * one privately. The adapters are the same classes the composition root
   * registers, and `GET /connectors` is asserted against this list, so a
   * provider that stopped being registered in production would still be caught
   * by the separate assertion in `connections-routes.test.ts`.
   */
  // WP 3.9. Built here, not inside `buildApp`, precisely so the connector and
  // the route file share one store — see `HarnessOptions.walletRpc`.
  const walletRpc =
    options.walletRpc === true
      ? createWalletRpcRuntime({ database: database.db, allowedHosts: [] })
      : null;

  const registry = new ConnectorRegistry([
    { connector: new ManualConnector({ store: manualStore }), manifest: MANUAL_MANIFEST },
    { connector: new CsvImportConnector(), manifest: CSV_MANIFEST },
    { connector: seedConnector, manifest: SEED_MANIFEST },
    ...(options.plaidConnector === undefined
      ? []
      : [{ connector: options.plaidConnector, manifest: PLAID_MANIFEST }]),
    ...(options.coinbaseConnector === undefined
      ? []
      : [{ connector: options.coinbaseConnector, manifest: COINBASE_MANIFEST }]),
    ...(walletRpc === null
      ? []
      : [
          {
            connector: new WalletRpcConnector({
              store: walletRpc.store,
              esploraTransport: walletRpc.esploraTransport,
              etherscanTransport: walletRpc.etherscanTransport,
              etherscanApiKey: walletRpc.etherscanApiKey,
              clock: options.clock ?? systemClock,
            }),
            manifest: WALLETRPC_MANIFEST,
          },
        ]),
  ]);

  const config = testConfig(secrets, database.url, options.env);
  const built = await buildApp({
    config,
    pool: database.pool,
    ...(options.appBuildsRegistry === true ? {} : { connectorRegistry: registry }),
    ...(options.plaidApiFactory === undefined ? {} : { plaidApiFactory: options.plaidApiFactory }),
    ...(options.logStream === undefined ? {} : { logStream: options.logStream }),
    ...(options.marketDataTransport === undefined
      ? {}
      : {
          marketDataTransport: options.marketDataTransport,
          marketDataResolve:
            options.marketDataResolve ?? (() => Promise.resolve(['93.184.216.34'])),
        }),
    ...(walletRpc === null ? {} : { walletRpc }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const { app, security } = built;

  // `buildApp` constructs the runtime but never derives the KEK — `main.ts` does
  // that before it listens, and `emit-openapi` must not. A route test needs an
  // unlocked application, so the harness takes `main.ts`'s step explicitly.
  const state = await security.initialise();
  if (state.state !== 'unlocked') {
    throw new Error(`harness could not unlock the application: ${JSON.stringify(state)}`);
  }

  await app.ready();

  const orchestrator = new SyncOrchestrator({
    database: database.db,
    registry,
    secretBox: security.requireSecretBox(),
    ledgerWriter,
    clock: options.clock ?? systemClock,
    logger: silentLogger,
  });

  async function issueSession(
    sessionOptions: { fresh?: boolean; userId?: string } = {},
  ): Promise<TestSession> {
    const identity = security.requireIdentity();
    const issued = await identity.sessions.issue({
      userId: sessionOptions.userId ?? database.userId,
      authMethod: 'webauthn',
      fresh: sessionOptions.fresh ?? false,
    });
    return {
      accessToken: issued.accessToken,
      // Any 32+ byte value works: the control is that the cookie and the header
      // agree, not that the server minted the token.
      csrf: Buffer.from(newId().replaceAll('-', ''), 'hex').toString('base64url').padEnd(40, 'x'),
      fresh: sessionOptions.fresh ?? false,
    };
  }

  const fresh = await issueSession({ fresh: true });
  const stale = await issueSession({ fresh: false });

  let listening: string | null = null;

  return {
    app,
    config,
    database,
    security,
    userId: database.userId,
    manualStore,
    seedConnector,
    orchestrator,
    fresh,
    stale,
    issueSession,

    async request(request: ApiRequest): Promise<LightMyRequestResponse> {
      const cookies: string[] = [];
      const headers: Record<string, string> = {
        // The strongest of the three CSRF signals, and the one a browser on our
        // own origin actually sends. Supplying it keeps every mutation here
        // testing its *route*, while `csrf.test.ts` owns the gate itself.
        'sec-fetch-site': 'same-origin',
        origin: TEST_ORIGIN,
        ...request.headers,
      };

      if (request.session !== undefined) {
        cookies.push(`__Host-pfi_session=${request.session.accessToken}`);
        cookies.push(`__Host-pfi_csrf=${request.session.csrf}`);
        if (request.omitCsrfHeader !== true) {
          headers['x-csrf-token'] = request.session.csrf;
        }
      }
      if (cookies.length > 0) headers['cookie'] = cookies.join('; ');

      const injectOptions: InjectOptions = {
        method: request.method,
        url: request.url,
        headers,
        ...(request.body === undefined ? {} : { payload: request.body as object }),
      };
      return app.inject(injectOptions);
    },

    async listen(): Promise<string> {
      listening ??= await app.listen({ host: '127.0.0.1', port: 0 });
      return listening;
    },

    async close(): Promise<void> {
      // Order matters: the app holds the pool, and closing the pool first would
      // fail every in-flight request into an unhelpful error.
      await app.close();
      security.destroy();
      secrets.dispose();
      await database.drop();
    },
  };
}

/** Parse a problem-details body, asserting nothing. The suites do the asserting. */
export function problemOf(response: LightMyRequestResponse): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

/**
 * Fail with the response body rather than with `expected 500 to be 201`.
 *
 * A route test that dies on a status mismatch and prints no body costs ten
 * minutes of re-running with a `console.log` in it. This prints the problem
 * detail, which usually names the cause outright.
 */
export function expectStatus(response: LightMyRequestResponse, status: number): void {
  if (response.statusCode !== status) {
    throw new Error(
      `expected ${String(status)} from the route, got ${String(response.statusCode)}: ${response.body}`,
    );
  }
}

export interface ManualAccountInput {
  readonly providerAccountId: string;
  readonly name: string;
  readonly type: 'depository' | 'credit' | 'loan' | 'investment' | 'crypto' | 'manual';
  readonly currency: string;
}

export interface LinkedConnection {
  readonly connectionId: string;
  readonly providerConnectionId: string;
  readonly accountIds: readonly string[];
  readonly syncRunId: string | null;
}

/**
 * Stage a manual connection's opening batch, then link it over HTTP.
 *
 * The staging happens *before* `POST /connections` so the rows arrive on the
 * initial backfill, which is the path a real institution's history takes. The
 * alternative — link, then stage, then sync — exercises the incremental path
 * instead, and both are wanted; `appendManual` + `syncConnection` below are the
 * second half.
 */
export async function linkManual(
  h: ApiHarness,
  input: {
    readonly providerConnectionId: string;
    readonly displayName: string;
    readonly accounts: readonly ManualAccountInput[];
    readonly batch?: Parameters<ManualStore['append']>[1];
  },
): Promise<LinkedConnection> {
  h.manualStore.open(input.providerConnectionId);
  if (input.batch !== undefined) h.manualStore.append(input.providerConnectionId, input.batch);

  const response = await h.request({
    method: 'POST',
    url: '/connections',
    session: h.fresh,
    body: {
      provider: MANUAL_PROVIDER,
      input: {
        displayName: input.displayName,
        providerConnectionId: input.providerConnectionId,
        accounts: input.accounts,
      },
    },
  });
  expectStatus(response, 201);
  const body = response.json() as {
    connectionId: string;
    accountIds: string[];
    syncRunId: string | null;
  };
  return {
    connectionId: body.connectionId,
    providerConnectionId: input.providerConnectionId,
    accountIds: body.accountIds,
    syncRunId: body.syncRunId,
  };
}

/** `POST /connections/:id/sync`, asserting only that it was accepted. */
export async function syncConnection(
  h: ApiHarness,
  connectionId: string,
  session: TestSession = h.stale,
): Promise<Record<string, unknown>> {
  const response = await h.request({
    method: 'POST',
    url: `/connections/${connectionId}/sync`,
    session,
  });
  expectStatus(response, 202);
  return response.json() as Record<string, unknown>;
}

export { MANUAL_PROVIDER };
