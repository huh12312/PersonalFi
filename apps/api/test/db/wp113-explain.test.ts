// SPDX-License-Identifier: MIT
/**
 * WP 11.3 — "Explain this" through the shipped composition, against a real
 * database and the real explain adapter over the fake Ollama and the vendor
 * fakes (no live model):
 *
 *   * the routes: unavailable before the approval and when a scope is not
 *     granted (nothing enqueued); the approval through Advisor management's own
 *     preview and approve routes; 202 `computing` and a queued
 *     `insights.explain` job; the api never reaches the model;
 *   * the worker's job (the registration `appModules` returns): one chat, under
 *     the explain format, one `advisor_runs` row with the payload digest, one
 *     `insight_explanations` row; GET then says `shown` with the provider; a
 *     second POST is a cache hit (no job, no chat); a reply carrying a figure
 *     outside the evidence is `refused` and cached as a refusal; changed
 *     evidence is a new digest and a new row, the old one kept;
 *   * a health pillar the same way;
 *   * approvals, grants, consents, narrator settings and flags unchanged by
 *     every run;
 *   * the Brief's prefetch enqueues at most five;
 *   * the hosted branch: only through the narrator's own consented provider,
 *     the vendor fake answering under the explain schema name.
 */
import { EXPLAIN_FORMAT, EXPLAIN_SCHEMA_NAME } from '@advisor/local-model';
import {
  FakeHostedTransport,
  fakeHostedOk,
  recordedReply,
  startFakeOllama,
  type FakeOllama,
} from '@advisor/local-model/test';
import { newId, systemClock } from '@core/kernel';
import {
  createFlagService,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  platformExecutor,
  PLATFORM_FLAGS,
  type JobContext,
} from '@core/platform';
import {
  BUILTIN_CATALOGUE,
  EXPLAIN_JOB_KIND,
  INSIGHT_EXPLAIN_ADVISOR_ID,
  KIND_FLAG_KEYS,
  MODULE_FLAG_KEY,
  NARRATOR_MANIFEST,
  approveInsightExplain,
  grantScopes,
  insightExplainShape,
  registerAdvisor,
  type RunSwitches,
} from '@ctx/insights';
import { advisorRuns, healthScoreSnapshots, insightEvidence, insights } from '@ctx/insights/schema';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import {
  createExplainPrefetch,
  createExplainRuntime,
  runExplainPass,
  type ExplainRuntime,
} from '../../src/insight-explain.ts';
import { appModules, registerBuiltinAdvisors } from '../../src/modules.ts';
import { createNarratorRuntime, type NarratorStores } from '../../src/narrator-wiring.ts';
import { createNarratorStores } from '../../src/narrator-stores.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../../src/platform.ts';
import { explainSwitchesOf } from '../../src/routes/insight-explain.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '7'.repeat(64);
const TOKEN_SECRET = 'wp113-explain'; // gitleaks:allow — synthetic advisor-token secret for a test
const SCOPES = ['cash.summary', 'cashflow.monthly'] as const;

const C4 = BUILTIN_CATALOGUE.find((entry) => entry.ruleId === 'C4');

type Db = ApiHarness['database']['db'];

function jobContext(userId: string): JobContext {
  return {
    id: newId(),
    userId,
    kind: 'test',
    attempt: 1,
    correlationId: newId(),
    logger: pino({ level: 'silent' }) as unknown as JobContext['logger'],
    clock: systemClock,
    signal: new AbortController().signal,
  };
}

/**
 * One live built-in finding the way the nightly upsert leaves it, with its
 * source run on record: an `advisor_runs` row with the scopes it emitted, an
 * `insights` row, two evidence rows.
 */
async function seedFinding(
  db: Db,
  userId: string,
  input: { readonly key: string; readonly cash: string; readonly scopes?: readonly string[] },
): Promise<string> {
  const runId = newId();
  const id = newId();
  const now = new Date('2026-10-20T12:00:00.000Z');
  // fixture: advisor_runs row written by the schema insert because `finishRun` (the nightly advisor run) is its only writer; a completed built-in run could leave exactly this — the scopes its snapshot carried.
  await db.insert(advisorRuns).values({
    id: runId,
    userId,
    advisorId: C4?.advisorId ?? 'builtin.unknown',
    advisorVersion: '1.0.0',
    trigger: 'schedule',
    status: 'completed',
    grantedScopes: [...(input.scopes ?? SCOPES)],
    emittedScopes: [...(input.scopes ?? SCOPES)],
    proposedCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    rejections: [],
    correlationId: newId(),
    startedAt: now,
    finishedAt: now,
  });
  // fixture: insights row written by the schema insert because `upsertInsight` (the nightly advisor run) is its only writer; the run could write exactly this pending finding with evidence — input_digest is a placeholder no route recomputes.
  await db.insert(insights).values({
    id,
    userId,
    advisorId: C4?.advisorId ?? 'builtin.unknown',
    advisorVersion: '1.0.0',
    runId,
    key: input.key,
    period: '2026-10',
    type: 'cash.emergency_fund',
    severity: 'notable',
    severityClamped: false,
    title: 'Your cash covers 2.4 months of spending',
    summaryMd: `Cash of ${input.cash} covers 2.4 months of your recent spending of $3,000.00 a month.`,
    confidence: '0.900000',
    confidenceBasis: 'deterministic',
    horizon: 'this_period',
    status: 'pending_review',
    impactAnnualizedMinor: null,
    impactOneTimeMinor: null,
    impactCurrency: null,
    impactBasis: 'Months of spending the cash would cover.',
    impactDerivationId: null,
    derivations: [],
    caveats: [],
    narratesInsightId: null,
    inputDigest: `sha256:${'b'.repeat(64)}`,
    firstProposedAt: now,
    lastProposedAt: now,
    reviewedAt: null,
    expiresAt: null,
  });
  // fixture: insight_evidence rows written by the schema insert because `upsertInsight` is their only writer; the run could cite exactly these two snapshot figures.
  await db.insert(insightEvidence).values([
    {
      id: newId(),
      userId,
      insightId: id,
      position: 0,
      kind: 'metric',
      label: 'Cash in checking and savings',
      value: input.cash,
      sourceRef: 'snapshot:cash_summary.total.minor',
      resolvedDisplay: null,
      href: null,
    },
    {
      id: newId(),
      userId,
      insightId: id,
      position: 1,
      kind: 'metric',
      label: 'Average monthly spending',
      value: '$3,000.00',
      sourceRef: 'snapshot:cashflow_monthly.months[0].expense.minor',
      resolvedDisplay: null,
      href: null,
    },
  ]);
  return id;
}

const reply = (explanation: string): string => JSON.stringify({ explanation });

describe.skipIf(NO_DATABASE)('WP 11.3 — "Explain this" through the composition', () => {
  let h: ApiHarness;
  let fake: FakeOllama;
  let modules: ReturnType<typeof appModules>;
  let explainRuntime: ExplainRuntime;
  let switches: RunSwitches;
  let insightId: string;

  async function count(table: string, where = sql`TRUE`): Promise<number> {
    const rows = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE ${where}`,
    );
    return Number(rows.rows[0]?.n ?? 0);
  }

  async function tableDigest(table: string): Promise<string> {
    const rows = await h.database.db.execute(
      sql`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${sql.raw(table)} t`,
    );
    return String((rows.rows[0] as { digest: string }).digest);
  }

  const WATCHED = [
    'advisor_payload_approvals',
    'snapshot_grants',
    'snapshot_grant_events',
    'narrator_provider_consents',
    'narrator_settings',
    'feature_flags',
    'insights',
    'insight_evidence',
  ];
  /** Every advisor's switches (level 3 and its source, the quarantine); its run-health counters may move. */
  async function switchesDigest(): Promise<string> {
    const rows = await h.database.db.execute(sql`
      SELECT md5(COALESCE(string_agg(advisor_id || ':' || enabled || ':' || enabled_source || ':' ||
             COALESCE(quarantined_at::text, '-'), '|' ORDER BY advisor_id), '')) AS digest
        FROM advisors
    `);
    return String((rows.rows[0] as { digest: string }).digest);
  }
  const watched = async () => [
    ...(await Promise.all(WATCHED.map((table) => tableDigest(table)))),
    await switchesDigest(),
  ];

  async function explainJobs(): Promise<number> {
    return count('jobs', sql`kind = ${EXPLAIN_JOB_KIND}`);
  }

  async function runExplainJobs(): Promise<void> {
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    const registration = insightsModule?.jobs?.find((entry) => entry.kind === EXPLAIN_JOB_KIND);
    if (registration === undefined) throw new Error(`${EXPLAIN_JOB_KIND} is not registered`);
    const pending = await h.database.db.execute<{ id: string; payload: unknown }>(sql`
      SELECT id, payload FROM jobs WHERE kind = ${EXPLAIN_JOB_KIND} AND status = 'pending'
       ORDER BY created_at
    `);
    for (const row of pending.rows) {
      await registration.handler(row.payload, jobContext(h.userId));
      await h.database.db.execute(
        sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${row.id}::uuid`,
      );
    }
  }

  async function post(url: string) {
    return h.request({ method: 'POST', url, session: h.stale });
  }
  async function get(url: string) {
    return h.request({ method: 'GET', url, session: h.stale });
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp113',
      env: {
        LOCAL_MODEL_PIN_NAME: MODEL_NAME,
        LOCAL_MODEL_PIN_DIGEST: `sha256:${DIGEST_HEX}`,
      },
    });
    fake = await startFakeOllama({
      models: [{ name: MODEL_NAME, digest: DIGEST_HEX }],
      chat: { kind: 'reply', reply: reply('unused') },
    });
    await registerBuiltinAdvisors(h.database.db, {
      userId: h.userId,
      clock: systemClock,
      correlationId: newId(),
    });
    const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
    await registerAdvisor(h.database.db, ctx, { manifest: NARRATOR_MANIFEST, enabled: false });

    // worker.ts's construction, with the fake Ollama behind the local-endpoint policy.
    const endpoint = `ollama:${String(fake.port)}`;
    const policy = createLocalEndpointPolicy({
      endpoint,
      timeoutMs: 20_000,
      maxResponseBytes: 512 * 1024,
    });
    const localTransport = createLocalEndpointTransport(policy, {
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    const localModel = {
      endpoint,
      name: MODEL_NAME,
      digest: `sha256:${DIGEST_HEX}`,
      timeoutMs: 20_000,
      allowRemote: false,
    };
    const stores = createNarratorStores({
      database: h.database.db,
      secretBox: () => h.security.requireSecretBox(),
    });
    const narratorRuntime = createNarratorRuntime({
      mode: 'run',
      stores,
      localModel,
      timeoutMs: 20_000,
      allowRemote: false,
      fileKeys: {},
      localTransport,
      clock: systemClock,
    });
    explainRuntime = createExplainRuntime({
      mode: 'run',
      narrator: narratorRuntime,
      stores,
      localModel,
      timeoutMs: 20_000,
      allowRemote: false,
      fileKeys: {},
      localTransport,
      clock: systemClock,
    });
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const runtime = createDomainRuntime({
      database: h.database.db,
      clock: systemClock,
      logger: pino({ level: 'silent' }),
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
    });
    modules = appModules({
      advisorsEnabled: true,
      database: h.database.db,
      userId: h.userId,
      orchestrator: runtime.orchestrator,
      timezone: 'UTC',
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: denyAll }),
        smtp: createSmtpChannel({ policy: denyAll }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(h.database.db),
      advisorTokenSecret: TOKEN_SECRET,
      localModelConfigured: true,
      narratorRuntime,
      insightExplain: { runtime: explainRuntime },
    });
    switches = explainSwitchesOf({
      config: { env: { ADVISORS_ENABLED: true } } as never,
      database: h.database.db,
    });
    const flags = createFlagService({
      db: platformExecutor(h.database.db),
      defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
      ttlMs: 0,
    });
    const platformDb = platformExecutor(h.database.db);
    await flags.set(platformDb, h.userId, MODULE_FLAG_KEY, true);
    await flags.set(
      platformDb,
      h.userId,
      KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model',
      true,
    );
    insightId = await seedFinding(h.database.db, h.userId, { key: 'wp113-a', cash: '$7,200.00' });
  }, 120_000);

  afterAll(async () => {
    await fake?.close();
    await h?.close();
  }, 60_000);

  it('is unavailable until the payload is approved, and until the finding’s scopes are granted — nothing enqueued', async () => {
    expect(C4).toBeDefined();
    const before = await post(`/insights/${insightId}/explain`);
    expectStatus(before, 200);
    expect(before.json()).toMatchObject({
      state: 'unavailable',
      reason: 'payload_not_approved',
      explanation: null,
    });

    // Advisor management: insight.explain is listed; its preview and approval are its own.
    const listed = await get('/advisors');
    expect(
      (listed.json() as { advisors: { advisorId: string; enabled: boolean }[] }).advisors.find(
        (row) => row.advisorId === INSIGHT_EXPLAIN_ADVISOR_ID,
      ),
    ).toMatchObject({ enabled: true });
    const preview = await get(`/advisors/${INSIGHT_EXPLAIN_ADVISOR_ID}/payload-preview`);
    expectStatus(preview, 200);
    const shown = preview.json() as {
      queryShape: string;
      approved: boolean;
      request: { snapshot: { explain: { entity_kind: string } }; granted_scopes: string[] };
      prompt: { text: string };
    };
    expect(shown.approved).toBe(false);
    // No narrator grant yet: the preview shows the illustrative subject.
    expect(shown.request.snapshot.explain.entity_kind).toBe('insight');
    expect(shown.prompt.text).toContain('untrusted_data');
    const stale = await h.request({
      method: 'POST',
      url: `/advisors/${INSIGHT_EXPLAIN_ADVISOR_ID}/payload-approvals`,
      session: h.stale,
      body: { queryShape: shown.queryShape },
    });
    expect(stale.statusCode).toBe(403);
    const approved = await h.request({
      method: 'POST',
      url: `/advisors/${INSIGHT_EXPLAIN_ADVISOR_ID}/payload-approvals`,
      session: h.fresh,
      body: { queryShape: shown.queryShape },
    });
    expectStatus(approved, 200);

    // Approved, but the narrator has no grant for cashflow.monthly: the scope bound.
    const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
    await grantScopes(h.database.db, ctx, NARRATOR_MANIFEST.advisor_id, ['cash.summary']);
    const ungranted = await post(`/insights/${insightId}/explain`);
    expect(ungranted.json()).toMatchObject({ state: 'unavailable', reason: 'scope_not_granted' });
    expect(await explainJobs()).toBe(0);
    await grantScopes(h.database.db, ctx, NARRATOR_MANIFEST.advisor_id, [...SCOPES]);
  });

  it('POST is 202 computing and queues the worker; the api never reaches the model', async () => {
    const chatsBefore = fake.chats.length;
    const requestsBefore = fake.requests.length;
    const asked = await post(`/insights/${insightId}/explain`);
    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toMatchObject({ state: 'computing', entityKind: 'insight' });
    expect(await explainJobs()).toBe(1);
    // A second tap while it is queued is the same job.
    expect((await post(`/insights/${insightId}/explain`)).statusCode).toBe(202);
    expect(await explainJobs()).toBe(1);
    expect((await get(`/insights/${insightId}/explain`)).json()).toMatchObject({
      state: 'computing',
    });
    expect(fake.chats.length).toBe(chatsBefore);
    expect(fake.requests.length).toBe(requestsBefore);
  });

  it('the worker explains once, under the explain format; GET shows it with its provider; nothing else changes', async () => {
    const before = await watched();
    const runsBefore = await count('advisor_runs', sql`advisor_id = ${INSIGHT_EXPLAIN_ADVISOR_ID}`);
    const chatsBefore = fake.chats.length;
    fake.chat = {
      kind: 'reply',
      reply: reply(
        'This finding appeared because your cash, $7,200.00, is set against average monthly ' +
          'spending of $3,000.00. More cash or lower spending would change it.',
      ),
    };
    await runExplainJobs();
    expect(fake.chats.length).toBe(chatsBefore + 1);
    const chat = fake.requests.filter((request) => request.path === '/api/chat').at(-1);
    expect((chat?.body as { format?: unknown }).format).toEqual(EXPLAIN_FORMAT);
    expect(JSON.stringify(chat?.body)).not.toContain(insightId);

    expect(await count('advisor_runs', sql`advisor_id = ${INSIGHT_EXPLAIN_ADVISOR_ID}`)).toBe(
      runsBefore + 1,
    );
    const run = await h.database.db.execute<{
      status: string;
      input_digest: string;
      accepted_count: number;
      granted_scopes: string[];
      llm_model: string;
    }>(sql`
      SELECT status, input_digest, accepted_count, granted_scopes, llm_model FROM advisor_runs
       WHERE advisor_id = ${INSIGHT_EXPLAIN_ADVISOR_ID} ORDER BY started_at DESC LIMIT 1
    `);
    expect(run.rows[0]).toMatchObject({
      status: 'completed',
      accepted_count: 1,
      granted_scopes: [...SCOPES],
    });
    const cached = await h.database.db.execute<{ evidence_digest: string; llm_provider: string }>(
      sql`SELECT evidence_digest, llm_provider FROM insight_explanations WHERE entity_id = ${insightId}`,
    );
    expect(cached.rows).toHaveLength(1);
    expect(cached.rows[0]?.evidence_digest).toBe(run.rows[0]?.input_digest);
    expect(cached.rows[0]?.llm_provider).toBe('ollama');

    const state = (await get(`/insights/${insightId}/explain`)).json() as {
      state: string;
      explanation: { text: string; provider: string; providerName: string; model: string };
    };
    expect(state.state).toBe('shown');
    expect(state.explanation).toMatchObject({ provider: 'ollama', providerName: 'Local model' });
    expect(state.explanation.model).toMatch(/^qwen2\.5:7b-instruct.*@sha256:7{64}$/u);
    expect(state.explanation.text).toContain('$7,200.00');
    // Approvals, grants, consents, settings, flags and the insight itself: unchanged by the run.
    expect(await watched()).toEqual(before);
  });

  it('an unchanged digest is a cache hit: no job, no chat', async () => {
    const chatsBefore = fake.chats.length;
    const jobsBefore = await explainJobs();
    const again = await post(`/insights/${insightId}/explain`);
    expectStatus(again, 200);
    expect(again.json()).toMatchObject({ state: 'shown' });
    expect(await explainJobs()).toBe(jobsBefore);
    expect(fake.chats.length).toBe(chatsBefore);
  });

  it('a reply carrying a figure outside the evidence is refused, cached as a refusal, and said so', async () => {
    const second = await seedFinding(h.database.db, h.userId, {
      key: 'wp113-b',
      cash: '$5,100.00',
    });
    expect((await post(`/insights/${second}/explain`)).statusCode).toBe(202);
    fake.chat = {
      kind: 'reply',
      reply: reply('Your cash of $5,100.00 is $3,900.00 short of six months.'),
    };
    await runExplainJobs();
    const state = (await get(`/insights/${second}/explain`)).json();
    expect(state).toMatchObject({ state: 'refused', refusal: 'numeral', explanation: null });
    const row = await h.database.db.execute<{ explanation_text: string | null; refusal: string }>(
      sql`SELECT explanation_text, refusal FROM insight_explanations WHERE entity_id = ${second}`,
    );
    expect(row.rows).toEqual([{ explanation_text: null, refusal: 'numeral' }]);
    const run = await h.database.db.execute<{ rejections: { refusal: string }[] }>(sql`
      SELECT rejections FROM advisor_runs WHERE advisor_id = ${INSIGHT_EXPLAIN_ADVISOR_ID}
       ORDER BY started_at DESC LIMIT 1
    `);
    expect(run.rows[0]?.rejections).toEqual([{ refusal: 'numeral' }]);
    // A refusal is not re-asked: POST answers the cached refusal.
    const chatsBefore = fake.chats.length;
    expect((await post(`/insights/${second}/explain`)).json()).toMatchObject({ state: 'refused' });
    expect(fake.chats.length).toBe(chatsBefore);
  });

  it('a changed evidence set is a new digest and a new row; the old row stays', async () => {
    await h.database.db.execute(sql`
      UPDATE insight_evidence SET value = '$7,400.00'
       WHERE insight_id = ${insightId}::uuid AND position = 0
    `);
    expect((await get(`/insights/${insightId}/explain`)).json()).toMatchObject({ state: 'idle' });
    expect((await post(`/insights/${insightId}/explain`)).statusCode).toBe(202);
    fake.chat = {
      kind: 'reply',
      reply: reply('Your cash of $7,400.00 sits against spending of $3,000.00 a month.'),
    };
    await runExplainJobs();
    const rows = await h.database.db.execute<{ evidence_digest: string }>(
      sql`SELECT evidence_digest FROM insight_explanations WHERE entity_id = ${insightId}`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row) => row.evidence_digest)).size).toBe(2);
    expect((await get(`/insights/${insightId}/explain`)).json()).toMatchObject({
      state: 'shown',
      explanation: { text: expect.stringContaining('$7,400.00') as string },
    });
  });

  it('a health pillar: its inputs, its bands, the same gate and cache', async () => {
    const pillars = [
      {
        component: 'emergency_fund_months',
        status: 'scored',
        value: '2.4',
        band: 'fair',
        weight: '0.200000',
        score: 50,
        inputs: [
          {
            key: 'cash_total',
            label: 'Cash in checking and savings',
            kind: 'money',
            value: { minor: '720000', currency: 'USD' },
          },
        ],
      },
      ...['savings_rate', 'debt_to_income', 'subscription_load', 'diversification', 'fee_drag'].map(
        (component) => ({
          component,
          status: 'withheld',
          reason: 'not computed',
          unlock: 'Let a month arrive.',
          inputs: [],
        }),
      ),
    ];
    // fixture: health_score_snapshots row written by the schema insert because `computeAndStoreHealthSnapshot` needs a full snapshot build; the daily job could write exactly these two pillars.
    await h.database.db.insert(healthScoreSnapshots).values({
      id: newId(),
      userId: h.userId,
      asOfDate: '2026-10-27',
      score: '50.00',
      pillars,
      computedAt: new Date('2026-10-27T04:10:00.000Z'),
    });
    const withheld = await post('/insights/health/savings_rate/explain');
    expect(withheld.json()).toMatchObject({ state: 'unavailable', reason: 'pillar_not_scored' });
    expect((await post('/insights/health/emergency_fund_months/explain')).statusCode).toBe(202);
    fake.chat = {
      kind: 'reply',
      reply: reply(
        'Emergency fund scores 50 out of 100, in Fair, because your cash of $7,200.00 covers ' +
          '2.4 months. Reaching 3 months would move it to Good.',
      ),
    };
    await runExplainJobs();
    const state = (await get('/insights/health/emergency_fund_months/explain')).json();
    expect(state).toMatchObject({
      state: 'shown',
      entityKind: 'health_pillar',
      explanation: { provider: 'ollama' },
    });
    const sent = fake.requests.filter((request) => request.path === '/api/chat').at(-1);
    const text = JSON.stringify(sent?.body);
    expect(text).toContain('Fair: 1 month to under 3 months');
    expect(text).not.toContain('Everyday');
  });

  it('the Brief’s prefetch enqueues at most five, only what is explainable and not cached', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 7; n += 1) {
      ids.push(
        await seedFinding(h.database.db, h.userId, {
          key: `wp113-prefetch-${String(n)}`,
          cash: `$${String(1_000 + n)}.00`,
        }),
      );
    }
    const before = await explainJobs();
    const enqueued = await createExplainPrefetch({
      database: h.database.db,
      runtime: explainRuntime,
      switches,
      clock: systemClock,
    })({ userId: h.userId, insightIds: ids, correlationId: newId() });
    expect(enqueued).toBe(5);
    expect(await explainJobs()).toBe(before + 5);
    // The first item is already explained: a second prefetch of a cached item asks nothing.
    const cachedOnly = await createExplainPrefetch({
      database: h.database.db,
      runtime: explainRuntime,
      switches,
      clock: systemClock,
    })({ userId: h.userId, insightIds: [insightId], correlationId: newId() });
    expect(cachedOnly).toBe(0);
    await h.database.db.execute(
      sql`UPDATE jobs SET status = 'cancelled' WHERE kind = ${EXPLAIN_JOB_KIND} AND status = 'pending'`,
    );
  });

  it('the hosted branch is the narrator’s own consented provider, through the vendor fake', async () => {
    const stores: NarratorStores = {
      settings: () =>
        Promise.resolve({
          activeProvider: 'anthropic',
          hasRow: true,
          models: {},
          ollama: null,
          consented: new Set(['anthropic'] as const),
        }),
      storedKey: () => Promise.resolve({ reveal: () => 'sk-ant-test-wp113' }), // gitleaks:allow — synthetic
    };
    const vendor = new FakeHostedTransport(() =>
      fakeHostedOk(
        recordedReply(
          'anthropic',
          reply('The figure of $7,500.00 is your cash, set against $3,000.00 of monthly spending.'),
        ),
      ),
    );
    const consented = (narrator: boolean): ExplainRuntime =>
      createExplainRuntime({
        mode: 'run',
        narrator: {
          resolve: () =>
            Promise.resolve(
              narrator
                ? {
                    provider: 'anthropic' as const,
                    reason: null,
                    narrator: {
                      provider: 'anthropic' as const,
                      modelId: 'claude-test',
                      label: 'anthropic:claude-test',
                      keySource: 'stored' as const,
                      renderer: undefined as never,
                      model: undefined as never,
                    },
                  }
                : {
                    provider: 'anthropic' as const,
                    reason: 'consent_required' as const,
                    narrator: null,
                  },
            ),
          budgets: new Map(),
        },
        stores,
        localModel: undefined,
        timeoutMs: 20_000,
        allowRemote: false,
        fileKeys: {},
        hostedTransport: vendor.transport,
        resolveHost: () => Promise.resolve(['93.184.216.34']),
        clock: systemClock,
      });
    // No standing narrator consent: no adapter, nothing sent.
    expect(await consented(false).resolve(h.userId)).toMatchObject({
      adapter: null,
      reason: 'consent_required',
    });
    const runtime = consented(true);
    const resolution = await runtime.resolve(h.userId);
    expect(resolution.adapter?.provider).toBe('anthropic');
    const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
    const cachedHit = await runExplainPass(
      { database: h.database.db, runtime, switches, clock: systemClock },
      {
        userId: h.userId,
        correlationId: newId(),
        payload: { entityKind: 'insight', entityId: insightId, trigger: 'manual' },
      },
    );
    // The cache holds the local model's explanation of this digest: a hit, nothing sent.
    expect(cachedHit.outcome).toBe('cached');
    expect(vendor.calls).toHaveLength(0);
    await h.database.db.execute(sql`
      UPDATE insight_evidence SET value = '$7,500.00' WHERE insight_id = ${insightId}::uuid AND position = 0
    `);
    const before = await watched();
    const unapproved = await runExplainPass(
      { database: h.database.db, runtime, switches, clock: systemClock },
      {
        userId: h.userId,
        correlationId: newId(),
        payload: { entityKind: 'insight', entityId: insightId, trigger: 'manual' },
      },
    );
    // Its own shape: the hosted template hash names provider and model, so it needs its own approval.
    expect(unapproved.result).toMatchObject({ status: 'refused', refusal: 'payload_not_approved' });
    expect(vendor.calls).toHaveLength(0);
    expect(await watched()).toEqual(before);

    if (resolution.adapter === null) throw new Error('no hosted adapter');
    const approval = await approveInsightExplain(h.database.db, ctx, {
      renderer: resolution.adapter,
      queryShape: insightExplainShape(resolution.adapter.templateHash),
    });
    expect(approval.approvalId).toBeTruthy();
    const done = await runExplainPass(
      { database: h.database.db, runtime, switches, clock: systemClock },
      {
        userId: h.userId,
        correlationId: newId(),
        payload: { entityKind: 'insight', entityId: insightId, trigger: 'manual' },
      },
    );
    expect(done.result).toMatchObject({ status: 'completed', replyRefusal: null });
    expect(vendor.calls).toHaveLength(1);
    expect(vendor.calls[0]?.host).toBe('api.anthropic.com');
    // Anthropic's structured output carries the explain format itself (OpenAI's names it EXPLAIN_SCHEMA_NAME).
    expect(
      (vendor.calls[0]?.body as { output_config?: { format?: { schema?: unknown } } }).output_config
        ?.format?.schema,
    ).toEqual(EXPLAIN_FORMAT);
    expect(EXPLAIN_SCHEMA_NAME).toBe('insight_explanation');
    expect(JSON.stringify(vendor.calls[0]?.body)).not.toContain(insightId);
    const state = (await get(`/insights/${insightId}/explain`)).json() as {
      explanation: { provider: string; providerName: string } | null;
    };
    // The api's own preview runtime resolves the local model (no settings row), whose cached row
    // for this digest does not exist; the hosted row is the one on record.
    const row = await h.database.db.execute<{ llm_provider: string; llm_model: string }>(sql`
      SELECT llm_provider, llm_model FROM insight_explanations
       WHERE entity_id = ${insightId} ORDER BY created_at DESC LIMIT 1
    `);
    expect(row.rows[0]).toEqual({ llm_provider: 'anthropic', llm_model: 'anthropic:claude-test' });
    expect(state.explanation).toMatchObject({ provider: 'anthropic', providerName: 'Anthropic' });
  });
});
