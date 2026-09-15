// SPDX-License-Identifier: MIT
import { loadConfig, type AppConfig } from '@core/config';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { CORRELATION_ID_HEADER, buildApp } from '../src/app.ts';
import { createTempSecrets } from './helpers/secrets.ts';

/**
 * One temp secrets directory for the file, disposed at the end.
 *
 * `master_key` is required from WP 0.2 on, so `loadConfig` now fails without it —
 * which is the intended behaviour (a box that boots without the passphrase can
 * neither read a provider token nor write one) and is why the shell tests grew a
 * real directory instead of a stubbed reader.
 */
const secrets = createTempSecrets();

afterAll(() => {
  secrets.dispose();
});

function testConfig(): AppConfig {
  return loadConfig({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      SECRETS_DIR: secrets.dir,
    },
  });
}

/** A pool that never connects: readiness must degrade, not hang or crash. */
const unreachablePool = {
  connect: () => Promise.reject(new Error('ECONNREFUSED')),
  query: () => Promise.reject(new Error('ECONNREFUSED')),
} as unknown as pg.Pool;

describe('API shell', () => {
  it('answers /health without touching the database', async () => {
    // An orchestrator that restarts the API because Postgres is slow turns a
    // blip into an outage, so liveness must not depend on readiness.
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api', version: '0.1.0' });
    await app.close();
  });

  it('reports 503 problem details from /ready when the database is unreachable', async () => {
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json() as Record<string, unknown>;
    expect(problem['code']).toBe('database_unavailable');
    expect(problem['status']).toBe(503);
    expect(problem['type']).toBe('https://personalfi.local/problems/database_unavailable');
    expect(typeof problem['correlationId']).toBe('string');
    await app.close();
  });

  it('returns RFC 9457 problem details for an unknown route', async () => {
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json() as Record<string, unknown>;
    expect(problem['code']).toBe('route_not_found');
    // The client switches on `code`, never on `detail`; assert both exist.
    expect(problem['title']).toBe('Not Found');
    expect(problem['detail']).toContain('/nope');
    await app.close();
  });

  it('echoes a supplied correlation id and mints one otherwise', async () => {
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });

    const supplied = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { [CORRELATION_ID_HEADER]: 'sync-run-42' },
    });
    expect(supplied.headers[CORRELATION_ID_HEADER]).toBe('sync-run-42');

    const minted = await app.inject({ method: 'GET', url: '/health' });
    expect(minted.headers[CORRELATION_ID_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await app.close();
  });

  it('generates an OpenAPI document from the route schemas', async () => {
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });
    await app.ready();
    const spec = app.swagger() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/health']?.['get']?.operationId).toBe('getHealth');

    // The auth surface is part of the contract the generated frontend client is
    // built from: a route that exists on the server but not in the spec is a
    // route the UI cannot call, and nobody notices until it is in front of a user.
    const paths = Object.keys(spec.paths);
    for (const route of [
      '/health',
      '/ready',
      '/auth/unlock-state',
      '/auth/session',
      '/auth/register/options',
      '/auth/register/verify',
      '/auth/login/options',
      '/auth/login/verify',
      '/auth/totp/verify',
      '/auth/recovery-code/verify',
      '/auth/step-up/options',
      '/auth/step-up/verify',
      '/auth/refresh',
      '/auth/logout',
      '/auth/credentials',
      '/auth/totp/enroll',
      '/auth/totp/confirm',
      '/auth/recovery-codes',
      '/auth/events',
    ]) {
      expect(paths).toContain(route);
    }
    await app.close();
  });

  /**
   * Every `$ref` in the document resolves to a schema that is actually present.
   *
   * A regression test with an incident behind it: the swagger plugin was
   * registered with `transform` but not `transformObject`, so routes were
   * rewritten to `#/components/schemas/Problem` while `components.schemas` stayed
   * `{}`. Fastify serves that document without complaint — nothing validates a
   * served spec — and the damage lands a layer away, where `openapi-ts` turns
   * every dangling ref into `unknown`. A generated client that types its payloads
   * as `unknown` still compiles, which is what makes it expensive: the UI keeps
   * building, and the types stop meaning anything.
   *
   * Written against the whole document rather than a list of expected names, so
   * it covers the routes WP 0.3 onward adds without anyone remembering to extend
   * it.
   */
  it('emits a resolvable schema for every $ref it generates', async () => {
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });
    await app.ready();
    const spec = app.swagger() as {
      components?: { schemas?: Record<string, unknown> };
    };

    const defined = new Set(Object.keys(spec.components?.schemas ?? {}));
    expect(defined.size).toBeGreaterThan(0);

    const referenced = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') referenced.add(value);
        else walk(value);
      }
    };
    walk(spec);

    // Every ref is local and resolvable. A remote `$ref` would also be a bug here:
    // the spec is committed and consumed offline by the client generator.
    const dangling = [...referenced].filter((ref) => {
      const name = ref.replace('#/components/schemas/', '');
      return !ref.startsWith('#/components/schemas/') || !defined.has(name);
    });
    expect(dangling, `unresolvable $ref(s): ${dangling.join(', ')}`).toEqual([]);

    // The named response models the UI actually binds to. Listed explicitly
    // because the sweep above would still pass if they silently stopped being
    // hoisted and every route inlined its schema instead.
    for (const name of ['Problem', 'AuthOk', 'UnlockState', 'SessionState', 'Credential']) {
      expect(defined, `${name} must be a named schema`).toContain(name);
    }
    await app.close();
  });

  it('serves the OpenAPI document with a relative server URL under /api (C-1a)', async () => {
    // `openapi-ts` *could* bake `servers[0].url` into the frontend client as its
    // base URL, except `apps/web/openapi-ts.shared.mjs` sets `baseUrl: false`
    // specifically to stop that — see `app.ts`'s own comment on this field. An
    // absolute URL here would freeze the *generator's* host into the document
    // instead — the committed spec once carried `http://127.0.0.1:8080`, so
    // every call from `https://personalfi.lan` would have been cross-origin to
    // a loopback address: mixed content, CORS, and a request that never
    // arrives. `/api`, not `/`, since gate-security-review.md F-4/C-1a:
    // `docker/Caddyfile` now proxies exactly `handle_path /api/*` (stripped)
    // to this API, not the site root — `scripts/check-proxy-routes.ts` (C-1b)
    // asserts this value and the Caddyfile's routed prefix agree.
    const { app } = await buildApp({ config: testConfig(), pool: unreachablePool });
    await app.ready();

    const spec = app.swagger() as { servers?: { url: string }[] };
    expect(spec.servers).toEqual([{ url: '/api' }]);

    await app.close();
  });
});

/**
 * A request over a **real socket**, not `app.inject()`.
 *
 * Every other case in this file injects, which builds a fake request object with
 * no `raw`, no socket and no libuv handle. That gap hid a real defect: the H-3
 * redaction fix added a `formatters.log` hook, `formatters.log` runs *before*
 * pino's serializers, and so the hook received the whole live Fastify request
 * and walked it — socket, handle, getters that throw on a half-closed
 * connection. Every genuine HTTP request died mid-flight while the injected
 * suite stayed green; only `test/db/log-hygiene.test.ts`, which spawns the real
 * process, caught it.
 *
 * One real listen-and-fetch closes that gap cheaply, at the level where the
 * logging hooks actually run.
 */
describe('the shell serves a real socket, with logging enabled', () => {
  it('answers a request over TCP with request logging on', async () => {
    // `silent` would switch off the very hooks under test.
    const config = loadConfig({
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
        SECRETS_DIR: secrets.dir,
      },
    });
    const { app } = await buildApp({ config, pool: unreachablePool });
    await app.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');

      const response = await fetch(`http://127.0.0.1:${String(address.port)}/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get(CORRELATION_ID_HEADER)).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

/**
 * **M-1: `request.ip` must not be client-controlled.**
 *
 * `auth-flows.ts` keys the persisted rate limiter and the lockout on
 * `ip:${context.ip}`, and `context.ip` is `request.ip`. Under the previous
 * `trustProxy: true` the API would have taken the leftmost entry of a header the
 * client wrote, handing the attacker a fresh limiter subject per request. The
 * gate could not reproduce it — Caddy 2.11.4's empty `trusted_proxies` default
 * *replaces* `X-Forwarded-For` rather than appending to it — which is exactly the
 * problem: the control lived in a version-dependent default of another process,
 * with no test anywhere pinning it.
 *
 * These cases pin it here, where this application can be held to it.
 */
describe('trustProxy is a hop count, not a blanket trust (M-1)', () => {
  /** Echoes what the auth flows would key their limiter and lockout on. */
  async function ipSeenBy(trustProxy: string, forwardedFor: string): Promise<string> {
    const config = loadConfig({
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
        SECRETS_DIR: secrets.dir,
        TRUST_PROXY: trustProxy,
      },
    });
    const { app } = await buildApp({ config, pool: unreachablePool });
    app.get('/__ip', async (request) => ({ ip: request.ip }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/__ip',
      headers: { 'x-forwarded-for': forwardedFor },
    });
    await app.close();
    return (response.json() as { ip: string }).ip;
  }

  it('does not let a client-supplied chain reach past one hop', async () => {
    // The attack: the client writes two entries, hoping the leftmost — which it
    // fully controls and can vary per request — becomes the limiter subject.
    // With one hop trusted, only the rightmost entry (the one a real proxy
    // appended) is taken, and the spoofed value is discarded.
    const ip = await ipSeenBy('1', '203.0.113.77, 198.51.100.9');

    expect(ip).not.toBe('203.0.113.77');
    expect(ip).toBe('198.51.100.9');
  });

  it('discards a long spoofed chain entirely, however many entries it has', async () => {
    // Padding the chain is the obvious escalation: if the hop count were applied
    // from the left, or if trust were total, more entries would win.
    const ip = await ipSeenBy('1', '10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4, 203.0.113.77');

    expect(ip).toBe('203.0.113.77');
    for (const spoofed of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
      expect(ip).not.toBe(spoofed);
    }
  });

  it('ignores forwarded headers altogether at TRUST_PROXY=0', async () => {
    const ip = await ipSeenBy('0', '203.0.113.77, 198.51.100.9');

    expect(ip).not.toBe('203.0.113.77');
    expect(ip).not.toBe('198.51.100.9');
  });

  it('takes two hops only when two are configured', async () => {
    // The setting must actually mean something, or "default 1" is decoration.
    const ip = await ipSeenBy('2', '203.0.113.77, 198.51.100.9, 192.0.2.44');

    expect(ip).toBe('198.51.100.9');
  });
});
