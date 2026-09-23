// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ConfigError, type ConfigProblem } from './errors.ts';
import { describeConfig, loadConfig } from './load.ts';
import { REDACTED_MARKER, isRedacted, redact } from './redacted.ts';
import { SECRET_SPECS } from './schema.ts';

const VALID_URL = 'postgres://app:hunter2@db:5432/personalfi';

/** Obviously a fixture, and distinctive enough that a leak assertion means something. */
const MASTER_KEY = 'pfi-config-test-kek-4b7e1c93-do-not-use';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', DATABASE_URL: VALID_URL, SECRETS_DIR: '/nonexistent', ...overrides };
}

/**
 * Passkey settings a production box would actually be deployed with.
 *
 * Spread into the production cases below that are *about* something else (the
 * Argon2id floor, a missing secret), so the P0-4 boot check does not add
 * problems to an assertion that pins an exact problem list. The check itself is
 * exercised in its own describe block.
 */
const PROD_AUTH = {
  AUTH_RP_ID: 'personalfi.lan',
  AUTH_ALLOWED_ORIGINS: 'https://personalfi.lan',
} as const;

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
    // `api` so that `docker run <image>` with no ROLE does something sane.
    expect(config.env.ROLE).toBe('api');
  });

  /**
   * Every role the image can actually be started as must load.
   *
   * This is a regression test with a real incident behind it: `ROLE` was
   * `z.enum(['api', 'worker'])` while `docker/entrypoint.mjs` dispatched on
   * `api | worker | migrator` and `compose.yml` set `ROLE: migrator` on the
   * one-shot migrator. `loadConfig` runs *before* the first migration, so the
   * migrator exited 78 (EX_CONFIG), and because `api` and `worker` gate on it
   * completing, the whole stack never started — on a config key that nothing
   * branches on.
   *
   * The list is duplicated here on purpose. `@core/config` may import nothing but
   * `@core/kernel`, so it cannot reference `ProcessRole` from `@core/platform`,
   * and reading `entrypoint.mjs` from a unit test would couple config to the
   * Docker layout. A duplicated list with a failing test is the cheap half of
   * that trade; a silent 78 in production is the expensive half.
   */
  it('accepts every role the entrypoint and the snapshot table can produce', () => {
    // Keep in sync with `ENTRYPOINTS` in docker/entrypoint.mjs and `ProcessRole`
    // in packages/platform/src/config-snapshot.ts.
    for (const role of ['api', 'worker', 'migrator', 'cli'] as const) {
      const config = loadConfig({ env: env({ ROLE: role }), readSecret: secretsFrom({}) });
      expect(config.env.ROLE, `ROLE=${role} must load`).toBe(role);
    }
  });

  /**
   * The migrator must load with exactly the secrets `compose.yml` grants it.
   *
   * Second half of the same incident, and the reason the test above did not catch
   * it: `secretsFrom` supplies `master_key` by default, so "every role loads" was
   * only ever asserted against a secrets directory richer than the one the
   * migrator actually gets. `compose.yml` gives that service
   * `secrets: [database_url]` and nothing else — correctly, because it applies
   * DDL and never unwraps a DEK — while `master_key` was `required: true` for
   * every role. The migrator therefore exited non-zero at boot, and `api` and
   * `worker` gate on it with `service_completed_successfully`, so
   * `docker compose up` on a clean box produced no API at all.
   *
   * The fix must not be "mount the passphrase into the migrator too": that would
   * hand the key that opens every provider credential to a container with no use
   * for it. So this test pins the narrow claim — migrator boots *without* the
   * passphrase — and the one below pins that nothing else does.
   */
  it('starts the migrator with only the secrets compose grants it (no master_key)', () => {
    const config = loadConfig({
      env: env({ ROLE: 'migrator' }),
      readSecret: secretsFrom({ master_key: undefined }),
    });
    expect(config.env.ROLE).toBe('migrator');
    expect(config.secrets.master_key).toBeUndefined();
    expect(config.databaseUrl.reveal()).toBe(VALID_URL);
  });

  it('still refuses to start api, worker or cli without the passphrase', () => {
    // The exemption is for the migrator alone. Any role that can reach a DEK —
    // the API, the sync worker, and `bootstrap-user` — must fail closed.
    for (const role of ['api', 'worker', 'cli'] as const) {
      let thrown: unknown;
      try {
        loadConfig({
          env: env({ ROLE: role }),
          readSecret: secretsFrom({ master_key: undefined }),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `ROLE=${role} must refuse to start`).toBeInstanceOf(ConfigError);
      expect(
        (thrown as ConfigError).problems.some((p) => p.key === 'secret:master_key'),
        `ROLE=${role} must name the missing passphrase`,
      ).toBe(true);
    }
  });

  /**
   * C-3 (gate-security-review.md §2.2): `compose.yml`'s file secrets must
   * exist on the host or `docker compose up` refuses to start the container
   * at all — there is no "optional bind mount" in Compose's secret model.
   * For an optional secret (the three `plaid_*` files) that forces a choice:
   * either every operator hand-creates empty placeholder files for secrets
   * they are not using, or an empty file has to mean the same thing as no
   * file. This is the second, applied uniformly — including to a *required*
   * secret, where "empty" must fail exactly as loudly as "missing" and never
   * silently succeed with a zero-length passphrase.
   */
  it('treats a zero-length secret file as absent, the same as no file at all', () => {
    const config = loadConfig({
      env: env({ ROLE: 'migrator' }),
      readSecret: secretsFrom({ master_key: undefined, database_url: '' }),
    });
    // `database_url` has an env fallback (`DATABASE_URL`, set by `env()`), so
    // an empty *file* falling through to it is the proof the file was treated
    // as absent rather than as "present, with an empty connection string".
    expect(config.databaseUrl.reveal()).toBe(VALID_URL);
  });

  it('treats a whitespace-only secret file as absent too, not as a blank credential', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ database_url: '   \n\t  ' }),
    });
    expect(config.databaseUrl.reveal()).toBe(VALID_URL);
  });

  it('refuses to start api/worker/cli when master_key is an empty file, exactly as when absent', () => {
    for (const role of ['api', 'worker', 'cli'] as const) {
      let thrown: unknown;
      try {
        loadConfig({
          env: env({ ROLE: role }),
          readSecret: secretsFrom({ master_key: '' }),
        });
      } catch (error) {
        thrown = error;
      }
      expect(
        thrown,
        `ROLE=${role} must refuse to start on an empty master_key file`,
      ).toBeInstanceOf(ConfigError);
      expect(
        (thrown as ConfigError).problems.some((p) => p.key === 'secret:master_key'),
        `ROLE=${role} must name the empty passphrase as missing`,
      ).toBe(true);
    }
  });

  it('still rejects a role nothing can start as', () => {
    // The enum is a guard, not a free-text field: a typo'd `ROLE: wroker` in
    // compose should fail loudly at boot rather than silently run as the default.
    expect(() =>
      loadConfig({ env: env({ ROLE: 'wroker' }), readSecret: secretsFrom({}) }),
    ).toThrowError(ConfigError);
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
      env: { NODE_ENV: 'production', DATABASE_URL: VALID_URL, ...PROD_AUTH },
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
          ...PROD_AUTH,
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
          env: { NODE_ENV: 'production', DATABASE_URL: VALID_URL, ...PROD_AUTH, [key]: value },
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

/**
 * **P0-4 evidence: the passkey configuration must describe the host served.**
 *
 * The gate found `AUTH_RP_ID=localhost` and
 * `AUTH_ALLOWED_ORIGINS=http://localhost:8080` live on a stack serving
 * `https://personalfi.lan`, because both settings defaulted and `compose.yml`
 * set neither. The damage was doubled and silent: the CSRF `Origin` allow-list
 * 403'd every mutation from the real origin, and `localhost` is not a
 * registrable suffix of `personalfi.lan`, so the browser refused the WebAuthn
 * ceremony before the server saw it. No passkey had ever been enrolled and the
 * boot log looked fine.
 *
 * These cases are the "loudly" in "fail loudly": every one asserts a `ConfigError`
 * naming the setting, thrown before a socket is opened.
 */
describe('the passkey configuration boot check (P0-4)', () => {
  const load = (overrides: Record<string, string>) =>
    loadConfig({
      env: { NODE_ENV: 'production', DATABASE_URL: VALID_URL, ...overrides },
      readSecret: secretsFrom({}),
    });

  function problemsFrom(overrides: Record<string, string>): readonly ConfigProblem[] {
    try {
      load(overrides);
    } catch (caught) {
      if (caught instanceof ConfigError) return caught.problems;
      throw caught;
    }
    return [];
  }

  it('refuses to boot a production box still on the shipped defaults', () => {
    // Exactly the deployed configuration the gate found. Before this check it
    // booted, logged "configuration loaded", and enrolled nothing.
    const problems = problemsFrom({});

    expect(problems.map((problem) => problem.key)).toContain('AUTH_RP_ID');
    expect(problems.find((problem) => problem.key === 'AUTH_RP_ID')?.problem).toContain(
      'development default',
    );
    expect(problems.find((problem) => problem.key === 'AUTH_RP_ID')?.hint).toContain('P0-4');
  });

  it('refuses a pairing where no allowed origin could ever enrol a passkey', () => {
    // The precise shape of the outage: a real hostname served, but an RP id that
    // is not a registrable suffix of it. The browser refuses the ceremony before
    // the server is consulted, so nothing server-side would ever have noticed.
    const problems = problemsFrom({
      AUTH_RP_ID: 'localhost',
      AUTH_ALLOWED_ORIGINS: 'https://personalfi.lan',
    });

    // Two distinct AUTH_RP_ID problems fire here and both are true: it is still
    // the shipped default, *and* it matches no origin. Assert across the set
    // rather than on the first, so neither can silently stop being reported.
    const rpProblems = problems.filter((candidate) => candidate.key === 'AUTH_RP_ID');
    expect(rpProblems.map((problem) => problem.problem).join('\n')).toContain(
      'not the host of any allowed origin',
    );
    expect(rpProblems.map((problem) => problem.hint).join('\n')).toContain(
      'AUTH_RP_ID=personalfi.lan',
    );
  });

  it('applies the rule outside production too', () => {
    // It is a property of WebAuthn, not of a deployment: a mismatched pair can
    // never produce a credential this server will verify, in any environment.
    expect(() =>
      loadConfig({
        env: env({ AUTH_RP_ID: 'example.test', AUTH_ALLOWED_ORIGINS: 'http://localhost:8080' }),
        readSecret: secretsFrom({}),
      }),
    ).toThrowError(/AUTH_RP_ID/);
  });

  it('accepts a subdomain of the RP id, which is what a Tailscale name looks like', () => {
    const config = load({
      AUTH_RP_ID: 'example.ts.net',
      AUTH_ALLOWED_ORIGINS: 'https://fi.example.ts.net,https://example.ts.net',
    });

    expect(config.allowedOrigins).toEqual(['https://fi.example.ts.net', 'https://example.ts.net']);
    expect(config.env.AUTH_RP_ID).toBe('example.ts.net');
  });

  it('allows a CSRF-only origin alongside the enrollable one', () => {
    // The list serves double duty (WebAuthn *and* the CSRF `Origin` check), and a
    // LAN name beside a Tailscale name is a real deployment: both must pass CSRF,
    // only one can be the WebAuthn RP. Rejecting the extra would forbid a working
    // configuration in order to catch a mistake the quorum rule already catches.
    const config = load({
      AUTH_RP_ID: 'personalfi.lan',
      AUTH_ALLOWED_ORIGINS: 'https://personalfi.lan,https://fi.example.ts.net',
    });

    expect(config.allowedOrigins).toHaveLength(2);
  });

  it('rejects a plain-HTTP origin in production', () => {
    const problems = problemsFrom({
      AUTH_RP_ID: 'personalfi.lan',
      AUTH_ALLOWED_ORIGINS: 'http://personalfi.lan',
    });

    expect(problems.find((problem) => problem.key === 'AUTH_ALLOWED_ORIGINS')?.problem).toContain(
      'not HTTPS',
    );
  });

  it('rejects an origin carrying a path, which is a URL rather than an origin', () => {
    // `https://personalfi.lan/` is fine; `https://personalfi.lan/app` never
    // matches a browser `Origin` header, so it would allow-list nothing.
    const problems = problemsFrom({
      AUTH_RP_ID: 'personalfi.lan',
      AUTH_ALLOWED_ORIGINS: 'https://personalfi.lan/app',
    });

    expect(problems.find((problem) => problem.key === 'AUTH_ALLOWED_ORIGINS')?.problem).toContain(
      'path, query or fragment',
    );
  });

  it('names every bad origin at once rather than one per restart', () => {
    const problems = problemsFrom({
      AUTH_RP_ID: 'personalfi.lan',
      AUTH_ALLOWED_ORIGINS: 'http://personalfi.lan,https://elsewhere.test/app,not-a-url',
    });

    // Not HTTPS; carries a path; unparseable. An operator should fix the
    // configuration in one pass rather than discover a new problem per restart.
    expect(problems.filter((problem) => problem.key === 'AUTH_ALLOWED_ORIGINS').length).toBe(3);
  });

  it('leaves the development defaults working, so the check costs nothing until it fires', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });

    expect(config.env.AUTH_RP_ID).toBe('localhost');
    expect(config.allowedOrigins).toEqual(['http://localhost:8080']);
  });

  // gate-remediation-2.md finding 8: a bare label is not a registrable
  // domain, whether or not it happens to also be the shipped default.
  it.each(['lan', 'com', 'localhost'])(
    'rejects AUTH_RP_ID=%s in production as a bare label, not a real hostname',
    (rpId) => {
      const problems = problemsFrom({
        AUTH_RP_ID: rpId,
        AUTH_ALLOWED_ORIGINS: `https://${rpId}`,
      });

      expect(problems.map((problem) => problem.key)).toContain('AUTH_RP_ID');
      const messages = problems
        .filter((problem) => problem.key === 'AUTH_RP_ID')
        .map((problem) => problem.problem)
        .join('\n');
      expect(messages).toMatch(/development default|bare label/);
    },
  );

  it('rejects any other single-label AUTH_RP_ID in production, not just the denylisted ones', () => {
    const problems = problemsFrom({
      AUTH_RP_ID: 'nas',
      AUTH_ALLOWED_ORIGINS: 'https://nas',
    });

    expect(problems.find((problem) => problem.key === 'AUTH_RP_ID')?.problem).toContain(
      'bare label',
    );
  });

  it('accepts a bare-suffix-looking label outside production', () => {
    // The rule targets a production deployment mistake, not development —
    // `localhost` is the working dev default (asserted above) and stays that
    // way; this pins that `lan`/`com` are equally fine in non-production.
    const config = loadConfig({
      env: env({ AUTH_RP_ID: 'lan', AUTH_ALLOWED_ORIGINS: 'http://lan' }),
      readSecret: secretsFrom({}),
    });

    expect(config.env.AUTH_RP_ID).toBe('lan');
  });
});

/**
 * **M-1: `trustProxy` is a stated topology, not `true`.**
 *
 * `app.ts` trusted any peer's `X-Forwarded-For`. That did not reproduce as an
 * exploit only because Caddy 2.11.4's empty `trusted_proxies` default *replaces*
 * the header rather than appending to it — an undocumented, version-dependent
 * default in a file this process does not own. The hop count makes the
 * assumption explicit and testable; `app.test.ts` pins the resulting `request.ip`.
 */
describe('TRUST_PROXY (M-1)', () => {
  it('defaults to one hop — Caddy, and nothing behind it', () => {
    expect(loadConfig({ env: env(), readSecret: secretsFrom({}) }).env.TRUST_PROXY).toBe(1);
  });

  it('accepts 0 for a process reached directly, with no forwarded headers parsed', () => {
    expect(
      loadConfig({ env: env({ TRUST_PROXY: '0' }), readSecret: secretsFrom({}) }).env.TRUST_PROXY,
    ).toBe(0);
  });

  it('refuses a non-numeric or negative hop count rather than silently trusting everything', () => {
    // The dangerous typo is `TRUST_PROXY=true`: under the old `trustProxy: true`
    // that *was* the configuration, so it must not coerce to something plausible.
    expect(() =>
      loadConfig({ env: env({ TRUST_PROXY: 'true' }), readSecret: secretsFrom({}) }),
    ).toThrowError(ConfigError);
    expect(() =>
      loadConfig({ env: env({ TRUST_PROXY: '-1' }), readSecret: secretsFrom({}) }),
    ).toThrowError(ConfigError);
  });
});

/**
 * `NOTIFICATIONS_ALLOWED_HOSTS` (02-phase-2-dispatch.md §4 item 3;
 * wp2.4-notifications.md §8): `@ctx/notifications`'s egress allow-list, as
 * deployment configuration. `config.notifications.allowedHosts` is what
 * `apps/api/src/domain.ts`'s `createNotificationEgressPolicy` hands to
 * `createEgressPolicy`.
 */
describe('NOTIFICATIONS_ALLOWED_HOSTS', () => {
  it('defaults to empty — deny-all until an operator names a host', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    expect(config.notifications.allowedHosts).toEqual([]);
  });

  it('parses a comma-separated list, lower-cased and trimmed', () => {
    const config = loadConfig({
      env: env({ NOTIFICATIONS_ALLOWED_HOSTS: ' Ntfy.Example.TS.net , smtp.example.com ' }),
      readSecret: secretsFrom({}),
    });
    expect(config.notifications.allowedHosts).toEqual(['ntfy.example.ts.net', 'smtp.example.com']);
  });

  it('de-duplicates entries that only differ by case', () => {
    const config = loadConfig({
      env: env({ NOTIFICATIONS_ALLOWED_HOSTS: 'ntfy.example.ts.net,NTFY.EXAMPLE.TS.NET' }),
      readSecret: secretsFrom({}),
    });
    expect(config.notifications.allowedHosts).toEqual(['ntfy.example.ts.net']);
  });

  it('rejects an IP literal — a second door to the private-range refusal', () => {
    expect(() =>
      loadConfig({
        env: env({ NOTIFICATIONS_ALLOWED_HOSTS: '169.254.169.254' }),
        readSecret: secretsFrom({}),
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({
        env: env({ NOTIFICATIONS_ALLOWED_HOSTS: '169.254.169.254' }),
        readSecret: secretsFrom({}),
      });
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(
        problems.some(
          (problem: ConfigProblem) =>
            problem.key === 'NOTIFICATIONS_ALLOWED_HOSTS' && problem.problem.includes('IP literal'),
        ),
      ).toBe(true);
    }
  });

  it('rejects an IPv6 literal too', () => {
    expect(() =>
      loadConfig({
        env: env({ NOTIFICATIONS_ALLOWED_HOSTS: '::1' }),
        readSecret: secretsFrom({}),
      }),
    ).toThrowError(ConfigError);
  });

  it('rejects a wildcard', () => {
    expect(() =>
      loadConfig({
        env: env({ NOTIFICATIONS_ALLOWED_HOSTS: '*.example.com' }),
        readSecret: secretsFrom({}),
      }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({
        env: env({ NOTIFICATIONS_ALLOWED_HOSTS: '*.example.com' }),
        readSecret: secretsFrom({}),
      });
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(
        problems.some(
          (problem: ConfigProblem) =>
            problem.key === 'NOTIFICATIONS_ALLOWED_HOSTS' && problem.problem.includes('wildcard'),
        ),
      ).toBe(true);
    }
  });

  it('rejects a syntactically invalid hostname', () => {
    expect(() =>
      loadConfig({
        env: env({ NOTIFICATIONS_ALLOWED_HOSTS: 'not a host!' }),
        readSecret: secretsFrom({}),
      }),
    ).toThrowError(ConfigError);
  });

  it('an empty string means no hosts, not one empty entry', () => {
    const config = loadConfig({
      env: env({ NOTIFICATIONS_ALLOWED_HOSTS: '' }),
      readSecret: secretsFrom({}),
    });
    expect(config.notifications.allowedHosts).toEqual([]);
  });
});

/**
 * `MARKET_DATA_ALLOWED_HOSTS` and `CRYPTO_ALLOWED_HOSTS`
 * (03-phase-3-dispatch.md §4 item 8; wp3.4-market-data.md §9 item 3).
 *
 * The same hand-validation as `NOTIFICATIONS_ALLOWED_HOSTS` above, asserted
 * independently rather than by trusting that they share `resolveAllowedHosts`.
 * They do share it today; a future edit that gives one of the three its own
 * copy — the exact drift `NOTIFICATIONS_ALLOWED_HOSTS` was written by hand to
 * avoid in the first place — has to break a test, not just a code reading.
 *
 * The one deliberate behavioural difference from notifications is asserted at
 * the bottom of each block: an empty value here means *no override*, and
 * `apps/api/src/domain.ts` then uses `@ctx/integrations`' own four-host list.
 * Empty can never widen anything, because widening is not an operation this
 * variable has.
 */
describe.each([
  {
    key: 'MARKET_DATA_ALLOWED_HOSTS' as const,
    read: (config: ReturnType<typeof loadConfig>) => config.marketData.allowedHosts,
    good: ' Api.Tiingo.com , api.coingecko.com ',
    expected: ['api.tiingo.com', 'api.coingecko.com'],
    duplicate: 'api.tiingo.com,API.TIINGO.COM',
    deduped: ['api.tiingo.com'],
  },
  {
    key: 'CRYPTO_ALLOWED_HOSTS' as const,
    read: (config: ReturnType<typeof loadConfig>) => config.crypto.allowedHosts,
    good: ' Api.Coinbase.com , blockstream.info ',
    expected: ['api.coinbase.com', 'blockstream.info'],
    duplicate: 'api.coinbase.com,API.COINBASE.COM',
    deduped: ['api.coinbase.com'],
  },
])('$key', ({ key, read, good, expected, duplicate, deduped }) => {
  it('defaults to empty — no narrowing of the list the code itself carries', () => {
    expect(read(loadConfig({ env: env(), readSecret: secretsFrom({}) }))).toEqual([]);
  });

  it('parses a comma-separated list, lower-cased and trimmed', () => {
    const config = loadConfig({ env: env({ [key]: good }), readSecret: secretsFrom({}) });
    expect(read(config)).toEqual(expected);
  });

  it('de-duplicates entries that only differ by case', () => {
    const config = loadConfig({ env: env({ [key]: duplicate }), readSecret: secretsFrom({}) });
    expect(read(config)).toEqual(deduped);
  });

  it('rejects an IP literal — a second door to the private-range refusal', () => {
    expect(() =>
      loadConfig({ env: env({ [key]: '169.254.169.254' }), readSecret: secretsFrom({}) }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({ env: env({ [key]: '169.254.169.254' }), readSecret: secretsFrom({}) });
      expect.unreachable('an IP literal must be refused');
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(
        problems.some(
          (problem: ConfigProblem) => problem.key === key && problem.problem.includes('IP literal'),
        ),
      ).toBe(true);
    }
  });

  it('rejects an IPv6 literal too', () => {
    expect(() =>
      loadConfig({ env: env({ [key]: '::1' }), readSecret: secretsFrom({}) }),
    ).toThrowError(ConfigError);
  });

  it('rejects a wildcard', () => {
    try {
      loadConfig({ env: env({ [key]: '*.example.com' }), readSecret: secretsFrom({}) });
      expect.unreachable('a wildcard must be refused');
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(
        problems.some(
          (problem: ConfigProblem) => problem.key === key && problem.problem.includes('wildcard'),
        ),
      ).toBe(true);
    }
  });

  it('rejects a syntactically invalid hostname', () => {
    expect(() =>
      loadConfig({ env: env({ [key]: 'not a host!' }), readSecret: secretsFrom({}) }),
    ).toThrowError(ConfigError);
  });

  it('an empty string means no override, not one empty entry', () => {
    const config = loadConfig({ env: env({ [key]: '' }), readSecret: secretsFrom({}) });
    expect(read(config)).toEqual([]);
  });

  it('names itself in the problem, so an operator knows which variable to fix', () => {
    try {
      loadConfig({ env: env({ [key]: '*.evil.example' }), readSecret: secretsFrom({}) });
      expect.unreachable('a wildcard must be refused');
    } catch (error) {
      const keys = (error as ConfigError).problems.map((problem: ConfigProblem) => problem.key);
      expect(keys).toContain(key);
      // The generalisation must not have re-pointed one list's problems at
      // another's variable name.
      expect(keys).not.toContain('NOTIFICATIONS_ALLOWED_HOSTS');
    }
  });
});

/**
 * `coinbase_key_name` / `coinbase_private_key` (wp3.5-coinbase.md §8.1).
 *
 * Feature-detected exactly as the Plaid pair is, and — the half that earns
 * `resolveCoinbase` its existence — present-but-partial is a boot problem
 * rather than a connector that registers and then cannot sign anything.
 */
describe('coinbase secrets', () => {
  const KEY_NAME =
    'organizations/11111111-1111-1111-1111-111111111111/apiKeys/22222222-2222-2222-2222-222222222222';
  const PRIVATE_KEY = 'ZmFrZS1lZDI1NTE5LXNlZWQtZm9yLXRlc3Rpbmctb25seS1ub3QtYS1yZWFsLWtleQ==';

  it('is null when neither file is present — the ordinary unconfigured install', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    expect(config.coinbase).toBeNull();
  });

  it('is configured when both files are present', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({
        coinbase_key_name: KEY_NAME,
        coinbase_private_key: PRIVATE_KEY,
      }),
    });
    expect(config.coinbase).toEqual({ configured: true });
  });

  it('carries no credential on the config object — only the fact of opting in', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({
        coinbase_key_name: KEY_NAME,
        coinbase_private_key: PRIVATE_KEY,
      }),
    });
    // The signing key must not be reachable through `config.coinbase`; the
    // connector reads it from the sealed `ConnectionHandle` per request.
    expect(Object.keys(config.coinbase ?? {})).toEqual(['configured']);
    expect(JSON.stringify(config.coinbase)).not.toContain(PRIVATE_KEY);
  });

  it('refuses a key name with no private key', () => {
    try {
      loadConfig({ env: env(), readSecret: secretsFrom({ coinbase_key_name: KEY_NAME }) });
      expect.unreachable('half a CDP credential must be refused');
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(
        problems.some((problem: ConfigProblem) => problem.key === 'secret:coinbase_private_key'),
      ).toBe(true);
    }
  });

  it('refuses a private key with no key name', () => {
    try {
      loadConfig({ env: env(), readSecret: secretsFrom({ coinbase_private_key: PRIVATE_KEY }) });
      expect.unreachable('half a CDP credential must be refused');
    } catch (error) {
      const problems = (error as ConfigError).problems;
      expect(
        problems.some((problem: ConfigProblem) => problem.key === 'secret:coinbase_key_name'),
      ).toBe(true);
    }
  });

  it('never echoes the private key into a boot problem', () => {
    try {
      loadConfig({ env: env(), readSecret: secretsFrom({ coinbase_private_key: PRIVATE_KEY }) });
      expect.unreachable('half a CDP credential must be refused');
    } catch (error) {
      const rendered = (error as ConfigError).problems
        .map((problem: ConfigProblem) => `${problem.key} ${problem.problem} ${problem.hint}`)
        .join('\n');
      expect(rendered).not.toContain(PRIVATE_KEY);
    }
  });

  it('both secrets are file-only — neither declares an env fallback', () => {
    for (const name of ['coinbase_key_name', 'coinbase_private_key'] as const) {
      const spec = SECRET_SPECS.find((candidate) => candidate.name === name);
      expect(spec, `${name} must be declared in SECRET_SPECS`).toBeDefined();
      expect(spec?.envFallback).toBeUndefined();
      expect(spec?.requiredForRoles).toEqual([]);
    }
  });
});

/**
 * `ADVISOR_TOKEN_SECRET` (wp2.6-insights.md §6, open item 5): the file secret
 * `@ctx/insights`'s `InsightsSettings.tokenSecret` is keyed from. File-only,
 * like `master_key`, and optional: an install with no file present has simply
 * not opted into `module.insights` yet.
 */
describe('advisor_token_secret (wp2.6 §6)', () => {
  it('is absent by default — module.insights stays unwired, not crashed', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    expect(config.secrets.advisor_token_secret).toBeUndefined();
  });

  it('is read from the secrets directory when present, and boxed', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ advisor_token_secret: 'a-stable-install-secret' }),
    });
    expect(config.secrets.advisor_token_secret?.reveal()).toBe('a-stable-install-secret');
  });

  it('has no env-var fallback — file only, same posture as master_key', () => {
    const config = loadConfig({
      env: env({ ADVISOR_TOKEN_SECRET: 'should-not-be-read' }),
      readSecret: secretsFrom({}),
    });
    expect(config.secrets.advisor_token_secret).toBeUndefined();
  });

  it('is required for no role — absence never fails boot', () => {
    for (const role of ['api', 'worker', 'migrator', 'cli'] as const) {
      expect(() =>
        loadConfig({ env: env({ ROLE: role, ...PROD_AUTH }), readSecret: secretsFrom({}) }),
      ).not.toThrow();
    }
  });
});

/**
 * Market-data provider keys (WP 3.4): `tiingo_api_key`, `fred_api_key`,
 * `coingecko_api_key`, `openfigi_api_key`.
 *
 * Two claims the adapters are built on, pinned here so neither can quietly
 * stop being true:
 *
 *  - **Optional for every role.** 03 §6 item 1 — "Phase 3 completes with zero
 *    keys — it just cannot prove freshness." A key that became required would
 *    turn a deployment that has simply not signed up for Tiingo into a box that
 *    refuses to boot.
 *  - **Never from the environment.** File-only, same posture as
 *    `plaid_client_id` (01 §1.10): an env-var escape hatch is the leak surface
 *    (`docker inspect`, `/proc/<pid>/environ`, crash dumps) the file secret
 *    exists to avoid. `gate-secret-custody.test.ts` asserts this generically
 *    over every file-only secret; these cases name the four so a deletion from
 *    `SECRET_SPECS` fails loudly rather than shrinking that gate's input.
 */
describe('market-data provider API keys (WP 3.4)', () => {
  const MARKET_DATA_SECRETS = [
    'tiingo_api_key',
    'fred_api_key',
    'coingecko_api_key',
    'openfigi_api_key',
  ] as const;

  /** Distinctive enough that finding one anywhere in the config means something. */
  const KEY_VALUES: Record<(typeof MARKET_DATA_SECRETS)[number], string> = {
    tiingo_api_key: 'pfi-test-tiingo-key-0a1b-do-not-use',
    fred_api_key: 'pfi-test-fred-key-2c3d-do-not-use',
    coingecko_api_key: 'pfi-test-coingecko-key-4e5f-do-not-use',
    openfigi_api_key: 'pfi-test-openfigi-key-6a7b-do-not-use',
  };

  it('declares all four as optional, file-only secrets', () => {
    for (const name of MARKET_DATA_SECRETS) {
      const spec = SECRET_SPECS.find((candidate) => candidate.name === name);
      expect(spec, `${name} must be declared in SECRET_SPECS`).toBeDefined();
      expect(spec?.requiredForRoles, `${name} must be required for no role`).toEqual([]);
      expect(spec?.envFallback, `${name} must have no env fallback`).toBeUndefined();
      expect(spec?.file).toBe(name);
    }
  });

  it('boots every role with no market-data key present at all', () => {
    // The zero-key deployment 03 §6 calls the default: no Tiingo account, no
    // FRED registration, and every container still starts.
    for (const role of ['api', 'worker', 'migrator', 'cli'] as const) {
      const config = loadConfig({
        env: env({ ROLE: role, ...PROD_AUTH }),
        readSecret: secretsFrom({}),
      });
      for (const name of MARKET_DATA_SECRETS) {
        expect(config.secrets[name], `${name} must be absent with no file`).toBeUndefined();
      }
    }
  });

  it('exposes each key when its file is present, and only that one', () => {
    for (const name of MARKET_DATA_SECRETS) {
      const config = loadConfig({
        env: env(),
        readSecret: secretsFrom({ [name]: KEY_VALUES[name] }),
      });
      expect(config.secrets[name]?.reveal()).toBe(KEY_VALUES[name]);
      for (const other of MARKET_DATA_SECRETS) {
        if (other === name) continue;
        expect(config.secrets[other], `${other} must stay absent`).toBeUndefined();
      }
    }
  });

  it('is never read from an environment variable', () => {
    // The escape hatch that must not exist: the obvious upper-cased name, plus
    // the provider-prefixed spelling a compose file would reach for.
    const planted: Record<string, string> = {};
    for (const name of MARKET_DATA_SECRETS) {
      planted[name.toUpperCase()] = KEY_VALUES[name];
      planted[name.toUpperCase().replace('_API_KEY', '_KEY')] = KEY_VALUES[name];
    }

    const config = loadConfig({ env: env(planted), readSecret: secretsFrom({}) });

    const serialised = JSON.stringify(config);
    for (const name of MARKET_DATA_SECRETS) {
      expect(config.secrets[name], `${name} must not come from the environment`).toBeUndefined();
      expect(serialised).not.toContain(KEY_VALUES[name]);
      expect(JSON.stringify(describeConfig(config))).not.toContain(KEY_VALUES[name]);
    }
  });

  it('keeps every key out of anything serialisable, by name only', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ ...KEY_VALUES }),
    });

    const serialised = JSON.stringify(config);
    const described = JSON.stringify(describeConfig(config));
    for (const name of MARKET_DATA_SECRETS) {
      expect(serialised).not.toContain(KEY_VALUES[name]);
      expect(described).not.toContain(KEY_VALUES[name]);
    }
    // Presence stays answerable from a boot log line without the log line
    // carrying the keys — the same contract `describeConfig` keeps for Plaid.
    expect(describeConfig(config)['secretsPresent']).toEqual([
      'database_url',
      'master_key',
      ...MARKET_DATA_SECRETS,
    ]);
  });
});

/**
 * gate-remediation-2.md finding 8: `SESSION_COOKIE_SECURE=false` exists only
 * for a plain-HTTP local/integration harness (apps/api/test/cookies.test.ts).
 * Left set in production, the session cookie would ride along on plain HTTP —
 * this is the boot-time check that turns that into a startup error instead of
 * a silent downgrade.
 */
describe('SESSION_COOKIE_SECURE gated to non-production', () => {
  it('defaults to true and boots in production unchanged', () => {
    const config = loadConfig({
      env: { NODE_ENV: 'production', DATABASE_URL: VALID_URL, ...PROD_AUTH },
      readSecret: secretsFrom({}),
    });

    expect(config.env.SESSION_COOKIE_SECURE).toBe(true);
  });

  it('refuses to boot in production with SESSION_COOKIE_SECURE=false', () => {
    expect(() =>
      loadConfig({
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: VALID_URL,
          SESSION_COOKIE_SECURE: 'false',
          ...PROD_AUTH,
        },
        readSecret: secretsFrom({}),
      }),
    ).toThrowError(/SESSION_COOKIE_SECURE/);
  });

  it('allows SESSION_COOKIE_SECURE=false outside production, for the plain-HTTP test harness', () => {
    const config = loadConfig({
      env: env({ SESSION_COOKIE_SECURE: 'false' }),
      readSecret: secretsFrom({}),
    });

    expect(config.env.SESSION_COOKIE_SECURE).toBe(false);
  });
});

describe('Plaid (WP 1.3b — config)', () => {
  const CLIENT_ID = 'pfi-config-test-plaid-client-id-do-not-use';
  const SECRET = 'pfi-config-test-plaid-secret-b4f2-do-not-use';

  it('boots with Plaid unconfigured when neither secret file is present', () => {
    const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
    expect(config.plaid).toBeNull();
  });

  it('boots with Plaid unconfigured when both files exist but are empty (C-3 bootstrap placeholder)', () => {
    // RUNBOOK.md's "Create secrets" has the operator generate empty
    // plaid_client_id/plaid_secret/plaid_env placeholders unconditionally
    // (compose.yml requires the files to exist), so an empty file — not
    // ENOENT — is the file an operator who has not signed up for Plaid
    // actually has on disk.
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ plaid_client_id: '', plaid_secret: '\n' }),
    });
    expect(config.plaid).toBeNull();
  });

  it('treats an empty plaid_secret file as missing when plaid_client_id is present', () => {
    let error: unknown;
    try {
      loadConfig({
        env: env(),
        readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: '   ' }),
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.some((p) => p.key === 'secret:plaid_secret')).toBe(true);
  });

  it('refuses to boot with only a client id and no secret', () => {
    expect(() =>
      loadConfig({
        env: env(),
        readSecret: secretsFrom({ plaid_client_id: CLIENT_ID }),
      }),
    ).toThrowError(/plaid_secret/);
  });

  it('refuses to boot with only a secret and no client id', () => {
    let error: unknown;
    try {
      loadConfig({ env: env(), readSecret: secretsFrom({ plaid_secret: SECRET }) });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems.some((p) => p.key === 'secret:plaid_client_id')).toBe(
      true,
    );
  });

  it('defaults plaid_env to sandbox when the file is absent', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
    });
    expect(config.plaid).not.toBeNull();
    expect(config.plaid?.environment).toBe('sandbox');
    expect(config.plaid?.clientId.reveal()).toBe(CLIENT_ID);
    expect(config.plaid?.secret.reveal()).toBe(SECRET);
  });

  it('accepts an explicit sandbox plaid_env', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({
        plaid_client_id: CLIENT_ID,
        plaid_secret: SECRET,
        plaid_env: 'sandbox',
      }),
    });
    expect(config.plaid?.environment).toBe('sandbox');
  });

  it('rejects an unrecognised plaid_env value', () => {
    expect(() =>
      loadConfig({
        env: env(),
        readSecret: secretsFrom({
          plaid_client_id: CLIENT_ID,
          plaid_secret: SECRET,
          plaid_env: 'bogus',
        }),
      }),
    ).toThrowError(/plaid_env/);
  });

  it("rejects 'development' by name — Plaid retired it as an API base path (01 §1.2)", () => {
    let error: unknown;
    try {
      loadConfig({
        env: env(),
        readSecret: secretsFrom({
          plaid_client_id: CLIENT_ID,
          plaid_secret: SECRET,
          plaid_env: 'development',
        }),
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = (error as ConfigError).problems.find((p) => p.key === 'secret:plaid_env');
    expect(problem?.problem).toMatch(/retired/);
  });

  it('refuses to boot with plaid_env=production and no PLAID_ALLOW_PRODUCTION opt-in (D16)', () => {
    let error: unknown;
    try {
      loadConfig({
        env: env(),
        readSecret: secretsFrom({
          plaid_client_id: CLIENT_ID,
          plaid_secret: SECRET,
          plaid_env: 'production',
        }),
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = (error as ConfigError).problems.find((p) => p.key === 'secret:plaid_env');
    expect(problem?.problem).toMatch(/ten-Item cap|production/);
  });

  it('boots against Production once PLAID_ALLOW_PRODUCTION=true is also set', () => {
    const config = loadConfig({
      env: env({ PLAID_ALLOW_PRODUCTION: 'true' }),
      readSecret: secretsFrom({
        plaid_client_id: CLIENT_ID,
        plaid_secret: SECRET,
        plaid_env: 'production',
      }),
    });
    expect(config.plaid?.environment).toBe('production');
  });

  it('parses PLAID_COUNTRY_CODES as a comma-separated list, trimmed', () => {
    const config = loadConfig({
      env: env({ PLAID_COUNTRY_CODES: 'US, CA' }),
      readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
    });
    expect(config.plaid?.countryCodes).toEqual(['US', 'CA']);
  });

  it('carries the redirect and webhook URLs through when set, null by default', () => {
    const unset = loadConfig({
      env: env(),
      readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
    });
    expect(unset.plaid?.redirectUri).toBeNull();
    expect(unset.plaid?.webhookUrl).toBeNull();

    const set = loadConfig({
      env: env({
        // The redirect URI's origin has to be one of AUTH_ALLOWED_ORIGINS
        // (see the describe block below) — this deployment's own.
        AUTH_RP_ID: 'nuc.tailnet-fake.ts.net',
        AUTH_ALLOWED_ORIGINS: 'https://nuc.tailnet-fake.ts.net',
        PLAID_REDIRECT_URI: 'https://nuc.tailnet-fake.ts.net/link/oauth',
        PLAID_WEBHOOK_URL: 'https://nuc.tailnet-fake.ts.net/webhooks/plaid',
      }),
      readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
    });
    expect(set.plaid?.redirectUri).toBe('https://nuc.tailnet-fake.ts.net/link/oauth');
    expect(set.plaid?.webhookUrl).toBe('https://nuc.tailnet-fake.ts.net/webhooks/plaid');
  });

  describe('PLAID_REDIRECT_URI (D12; gate-security-review.md §2.2 F-2, §6 C-3)', () => {
    const MATCHING_ORIGIN = {
      AUTH_RP_ID: 'nuc.tailnet-fake.ts.net',
      AUTH_ALLOWED_ORIGINS: 'https://nuc.tailnet-fake.ts.net',
    } as const;

    it('accepts an https redirect URI whose origin is an allowed origin', () => {
      const config = loadConfig({
        env: env({
          ...MATCHING_ORIGIN,
          PLAID_REDIRECT_URI: 'https://nuc.tailnet-fake.ts.net/link/oauth',
        }),
        readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
      });
      expect(config.plaid?.redirectUri).toBe('https://nuc.tailnet-fake.ts.net/link/oauth');
    });

    it('refuses a non-https redirect URI, even when its origin would otherwise match', () => {
      expect(() =>
        loadConfig({
          env: env({
            AUTH_RP_ID: 'nuc.tailnet-fake.ts.net',
            AUTH_ALLOWED_ORIGINS: 'http://nuc.tailnet-fake.ts.net',
            PLAID_REDIRECT_URI: 'http://nuc.tailnet-fake.ts.net/link/oauth',
          }),
          readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
        }),
      ).toThrowError(/PLAID_REDIRECT_URI/);
    });

    it('refuses a redirect URI whose origin is not an allowed origin', () => {
      let error: unknown;
      try {
        loadConfig({
          env: env({
            ...MATCHING_ORIGIN,
            // Different host than AUTH_ALLOWED_ORIGINS above.
            PLAID_REDIRECT_URI: 'https://not-this-deployment.example.com/link/oauth',
          }),
          readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      const problem = (error as ConfigError).problems.find((p) => p.key === 'PLAID_REDIRECT_URI');
      expect(problem?.problem).toMatch(/not one of AUTH_ALLOWED_ORIGINS/);
    });

    it('is not a problem when unset, even with no Plaid credentials at all', () => {
      const config = loadConfig({ env: env(), readSecret: secretsFrom({}) });
      expect(config.plaid).toBeNull();
    });

    it('treats an empty-string env value as absent, the same as an unset key', () => {
      // compose.yml passes this through as `${PLAID_REDIRECT_URI:-}` — an
      // operator with no PLAID_REDIRECT_URI in .env hands the container an
      // empty string, not a missing key. `z.url()` alone would reject "" as
      // an invalid URL and fail every fresh boot with no Plaid OAuth in use.
      const config = loadConfig({
        env: env({ PLAID_REDIRECT_URI: '', PLAID_WEBHOOK_URL: '' }),
        readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
      });
      expect(config.plaid?.redirectUri).toBeNull();
      expect(config.plaid?.webhookUrl).toBeNull();
    });
  });

  it('never puts the client id or secret in an error message', () => {
    let error: unknown;
    try {
      loadConfig({
        env: env(),
        readSecret: secretsFrom({
          plaid_client_id: CLIENT_ID,
          plaid_secret: SECRET,
          plaid_env: 'bogus',
        }),
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CLIENT_ID);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('keeps the client id and secret out of anything serialisable, by name only', () => {
    const config = loadConfig({
      env: env(),
      readSecret: secretsFrom({ plaid_client_id: CLIENT_ID, plaid_secret: SECRET }),
    });
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain(CLIENT_ID);
    expect(serialised).not.toContain(SECRET);
    expect(JSON.stringify(describeConfig(config))).not.toContain(CLIENT_ID);
    expect(JSON.stringify(describeConfig(config))).not.toContain(SECRET);
    expect(describeConfig(config)['secretsPresent']).toEqual([
      'database_url',
      'master_key',
      'plaid_client_id',
      'plaid_secret',
    ]);
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
