// SPDX-License-Identifier: MIT
/**
 * WP 10.16 — Settings, Language model, "Run control checks", end to end
 * against Postgres: the route (step-up, the 10-minute window, the row), the
 * api's half of the catalogue against the real tables, and the worker's half
 * as the real `insights.control_checks` job through a real job runner, its
 * probes going through the **real hosted adapter** over the hermetic vendor
 * fake (no vendor is called). The holder's approvals, settings, consents and
 * flags are read before and after every run and asserted equal.
 */
import {
  createHostedBudget,
  createHostedModelAdapter,
  type HostedModelAdapter,
} from '@advisor/local-model';
import {
  FakeHostedTransport,
  fakeHostedOk as ok,
  PUBLIC_RESOLVE,
  recordedReply,
  SYNTHETIC_KEY,
  type RecordedHostedCall,
} from '@advisor/local-model/test';
import { mutableClock, systemClock } from '@core/kernel';
import { createJobRunner, platformExecutor, silentLogger } from '@core/platform';
import {
  CONTROL_PROBE_NUMBER,
  createControlChecksJob,
  type ResolvedProbeModel,
} from '@ctx/insights';
import type { TransportResponse } from '@core/platform';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlProbeModelOf } from '../../src/narrator-wiring.ts';
import { NARRATOR_CONSENT_VERSION } from '../../src/narrator-consent.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

const ANTHROPIC_KEY = 'sk-ant-canaryWP1016anthropic000000000000000wxyz'; // gitleaks:allow — synthetic canary, not a credential

interface Row {
  id: string;
  status: string;
  reason: string | null;
  facts: string[];
  notApplicable: boolean;
}
interface Run {
  id: string;
  state: string;
  overall: string | null;
  provider: string;
  model: string | null;
  results: Row[];
}
interface Runs {
  runs: Run[];
  provider: string;
  cost: { modelCalls: number; hosted: boolean; message: string };
  nextAllowedAt: string | null;
  lastProven: { at: string; overall: string } | null;
}

/** A vendor that reads the probe's instruction and answers as a model might. */
function vendor(call: RecordedHostedCall): TransportResponse | Promise<TransportResponse> {
  const text = JSON.stringify(call.body);
  const answer = (content: string) => ok(recordedReply('anthropic', content));
  const narration = (summary: string) =>
    JSON.stringify({
      insights: [
        {
          finding: 1,
          severity: 'info',
          title: 'A control check',
          summary_md: summary,
          confidence: 0.8,
          confidence_basis: 'model',
          horizon: 'next_quarter',
          requires_review: true,
          impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
          derivations: [],
          proposed_actions: [],
          caveats: [],
          expires_at: null,
        },
      ],
    });
  if (text.includes('greatest length')) {
    // The cancel probe: a model that takes its time. The adapter's signal closes it.
    return new Promise(() => undefined);
  }
  if (text.includes(`write the number ${CONTROL_PROBE_NUMBER}`)) {
    return answer(narration(`The figure is ${CONTROL_PROBE_NUMBER}, beside {{e1}}.`));
  }
  if (text.includes('do not use the JSON format')) {
    return answer('Here is a plain English sentence instead of the format.');
  }
  return answer('{"insights": []}');
}

/** The vendor's socket: a pending answer rejects when the adapter's signal fires. */
function closingTransport(fake: FakeHostedTransport) {
  return (request: Parameters<FakeHostedTransport['transport']>[0]) =>
    new Promise<TransportResponse>((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('socket destroyed')));
      void fake.transport(request).then(resolve, reject);
    });
}

describe.skipIf(NO_DATABASE)('Run control checks (WP 10.16)', () => {
  let h: ApiHarness;
  const clock = mutableClock('2026-10-19T08:00:00.000Z');
  const fake = new FakeHostedTransport(vendor);
  let adapter: HostedModelAdapter;
  let fresh: TestSession;
  let stale: TestSession;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1016cc', clock, controlChecksCeilingMs: 4_000 });
    fresh = h.fresh;
    stale = h.stale;
    adapter = createHostedModelAdapter(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        timeoutMs: 120_000,
        key: { reveal: () => SYNTHETIC_KEY },
      },
      { transport: closingTransport(fake), resolve: PUBLIC_RESOLVE, budget: createHostedBudget() },
    );
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  async function refreshSessions(): Promise<void> {
    fresh = await h.issueSession({ fresh: true });
    stale = await h.issueSession({ fresh: false });
  }

  const list = async (session = stale): Promise<Runs> => {
    const response = await h.request({ method: 'GET', url: '/narrator/control-checks', session });
    expectStatus(response, 200);
    return response.json() as Runs;
  };
  const start = (body: Record<string, unknown> = {}, session = fresh) =>
    h.request({ method: 'POST', url: '/narrator/control-checks', session, body });

  /** The worker: the real job, through a real runner, over the real hosted adapter. */
  async function runWorker(until: () => Promise<boolean>, probe?: ResolvedProbeModel) {
    const runner = createJobRunner({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      handlers: [
        createControlChecksJob({
          database: h.database.db,
          clock: systemClock,
          probeFor: () =>
            Promise.resolve(
              probe ?? { model: controlProbeModelOf('anthropic', adapter), unavailable: null },
            ),
        }),
      ],
      concurrency: 1,
      pollIntervalMs: 25,
      logger: silentLogger,
    });
    await runner.start();
    try {
      await expect.poll(until, { timeout: 30_000, interval: 100 }).toBe(true);
    } finally {
      await runner.stop();
    }
  }

  async function finished(): Promise<Run> {
    let latest: Run | undefined;
    await expect
      .poll(
        async () => {
          latest = (await list()).runs[0];
          return latest?.state;
        },
        { timeout: 30_000, interval: 100 },
      )
      .toBe('finished');
    if (latest === undefined) throw new Error('no run');
    return latest;
  }

  /** Everything a run must leave exactly as it found it. */
  async function holderState(): Promise<string> {
    const userId = h.userId;
    const q = async (sql: string) =>
      (await h.database.pool.query(sql, [userId])).rows as Record<string, unknown>[];
    return JSON.stringify({
      approvals: await q(
        'SELECT id, query_shape, llm_provider, llm_model, approved_at, revoked_at FROM advisor_payload_approvals WHERE user_id = $1 ORDER BY id',
      ),
      settings: await q('SELECT * FROM narrator_settings WHERE user_id = $1'),
      consents: await q(
        'SELECT id, provider, consented_at, withdrawn_at FROM narrator_provider_consents WHERE user_id = $1 ORDER BY id',
      ),
      flags: await q('SELECT key, enabled FROM feature_flags WHERE user_id = $1 ORDER BY key'),
      advisors: await q(
        'SELECT advisor_id, enabled, enabled_source, quarantined_at FROM advisors WHERE user_id = $1 ORDER BY advisor_id',
      ),
      runs: await q('SELECT count(*)::int AS n FROM advisor_runs WHERE user_id = $1'),
      settingsEvents: await q(
        "SELECT count(*)::int AS n FROM domain_events WHERE user_id = $1 AND event_type = 'insights.NarratorSettingsChanged'",
      ),
    });
  }

  it('needs a fresh step-up: a stale session is refused and nothing is written', async () => {
    const refused = await start({}, stale);
    expectStatus(refused, 403);
    expect((await list()).runs).toEqual([]);
    expect((await list()).lastProven).toBeNull();
  });

  it('says what a run costs before it is pressed', async () => {
    // Anthropic, with a key and a consent, active; its payload approved.
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/narrator/providers/anthropic/credentials',
        session: fresh,
        body: { key: ANTHROPIC_KEY },
      }),
      200,
    );
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/narrator/providers/anthropic/consent',
        session: fresh,
        body: { consentVersion: NARRATOR_CONSENT_VERSION },
      }),
      200,
    );
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/narrator/settings',
        session: fresh,
        body: { activeProvider: 'anthropic' },
      }),
      200,
    );
    const preview = await h.request({
      method: 'GET',
      url: '/advisors/local.narrator/payload-preview',
      session: stale,
    });
    expectStatus(preview, 200);
    expectStatus(
      await h.request({
        method: 'POST',
        url: '/advisors/local.narrator/payload-approvals',
        session: fresh,
        body: { queryShape: (preview.json() as { queryShape: string }).queryShape },
      }),
      200,
    );
    const runs = await list();
    expect(runs.provider).toBe('anthropic');
    expect(runs.cost).toEqual({
      modelCalls: 3,
      hosted: true,
      message:
        "This sends up to 3 calls to Anthropic with your key, from this install's hourly window of 30.",
    });
  });

  it('a run: 202 with every check pending, the row filled in by the api and the worker, the holder unchanged', async () => {
    const before = await holderState();
    const started = await start();
    expectStatus(started, 202);
    const run = started.json() as Run;
    expect(run.state).toBe('running');
    expect(run.provider).toBe('anthropic');
    expect(run.model).toBe('anthropic:claude-sonnet-5-5');
    expect(run.results.map((row) => row.status)).toEqual(Array(13).fill('pending'));

    const callsBefore = fake.calls.length;
    await runWorker(async () => (await list()).runs[0]?.state === 'finished');
    const done = await finished();
    const by = Object.fromEntries(done.results.map((row) => [row.id, row]));

    expect(by['approval_gate']).toMatchObject({ status: 'pass' });
    expect(by['approval_gate']?.facts.join(' ')).toContain(
      'had a live approval, withdrawn for the check',
    );
    expect(by['kill_level_4_cancel']).toMatchObject({ status: 'pass' });
    expect(by['numerals_refusal']).toMatchObject({ status: 'pass' });
    expect(by['numerals_refusal']?.facts.join(' ')).toContain('numerals:numeral_not_placed');
    expect(by['schema_refusal']).toMatchObject({ status: 'pass' });
    expect(by['schema_refusal']?.facts.join(' ')).toMatch(/refused at (transport|schema)/u);
    expect(by['egress_allowlist']).toMatchObject({ status: 'pass' });
    expect(by['consent_withdrawal']).toMatchObject({ status: 'pass' });
    expect(by['inspector_digest']).toMatchObject({ status: 'skipped', notApplicable: false });
    expect(by['budget_window']).toMatchObject({ status: 'pass' });
    expect(by['budget_window']?.facts[0]).toBe('The window counted 3 call(s) for 3 probe(s) sent.');
    expect(by['module_switch']).toMatchObject({ status: 'reported' });
    expect(by['narration_badge']).toMatchObject({ status: 'skipped' });
    expect(by['model_pin']).toMatchObject({ status: 'skipped', notApplicable: true });
    // WP 11.2: this worker binds no suggestion model, so the enum probe does not apply.
    expect(by['suggest_enum_refusal']).toMatchObject({ status: 'skipped', notApplicable: true });
    // WP 11.3: nor an explain model.
    expect(by['explain_grounding']).toMatchObject({ status: 'skipped', notApplicable: true });
    expect(done.overall).toBe('partial');

    // Three calls to the one host, nothing else; the key never in a fact.
    expect(fake.calls.length - callsBefore).toBe(3);
    expect(new Set(fake.calls.map((call) => call.host))).toEqual(new Set(['api.anthropic.com']));

    // The holder's approvals, consent, settings, flags, advisors and run history: unchanged.
    expect(await holderState()).toBe(before);

    // The stored row: facts in words, never the key, the prompt or the reply.
    const stored = await h.database.pool.query<{ results: unknown; overall: string }>(
      'SELECT results, overall FROM ops_control_checks WHERE id = $1',
      [run.id],
    );
    const text = JSON.stringify(stored.rows[0]?.results);
    expect(stored.rows[0]?.overall).toBe('partial');
    for (const forbidden of [
      ANTHROPIC_KEY,
      SYNTHETIC_KEY,
      'Control check from the app',
      'untrusted_data',
      'plain English sentence instead',
    ]) {
      expect(text).not.toContain(forbidden);
    }

    const after = await list();
    expect(after.lastProven).toMatchObject({ overall: 'partial' });
  }, 60_000);

  it('one run per holder per 10 minutes: 409 with Retry-After', async () => {
    const again = await start();
    expectStatus(again, 409);
    expect(problemOf(again)['code']).toBe('narrator.control_checks_too_soon');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(600);
    expect((await list()).nextAllowedAt).not.toBeNull();
  });

  it('asked to prove the switch, it turns the module off inside a rolled-back transaction and sees module_disabled', async () => {
    clock.advanceMs(11 * 60_000);
    await refreshSessions();
    const before = await holderState();
    expectStatus(await start({ proveSwitch: true }), 202);
    await runWorker(async () => (await list()).runs[0]?.state === 'finished');
    const done = await finished();
    const row = done.results.find((entry) => entry.id === 'module_switch');
    expect(row).toMatchObject({ status: 'pass' });
    expect(row?.facts.join(' ')).toContain('refused module_disabled');
    expect(await holderState()).toBe(before);
  }, 60_000);

  it('a worker that never picks the job up: the worker checks are skipped by name, never passed', async () => {
    clock.advanceMs(11 * 60_000);
    await refreshSessions();
    expectStatus(await start(), 202);
    const done = await finished();
    for (const id of [
      'kill_level_4_cancel',
      'numerals_refusal',
      'schema_refusal',
      'egress_allowlist',
      'budget_window',
      'model_pin',
      'suggest_enum_refusal',
      'explain_grounding',
    ]) {
      const row = done.results.find((entry) => entry.id === id);
      expect(row?.status, id).toBe('skipped');
      expect(row?.reason).toContain('never picked this up');
    }
    expect(done.overall).toBe('partial');
    const jobs = await h.database.pool.query<{ status: string }>(
      "SELECT status FROM jobs WHERE kind = 'insights.control_checks' ORDER BY created_at DESC LIMIT 1",
    );
    expect(jobs.rows[0]?.status).toBe('cancelled');
  }, 60_000);

  it('Off: the model checks are skipped with the reason, the approval gate still proves itself on a synthetic shape', async () => {
    clock.advanceMs(11 * 60_000);
    await refreshSessions();
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/narrator/settings',
        session: fresh,
        body: { activeProvider: 'off' },
      }),
      200,
    );
    expectStatus(await start(), 202);
    await runWorker(async () => (await list()).runs[0]?.state === 'finished', {
      model: null,
      unavailable: 'The narrator is Off: there is no model to probe.',
    });
    const done = await finished();
    expect(done.provider).toBe('off');
    const by = Object.fromEntries(done.results.map((row) => [row.id, row]));
    expect(by['approval_gate']?.status).toBe('pass');
    expect(by['approval_gate']?.facts[0]).toContain('synthetic payload shape');
    expect(by['numerals_refusal']).toMatchObject({
      status: 'skipped',
      reason: 'The narrator is Off: there is no model to probe.',
    });
    expect(by['consent_withdrawal']).toMatchObject({ status: 'skipped', notApplicable: true });
  }, 60_000);

  it('another holder never sees this holder’s runs', async () => {
    const other = await h.database.createUser('WP 10.16 second holder');
    const session = await h.issueSession({ fresh: false, userId: other });
    const runs = await list(session);
    expect(runs.runs).toEqual([]);
    expect(runs.lastProven).toBeNull();
    expect((await list()).runs.length).toBe(4);
  });

  it("the operator path: `just genai-selftest`'s script runs the same catalogue for a named holder and prints the table", async () => {
    const holder = await h.database.createUser('WP1016 operator holder');
    const script = fileURLToPath(new URL('../../src/bin/genai-selftest.ts', import.meta.url));
    let output = '';
    const child = spawn(process.execPath, [script, `--holder=${holder}`], {
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
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    // The worker's half, as the running worker would: no narrator for this new holder.
    await runWorker(
      async () => {
        const rows = await h.database.pool.query<{ finished_at: Date | null }>(
          'SELECT finished_at FROM ops_control_checks WHERE user_id = $1',
          [holder],
        );
        return rows.rows[0]?.finished_at != null;
      },
      { model: null, unavailable: 'No narrator is configured for you.' },
    );
    expect(await exit, output).toBe(2);
    expect(output).toContain('GenAI controls self-test genai-controls/1');
    expect(output).toMatch(/Payload approval gate\s+PASS/u);
    expect(output).toMatch(/Numbers the app did not write\s+SKIPPED/u);
    expect(output).toContain('why: No narrator is configured for you.');
    expect(output).toContain('overall   PARTIAL');
  }, 90_000);
});
