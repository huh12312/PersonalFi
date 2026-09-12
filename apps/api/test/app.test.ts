// SPDX-License-Identifier: MIT
import { loadConfig, type AppConfig } from '@core/config';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { CORRELATION_ID_HEADER, buildApp } from '../src/app.ts';
import { REDACTED_PATHS } from '../src/logging.ts';
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

  it('redacts every credential-shaped field name', () => {
    // This list is a P0 control: no token and no account number may reach a log.
    for (const path of [
      '*.access_token',
      '*.client_secret',
      '*.account_number',
      '*.routing_number',
      '*.password',
      'req.headers.authorization',
      'req.headers.cookie',
    ]) {
      expect(REDACTED_PATHS).toContain(path);
    }
  });
});
