// SPDX-License-Identifier: MIT
/**
 * WP 11.2 through the shipped composition, against a real database and the
 * real local suggestion adapter over the fake Ollama (no live model):
 *
 *   * §1 — a pick through `PATCH /transactions/{id}` and `POST /transactions/bulk`
 *     reaches the categorization consumer as `ledger.TransactionCategoryChosen`
 *     and produces `classifier_examples` rows; three picks of a merchant become
 *     a learned merchant default that files the next sync's row.
 *   * §4 — Settings: the state, Enable refused below 85 % (and at 84 %), allowed
 *     at 85 % over 20 rows; the measurement through the worker's job writes
 *     its own row and nothing else, and opens the gate on the holder's history.
 *   * §2/§3 — the worker's `categorization.suggest` job (the registration
 *     `appModules` returns) asks the model once per merchant, lands a
 *     suggestion on the abstention row and in `GET /transactions/explanations`,
 *     leaves the row uncategorised, writes one `advisor_runs` row with the
 *     batch digest, and changes no approval, grant or consent.
 *   * the hosted branch is unreachable without the separate consent.
 */
import { SUGGEST_FORMAT } from '@advisor/local-model';
import { startFakeOllama, type FakeOllama } from '@advisor/local-model/test';
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import {
  createConsumerPump,
  createFlagService,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  platformExecutor,
  PLATFORM_FLAGS,
  type JobContext,
} from '@core/platform';
import {
  SUGGEST_JOB_KIND,
  SUGGEST_MEASURE_JOB_KIND,
  categoryIdsByKey,
  recordSuggestionEval,
  seedSystemTaxonomy,
  writeSuggestionSettings,
  type CategorizationExecutor,
} from '@ctx/categorization';
import { CATEGORY_SUGGEST_ADVISOR_ID, KIND_FLAG_KEYS, MODULE_FLAG_KEY } from '@ctx/insights';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSuggestionRuntime,
  suggestHostedConsentSha256,
  type SuggestionRuntime,
} from '../../src/category-suggestions.ts';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules, registerBuiltinAdvisors } from '../../src/modules.ts';
import { createNarratorRuntime, type NarratorStores } from '../../src/narrator-wiring.ts';
import { createNarratorStores } from '../../src/narrator-stores.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../../src/platform.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  problemOf,
  syncConnection,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '7'.repeat(64);
const CLASSIFIER_NAME = 'qwen2.5:3b-instruct';
const CLASSIFIER_DIGEST_HEX = '3'.repeat(64);
const TOKEN_SECRET = 'wp112-category-suggestions'; // gitleaks:allow — synthetic advisor-token secret for a test
const ACCOUNT = 'wp112-card';

/** Seven single-word merchants, three hand-filed picks each: the gold set. */
const GOLD: readonly (readonly [string, string])[] = [
  ['ALPHAMART', 'groceries.supermarkets'],
  ['BRAVOFUEL', 'health.dental'],
  ['CHARLIEPETS', 'shopping.other_shopping'],
  ['DELTADINER', 'dining.restaurants'],
  ['ECHOBOOKS', 'shopping.books_and_media'],
  ['FOXTROTGYM', 'personal_care.fitness'],
  ['GOLFPHARM', 'health.pharmacy'],
];

function reply(entries: readonly (readonly [string, string | null])[]): string {
  return JSON.stringify({
    suggestions: entries
      .filter((entry) => entry[1] !== null)
      .map(([ref, key]) => ({
        transaction_ref: ref,
        category_key: key,
        reason: 'The payee name points that way.',
      })),
    abstain: entries.filter((entry) => entry[1] === null).map(([ref]) => ref),
  });
}

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

describe.skipIf(NO_DATABASE)('WP 11.2 — category suggestions through the composition', () => {
  let h: ApiHarness;
  let fake: FakeOllama;
  let modules: ReturnType<typeof appModules>;
  let suggestionRuntime: SuggestionRuntime;
  let connectionId: string;
  const syncedNames: string[] = [];

  async function drain(): Promise<void> {
    const categorization = modules.find((module) => module.flagKey === 'module.categorization');
    const pump = createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      clock: systemClock,
      logger: pino({ level: 'silent' }),
      consumers: categorization?.consumers ?? [],
    });
    await pump.drain();
  }

  async function sync(rows: readonly { id: string; name: string; amount: bigint; date: string }[]) {
    h.manualStore.append(`wp112-conn`, {
      added: rows.map((row) =>
        manualTransaction({
          providerAccountId: ACCOUNT,
          providerTransactionId: row.id,
          amount: money(row.amount, 'USD'),
          postedDate: DateOnly.parse(row.date),
          name: row.name,
        }),
      ),
    });
    syncedNames.push(...rows.map((row) => row.name));
    await syncConnection(h, connectionId, h.fresh);
    await drain();
  }

  async function transactionsNamed(name: string) {
    const response = await h.request({
      method: 'GET',
      url: `/transactions?limit=200&q=${encodeURIComponent(name)}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    return (
      response.json() as { items: { id: string; name: string; categoryId: string | null }[] }
    ).items.filter((item) => item.name.toUpperCase().includes(name));
  }

  async function job(kind: string) {
    const categorization = modules.find((module) => module.flagKey === 'module.categorization');
    const registration = categorization?.jobs?.find((entry) => entry.kind === kind);
    if (registration === undefined) throw new Error(`${kind} is not registered`);
    return registration;
  }

  async function tableDigest(table: string): Promise<string> {
    const rows = await h.database.db.execute(
      sql`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${sql.raw(table)} t`,
    );
    return String((rows.rows[0] as { digest: string }).digest);
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp112',
      env: {
        LOCAL_MODEL_PIN_NAME: MODEL_NAME,
        LOCAL_MODEL_PIN_DIGEST: `sha256:${DIGEST_HEX}`,
        LOCAL_MODEL_CLASSIFIER_NAME: CLASSIFIER_NAME,
        LOCAL_MODEL_CLASSIFIER_DIGEST: `sha256:${CLASSIFIER_DIGEST_HEX}`,
      },
    });
    fake = await startFakeOllama({
      models: [
        { name: MODEL_NAME, digest: DIGEST_HEX },
        { name: CLASSIFIER_NAME, digest: CLASSIFIER_DIGEST_HEX },
      ],
      chat: { kind: 'reply', reply: reply([]) },
    });
    await seedSystemTaxonomy(h.database.db, { userId: h.userId, clock: systemClock });
    await registerBuiltinAdvisors(h.database.db, {
      userId: h.userId,
      clock: systemClock,
      correlationId: newId(),
    });

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
    suggestionRuntime = createSuggestionRuntime({
      mode: 'run',
      database: h.database.db,
      narrator: narratorRuntime,
      stores,
      localModel,
      classifier: { name: CLASSIFIER_NAME, digest: `sha256:${CLASSIFIER_DIGEST_HEX}` },
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
      categorySuggestions: { runtime: suggestionRuntime },
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

    const linked = await linkManual(h, {
      providerConnectionId: 'wp112-conn',
      displayName: 'Everyday Card',
      accounts: [{ providerAccountId: ACCOUNT, name: 'Card', type: 'credit', currency: 'USD' }],
    });
    connectionId = linked.connectionId;
  }, 120_000);

  afterAll(async () => {
    await fake?.close();
    await h?.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  // §1
  // -------------------------------------------------------------------------

  it('a pick through the route produces classifier examples; three become a learned merchant default', async () => {
    const ids = await categoryIdsByKey(
      h.database.db as unknown as CategorizationExecutor,
      h.userId,
    );
    const rows = GOLD.flatMap(([name], merchant) =>
      [0, 1, 2].map((n) => ({
        id: `gold-${String(merchant)}-${String(n)}`,
        name,
        amount: -(1_000n + BigInt(merchant * 100 + n)),
        date: `2026-0${String(3 + n)}-1${String(merchant)}`,
      })),
    );
    await sync(rows);
    expect(await countOf('classifier_examples')).toBe(0);

    // The first merchant through PATCH (one pick at a time), the rest through the bulk path.
    const [first, ...others] = GOLD;
    if (first === undefined) throw new Error('no gold');
    for (const item of await transactionsNamed(first[0])) {
      const response = await h.request({
        method: 'PATCH',
        url: `/transactions/${item.id}`,
        session: h.stale,
        body: { categoryId: ids.get(first[1]) },
      });
      expectStatus(response, 200);
    }
    await drain();
    expect(await countOf('classifier_examples')).toBeGreaterThan(0);
    const support = await h.database.db.execute<{ n: number }>(sql`
      SELECT max(default_support_count) AS n FROM merchant_profiles WHERE user_id = ${h.userId}
    `);
    expect(Number(support.rows[0]?.n)).toBe(3);

    for (const [name, key] of others) {
      const items = await transactionsNamed(name);
      const response = await h.request({
        method: 'POST',
        url: '/transactions/bulk',
        session: h.stale,
        body: { transactionIds: items.map((item) => item.id), patch: { categoryId: ids.get(key) } },
      });
      expectStatus(response, 200);
    }
    await drain();
    const confirmed = await h.database.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM category_assignments
       WHERE user_id = ${h.userId} AND is_current AND source = 'user' AND confirmed_at IS NOT NULL
    `);
    expect(Number(confirmed.rows[0]?.n)).toBe(21);

    // The learned default files the next sync's row of that merchant.
    await sync([{ id: 'gold-next', name: first[0], amount: -1_234n, date: '2026-06-15' }]);
    // The ledger's effective category carries only the user and rule tiers
    // (`effectiveOf`, WP 1.4 — unchanged here); a merchant default is recorded
    // in category_assignments, which is what this asserts.
    const source = await h.database.db.execute<{ source: string }>(sql`
      SELECT a.source FROM category_assignments a
       WHERE a.user_id = ${h.userId} AND a.is_current AND a.source = 'merchant_default'
    `);
    expect(source.rows).toHaveLength(1);
  }, 120_000);

  async function countOf(table: string): Promise<number> {
    const rows = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${sql.raw(table)}`,
    );
    return Number(rows.rows[0]?.n);
  }

  // -------------------------------------------------------------------------
  // §4 — Settings and the gate
  // -------------------------------------------------------------------------

  async function settings() {
    const response = await h.request({
      method: 'GET',
      url: '/categories/suggestions/settings',
      session: h.stale,
    });
    expectStatus(response, 200);
    return response.json() as {
      state: string;
      enabled: boolean;
      gate: { open: boolean; reason: string | null };
      modelChoice: string;
      models: {
        choice: string;
        available: boolean;
        label: string | null;
        latest: { precision: number | null } | null;
      }[];
      approval: { queryShape: string | null; approved: boolean; live: number };
      hosted: { applies: boolean; consented: boolean; consentText: string };
    };
  }

  async function enable(enabled: boolean) {
    return h.request({
      method: 'POST',
      url: '/categories/suggestions/enabled',
      session: h.fresh,
      body: { enabled },
    });
  }

  it('Settings: not measured, Enable refused; both pinned models offered; hosted consent names merchant names and is off', async () => {
    const view = await settings();
    expect(view.state).toBe('not_measured');
    expect(view.enabled).toBe(false);
    expect(view.models.map((model) => [model.choice, model.available])).toEqual([
      ['narrator', true],
      ['classifier', true],
    ]);
    expect(view.hosted.consented).toBe(false);
    expect(view.hosted.applies).toBe(false);
    expect(view.hosted.consentText).toContain('merchant names leave this machine');
    const refused = await enable(true);
    expectStatus(refused, 409);
    expect(problemOf(refused)['code']).toBe('categorization.suggestions_below_gate');
    // And the generic advisor switch refuses to bypass the card.
    const bypass = await h.request({
      method: 'POST',
      url: `/advisors/${CATEGORY_SUGGEST_ADVISOR_ID}/enabled`,
      session: h.fresh,
      body: { enabled: true },
    });
    expectStatus(bypass, 409);
    expect(problemOf(bypass)['code']).toBe('categorization.suggestions_enable_elsewhere');
  });

  it('the gate refuses Enable at 84 % and allows it at 85 % over twenty rows', async () => {
    const executor = h.database.db as unknown as CategorizationExecutor;
    const figures = (scored: number, correct: number) => ({
      goldTotal: scored,
      residue: scored,
      asked: scored,
      scored,
      correct,
      abstained: 0,
      refused: 0,
      precision: correct / scored,
      coverage: 1,
      confusions: [],
    });
    const base = {
      modelChoice: 'classifier' as const,
      model: 'synthetic',
      modelDigest: null,
      status: 'completed' as const,
      failure: null,
      batchDigests: [],
      durationMs: 1,
    };
    await writeSuggestionSettings(
      executor,
      { userId: h.userId, clock: systemClock },
      { modelChoice: 'classifier' },
    );
    await recordSuggestionEval(
      executor,
      { userId: h.userId, clock: systemClock },
      { ...base, figures: figures(100, 84) },
    );
    const at84 = await enable(true);
    expectStatus(at84, 409);
    expect(problemOf(at84)['detail']).toContain('84 %');
    expect((await settings()).state).toBe('below_gate');

    await recordSuggestionEval(
      executor,
      { userId: h.userId, clock: systemClock },
      { ...base, figures: figures(19, 19) },
    );
    expectStatus(await enable(true), 409);

    await recordSuggestionEval(
      executor,
      { userId: h.userId, clock: systemClock },
      { ...base, figures: figures(20, 17) },
    );
    const at85 = await enable(true);
    expectStatus(at85, 200);
    expect((at85.json() as { state: string }).state).toBe('on');
    // Off again, and back to the narrator's model for the rest of the suite.
    expectStatus(await enable(false), 200);
    await writeSuggestionSettings(
      executor,
      { userId: h.userId, clock: systemClock },
      { modelChoice: 'narrator' },
    );
  });

  it('Measure: the worker job scores the model on the residue of the holder history, writes only its own row, and opens the gate', async () => {
    // The seven merchants, each held out, are the residue; one batch, refs in merchant-key order.
    fake.chat = {
      kind: 'reply',
      reply: reply(GOLD.map(([, key], index) => [`r${String(index + 1)}`, key])),
    };
    const watched = [
      'category_assignments',
      'category_abstentions',
      'classifier_examples',
      'merchant_profiles',
      'category_suggestion_cache',
      'advisor_runs',
      'advisor_payload_approvals',
      'snapshot_grants',
    ];
    // Measure needs an approved payload shape (the payload goes to the model):
    // preview and approve through the api's own routes first.
    const preview = await h.request({
      method: 'GET',
      url: '/categories/suggestions/preview',
      session: h.stale,
    });
    expectStatus(preview, 200);
    const shown = preview.json() as { queryShape: string; approved: boolean };
    expect(shown.approved).toBe(false);
    expectStatus(
      await h.request({
        method: 'POST',
        url: '/categories/suggestions/approve',
        session: h.fresh,
        body: { queryShape: shown.queryShape },
      }),
      200,
    );
    const before = await Promise.all(watched.map((table) => tableDigest(table)));
    const chatsBefore = fake.chats.length;
    const evalsBefore = await countOf('category_suggestion_evals');
    const registration = await job(SUGGEST_MEASURE_JOB_KIND);
    await registration.handler({ modelChoice: 'narrator' }, jobContext(h.userId));
    expect(fake.chats.length).toBe(chatsBefore + 1);
    const lastChat = fake.requests.filter((request) => request.path === '/api/chat').at(-1);
    expect((lastChat?.body as { format?: unknown }).format).toEqual(SUGGEST_FORMAT);
    expect(await countOf('category_suggestion_evals')).toBe(evalsBefore + 1);
    expect(await Promise.all(watched.map((table) => tableDigest(table)))).toEqual(before);
    const view = await settings();
    const narrator = view.models.find((model) => model.choice === 'narrator');
    expect(narrator?.latest).toMatchObject({
      status: 'completed',
      scored: 21,
      correct: 21,
      precision: 1,
    });
    expect(view.state).toBe('ready');
  }, 60_000);

  it('the suggestion job asks once per merchant, lands a chip, assigns nothing, and changes no approval or consent', async () => {
    await sync([
      { id: 'res-1', name: 'XRAYSHOP', amount: -4_500n, date: '2026-07-02' },
      { id: 'res-2', name: 'XRAYSHOP', amount: -4_600n, date: '2026-07-09' },
      { id: 'res-3', name: 'YANKEECRAFT', amount: -2_100n, date: '2026-07-03' },
    ]);
    // The approval, through the api's own preview and approve routes.
    const preview = await h.request({
      method: 'GET',
      url: '/categories/suggestions/preview',
      session: h.stale,
    });
    expectStatus(preview, 200);
    const shown = preview.json() as {
      queryShape: string;
      prompt: { text: string };
      approved: boolean;
    };
    // The same shape as the one approved before the measurement: still approved.
    expect(shown.approved).toBe(true);
    expect(shown.prompt.text).toContain('xrayshop');
    expect(shown.prompt.text).not.toContain('XRAYSHOP');
    expectStatus(await enable(true), 200);

    const consentsBefore = await Promise.all(
      [
        'advisor_payload_approvals',
        'snapshot_grants',
        'category_suggestion_settings',
        'narrator_provider_consents',
      ].map((table) => tableDigest(table).catch(() => 'absent')),
    );
    const runsBefore = await countOf('advisor_runs');
    const chatsBefore = fake.chats.length;
    fake.chat = {
      kind: 'reply',
      reply: reply([
        ['r1', 'shopping.hobbies'],
        ['r2', null],
      ]),
    };
    const registration = await job(SUGGEST_JOB_KIND);
    await registration.handler({}, jobContext(h.userId));
    expect(fake.chats.length).toBe(chatsBefore + 1);
    expect(await countOf('advisor_runs')).toBe(runsBefore + 1);
    const run = await h.database.db.execute<{
      status: string;
      input_digest: string | null;
      accepted_count: number;
    }>(sql`
      SELECT status, input_digest, accepted_count FROM advisor_runs
       WHERE advisor_id = ${CATEGORY_SUGGEST_ADVISOR_ID} ORDER BY started_at DESC LIMIT 1
    `);
    expect(run.rows[0]).toMatchObject({ status: 'completed', accepted_count: 1 });
    expect(run.rows[0]?.input_digest).toMatch(/^sha256:/u);

    // The chip, and no assignment.
    const xray = await transactionsNamed('XRAYSHOP');
    expect(xray.every((item) => item.categoryId === null)).toBe(true);
    const explained = await h.request({
      method: 'GET',
      url: `/transactions/explanations?ids=${xray.map((item) => item.id).join(',')}`,
      session: h.stale,
    });
    expectStatus(explained, 200);
    const items = (
      explained.json() as {
        items: {
          status: string;
          suggestion: { source: string; categoryKey: string; reason: string } | null;
        }[];
      }
    ).items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.status).toBe('abstained');
      expect(item.suggestion).toMatchObject({ source: 'model', categoryKey: 'shopping.hobbies' });
    }

    // Approvals, grants and consents are unchanged by a run.
    const consentsAfter = await Promise.all(
      [
        'advisor_payload_approvals',
        'snapshot_grants',
        'category_suggestion_settings',
        'narrator_provider_consents',
      ].map((table) => tableDigest(table).catch(() => 'absent')),
    );
    expect(consentsAfter).toEqual(consentsBefore);

    // A second pass asks nothing: both merchants are in the cache.
    await registration.handler({}, jobContext(h.userId));
    expect(fake.chats.length).toBe(chatsBefore + 1);

    // Not this: the chip goes from both rows, nothing is assigned.
    const rejected = await h.request({
      method: 'POST',
      url: `/transactions/${xray[0]?.id ?? ''}/suggestion/reject`,
      session: h.stale,
    });
    expectStatus(rejected, 200);
    expect(rejected.json()).toEqual({ outcome: 'rejected' });
    const after = await h.request({
      method: 'GET',
      url: `/transactions/explanations?ids=${xray.map((item) => item.id).join(',')}`,
      session: h.stale,
    });
    expect(
      (after.json() as { items: { suggestion: unknown }[] }).items.map((item) => item.suggestion),
    ).toEqual([null, null]);
    expect((await transactionsNamed('XRAYSHOP')).every((item) => item.categoryId === null)).toBe(
      true,
    );
  }, 60_000);

  it('Confirm is the normal pick: the row is categorised and the pick teaches', async () => {
    const ids = await categoryIdsByKey(
      h.database.db as unknown as CategorizationExecutor,
      h.userId,
    );
    const [yankee] = await transactionsNamed('YANKEECRAFT');
    if (yankee === undefined) throw new Error('no residue row');
    const examplesBefore = await countOf('classifier_examples');
    const picked = await h.request({
      method: 'PATCH',
      url: `/transactions/${yankee.id}`,
      session: h.stale,
      body: { categoryId: ids.get('shopping.hobbies') },
    });
    expectStatus(picked, 200);
    await drain();
    expect(await countOf('classifier_examples')).toBeGreaterThan(examplesBefore);
    const abstention = await h.database.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM category_abstentions WHERE transaction_id = ${yankee.id}
    `);
    expect(Number(abstention.rows[0]?.n)).toBe(0);
  });

  it('the hosted branch is unreachable without the separate consent', async () => {
    const stores: NarratorStores = {
      settings: () =>
        Promise.resolve({
          activeProvider: 'openai',
          hasRow: true,
          models: {},
          ollama: null,
          consented: new Set(['openai'] as const),
        }),
      storedKey: () => Promise.resolve({ reveal: () => 'sk-test-wp112' }), // gitleaks:allow — synthetic
    };
    const runtime = createSuggestionRuntime({
      mode: 'run',
      database: h.database.db,
      narrator: {
        resolve: () =>
          Promise.resolve({
            provider: 'openai',
            reason: null,
            narrator: {
              provider: 'openai',
              modelId: 'gpt-test',
              label: 'openai:gpt-test',
              keySource: 'stored',
              renderer: undefined as never,
              model: undefined as never,
            },
          }),
      },
      stores,
      localModel: undefined,
      classifier: undefined,
      timeoutMs: 20_000,
      allowRemote: false,
      fileKeys: {},
      hostedTransport: () => Promise.reject(new Error('no network in this test')),
      clock: systemClock,
    });
    const executor = h.database.db as unknown as CategorizationExecutor;
    await writeSuggestionSettings(
      executor,
      { userId: h.userId, clock: systemClock },
      { hostedConsentTextHash: null },
    );
    const withheld = await runtime.resolve(h.userId, 'narrator');
    expect(withheld).toMatchObject({ adapter: null, reason: 'hosted_consent_required' });
    await writeSuggestionSettings(
      executor,
      { userId: h.userId, clock: systemClock },
      { hostedConsentTextHash: 'sha256:a-different-text' },
    );
    expect((await runtime.resolve(h.userId, 'narrator')).reason).toBe('hosted_consent_required');
    await writeSuggestionSettings(
      executor,
      { userId: h.userId, clock: systemClock },
      { hostedConsentTextHash: suggestHostedConsentSha256() },
    );
    const given = await runtime.resolve(h.userId, 'narrator');
    expect(given.reason).toBeNull();
    expect(given.provider).toBe('openai');
    expect(given.adapter?.egress).toBe('hosted');
    await writeSuggestionSettings(
      executor,
      { userId: h.userId, clock: systemClock },
      { hostedConsentTextHash: null },
    );
  });
});
