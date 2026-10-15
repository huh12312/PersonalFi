// SPDX-License-Identifier: MIT
/**
 * WP 10.6 (D30) — Settings, Language model, end to end against Postgres.
 *
 * The Test button's hosted probe goes through the real hosted adapter over
 * the hermetic vendor fake (`narratorTransport`, the network seam): no vendor
 * is called. Every key below is synthetic and distinctive, so an absence
 * assertion cannot pass by accident.
 */
import {
  FakeHostedTransport,
  fakeHostedOk,
  recordedReply,
  vendorError,
  type RecordedHostedCall,
} from '@advisor/local-model/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { narratorConsentSha256, NARRATOR_CONSENT_VERSION } from '../../src/narrator-consent.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const ANTHROPIC_KEY = 'sk-ant-canaryWP106anthropic00000000000000wxyz'; // gitleaks:allow — synthetic canary, not a credential
const OPENAI_KEY = 'sk-canaryWP106openai0000000000000000000000q7zk'; // gitleaks:allow — synthetic canary, not a credential
const REJECTED_KEY = 'sk-rejected-canaryWP106000000000000000000001'; // gitleaks:allow — synthetic canary, not a credential
const FILE_KEY = 'sk-file-canaryWP106operator0000000000000003'; // gitleaks:allow — synthetic canary, not a credential

const NO_SESSION = { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false };

function responder(call: RecordedHostedCall) {
  const carried = JSON.stringify(call.headers);
  const provider =
    call.host === 'api.anthropic.com'
      ? 'anthropic'
      : call.host === 'openrouter.ai'
        ? 'openrouter'
        : 'openai';
  if (carried.includes('rejected-canary')) {
    // A vendor that echoes the key it refused: the redaction must hold.
    return fakeHostedOk(vendorError(provider, `invalid x-api-key ${REJECTED_KEY}`), 401);
  }
  return fakeHostedOk(recordedReply(provider, '{"insights": []}'));
}

describe.skipIf(NO_DATABASE)('Settings, Language model (WP 10.6)', () => {
  let h: ApiHarness;
  let logs = '';
  const logStream = { write: (chunk: string) => void (logs += chunk) };
  const fake = new FakeHostedTransport(responder);

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp106lm',
      narratorTransport: fake.transport,
      logStream,
      env: { LOG_LEVEL: 'trace' },
    });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  const get = () => h.request({ method: 'GET', url: '/narrator/settings', session: h.stale });
  const setActive = (activeProvider: string, session = h.fresh) =>
    h.request({ method: 'PUT', url: '/narrator/settings', session, body: { activeProvider } });
  const putKey = (provider: string, key: string, session = h.fresh) =>
    h.request({
      method: 'PUT',
      url: `/narrator/providers/${provider}/credentials`,
      session,
      body: { key },
    });
  const consent = (
    provider: string,
    consentVersion = NARRATOR_CONSENT_VERSION,
    session = h.fresh,
  ) =>
    h.request({
      method: 'PUT',
      url: `/narrator/providers/${provider}/consent`,
      session,
      body: { consentVersion },
    });
  const test = (provider: string) =>
    h.request({ method: 'POST', url: `/narrator/providers/${provider}/test`, session: h.stale });

  type Settings = {
    activeProvider: string;
    active: { provider: string; label: string | null; ready: boolean; notReady: string | null };
    providers: Array<{
      provider: string;
      host: string | null;
      key: { source: string; hint: string | null };
      model: { value: string | null; default: string | null; locked: boolean };
      consent: { given: boolean; text: string } | null;
      ready: boolean;
      notReady: string | null;
    }>;
    approvalsRevoked?: number;
  };
  const provider = (body: Settings, name: string) =>
    body.providers.find((p) => p.provider === name);

  async function auditRows(like: string) {
    const result = await h.database.pool.query<{
      kind: string;
      outcome: string;
      detail: Record<string, unknown>;
    }>(
      'SELECT kind, outcome, detail FROM security_events WHERE kind LIKE $1 ORDER BY occurred_at, id',
      [like],
    );
    return result.rows;
  }

  it('another holder’s key and consent are never this holder’s', async () => {
    const other = await h.database.createUser('WP 10.6 second holder');
    const { setLanguageModelKey } = await import('@ctx/connections');
    const { giveNarratorConsent } = await import('@ctx/insights');
    const { newId, systemClock } = await import('@core/kernel');
    await h.database.db.transaction(async (tx) => {
      await setLanguageModelKey(
        tx,
        {
          provider: 'openrouter',
          key: OPENAI_KEY.replace('openai', 'otherx'),
          secretBox: h.security.requireSecretBox(),
        },
        { userId: other, clock: systemClock, correlationId: newId() },
      );
      await giveNarratorConsent(
        tx,
        { userId: other, clock: systemClock, correlationId: newId() },
        {
          provider: 'openrouter',
          consentTextVersion: NARRATOR_CONSENT_VERSION,
          consentTextSha256: narratorConsentSha256('openrouter'),
        },
      );
    });
    const body = (await get()).json() as Settings;
    expect(provider(body, 'openrouter')).toMatchObject({
      key: { source: 'none' },
      consent: { given: false },
    });
  });

  it('GET shows every provider with no key and the consent text; nothing narrates with nothing configured', async () => {
    const response = await get();
    expectStatus(response, 200);
    const body = response.json() as Settings;
    expect(body.activeProvider).toBe('ollama');
    expect(body.active).toMatchObject({
      provider: 'ollama',
      ready: false,
      notReady: 'not_configured',
    });
    expect(body.providers.map((p) => p.provider)).toEqual([
      'ollama',
      'openai',
      'openrouter',
      'anthropic',
    ]);
    expect(provider(body, 'anthropic')).toMatchObject({
      host: 'api.anthropic.com',
      key: { source: 'none', hint: null },
      model: { value: 'claude-sonnet-5-5', default: 'claude-sonnet-5-5', locked: false },
      consent: { given: false },
      ready: false,
      notReady: 'consent_required',
    });
    expect(provider(body, 'anthropic')?.consent?.text).toContain(
      'Brief findings: aggregated amounts, bucketed, merchants pseudonymised — never a transaction, never an account number',
    );
    expect(provider(body, 'openai')?.host).toBe('api.openai.com');
    expect(provider(body, 'openrouter')?.host).toBe('openrouter.ai');
    // No session: 401.
    expect(
      (await h.request({ method: 'GET', url: '/narrator/settings', session: NO_SESSION }))
        .statusCode,
    ).toBe(401);
  });

  it('a key: Save needs a fresh step-up, is sealed, shows only its last four characters, and is never returned', async () => {
    expect((await putKey('anthropic', ANTHROPIC_KEY, h.stale)).statusCode).toBe(403);
    expect((await putKey('anthropic', 'short-key')).statusCode).toBe(400);
    const saved = await putKey('anthropic', ANTHROPIC_KEY);
    expectStatus(saved, 200);
    expect(provider(saved.json() as Settings, 'anthropic')?.key).toMatchObject({
      source: 'stored',
      hint: 'wxyz',
    });
    expect(saved.body).not.toContain(ANTHROPIC_KEY);
    expect((await get()).body).not.toContain(ANTHROPIC_KEY);
    const row = await h.database.pool.query<{
      secret_sealed: Buffer;
      client_id_hint: string;
      env: string | null;
    }>(
      "SELECT secret_sealed, client_id_hint, env FROM provider_credentials WHERE provider = 'anthropic'",
    );
    expect(row.rows[0]?.client_id_hint).toBe('wxyz');
    expect(row.rows[0]?.env).toBeNull();
    expect(row.rows[0]?.secret_sealed.includes(Buffer.from(ANTHROPIC_KEY))).toBe(false);
    expectStatus(await putKey('anthropic', ANTHROPIC_KEY), 200);
    const audit = await auditRows('provider_credentials.%');
    expect(audit.map((r) => [r.kind, r.detail])).toEqual([
      ['provider_credentials.set', { provider: 'anthropic' }],
      ['provider_credentials.rotated', { provider: 'anthropic' }],
    ]);
  });

  it('the consent gate: a hosted provider cannot be made active until its consent is ticked, against the current text', async () => {
    const refused = await setActive('anthropic');
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused)['code']).toBe('narrator.consent_required');
    expect((await get()).json()).toMatchObject({ activeProvider: 'ollama' });

    const stale = await consent('anthropic', 'narrator-consent/0');
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale)['code']).toBe('narrator.consent_version_unknown');
    expect((await consent('anthropic', NARRATOR_CONSENT_VERSION, h.stale)).statusCode).toBe(403);

    expectStatus(await consent('anthropic'), 200);
    const active = await setActive('anthropic');
    expectStatus(active, 200);
    expect(active.json()).toMatchObject({
      activeProvider: 'anthropic',
      active: { provider: 'anthropic', label: 'anthropic:claude-sonnet-5-5', ready: true },
    });
    const consents = await h.database.pool.query<{
      consent_text_version: string;
      consent_text_sha256: string;
    }>(
      "SELECT consent_text_version, consent_text_sha256 FROM narrator_provider_consents WHERE provider = 'anthropic' AND withdrawn_at IS NULL",
    );
    expect(consents.rows).toEqual([
      {
        consent_text_version: NARRATOR_CONSENT_VERSION,
        consent_text_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    ]);
    const changed = await auditRows('narrator.%');
    expect(changed.filter((r) => r.outcome === 'success').map((r) => r.detail)).toContainEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
    expect(JSON.stringify(changed)).not.toContain(ANTHROPIC_KEY);
  });

  it('a hosted provider with a consent and no key is refused narrator.key_required', async () => {
    expectStatus(await consent('openai'), 200);
    const refused = await setActive('openai');
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused)['code']).toBe('narrator.key_required');
  });

  it('switching to another hosted provider revokes the narrator’s approval; re-approving records the new provider and model', async () => {
    // Anthropic is active (above). Approve its payload through the product.
    const preview = await h.request({
      method: 'GET',
      url: '/advisors/local.narrator/payload-preview',
      session: h.stale,
    });
    expectStatus(preview, 200);
    const shape = (preview.json() as { queryShape: string; prompt: { text: string } | null })
      .queryShape;
    expectStatus(
      await h.request({
        method: 'POST',
        url: '/advisors/local.narrator/payload-approvals',
        session: h.fresh,
        body: { queryShape: shape },
      }),
      200,
    );
    let approvals = await h.database.pool.query<{
      llm_provider: string;
      llm_model: string;
      revoked_at: Date | null;
    }>(
      "SELECT llm_provider, llm_model, revoked_at FROM advisor_payload_approvals WHERE advisor_id = 'local.narrator'",
    );
    expect(approvals.rows).toEqual([
      { llm_provider: 'anthropic', llm_model: 'anthropic:claude-sonnet-5-5', revoked_at: null },
    ]);

    expectStatus(await putKey('openai', OPENAI_KEY), 200);
    const switched = await setActive('openai');
    expectStatus(switched, 200);
    expect((switched.json() as Settings).approvalsRevoked).toBe(1);
    const after = await h.request({
      method: 'GET',
      url: '/advisors/local.narrator/payload-preview',
      session: h.stale,
    });
    const next = after.json() as { queryShape: string; approved: boolean };
    expect(next.approved).toBe(false);
    expect(next.queryShape).not.toBe(shape);
    expectStatus(
      await h.request({
        method: 'POST',
        url: '/advisors/local.narrator/payload-approvals',
        session: h.fresh,
        body: { queryShape: next.queryShape },
      }),
      200,
    );
    approvals = await h.database.pool.query(
      "SELECT llm_provider, llm_model, revoked_at FROM advisor_payload_approvals WHERE advisor_id = 'local.narrator' AND revoked_at IS NULL",
    );
    expect(approvals.rows).toEqual([
      { llm_provider: 'openai', llm_model: 'openai:gpt-6.1-sol', revoked_at: null },
    ]);

    // A model change of the active provider is a new approval too.
    const model = await h.request({
      method: 'PUT',
      url: '/narrator/providers/openai/model',
      session: h.fresh,
      body: { model: 'gpt-6-luna' },
    });
    expectStatus(model, 200);
    expect(model.json()).toMatchObject({
      approvalsRevoked: 1,
      active: { label: 'openai:gpt-6-luna' },
    });
    expect(
      (
        await h.request({
          method: 'PUT',
          url: '/narrator/providers/openai/model',
          session: h.fresh,
          body: { model: 'bad model; id' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('Test: a fixed probe, the round trip in words; a refused key is named without the provider’s prose; one per 20 s', async () => {
    const before = fake.calls.length;
    const ok = await test('openai');
    expectStatus(ok, 200);
    expect(ok.json()).toMatchObject({
      provider: 'openai',
      model: 'gpt-6-luna',
      outcome: 'ok',
      ok: true,
      status: 200,
    });
    expect((ok.json() as { message: string }).message).toMatch(
      /^OpenAI answered in \d+ ms with gpt-6-luna, in the narration's reply format/u,
    );
    const call = fake.calls[before];
    expect(call?.host).toBe('api.openai.com');
    expect(JSON.stringify(call?.body)).toContain('connectivity check');

    const again = await test('openai');
    expect(again.statusCode).toBe(409);
    expect(problemOf(again)['code']).toBe('narrator.test_too_soon');

    expectStatus(await putKey('openrouter', REJECTED_KEY), 200);
    const refused = await test('openrouter');
    expect(refused.json()).toMatchObject({ outcome: 'key_rejected', ok: false, status: 401 });
    expect(refused.body).not.toContain(REJECTED_KEY);
    expect(refused.body).not.toContain('invalid x-api-key');

    const local = await test('ollama');
    expect(local.json()).toMatchObject({ outcome: 'not_configured', ok: false });
  });

  it('withdrawing the active provider’s consent turns the narrator off; Off configures nothing', async () => {
    expectStatus(await consent('anthropic'), 200);
    expectStatus(await setActive('anthropic'), 200);
    const withdrawn = await h.request({
      method: 'DELETE',
      url: '/narrator/providers/anthropic/consent',
      session: h.fresh,
    });
    expectStatus(withdrawn, 200);
    expect(withdrawn.json()).toMatchObject({
      activeProvider: 'off',
      active: { notReady: 'off', ready: false },
    });
    const kind = await h.request({
      method: 'GET',
      url: '/advisors/kinds/local_model/enabled',
      session: h.stale,
    });
    expect(kind.json()).toMatchObject({ configured: false, effective: false });
    const preview = await h.request({
      method: 'GET',
      url: '/advisors/local.narrator/payload-preview',
      session: h.stale,
    });
    expect(preview.statusCode).toBe(503);
  });

  it('an Ollama endpoint set here must pass the local-endpoint policy, and needs a step-up', async () => {
    const digest = `sha256:${'8'.repeat(64)}`;
    const body = { endpoint: 'http://ollama:11434', model: 'qwen2.5:7b-instruct-q4_K_M', digest };
    expect(
      (
        await h.request({
          method: 'PUT',
          url: '/narrator/providers/ollama/endpoint',
          session: h.stale,
          body,
        })
      ).statusCode,
    ).toBe(403);
    const remote = await h.request({
      method: 'PUT',
      url: '/narrator/providers/ollama/endpoint',
      session: h.fresh,
      body: { ...body, endpoint: 'https://ollama.example.com' },
    });
    expect(remote.statusCode).toBe(422);
    expect(problemOf(remote)['code']).toBe('narrator.endpoint_refused');
    const saved = await h.request({
      method: 'PUT',
      url: '/narrator/providers/ollama/endpoint',
      session: h.fresh,
      body,
    });
    expectStatus(saved, 200);
    expect(provider(saved.json() as Settings, 'ollama')).toMatchObject({
      ready: true,
      model: { value: 'qwen2.5:7b-instruct-q4_K_M' },
    });
    expectStatus(await setActive('ollama'), 200);
    expect((await get()).json()).toMatchObject({ active: { provider: 'ollama', ready: true } });
  });

  it('a key never reaches a log line, on any path', () => {
    for (const key of [ANTHROPIC_KEY, OPENAI_KEY, REJECTED_KEY]) {
      expect(logs.includes(key), `a log line contains ${key.slice(0, 12)}…`).toBe(false);
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe.skipIf(NO_DATABASE)('Settings, Language model: the operator’s file wins (WP 10.6)', () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp106lmfile',
      extraSecrets: { anthropic_api_key: FILE_KEY },
    });
  }, 180_000);
  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('GET says file with no hint, and PUT is refused rather than stored and silently ignored', async () => {
    const body = (
      await h.request({ method: 'GET', url: '/narrator/settings', session: h.stale })
    ).json() as {
      providers: Array<{ provider: string; key: { source: string; hint: string | null } }>;
    };
    expect(body.providers.find((p) => p.provider === 'anthropic')?.key).toMatchObject({
      source: 'file',
      hint: null,
    });
    const refused = await h.request({
      method: 'PUT',
      url: '/narrator/providers/anthropic/credentials',
      session: h.fresh,
      body: { key: ANTHROPIC_KEY },
    });
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused)['code']).toBe('provider_credentials.managed_by_files');
    const rows = await h.database.pool.query(
      "SELECT 1 FROM provider_credentials WHERE provider = 'anthropic'",
    );
    expect(rows.rowCount).toBe(0);
    expect(JSON.stringify(body)).not.toContain(FILE_KEY);
  });
});
