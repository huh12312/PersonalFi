// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { ConfigError, type ConfigProblem } from './errors.ts';
import { redact, type Redacted } from './redacted.ts';
import {
  SECRET_SPECS,
  environmentSchema,
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

export interface AppConfig {
  readonly env: PublicEnvironmentConfig;
  /** Every declared secret, boxed. `config.secrets.database_url?.reveal()`. */
  readonly secrets: Readonly<Record<SecretName, Redacted<string> | undefined>>;
  /** The effective database URL, from the secret file if present, else the env var. */
  readonly databaseUrl: Redacted<string>;
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
      if (spec.required) {
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

  if (problems.length > 0) throw new ConfigError(problems);
  if (databaseUrl === undefined) throw new ConfigError(problems); // unreachable; narrows the type

  const { DATABASE_URL: _consumed, ...publicEnv } = env;

  return Object.freeze({
    env: publicEnv,
    secrets: Object.freeze({ ...secrets }) as AppConfig['secrets'],
    databaseUrl,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  });
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
