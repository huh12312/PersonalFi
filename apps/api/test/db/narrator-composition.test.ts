// SPDX-License-Identifier: MIT
/**
 * WP 9.5 — the narrator through the worker's own composition (Phase 5 gate
 * C5-4 and C5-2; its §2.2 B5b and G5-6, and process condition C5-11).
 *
 * The gate removed `knownFindingTypes` from `service.ts` and every
 * composition-root test stayed green: nothing asserted that a narration is
 * *accepted* end to end through the shipped wiring (B5b). And both Phase 5
 * live numbers were taken on an adapter built with a reply format the worker
 * never passed (G5-6). This file builds the narrator exactly as `worker.ts`
 * does — `createNarratorWiring` (the function `main()` calls, which takes no
 * `format`) bound into `appModules` as `narratorModel` and `promptRenderer` —
 * points it at a fake Ollama on loopback, and drives the real weekly-Brief job
 * and the real `insights.run_local` handler through a real job runner:
 *
 *   * a built-in finding the Brief chooses is narrated, the narration is
 *     accepted and linked to it — the model wrote no key, no type and no
 *     period (WP 9.5 option A), and no figure and no citation (option B): it
 *     placed slots, and the app filled each with the row's value beside its
 *     label, one of them a percent the built-in left `null` in its own row
 *     (option A(b), read back from `insight_evidence`);
 *   * the Brief's first narration, against a model nothing has loaded, is
 *     preceded by exactly one data-free warm-up inside the request's own
 *     deadline, and a warm model gets none (C5-2's cold-model design);
 *   * the Brief enqueues **one job per item**, carrying that item's id, never
 *     re-run by the queue (C5-2);
 *   * the reply format the worker's adapter sends is the narrator's;
 *   * a model that never answers fails the run once, `model_timeout`, and the
 *     job is not retried (C5-2: the breaker already counts it).
 *
 * `docs/TESTING.md`'s scratch-database-per-suite convention (`createApiHarness`
 * against the dev Postgres at 127.0.0.1:5433), a fresh holder per test.
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { NARRATION_FORMAT, WARM_UP_MESSAGES } from '@advisor/local-model';
import { startFakeOllama, type FakeOllama } from '@advisor/local-model/test';
import { money, newId, systemClock } from '@core/kernel';
import {
  createFlagService,
  createJobRunner,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  enqueueJob,
  platformExecutor,
  silentLogger,
  PLATFORM_FLAGS,
} from '@core/platform';
import {
  approvePayload,
  BUILTIN_CATALOGUE,
  createAdvisorRegistry,
  createNarratorAdvisor,
  grantScopes,
  inMemoryBudgetPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryRecurringPort,
  KIND_FLAG_KEYS,
  MODULE_FLAG_KEY,
  NARRATOR_MANIFEST,
  NARRATOR_REPLY_FORMAT,
  NARRATOR_SCOPES,
  previewRequest,
  registerAdvisor,
  runAdvisor,
  setAdvisorEnabled,
  type InsightsContext,
  type InsightsDependencies,
} from '@ctx/insights';
import { insights } from '@ctx/insights/schema';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules, insightsRunSwitches, type ModuleWiringOptions } from '../../src/modules.ts';
import { createNarratorWiring, type NarratorWiring } from '../../src/narrator-wiring.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../../src/platform.ts';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const ZONE = 'America/New_York';
const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const SERVED_DIGEST_HEX = '845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e';
const YIELD = 'builtin.cash.yield_spread';
const TOKEN_SECRET = 'wp95-narrator-composition'; // gitleaks:allow — synthetic advisor-token secret for a test

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
}

/**
 * `worker.ts`'s own construction: `createNarratorWiring(config.localModel, …)`.
 * The one seam is the transport — `ollama` resolves to loopback here, as WP
 * 5.2's own suite does — which the production call leaves to the policy.
 */
function workerWiring(port: number, timeoutMs: number): NarratorWiring {
  const endpoint = `ollama:${String(port)}`;
  const policy = createLocalEndpointPolicy({ endpoint, timeoutMs, maxResponseBytes: 512 * 1024 });
  const transport = createLocalEndpointTransport(policy, {
    resolve: () => Promise.resolve(['127.0.0.1']),
  });
  const wiring = createNarratorWiring(
    {
      endpoint,
      name: MODEL_NAME,
      digest: `sha256:${SERVED_DIGEST_HEX}`,
      timeoutMs,
      allowRemote: false,
    },
    { transport, clock: systemClock },
  );
  if (wiring === undefined) throw new Error('a configured model must yield a wiring');
  return wiring;
}

/** `appModules()` as `worker.ts` builds it when a model is configured. */
function workerModules(
  h: ApiHarness,
  wiring: NarratorWiring,
  overrides: Partial<ModuleWiringOptions>,
): ReturnType<typeof appModules> {
  const denyAll = createEgressPolicy({ allowedHosts: [] });
  const runtime = createDomainRuntime({
    database: h.database.db,
    clock: systemClock,
    logger: pino({ level: 'silent' }),
    registry: createConnectorRegistry(),
    secretBox: h.security.requireSecretBox(),
  });
  return appModules({
    advisorsEnabled: true,
    database: h.database.db,
    userId: h.userId,
    orchestrator: runtime.orchestrator,
    timezone: ZONE,
    notificationChannels: {
      ntfy: createNtfyChannel({ policy: denyAll }),
      smtp: createSmtpChannel({ policy: denyAll }),
    },
    secretBox: h.security.requireSecretBox(),
    investmentSyncPort: createInvestmentSyncPort(h.database.db),
    advisorTokenSecret: TOKEN_SECRET,
    // worker.ts, verbatim in shape: `localModelConfigured: config.localModel
    // !== undefined`, the wiring's renderer, the wiring's model port.
    localModelConfigured: true,
    promptRenderer: wiring.localModel.promptRenderer,
    narratorModel: wiring.narratorModel,
    ...overrides,
  });
}

/** Two cash accounts, one at 4.5% and one at 0%: `builtin.cash.yield_spread`'s own-rate comparison. */
function yieldPorts(): InsightsDependencies['ports'] {
  return {
    ledger: inMemoryLedgerPort({
      accounts: [
        {
          id: 'acct-savings',
          type: 'savings' as const,
          isCash: true,
          balance: money(500_000n, 'USD'),
          apy: 0.045,
          closed: false,
        },
        {
          id: 'acct-checking',
          type: 'checking' as const,
          isCash: true,
          balance: money(2_123_500n, 'USD'),
          apy: 0,
          closed: false,
        },
      ],
    }),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort([]),
    investments: inMemoryInvestmentsPort({}),
    marketData: inMemoryMarketDataPort(null),
  };
}

function contextFor(userId: string): InsightsContext {
  return { userId, clock: systemClock, correlationId: newId() };
}

/**
 * Everything the narration needs before the model is called, through the
 * product's own functions: both advisors registered and granted, the operator
 * flags on, the narrator enabled and its payload approved under the
 * wiring's renderer — and one real built-in finding in the database.
 */
async function narratorReady(
  h: ApiHarness,
  userId: string,
  wiring: NarratorWiring,
  insightsModule: NonNullable<ReturnType<typeof appModules>[number]>,
): Promise<{ readonly findingId: string }> {
  const context = contextFor(userId);
  await insightsModule.schedules?.(userId); // registers local.narrator (disabled: kill level 3's default)
  const yieldEntry = BUILTIN_CATALOGUE.find((entry) => entry.advisorId === YIELD);
  if (yieldEntry === undefined) throw new Error(`no ${YIELD}`);
  const narrator = createNarratorAdvisor({ model: wiring.narratorModel });
  const dependencies: InsightsDependencies = {
    registry: createAdvisorRegistry([yieldEntry.advisor, narrator]),
    switches: insightsRunSwitches(h.database.db, {
      advisorsEnabled: true,
      localModelConfigured: true,
    }),
    promptRenderer: wiring.localModel.promptRenderer,
    ports: yieldPorts(),
    settings: { timeZone: ZONE, baseCurrency: 'USD', tokenSecret: TOKEN_SECRET },
  };
  await registerAdvisor(h.database.db, context, {
    manifest: yieldEntry.advisor.manifest,
    enabled: true,
  });
  await grantScopes(h.database.db, context, YIELD, [
    ...yieldEntry.advisor.manifest.requires_scopes,
  ]);
  await grantScopes(h.database.db, context, NARRATOR_MANIFEST.advisor_id, [...NARRATOR_SCOPES]);
  await setAdvisorEnabled(h.database.db, context, NARRATOR_MANIFEST.advisor_id, true);
  const flags = createFlagService({
    db: platformExecutor(h.database.db),
    defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
    ttlMs: 0,
  });
  const platformDb = platformExecutor(h.database.db);
  await flags.set(platformDb, userId, MODULE_FLAG_KEY, true);
  await flags.set(
    platformDb,
    userId,
    KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model',
    true,
  );

  const seeded = await runAdvisor(h.database.db, context, dependencies, {
    advisorId: YIELD,
    trigger: 'manual',
  });
  if (seeded.accepted !== 1)
    throw new Error(`the yield rule made no finding: ${JSON.stringify(seeded)}`);
  const rows = await h.database.db
    .select({ id: insights.id })
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.advisorId, YIELD)));
  const findingId = rows[0]?.id;
  if (findingId === undefined) throw new Error('no stored finding');

  const preview = await previewRequest(
    h.database.db,
    context,
    dependencies,
    NARRATOR_MANIFEST.advisor_id,
  );
  await approvePayload(h.database.db, context, dependencies, {
    advisorId: NARRATOR_MANIFEST.advisor_id,
    queryShape: preview.queryShape,
  });
  return { findingId };
}

/**
 * The reply in the shape the model is now asked for (contract 1.6.0): its
 * finding's number, prose with **slots** where figures go, and no key, type,
 * period or evidence. The yield finding's rows, in order: `The balance`
 * ($21,235.00) e1, `What it earns` (0%) e2, `The better rate you hold`
 * (4.5%) e3.
 */
function narrationReply(): string {
  return JSON.stringify({
    insights: [
      {
        finding: 1,
        severity: 'notable',
        title: 'One account earns far less than another',
        summary_md: 'One account holds {{e1}} at {{e2}}, while another of your own earns {{e3}}.',
        confidence: 0.7,
        confidence_basis: 'model',
        horizon: 'this_year',
        requires_review: true,
        impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
        derivations: [],
        proposed_actions: [],
        caveats: [],
        expires_at: null,
      },
    ],
  });
}

/** The narrations the fake was sent — streamed chats, not the warm-up's. */
function narrationChats(fake: FakeOllama): FakeOllama['requests'] {
  return fake.requests.filter(
    (request) =>
      request.path === '/api/chat' &&
      (request.body as { stream?: unknown } | null)?.stream !== false,
  );
}

describe.skipIf(NO_DATABASE)('WP 9.5 — the narrator through the worker composition', () => {
  let h: ApiHarness;
  let fake: FakeOllama;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp95narrator' });
    fake = await startFakeOllama({
      models: [{ name: MODEL_NAME, digest: SERVED_DIGEST_HEX }],
      chat: { kind: 'reply', reply: narrationReply() },
    });
  }, 120_000);

  afterAll(async () => {
    await fake?.close();
    await h?.close();
  }, 60_000);

  it('through the real worker.ts wiring an accepted narration lands, narrating the Brief item it was enqueued for', async () => {
    const userId = await h.database.createUser('WP 9.5 narrator composition');
    const wiring = workerWiring(fake.port, 20_000);
    // The system clock, as `worker.ts` runs: the request's deadline is
    // `generated_at` + the manifest's timeout, and the adapter measures it
    // against its own clock — a fixed module clock would put it in the past.
    const modules = workerModules(h, wiring, {});
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    if (insightsModule === undefined) throw new Error('module.insights did not resolve');
    const { findingId } = await narratorReady(h, userId, wiring, insightsModule);
    fake.chat = { kind: 'reply', reply: narrationReply() };
    const chatsBefore = narrationChats(fake).length;
    // C5-2: the scheduled Brief meets a cold model — nothing loaded.
    fake.loaded = false;
    const warmUpsBefore = fake.warmUps.length;
    const requestsBefore = fake.requests.length;

    const handlers = (insightsModule.jobs ?? []).filter(
      (job) => job.kind === 'insights.brief' || job.kind === 'insights.run_local',
    );
    expect(handlers.map((job) => job.kind).sort()).toEqual([
      'insights.brief',
      'insights.run_local',
    ]);
    const runner = createJobRunner({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      handlers,
      concurrency: 2,
      pollIntervalMs: 25,
      logger: silentLogger,
    });
    await runner.start();
    try {
      await enqueueJob(platformExecutor(h.database.db), {
        kind: 'insights.brief',
        userId,
        payload: {},
        correlationId: newId(),
      });
      await until(
        async () => {
          const rows = await h.database.db
            .select({ id: insights.id })
            .from(insights)
            .where(and(eq(insights.userId, userId), isNotNull(insights.narratesInsightId)));
          return rows.length > 0;
        },
        30_000,
        'a narration to land',
      );
    } finally {
      await runner.stop();
    }

    // C5-2: one narration job per Brief item, carrying that item's own id,
    // never re-run by the queue.
    const jobs = await h.database.db.execute<{
      ids: string[] | null;
      max_attempts: number;
      status: string;
    }>(sql`
      SELECT ARRAY(SELECT jsonb_array_elements_text(payload->'narrateInsightIds')) AS ids,
             max_attempts, status
        FROM jobs WHERE user_id = ${userId}::uuid AND kind = 'insights.run_local'
    `);
    const briefItems = await h.database.db.execute<{ insight_id: string }>(sql`
      SELECT i.insight_id FROM advisory_brief_items i
        JOIN advisory_briefs b ON b.id = i.brief_id
       WHERE b.user_id = ${userId}::uuid
    `);
    expect(briefItems.rows.map((row) => row.insight_id)).toContain(findingId);
    expect(jobs.rows.map((row) => row.ids?.join(',')).sort()).toEqual(
      briefItems.rows.map((row) => row.insight_id).sort(),
    );
    for (const job of jobs.rows) expect(job.max_attempts).toBe(1);

    // B5b: the narration was accepted and linked to the finding it narrates.
    const narrations = await h.database.db
      .select()
      .from(insights)
      .where(and(eq(insights.userId, userId), eq(insights.narratesInsightId, findingId)));
    expect(narrations).toHaveLength(1);
    const narration = narrations[0];
    const finding = (
      await h.database.db.select().from(insights).where(eq(insights.id, findingId))
    )[0];
    // Option A(a): the model wrote no key, type or period — the app did.
    expect(narration?.key).toBe(finding?.key);
    expect(narration?.type).toBe(finding?.type);
    expect(narration?.period).toBe(finding?.period);
    // Option B: the model wrote slots; the app placed each figure beside its
    // own label and cited each placed row under that label.
    expect(narration?.summaryMd).toBe(
      'One account holds $21,235.00 (The balance) at 0% (What it earns), while another of ' +
        'your own earns 4.5% (The better rate you hold).',
    );
    const cited = await h.database.db.execute<{ label: string; value: string | null }>(sql`
      SELECT label, value FROM insight_evidence
       WHERE insight_id = ${narration?.id ?? ''}::uuid ORDER BY position
    `);
    expect(cited.rows).toEqual([
      { label: 'The balance', value: '$21,235.00' },
      { label: 'What it earns', value: '0%' },
      { label: 'The better rate you hold', value: '4.5%' },
    ]);
    // Option A(b): `4.5%` is the built-in's own prose for a row it stored as
    // `null` (`resolved_display` 0.045) — the envelope read it back from
    // `insight_evidence` as the panel shows it, and the slot placed it.
    expect(narration?.summaryMd).toContain('4.5%');
    const rateRow = await h.database.db.execute<{
      value: string | null;
      resolved: string | null;
    }>(sql`
      SELECT value, resolved_display AS resolved FROM insight_evidence
       WHERE insight_id = ${findingId}::uuid AND label = 'The better rate you hold'
    `);
    expect(rateRow.rows[0]).toEqual({ value: null, resolved: '0.045' });

    // C5-2's cold-model design: exactly one warm-up, before the first
    // narration, carrying the two constants and nothing of the holder's — and
    // under the narration's own runner settings, so it loads the runner the
    // narration then uses. The model was warm for every later item.
    const run = fake.requests.slice(requestsBefore);
    const warmAt = run.findIndex(
      (request) =>
        request.path === '/api/chat' &&
        (request.body as { stream?: unknown } | null)?.stream === false,
    );
    const firstNarrationAt = run.findIndex(
      (request) =>
        request.path === '/api/chat' &&
        (request.body as { stream?: unknown } | null)?.stream !== false,
    );
    expect(fake.warmUps.length - warmUpsBefore).toBe(1);
    expect(warmAt).toBeGreaterThanOrEqual(0);
    expect(warmAt).toBeLessThan(firstNarrationAt);
    expect(run.slice(0, warmAt).some((request) => request.path === '/api/ps')).toBe(true);
    const warmUp = fake.warmUps.at(-1) as {
      messages: unknown;
      options: { num_predict: number; num_ctx: number };
    };
    expect(warmUp.messages).toEqual(WARM_UP_MESSAGES.map((m) => ({ ...m })));
    expect(warmUp.options.num_predict).toBe(1);
    const narrated = run[firstNarrationAt]?.body as { options: { num_ctx: number } };
    expect(warmUp.options.num_ctx).toBe(narrated.options.num_ctx);
    expect(JSON.stringify(warmUp)).not.toContain(finding?.title ?? '(no title)');
    // The request's deadline is the platform ceiling; the chat's own timeout
    // is still the adapter's (20 s here, LOCAL_MODEL_TIMEOUT_MS in production).
    expect(NARRATOR_MANIFEST.limits.timeout_ms).toBe(300_000);

    // G5-6: the worker's adapter sent the narrator's reply format — the one
    // the evaluation measures — with no `format` passed anywhere.
    const chats = narrationChats(fake);
    expect(chats.length).toBe(chatsBefore + jobs.rows.length);
    const sent = (chats.at(-1)?.body as { format?: unknown } | undefined)?.format;
    expect(isDeepStrictEqual(sent, NARRATOR_REPLY_FORMAT)).toBe(true);
    expect(isDeepStrictEqual(NARRATION_FORMAT, NARRATOR_REPLY_FORMAT)).toBe(true);

    // And `worker.ts` builds it through `createNarratorWiring`, not by hand.
    const worker = readFileSync(new URL('../../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('createNarratorWiring(config.localModel,');
    expect(worker).not.toMatch(/createLocalModelAdapter\(/u);
  }, 60_000);

  it('a narration that times out fails its run once and is not retried by the queue', async () => {
    const userId = await h.database.createUser('WP 9.5 narrator timeout');
    // The adapter's own deadline, short: a model that streams forever.
    const wiring = workerWiring(fake.port, 1_500);
    const modules = workerModules(h, wiring, {});
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    if (insightsModule === undefined) throw new Error('module.insights did not resolve');
    const { findingId } = await narratorReady(h, userId, wiring, insightsModule);
    fake.chat = { kind: 'endless', intervalMs: 50 };

    const runLocal = (insightsModule.jobs ?? []).find((job) => job.kind === 'insights.run_local');
    if (runLocal === undefined) throw new Error('insights.run_local did not register');
    const runner = createJobRunner({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      handlers: [runLocal],
      concurrency: 1,
      pollIntervalMs: 25,
      logger: silentLogger,
    });
    await runner.start();
    try {
      // The lane's default `maxAttempts` (5), as the api's "run advisors"
      // button enqueues it: the lane itself must not re-run a failed narration.
      await enqueueJob(platformExecutor(h.database.db), {
        kind: 'insights.run_local',
        userId,
        payload: {
          advisorId: NARRATOR_MANIFEST.advisor_id,
          trigger: 'manual',
          narrateInsightIds: [findingId],
        },
        correlationId: newId(),
      });
      await until(
        async () => {
          const rows = await h.database.db.execute<{ status: string }>(sql`
            SELECT status FROM jobs WHERE user_id = ${userId}::uuid AND kind = 'insights.run_local'
          `);
          return rows.rows[0]?.status === 'succeeded';
        },
        30_000,
        'the narration job to finish',
      );
      // Give a retry, if there were one, the time to be claimed.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await runner.stop();
      fake.chat = { kind: 'reply', reply: narrationReply() };
    }

    const job = await h.database.db.execute<{ attempts: number; status: string }>(sql`
      SELECT attempts, status FROM jobs WHERE user_id = ${userId}::uuid AND kind = 'insights.run_local'
    `);
    expect(job.rows).toEqual([{ attempts: 1, status: 'succeeded' }]);
    const runs = await h.database.db.execute<{ status: string; error_code: string | null }>(sql`
      SELECT status, error_code FROM advisor_runs
       WHERE user_id = ${userId}::uuid AND advisor_id = ${NARRATOR_MANIFEST.advisor_id}
    `);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]?.status).toBe('failed');
    expect(runs.rows[0]?.error_code ?? '').toMatch(/model_timeout/u);
  }, 60_000);
});
