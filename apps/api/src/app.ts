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
import { createConnectorRegistry, createDomainRuntime, type DomainRuntime } from './domain.ts';
import { buildLoggerOptions } from './logging.ts';
import { AppError, PROBLEM_CONTENT_TYPE, toProblem } from './problem.ts';
import { accountRoutes } from './routes/accounts.ts';
import { authRoutes } from './routes/auth.ts';
import { connectionRoutes } from './routes/connections.ts';
import type { RouteDeps } from './routes/deps.ts';
import { eventRoutes } from './routes/events.ts';
import { healthRoutes } from './routes/health.ts';
import { plaidRoutes } from './routes/plaid.ts';
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
       * Relative, deliberately.
       *
       * This document is generated at build time and `openapi-ts` bakes
       * `servers[0].url` into the frontend client as its base URL. An absolute
       * one freezes whatever host the *generator* ran on into the bundle: the
       * committed spec carried `http://127.0.0.1:8080` (the `BASE_URL` default
       * used by `emit-openapi`), so every browser call from `https://personalfi.lan`
       * would have been cross-origin to a loopback address — a mixed-content
       * block, a CORS failure, and a request that never reaches the API, all from
       * a value nobody set on purpose.
       *
       * `/` makes the client same-origin by construction, which is also the only
       * deployment this application supports: the SPA is served from the same
       * Caddy site as the API. The externally visible URL is still in
       * `BASE_URL`, where operator-facing output (the `just bootstrap-user`
       * enrolment link) reads it.
       */
      servers: [{ url: '/' }],
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
  const registry =
    options.connectorRegistry ??
    createConnectorRegistry({ plaid: config.plaid, clock, logger: app.log });
  let domain: DomainRuntime | null = null;

  const deps: RouteDeps = {
    guards: createGuards(security),
    database,
    pool,
    clock,
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
  await app.register(plaidRoutes(deps));
  await app.register(eventRoutes(deps));

  return { app, security };
}
