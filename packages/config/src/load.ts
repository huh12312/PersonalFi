// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { ConfigError, type ConfigProblem } from './errors.ts';
import { redact, type Redacted } from './redacted.ts';
import {
  KEK_ARGON2_FLOORS,
  SECRET_SPECS,
  environmentSchema,
  type Argon2Params,
  type EnvironmentConfig,
  type SecretName,
} from './schema.ts';

/**
 * The environment as the rest of the app sees it.
 *
 * `DATABASE_URL` is deliberately absent: it carries a password, so once it has
 * been read it lives only inside `databaseUrl`, boxed in `Redacted`. Leaving it on
 * a plain object means the first `JSON.stringify(config)` in a debug log prints
 * the database password, and that call site is impossible to find later.
 */
export type PublicEnvironmentConfig = Omit<EnvironmentConfig, 'DATABASE_URL'>;

/**
 * Key-derivation settings, resolved and floor-checked at boot.
 *
 * The passphrase is **not** here. It stays in `secrets.master_key` as a
 * `Redacted<string>` and is handed to `SecretBox.unlock()` exactly once; putting
 * it — or the derived KEK — on `config` would mean the first
 * `JSON.stringify(config)` in a debug log prints the key to everything.
 */
export interface KekConfig {
  readonly params: Argon2Params;
  readonly floor: Argon2Params;
}

export interface AppConfig {
  readonly env: PublicEnvironmentConfig;
  /** Every declared secret, boxed. `config.secrets.database_url?.reveal()`. */
  readonly secrets: Readonly<Record<SecretName, Redacted<string> | undefined>>;
  /** The effective database URL, from the secret file if present, else the env var. */
  readonly databaseUrl: Redacted<string>;
  /** Argon2id parameters for the KEK, with the floor they were checked against. */
  readonly kek: KekConfig;
  /** Origins allowed by WebAuthn verification and the CSRF `Origin` check. */
  readonly allowedOrigins: readonly string[];
  readonly isProduction: boolean;
  readonly isTest: boolean;
}

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Injectable so tests never mutate the real one. */
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides `SECRETS_DIR`. */
  readonly secretsDir?: string;
  /** Read a secret file. Injectable for tests; defaults to the filesystem. */
  readonly readSecret?: (path: string) => string;
}

function defaultReadSecret(path: string): string {
  return readFileSync(path, 'utf8');
}

function hintFor(key: string): string {
  return `set ${key} in the environment (see .env.example)`;
}

function problemsFromZod(error: z.ZodError): ConfigProblem[] {
  return error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return {
      key,
      // `issue.message` describes the constraint, never echoes the value, so it is
      // safe to print even when the key turns out to be sensitive.
      problem: issue.message,
      hint: hintFor(key),
    };
  });
}

/**
 * Load and validate configuration. Throws `ConfigError` listing every problem.
 *
 * Non-secrets come from the environment; secrets come from files under
 * `SECRETS_DIR`, because env vars leak into `docker inspect`, crash dumps and
 * child processes. No secret value ever appears in a thrown message.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const source = options.env ?? process.env;
  const readSecret = options.readSecret ?? defaultReadSecret;
  const problems: ConfigProblem[] = [];

  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    problems.push(...problemsFromZod(parsed.error));
  }

  // Without a valid environment we cannot know where the secrets live, so report
  // what we have rather than guessing.
  if (!parsed.success) throw new ConfigError(problems);

  const env = parsed.data;
  const secretsDir = options.secretsDir ?? env.SECRETS_DIR;
  const secrets: Partial<Record<SecretName, Redacted<string>>> = {};

  for (const spec of SECRET_SPECS) {
    const path = join(secretsDir, spec.file);
    let value: string | undefined;
    try {
      const raw = readSecret(path).trim();
      if (raw.length > 0) value = raw;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== undefined && code !== 'ENOENT' && code !== 'ENOTDIR') {
        problems.push({
          key: `secret:${spec.name}`,
          problem: `could not be read (${code})`,
          hint: `check permissions on ${path}; it should be mode 0400 owned by the app user`,
        });
        continue;
      }
    }

    if (value === undefined && spec.envFallback !== undefined) {
      const fallback = source[spec.envFallback];
      if (typeof fallback === 'string' && fallback.trim().length > 0) value = fallback.trim();
    }

    if (value === undefined) {
      // Required-ness is per role (`SECRET_SPECS[].requiredForRoles`): the
      // one-shot migrator applies DDL and has no use for the KEK passphrase, so
      // demanding it there would only force the passphrase to be mounted into a
      // container that must never hold it.
      if (spec.requiredForRoles.includes(env.ROLE)) {
        problems.push({ key: `secret:${spec.name}`, problem: 'is missing', hint: spec.hint });
      }
      continue;
    }
    secrets[spec.name] = redact(value);
  }

  const databaseUrl = secrets.database_url;
  if (databaseUrl === undefined) {
    problems.push({
      key: 'secret:database_url',
      problem: 'is missing; the application cannot start without a database',
      hint: `write it to ${join(secretsDir, 'database_url')}, or set DATABASE_URL for local dev`,
    });
  }

  const isProduction = env.NODE_ENV === 'production';
  const kekParams: Argon2Params = {
    memoryKiB: env.KEK_ARGON2_MEMORY_KIB,
    timeCost: env.KEK_ARGON2_TIME_COST,
    parallelism: env.KEK_ARGON2_PARALLELISM,
  };
  // The floor follows NODE_ENV, never a setting of its own: a "relax the KDF"
  // switch is a switch that eventually gets flipped in production at 02:00 to make
  // a restart faster.
  const kekFloor = KEK_ARGON2_FLOORS[isProduction ? 'production' : 'development'];
  problems.push(...kekFloorProblems(kekParams, kekFloor, isProduction));

  const allowedOrigins = env.AUTH_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (allowedOrigins.length === 0) {
    problems.push({
      key: 'AUTH_ALLOWED_ORIGINS',
      problem: 'is empty; with no allowed origin every mutation would be rejected as cross-site',
      hint: 'set it to the exact scheme+host+port the UI is served from, e.g. https://fi.example.ts.net',
    });
  }

  if (problems.length > 0) throw new ConfigError(problems);
  if (databaseUrl === undefined) throw new ConfigError(problems); // unreachable; narrows the type

  const { DATABASE_URL: _consumed, ...publicEnv } = env;

  return Object.freeze({
    env: publicEnv,
    secrets: Object.freeze({ ...secrets }) as AppConfig['secrets'],
    databaseUrl,
    kek: Object.freeze({ params: Object.freeze(kekParams), floor: kekFloor }),
    allowedOrigins: Object.freeze(allowedOrigins),
    isProduction,
    isTest: env.NODE_ENV === 'test',
  });
}

function kekFloorProblems(
  params: Argon2Params,
  floor: Argon2Params,
  isProduction: boolean,
): ConfigProblem[] {
  const where = isProduction ? 'production' : 'development';
  const problems: ConfigProblem[] = [];
  const check = (key: string, value: number, minimum: number, unit: string): void => {
    if (value >= minimum) return;
    problems.push({
      key,
      problem: `${String(value)}${unit} is below the ${where} Argon2id floor of ${String(minimum)}${unit}`,
      hint:
        `raise ${key} to at least ${String(minimum)}${unit}. The KEK is derived once per boot, ` +
        'so the cost is paid once; see 03 §2.2 and P0-2.',
    });
  };
  check('KEK_ARGON2_MEMORY_KIB', params.memoryKiB, floor.memoryKiB, ' KiB');
  check('KEK_ARGON2_TIME_COST', params.timeCost, floor.timeCost, '');
  check('KEK_ARGON2_PARALLELISM', params.parallelism, floor.parallelism, '');
  return problems;
}

/**
 * The non-secret effective configuration, safe to log at boot and to record in
 * `config_snapshots` so "what changed?" is answerable after a behaviour shift.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config.env,
    secretsPresent: Object.entries(config.secrets)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
  };
}

/**
 * The KDF parameters and duration, for the boot log line P0-2 asks for
 * ("startup log shows KDF params and duration"). Parameters are not secret — the
 * salt is stored in the clear beside the ciphertext too — but the passphrase and
 * the derived key are never in this object.
 */
export function describeKek(config: AppConfig, durationMs: number): Record<string, unknown> {
  return {
    kdf: 'argon2id',
    memoryKiB: config.kek.params.memoryKiB,
    timeCost: config.kek.params.timeCost,
    parallelism: config.kek.params.parallelism,
    floorMemoryKiB: config.kek.floor.memoryKiB,
    durationMs,
  };
}
