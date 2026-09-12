// SPDX-License-Identifier: MIT
/**
 * **P0-5 evidence, the issuing half: _"session cookie attributes asserted by
 * test"_.**
 *
 * `csrf.test.ts` already asserts the attributes on the *clearing* path, because
 * `POST /auth/logout` is the one auth mutation that reaches a verdict with no
 * database behind it. That leaves a gap worth closing on its own: the attributes
 * a browser actually stores come from the **set** path, and a `Secure` dropped
 * from `setSessionCookies` would leave every assertion in that file green while
 * shipping a session cookie that travels over plain HTTP.
 *
 * So this file registers `@fastify/cookie` and one throwaway route per helper and
 * reads the real `Set-Cookie` headers Fastify serialises. No `AppConfig`, no
 * pool, no `buildApp`: the subject is `auth/cookies.ts` and nothing else, and a
 * failure here should name that file without a boot to read through.
 *
 * `__Host-` is the reason each attribute is checked rather than assumed. A
 * browser silently *ignores* a `__Host-` cookie that is not `Secure`, or has a
 * `Path` other than `/`, or carries any `Domain` at all — it does not warn, it
 * does not fail the response, the user simply cannot log in. That failure mode is
 * exactly the kind a test has to catch, because in production it looks like "the
 * session sometimes doesn't stick".
 */
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearSessionCookies,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  setCsrfCookie,
  setSessionCookies,
  type CookiePolicy,
} from '../src/auth/cookies.ts';

const SECURE: CookiePolicy = { secure: true };
/** The documented escape hatch: a plain-HTTP integration harness, never production. */
const INSECURE: CookiePolicy = { secure: false };

const ACCESS_TOKEN = 'access-jH2p9QvR6sT1uW4xY7zB0cD3eF5gH8iK';
const REFRESH_TOKEN = 'refresh-mN1oP4qR7sT0uV3wX6yZ9aB2cD5eF8g';
const CSRF_TOKEN = 'csrf-k4rGQ0mYd8Qw2lS7pV1xZaB3nC6tH9jU';
/** Eight hours: the D21 absolute session cap, so the number is not arbitrary. */
const REFRESH_MAX_AGE = 28_800;

async function build(policy: CookiePolicy): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  app.post('/set-session', (_request, reply) => {
    setSessionCookies(reply, policy, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      refreshMaxAgeSeconds: REFRESH_MAX_AGE,
    });
    return reply.send({ ok: true });
  });
  app.post('/set-csrf', (_request, reply) => {
    setCsrfCookie(reply, policy, CSRF_TOKEN);
    return reply.send({ ok: true });
  });
  app.post('/clear', (_request, reply) => {
    clearSessionCookies(reply, policy);
    return reply.send({ ok: true });
  });

  await app.ready();
  return app;
}

describe('session cookie attributes (P0-5)', () => {
  let app: FastifyInstance;
  let insecureApp: FastifyInstance;

  beforeAll(async () => {
    app = await build(SECURE);
    insecureApp = await build(INSECURE);
  });

  afterAll(async () => {
    await app.close();
    await insecureApp.close();
  });

  /**
   * The raw header, not Fastify's parsed view.
   *
   * `light-my-request` parses `Set-Cookie` for us, but a parser that normalises an
   * absent attribute to `undefined` reads the same whether the attribute was
   * omitted or misspelled. `Domain` is the one that matters most here, so the raw
   * string is checked alongside.
   */
  async function setCookies(instance: FastifyInstance, url: string) {
    const response = await instance.inject({ method: 'POST', url });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    return {
      parsed: Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie] as const)),
      raw: (Array.isArray(raw) ? raw : [raw ?? '']).join('\n'),
    };
  }

  it('issues the session and refresh cookies with every __Host- attribute', async () => {
    const { parsed, raw } = await setCookies(app, '/set-session');

    for (const name of [SESSION_COOKIE, REFRESH_COOKIE]) {
      const cookie = parsed[name];
      expect(cookie, `${name} was not set`).toBeDefined();
      // Secure + Path=/ + no Domain are the three conditions a browser checks
      // before it honours the `__Host-` prefix at all.
      expect(cookie?.secure).toBe(true);
      expect(cookie?.['path']).toBe('/');
      expect(cookie?.['domain']).toBeUndefined();
      // HttpOnly keeps an XSS payload from reading the token; SameSite=Strict is
      // the first of the three CSRF controls (the other two are in csrf.test.ts).
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe('Strict');
    }

    expect(parsed[SESSION_COOKIE]?.value).toBe(ACCESS_TOKEN);
    expect(parsed[REFRESH_COOKIE]?.value).toBe(REFRESH_TOKEN);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('gives the refresh cookie a Max-Age and the session cookie none', async () => {
    const { parsed } = await setCookies(app, '/set-session');

    // The access cookie is a browser *session* cookie on purpose: its real
    // lifetime is `idle_expires_at` on the row, and a `Max-Age` that disagreed
    // with it would only ever be wrong in one of the two directions.
    expect(parsed[SESSION_COOKIE]?.maxAge).toBeUndefined();
    expect(parsed[REFRESH_COOKIE]?.maxAge).toBe(REFRESH_MAX_AGE);
  });

  it('leaves the CSRF cookie readable by script and nothing else', async () => {
    const { parsed, raw } = await setCookies(app, '/set-csrf');
    const cookie = parsed[CSRF_COOKIE];

    // Readable is the entire point of a double submit: the browser has to echo it
    // into `X-CSRF-Token`. It authenticates nothing on its own.
    expect(cookie?.httpOnly).toBeFalsy();
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.['path']).toBe('/');
    expect(cookie?.['domain']).toBeUndefined();
    expect(cookie?.value).toBe(CSRF_TOKEN);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('clears all three with the same attributes, or the browser keeps them', async () => {
    const { parsed } = await setCookies(app, '/clear');

    for (const name of [SESSION_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
      // A browser matches a clearing cookie on name, path and domain. Clearing a
      // `Path=/` cookie with a `Path=/auth` delete is a no-op, and the session
      // survives a logout the user was told worked.
      expect(parsed[name]?.value).toBe('');
      expect(parsed[name]?.['path']).toBe('/');
      expect(parsed[name]?.['domain']).toBeUndefined();
      expect(parsed[name]?.secure).toBe(true);
      expect(parsed[name]?.sameSite).toBe('Strict');
    }
  });

  it('drops Secure only when the policy says so, and never the rest', async () => {
    // `SESSION_COOKIE_SECURE=false` exists for a plain-HTTP integration harness.
    // Worth pinning: it must weaken exactly one attribute. If it also dropped
    // `SameSite` or `HttpOnly`, a test harness setting would be a production
    // downgrade waiting for one copied `.env`.
    const { parsed } = await setCookies(insecureApp, '/set-session');

    for (const name of [SESSION_COOKIE, REFRESH_COOKIE]) {
      expect(parsed[name]?.secure).toBeFalsy();
      expect(parsed[name]?.httpOnly).toBe(true);
      expect(parsed[name]?.sameSite).toBe('Strict');
      expect(parsed[name]?.['path']).toBe('/');
      expect(parsed[name]?.['domain']).toBeUndefined();
    }
  });
});
