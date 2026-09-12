// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.ts';
import { describeConfig, loadConfig } from './load.ts';
import { REDACTED_MARKER, isRedacted, redact } from './redacted.ts';

const VALID_URL = 'postgres://app:hunter2@db:5432/personalfi';

/** Obviously a fixture, and distinctive enough that a leak assertion means something. */
const MASTER_KEY = 'pfi-config-test-kek-4b7e1c93-do-not-use';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', DATABASE_URL: VALID_URL, SECRETS_DIR: '/nonexistent', ...overrides };
}

/**
 * A secrets directory that exists and contains exactly the named files — plus a
 * `master_key`, unless the caller explicitly passes `master_key: undefined`.
 *
 * The passphrase became a **required** secret with WP 0.2 (P0-2): a box that
 * boots without it can neither read a provider token nor write one. Defaulting it
 * here keeps every test below about the thing it names, and the two cases that
 * are *about* the passphrase opt out in one visible line.
 */
function secretsFrom(files: Record<string, string | undefined>): (path: string) => string {
  const resolved: Record<string, string | undefined> = { master_key: MASTER_KEY, ...files };
  return (path: string) => {
    const name = path.split('/').pop() ?? '';
    const value = resolved[name];
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

/**
 * **P0-2 evidence: _"KEK never in env or cleartext on disk; Argon2id
 * (m ≥ 1 GiB, t = 4, p = 4)"_.**
 *
 * The cost parameters are only worth anything if a box configured below them
 * refuses to boot, and that refusal lives here — `loadConfig` is the single place
 * the floor is applied, before a socket is opened or a pool is created. Without
 * these cases, "the production floor is enforced" is a comment.
 *
 * The floor is selected from `NODE_ENV` and from nothing else, which is the other
 * half of the control: a dedicated "relax the KDF" setting is a setting that gets
 * flipped in production at 02:00 to make a restart faster, and then stays flipped.
 */
describe('the KEK Argon2id floor (P0-2)', () => {
  const kek = (overrides: Record<string, string> = {}) =>
    loadConfig({
      env: env({ ...overrides }),
      readSecret: secretsFrom({}),
    }).kek;

  it('defaults to the memo`s numbers, whatever NODE_ENV says', () => {
    // The *defaults* do not follow NODE_ENV — only the floor does. A developer who
    // never sets these gets the production cost, so the 6 s derivation is a thing
    // they have already seen by the time it reaches a container.
    expect(kek().params).toEqual({ memoryKiB: 1_048_576, timeCost: 4, parallelism: 4 });
  });

  it('holds the production floor at m = 1 GiB, t = 4, p = 4', () => {
    const floor = loadConfig({
      env: { NODE_ENV: 'production', DATABASE_URL: VALID_URL },
      readSecret: secretsFrom({}),
    }).kek.floor;
    expect(floor).toEqual({ memoryKiB: 1_048_576, timeCost: 4, parallelism: 4 });
  });

  it('refuses to start a production box below the floor, naming every parameter', () => {
    let error: unknown;
    try {
      loadConfig({
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: VALID_URL,
          // The plausible mistake: someone copies the dev numbers into the
          // production compose file to make `docker compose up` feel faster.
          KEK_ARGON2_MEMORY_KIB: '8192',
          KEK_ARGON2_TIME_COST: '2',
          KEK_ARGON2_PARALLELISM: '1',
        },
        readSecret: secretsFrom({}),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    // All three at once, not the first: an operator should fix the configuration
    // in one pass rather than discover a new problem per restart.
    expect(problems.map((problem) => problem.key)).toEqual([
      'KEK_ARGON2_MEMORY_KIB',
      'KEK_ARGON2_TIME_COST',
      'KEK_ARGON2_PARALLELISM',
    ]);
    expect(problems[0]?.problem).toContain('production Argon2id floor');
    for (const problem of problems) expect(problem.hint).toContain('P0-2');
  });

  it('rejects each parameter independently, so one weak value is still fatal', () => {
    const below = {
      KEK_ARGON2_MEMORY_KIB: '1048575',
      KEK_ARGON2_TIME_COST: '3',
      KEK_ARGON2_PARALLELISM: '3',
    };
    for (const [key, value] of Object.entries(below)) {
      expect(() =>
        loadConfig({
          env: { NODE_ENV: 'production', DATABASE_URL: VALID_URL, [key]: value },
          readSecret: secretsFrom({}),
        }),
      ).toThrowError(new RegExp(key));
    }
  });

  it('lets a development box run the cheap parameters, because a suite derives dozens', () => {
    const config = kek({
      KEK_ARGON2_MEMORY_KIB: '8192',
      KEK_ARGON2_TIME_COST: '2',
      KEK_ARGON2_PARALLELISM: '1',
    });
    expect(config.floor).toEqual({ memoryKiB: 8_192, timeCost: 2, parallelism: 1 });
    expect(config.params).toEqual(config.floor);
  });

  it('still has a floor outside production — cheap is not the same as absent', () => {
    expect(() => kek({ KEK_ARGON2_MEMORY_KIB: '8191' })).toThrowError(ConfigError);
    expect(() => kek({ KEK_ARGON2_TIME_COST: '1' })).toThrowError(ConfigError);
  });

  it('rejects memory above the measured wasm32 ceiling before anything allocates', () => {
    // `hash-wasm` compiles Argon2 to wasm32, so m = 2 GiB throws
    // `Invalid typed array length` deep inside the KDF. Caught at boot instead, it
    // is a config problem with a fix; caught at 03:15 it is a crash loop.
    // See docs/evidence/phase-0/wp0.2-argon2-parameters.md.
    expect(() => kek({ KEK_ARGON2_MEMORY_KIB: '2097152' })).toThrowError(/KEK_ARGON2_MEMORY_KIB/);
  });

  it('has no environment fallback for the passphrase, and refuses to boot without it', () => {
    // The whole point of D5's custody ladder. An env var is readable by every
    // dependency in-process and survives into `/proc/<pid>/environ`, child
    // processes, crash dumps and `docker inspect`.
    let error: unknown;
    try {
      loadConfig({
        env: env({ MASTER_KEY: MASTER_KEY, KEK_PASSPHRASE: MASTER_KEY }),
        readSecret: secretsFrom({ master_key: undefined }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = (error as ConfigError).problems.find((p) => p.key === 'secret:master_key');
    expect(problem?.problem).toContain('is missing');
    expect(problem?.hint).toContain('never read from the environment');
  });

  it('never puts the passphrase in an error message', () => {
    let error: unknown;
    try {
      loadConfig({ env: env({ LOG_LEVEL: 'nonsense' }), readSecret: secretsFrom({}) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).not.toContain(MASTER_KEY);
    expect(JSON.stringify((error as ConfigError).problems)).not.toContain(MASTER_KEY);
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
    // By name only: "is the passphrase mounted?" stays answerable from a log line
    // without the log line carrying the passphrase.
    expect(describeConfig(config)['secretsPresent']).toEqual(['database_url', 'master_key']);
    expect(serialised).not.toContain(MASTER_KEY);
    expect(JSON.stringify(describeConfig(config))).not.toContain(MASTER_KEY);
  });
});
