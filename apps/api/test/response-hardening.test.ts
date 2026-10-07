// SPDX-License-Identifier: MIT
/**
 * WP 9.11 — three Lows from WP 9.10, each a property of the real `buildApp`:
 *
 * - **G-05** (ZAP 10015/10049; ASVS V14.3.2): every API response carries
 *   `Cache-Control: no-store`. Authenticated JSON (`/auth/session`, accounts,
 *   insights…) carried no `Cache-Control` at all, so a shared or browser cache
 *   was free to keep financial data.
 * - **G-17** (SAB-31 green): the 1 MiB body limit refuses a body one byte over
 *   it — with a valid CSRF pair, so it is the limit and not the CSRF gate that
 *   answers (the Phase 1 gate's 403 at 2 MiB was the CSRF gate).
 * - **G-33** (SAB-37 green; ASVS V16.5.1): an unexpected exception thrown
 *   inside a route answers the fixed `internal_error` problem, with no message,
 *   stack or class name of the error in the body.
 */
import { loadConfig, type AppConfig } from '@core/config';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CSRF_COOKIE, CSRF_HEADER } from '../src/auth/cookies.ts';
import { createTempSecrets } from './helpers/secrets.ts';

const secrets = createTempSecrets();
const ORIGIN = 'https://fi.example.ts.net';
const TOKEN = 'k4rGQ0mYd8Qw2lS7pV1xZaB3nC6tH9jU'; // gitleaks:allow — synthetic fixture for the generic-500-body test (G-33), not a credential
const SECRET_MESSAGE = 'wp911-internal-detail postgres://user:hunter2@db/personalfi'; // gitleaks:allow — synthetic fixture for the generic-500-body test (G-33), not a credential

function testConfig(): AppConfig {
  return loadConfig({
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      SECRETS_DIR: secrets.dir,
      BASE_URL: ORIGIN,
      AUTH_ALLOWED_ORIGINS: ORIGIN,
      AUTH_RP_ID: 'fi.example.ts.net',
    },
  });
}

const unreachablePool = {
  connect: () => Promise.reject(new Error('ECONNREFUSED')),
  query: () => Promise.reject(new Error('ECONNREFUSED')),
} as unknown as pg.Pool;

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await buildApp({ config: testConfig(), pool: unreachablePool }));
  // A route that fails the way a bug does: an ordinary Error carrying
  // something internal, thrown from a handler.
  app.get('/__wp911/throws', async () => {
    const error = new TypeError(SECRET_MESSAGE);
    throw error;
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  secrets.dispose();
});

function sameOrigin(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: TOKEN, ...extra };
}

describe('G-05: Cache-Control: no-store on API responses', () => {
  it('on a success, an auth refusal, a problem, and an unknown route', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/auth/session' }),
      app.inject({ method: 'GET', url: '/ready' }),
      app.inject({ method: 'GET', url: '/no/such/route' }),
      app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { [CSRF_COOKIE]: TOKEN },
        headers: sameOrigin(),
      }),
    ]);
    for (const response of responses) {
      expect(response.headers['cache-control'], `${response.statusCode}`).toBe('no-store');
    }
  });
});

describe('G-17: the 1 MiB body limit', () => {
  it('a JSON body one byte over 1 MiB, with a valid CSRF pair, is refused 413', async () => {
    const limit = 1_048_576;
    const padding = 'x'.repeat(limit - '{"p":""}'.length + 1);
    const body = `{"p":"${padding}"}`;
    expect(Buffer.byteLength(body)).toBe(limit + 1);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [CSRF_COOKIE]: TOKEN },
      headers: sameOrigin({ 'content-type': 'application/json' }),
      payload: body,
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('positive control: the same request at exactly 1 MiB passes the limit', async () => {
    const limit = 1_048_576;
    const padding = 'x'.repeat(limit - '{"p":""}'.length);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [CSRF_COOKIE]: TOKEN },
      headers: sameOrigin({ 'content-type': 'application/json' }),
      payload: `{"p":"${padding}"}`,
    });
    expect(response.statusCode).not.toBe(413);
  });
});

describe('G-33: the generic 500', () => {
  it('an unexpected exception answers internal_error with nothing of the error in the body', async () => {
    const response = await app.inject({ method: 'GET', url: '/__wp911/throws' });
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = response.json() as Record<string, unknown>;
    expect(problem['code']).toBe('internal_error');
    expect(response.body).not.toContain('wp911-internal-detail');
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('TypeError');
    expect(response.body).not.toMatch(/\bat .+\.ts:\d+/);
    // Exactly the fixed problem: nothing a caller could learn about the failure.
    expect(problem).toEqual({
      type: 'https://personalfi.local/problems/internal_error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'The request could not be completed. Quote the correlation id when reporting this.',
      instance: '/__wp911/throws',
      code: 'internal_error',
      correlationId: response.headers['x-correlation-id'],
    });
  });
});
