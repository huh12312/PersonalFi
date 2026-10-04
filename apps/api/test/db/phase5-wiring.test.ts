// SPDX-License-Identifier: MIT
/**
 * The Phase 5 W-C wiring batch, proved end to end over a real database
 * (05-phase-5-dispatch.md §4 "Wiring batches", the W-C paragraph).
 *
 * `apps/api/test/phase3-registration.test.ts` proves the *shape*
 * `appModules()` returns now that `insightsModule` registers `local.narrator`
 * and `insights.brief` (WP 5.3 / WP 5.6). This file proves the shape is
 * connected to anything, the `phase3-wiring.test.ts` / `phase4-wiring.test.ts`
 * pattern: a real weekly-Brief job, run through a real `@core/platform` job
 * runner, publishes and — only when a model is configured — enqueues a real
 * narration on `insights.run_local`; a real `local.narrator`, wrapping the
 * real `@advisor/local-model` adapter pointed at a fake Ollama server
 * (`@advisor/local-model/test`), is killed at each of the four levels while
 * genuinely mid-reply; the `insights.weekly_brief` schedule name is accepted
 * by the platform's own `CHECK`, not a JS-side regex mirror of it; and
 * `assertPoolCoversLeases` is re-derived at the default `DATABASE_POOL_MAX`
 * with every Phase 5 job kind wired in.
 *
 * `docs/TESTING.md`'s scratch-database-per-suite convention:
 * `createApiHarness`, never the compose stack, against the dev Postgres at
 * `127.0.0.1:5433`. A fresh holder per test (`h.database.createUser(...)`),
 * the `phase4-wiring.test.ts` reason: a shared holder would make one test's
 * ISO-week Brief or registered advisors couple to another's.
 */
import { readFileSync } from 'node:fs';
import { createLocalModelAdapter, type LocalModelAdapter } from '@advisor/local-model';
import { startFakeOllama, type FakeOllama } from '@advisor/local-model/test';
import { fixedClock, money, newId, systemClock } from '@core/kernel';
import {
  createFlagService,
  createJobRunner,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  enqueueJob,
  platformExecutor,
  silentLogger,
  PLATFORM_FLAGS,
  type FlagService,
} from '@core/platform';
import {
  ADVISOR_CONTRACT_MAJOR,
  approvePayload,
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
  NARRATOR_SCOPES,
  previewRequest,
  registerAdvisor,
  requestRunCancel,
  runAdvisor,
  setAdvisorEnabled,
  type Advisor,
  type AdvisorManifest,
  type AdvisorRequest,
  type InsightsContext,
  type InsightsDependencies,
  type NarratorModelPort,
} from '@ctx/insights';
import { advisoryBriefs, insights } from '@ctx/insights/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules, insightsRunSwitches, type ModuleWiringOptions } from '../../src/modules.ts';
import { MODULE_FLAGS, ADVISOR_KIND_FLAGS } from '../../src/platform.ts';
import { assertPoolCoversLeases, WORKER_PINNED_CONNECTIONS } from '../../src/worker.ts';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';

const ZONE = 'America/Los_Angeles';
const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const SERVED_DIGEST_HEX = '845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e';
const PINNED_DIGEST = `sha256:${SERVED_DIGEST_HEX}`;

/** Poll until `check` is true, or fail loudly after `timeoutMs` — `local-lane.test.ts`'s helper. */
async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** `.env.example`'s own default — read, not hardcoded, the `worker-pool-guard.test.ts` pattern. */
function defaultDatabasePoolMax(): number {
  const text = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
  const match = /^DATABASE_POOL_MAX=(\d+)$/m.exec(text);
  if (match?.[1] === undefined) throw new Error('.env.example has no DATABASE_POOL_MAX default');
  return Number(match[1]);
}

/** `appModules()` built the same way `worker.ts` builds it — the `phase4-wiring.test.ts` helper. */
function buildModules(
  h: ApiHarness,
  overrides: Partial<ModuleWiringOptions> = {},
): ReturnType<typeof appModules> {
  const logger = pino({ level: 'silent' });
  const denyAll = createEgressPolicy({ allowedHosts: [] });
  const runtime = createDomainRuntime({
    database: h.database.db,
    clock: systemClock,
    logger,
    registry: createConnectorRegistry(),
    secretBox: h.security.requireSecretBox(),
  });
  return appModules({
    advisorsEnabled: true,
    localModelConfigured: false,
    database: h.database.db,
    userId: h.userId,
    orchestrator: runtime.orchestrator,
    timezone: ZONE,
    clock: systemClock,
    notificationChannels: {
      ntfy: createNtfyChannel({ policy: denyAll }),
      smtp: createSmtpChannel({ policy: denyAll }),
    },
    secretBox: h.security.requireSecretBox(),
    investmentSyncPort: createInvestmentSyncPort(h.database.db),
    ...overrides,
  });
}

/** A `NarratorModelPort` that is never meant to be called — tests 1/2 only enqueue, never run. */
function uncallableNarratorModel(): NarratorModelPort {
  return { run: () => Promise.reject(new Error('not called by this test')) };
}

/**
 * The real adapter, pointed at a fake Ollama the way `worker.ts` points it at
 * the real one — `ollama-client.test.ts`'s own construction, reused: `ollama`
 * is a single-label compose host name, resolved to `127.0.0.1` here because
 * the test says so.
 */
function adapterFor(port: number) {
  const endpoint = `ollama:${String(port)}`;
  const policy = createLocalEndpointPolicy({
    endpoint,
    timeoutMs: 20_000,
    maxResponseBytes: 512 * 1024,
  });
  const transport = createLocalEndpointTransport(policy, {
    resolve: () => Promise.resolve(['127.0.0.1']),
  });
  return createLocalModelAdapter(
    { endpoint, name: MODEL_NAME, digest: PINNED_DIGEST, timeoutMs: 20_000, allowRemote: false },
    { transport, clock: systemClock },
  );
}

function contextFor(userId: string): InsightsContext {
  return { userId, clock: systemClock, correlationId: newId() };
}

// ---------------------------------------------------------------------------
// A tiny, self-contained builtin: one real, accepted insight over one real
// `cash.summary` scope, so the narrator has a real finding to narrate in the
// kill-ladder cases below. No port but `ledger` is ever called (a fake that
// throws proves it).
// ---------------------------------------------------------------------------

const SEED_ADVISOR_ID = 'test.w_c_wiring_seed';

function seedManifest(): AdvisorManifest {
  return {
    advisor_id: SEED_ADVISOR_ID,
    version: '1.0.0',
    contract_version: ADVISOR_CONTRACT_MAJOR,
    kind: 'builtin',
    display_name: 'W-C wiring test seed',
    purpose: 'Seeds one real, accepted finding for the narrator kill-ladder cases (test-only).',
    requires_scopes: ['cash.summary'],
    triggers: [],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: false,
      max_severity: 'urgent',
    },
    limits: { timeout_ms: 30_000, max_insights: 5, max_response_bytes: 65_536 },
    egress_allowlist: [],
  };
}

function seedAdvisor(): Advisor {
  return {
    manifest: seedManifest(),
    run: (request: AdvisorRequest) =>
      Promise.resolve({
        contract_version: request.contract_version,
        request_id: request.request_id,
        advisor_id: request.advisor_id,
        advisor_version: request.advisor_version,
        produced_at: new Date().toISOString(),
        diagnostics: { runtime_ms: 0, model: null, warnings: [] },
        insights: [
          {
            key: 'seed.cash_account',
            period: 'all_time',
            type: 'seed.cash_account',
            severity: 'info' as const,
            title: 'You hold a cash account',
            summary_md: 'There is a cash account on file.',
            confidence: 0.9,
            confidence_basis: 'heuristic' as const,
            horizon: 'this_period' as const,
            requires_review: true as const,
            impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
            evidence: [
              {
                kind: 'metric' as const,
                label: 'Cash accounts',
                // `value: null` is a citation without a restatement
                // (`validate/evidence.ts`'s own header): the ref still has to
                // resolve into the real snapshot, but nothing is claimed
                // about its content, so this needs no exact-string match.
                value: null,
                source_ref: 'snapshot:cash_summary.account_count',
                url: null,
              },
            ],
            derivations: [],
            proposed_actions: [],
            caveats: [],
            expires_at: null,
          },
        ],
      }),
  };
}

/** The `InsightsDependencies.ports` a zero-scope-beyond-`cash.summary` world needs. Everything else throws. */
function seedPorts() {
  return {
    ledger: inMemoryLedgerPort({
      accounts: [
        {
          id: 'seed-account',
          type: 'checking' as const,
          isCash: true,
          balance: money(100_00n, 'USD'),
          apy: null,
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

/**
 * The narrator world, built over `insightsModule`'s own exported
 * `insightsRunSwitches(database, options)` — not a second, parallel
 * construction that could quietly drift from it. A sabotage of that
 * function's `ttlMs: 0` (`wave-a-wiring.md` §4's named gap: "the composition
 * root's cache setting is proved only by inspection until W-C lands") is
 * therefore a sabotage of exactly what the kill-ladder cases below run
 * against. `flags` here is a second `FlagService` instance pointed at the
 * same database and used only to `.set(...)` a flag — safe, because both
 * readers are uncached: a write through this instance is visible to
 * `insightsRunSwitches`'s own reader on its very next read, with nothing to
 * invalidate. Registers and grants both advisors, runs the seed to create
 * one real finding, and previews/approves the narrator's payload —
 * everything a kill-ladder case needs before the model is ever called.
 */
async function narratorWorld(
  h: ApiHarness,
  userId: string,
  adapter: LocalModelAdapter,
): Promise<{ readonly dependencies: InsightsDependencies; readonly flags: FlagService }> {
  const flags = createFlagService({
    db: platformExecutor(h.database.db),
    defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
    ttlMs: 0,
  });
  const switches = insightsRunSwitches(h.database.db, {
    advisorsEnabled: true,
    localModelConfigured: true,
  });
  // `LocalModelAdapter.run` satisfies `NarratorModelPort` structurally — the
  // adapter's own header says so, and W-C's `worker.ts` binds the same
  // object without adapting it either.
  const narrator = createNarratorAdvisor({ model: adapter });
  const dependencies: InsightsDependencies = {
    registry: createAdvisorRegistry([seedAdvisor(), narrator]),
    switches,
    promptRenderer: adapter.promptRenderer,
    ports: seedPorts(),
    settings: { timeZone: ZONE, baseCurrency: 'USD', tokenSecret: 'w-c-wiring-test' },
  };

  const context = contextFor(userId);
  await registerAdvisor(h.database.db, context, { manifest: seedManifest(), enabled: true });
  await registerAdvisor(h.database.db, context, { manifest: NARRATOR_MANIFEST, enabled: true });
  await grantScopes(h.database.db, context, SEED_ADVISOR_ID, ['cash.summary']);
  await grantScopes(h.database.db, context, NARRATOR_MANIFEST.advisor_id, [...NARRATOR_SCOPES]);

  // Both operator-side flags this world needs: `module.insights` (default
  // on) and `advisors.kind.local_model` (default OFF — kill level 2's own
  // default; 05 §3's ladder table), turned on explicitly here.
  const platformDb = platformExecutor(h.database.db);
  await flags.set(platformDb, userId, MODULE_FLAG_KEY, true);
  await flags.set(
    platformDb,
    userId,
    KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model',
    true,
  );

  const seeded = await runAdvisor(h.database.db, context, dependencies, {
    advisorId: SEED_ADVISOR_ID,
    trigger: 'manual',
  });
  if (seeded.accepted !== 1) {
    throw new Error(`seed advisor did not produce an accepted finding: ${JSON.stringify(seeded)}`);
  }

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

  return { dependencies, flags };
}

async function startedNarratorRunId(h: ApiHarness, userId: string): Promise<string> {
  const rows = await h.database.db.execute<{ id: string }>(sql`
    SELECT id FROM advisor_runs
     WHERE user_id = ${userId}::uuid AND advisor_id = ${NARRATOR_MANIFEST.advisor_id} AND status = 'started'
     ORDER BY started_at DESC LIMIT 1
  `);
  const id = rows.rows[0]?.id;
  if (id === undefined) throw new Error('no started narrator run');
  return id;
}

describe.skipIf(NO_DATABASE)('Phase 5 W-C wiring (apps/api/src/{modules,worker}.ts)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp5wcwiring' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it(
    'the weekly Brief job publishes one Brief for the ISO week and enqueues its narrations ' +
      'on insights.run_local only when a model is configured',
    async () => {
      const userId = await h.database.createUser('W-C Brief, model configured');
      const modules = buildModules(h, {
        advisorTokenSecret: 'w-c-wiring-test',
        localModelConfigured: true,
        narratorModel: uncallableNarratorModel(),
        // A fixed, distinct ISO week from the other Brief test: the
        // narration-enqueue `dedupeKey` (`brief/job.ts`) is
        // `insights.run_local:local.narrator:<isoWeek>`, with no `userId` in
        // it — a discovered wrinkle in WP 5.6's own key, worth flagging
        // (evidence), not fixing here. Two Brief tests sharing wall-clock
        // "this week" would otherwise have the second test's enqueue silently
        // deduped by the first's row, which proves nothing about the gate.
        clock: fixedClock('2026-01-05T09:00:00.000Z'), // 2026-W02
      });
      const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
      expect(insightsModule).toBeDefined();
      await insightsModule?.schedules?.(userId);

      // The narrator registered through the same `registerAdvisor` path the
      // builtins use (05 §4 W-C): a row exists, `enabled_source: 'default'`.
      const advisorRows = await h.database.db.execute<{ enabled_source: string }>(sql`
        SELECT enabled_source FROM advisors WHERE user_id = ${userId}::uuid AND advisor_id = 'local.narrator'
      `);
      expect(advisorRows.rows).toHaveLength(1);
      expect(advisorRows.rows[0]?.enabled_source).toBe('default');

      const briefJob = insightsModule?.jobs?.find((job) => job.kind === 'insights.brief');
      expect(briefJob).toBeDefined();
      if (briefJob === undefined) return;

      // Only `insights.brief`'s own handler is registered with the runner:
      // this test is about what the Brief job *enqueues*, not about running
      // whatever it enqueues — the kill-ladder case below drives a narration
      // run itself, deliberately, under its own control.
      const runner = createJobRunner({
        pool: h.database.pool,
        db: platformExecutor(h.database.db),
        handlers: [briefJob],
        concurrency: 1,
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
              .select()
              .from(advisoryBriefs)
              .where(eq(advisoryBriefs.userId, userId));
            return rows.length === 1;
          },
          10_000,
          'the Brief to publish',
        );
      } finally {
        await runner.stop();
      }

      // WP 5.8's fold (wp5.8-health.md §6, applied by the orchestrator): the
      // same tick computed and stored the week's health score over a builtin
      // snapshot — a quiet week still gets a score, and a Brief job bound
      // without snapshot ports would have logged "not computed" and stored
      // nothing, which this row count would catch.
      const health = await h.database.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM health_scores WHERE user_id = ${userId}::uuid
      `);
      expect(health.rows[0]?.n).toBe(1);

      const briefs = await h.database.db
        .select()
        .from(advisoryBriefs)
        .where(eq(advisoryBriefs.userId, userId));
      expect(briefs).toHaveLength(1);

      const queued = await h.database.db.execute<{ kind: string; advisor_id: string | null }>(sql`
        SELECT kind, payload->>'advisorId' AS advisor_id FROM jobs
         WHERE user_id = ${userId}::uuid AND kind = 'insights.run_local'
      `);
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]?.advisor_id).toBe('local.narrator');
    },
    60_000,
  );

  it('with no model configured the narrator is not registered and the Brief enqueues no narration', async () => {
    const userId = await h.database.createUser('W-C Brief, no model');
    // `localModelConfigured` defaults to `false` in `buildModules` — the real
    // worker's own default (kill level 2 is off by default) — and no
    // `narratorModel` is supplied either, the api process's own shape.
    const modules = buildModules(h, {
      advisorTokenSecret: 'w-c-wiring-test',
      // A distinct ISO week from the other Brief test — see its own comment
      // on the narration-enqueue `dedupeKey`.
      clock: fixedClock('2026-02-02T09:00:00.000Z'), // 2026-W06
    });
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    expect(insightsModule).toBeDefined();
    await insightsModule?.schedules?.(userId);

    const advisorRows = await h.database.db.execute<{ advisor_id: string }>(sql`
      SELECT advisor_id FROM advisors WHERE user_id = ${userId}::uuid AND advisor_id = 'local.narrator'
    `);
    expect(advisorRows.rows).toHaveLength(0);

    const briefJob = insightsModule?.jobs?.find((job) => job.kind === 'insights.brief');
    if (briefJob === undefined) throw new Error('insights.brief did not register');

    const runner = createJobRunner({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      handlers: [briefJob],
      concurrency: 1,
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
            .select()
            .from(advisoryBriefs)
            .where(eq(advisoryBriefs.userId, userId));
          return rows.length === 1;
        },
        10_000,
        'the Brief to publish',
      );
    } finally {
      await runner.stop();
    }

    const queued = await h.database.db.execute<{ kind: string }>(sql`
      SELECT kind FROM jobs WHERE user_id = ${userId}::uuid AND kind = 'insights.run_local'
    `);
    expect(queued.rows).toHaveLength(0);
  }, 60_000);

  it("the schedule name insights.weekly_brief passes the platform's CHECK", async () => {
    const userId = await h.database.createUser('W-C schedule name');
    const modules = buildModules(h, { advisorTokenSecret: 'w-c-wiring-test' });
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    // `upsertSchedule` asserts `SCHEDULE_NAME_PATTERN` itself before it ever
    // reaches Postgres, and the row's own CHECK constraint
    // (`packages/db/migrations/0003_platform.sql`) is the second, independent
    // line — a schedule call that returned without throwing here passed both,
    // over a real database, which is the platform's own `CHECK` and not a
    // JS-side mirror of it.
    await expect(insightsModule?.schedules?.(userId)).resolves.toBeUndefined();

    // `schedules.name` is globally UNIQUE (`0003_platform.sql`, D6's one
    // holder: one row per well-known name, not one per user), and
    // `upsertSchedule`'s own `ON CONFLICT (name) DO UPDATE` deliberately
    // never overwrites `user_id` on an existing row (`scheduler.ts`'s own
    // comment: a redeploy must not reassign a schedule) — so with an earlier
    // test in this file having already created this exact row under its own
    // fresh holder, the row here may belong to that holder rather than to
    // `userId`. Queried by name alone for exactly that reason; the claim
    // under test is that the name and shape are accepted, not which holder
    // owns the row.
    const rows = await h.database.db.execute<{
      name: string;
      job_kind: string;
      cron: string;
      timezone: string;
    }>(sql`
      SELECT name, job_kind, cron, timezone FROM schedules WHERE name = 'insights.weekly_brief'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.job_kind).toBe('insights.brief');
    // Sunday 06:00 local (05 §3 WP 5.6): the standard five-field cron, minute
    // 0, hour 6, every day-of-month, every month, Sunday (0).
    expect(rows.rows[0]?.cron).toBe('0 6 * * 0');
    expect(rows.rows[0]?.timezone).toBe(ZONE);
  }, 60_000);

  it('assertPoolCoversLeases holds with the Phase 5 kinds at the default DATABASE_POOL_MAX', () => {
    const modules = buildModules(h, {
      advisorTokenSecret: 'w-c-wiring-test',
      localModelConfigured: true,
      narratorModel: uncallableNarratorModel(),
    });
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    // `insights.brief`, `insights.run_local`, `insights.run` and
    // `insights.run_all` are job *kinds*, not consumers: exactly one
    // consumer either way (`createInsightsConsumer`), with every Phase 5
    // kind wired in and the narrator registered.
    expect(insightsModule?.consumers ?? []).toHaveLength(1);
    expect((insightsModule?.jobs ?? []).map((job) => job.kind).sort()).toEqual(
      ['insights.brief', 'insights.run', 'insights.run_all', 'insights.run_local'].sort(),
    );

    // The worst case `WORKER_PINNED_CONNECTIONS` itself is derived from
    // (`worker-pool-guard.test.ts`'s own precedent): every module enabled,
    // one consumer each.
    const consumerCount = MODULE_FLAGS.length;
    const poolMax = defaultDatabasePoolMax() + WORKER_PINNED_CONNECTIONS;
    const logger = pino({ level: 'silent' });
    expect(() => assertPoolCoversLeases(logger, poolMax, consumerCount)).not.toThrow();
  }, 30_000);

  describe(
    'a narration run killed at each of the four levels while the fake model is mid-reply ' +
      'ends within two seconds and links nothing',
    () => {
      const LEVELS: readonly {
        readonly level: 1 | 2 | 3 | 4;
        readonly name: string;
        readonly expected: string;
      }[] = [
        { level: 1, name: 'module.insights off', expected: 'module_disabled' },
        { level: 2, name: 'advisors.kind.local_model off', expected: 'kind_disabled' },
        { level: 3, name: 'advisors.enabled off', expected: 'advisor_disabled' },
        { level: 4, name: 'POST …/cancel (requestRunCancel)', expected: 'run_cancelled' },
      ];

      for (const level of LEVELS) {
        it(`level ${String(level.level)} — ${level.name}`, async () => {
          const userId = await h.database.createUser(`W-C kill level ${String(level.level)}`);
          const fake: FakeOllama = await startFakeOllama({
            models: [{ name: MODEL_NAME, digest: SERVED_DIGEST_HEX }],
            // Mid-reply forever, until the run is aborted — the same
            // double `ollama-client.test.ts` proves an abort against.
            chat: { kind: 'endless', intervalMs: 15 },
          });
          try {
            const adapter = adapterFor(fake.port);
            const { dependencies, flags } = await narratorWorld(h, userId, adapter);
            const context = contextFor(userId);
            const platformDb = platformExecutor(h.database.db);

            const running = runAdvisor(h.database.db, context, dependencies, {
              advisorId: NARRATOR_MANIFEST.advisor_id,
              trigger: 'manual',
              lane: 'local',
            });

            // Wait until the model is genuinely generating — not merely
            // requested — before flipping anything.
            await until(
              async () => (fake.chats[0]?.linesWritten ?? 0) > 2,
              10_000,
              'the model to start streaming',
            );

            const flippedAt = Date.now();
            if (level.level === 1) {
              await flags.set(platformDb, userId, MODULE_FLAG_KEY, false);
            } else if (level.level === 2) {
              await flags.set(
                platformDb,
                userId,
                KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model',
                false,
              );
            } else if (level.level === 3) {
              await setAdvisorEnabled(h.database.db, context, NARRATOR_MANIFEST.advisor_id, false);
            } else {
              const runId = await startedNarratorRunId(h, userId);
              expect(await requestRunCancel(h.database.db, context, runId)).toBe('requested');
            }

            const result = await running;
            const stopMs = Date.now() - flippedAt;
            console.info(
              `[phase5-wiring] level ${String(level.level)} (${level.name}): stopped in ${stopMs.toFixed(0)} ms`,
            );

            expect(result.status).toBe('cancelled');
            expect(result.cancelReason).toBe(level.expected);
            expect(stopMs).toBeLessThan(2_000);

            // Links nothing: no narration row exists for this user at all.
            const narrationRows = await h.database.db
              .select()
              .from(insights)
              .where(and(eq(insights.userId, userId), isNotNull(insights.narratesInsightId)));
            expect(narrationRows).toHaveLength(0);

            // And the socket really was still open when the level flipped
            // — the fake server's own observation, not the client's.
            await until(async () => fake.chats[0]?.closed === true, 2_000, 'the socket to close');
          } finally {
            await fake.close();
          }
        }, 60_000);
      }
    },
  );
});
