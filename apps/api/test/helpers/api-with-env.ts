// SPDX-License-Identifier: MIT
/**
 * The real `buildApp`, with extra environment layered over the test config
 * (WP 9.6).
 *
 * `createApiHarness` hands `buildApp` a fixed config, and two of WP 9.6's
 * claims are about what the api does under a particular configuration: a local
 * model pinned (`LOCAL_MODEL_PIN_*`, CF-1) and narration text shown
 * (`NARRATION_TEXT_SHOWN`, R-2). The app below is the shipped composition —
 * `buildApp`, real guards, real routes — only the config differs; the session
 * helper is the harness's own (`security.requireIdentity().sessions.issue`).
 * No route double. Cheap enough to fold into `createApiHarness` as an `env`
 * option when someone owns that file again.
 */
import { loadConfig, type AppConfig } from '@core/config';
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import type { SecurityRuntime } from '../../src/auth/runtime.ts';
import { createConnectorRegistry } from '../../src/domain.ts';
import { TEST_ORIGIN } from './api-harness.ts';
import { createTempSecrets, type TempSecrets } from './secrets.ts';

const TEST_KDF = {
  KEK_ARGON2_MEMORY_KIB: '8192',
  KEK_ARGON2_TIME_COST: '2',
  KEK_ARGON2_PARALLELISM: '1',
} as const;

export interface EnvApiSession {
  readonly accessToken: string;
  readonly csrf: string;
}

export interface EnvApi {
  readonly app: FastifyInstance;
  readonly security: SecurityRuntime;
  readonly database: TestDatabase;
  readonly config: AppConfig;
  readonly fresh: EnvApiSession;
  readonly stale: EnvApiSession;
  issueSession(options?: { fresh?: boolean; userId?: string }): Promise<EnvApiSession>;
  request(options: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    session?: EnvApiSession;
    body?: unknown;
  }): Promise<{ statusCode: number; json(): unknown }>;
  close(): Promise<void>;
}

/** `suite` becomes part of the scratch database name (`personalfi_wp96_<suite>_<unique>`). */
export async function startApiWithEnv(
  suite: string,
  env: Record<string, string> = {},
): Promise<EnvApi> {
  const unique = newId().replaceAll('-', '').slice(-12);
  const database = await createTestDatabase(`personalfi_wp96_${suite}_${unique}`);
  const secrets: TempSecrets = createTempSecrets({});
  const config = loadConfig({
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: database.url,
      SECRETS_DIR: secrets.dir,
      BASE_URL: TEST_ORIGIN,
      AUTH_ALLOWED_ORIGINS: TEST_ORIGIN,
      AUTH_RP_ID: '127.0.0.1',
      ...TEST_KDF,
      ...env,
    },
  });
  const { app, security } = await buildApp({
    config,
    pool: database.pool,
    connectorRegistry: createConnectorRegistry(),
  });
  const state = await security.initialise();
  if (state.state !== 'unlocked') throw new Error(`could not unlock: ${JSON.stringify(state)}`);
  await app.ready();

  async function issueSession(
    options: { fresh?: boolean; userId?: string } = {},
  ): Promise<EnvApiSession> {
    const issued = await security.requireIdentity().sessions.issue({
      userId: options.userId ?? database.userId,
      authMethod: 'webauthn',
      fresh: options.fresh ?? false,
    });
    return {
      accessToken: issued.accessToken,
      csrf: Buffer.from(newId().replaceAll('-', ''), 'hex').toString('base64url').padEnd(40, 'x'),
    };
  }

  return {
    app,
    security,
    database,
    config,
    fresh: await issueSession({ fresh: true }),
    stale: await issueSession({ fresh: false }),
    issueSession,
    async request(options) {
      const headers: Record<string, string> = {
        'sec-fetch-site': 'same-origin',
        origin: TEST_ORIGIN,
      };
      if (options.session !== undefined) {
        headers['cookie'] =
          `__Host-pfi_session=${options.session.accessToken}; __Host-pfi_csrf=${options.session.csrf}`;
        headers['x-csrf-token'] = options.session.csrf;
      }
      const response = await app.inject({
        method: options.method,
        url: options.url,
        headers,
        ...(options.body === undefined ? {} : { payload: options.body as object }),
      });
      return { statusCode: response.statusCode, json: () => response.json() as unknown };
    },
    async close() {
      await app.close();
      security.destroy();
      secrets.dispose();
      await database.drop();
    },
  };
}
