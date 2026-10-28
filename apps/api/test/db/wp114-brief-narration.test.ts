// SPDX-License-Identifier: MIT
/**
 * WP 11.4 — the Brief's own narration and the weekly recap (`brief.narrate`)
 * through the shipped composition, against a real database and the real
 * brief-narrate adapter over the fake Ollama and the vendor fake (no live
 * model):
 *
 *   * the weekly Brief job (the registration `appModules` returns) publishes,
 *     enqueues the per-item narrations and one `insights.brief_narrate` job;
 *     the Brief reads `pending` with its deterministic opening;
 *   * the composition waits for the item narrations (no model asked), then
 *     asks once, under the brief-narrate format, sending only the Brief's
 *     figures and its chosen items; one `advisor_runs` row whose input digest
 *     is the `brief_narrations` row's; GET shows both texts and who wrote them;
 *   * approvals, grants, grant events, consents, narrator settings, flags, the
 *     insights, their evidence and the Brief's own rows are byte-identical
 *     before and after;
 *   * one call per Brief: a second job asks nothing and announces nothing;
 *   * the announcement (`insights.BriefRecapReady`) carries the recap when it
 *     passed and the notification body carries it after the deterministic
 *     lines; a refused composition announces without it, and the Brief reads
 *     `refused` with its opening standing;
 *   * the hosted branch: only through the narrator's own consented provider,
 *     its own approval, the vendor fake answering under the brief schema.
 */
import { BRIEF_NARRATE_FORMAT, BRIEF_NARRATE_SCHEMA_NAME } from '@advisor/local-model';
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
  BRIEF_NARRATE_ADVISOR_ID,
  BRIEF_NARRATE_JOB_KIND,
  BUILTIN_CATALOGUE,
  KIND_FLAG_KEYS,
  MODULE_FLAG_KEY,
  NARRATOR_MANIFEST,
  approveBriefNarrate,
  briefNarrateShape,
  briefNarrateTargetOf,
  runBriefNarration,
  grantScopes,
  registerAdvisor,
  type RunSwitches,
} from '@ctx/insights';
import {
  advisoryBriefItems,
  advisoryBriefs,
  advisorRuns,
  insightActions,
  insightEvidence,
  insights,
} from '@ctx/insights/schema';
import {
  createEgressPolicy,
  createNtfyChannel,
  createSmtpChannel,
  renderNotification,
} from '@ctx/notifications';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBriefNarrateRuntime,
  runBriefNarrationPass,
  type BriefNarrateRuntime,
} from '../../src/brief-narration.ts';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
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
const DIGEST_HEX = '8'.repeat(64);
/** The adapter's label cuts a local model's name to 24 characters (the narrator's own rule). */
const LABEL_NAME = MODEL_NAME.slice(0, 24);
const TOKEN_SECRET = 'wp114-brief'; // gitleaks:allow — synthetic advisor-token secret for a test
const SCOPES = ['cash.summary', 'cashflow.monthly'] as const;

const C4 = BUILTIN_CATALOGUE.find((entry) => entry.ruleId === 'C4');

const FIRST = 'Idle cash is earning less than it could';
const SECOND = 'Your savings rate slipped this month';
const THIRD = 'A smaller cash buffer than usual';
const UNCHOSEN = 'Your cash covers 2.4 months of spending';

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

/** One live built-in finding the way the nightly upsert leaves it, with its source run on record. */
async function seedFinding(
  db: Db,
  userId: string,
  input: {
    readonly key: string;
    readonly title: string;
    readonly annualMinor: bigint | null;
    readonly type?: string;
  },
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
    grantedScopes: [...SCOPES],
    emittedScopes: [...SCOPES],
    proposedCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    rejections: [],
    correlationId: newId(),
    startedAt: now,
    finishedAt: now,
  });
  // fixture: insights row written by the schema insert because `upsertInsight` (the nightly advisor run) is its only writer; the run could write exactly this pending finding — input_digest is a placeholder no route recomputes.
  await db.insert(insights).values({
    id,
    userId,
    advisorId: C4?.advisorId ?? 'builtin.unknown',
    advisorVersion: '1.0.0',
    runId,
    key: input.key,
    period: '2026-10',
    // At most two of one rule family are ranked (E11), so the third is another family.
    type: input.type ?? 'cash.emergency_fund',
    severity: 'notable',
    severityClamped: false,
    title: input.title,
    summaryMd: `${input.title}: cash of $7,200.00 against spending of $3,000.00 a month.`,
    confidence: '0.900000',
    confidenceBasis: 'deterministic',
    horizon: 'this_period',
    status: 'pending_review',
    impactAnnualizedMinor: input.annualMinor,
    impactOneTimeMinor: null,
    impactCurrency: input.annualMinor === null ? null : 'USD',
    impactBasis: 'The yearly difference the action makes.',
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
  // fixture: insight_evidence row written by the schema insert because `upsertInsight` is its only writer.
  await db.insert(insightEvidence).values({
    id: newId(),
    userId,
    insightId: id,
    position: 0,
    kind: 'metric',
    label: 'Cash in checking and savings',
    value: '$7,200.00',
    sourceRef: 'snapshot:cash_summary.total.minor',
    resolvedDisplay: null,
    href: null,
  });
  // fixture: insight_actions row written by the schema insert because `upsertInsight` is its only writer; the Brief admits only a finding with an action.
  await db.insert(insightActions).values({
    id: newId(),
    userId,
    insightId: id,
    position: 0,
    kind: 'suggest_only',
    label: 'Review it',
    rationaleMd: 'A suggestion the built-in rule makes.',
    url: null,
  });
  return id;
}

const reply = (narration: string, recap: string): string => JSON.stringify({ narration, recap });

describe.skipIf(NO_DATABASE)('WP 11.4 — the Brief’s own narration through the composition', () => {
  let h: ApiHarness;
  let fake: FakeOllama;
  let modules: ReturnType<typeof appModules>;
  let runtime: BriefNarrateRuntime;
  let switches: RunSwitches;
  let briefId: string;
  let isoWeek: string;

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
    'insight_actions',
    'advisory_briefs',
    'advisory_brief_items',
  ];
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

  function registration(kind: string) {
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    const found = insightsModule?.jobs?.find((entry) => entry.kind === kind);
    if (found === undefined) throw new Error(`${kind} is not registered`);
    return found;
  }

  async function runPending(kind: string): Promise<number> {
    const pending = await h.database.db.execute<{ id: string; payload: unknown }>(sql`
      SELECT id, payload FROM jobs WHERE kind = ${kind} AND status = 'pending' ORDER BY created_at
    `);
    for (const row of pending.rows) {
      await h.database.db.execute(
        sql`UPDATE jobs SET status = 'running' WHERE id = ${row.id}::uuid`,
      );
      await registration(kind).handler(row.payload, jobContext(h.userId));
      await h.database.db.execute(
        sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${row.id}::uuid`,
      );
    }
    return pending.rows.length;
  }

  async function announcements(): Promise<Record<string, unknown>[]> {
    const rows = await h.database.db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM domain_events WHERE event_type = 'insights.BriefRecapReady' ORDER BY seq
    `);
    return rows.rows.map((row) => row.payload);
  }

  async function get(url: string) {
    return h.request({ method: 'GET', url, session: h.stale });
  }

  /** A second published Brief for another week, its items copied from the first (a fixture, see below). */
  async function copyBrief(week: string): Promise<string> {
    const id = newId();
    const [original] = await h.database.db
      .select()
      .from(advisoryBriefs)
      .where(eq(advisoryBriefs.id, briefId));
    if (original === undefined) throw new Error('no Brief');
    // fixture: advisory_briefs / advisory_brief_items rows written by the schema insert because `publishWeeklyBrief` (the weekly job) is their only writer and publishes only the current week; it could have published exactly these rows for another week.
    await h.database.db.insert(advisoryBriefs).values({ ...original, id, isoWeek: week });
    const items = await h.database.db
      .select()
      .from(advisoryBriefItems)
      .where(eq(advisoryBriefItems.briefId, briefId));
    await h.database.db
      .insert(advisoryBriefItems)
      .values(items.map((item) => ({ ...item, id: newId(), briefId: id })));
    return id;
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp114',
      env: {
        LOCAL_MODEL_PIN_NAME: MODEL_NAME,
        LOCAL_MODEL_PIN_DIGEST: `sha256:${DIGEST_HEX}`,
      },
    });
    fake = await startFakeOllama({
      models: [{ name: MODEL_NAME, digest: DIGEST_HEX }],
      chat: { kind: 'reply', reply: reply('unused', 'unused') },
    });
    await registerBuiltinAdvisors(h.database.db, {
      userId: h.userId,
      clock: systemClock,
      correlationId: newId(),
    });
    const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
    await registerAdvisor(h.database.db, ctx, { manifest: NARRATOR_MANIFEST, enabled: false });

    const endpoint = `ollama:${String(fake.port)}`;
    const localTransport = createLocalEndpointTransport(
      createLocalEndpointPolicy({ endpoint, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 }),
      { resolve: () => Promise.resolve(['127.0.0.1']) },
    );
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
    runtime = createBriefNarrateRuntime({
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
    const domain = createDomainRuntime({
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
      orchestrator: domain.orchestrator,
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
      briefNarration: { runtime, textShown: false },
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
    await grantScopes(h.database.db, ctx, NARRATOR_MANIFEST.advisor_id, [...SCOPES]);
    await seedFinding(h.database.db, h.userId, {
      key: 'wp114-a',
      title: FIRST,
      annualMinor: 84000n,
    });
    await seedFinding(h.database.db, h.userId, {
      key: 'wp114-b',
      title: SECOND,
      annualMinor: 42000n,
    });
    await seedFinding(h.database.db, h.userId, {
      key: 'wp114-c',
      title: THIRD,
      annualMinor: 30000n,
      type: 'spending.category_creep',
    });
    // A live finding with no dollar figure: the Brief does not choose it (G5-15's "no other").
    await seedFinding(h.database.db, h.userId, {
      key: 'wp114-d',
      title: UNCHOSEN,
      annualMinor: null,
    });
  }, 120_000);

  afterAll(async () => {
    await fake?.close();
    await h?.close();
  }, 60_000);

  it('Advisor management lists brief.narrate with its own preview; approving it changes nothing else', async () => {
    const listed = await get('/advisors');
    expect(
      (listed.json() as { advisors: { advisorId: string; enabled: boolean }[] }).advisors.find(
        (row) => row.advisorId === BRIEF_NARRATE_ADVISOR_ID,
      ),
    ).toMatchObject({ enabled: true });
    const preview = await get(`/advisors/${BRIEF_NARRATE_ADVISOR_ID}/payload-preview`);
    expectStatus(preview, 200);
    const shown = preview.json() as {
      queryShape: string;
      approved: boolean;
      scopes: string[];
      request: { snapshot: { brief: { items: unknown[] } } };
      prompt: { text: string };
    };
    expect(shown.approved).toBe(false);
    expect(shown.scopes).not.toContain('transactions.raw');
    // No Brief yet: the illustrative one, labelled as such by the preview.
    expect(shown.request.snapshot.brief.items).toHaveLength(2);
    expect(shown.prompt.text).toContain('untrusted_data');
    const stale = await h.request({
      method: 'POST',
      url: `/advisors/${BRIEF_NARRATE_ADVISOR_ID}/payload-approvals`,
      session: h.stale,
      body: { queryShape: shown.queryShape },
    });
    expect(stale.statusCode).toBe(403);
    const approved = await h.request({
      method: 'POST',
      url: `/advisors/${BRIEF_NARRATE_ADVISOR_ID}/payload-approvals`,
      session: h.fresh,
      body: { queryShape: shown.queryShape },
    });
    expectStatus(approved, 200);
  });

  it('the weekly Brief job publishes, enqueues the item narrations and one composition; the Brief reads pending with its opening', async () => {
    const chatsBefore = fake.chats.length;
    await registration('insights.brief').handler({}, jobContext(h.userId));
    const [brief] = await h.database.db
      .select()
      .from(advisoryBriefs)
      .where(eq(advisoryBriefs.userId, h.userId));
    if (brief === undefined) throw new Error('the Brief was not published');
    briefId = brief.id;
    isoWeek = brief.isoWeek;
    expect(await count('jobs', sql`kind = 'insights.run_local'`)).toBeGreaterThan(0);
    expect(await count('jobs', sql`kind = ${BRIEF_NARRATE_JOB_KIND}`)).toBe(1);
    expect(fake.chats.length).toBe(chatsBefore);
    const served = (await get('/insights/brief/current')).json() as {
      brief: { opening: string; narration: { state: string; text: string | null } };
    };
    expect(served.brief.opening).toBe(
      `3 ranked actions this week, in order of dollar impact. The largest is “${FIRST}”, $840.00 a year.`,
    );
    expect(served.brief.narration).toMatchObject({ state: 'pending', text: null });
  });

  it('the composition waits for the item narrations — no model asked — then asks once; nothing else changes', async () => {
    const chatsBefore = fake.chats.length;
    expect(await runPending(BRIEF_NARRATE_JOB_KIND)).toBe(1);
    // The item narrations are still queued: it re-enqueued itself and asked nothing.
    expect(fake.chats.length).toBe(chatsBefore);
    expect(await count('jobs', sql`kind = ${BRIEF_NARRATE_JOB_KIND} AND status = 'pending'`)).toBe(
      1,
    );
    expect(await announcements()).toEqual([]);
    // The item narrations finish (the narrator's own lane is not this test's subject).
    await h.database.db.execute(
      sql`UPDATE jobs SET status = 'succeeded' WHERE kind = 'insights.run_local'`,
    );
    await h.database.db.execute(
      sql`UPDATE jobs SET run_after = now() WHERE kind = ${BRIEF_NARRATE_JOB_KIND}`,
    );

    const before = await watched();
    fake.chat = {
      kind: 'reply',
      reply: reply(
        `${FIRST} leads the week at $840.00 a year, then ${SECOND} at $420.00 a year, ` +
          `and ${THIRD} at $300.00 a year.`,
        `Week ${isoWeek} has 3 ranked actions and none needing attention.`,
      ),
    };
    expect(await runPending(BRIEF_NARRATE_JOB_KIND)).toBe(1);
    expect(fake.chats.length).toBe(chatsBefore + 1);
    const chat = fake.requests.filter((request) => request.path === '/api/chat').at(-1);
    expect((chat?.body as { format?: unknown }).format).toEqual(BRIEF_NARRATE_FORMAT);
    const sent = JSON.stringify(chat?.body);
    // Only the Brief's chosen items, never the unchosen finding, never an id.
    for (const title of [FIRST, SECOND, THIRD]) expect(sent).toContain(title);
    expect(sent).not.toContain(UNCHOSEN);
    expect(sent).not.toContain(briefId);

    const run = await h.database.db.execute<{
      status: string;
      input_digest: string;
      accepted_count: number;
      granted_scopes: string[];
    }>(sql`
      SELECT status, input_digest, accepted_count, granted_scopes FROM advisor_runs
       WHERE advisor_id = ${BRIEF_NARRATE_ADVISOR_ID}
    `);
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({
      status: 'completed',
      accepted_count: 1,
      granted_scopes: [...SCOPES],
    });
    const row = await h.database.db.execute<{
      status: string;
      input_digest: string;
      llm_provider: string;
    }>(
      sql`SELECT status, input_digest, llm_provider FROM brief_narrations WHERE brief_id = ${briefId}::uuid`,
    );
    expect(row.rows).toEqual([
      { status: 'shown', input_digest: run.rows[0]?.input_digest, llm_provider: 'ollama' },
    ]);

    const served = (await get('/insights/brief/current')).json() as {
      brief: {
        opening: string;
        narration: {
          state: string;
          text: string;
          recap: string;
          narratedBy: { provider: string; model: string };
        };
      };
    };
    expect(served.brief.narration.state).toBe('shown');
    expect(served.brief.narration.text).toContain(FIRST);
    expect(served.brief.narration.recap).toContain('3 ranked actions');
    expect(served.brief.narration.narratedBy).toEqual({ provider: 'ollama', model: LABEL_NAME });
    expect(served.brief.opening).toContain(FIRST);
    // Approvals, grants, consents, settings, flags, the insights and the Brief itself: unchanged.
    expect(await watched()).toEqual(before);
  });

  it('announces the Brief once: the notification body carries the deterministic lines, then the recap', async () => {
    const events = await announcements();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      briefId,
      isoWeek,
      rankedCount: 3,
      attentionCount: 0,
      recapBy: { provider: 'ollama', model: LABEL_NAME },
    });
    const rendered = renderNotification('insights.BriefRecapReady', event ?? {});
    expect(rendered?.bodyMd).toBe(
      `3 ranked actions this week (${isoWeek}), in order of dollar impact.\n\n` +
        `Your week (AI-assisted wording, the local model ${LABEL_NAME}): ` +
        `Week ${isoWeek} has 3 ranked actions and none needing attention.`,
    );
  });

  it('one call per Brief: a second job for the same Brief asks nothing and announces nothing', async () => {
    const chatsBefore = fake.chats.length;
    const runsBefore = await count('advisor_runs', sql`advisor_id = ${BRIEF_NARRATE_ADVISOR_ID}`);
    const pass = await runBriefNarrationPass(
      { database: h.database.db, runtime, switches, textShown: false, clock: systemClock },
      { userId: h.userId, correlationId: newId(), payload: { briefId, isoWeek, waits: 0 } },
    );
    expect(pass).toMatchObject({ outcome: 'already', announced: false });
    expect(fake.chats.length).toBe(chatsBefore);
    expect(await count('advisor_runs', sql`advisor_id = ${BRIEF_NARRATE_ADVISOR_ID}`)).toBe(
      runsBefore,
    );
    expect(await announcements()).toHaveLength(1);
  });

  it('a reply with a figure outside the Brief is refused: the Brief reads refused with its opening, and is announced without a recap', async () => {
    const other = await copyBrief('2026-W01');
    const before = await watched();
    fake.chat = {
      kind: 'reply',
      reply: reply(
        `${FIRST} leads the week at $840.00 a year; the three together are worth $1,560.00.`,
        'Three ranked actions this week.',
      ),
    };
    const pass = await runBriefNarrationPass(
      { database: h.database.db, runtime, switches, textShown: false, clock: systemClock },
      {
        userId: h.userId,
        correlationId: newId(),
        payload: { briefId: other, isoWeek: '2026-W01', waits: 0 },
      },
    );
    expect(pass.result).toMatchObject({ status: 'completed', replyRefusal: 'numeral' });
    const served = (await get('/insights/brief/2026-W01')).json() as {
      brief: { opening: string; narration: Record<string, unknown> };
    };
    expect(served.brief.opening).toContain(FIRST);
    expect(served.brief.narration).toMatchObject({
      state: 'refused',
      text: null,
      recap: null,
      refusal: 'numeral',
    });
    expect(String(served.brief.narration['message'])).toContain('didn');
    const events = await announcements();
    const last = events.at(-1) ?? {};
    expect(last).toMatchObject({ briefId: other, recap: null, recapBy: null });
    expect(renderNotification('insights.BriefRecapReady', last)?.bodyMd).toBe(
      '3 ranked actions this week (2026-W01), in order of dollar impact.',
    );
    expect(await watched()).toEqual(before);
  });

  it('the scope ceiling: a target whose scopes reach past the narrator’s grant sends nothing and records no run', async () => {
    const other = await copyBrief('2026-W03');
    const resolution = await runtime.resolve(h.userId);
    if (resolution.adapter === null) throw new Error('no adapter');
    const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
    // The builder is handed a wider ceiling than the holder granted (holdings.detail is not granted):
    // the run's own check is the backstop.
    const target = briefNarrateTargetOf({
      briefId: other,
      isoWeek: '2026-W03',
      week: {
        week: '2026-W03',
        rankedCount: '1',
        attentionCount: '0',
        healthScore: null,
        milestones: [],
      },
      ranked: [
        {
          title: FIRST,
          summaryMd: 'A summary.',
          narrationText: null,
          annualizedImpact: { minor: '84000', currency: 'USD' },
          oneTimeImpact: null,
          carried: false,
          evidence: [],
          scopes: ['holdings.detail'],
        },
      ],
      lastWeek: null,
      allowedScopes: [...NARRATOR_MANIFEST.requires_scopes],
      foreignTitles: [],
    });
    expect(target.scopes).toEqual(['holdings.detail']);
    const chatsBefore = fake.chats.length;
    const runsBefore = await count('advisor_runs', sql`advisor_id = ${BRIEF_NARRATE_ADVISOR_ID}`);
    const result = await runBriefNarration(
      h.database.db,
      ctx,
      { switches, model: resolution.adapter },
      { target, trigger: 'event' },
    );
    expect(result).toMatchObject({ status: 'scope_not_granted', runId: null });
    expect(fake.chats.length).toBe(chatsBefore);
    expect(await count('advisor_runs', sql`advisor_id = ${BRIEF_NARRATE_ADVISOR_ID}`)).toBe(
      runsBefore,
    );
    expect(await count('brief_narrations', sql`brief_id = ${other}::uuid`)).toBe(0);
  });

  it('the hosted branch is the narrator’s own consented provider, with its own approval, through the vendor fake', async () => {
    const other = await copyBrief('2026-W02');
    const stores: NarratorStores = {
      settings: () =>
        Promise.resolve({
          activeProvider: 'anthropic',
          hasRow: true,
          models: {},
          ollama: null,
          consented: new Set(['anthropic'] as const),
        }),
      storedKey: () => Promise.resolve({ reveal: () => 'sk-ant-test-wp114' }), // gitleaks:allow — synthetic
    };
    const vendor = new FakeHostedTransport(() =>
      fakeHostedOk(
        recordedReply(
          'anthropic',
          reply(
            `${FIRST} leads at $840.00 a year, then ${SECOND} at $420.00 a year.`,
            'Week 2026-W02 has 3 ranked actions.',
          ),
        ),
      ),
    );
    const consented = (narrator: boolean): BriefNarrateRuntime =>
      createBriefNarrateRuntime({
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
    expect(await consented(false).resolve(h.userId)).toMatchObject({
      adapter: null,
      reason: 'consent_required',
    });
    const hosted = consented(true);
    const resolution = await hosted.resolve(h.userId);
    if (resolution.adapter === null) throw new Error('no hosted adapter');
    const deps = {
      database: h.database.db,
      runtime: hosted,
      switches,
      textShown: false,
      clock: systemClock,
    };
    const payload = { briefId: other, isoWeek: '2026-W02', waits: 0 };
    const unapproved = await runBriefNarrationPass(deps, {
      userId: h.userId,
      correlationId: newId(),
      payload,
    });
    // Its own shape: the hosted template hash names provider and model.
    expect(unapproved.result).toMatchObject({ status: 'refused', refusal: 'payload_not_approved' });
    expect(vendor.calls).toHaveLength(0);
    const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
    await approveBriefNarrate(h.database.db, ctx, {
      renderer: resolution.adapter,
      queryShape: briefNarrateShape(resolution.adapter.templateHash),
    });
    const done = await runBriefNarrationPass(deps, {
      userId: h.userId,
      correlationId: newId(),
      payload,
    });
    expect(done.result).toMatchObject({ status: 'completed', replyRefusal: null });
    expect(vendor.calls).toHaveLength(1);
    expect(vendor.calls[0]?.host).toBe('api.anthropic.com');
    expect(
      (vendor.calls[0]?.body as { output_config?: { format?: { schema?: unknown } } }).output_config
        ?.format?.schema,
    ).toEqual(BRIEF_NARRATE_FORMAT);
    expect(BRIEF_NARRATE_SCHEMA_NAME).toBe('brief_narration');
    const served = (await get('/insights/brief/2026-W02')).json() as {
      brief: { narration: { state: string; narratedBy: unknown } };
    };
    expect(served.brief.narration).toMatchObject({
      state: 'shown',
      narratedBy: { provider: 'anthropic', model: 'claude-test' },
    });
  });
});
