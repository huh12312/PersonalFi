// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.ts';
import { describeConfig, loadConfig } from './load.ts';
import { REDACTED_MARKER, isRedacted, redact } from './redacted.ts';

const VALID_URL = 'postgres://app:hunter2@db:5432/personalfi';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', DATABASE_URL: VALID_URL, SECRETS_DIR: '/nonexistent', ...overrides };
}

/** A secrets directory that exists and contains exactly the named files. */
function secretsFrom(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const name = path.split('/').pop() ?? '';
    const value = files[name];
    if (value === undefined) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return value;
  };
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    expect(config.env.HTTP_HOST).toBe('127.0.0.1'); // loopback, never 0.0.0.0
    expect(config.env.HTTP_PORT).toBe(8080);
    expect(config.env.LOG_LEVEL).toBe('info');
    expect(config.env.DEMO_MODE).toBe(false);
    expect(config.isTest).toBe(true);
    expect(config.isProduction).toBe(false);
  });

  it('prefers a file-mounted secret over the environment variable', () => {
    // Production posture: the password must not be visible in `docker inspect`.
    const fileUrl = 'postgres://app:from-file@db:5432/personalfi';
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ database_url: `${fileUrl}\n` }),
    });
    expect(config.databaseUrl.reveal()).toBe(fileUrl);
  });

  it('falls back to the environment variable for local development', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    expect(config.databaseUrl.reveal()).toBe(VALID_URL);
  });

  it('reports every problem at once, not just the first', () => {
    // A container that starts half-configured and fails at 03:15 mid-sync is far
    // worse than one that never starts.
    let error: unknown;
    try {
      loadConfig({
        env: {
          NODE_ENV: 'banana',
          LOG_LEVEL: 'shout',
          HTTP_PORT: '99999',
          DATABASE_URL: 'mysql://x',
        },
        readSecret: secretsFrom({}),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    const keys = problems.map((p) => p.key);
    expect(keys).toContain('NODE_ENV');
    expect(keys).toContain('LOG_LEVEL');
    expect(keys).toContain('HTTP_PORT');
    expect(keys).toContain('DATABASE_URL');
    expect(problems.length).toBeGreaterThanOrEqual(4);
    for (const problem of problems) expect(problem.hint.length).toBeGreaterThan(0);
  });

  it('refuses to start without a database and says how to fix it', () => {
    let error: unknown;
    try {
      loadConfig({
        env: { NODE_ENV: 'production', SECRETS_DIR: '/run/secrets' },
        readSecret: secretsFrom({}),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('/run/secrets/database_url');
  });

  it('never puts a secret value in an error message', () => {
    const password = 'correct-horse-battery-staple';
    let error: unknown;
    try {
      loadConfig({
        env: { NODE_ENV: 'production', LOG_LEVEL: 'nonsense' },
        readSecret: secretsFrom({ database_url: `postgres://app:${password}@db:5432/pf` }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).not.toContain(password);
    expect(JSON.stringify((error as ConfigError).problems)).not.toContain(password);
  });

  it('reports an unreadable secret file as a permissions problem, not a missing one', () => {
    const denied = (): never => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };
    let error: unknown;
    try {
      loadConfig({ env: { NODE_ENV: 'production' }, readSecret: denied });
    } catch (caught) {
      error = caught;
    }
    expect((error as ConfigError).message).toContain('EACCES');
    expect((error as ConfigError).message).toContain('permissions');
  });
});

describe('Redacted', () => {
  const secret = redact('super-secret-token');

  it('reveals only on an explicit, greppable call', () => {
    expect(secret.reveal()).toBe('super-secret-token');
    expect(isRedacted(secret)).toBe(true);
  });

  it('cannot be logged by accident', () => {
    expect(String(secret)).toBe(REDACTED_MARKER);
    expect(`${secret}`).toBe(REDACTED_MARKER);
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[redacted]"}');
    expect(JSON.stringify([secret])).toBe('["[redacted]"]');
  });

  it('keeps the database URL out of anything serialisable', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain('hunter2');
    expect(JSON.stringify(describeConfig(config))).not.toContain('hunter2');
    expect(describeConfig(config)['secretsPresent']).toEqual(['database_url']);
  });
});
