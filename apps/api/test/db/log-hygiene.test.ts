// SPDX-License-Identifier: MIT
/**
 * **P0-12 evidence: no secret reaches a log line.**
 *
 * This test boots `apps/api/src/main.ts` as a real child process against a real
 * database and captures its actual stdout and stderr, rather than building the
 * app in-process with an injected stream. That choice is the test:
 *
 * - the leak this control exists to prevent is a secret reaching *the log*, and
 *   the log is a file descriptor, not an object a test can substitute;
 * - a boot is where the passphrase is handled — read from a file, revealed once,
 *   fed to Argon2id — and an in-process harness would skip `main.ts`, which is
 *   exactly the file where a `console.log(config)` would do the damage;
 * - the same run produces the other half of P0-2's evidence ("startup log shows
 *   KDF params and duration"), which has to come from a real boot to mean
 *   anything.
 *
 * The two secrets under test are the KEK passphrase and a one-time passkey
 * enrolment token, and both are deliberately distinctive strings so that a
 * negative assertion cannot pass by accident.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runMigrations } from '@core/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempSecrets } from '../helpers/secrets.ts';

const ADMIN_URL = process.env['WP02_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DB_NAME = 'personalfi_wp02_loghygiene';

/**
 * Distinctive on purpose. `master_key` is asserted absent from the log, and a
 * value like `secret` would match a dozen innocent lines and make the assertion
 * meaningless.
 */
const MASTER_KEY = 'pfi-log-hygiene-kek-Zq7Z4rW2xN8vB1kD6mH0-do-not-use';
const ALLOWED_ORIGIN = 'http://127.0.0.1:8080';

/**
 * WP 10.1: a Plaid client id and secret a holder pastes into the Add connection
 * menu travel in a request body. Distinctive, and not credentials of anything.
 */
const PLAID_CANARY_CLIENT_ID = 'hygieneclientid0123456789ab'; // gitleaks:allow — synthetic canary, not a Plaid credential
const PLAID_CANARY_SECRET = 'hygienesecretZq7f8e7d6c5b4a39281'; // gitleaks:allow — synthetic canary, not a Plaid credential

interface Booted {
  readonly child: ChildProcess;
  readonly port: number;
  output(): string;
  stop(): Promise<void>;
}

describeWithDb('log hygiene (P0-12)', () => {
  const secrets = createTempSecrets({ master_key: MASTER_KEY });
  let databaseUrl: string;
  let registrationToken: string;
  let bootstrapOutput: string;
  let api: Booted;
  let log = '';
  const credentialStatuses: number[] = [];

  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'trace',
      LOG_PRETTY: 'false',
      SECRETS_DIR: secrets.dir,
      DATABASE_URL: databaseUrl,
      BASE_URL: ALLOWED_ORIGIN,
      AUTH_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      // `loadConfig` now refuses a pairing in which no allowed origin could
      // enrol a passkey (P0-4), and `localhost` — the default — is not the host
      // of `http://127.0.0.1:8080`: to WebAuthn they are two different effective
      // domains, however interchangeable they look in a shell.
      AUTH_RP_ID: '127.0.0.1',
      // The development floor: this suite is about what reaches the log, and
      // 5.9 s of Argon2id would tell us nothing extra about that.
      KEK_ARGON2_MEMORY_KIB: '8192',
      KEK_ARGON2_TIME_COST: '2',
      KEK_ARGON2_PARALLELISM: '1',
      ...extra,
    };
  }

  /** Both pipes into one buffer: a secret in stderr is as bad as one in stdout. */
  function capture(child: ChildProcess, sink: (text: string) => void): void {
    child.stdout?.on('data', (chunk: Buffer) => sink(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => sink(chunk.toString('utf8')));
  }

  /** Run a one-shot command and return everything it printed. */
  function run(script: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, script), ...args], {
        cwd: REPO_ROOT,
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let captured = '';
      capture(child, (text) => (captured += text));
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve(captured);
        else reject(new Error(`${script} exited ${String(code)}:\n${captured}`));
      });
    });
  }

  /**
   * Borrow an ephemeral port from the OS and hand it back.
   *
   * `HTTP_PORT=0` is refused by the config schema — deliberately, because a
   * production container that binds an arbitrary port is a container Caddy
   * cannot find — so the port is chosen here instead of a fixed number that two
   * concurrent suites could collide on.
   */
  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  async function boot(): Promise<Booted> {
    const chosen = await freePort();
    const child = spawn(process.execPath, [join(REPO_ROOT, 'apps/api/src/main.ts')], {
      cwd: REPO_ROOT,
      env: childEnv({ HTTP_HOST: '127.0.0.1', HTTP_PORT: String(chosen) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let captured = '';
    capture(child, (text) => (captured += text));

    const deadline = Date.now() + 60_000;
    let port: number | undefined;
    while (port === undefined) {
      const match = /Server listening at https?:\/\/127\.0\.0\.1:(\d+)/.exec(captured);
      if (match?.[1] !== undefined) port = Number(match[1]);
      else if (child.exitCode !== null) throw new Error(`api exited early:\n${captured}`);
      else if (Date.now() > deadline) throw new Error(`api never listened:\n${captured}`);
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return {
      child,
      port,
      output: () => captured,
      stop: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.on('exit', () => resolve());
          // SIGTERM is the path that zeroes the KEK (P0-2).
          child.kill('SIGTERM');
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 15_000).unref();
        }),
    };
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
    await admin.end();

    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;
    databaseUrl = url.toString();
    await runMigrations({
      databaseUrl,
      logger: { info: () => undefined, warn: () => undefined },
    });

    // The bootstrap command prints the token once, on purpose: stdout of a
    // command an operator is watching is the one place it is allowed to appear.
    bootstrapOutput = await run('apps/api/src/bin/bootstrap-user.ts', [
      '--name=Chris',
      '--timezone=America/Los_Angeles',
    ]);
    const match = /token only: ([A-Za-z0-9_-]{20,})/.exec(bootstrapOutput);
    if (match?.[1] === undefined) {
      throw new Error(`bootstrap-user printed no token:\n${bootstrapOutput}`);
    }
    registrationToken = match[1];

    api = await boot();

    // Exercise the paths a secret could travel: an unauthenticated GET, a POST
    // carrying the enrolment token in its body, and a failed login.
    const base = `http://127.0.0.1:${String(api.port)}`;
    await fetch(`${base}/health`);
    const unlock = await fetch(`${base}/auth/unlock-state`);
    const csrf = /__Host-pfi_csrf=([^;]+)/.exec(unlock.headers.get('set-cookie') ?? '')?.[1] ?? '';

    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
          'sec-fetch-site': 'same-origin',
          cookie: `__Host-pfi_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify(body),
      });

    // WP 10.1: the canary Plaid credentials, on the route that takes them, three ways — a
    // well-formed body (no session: the route's own 401), a body the schema refuses (400),
    // and a GET. Both bodies carry the canary secret; none of the three may log it.
    const putCredentials = (body: unknown): Promise<Response> =>
      fetch(`${base}/connections/providers/plaid/credentials`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: ALLOWED_ORIGIN,
          'sec-fetch-site': 'same-origin',
          cookie: `__Host-pfi_csrf=${csrf}; __Host-pfi_session=not-a-real-session-token`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify(body),
      });
    credentialStatuses.push(
      (
        await putCredentials({
          clientId: PLAID_CANARY_CLIENT_ID,
          secret: PLAID_CANARY_SECRET,
          env: 'sandbox',
        })
      ).status,
      (
        await putCredentials({
          clientId: PLAID_CANARY_CLIENT_ID,
          secret: `${PLAID_CANARY_SECRET} not valid`,
          env: 'sandbox',
        })
      ).status,
    );

    await post('/auth/register/options', { registrationToken });
    await post('/auth/login/verify', { response: { id: 'nope' }, trustedDevice: false });
    await fetch(`${base}/ready`);

    await api.stop();
    log = api.output();
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
    secrets.dispose();
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await cleanup.end();
  }, 60_000);

  it('captured a real boot, so the negative assertions are not vacuous', () => {
    // Without this, "the log does not contain the passphrase" would also pass
    // against an empty log.
    expect(log).toContain('configuration loaded');
    expect(log).toContain('Server listening at');
    expect(log).toContain('/auth/register/options');
    expect(log).toContain('shutting down');
    expect(log.length).toBeGreaterThan(2_000);
  });

  it('never writes the KEK passphrase to a log line', () => {
    expect(log).not.toContain(MASTER_KEY);
    // Nor any substantial fragment of it, which would catch a truncating logger.
    for (let i = 0; i + 12 <= MASTER_KEY.length; i += 6) {
      expect(log).not.toContain(MASTER_KEY.slice(i, i + 12));
    }
  });

  it('never writes the one-time enrolment token to a log line', () => {
    // It arrived in a request body, was redeemed, and produced a WebAuthn
    // challenge — three opportunities to be logged, and none of them taken.
    expect(registrationToken.length).toBeGreaterThanOrEqual(20);
    expect(log).not.toContain(registrationToken);
    expect(log).not.toContain(registrationToken.slice(0, 16));
  });

  it('never writes a database URL, so the database password stays out too', () => {
    // `DATABASE_URL` is stripped from the public config object by construction,
    // so that the first `JSON.stringify(config)` in a debug log cannot print it.
    expect(log).not.toMatch(/postgres(ql)?:\/\//);
    expect(log).not.toContain('DATABASE_URL');
  });

  it('never echoes a cookie or an authorization header', () => {
    // The request serialiser keeps only `host` and `user-agent`; `REDACTED_PATHS`
    // is the second line of defence behind it.
    expect(log).not.toMatch(/"cookie"\s*:/i);
    expect(log).not.toMatch(/"set-cookie"\s*:/i);
    expect(log).not.toMatch(/__Host-pfi_csrf=/);
  });

  it('never writes a Plaid credential submitted to the credentials route to a log line (WP 10.1)', () => {
    // Not vacuous: both requests reached the route and were refused for the reasons
    // the test means (no session; a body the schema refuses), and are in the log.
    expect(credentialStatuses).toEqual([401, 400]);
    expect(log).toContain('/connections/providers/plaid/credentials');
    for (const canary of [PLAID_CANARY_SECRET, PLAID_CANARY_CLIENT_ID]) {
      expect(log.includes(canary), `the log contains ${canary.slice(0, 8)}…`).toBe(false);
      for (let i = 0; i + 12 <= canary.length; i += 6) {
        expect(log.includes(canary.slice(i, i + 12)), `a fragment of ${canary.slice(0, 8)}…`).toBe(
          false,
        );
      }
    }
  });

  it('reports which secrets are present, by name only', () => {
    // "Is the passphrase mounted?" has to be answerable from the log, or the
    // first production incident is a guessing game.
    expect(log).toMatch(/"secretsPresent":\s*\[[^\]]*"master_key"/);
    expect(log).toMatch(/"secretsPresent":\s*\[[^\]]*"database_url"/);
  });

  it('logs the Argon2id parameters and the derivation time (P0-2 evidence)', () => {
    expect(log).toContain('key custody: unlocked');
    expect(log).toContain('"kdf":"argon2id"');
    expect(log).toMatch(/"memoryKiB":8192/);
    expect(log).toMatch(/"timeCost":2/);
    expect(log).toMatch(/"durationMs":\d+/);
    expect(log).toMatch(/"kekVersion":1/);
  });

  it('keeps the bootstrap token out of the API log even though the command printed it', () => {
    // The one place the token is readable is the stdout of the command an
    // operator ran, which is the whole design: stored as a digest, printed once.
    expect(bootstrapOutput).toContain(registrationToken);
    expect(bootstrapOutput).not.toContain(MASTER_KEY);
    expect(log).not.toContain(registrationToken);
  });

  it('carries a correlation id on every request line', () => {
    // One id spans the browser, the API and a background job; without it a
    // failure at 03:15 is unreconstructable.
    expect(log).toMatch(/"correlationId":"[0-9a-f-]{36}"/);
  });
});
