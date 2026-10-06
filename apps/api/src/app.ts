// SPDX-License-Identifier: MIT
// `@fastify/cookie` is imported for its value (the plugin) *and* for the module
// augmentation it carries: `request.cookies`, `reply.setCookie` and
// `reply.clearCookie` only exist on the Fastify types once this module is part of
// the type program. Importing it here — the composition root, where the plugin is
// actually registered — is what makes `auth/cookies.ts` typecheck.
import fastifyCookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import type { AppConfig } from '@core/config';
import { createDatabase } from '@core/db';
import { OPENAPI_CONTRACT_VERSION } from '@core/contracts';
import { newId, systemClock, type Clock } from '@core/kernel';
import type { TransactionalExecutor } from '@core/platform';
import type { ConnectorRegistry } from '@ctx/connections';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { CookiePolicy } from './auth/cookies.ts';
import { assertCsrf, ensureCsrfCookie } from './auth/csrf.ts';
import { createGuards } from './auth/guards.ts';
import { SecurityRuntime } from './auth/runtime.ts';
import { seedUserState } from './bootstrap-seed.ts';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createMonteCarloRunnerFromCache,
  createWalletRpcRuntime,
  type DomainRuntime,
  type WalletRpcRuntime,
} from './domain.ts';
import { buildLoggerOptions } from './logging.ts';
import { createPreviewModel } from './modules.ts';
import { buildPlatform } from './platform.ts';
import { AppError, PROBLEM_CONTENT_TYPE, toProblem } from './problem.ts';
import { accountRoutes } from './routes/accounts.ts';
import { advisorGrantRoutes } from './routes/advisor-grants.ts';
import { advisorRunRoutes } from './routes/advisor-runs.ts';
import { assumptionsRoutes } from './routes/assumptions.ts';
import { authRoutes } from './routes/auth.ts';
import { briefRoutes } from './routes/brief.ts';
import { budgetRoutes } from './routes/budgets.ts';
import { categoryRoutes } from './routes/categories.ts';
import { connectionRoutes } from './routes/connections.ts';
import type { RouteDeps } from './routes/deps.ts';
import { eventRoutes } from './routes/events.ts';
import { exportRoutes } from './routes/export.ts';
import { goalRoutes } from './routes/goals.ts';
import { healthRoutes } from './routes/health.ts';
import { insightRoutes } from './routes/insights.ts';
import { investmentRoutes } from './routes/investments.ts';
import { marketDataRoutes } from './routes/market-data.ts';
import { netWorthRoutes } from './routes/net-worth.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { opsRoutes } from './routes/ops.ts';
import { plaidRoutes } from './routes/plaid.ts';
import { planRoutes } from './routes/plan.ts';
import { priceRoutes } from './routes/prices.ts';
import { recurringRoutes } from './routes/recurring.ts';
import { reportRoutes } from './routes/reports.ts';
import { ruleRoutes } from './routes/rules.ts';
import { securityRoutes } from './routes/securities.ts';
import { transactionRoutes } from './routes/transactions.ts';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
  /**
   * Optional platform handle. When supplied, `/ready` also reports outbox lag
   * and queue health. Optional rather than required so a test can build the
   * shell against an unreachable pool without a migrated database behind it.
   */
  readonly platformDb?: TransactionalExecutor;
  /** Injectable so a session-expiry test does not have to wait eight hours. */
  readonly clock?: Clock;
  /**
   * Injectable so a test can register a pre-loaded `SeedConnector` alongside the
   * real adapters. Production builds the registry from `domain.ts` and this is
   * the only way anything else gets into it.
   */
  readonly connectorRegistry?: ConnectorRegistry;
  /**
   * WP 3.9. The watch-only wallet runtime, when the caller built one.
   *
   * Only ever supplied alongside `connectorRegistry`: a test that registers its
   * own `WalletRpcConnector` must hand over the **same** runtime, because
   * `routes/connections.ts` drains the store's pending map after the link
   * commits and two stores would leave the descriptor staged forever. In
   * production this is absent and `buildApp` constructs it.
   */
  readonly walletRpc?: WalletRpcRuntime;
}

/**
 * The shell and the key custody that outlives one request.
 *
 * `security` is returned rather than hidden inside the instance because exactly
 * one caller needs it — `main.ts`, to zero the KEK on `SIGTERM` (P0-2). Hanging it
 * off `app` as a decorator would put the custodian of the key-encryption key on an
 * object that every plugin and every route handler already holds a reference to.
 */
export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly security: SecurityRuntime;
}

/**
 * The API shell.
 *
 * What this file owns is the cross-cutting behaviour every route inherits —
 * correlation ids, redacted structured logs, schema-first validation and
 * serialisation, RFC 9457 errors, cookie parsing and the CSRF gate — plus the
 * composition of the contexts whose routes it mounts.
 */
export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config, pool } = options;
  const clock = options.clock ?? systemClock;

  const app = Fastify({
    logger: buildLoggerOptions(config),
    // One correlation id per request, taken from the caller if it supplied one so
    // a browser, the API, and a worker job all appear under the same id. One id
    // reconstructs an entire sync.
    genReqId: (request) => {
      const supplied = request.headers[CORRELATION_ID_HEADER];
      if (typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128) {
        return supplied;
      }
      return newId();
    },
    requestIdHeader: false,
    // Every request log line keys the id as `correlationId`, matching the field
    // name a job or an event carries, so one grep spans HTTP and background work.
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    /**
     * Behind Caddy. Without this every request logs the proxy's address — and
     * every rate-limit and lockout subject becomes the proxy, which is worse.
     *
     * A **hop count**, never `true` (M-1). `true` means "trust any peer's
     * `X-Forwarded-For` in full", so `request.ip` becomes the leftmost entry of a
     * header the client wrote, and `auth-flows.ts` keys the persisted limiter and
     * the lockout on `ip:${context.ip}`. That did not reproduce as an exploit,
     * but only because Caddy 2.11.4's empty `trusted_proxies` default *replaces*
     * the header with the peer address instead of appending to it. The control
     * was inherited from a default in a file this process does not own, in a
     * version this process cannot see. With a count, exactly `TRUST_PROXY` entries
     * are taken off the right of the chain — the hops we actually deployed — and
     * anything a client prepended is ignored whatever the proxy decides to do.
     *
     * Written as a predicate rather than the bare number because Fastify's types
     * do not admit `number` even though `proxy-addr` beneath it does. This is
     * `proxy-addr`'s own numeric rule stated literally: trust hop `i` iff
     * `i < TRUST_PROXY`, counting from the socket peer inwards. `TRUST_PROXY=0`
     * makes it constantly false, which is "parse no forwarded headers at all".
     */
    trustProxy: (_address: string, hop: number) => hop < config.env.TRUST_PROXY,
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>();

  // Schema-first: one Zod schema per route validates the request, serialises the
  // response, and becomes the OpenAPI document. A response that does not match its
  // schema is a 500, not a silently wrong payload.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Parsing only. No `secret`, so no signed cookies: the session cookie is an
  // opaque 256-bit random token whose authority comes from a row in `sessions`,
  // and a signature over it would add a second key to protect for no gain.
  await app.register(fastifyCookie);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'PersonalFi API',
        description:
          'Self-hosted personal finance and advisory. Single user, zero public ingress. ' +
          'Errors are RFC 9457 problem details; clients switch on `code`, never on `detail`.',
        version: OPENAPI_CONTRACT_VERSION,
        license: { name: 'MIT', identifier: 'MIT' },
      },
      /**
       * Relative, deliberately — and now `/api`, not `/`.
       *
       * gate-security-review.md F-4/C-1a: `docker/Caddyfile` used to proxy three
       * hand-picked prefixes (`/auth/*`, `/health`, `/ready`) at the site root,
       * against an API that (by WP 1.5/1.3b) mounts eleven. The other eight fell
       * through to the SPA catch-all and answered `200 text/html` — silently
       * wrong, not an error. Routing by prefix at the root can never be fixed by
       * listing more prefixes: `/transactions` and `/accounts` are both SPA
       * routes (`apps/web/src/routes`) and API routes, distinguishable only by
       * `Accept`/`Sec-Fetch-Dest`, which `handle` blocks don't see.
       *
       * The fix is a namespace, not a bigger prefix list: Caddy now proxies
       * exactly `handle_path /api/*` (strips the prefix) to this API, and the
       * SPA owns every other path unconditionally. This app's own route paths
       * are unchanged — it still mounts `/auth/*`, `/health`, `/transactions`,
       * etc. at the root, same as always, because Caddy is the one stripping
       * `/api` before the request ever reaches `api:8080`.
       *
       * This document is generated at build time and `openapi-ts` *could* bake
       * `servers[0].url` into the frontend client as its base URL, except
       * `apps/web/openapi-ts.shared.mjs` sets `baseUrl: false` specifically to
       * stop that (see that file's own comment) — the real default lives in the
       * hand-written, regeneration-proof `apps/web/src/api/client-runtime-config.ts`
       * instead. `servers` here is still `/api`, not an absolute URL: an
       * absolute one would freeze whatever host the *generator* ran on into the
       * document (the old value was `http://127.0.0.1:8080`, the `BASE_URL`
       * default used by `emit-openapi`), which is wrong for every real
       * deployment and is exactly the mistake `baseUrl: false` exists to be
       * independent of. `/api` documents the contract truthfully — this is
       * where every operation in this document is actually reachable from a
       * browser — without being load-bearing for the generated client's
       * runtime behaviour. `scripts/check-proxy-routes.ts` (C-1b) asserts this
       * value and `docker/Caddyfile`'s routed prefix agree.
       */
      servers: [{ url: '/api' }],
      tags: [
        { name: 'system', description: 'Liveness, readiness, and operational endpoints.' },
        {
          name: 'auth',
          description:
            'Passkeys, TOTP fallback, recovery codes, sessions and step-up. Tokens travel in ' +
            '`__Host-` cookies and never in a response body.',
        },
        {
          name: 'accounts',
          description: 'Accounts, their latest balances, and net worth. Every balance says when.',
        },
        {
          name: 'transactions',
          description:
            'The feed, the overlay, splits, transfers and the CSV export. Pagination is keyset: ' +
            'pass `nextCursor` back verbatim.',
        },
        {
          name: 'connections',
          description:
            'Providers, the link and reconnect flows, sync history, and the server-sent event ' +
            'streams that carry sync progress.',
        },
        {
          name: 'categories',
          description:
            'The chart of categories this user may assign to. Per user (decision D6), seeded ' +
            'from the shipped taxonomy at boot, and editable by the user thereafter — so the ' +
            'list is read from the table, never from the constant.',
        },
        {
          name: 'rules',
          description:
            'The categorisation rule language, as CRUD, plus preview/apply and ' +
            '"always categorise like this transaction". A session is enough — see rules.ts\'s ' +
            'module comment for why this file does not need a step-up assertion.',
        },
        {
          name: 'reports',
          description:
            'Spending, income, the Sankey and budget-vs-actual — pure aggregation over the ' +
            "contexts' own read models. Transfers excluded and refunds netted, reusing " +
            "`@ctx/budgeting`'s rule rather than re-deriving it.",
        },
        {
          name: 'export',
          description:
            'The full-database bundle: export as a versioned, hash-checked JSONL stream, and ' +
            'import into a clean instance. Both need a step-up assertion.',
        },
        {
          name: 'budgets',
          description:
            'The envelope budget: periods, lines, assignments and rolls. A session is enough — ' +
            "every write here edits the user's own plan, never a credential.",
        },
        {
          name: 'recurring',
          description:
            'Subscriptions and bills: the candidate queue, confirmed streams, the forecast and ' +
            'safe-to-spend. A session is enough.',
        },
        {
          name: 'insights',
          description:
            'The advisory feed and the advisor registry: review an insight, and the three kill ' +
            'switches. Turning an advisor on/off or triggering a run needs a step-up assertion.',
        },
        {
          name: 'notifications',
          description:
            'Channels, rules and the delivery outbox. Attaching or destroying a channel needs a ' +
            "step-up assertion, the same policy as a connection's credential.",
        },
        {
          name: 'investments',
          description:
            'Holdings aggregated across accounts, per-account lots and basis provenance, ' +
            'allocation, drift, performance, securities and prices. `unclassifiedPct` and ' +
            '`stale` are always fields, never inferences; a time-weighted return, a ' +
            'money-weighted return and a dollar gain never share an object (07 §4.2). A ' +
            'session is enough to read and to set an overlay; the rung-1 price override and ' +
            'the sticky basis-method election need a step-up assertion.',
        },
        {
          name: 'planning',
          description:
            'Net worth over time. The series is gapless and a day with no data is `null`, not ' +
            'zero; sealed days are labelled as such. A correction never rewrites a sealed row — ' +
            'it writes the next revision with its reason — and needs a step-up assertion.',
        },
        {
          name: 'market-data',
          description:
            'Price-source priority, provider key **presence** (never a key value), rate ' +
            'budgets, the licence obligations that bind on any surface showing these numbers, ' +
            'and a guarded test fetch. Both writes need a step-up assertion.',
        },
      ],
    },
    transform: jsonSchemaTransform,
    /**
     * Hoist every `.meta({ id })` schema into `components.schemas`.
     *
     * `transform` alone rewrites a *route's* schema to a `$ref` but never emits
     * the thing being referenced, so the document ends up with
     * `#/components/schemas/Problem` pointing at an empty `components.schemas`.
     * Fastify serves it happily — nothing validates a served spec — and the
     * breakage lands one layer away, where `openapi-ts` generates the frontend
     * client and every dangling ref becomes `unknown`. A typed client that types
     * its payloads as `unknown` is worse than no client: it compiles.
     *
     * It emits two entries per schema — `Problem` and `ProblemInput` — because a
     * Zod schema's input and output types can differ (a `.default()` or a
     * `.transform()` makes them differ), so the library registers both halves
     * unconditionally. Every schema here is response-only, so the `*Input` half is
     * referenced by nothing in `paths` and reaches the frontend as ten unused
     * generated types. That is the library default and it stays: suppressing it
     * would mean post-processing the emitted document, and a hand-edited generated
     * artefact is a worse thing to own than ten dead type aliases.
     */
    transformObject: jsonSchemaTransformObject,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
  });

  /**
   * The CSRF gate, applied to **every** mutation in the application rather than to
   * the auth routes alone (P1-3).
   *
   * Mounting it at the root is the point: a cross-site `POST /connections` that
   * rides an ambient session cookie is exactly as damaging as a cross-site
   * `POST /auth/logout`, and a per-router hook is a control that a future router
   * forgets to add. `assertCsrf` returns immediately for safe methods, so the cost
   * on a `GET` is one `Set.has`.
   */
  const cookiePolicy: CookiePolicy = { secure: config.env.SESSION_COOKIE_SECURE };
  app.addHook('onRequest', async (request, reply) => {
    // The double-submit token is minted on *any* safe request, not only on an
    // `/auth/*` one (which is where WP 0.2 left it). A client whose first call is
    // `GET /transactions` must already hold a token by the time the user presses
    // "categorise", and a "fetch me a token" endpoint is one more failure mode
    // on the path to the first mutation.
    ensureCsrfCookie(request, reply, cookiePolicy);
    assertCsrf(request, { allowedOrigins: config.allowedOrigins, cookiePolicy });
  });

  app.setErrorHandler((error, request, reply) => {
    const { problem, family } = toProblem(error, String(request.id), request.url);

    if (family === 'internal') {
      request.log.error({ err: error, code: problem.code }, 'unhandled error');
    } else if (family === 'user') {
      request.log.info({ code: problem.code, status: problem.status }, 'request rejected');
    } else {
      request.log.warn({ err: error, code: problem.code }, 'request failed');
    }

    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const { problem } = toProblem(
      new AppError({
        status: 404,
        code: 'route_not_found',
        title: 'Not Found',
        detail: `No route for ${request.method} ${request.url}.`,
        family: 'user',
      }),
      String(request.id),
      request.url,
    );
    return reply.code(404).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  await app.register(
    healthRoutes({
      pool,
      version: OPENAPI_CONTRACT_VERSION,
      ...(options.platformDb === undefined ? {} : { platformDb: options.platformDb }),
      maxOutboxLagEvents: config.env.READINESS_MAX_OUTBOX_LAG_EVENTS,
      maxQueueWaitSeconds: config.env.READINESS_MAX_QUEUE_WAIT_SECONDS,
      failOnDegraded: config.env.READINESS_FAIL_ON_DEGRADED,
    }),
  );

  // Constructed, not initialised: deriving the KEK is six seconds of Argon2id and
  // must not happen inside `buildApp`, which `emit-openapi` and the shell tests
  // call with no database behind them. `main.ts` initialises before it listens;
  // `/auth/unlock-state` initialises lazily so that `just bootstrap-user` can
  // create the user while the API is already up.
  const security = new SecurityRuntime({ config, db: pool, clock, logger: app.log });

  await app.register(authRoutes({ runtime: security, cookiePolicy }));

  /**
   * The domain wiring, built on first use and then held.
   *
   * Lazy for the same reason `SecurityRuntime` is constructed rather than
   * initialised: the `SyncOrchestrator` needs the `SecretBox`, deriving the KEK
   * is six seconds of Argon2id, and `emit-openapi` builds this app with no
   * database behind it at all. `requireSecretBox()` throws the 503 problem that
   * names *why* the application is locked, which is the answer a route should
   * give — not a null dereference.
   */
  const database = createDatabase(pool);
  /**
   * WP 3.6's watch-only runtime, hoisted out of the registry construction.
   *
   * It used to be built inline in the registry call below, which made
   * its `store` unreachable from anything else. WP 3.9 needs it in one more
   * place: `routes/connections.ts` calls `store.persistPending(...)` after
   * `createConnection` commits, because `@ctx/connections` calls
   * `connector.connect()` *before* the `connections` row exists and `put` has
   * nowhere to write on a first link (`wp3.w-wiring.md` §10 item 8). Hoisting it
   * changes nothing about what is registered; it only gives the route file a
   * handle on the same store the connector holds.
   *
   * `options.walletRpc` exists for a test that injects its own registry: a
   * runtime and a registry built from it have to be the *same* store instance,
   * or `persistPending` would drain a map nothing staged into.
   */
  const walletRpc: WalletRpcRuntime =
    options.walletRpc ??
    createWalletRpcRuntime({
      database,
      allowedHosts: config.crypto.allowedHosts,
      etherscanApiKey: config.secrets.etherscan_api_key,
      // Phase 4 gate C-4 (G4-8), the api half: this runtime is built before
      // the application is unlocked (`security.requireSecretBox()` throws
      // until then), so the `SecretBox` is handed over as a thunk the store
      // resolves fresh on every read and write (`resolveWalletSecretBox`).
      // A wallet linked through the api is sealed exactly as one the worker
      // syncs; before this line the api path still wrote the descriptor in
      // the clear (wp5.13-carry-overs.md §4.2, wp5.14-quality.md §8 item 24).
      secretBox: () => {
        try {
          return security.requireSecretBox();
        } catch {
          return undefined;
        }
      },
    });
  const registry =
    options.connectorRegistry ??
    createConnectorRegistry({
      plaid: config.plaid,
      // WP 3.5. The API needs the adapter registered too, not only the worker:
      // `registry.manifests()` is what the "Add a connection" screen renders
      // from, and the link ceremony (`POST /connections`) runs inline here.
      coinbase: config.coinbase,
      // WP 3.6. The link ceremony for a watch-only wallet runs inline here —
      // `parseConnectInput` refuses private material at this seam, before
      // anything parses, stores, logs or sends it — so the API needs the
      // adapter and its store even though every *sync* happens in the worker.
      // `database` is available at this point (it is built one line up), which
      // is what lets the store be bound here rather than in
      // `createDomainRuntime` the way CSV's and Manual's are.
      walletRpc,
      clock,
      logger: app.log,
    });
  let domain: DomainRuntime | null = null;

  /**
   * WP 4.8. Built once, eagerly — it needs no `SecretBox` and does not
   * depend on the KEK the way `connections()` does. `createMonteCarloRunnerFromCache`
   * never substitutes the lognormal engine silently: with no return series on
   * disk (or a checksum mismatch) it logs and answers `null`, and every route
   * below treats that exactly as `refreshBaseline` does — fall back to the
   * deterministic engine and record which one ran, never invent a Monte Carlo
   * result.
   *
   * `config.planning.returnsCacheDir` (`PLANNING_RETURNS_CACHE_DIR`,
   * `packages/config/src/schema.ts`) landed after `wp4.w-wave-c-wiring.md`
   * §4.3 was written, with a doc comment saying "only `worker` ever reads
   * it" — written when only the worker had anywhere to bind a runner. This
   * process now has somewhere too (an interactive `POST .../projections`),
   * and reading a *different* cache directory than the worker would mean
   * the api and the worker could silently disagree about which return
   * series backs a Monte Carlo run in a deployment that sets the variable —
   * exactly the kind of drift 07 §7.3's "why did it say $720?" is about. So
   * this process reads the same config key. The one-line doc fix to that
   * comment ("only worker" → "worker and api") is `packages/config`'s file
   * to make, not this WP's; recorded in `docs/evidence/phase-4/
   * wp4.8-routes.md` "For the orchestrator" for whoever picks it up.
   */
  const monteCarlo = createMonteCarloRunnerFromCache({
    logger: app.log,
    ...(config.planning.returnsCacheDir === undefined
      ? {}
      : { cacheDir: config.planning.returnsCacheDir }),
    // `MONTE_CARLO_MAX_CONCURRENT` (W-B wiring, 05 §4 item 9): the api serves
    // the interactive route from this runner too, so it reads the cap as well.
    maxConcurrent: config.planning.monteCarloMaxConcurrent,
  });

  const deps: RouteDeps = {
    guards: createGuards(security),
    database,
    pool,
    clock,
    config,
    walletRpc,
    monteCarlo,
    connections(): DomainRuntime {
      const secretBox = security.requireSecretBox();
      // Rebuild if the runtime was destroyed and re-initialised: holding an
      // orchestrator around a zeroed SecretBox would fail at the first sealed
      // credential, a long way from the cause.
      if (domain === null || domain.secretBox !== secretBox) {
        domain = createDomainRuntime({
          database,
          clock,
          logger: app.log,
          registry,
          secretBox,
        });
      }
      return domain;
    },
  };

  await app.register(accountRoutes(deps));
  await app.register(transactionRoutes(deps));
  await app.register(connectionRoutes(deps));
  await app.register(categoryRoutes(deps));
  await app.register(ruleRoutes(deps));
  await app.register(plaidRoutes(deps));
  await app.register(eventRoutes(deps));
  await app.register(reportRoutes(deps));
  await app.register(exportRoutes(deps, { secretsDir: config.env.SECRETS_DIR }));
  await app.register(budgetRoutes(deps));
  await app.register(recurringRoutes(deps));
  await app.register(insightRoutes(deps));
  await app.register(notificationRoutes(deps));
  // WP 3.9. Five routers rather than one: they own disjoint path prefixes and
  // disjoint readers, and the plan assigns them as five files so a later wave
  // editing the market-data settings cannot collide with one editing holdings.
  await app.register(investmentRoutes(deps));
  await app.register(securityRoutes(deps));
  await app.register(priceRoutes(deps));
  await app.register(netWorthRoutes(deps));
  await app.register(marketDataRoutes(deps));
  // WP 4.8. Four routers, matching the dispatch's file split: `goals.ts`
  // (goals, contribution plans, the risk-profile questionnaire — WP 4.1's
  // domain), `plan.ts` (scenarios, life events, projections, required
  // savings, compare — WP 4.4/4.5/4.6), `assumptions.ts` (WP 4.2's cited
  // file and its overrides), `advisor-grants.ts` (the scope-consent route —
  // `grantScopes`'s first production caller).
  await app.register(goalRoutes(deps));
  await app.register(planRoutes(deps));
  await app.register(assumptionsRoutes(deps));
  await app.register(advisorGrantRoutes(deps));
  // WP 5.10 (05-phase-5-dispatch.md §3). Two routers, matching the dispatch's
  // file split: `brief.ts` (the Weekly Advisory Brief and the health-score
  // stub, under the existing `/insights` prefix) and `advisor-runs.ts` (the
  // run inspector, cancel, the payload preview/approval gate, the kind
  // switch and rule health, under the existing `/advisors` prefix). No
  // `docker/Caddyfile` edit needed — both prefixes already route to this
  // process (`scripts/check-proxy-routes.ts`).
  await app.register(briefRoutes(deps));
  // WP 9.6 (CF-1, C5-1, Phase 5 gate R-4): when a model is configured the api
  // binds the pure, preview-only `PromptRenderer` and registers
  // `local.narrator`'s manifest (never its executor, never an endpoint — the
  // api is given the model's name and digest, `LOCAL_MODEL_PIN_*`), so preview
  // and "Approve this payload" work through the product and the worker's next
  // narration is not refused `payload_not_approved`.
  await app.register(advisorRunRoutes(deps, createPreviewModel(config.localModelPin)));
  // WP 9.1 (09 §4 batch 3, W-A): `GET /ops/backup-status` — install-wide
  // backup and restore-drill status from `@core/platform`'s ops tables
  // (0036). Session only; nothing in the answer is a holder's.
  await app.register(opsRoutes(deps));

  /**
   * Idempotent repair pass for every user that already exists (condition D-6,
   * N-3, and Phase 2's **C-1**).
   *
   * The root fix — seeding a brand-new user's taxonomy, advisor catalogue and
   * schedules **at creation**, not at the next boot — is
   * `./bootstrap-seed.ts`'s `seedUserState`, called from `bin/bootstrap-user.ts`
   * the moment `createPrimary` returns. This hook is what that fix leaves
   * behind on purpose: a pass every api boot, over whichever user already
   * exists, so an *upgrade* — a release that adds a category, an advisor, or a
   * schedule this file did not know to seed when this user was created —
   * still reaches them. `seedUserState` is safe to call unconditionally here
   * for the same reason `bootstrap-user.ts` calls it once: `ensureTaxonomy`
   * and `registerBuiltinAdvisors` write nothing on a row that already matches,
   * and `upsertSchedule`'s own `ON CONFLICT` never touches `enabled` or
   * `next_run_at` — a restart cannot silently re-enable a schedule the user
   * turned off, or reset one that is already pending.
   *
   * **Here rather than in a migration.** `categories` is `user_id`-scoped (D6),
   * and migrations run before any user exists — `just bootstrap-user` creates the
   * first one afterwards — so there is literally nothing for a migration to seed.
   * An applied migration is also immutable while `TAXONOMY` gains categories in
   * later releases, and transcribing ~130 rows into SQL would give the app two
   * copies of its own taxonomy for a release to drift apart.
   *
   * **Here rather than in `modules.ts` or in identity's user-creation path.**
   * `modules.ts` is the event-consumer registry and this is not a consumer;
   * hanging it off `UserService.createPrimary` would put a categorization
   * concern inside the identity context. "Which users exist?" is a question
   * only this file may ask — the composition root is the one place that knows
   * about every context involved — so it asks identity's own `UserService`
   * (`security.users()`, which is deliberately usable before the KEK exists).
   * `findPrimary` is today's whole answer because `createPrimary` refuses a
   * second user outright.
   *
   * **`onReady` rather than inline.** `buildApp` is called by `emit-openapi` and
   * by the shell tests with no database behind it at all; an inline await would
   * make every one of them pay a failing round trip before a single route was
   * registered. The hook runs once, after the routes are mounted and before the
   * socket accepts anything.
   *
   * **Logged and survived, never fatal**, for the same reason `main.ts` treats
   * the config snapshot that way: a database that is up but not yet migrated
   * should get an API that can *say so* on `/ready`, not a crash loop that tells
   * the operator nothing.
   */
  app.addHook('onReady', async () => {
    try {
      const primary = await security.users().findPrimary();
      if (primary === null) return;

      const platform = buildPlatform({ config, pool });
      const seeded = await seedUserState(database, platform.flags, {
        userId: primary.id,
        timezone: primary.displayTimezone,
        clock,
        correlationId: newId(),
        ...(config.secrets.advisor_token_secret === undefined
          ? {}
          : { advisorTokenSecret: config.secrets.advisor_token_secret.reveal() }),
      });
      await platform.flags.close();
      app.log.info({ userId: primary.id, ...seeded }, 'per-user state ensured (C-1 repair pass)');
    } catch (error) {
      app.log.warn({ err: error }, 'could not run the C-1 per-user repair pass; continuing');
    }
  });

  return { app, security };
}
