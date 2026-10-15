// SPDX-License-Identifier: MIT
/**
 * WP 10.6 (D30) — a hosted narrator through the worker's own composition.
 *
 * `appModules` exactly as `worker.ts` builds it on an install with **no**
 * `LOCAL_MODEL_*` environment (`localModelConfigured: false`, no renderer, no
 * model port) and the per-holder runtime `worker.ts` builds —
 * `createNarratorRuntime({ mode: 'run', stores: createNarratorStores(...) })` —
 * over the real settings, consent and sealed-key tables. The one seam is the
 * hosted adapter's transport: the hermetic vendor fake (`@advisor/local-model/test`),
 * answering in Anthropic's documented reply shape. No vendor is called.
 *
 *   * a holder who consented, saved a key and made Anthropic active gets an
 *     accepted narration through the real `insights.run_local` handler; the
 *     run records `anthropic:claude-sonnet-5-5`, the approval says
 *     `anthropic` and the model, and the one call went to `api.anthropic.com`
 *     under the reply format derived from `NARRATION_FORMAT`;
 *   * a hosted reply that introduces a figure is refused by the numerals check
 *     (`numerals:numeral_not_placed`), and one outside the reply format by the
 *     validator — the same validation path, byte for byte, as a local reply;
 *   * switching the provider revokes the approval: the next run is refused
 *     `payload_not_approved` until the holder re-approves;
 *   * Off: the change reaches the worker through the settings consumer without
 *     a restart, and a queued narration is refused `kind_disabled`, by name.
 */
import { readFileSync } from 'node:fs';
import { hostedNarrationFormat } from '@advisor/local-model';
import {
  FakeHostedTransport,
  fakeHostedOk,
  PUBLIC_RESOLVE,
  recordedReply,
  SYNTHETIC_KEY,
} from '@advisor/local-model/test';
import { money, newId, systemClock } from '@core/kernel';
import {
  createFlagService,
  createJobRunner,
  enqueueJob,
  platformExecutor,
  silentLogger,
  PLATFORM_FLAGS,
} from '@core/platform';
import { setLanguageModelKey } from '@ctx/connections';
import {
  approvePayload,
  BUILTIN_CATALOGUE,
  createAdvisorRegistry,
  dependenciesForHolder,
  giveNarratorConsent,
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
  NARRATOR_SETTINGS_CONSUMER,
  narrationsFor,
  NarratorSettingsChanged,
  previewRequest,
  registerAdvisor,
  runAdvisor,
  setActiveNarratorProvider,
  setAdvisorEnabled,
  type InsightsContext,
  type InsightsDependencies,
} from '@ctx/insights';
import { advisorPayloadApprovals, advisorRuns, insights } from '@ctx/insights/schema';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules, insightsRunSwitches } from '../../src/modules.ts';
import { narratorConsentSha256, NARRATOR_CONSENT_VERSION } from '../../src/narrator-consent.ts';
import { createNarratorStores } from '../../src/narrator-stores.ts';
import { createNarratorRuntime, type NarratorRuntime } from '../../src/narrator-wiring.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../../src/platform.ts';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const ZONE = 'America/New_York';
const YIELD = 'builtin.cash.yield_spread';
const TOKEN_SECRET = 'wp106-hosted-composition'; // gitleaks:allow — synthetic advisor-token secret for a test

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

function contextFor(userId: string): InsightsContext {
  return { userId, clock: systemClock, correlationId: newId() };
}

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

function narration(summary: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    insights: [
      {
        finding: 1,
        severity: 'notable',
        title: 'One account earns far less than another',
        summary_md: summary,
        confidence: 0.7,
        confidence_basis: 'model',
        horizon: 'this_year',
        requires_review: true,
        impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
        derivations: [],
        proposed_actions: [],
        caveats: [],
        expires_at: null,
        ...extra,
      },
    ],
  });
}

const GOOD = narration(
  'One account holds {{e1}} at {{e2}}, while another of your own earns {{e3}}.',
);

describe.skipIf(NO_DATABASE)('WP 10.6 — a hosted narrator through the worker composition', () => {
  let h: ApiHarness;
  let reply = GOOD;
  const fake = new FakeHostedTransport(() => fakeHostedOk(recordedReply('anthropic', reply)));
  let runtime: NarratorRuntime;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp106hosted' });
    runtime = createNarratorRuntime({
      mode: 'run',
      stores: createNarratorStores({
        database: h.database.db,
        secretBox: () => h.security.requireSecretBox(),
      }),
      localModel: undefined,
      timeoutMs: 20_000,
      allowRemote: false,
      fileKeys: {},
      hostedTransport: fake.transport,
      resolve: PUBLIC_RESOLVE,
      clock: systemClock,
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  /** `appModules()` as `worker.ts` builds it with no LOCAL_MODEL_* and the per-holder runtime. */
  function workerModules(userId: string) {
    const denyAll = createEgressPolicy({ allowedHosts: [] });
    const domain = createDomainRuntime({
      database: h.database.db,
      clock: systemClock,
      logger: pino({ level: 'silent' }),
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
    });
    return appModules({
      advisorsEnabled: true,
      database: h.database.db,
      userId,
      orchestrator: domain.orchestrator,
      timezone: ZONE,
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: denyAll }),
        smtp: createSmtpChannel({ policy: denyAll }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(h.database.db),
      advisorTokenSecret: TOKEN_SECRET,
      localModelConfigured: false,
      narratorRuntime: runtime,
    });
  }

  /** Consent, key, Anthropic active — through the product's own functions. */
  async function anthropicActive(userId: string): Promise<void> {
    const context = contextFor(userId);
    await h.database.db.transaction(async (tx) => {
      await giveNarratorConsent(tx, context, {
        provider: 'anthropic',
        consentTextVersion: NARRATOR_CONSENT_VERSION,
        consentTextSha256: narratorConsentSha256('anthropic'),
      });
      await setLanguageModelKey(
        tx,
        { provider: 'anthropic', key: SYNTHETIC_KEY, secretBox: h.security.requireSecretBox() },
        { userId, clock: systemClock, correlationId: newId() },
      );
      await setActiveNarratorProvider(tx, context, {
        provider: 'anthropic',
        currentConsentVersion: NARRATOR_CONSENT_VERSION,
        model: 'claude-sonnet-5-5',
      });
    });
    runtime.invalidate();
  }

  /** The finding, the grants, the flags, and the payload approved under the holder's renderer. */
  async function narratorReady(
    userId: string,
  ): Promise<{ findingId: string; deps: InsightsDependencies }> {
    const context = contextFor(userId);
    const insightsModule = workerModules(userId).find((m) => m.flagKey === 'module.insights');
    await insightsModule?.schedules?.(userId);
    const yieldEntry = BUILTIN_CATALOGUE.find((entry) => entry.advisorId === YIELD);
    if (yieldEntry === undefined) throw new Error(`no ${YIELD}`);
    const deps: InsightsDependencies = {
      registry: createAdvisorRegistry([yieldEntry.advisor]),
      switches: insightsRunSwitches(h.database.db, {
        advisorsEnabled: true,
        localModelConfigured: false,
        narratorRuntime: runtime,
      }),
      narratorFor: runtime.forUser,
      ports: yieldPorts(),
      settings: { timeZone: ZONE, baseCurrency: 'USD', tokenSecret: TOKEN_SECRET },
    };
    await registerAdvisor(h.database.db, context, {
      manifest: yieldEntry.advisor.manifest,
      enabled: true,
    });
    await registerAdvisor(h.database.db, context, { manifest: NARRATOR_MANIFEST, enabled: false });
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
    await flags.set(platformExecutor(h.database.db), userId, MODULE_FLAG_KEY, true);
    await flags.set(
      platformExecutor(h.database.db),
      userId,
      KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model',
      true,
    );
    const seeded = await runAdvisor(h.database.db, context, deps, {
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
    await approve(userId, deps);
    return { findingId, deps };
  }

  async function approve(userId: string, deps: InsightsDependencies): Promise<void> {
    const context = contextFor(userId);
    const holder = await dependenciesForHolder(deps, userId);
    const preview = await previewRequest(
      h.database.db,
      context,
      holder,
      NARRATOR_MANIFEST.advisor_id,
    );
    await approvePayload(h.database.db, context, holder, {
      advisorId: NARRATOR_MANIFEST.advisor_id,
      queryShape: preview.queryShape,
    });
  }

  /** One narration through the real `insights.run_local` handler; its run row. */
  async function narrateOnce(userId: string, findingId: string) {
    const insightsModule = workerModules(userId).find((m) => m.flagKey === 'module.insights');
    const handlers = (insightsModule?.jobs ?? []).filter(
      (job) => job.kind === 'insights.run_local',
    );
    expect(handlers).toHaveLength(1);
    const before = (
      await h.database.db
        .select({ id: advisorRuns.id })
        .from(advisorRuns)
        .where(
          and(
            eq(advisorRuns.userId, userId),
            eq(advisorRuns.advisorId, NARRATOR_MANIFEST.advisor_id),
          ),
        )
    ).length;
    const runner = createJobRunner({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      handlers,
      concurrency: 1,
      pollIntervalMs: 25,
      logger: silentLogger,
    });
    await runner.start();
    try {
      await enqueueJob(platformExecutor(h.database.db), {
        kind: 'insights.run_local',
        userId,
        payload: {
          advisorId: NARRATOR_MANIFEST.advisor_id,
          trigger: 'manual',
          narrateInsightIds: [findingId],
        },
        correlationId: newId(),
        maxAttempts: 1,
      });
      await until(
        async () => {
          const rows = await h.database.db
            .select({ id: advisorRuns.id })
            .from(advisorRuns)
            .where(
              and(
                eq(advisorRuns.userId, userId),
                eq(advisorRuns.advisorId, NARRATOR_MANIFEST.advisor_id),
                isNotNull(advisorRuns.finishedAt),
              ),
            );
          return rows.length > before;
        },
        30_000,
        'the narrator run to finish',
      );
    } finally {
      await runner.stop();
    }
    const [run] = await h.database.db
      .select()
      .from(advisorRuns)
      .where(
        and(
          eq(advisorRuns.userId, userId),
          eq(advisorRuns.advisorId, NARRATOR_MANIFEST.advisor_id),
        ),
      )
      .orderBy(desc(advisorRuns.startedAt))
      .limit(1);
    if (run === undefined) throw new Error('no run row');
    return run;
  }

  it('an accepted narration lands through the worker wiring, named anthropic:claude-sonnet-5-5 end to end', async () => {
    const userId = await h.database.createUser('WP 10.6 hosted composition');
    await anthropicActive(userId);
    const { findingId } = await narratorReady(userId);
    reply = GOOD;
    const callsBefore = fake.calls.length;
    const run = await narrateOnce(userId, findingId);
    expect(run.status).toBe('completed');
    expect(run.acceptedCount).toBe(1);
    expect(run.llmModel).toBe('anthropic:claude-sonnet-5-5');

    const calls = fake.calls.slice(callsBefore);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe('api.anthropic.com');
    expect(calls[0]?.path).toBe('/v1/messages');
    expect(
      (calls[0]?.body['output_config'] as { format: { schema: unknown } }).format.schema,
    ).toEqual(hostedNarrationFormat('anthropic'));
    expect(JSON.stringify(calls[0]?.body)).not.toContain(SYNTHETIC_KEY);

    const [approval] = await h.database.db
      .select()
      .from(advisorPayloadApprovals)
      .where(eq(advisorPayloadApprovals.userId, userId));
    expect(approval?.llmProvider).toBe('anthropic');
    expect(approval?.llmModel).toBe('anthropic:claude-sonnet-5-5');

    // The badge's source: the narration's run names the model.
    const views = await narrationsFor(h.database.db, userId, [findingId]);
    expect(views.get(findingId)?.llmModel).toBe('anthropic:claude-sonnet-5-5');
  }, 120_000);

  it('a hosted reply that introduces a figure is refused by the numerals check, as a local one is', async () => {
    const userId = await h.database.createUser('WP 10.6 hosted numerals');
    await anthropicActive(userId);
    const { findingId } = await narratorReady(userId);
    reply = narration('One account holds 21235 dollars at {{e2}}, while another earns {{e3}}.');
    const run = await narrateOnce(userId, findingId);
    expect(run.acceptedCount).toBe(0);
    expect(run.rejections).toContainEqual(
      expect.objectContaining({ step: 'numerals', reason: 'numeral_not_placed' }),
    );
  }, 120_000);

  it('a hosted reply outside the reply format is refused by the validator, as a local one is', async () => {
    const userId = await h.database.createUser('WP 10.6 hosted format');
    await anthropicActive(userId);
    const { findingId } = await narratorReady(userId);
    reply = narration('One account holds {{e1}} at {{e2}}.', {
      confidence_basis: 'deterministic',
      proposed_actions: [{ kind: 'suggest_only', label: 'Move it', rationale_md: 'x' }],
    });
    const run = await narrateOnce(userId, findingId);
    expect(run.acceptedCount).toBe(0);
    expect(run.rejectedCount + (run.status === 'failed' ? 1 : 0)).toBeGreaterThan(0);
  }, 120_000);

  it('switching the provider revokes the approval: refused payload_not_approved until re-approved', async () => {
    const userId = await h.database.createUser('WP 10.6 hosted switch');
    await anthropicActive(userId);
    const { findingId, deps } = await narratorReady(userId);
    const context = contextFor(userId);
    await h.database.db.transaction(async (tx) => {
      await giveNarratorConsent(tx, context, {
        provider: 'openai',
        consentTextVersion: NARRATOR_CONSENT_VERSION,
        consentTextSha256: narratorConsentSha256('openai'),
      });
      await setLanguageModelKey(
        tx,
        { provider: 'openai', key: SYNTHETIC_KEY, secretBox: h.security.requireSecretBox() },
        { userId, clock: systemClock, correlationId: newId() },
      );
    });
    const change = await h.database.db.transaction((tx) =>
      setActiveNarratorProvider(tx, context, {
        provider: 'openai',
        currentConsentVersion: NARRATOR_CONSENT_VERSION,
        model: 'gpt-6.1-sol',
      }),
    );
    expect(change.approvalsRevoked).toBe(1);
    runtime.invalidate();
    const refused = await narrateOnce(userId, findingId);
    expect(refused.status).toBe('refused');
    expect(refused.refusal).toBe('payload_not_approved');

    await approve(userId, deps);
    const approvals = await h.database.db
      .select()
      .from(advisorPayloadApprovals)
      .where(eq(advisorPayloadApprovals.userId, userId));
    expect(approvals.filter((row) => row.revokedAt === null).map((row) => row.llmProvider)).toEqual(
      ['openai'],
    );
  }, 120_000);

  it('Off reaches the worker through the settings consumer, without a restart, and a queued narration is refused kind_disabled', async () => {
    const userId = await h.database.createUser('WP 10.6 hosted off');
    await anthropicActive(userId);
    const { findingId } = await narratorReady(userId);
    expect(await runtime.forUser(userId)).not.toBeNull(); // cached now
    await h.database.db.transaction((tx) =>
      setActiveNarratorProvider(tx, contextFor(userId), {
        provider: 'off',
        currentConsentVersion: NARRATOR_CONSENT_VERSION,
        model: null,
      }),
    );
    // Still cached: the change has not reached this process yet.
    expect(await runtime.forUser(userId)).not.toBeNull();
    const consumer = workerModules(userId)
      .find((m) => m.flagKey === 'module.insights')
      ?.consumers?.find((c) => c.name === NARRATOR_SETTINGS_CONSUMER);
    expect(consumer?.filter).toEqual([NarratorSettingsChanged.type]);
    await consumer?.handler(
      {
        eventType: NarratorSettingsChanged.type,
        userId,
        payload: { activeProvider: 'off', model: null, change: 'provider', approvalsRevoked: 0 },
      } as never,
      {} as never,
    );
    expect(await runtime.forUser(userId)).toBeNull();
    const run = await narrateOnce(userId, findingId);
    expect(run.status).toBe('refused');
    expect(run.refusal).toBe('kind_disabled');
  }, 120_000);

  it('worker.ts builds this runtime from the same stores and binds it into appModules', () => {
    const source = readFileSync(new URL('../../src/worker.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /createNarratorRuntime\(\{\s*mode: 'run',\s*stores: createNarratorStores\(/u,
    );
    expect(source).toMatch(/narratorRuntime,\n/u);
    const app = readFileSync(new URL('../../src/app.ts', import.meta.url), 'utf8');
    expect(app).toMatch(
      /createNarratorRuntime\(\{\s*mode: 'preview',\s*stores: createNarratorStores\(/u,
    );
  });
});
