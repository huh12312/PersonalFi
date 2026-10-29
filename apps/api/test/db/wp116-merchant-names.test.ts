// SPDX-License-Identifier: MIT
/**
 * WP 11.6 — merchant display-name suggestions through the shipped composition,
 * against a real database (scratch `personalfi_api_wp116_*`) and the real
 * merchant-name adapter over the fake Ollama (no live model):
 *
 *   * the job and its schedule register only with a runtime; nothing is asked,
 *     listed or recorded until the `merchant.name` shape is approved, and the
 *     list route says so (`payload_not_approved`) beside the noise merchants;
 *   * Advisor management's preview shows the holder's own descriptor and the
 *     versioned consent text; a stale session cannot approve, a fresh one can;
 *   * the worker asks once per noise merchant, under the merchant-name format,
 *     the descriptor and its prefix hint only — never a clean or a banking
 *     descriptor, never an amount, a date or an id; one `advisor_runs` row per
 *     call; each answer recorded once (an invention refused `name.invented`);
 *     the transactions, merchants, approvals, grants, settings and flags
 *     unchanged by the pass;
 *   * a second pass asks nothing;
 *   * Accept (session only, like the manual rename) renames every transaction of
 *     the merchant through the overlay, exactly as `PATCH { payeeName }` would,
 *     and never rewrites `merchants.display_name`; Dismiss is final and the key is
 *     never asked about again;
 *   * a hosted narrator binds no model: nothing is asked.
 */
import { MERCHANT_NAME_FORMAT } from '@advisor/local-model';
import { startFakeOllama, type FakeOllama } from '@advisor/local-model/test';
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import {
  createFlagService,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  platformExecutor,
  PLATFORM_FLAGS,
  type JobContext,
} from '@core/platform';
import {
  KIND_FLAG_KEYS,
  MERCHANT_NAMES_JOB_KIND,
  MERCHANT_NAMES_SCHEDULE_NAME,
  MERCHANT_NAME_ADVISOR_ID,
  MERCHANT_NAME_CONSENT_TEXT,
  MODULE_FLAG_KEY,
  NARRATOR_MANIFEST,
  registerAdvisor,
  type RunSwitches,
} from '@ctx/insights';
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
  createMerchantNameRuntime,
  runMerchantNamePass,
  type MerchantNameRuntime,
} from '../../src/merchant-names.ts';
import { appModules, registerBuiltinAdvisors } from '../../src/modules.ts';
import { createNarratorRuntime } from '../../src/narrator-wiring.ts';
import { createNarratorStores } from '../../src/narrator-stores.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../../src/platform.ts';
import { explainSwitchesOf } from '../../src/routes/insight-explain.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '6'.repeat(64);
const TOKEN_SECRET = 'wp116-merchant-names'; // gitleaks:allow — synthetic advisor-token secret for a test

/** The bank's text, as the manual connector sends it. Three noise merchants, three that are not. */
const DESCRIPTORS = [
  'PAYPAL *EBAYINC',
  'PAYPAL *EBAYINC',
  'PAYPAL *EBAYINC',
  'CKO*PATREON* MEMBERSHIP',
  'WHLFDS MKT #10234',
  'SQ *BLUE BOTTLE COFFEE #4471 OAKLAND CA',
  'CHECK 1234',
  'TST* JOES PIZZA 0042',
] as const;

/** What the obedient fake answers, by the descriptor it was sent. */
const ANSWERS: Readonly<Record<string, unknown>> = {
  Ebayinc: { display_name: 'Ebay' },
  'Cko*patreon* Membership': { display_name: 'Patreon Membership' },
  // An invention: refused `name.invented`, recorded, never shown.
  'Whlfds MKT': { display_name: 'Whole Foods Market' },
};

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

/** The `{ descriptor, stripped_prefix }` block of a recorded chat. */
function merchantOf(body: unknown): { descriptor: string; stripped_prefix: string | null } {
  const messages = (body as { messages: { role: string; content: string }[] }).messages;
  const user = messages.find((message) => message.role === 'user')?.content ?? '';
  const block = user.slice(
    user.indexOf('<untrusted_data>') + '<untrusted_data>'.length,
    user.indexOf('</untrusted_data>'),
  );
  return (JSON.parse(block) as { merchant: { descriptor: string; stripped_prefix: string | null } })
    .merchant;
}

interface ListBody {
  readonly availability: { available: boolean; reason: string | null; provider: string | null };
  readonly items: {
    id: string;
    merchantId: string | null;
    descriptor: string;
    status: string;
    displayName: string;
    provider: string;
    model: string;
  }[];
  readonly pending: { merchantId: string; descriptor: string }[];
}

describe.skipIf(NO_DATABASE)('WP 11.6 — merchant names through the composition', () => {
  let h: ApiHarness;
  let fake: FakeOllama;
  let modules: ReturnType<typeof appModules>;
  let runtime: MerchantNameRuntime;
  let switches: RunSwitches;

  const chats = () => fake.requests.filter((request) => request.path === '/api/chat');

  async function tableDigest(table: string): Promise<string> {
    const rows = await h.database.db.execute(
      sql`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${sql.identifier(table)} t`,
    );
    return String((rows.rows[0] as { digest: string }).digest);
  }
  const WATCHED = [
    'transactions',
    'transactions_provider',
    'merchants',
    'advisor_payload_approvals',
    'snapshot_grants',
    'narrator_provider_consents',
    'narrator_settings',
    'feature_flags',
  ];
  const watched = () => Promise.all(WATCHED.map((table) => tableDigest(table)));

  async function runJob(): Promise<void> {
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    const registration = insightsModule?.jobs?.find(
      (entry) => entry.kind === MERCHANT_NAMES_JOB_KIND,
    );
    if (registration === undefined) throw new Error(`${MERCHANT_NAMES_JOB_KIND} is not registered`);
    await registration.handler({}, jobContext(h.userId));
  }

  async function list(): Promise<ListBody> {
    const response = await h.request({
      method: 'GET',
      url: '/merchants/name-suggestions',
      session: h.stale,
    });
    expectStatus(response, 200);
    return response.json() as ListBody;
  }

  async function rows() {
    const result = await h.database.db.execute<{
      normalized_key: string;
      status: string;
      display_name: string | null;
      refusal_class: string | null;
      llm_provider: string;
      input_digest: string;
    }>(sql`SELECT normalized_key, status, display_name, refusal_class, llm_provider, input_digest
             FROM merchant_name_suggestions WHERE user_id = ${h.userId} ORDER BY normalized_key`);
    return result.rows;
  }

  async function merchantIdOf(key: string): Promise<string> {
    const result = await h.database.db.execute<{ id: string }>(
      sql`SELECT id FROM merchants WHERE user_id = ${h.userId} AND normalized_key = ${key}`,
    );
    return result.rows[0]?.id ?? '';
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp116',
      env: {
        LOCAL_MODEL_PIN_NAME: MODEL_NAME,
        LOCAL_MODEL_PIN_DIGEST: `sha256:${DIGEST_HEX}`,
      },
    });
    fake = await startFakeOllama({
      models: [{ name: MODEL_NAME, digest: DIGEST_HEX }],
      chat: {
        kind: 'respond',
        respond: (body) =>
          JSON.stringify(ANSWERS[merchantOf(body).descriptor] ?? { abstain: 'unscripted' }),
      },
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
    runtime = createMerchantNameRuntime({
      mode: 'run',
      narrator: narratorRuntime,
      stores,
      localModel,
      timeoutMs: 20_000,
      allowRemote: false,
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
      merchantNames: { runtime },
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

    // The bank's text arrives the way a sync brings it: the manual connector, the real orchestrator.
    await linkManual(h, {
      providerConnectionId: 'wp116-conn',
      displayName: 'WP 11.6 card',
      accounts: [{ providerAccountId: 'card', name: 'Card', type: 'credit', currency: 'USD' }],
      batch: {
        added: DESCRIPTORS.map((name, index) =>
          manualTransaction({
            providerAccountId: 'card',
            providerTransactionId: `wp116-${String(index)}`,
            amount: money(BigInt(-1_000 - index), 'USD'),
            postedDate: DateOnly.of(2026, 10, 10 + index),
            name,
          }),
        ),
      },
    });
  }, 300_000);

  afterAll(async () => {
    await fake?.close();
    await h?.close();
  }, 60_000);

  it('registers its job and nightly schedule; asks nothing until the shape is approved, and the list says so', async () => {
    const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
    expect((insightsModule?.jobs ?? []).map((job) => job.kind)).toContain(MERCHANT_NAMES_JOB_KIND);
    await insightsModule?.schedules?.(h.userId);
    const schedule = await h.database.db.execute<{ job_kind: string; cron: string }>(
      sql`SELECT job_kind, cron FROM schedules WHERE name = ${MERCHANT_NAMES_SCHEDULE_NAME}`,
    );
    expect(schedule.rows[0]).toEqual({ job_kind: MERCHANT_NAMES_JOB_KIND, cron: '20 5 * * *' });

    await runJob();
    expect(chats()).toHaveLength(0);
    expect(await rows()).toEqual([]);
    const runs = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM advisor_runs WHERE advisor_id = ${MERCHANT_NAME_ADVISOR_ID}`,
    );
    expect(Number(runs.rows[0]?.n)).toBe(0);

    const listed = await list();
    expect(listed.availability).toMatchObject({
      available: false,
      reason: 'payload_not_approved',
      provider: 'ollama',
    });
    expect(listed.items).toEqual([]);
    expect(listed.pending.map((entry) => entry.descriptor)).toEqual([
      'Ebayinc',
      'Cko*patreon* Membership',
      'Whlfds MKT',
    ]);
    expect(listed.pending[0]?.merchantId).toBe(await merchantIdOf('ebayinc'));
  });

  it('Advisor management previews the holder’s own descriptor and the consent text; only a fresh session approves', async () => {
    const preview = await h.request({
      method: 'GET',
      url: `/advisors/${MERCHANT_NAME_ADVISOR_ID}/payload-preview`,
      session: h.stale,
    });
    expectStatus(preview, 200);
    const shown = preview.json() as {
      queryShape: string;
      approved: boolean;
      scopes: string[];
      request: {
        subject: Record<string, unknown>;
        snapshot: Record<string, unknown>;
        granted_scopes: string[];
        consent: { version: string; text: string };
      };
      prompt: { text: string };
    };
    expect(shown.approved).toBe(false);
    expect(shown.scopes).toEqual(['transactions.residue']);
    expect(shown.request.snapshot).toEqual({
      transactions_residue: { descriptor: 'Ebayinc', stripped_prefix: 'PAYPAL *' },
    });
    expect(shown.request.consent).toMatchObject({
      version: 'merchant-name-consent/1',
      text: MERCHANT_NAME_CONSENT_TEXT,
    });
    expect(shown.prompt.text).toContain('untrusted_data');
    // The preview called no model.
    expect(chats()).toHaveLength(0);
    const stale = await h.request({
      method: 'POST',
      url: `/advisors/${MERCHANT_NAME_ADVISOR_ID}/payload-approvals`,
      session: h.stale,
      body: { queryShape: shown.queryShape },
    });
    expect(stale.statusCode).toBe(403);
    const approved = await h.request({
      method: 'POST',
      url: `/advisors/${MERCHANT_NAME_ADVISOR_ID}/payload-approvals`,
      session: h.fresh,
      body: { queryShape: shown.queryShape },
    });
    expectStatus(approved, 200);
    expect((await list()).availability).toMatchObject({ available: true, reason: null });
  });

  it('the worker asks once per noise merchant — the descriptor and its hint only — records each answer, and changes nothing else', async () => {
    const before = await watched();
    await runJob();
    const sent = chats();
    expect(sent).toHaveLength(3);
    for (const request of sent) {
      expect((request.body as { format?: unknown }).format).toEqual(MERCHANT_NAME_FORMAT);
      const text = JSON.stringify(request.body);
      // Never a clean or a banking descriptor, an amount, a date, an account or a key.
      for (const absent of [
        'Blue Bottle',
        'Joes',
        'CHECK',
        '-1000',
        '2026-10',
        'wp116-',
        h.userId,
      ]) {
        expect(text).not.toContain(absent);
      }
    }
    expect(sent.map((request) => merchantOf(request.body))).toEqual([
      { descriptor: 'Ebayinc', stripped_prefix: 'PAYPAL *' },
      { descriptor: 'Cko*patreon* Membership', stripped_prefix: null },
      { descriptor: 'Whlfds MKT', stripped_prefix: null },
    ]);
    const recorded = await rows();
    expect(
      recorded.map((row) => [row.normalized_key, row.status, row.display_name, row.refusal_class]),
    ).toEqual([
      ['ckopatreonmembership', 'suggested', 'Patreon Membership', null],
      ['ebayinc', 'suggested', 'Ebay', null],
      ['whlfdsmkt', 'refused', null, 'name.invented'],
    ]);
    expect(new Set(recorded.map((row) => row.llm_provider))).toEqual(new Set(['ollama']));
    // One advisor_runs row per call, its digest the one recorded.
    const runs = await h.database.db.execute<{ input_digest: string; status: string }>(
      sql`SELECT input_digest, status FROM advisor_runs WHERE advisor_id = ${MERCHANT_NAME_ADVISOR_ID} ORDER BY started_at`,
    );
    expect(runs.rows.map((row) => row.status)).toEqual(['completed', 'completed', 'completed']);
    expect(new Set(runs.rows.map((row) => row.input_digest))).toEqual(
      new Set(recorded.map((row) => row.input_digest)),
    );
    // Nothing applied: the transactions, merchants and every switch are as they were.
    expect(await watched()).toEqual(before);
  });

  it('a second pass asks nothing', async () => {
    const before = chats().length;
    await runJob();
    expect(chats().length).toBe(before);
    const result = await runMerchantNamePass(
      { database: h.database.db, runtime, switches },
      { userId: h.userId, correlationId: newId() },
    );
    expect(result).toMatchObject({ outcome: 'nothing_to_ask', asked: 0 });
    expect(chats().length).toBe(before);
  });

  it('the list shows each suggestion beside the rows of its merchant, with the provider and the model', async () => {
    const listed = await list();
    expect(listed.items.map((item) => [item.descriptor, item.displayName, item.status])).toEqual(
      expect.arrayContaining([
        ['Ebayinc', 'Ebay', 'suggested'],
        ['Cko*patreon* Membership', 'Patreon Membership', 'suggested'],
      ]),
    );
    expect(listed.items).toHaveLength(2);
    const ebay = listed.items.find((item) => item.displayName === 'Ebay');
    expect(ebay).toMatchObject({
      provider: 'ollama',
      model: `${MODEL_NAME.slice(0, 24)}@sha256:${DIGEST_HEX}`,
    });
    const feed = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    const ebayRows = (
      feed.json() as { items: { merchantId: string | null; name: string }[] }
    ).items.filter((row) => row.merchantId === ebay?.merchantId);
    expect(ebayRows).toHaveLength(3);
    expect(listed.pending).toEqual([]);
  });

  it('Accept (a session, as the manual rename) renames every row of the merchant through the overlay; the noise merchant row keeps its name', async () => {
    const { items } = await list();
    const ebay = items.find((item) => item.displayName === 'Ebay');
    const accepted = await h.request({
      method: 'POST',
      url: `/merchants/name-suggestions/${ebay?.id ?? ''}/accept`,
      session: h.stale,
    });
    expectStatus(accepted, 200);
    expect(accepted.json()).toMatchObject({ renamed: 3, suggestion: { status: 'accepted' } });
    const overlay = await h.database.db.execute<{
      user_merchant_name: string | null;
      effective_name: string;
    }>(sql`
      SELECT t.user_merchant_name, t.effective_name FROM transactions t
        JOIN transactions_provider p ON p.id = t.current_fact_id
       WHERE t.user_id = ${h.userId} AND p.name = 'PAYPAL *EBAYINC'`);
    expect(overlay.rows).toEqual([
      { user_merchant_name: 'Ebay', effective_name: 'Ebay' },
      { user_merchant_name: 'Ebay', effective_name: 'Ebay' },
      { user_merchant_name: 'Ebay', effective_name: 'Ebay' },
    ]);
    const noise = await h.database.db.execute<{ display_name: string }>(
      sql`SELECT display_name FROM merchants WHERE user_id = ${h.userId} AND normalized_key = 'ebayinc'`,
    );
    expect(noise.rows[0]?.display_name).toBe('Ebayinc');
    // The same rename by hand on another holder's view of it lands on the same merchant key.
    const feed = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    const renamed = (
      feed.json() as { items: { name: string; merchantId: string | null }[] }
    ).items.filter((row) => row.name === 'Ebay');
    expect(new Set(renamed.map((row) => row.merchantId))).toEqual(
      new Set([await merchantIdOf('ebay')]),
    );
  });

  it('Dismiss is final, and a dismissed merchant is never asked about again', async () => {
    const { items } = await list();
    const patreon = items.find((item) => item.displayName === 'Patreon Membership');
    const dismissed = await h.request({
      method: 'POST',
      url: `/merchants/name-suggestions/${patreon?.id ?? ''}/dismiss`,
      session: h.stale,
    });
    expectStatus(dismissed, 200);
    const again = await h.request({
      method: 'POST',
      url: `/merchants/name-suggestions/${patreon?.id ?? ''}/accept`,
      session: h.stale,
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe('ledger.merchant_name_suggestion_closed');
    const before = chats().length;
    await runJob();
    expect(chats().length).toBe(before);
    expect((await list()).items.map((item) => item.displayName)).toEqual(['Ebay']);
    const missing = await h.request({
      method: 'POST',
      url: `/merchants/name-suggestions/${newId()}/dismiss`,
      session: h.stale,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('a hosted narrator binds no model: the pass asks nothing and says why', async () => {
    const hosted = createMerchantNameRuntime({
      mode: 'run',
      narrator: {
        resolve: () =>
          Promise.resolve({
            provider: 'anthropic',
            narrator: { label: 'anthropic:claude-sonnet-5-5' },
            reason: null,
          } as never),
      },
      stores: createNarratorStores({
        database: h.database.db,
        secretBox: () => h.security.requireSecretBox(),
      }),
      localModel: undefined,
      timeoutMs: 1_000,
      allowRemote: false,
    });
    expect(await hosted.resolve(h.userId)).toEqual({ adapter: null, reason: 'hosted_narrator' });
    const before = chats().length;
    const result = await runMerchantNamePass(
      { database: h.database.db, runtime: hosted, switches },
      { userId: h.userId, correlationId: newId() },
    );
    expect(result).toMatchObject({ outcome: 'no_model', reason: 'hosted_narrator', asked: 0 });
    expect(chats().length).toBe(before);
  });
});
