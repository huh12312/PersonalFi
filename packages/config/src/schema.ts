// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * Non-secret deployment configuration. Env vars only.
 *
 * User *preferences* (base currency, budget period start, quiet hours, feature
 * toggles) deliberately do not live here: they are user data, must be editable in
 * the UI, and must land in the export and the backup. They live in the database.
 */
export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Absolute, externally visible base URL. Used for OpenAPI servers and links. */
  BASE_URL: z.url().default('http://127.0.0.1:8080'),

  /**
   * Postgres connection string. May instead be supplied as a secret file, which
   * is the production posture: the password must not sit in `docker inspect`.
   */
  DATABASE_URL: z
    .string()
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// URL',
    })
    .optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(64).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),

  /** Directory holding file-mounted secrets. Docker secrets default to /run/secrets. */
  SECRETS_DIR: z.string().min(1).default('/run/secrets'),

  /** Refuse to start if a real provider credential is present (08 §6.8). */
  DEMO_MODE: z.stringbool().default(false),
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;

/**
 * Declared secrets. Each is read from `${SECRETS_DIR}/<file>`; nothing here is
 * ever read from an env var in production.
 *
 * WP 0.2 adds `master_key`, and WP 0.1 deliberately does not: key custody is that
 * work package's decision to make, not this one's.
 */
export const SECRET_SPECS = [
  {
    name: 'database_url',
    file: 'database_url',
    required: false,
    envFallback: 'DATABASE_URL',
    hint: 'write the Postgres URL to ${SECRETS_DIR}/database_url, or set DATABASE_URL for local dev',
  },
] as const;

export type SecretName = (typeof SECRET_SPECS)[number]['name'];
