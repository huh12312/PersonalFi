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
   * Which process this is. One image, several commands (08 §3.2, D13): `api`
   * serves HTTP, `worker` runs the consumer pump, the job runners and the
   * scheduler, `migrator` is the one-shot that applies migrations before either
   * starts, and `cli` covers the operator commands (`bootstrap-user`, an ad-hoc
   * `migrate`). Keeping it in config rather than in the entrypoint means every log
   * line and every `config_snapshots` row says which role wrote it.
   *
   * **This list must stay a superset of the roles anything else can set.** It is
   * validated at boot, before a socket is opened or a migration is applied, so a
   * role missing from here is not a mislabelled log line — it is a container that
   * exits 78 and takes the stack down with it. Two places set it:
   *
   * - `docker/entrypoint.mjs`, whose `ENTRYPOINTS` map dispatches on the same
   *   strings (`api`, `worker`, `migrator`);
   * - `ProcessRole` in `@core/platform`, the type `recordConfigSnapshot` accepts.
   *
   * They cannot share one type: `@core/config` may import nothing but
   * `@core/kernel`, and `@core/platform` may not import `@core/config` at all, so
   * the arrows never point back. `load.test.ts` pins the set instead.
   */
  ROLE: z.enum(['api', 'worker', 'migrator', 'cli']).default('api'),

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

  // ---------------------------------------------------------------- key custody
  //
  // Argon2id parameters for the KEK derivation (03 §2.2, P0-2). Defaults are the
  // memo's numbers: m = 1 GiB, t = 4, p = 4, measured at 5.9 s on the dev box.
  // They are configurable because a 1 GiB derivation is not viable on every
  // machine this might run on, and floored because a configurable security
  // parameter with no floor is a security parameter that ends up at the default
  // of whichever tutorial the operator read. The floor is enforced in
  // `loadConfig`, and it is strictly higher when `NODE_ENV=production`.
  //
  // The ceiling is measured, not chosen: `hash-wasm` runs on wasm32, so 2 GiB
  // fails with `Invalid typed array length`. See
  // docs/evidence/phase-0/wp0.2-argon2-parameters.md.
  KEK_ARGON2_MEMORY_KIB: z.coerce.number().int().min(8_192).max(1_835_008).default(1_048_576),
  KEK_ARGON2_TIME_COST: z.coerce.number().int().min(1).max(64).default(4),
  KEK_ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(4),

  // ------------------------------------------------------------ authentication
  //
  // The WebAuthn Relying Party id: the exact hostname served. 03 §3.2 is blunt
  // about this — changing it invalidates every passkey, so a Tailscale-name →
  // custom-domain migration mid-project costs Chris his credentials. Fix it early.
  AUTH_RP_ID: z.string().min(1).default('localhost'),
  AUTH_RP_NAME: z.string().min(1).default('PersonalFi'),
  /**
   * Comma-separated allow-list of origins. Serves double duty: WebAuthn origin
   * verification and the CSRF `Origin`/`Sec-Fetch-Site` check, which must agree —
   * two lists that can drift is how a CSRF hole opens quietly.
   */
  AUTH_ALLOWED_ORIGINS: z.string().min(1).default('http://localhost:8080'),

  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(28_800),
  /** Trusted-device refresh window (D21: 14 days under rotation with reuse detection). */
  SESSION_TRUSTED_TTL_SECONDS: z.coerce.number().int().min(3_600).max(7_776_000).default(1_209_600),
  /** How long a fresh WebAuthn assertion keeps a session step-up eligible. */
  SESSION_STEP_UP_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  /**
   * Only ever false for a plain-HTTP integration test harness. Browsers treat
   * `localhost` as a secure context, so development does not need it off.
   */
  SESSION_COOKIE_SECURE: z.stringbool().default(true),
  /** Fixed latency floor on auth failures, so TOTP-vs-unknown cannot be timed apart. */
  AUTH_FAILURE_DELAY_MS: z.coerce.number().int().min(0).max(5_000).default(250),
});

export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export interface Argon2Params {
  readonly memoryKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * Minimum acceptable Argon2id parameters for the KEK.
 *
 * Two floors, and the difference between them is deliberate rather than a
 * convenience hole:
 *
 * - **production** is the memo's number verbatim (03 §2.2, P0-2): m = 1 GiB,
 *   t = 4, p = 4. A production container that tries to derive the KEK with less
 *   refuses to boot.
 * - **development** exists because the unit suite derives a KEK dozens of times
 *   and 5.9 s each would make it unrunnable. It is not reachable when
 *   `NODE_ENV=production`; `loadConfig` picks the floor from `NODE_ENV`, not from
 *   a separate setting an operator could flip.
 *
 * Measured on the dev box (Node 26, linux/x64): m=1 GiB/t=4/p=4 → 5.9 s;
 * m=8 MiB/t=2/p=1 → ~5 ms. See docs/evidence/phase-0/wp0.2-argon2-parameters.md.
 */
export const KEK_ARGON2_FLOORS: Readonly<Record<'production' | 'development', Argon2Params>> =
  Object.freeze({
    production: Object.freeze({ memoryKiB: 1_048_576, timeCost: 4, parallelism: 4 }),
    development: Object.freeze({ memoryKiB: 8_192, timeCost: 2, parallelism: 1 }),
  });

/**
 * Declared secrets. Each is read from `${SECRETS_DIR}/<file>`; nothing here is
 * ever read from an env var in production.
 */
export const SECRET_SPECS = [
  {
    name: 'database_url',
    file: 'database_url',
    required: false,
    envFallback: 'DATABASE_URL',
    hint: 'write the Postgres URL to ${SECRETS_DIR}/database_url, or set DATABASE_URL for local dev',
  },
  {
    /**
     * The KEK passphrase (03 §2.2 Tier 1, P0-2).
     *
     * **File only. There is deliberately no `envFallback`, and there never will
     * be.** An environment variable is readable by every dependency in-process,
     * survives into `/proc/<pid>/environ`, child processes, crash dumps and
     * `docker inspect`; putting the passphrase there would defeat the entire
     * envelope design in one line of compose YAML. On the production host the
     * backing file is a `systemd-creds`-encrypted credential delivered as a
     * Docker secret on tmpfs.
     *
     * Required: a box that boots without it can neither read a Plaid token nor
     * write one, so starting anyway would mean discovering the problem at 03:15
     * during a sync rather than at `docker compose up`.
     */
    name: 'master_key',
    file: 'master_key',
    required: true,
    envFallback: undefined,
    hint:
      'write a high-entropy passphrase to ${SECRETS_DIR}/master_key (mode 0400). ' +
      'Generate one with `just gen-master-key`. It is never read from the environment.',
  },
] as const;

export type SecretName = (typeof SECRET_SPECS)[number]['name'];
