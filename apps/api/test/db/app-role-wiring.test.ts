// SPDX-License-Identifier: MIT
/**
 * Phase 9 gate, G9-5 / condition C9-2: the role split's **wiring** is tested
 * through the shipped composition.
 *
 * `app-role.test.ts` proves what the DML-only role can and cannot do, and says
 * it "connects exactly as `main.ts` and `worker.ts` do" — but it builds its own
 * pool from `db-role.ts`. Nothing imported or read `main.ts` / `worker.ts`'s
 * pool construction, so reverting either line to the raw login URL made the
 * serving process the cluster SUPERUSER again with every test green (the gate's
 * RS3; P5-1's parallel-construction class, which C5-11 names).
 *
 * This file asserts against the processes themselves.
 *
 * 1. **The real `main.ts` and the real `worker.ts` are spawned** (`node
 *    src/main.ts`, `node src/worker.ts`: the entry points the images run)
 *    against a scratch database `personalfi_c9_*`, migrated, logging in as the
 *    cluster's superuser exactly as the shipped `database_url` does. Before
 *    they boot, the test installs a probe trigger on `config_snapshots`, the
 *    table both processes write once at boot through their pool
 *    (`recordConfigSnapshot`, after `createPool`). The trigger records
 *    `current_user`, `session_user` and whether that role is a superuser for
 *    the connection that wrote the row. The assertion is on those: the pool the
 *    process built from its own composition root is `personalfi_app`, not the
 *    superuser login. Nothing here builds a pool.
 * 2. **The boot order is read from the source**, as
 *    `kek-derivation-wiring.test.ts` reads it: `ensureAppRole(` before
 *    `createPool(`, the pool's URL is `appRoleDatabaseUrl(…)` and nothing else,
 *    and the pool is created before anything uses it. (The probe above is the
 *    behaviour; this is the second layer, cheap and instant, and the one that
 *    still says why when the database is not there.)
 *
 * Sabotage (docs/evidence/phase-9/gate-conditions-c9-1-2-9.md): RS3 —
 * `main.ts`'s `databaseUrl: appRoleDatabaseUrl(…)` replaced by
 * `config.databaseUrl.reveal()` — turns the api's boot case and the source
 * case red; the same edit to `worker.ts` turns the worker's.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DATABASE_ROLE } from '../../src/db-role.ts';
import { createTempSecrets, type TempSecrets } from '../helpers/secrets.ts';

const describeWithDb = process.env['DATABASE_URL'] === undefined ? describe.skip : describe;

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const src = (file: string): string => readFileSync(`${API_ROOT}src/${file}`, 'utf8');

/** Code only: a comment is where a removed call would still be "mentioned". */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('G9-5: the serving entry points open their pool as the app role (source, boot order)', () => {
  for (const file of ['main.ts', 'worker.ts'] as const) {
    it(`${file}: ensureAppRole over the login URL, then a pool whose URL is appRoleDatabaseUrl(login URL), before anything uses it`, () => {
      const source = code(src(file));

      const ensure = source.search(/\bensureAppRole\(config\.databaseUrl\.reveal\(\)\)/);
      expect(
        ensure,
        `${file} no longer re-asserts the app role over the login URL`,
      ).toBeGreaterThan(-1);

      const create = source.search(/\bcreatePool\(\{/);
      expect(create, `${file} no longer creates a pool`).toBeGreaterThan(-1);
      expect(ensure, `${file}: ensureAppRole must run before the pool opens`).toBeLessThan(create);

      // The pool's connection string, and nothing but the role-switched URL.
      const call = /\bcreatePool\(\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? '';
      expect(
        call,
        `${file}: the pool is not opened with appRoleDatabaseUrl(config.databaseUrl.reveal())`,
      ).toMatch(/databaseUrl:\s*appRoleDatabaseUrl\(config\.databaseUrl\.reveal\(\)\)\s*,/);

      // Exactly one pool in the entry point, and the raw login URL reaches
      // nothing but `ensureAppRole` and `appRoleDatabaseUrl`.
      expect([...source.matchAll(/\bcreatePool\(/g)]).toHaveLength(1);
      const revealed = [...source.matchAll(/config\.databaseUrl\.reveal\(\)/g)].length;
      const wrapped = [
        ...source.matchAll(
          /(?:ensureAppRole|appRoleDatabaseUrl)\(config\.databaseUrl\.reveal\(\)\)/g,
        ),
      ].length;
      expect(
        revealed,
        `${file}: config.databaseUrl.reveal() is used outside ensureAppRole/appRoleDatabaseUrl`,
      ).toBe(wrapped);

      // The pool exists before the platform (and so everything) is built on it.
      const platform = source.search(/\bbuildPlatform\(/);
      expect(platform).toBeGreaterThan(create);
    });
  }
});

describeWithDb('G9-5: the spawned api and worker connect as the DML-only app role', () => {
  let database: TestDatabase;
  let secrets: TempSecrets;

  /** What the probe trigger saw: one row per `config_snapshots` write. */
  interface Probe {
    readonly role: string;
    readonly current_user: string;
    readonly session_user: string;
    readonly rolsuper: boolean;
  }

  beforeAll(async () => {
    database = await createTestDatabase(
      `personalfi_c9_wiring_${newId().replaceAll('-', '').slice(-8)}`,
    );
    secrets = createTempSecrets({});
    await database.pool.query(`
      CREATE TABLE c9_role_probe (
        role text NOT NULL,
        current_user_name text NOT NULL,
        session_user_name text NOT NULL,
        rolsuper boolean NOT NULL
      );
      GRANT INSERT ON c9_role_probe TO PUBLIC;
      CREATE FUNCTION c9_role_probe() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        INSERT INTO c9_role_probe
        SELECT NEW.role, current_user::text, session_user::text, r.rolsuper
        FROM pg_roles r WHERE r.rolname = current_user;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER c9_role_probe BEFORE INSERT ON config_snapshots
        FOR EACH ROW EXECUTE FUNCTION c9_role_probe();
    `);
  }, 120_000);

  afterAll(async () => {
    secrets?.dispose();
    await database?.drop();
  }, 60_000);

  async function freePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  /** Boot `node src/<entry>`, wait for its boot-time `config_snapshots` write, stop it. */
  async function bootAndProbe(
    entry: 'main.ts' | 'worker.ts',
    role: 'api' | 'worker',
  ): Promise<{ probes: Probe[]; output: string; exit: string }> {
    const port = await freePort();
    let output = '';
    const child: ChildProcess = spawn(process.execPath, [`${API_ROOT}src/${entry}`], {
      cwd: API_ROOT,
      // A clean environment: nothing from the test runner's own DATABASE_URL, secrets or flags.
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DATABASE_URL: database.url,
        SECRETS_DIR: secrets.dir,
        BASE_URL: 'http://127.0.0.1',
        AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1',
        AUTH_RP_ID: '127.0.0.1',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: String(port),
        KEK_ARGON2_MEMORY_KIB: '8192',
        KEK_ARGON2_TIME_COST: '2',
        KEK_ARGON2_PARALLELISM: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    let exitDescription = 'still running';
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        exitDescription = `exit ${String(code)} signal ${String(signal)}`;
        resolve();
      });
    });

    try {
      const deadline = Date.now() + 45_000;
      let probes: Probe[] = [];
      while (Date.now() < deadline && exitDescription === 'still running') {
        const { rows } = await database.pool.query<Probe>(
          `SELECT role, current_user_name AS current_user, session_user_name AS session_user, rolsuper
             FROM c9_role_probe WHERE role = $1`,
          [role],
        );
        probes = rows;
        if (probes.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { probes, output, exit: exitDescription };
    } finally {
      if (exitDescription === 'still running') child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await exited;
      clearTimeout(killer);
    }
  }

  for (const [entry, role] of [
    ['main.ts', 'api'],
    ['worker.ts', 'worker'],
  ] as const) {
    it(`the real ${entry}: the connection that writes its boot-time config snapshot is ${APP_DATABASE_ROLE}, not the login superuser`, async () => {
      const { probes, output, exit } = await bootAndProbe(entry, role);
      expect(
        probes.length,
        `${entry} never wrote its config snapshot through its pool (${exit}). Output:\n${output.slice(-3000)}`,
      ).toBeGreaterThan(0);
      for (const probe of probes) {
        expect(probe).toEqual({
          role,
          current_user: APP_DATABASE_ROLE,
          // The login is still the cluster superuser (the shipped database_url);
          // the role switch is what makes the session harmless.
          session_user: expect.not.stringMatching(new RegExp(`^${APP_DATABASE_ROLE}$`)) as string,
          rolsuper: false,
        });
      }
    }, 90_000);
  }
});
