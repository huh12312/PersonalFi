// SPDX-License-Identifier: MIT
/**
 * WP 10.6 — `createNarratorRuntime`, the one place a holder's settings become
 * a narrator, over in-memory stores and the hermetic vendor fake. No database,
 * no vendor.
 */
import {
  FakeHostedTransport,
  narrationJson,
  PUBLIC_RESOLVE,
  SYNTHETIC_KEY,
} from '@advisor/local-model/test';
import { hostedNarrationFormat } from '@advisor/local-model';
import { describe, expect, it, vi } from 'vitest';
import {
  createNarratorRuntime,
  createNarratorWiring,
  NARRATOR_CACHE_TTL_MS,
  type NarratorRuntimeOptions,
  type NarratorSettingsSnapshot,
  type NarratorStores,
} from '../src/narrator-wiring.ts';

const DIGEST = `sha256:${'845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e'}`;
const LOCAL = {
  endpoint: 'ollama:11434',
  name: 'qwen2.5:7b-instruct-q4_K_M',
  digest: DIGEST,
  timeoutMs: 180_000,
  allowRemote: false,
};
const FILE_KEY = 'sk-file-wp106-synthetic-operator-key-0002'; // gitleaks:allow — synthetic

function snapshot(overrides: Partial<NarratorSettingsSnapshot> = {}): NarratorSettingsSnapshot {
  return {
    activeProvider: 'ollama',
    hasRow: false,
    models: {},
    ollama: null,
    consented: new Set(),
    ...overrides,
  };
}

function stores(
  settings: NarratorSettingsSnapshot,
  keys: Partial<Record<string, string>> = {},
): NarratorStores & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    settings: () => {
      reads.push('settings');
      return Promise.resolve(settings);
    },
    storedKey: (_userId, provider) => {
      reads.push(`key:${provider}`);
      const key = keys[provider];
      return Promise.resolve(key === undefined ? null : { reveal: () => key });
    },
  };
}

function runtime(
  store: NarratorStores,
  extra: Partial<NarratorRuntimeOptions> = {},
): ReturnType<typeof createNarratorRuntime> {
  return createNarratorRuntime({
    mode: 'run',
    stores: store,
    localModel: undefined,
    timeoutMs: 180_000,
    allowRemote: false,
    fileKeys: {},
    resolve: PUBLIC_RESOLVE,
    ...extra,
  });
}

function wellFormedRequest() {
  return {
    contract_version: 1,
    request_id: '01930000-0000-7000-8000-00000000f003',
    advisor_id: 'local.narrator',
    advisor_version: '1.0.0',
    kind: 'local_model',
    base_currency: 'USD',
    time_zone: 'UTC',
    today: '2026-10-15',
    granted_scopes: [],
    input_digest: `sha256:${'c'.repeat(64)}`,
    limits: { max_insights: 5, max_response_bytes: 131_072, deadline: '2099-01-01T00:00:00Z' },
    snapshot: {},
  } as never;
}

describe('createNarratorRuntime', () => {
  it('with no settings row it is today’s behaviour: the environment’s local model, else nothing', async () => {
    const none = await runtime(stores(snapshot())).resolve('u1');
    expect(none).toEqual({ provider: 'ollama', narrator: null, reason: 'not_configured' });

    const env = await runtime(stores(snapshot()), { localModel: LOCAL }).forUser('u1');
    expect(env?.provider).toBe('ollama');
    expect(env?.label).toBe(`${LOCAL.name}@${DIGEST}`);
    // The same renderer the worker built before WP 10.6, through the same function.
    const before = createNarratorWiring(LOCAL);
    expect(env?.renderer.templateHash).toBe(before?.localModel.promptRenderer.templateHash);
  });

  it('Off is no narrator, and says so', async () => {
    const off = await runtime(stores(snapshot({ activeProvider: 'off', hasRow: true })), {
      localModel: LOCAL,
    }).resolve('u1');
    expect(off).toEqual({ provider: 'off', narrator: null, reason: 'off' });
  });

  it('a hosted provider needs a consent, then a key; with both it narrates as provider:model', async () => {
    const unconsented = await runtime(
      stores(snapshot({ activeProvider: 'anthropic', hasRow: true }), { anthropic: SYNTHETIC_KEY }),
    ).resolve('u1');
    expect(unconsented.reason).toBe('consent_required');

    const keyless = await runtime(
      stores(
        snapshot({ activeProvider: 'anthropic', hasRow: true, consented: new Set(['anthropic']) }),
      ),
    ).resolve('u1');
    expect(keyless.reason).toBe('key_missing');

    const fake = FakeHostedTransport.answering('anthropic', narrationJson());
    const ready = await runtime(
      stores(
        snapshot({ activeProvider: 'anthropic', hasRow: true, consented: new Set(['anthropic']) }),
        { anthropic: SYNTHETIC_KEY },
      ),
      { hostedTransport: fake.transport },
    ).forUser('u1');
    expect(ready).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      label: 'anthropic:claude-sonnet-5-5',
      keySource: 'stored',
    });
    expect(ready?.renderer.provider).toBe('anthropic');
  });

  it('a non-empty operator file wins over a stored key, and the stored key is not even read', async () => {
    const store = stores(
      snapshot({ activeProvider: 'openai', hasRow: true, consented: new Set(['openai']) }),
      { openai: SYNTHETIC_KEY },
    );
    const fake = FakeHostedTransport.answering('openai', narrationJson());
    const narrator = await runtime(store, {
      fileKeys: { openai: { reveal: () => FILE_KEY } },
      hostedTransport: fake.transport,
    }).forUser('u1');
    expect(narrator?.keySource).toBe('file');
    expect(store.reads).not.toContain('key:openai');
    await narrator?.model.run(
      {
        contract_version: 1,
        request_id: '01930000-0000-7000-8000-00000000f001',
        advisor_id: 'local.narrator',
        advisor_version: '1.0.0',
        kind: 'local_model',
        base_currency: 'USD',
        time_zone: 'UTC',
        today: '2026-10-15',
        granted_scopes: [],
        input_digest: `sha256:${'a'.repeat(64)}`,
        limits: { max_insights: 5, max_response_bytes: 131_072, deadline: '2099-01-01T00:00:00Z' },
        snapshot: {},
      } as never,
      new AbortController().signal,
    );
    expect(fake.calls[0]?.headers['authorization']).toBe(`Bearer ${FILE_KEY}`);
  });

  it('a stored model id is used; none means the provider’s default', async () => {
    const fake = FakeHostedTransport.answering('openrouter', narrationJson());
    const narrator = await runtime(
      stores(
        snapshot({
          activeProvider: 'openrouter',
          hasRow: true,
          consented: new Set(['openrouter']),
          models: { openrouter: 'openai/gpt-6.1-sol' },
        }),
        { openrouter: SYNTHETIC_KEY },
      ),
      { hostedTransport: fake.transport },
    ).forUser('u1');
    expect(narrator?.label).toBe('openrouter:openai/gpt-6.1-sol');
  });

  it('the api’s preview runtime renders exactly what the worker’s run runtime will, and can call nothing', async () => {
    const settings = snapshot({
      activeProvider: 'anthropic',
      hasRow: true,
      consented: new Set(['anthropic']),
    });
    const fake = FakeHostedTransport.answering('anthropic', narrationJson());
    const run = await runtime(stores(settings, { anthropic: SYNTHETIC_KEY }), {
      hostedTransport: fake.transport,
    }).forUser('u1');
    const preview = await runtime(stores(settings, { anthropic: SYNTHETIC_KEY }), {
      mode: 'preview',
      hostedTransport: fake.transport,
    }).forUser('u1');
    // An approval keyed by the api's renderer is the shape the worker's run computes.
    expect(preview?.renderer.templateHash).toBe(run?.renderer.templateHash);
    expect(preview?.renderer.model).toBe(run?.renderer.model);
    // A well-formed request (a malformed one would reject before any socket):
    // the preview runtime's transport refuses, so the vendor fake is never reached.
    await expect(
      preview?.model.run(wellFormedRequest(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(fake.calls).toHaveLength(0);
    // …while the run runtime, over the same fake, does reach it.
    await run?.model.run(wellFormedRequest(), new AbortController().signal);
    expect(fake.calls).toHaveLength(1);

    const localPreview = await runtime(stores(snapshot()), {
      mode: 'preview',
      localModelPin: { name: LOCAL.name, digest: DIGEST },
    }).forUser('u1');
    const localRun = await runtime(stores(snapshot()), { localModel: LOCAL }).forUser('u1');
    expect(localPreview?.renderer.templateHash).toBe(localRun?.renderer.templateHash);
    expect(localPreview?.renderer.model).toBe(localRun?.renderer.model);
  });

  it('caches 30 s per holder; invalidate() (a consumer saw a change) drops it at once', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const clock = { now: () => new Date(now), nowMs: () => now };
      let settings = snapshot();
      const store: NarratorStores & { count: number } = {
        count: 0,
        settings() {
          store.count += 1;
          return Promise.resolve(settings);
        },
        storedKey: () => Promise.resolve(null),
      };
      const r = runtime(store, { localModel: LOCAL, clock: clock as never });
      expect((await r.forUser('u1'))?.provider).toBe('ollama');
      settings = snapshot({ activeProvider: 'off', hasRow: true });
      expect((await r.forUser('u1'))?.provider).toBe('ollama');
      expect(store.count).toBe(1);
      now += NARRATOR_CACHE_TTL_MS + 1;
      expect(await r.forUser('u1')).toBeNull();
      expect(store.count).toBe(2);
      settings = snapshot();
      const before = r.generation();
      r.invalidate();
      expect(r.generation()).toBe(before + 1);
      expect((await r.forUser('u1'))?.provider).toBe('ollama');
      expect(store.count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a local model set in Settings that the local-endpoint policy refuses is not configured, not a crash', async () => {
    const refused = await runtime(
      stores(
        snapshot({
          hasRow: true,
          ollama: { endpoint: 'https://ollama.example.com', name: LOCAL.name, digest: DIGEST },
        }),
      ),
    ).resolve('u1');
    expect(refused.reason).toBe('endpoint_refused');
  });

  it('the hosted reply format the runtime sends is derived from NARRATION_FORMAT', async () => {
    const fake = FakeHostedTransport.answering('openai', narrationJson());
    const narrator = await runtime(
      stores(snapshot({ activeProvider: 'openai', hasRow: true, consented: new Set(['openai']) }), {
        openai: SYNTHETIC_KEY,
      }),
      { hostedTransport: fake.transport },
    ).forUser('u1');
    await narrator?.model.run(
      {
        contract_version: 1,
        request_id: '01930000-0000-7000-8000-00000000f002',
        advisor_id: 'local.narrator',
        advisor_version: '1.0.0',
        kind: 'local_model',
        base_currency: 'USD',
        time_zone: 'UTC',
        today: '2026-10-15',
        granted_scopes: [],
        input_digest: `sha256:${'b'.repeat(64)}`,
        limits: { max_insights: 5, max_response_bytes: 131_072, deadline: '2099-01-01T00:00:00Z' },
        snapshot: {},
      } as never,
      new AbortController().signal,
    );
    const format = (fake.calls[0]?.body['response_format'] as { json_schema: { schema: unknown } })
      .json_schema.schema;
    expect(format).toEqual(hostedNarrationFormat('openai'));
  });
});
