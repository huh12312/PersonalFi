// SPDX-License-Identifier: MIT
/**
 * WP 11.8 — an install can no longer configure a narrator that can never run.
 *
 * Production ran three weeks with `secrets/advisor_token_secret` an empty
 * placeholder: the worker registered `module.insights`' events and nothing
 * else (by design), while the api read `module.insights` "on", let the holder
 * set up a hosted narrator and offered "Run control checks". Each surface now
 * reads the worker's registration from the same wiring (`module-registration.ts`,
 * the function `insightsModule` itself asks), with no database read:
 *
 * - `/ready`'s `modules` line names every module flag, `registered` and the reason;
 * - `GET`/`PUT /advisors/module/enabled` carry `worker.insightsRegistered`;
 * - the control checks' level-1 line names the registration;
 * - `POST /narrator/control-checks` refuses 503 and `just genai-selftest`
 *   exits 78, each before anything is enqueued.
 *
 * The unregistered install is the production shape exactly: the secret file
 * present but empty (what `scripts/secrets-placeholders.sh` writes).
 */
import { mutableClock, newId } from '@core/kernel';
import { checkModuleSwitch } from '@ctx/insights';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { apiCheckPorts } from '../../src/control-checks.ts';
import { createInvestmentSyncPort } from '../../src/domain.ts';
import { appModules } from '../../src/modules.ts';
import type { NarratorRuntime } from '../../src/narrator-wiring.ts';
import { MODULE_FLAGS } from '../../src/platform.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const TOKEN_SECRET = 'wp118-registered-token-secret-0123456789abcdef';

interface ModuleState {
  operator: { advisorsEnabled: boolean };
  user: { enabled: boolean };
  effective: boolean;
  worker: { insightsRegistered: boolean; reason: string | null };
}

interface ReadyBody {
  status: string;
  modules?: { flag: string; registered: boolean; reason?: string }[];
  degradedReasons?: string[];
}

/** The preview runtime's shape with no narrator: the level-1 line needs none. */
const NO_NARRATOR: Pick<NarratorRuntime, 'resolve' | 'forUser'> = {
  resolve: () => Promise.resolve({ provider: 'off', narrator: null, reason: 'off' }),
  forUser: () => Promise.resolve(null),
};

async function levelOneLine(h: ApiHarness): Promise<string> {
  const ports = await apiCheckPorts(
    {
      database: h.database.db,
      pool: h.database.pool,
      clock: mutableClock('2026-10-31T12:00:00.000Z'),
      config: h.config,
      runtime: NO_NARRATOR,
      preview: undefined,
    },
    { userId: h.userId, clock: mutableClock('2026-10-31T12:00:00.000Z'), correlationId: newId() },
  );
  const outcome = await checkModuleSwitch(ports.moduleSwitch, { prove: false });
  return outcome.facts[0] ?? '';
}

/**
 * `module.insights` as `worker.ts` builds it: the secret passed exactly the way
 * the worker passes it (`config.secrets.advisor_token_secret`, revealed).
 */
function workerInsightsModule(h: ApiHarness) {
  const denyAll = createEgressPolicy({ allowedHosts: [] });
  const secret = h.config.secrets.advisor_token_secret;
  return appModules({
    advisorsEnabled: true,
    localModelConfigured: false,
    database: h.database.db,
    userId: h.userId,
    orchestrator: h.orchestrator,
    timezone: 'UTC',
    notificationChannels: {
      ntfy: createNtfyChannel({ policy: denyAll }),
      smtp: createSmtpChannel({ policy: denyAll }),
    },
    secretBox: h.security.requireSecretBox(),
    investmentSyncPort: createInvestmentSyncPort(h.database.db),
    ...(secret === undefined ? {} : { advisorTokenSecret: secret.reveal() }),
  }).find((module) => module.flagKey === 'module.insights');
}

async function controlCheckRows(h: ApiHarness): Promise<{ runs: number; jobs: number }> {
  const runs = await h.database.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ops_control_checks',
  );
  const jobs = await h.database.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM jobs WHERE kind = 'insights.control_checks'",
  );
  return { runs: Number(runs.rows[0]?.count), jobs: Number(jobs.rows[0]?.count) };
}

/** `just genai-selftest`'s script, as the recipe runs it, against this harness's database and secrets. */
async function selftest(h: ApiHarness): Promise<{ exit: number | null; output: string }> {
  const script = fileURLToPath(new URL('../../src/bin/genai-selftest.ts', import.meta.url));
  let output = '';
  const child = spawn(process.execPath, [script, `--holder=${h.userId}`], {
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: h.config.databaseUrl.reveal(),
      SECRETS_DIR: h.config.env.SECRETS_DIR,
      BASE_URL: 'http://127.0.0.1',
      AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1',
      AUTH_RP_ID: '127.0.0.1',
      KEK_ARGON2_MEMORY_KIB: '8192',
      KEK_ARGON2_TIME_COST: '2',
      KEK_ARGON2_PARALLELISM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { exit, output };
}

describe.skipIf(NO_DATABASE)('WP 11.8: an install without advisor_token_secret', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    // The production shape: the placeholder file exists and is empty.
    h = await createApiHarness({ suite: 'wp118unreg', extraSecrets: { advisor_token_secret: '' } });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('the worker wiring registers module.insights events only — the fact every surface below reports', () => {
    const insights = workerInsightsModule(h);
    expect(insights?.events?.length).toBeGreaterThan(0);
    expect(insights?.consumers ?? []).toEqual([]);
    expect(insights?.jobs ?? []).toEqual([]);
    expect(insights?.schedules).toBeUndefined();
  });

  it("/ready names every module flag; module.insights reads registered: false with the reason, and the probe's status is untouched", async () => {
    const response = await h.request({ method: 'GET', url: '/ready' });
    expectStatus(response, 200);
    const body = response.json() as ReadyBody;
    expect(body.status).toBe('ready');
    expect(body.degradedReasons).toBeUndefined();
    expect(body.modules).toEqual(
      MODULE_FLAGS.map(({ key }) =>
        key === 'module.insights'
          ? { flag: key, registered: false, reason: 'advisor_token_secret absent' }
          : { flag: key, registered: true },
      ),
    );
  });

  it('GET and PUT /advisors/module/enabled carry worker.insightsRegistered false — while the holder flag reads on', async () => {
    const read = await h.request({
      method: 'GET',
      url: '/advisors/module/enabled',
      session: h.stale,
    });
    expectStatus(read, 200);
    const state = read.json() as ModuleState;
    expect(state.user.enabled).toBe(true);
    expect(state.worker).toEqual({
      insightsRegistered: false,
      reason: 'advisor_token_secret absent',
    });

    const written = await h.request({
      method: 'PUT',
      url: '/advisors/module/enabled',
      session: h.fresh,
      body: { enabled: true },
    });
    expectStatus(written, 200);
    expect((written.json() as ModuleState).worker.insightsRegistered).toBe(false);
  });

  it("the control checks' level-1 line says the worker's insights module is NOT registered", async () => {
    expect(await levelOneLine(h)).toContain(
      "the worker's insights module is NOT registered: advisor_token_secret absent.",
    );
  });

  it('POST /narrator/control-checks refuses 503 before starting anything', async () => {
    const before = await controlCheckRows(h);
    const response = await h.request({
      method: 'POST',
      url: '/narrator/control-checks',
      session: h.fresh,
      body: {},
    });
    expectStatus(response, 503);
    const problem = problemOf(response);
    expect(problem['code']).toBe('insights.advisor_token_secret_unconfigured');
    expect(problem['detail']).toContain('The insights module is not enabled on this install');
    expect(await controlCheckRows(h)).toEqual(before);
  });

  it('`just genai-selftest` exits 78 with the sentence and enqueues nothing', async () => {
    const before = await controlCheckRows(h);
    const { exit, output } = await selftest(h);
    expect(exit, output).toBe(78);
    expect(output).toContain(
      "genai-selftest: the worker's insights module is NOT registered: advisor_token_secret absent.",
    );
    expect(output).toContain(
      'The insights module is not enabled on this install: the operator has not written advisor_token_secret.',
    );
    expect(output).not.toContain('GenAI controls self-test');
    expect(await controlCheckRows(h)).toEqual(before);
  }, 60_000);
});

describe.skipIf(NO_DATABASE)('WP 11.8: an install with advisor_token_secret', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp118reg',
      extraSecrets: { advisor_token_secret: TOKEN_SECRET },
    });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('the worker wiring registers module.insights in full', () => {
    const insights = workerInsightsModule(h);
    expect(insights?.consumers?.length).toBeGreaterThan(0);
    expect(insights?.jobs?.map((job) => job.kind)).toContain('insights.run');
    expect(insights?.schedules).toBeTypeOf('function');
  });

  it('/ready reads every module registered, with no reason', async () => {
    const response = await h.request({ method: 'GET', url: '/ready' });
    expectStatus(response, 200);
    expect((response.json() as ReadyBody).modules).toEqual(
      MODULE_FLAGS.map(({ key }) => ({ flag: key, registered: true })),
    );
  });

  it('GET /advisors/module/enabled reads worker.insightsRegistered true, reason null', async () => {
    const read = await h.request({
      method: 'GET',
      url: '/advisors/module/enabled',
      session: h.stale,
    });
    expectStatus(read, 200);
    expect((read.json() as ModuleState).worker).toEqual({ insightsRegistered: true, reason: null });
  });

  it("the control checks' level-1 line says the worker's insights module is registered", async () => {
    expect(await levelOneLine(h)).toContain("the worker's insights module is registered.");
  });
});
