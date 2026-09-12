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

  /**
   * Which process this is. One image, two commands (08 §3.2): `api` serves HTTP,
   * `worker` runs the consumer pump, the job runners, and the scheduler. Keeping
   * it in config rather than in the entrypoint means every log line and every
   * `config_snapshots` row says which role wrote it.
   */
  ROLE: z.enum(['api', 'worker']).default('api'),

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

  // --- Worker (WP 0.3) ---------------------------------------------------
  //
  // Every one of these has a defensible default; they exist so an operator can
  // slow the worker down on a small box without editing code, and so a test can
  // drive the loops fast without waiting out a production poll interval.

  /** Identifies this worker in `jobs.locked_by`. Defaults to a fresh uuid. */
  WORKER_ID: z.string().min(1).optional(),
  /** Jobs in flight in one worker process, across all kinds. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Fallback poll for the consumer pump. LISTEN/NOTIFY is the fast path. */
  EVENT_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(5_000),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(5_000),
  JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(250).default(15_000),
  /** How long a graceful shutdown waits for in-flight jobs before aborting. */
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(30_000),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(250).default(30_000),

  // --- Readiness thresholds ----------------------------------------------

  /** Outbox lag above this marks `/ready` degraded. */
  READINESS_MAX_OUTBOX_LAG_EVENTS: z.coerce.number().int().min(0).default(1_000),
  /** A runnable job waiting longer than this marks `/ready` degraded. */
  READINESS_MAX_QUEUE_WAIT_SECONDS: z.coerce.number().int().min(0).default(900),
  /**
   * Whether a degraded platform makes `/ready` return 503.
   *
   * Off by default, and that is a deliberate operational choice rather than
   * laziness: the API is how the operator *sees* that the worker is wedged. An
   * API that takes itself out of rotation because a consumer is stuck hides the
   * maintenance page behind the very failure it is meant to report.
   */
  READINESS_FAIL_ON_DEGRADED: z.stringbool().default(false),
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
