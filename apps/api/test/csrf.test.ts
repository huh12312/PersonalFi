// SPDX-License-Identifier: MIT
/**
 * CSRF, asserted at the HTTP boundary (03 §3.4, P0-5, P1-3).
 *
 * Three independent controls, because `SameSite=Strict` alone has been quietly
 * bypassed too many times to be a plan: `Sec-Fetch-Site`, an `Origin` allow-list,
 * and a double-submit token. A mutation that can prove none of them is rejected —
 * fail closed.
 *
 * The hook is mounted at the root of the application rather than on the auth
 * router, so these assertions hold for every mutation WP 0.3 onward adds as well.
 * `/auth/logout` is the subject because it is the one mutation that reaches a
 * verdict without a database behind it.
 */
import { loadConfig, type AppConfig } from '@core/config';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, REFRESH_COOKIE } from '../src/auth/cookies.ts';
import { createTempSecrets } from './helpers/secrets.ts';
import type { FastifyInstance } from 'fastify';

const secrets = createTempSecrets();
const ORIGIN = 'https://fi.example.ts.net';

function testConfig(): AppConfig {
  return loadConfig({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      SECRETS_DIR: secrets.dir,
      BASE_URL: ORIGIN,
      AUTH_ALLOWED_ORIGINS: `${ORIGIN},https://fi.local`,
      // The allow-list serves WebAuthn as well as CSRF, and `loadConfig` now
      // refuses a pairing in which no origin could enrol a passkey (P0-4). The
      // second origin is deliberately *not* a subdomain of the RP id: it is the
      // CSRF-only entry, which is the case this suite is about.
      AUTH_RP_ID: 'fi.example.ts.net',
    },
  });
}

/** Never connects: nothing in this file may depend on a database. */
const unreachablePool = {
  connect: () => Promise.reject(new Error('ECONNREFUSED')),
  query: () => Promise.reject(new Error('ECONNREFUSED')),
} as unknown as pg.Pool;

const TOKEN = 'k4rGQ0mYd8Qw2lS7pV1xZaB3nC6tH9jU';

describe('CSRF', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildApp({ config: testConfig(), pool: unreachablePool }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    secrets.dispose();
  });

  /** A well-formed same-origin mutation, which the tests below then break. */
  function logout(
    overrides: {
      headers?: Record<string, string>;
      cookies?: Record<string, string>;
    } = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [CSRF_COOKIE]: TOKEN, ...overrides.cookies },
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        [CSRF_HEADER]: TOKEN,
        ...overrides.headers,
      },
    });
  }

  it('accepts a same-origin mutation carrying a matching token', async () => {
    const response = await logout();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('rejects a cross-site mutation on Sec-Fetch-Site alone', async () => {
    // The strongest signal available: it comes from the browser, not from the
    // page, so a malicious page cannot forge it.
    const response = await logout({
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'csrf_failed', status: 403 });
  });

  it('rejects a same-site mutation from a sibling subdomain', async () => {
    // `same-site` is not `same-origin`: `evil.example.ts.net` is same-site with
    // `fi.example.ts.net` and must not be trusted.
    const response = await logout({ headers: { 'sec-fetch-site': 'same-site' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'csrf_failed' });
  });

  it('rejects an origin that is not on the allow-list', async () => {
    const response = await logout({
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'csrf_failed' });
  });

  it('accepts every origin that is on the allow-list', async () => {
    // The list serves double duty — WebAuthn origin verification and this check —
    // precisely so the two cannot drift apart.
    const response = await logout({ headers: { origin: 'https://fi.local' } });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a mutation that can prove neither signal', async () => {
    // A browser always sends at least one on a cross-origin mutation. Neither
    // means a tool, and a tool has no business posting with an ambient cookie.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [CSRF_COOKIE]: TOKEN },
      headers: { [CSRF_HEADER]: TOKEN },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'csrf_failed' });
  });

  it('rejects a mutation with no double-submit token', async () => {
    const withoutHeader = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [CSRF_COOKIE]: TOKEN },
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    });
    expect(withoutHeader.statusCode).toBe(403);

    const withoutCookie = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: TOKEN },
    });
    expect(withoutCookie.statusCode).toBe(403);
  });

  it('rejects a mismatched double-submit token', async () => {
    const response = await logout({ headers: { [CSRF_HEADER]: `${TOKEN}x` } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'csrf_failed' });
  });

  it('guards every unsafe method, not only POST', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
      const response = await app.inject({
        method,
        url: '/auth/credentials/0192f3c1-0000-7000-8000-000000000001',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'csrf_failed' });
    }
  });

  it('never blocks a safe method', async () => {
    // A GET that changes state is a bug to fix at the route, not a case to
    // handle here.
    for (const url of ['/health', '/ready']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      });
      expect(response.statusCode).not.toBe(403);
    }
  });

  it('mints a CSRF cookie on an auth GET so the login POST has one to echo', async () => {
    // A login page that must first call a "get me a token" endpoint is a login
    // page with an extra failure mode.
    const response = await app.inject({ method: 'GET', url: '/auth/unlock-state' });
    const cookie = response.cookies.find((entry) => entry.name === CSRF_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.value.length).toBeGreaterThanOrEqual(32);
    // Readable by our own script — that is the entire point of a double submit —
    // and by nobody else's, which is what `__Host-` and `SameSite` buy.
    expect(cookie?.httpOnly).toBeFalsy();
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.['path']).toBe('/');
    expect(cookie?.['domain']).toBeUndefined();
  });

  it('keeps the CSRF cookie the browser already has', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/unlock-state',
      cookies: { [CSRF_COOKIE]: TOKEN },
    });
    expect(response.cookies.find((entry) => entry.name === CSRF_COOKIE)).toBeUndefined();
  });

  it('clears every auth cookie on logout with __Host- attributes intact', async () => {
    const response = await logout();
    const cleared = Object.fromEntries(
      response.cookies.map((cookie) => [cookie.name, cookie] as const),
    );

    for (const name of [SESSION_COOKIE, REFRESH_COOKIE]) {
      // `__Host-` is only honoured for a Secure, Path=/, Domain-less cookie, so
      // the clearing cookie has to carry the same attributes or the browser
      // keeps the original (P0-5).
      expect(cleared[name]?.secure).toBe(true);
      expect(cleared[name]?.httpOnly).toBe(true);
      expect(cleared[name]?.sameSite).toBe('Strict');
      expect(cleared[name]?.['path']).toBe('/');
      expect(cleared[name]?.['domain']).toBeUndefined();
      expect(cleared[name]?.value).toBe('');
    }
    expect(cleared[CSRF_COOKIE]?.httpOnly).toBeFalsy();
  });

  it('names every session cookie with the __Host- prefix', () => {
    for (const name of [SESSION_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
      expect(name.startsWith('__Host-')).toBe(true);
    }
  });
});
