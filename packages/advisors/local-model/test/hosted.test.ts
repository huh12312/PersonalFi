// SPDX-License-Identifier: MIT
/**
 * WP 10.6 — the hosted adapter, per provider, over the hermetic fake
 * (`fake-hosted.ts`). No vendor is called.
 */
import { guardUrl } from '@core/platform';
import { describe, expect, it } from 'vitest';
import { createLocalModelAdapter } from '../src/adapter.ts';
import { hostedNarrationFormat } from '../src/hosted-format.ts';
import {
  createHostedBudget,
  createHostedModelAdapter,
  HOSTED_MODEL_HOSTS,
  HOSTED_PROVIDERS,
  HOSTED_TIMEOUT_CEILING_MS,
  HostedModelError,
  PROBE_MESSAGES,
  redactProviderText,
  type HostedProvider,
} from '../src/hosted.ts';
import { renderPrompt } from '../src/prompt.ts';
import {
  FakeHostedTransport,
  narrationJson,
  ok,
  PRIVATE_RESOLVE,
  PUBLIC_RESOLVE,
  recordedReply,
  RejectingHostedTransport,
  SYNTHETIC_KEY,
} from './fake-hosted.ts';
import { baseRequest, MODEL_NAME, PINNED_DIGEST } from './fixtures.ts';

const MODEL: Record<HostedProvider, string> = {
  openai: 'gpt-6.1-sol',
  openrouter: 'anthropic/claude-sonnet-5.5',
  anthropic: 'claude-sonnet-5-5',
};

function capturingLogger() {
  const lines: unknown[] = [];
  return {
    lines,
    logger: {
      info: (obj: Record<string, unknown>, msg?: string) => lines.push([obj, msg]),
      warn: (obj: Record<string, unknown>, msg?: string) => lines.push([obj, msg]),
    },
  };
}

function adapterFor(
  provider: HostedProvider,
  fake: FakeHostedTransport,
  extra: { timeoutMs?: number; logger?: ReturnType<typeof capturingLogger>['logger'] } = {},
) {
  return createHostedModelAdapter(
    {
      provider,
      model: MODEL[provider],
      timeoutMs: extra.timeoutMs ?? 120_000,
      key: { reveal: () => SYNTHETIC_KEY },
    },
    {
      transport: fake.transport,
      resolve: PUBLIC_RESOLVE,
      ...(extra.logger === undefined ? {} : { logger: extra.logger }),
    },
  );
}

const signal = (): AbortSignal => new AbortController().signal;

describe.each(HOSTED_PROVIDERS)('the %s adapter', (provider) => {
  it('posts the rendered prompt to its one host, under the reply format derived from NARRATION_FORMAT', async () => {
    const fake = FakeHostedTransport.answering(provider, narrationJson());
    const adapter = adapterFor(provider, fake);
    const request = baseRequest();
    await adapter.run(request, signal());

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.host).toBe(HOSTED_MODEL_HOSTS[provider]);
    expect(call?.address).toBe('93.184.216.34');
    const rendered = renderPrompt(request);
    const body = call?.body ?? {};
    expect(body['model']).toBe(MODEL[provider]);
    expect(body['stream']).toBeUndefined();
    if (provider === 'anthropic') {
      expect(call?.path).toBe('/v1/messages');
      expect(call?.headers['x-api-key']).toBe(SYNTHETIC_KEY);
      expect(call?.headers['anthropic-version']).toBe('2023-06-01');
      expect(call?.headers['authorization']).toBeUndefined();
      expect(body['system']).toBe(rendered.messages[0]?.content);
      expect(body['messages']).toEqual([{ role: 'user', content: rendered.messages[1]?.content }]);
      expect(body['output_config']).toEqual({
        format: { type: 'json_schema', schema: hostedNarrationFormat('anthropic') },
      });
    } else {
      expect(call?.headers['authorization']).toBe(`Bearer ${SYNTHETIC_KEY}`);
      expect(body['messages']).toEqual(
        rendered.messages.map((m) => ({ role: m.role, content: m.content })),
      );
      expect(body['response_format']).toEqual({
        type: 'json_schema',
        json_schema: { name: 'narration', strict: true, schema: hostedNarrationFormat(provider) },
      });
      if (provider === 'openrouter') {
        expect(call?.path).toBe('/api/v1/chat/completions');
        expect(call?.headers['http-referer']).toBe('https://github.com/huh12312/PersonalFi');
        expect(call?.headers['x-openrouter-title']).toBe('PersonalFi');
        expect(body['provider']).toEqual({ require_parameters: true });
      } else {
        expect(call?.path).toBe('/v1/chat/completions');
        expect(call?.headers['http-referer']).toBeUndefined();
      }
    }
    // The pin: the schema sent is the derivation of NARRATION_FORMAT, which
    // `hosted-format.test.ts` reconstructs to NARRATION_FORMAT exactly.
    expect(adapter.format).toEqual(hostedNarrationFormat(provider));
  });

  it('wraps the reply with the request envelope and names provider:model in diagnostics.model', async () => {
    const fake = FakeHostedTransport.answering(
      provider,
      JSON.stringify({
        ...JSON.parse(narrationJson()),
        request_id: 'forged',
        advisor_id: 'forged',
      }),
    );
    const request = baseRequest();
    const response = (await adapterFor(provider, fake).run(request, signal())) as Record<
      string,
      unknown
    >;
    expect(response['request_id']).toBe(request.request_id);
    expect(response['advisor_id']).toBe(request.advisor_id);
    expect(response['advisor_version']).toBe(request.advisor_version);
    const diagnostics = response['diagnostics'] as Record<string, unknown>;
    expect(diagnostics['model']).toBe(`${provider}:${MODEL[provider]}`);
    expect(diagnostics['warnings']).toContain(
      'model reply carried 2 top-level field(s) besides insights; ignored',
    );
    expect(response['insights']).toEqual(JSON.parse(narrationJson())['insights']);
  });

  it('egress: the policy allows exactly its own host over https:443, and a private DNS answer is refused before any call', async () => {
    const fake = FakeHostedTransport.answering(provider, narrationJson());
    const adapter = adapterFor(provider, fake);
    expect(adapter.policy.allowedHosts).toEqual([HOSTED_MODEL_HOSTS[provider]]);
    for (const other of Object.values(HOSTED_MODEL_HOSTS).filter((h) => h !== adapter.host)) {
      const decision = await guardUrl(`https://${other}/v1/x`, adapter.policy, PUBLIC_RESOLVE);
      expect(decision.ok, other).toBe(false);
    }
    expect((await guardUrl('https://evil.example/v1', adapter.policy, PUBLIC_RESOLVE)).ok).toBe(
      false,
    );
    expect((await guardUrl(`http://${adapter.host}/v1`, adapter.policy, PUBLIC_RESOLVE)).ok).toBe(
      false,
    );

    const rebinding = createHostedModelAdapter(
      { provider, model: MODEL[provider], timeoutMs: 1_000, key: { reveal: () => SYNTHETIC_KEY } },
      { transport: fake.transport, resolve: PRIVATE_RESOLVE },
    );
    await expect(rebinding.run(baseRequest(), signal())).rejects.toMatchObject({
      code: 'endpoint_refused',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['unauthorized', 'key_rejected', 401],
    ['rate_limited', 'provider_rate_limited', 429],
    ['schema_refused', 'request_refused', 400],
    ['down', 'model_unavailable', 503],
    ['redirect', 'endpoint_refused', 307],
  ] as const)(
    'a %s answer is %s, with the status and never the provider prose',
    async (mode, code, status) => {
      const fake = new RejectingHostedTransport(provider, mode, SYNTHETIC_KEY);
      const error = await adapterFor(provider, fake)
        .run(baseRequest(), signal())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostedModelError);
      expect((error as HostedModelError).code).toBe(code);
      expect((error as HostedModelError).status).toBe(status);
      expect((error as Error).message).not.toContain(SYNTHETIC_KEY);
      expect((error as Error).message).not.toContain('Incorrect API key');
    },
  );

  it('a provider error that echoes the key is logged redacted; no logger argument carries the key', async () => {
    const { lines, logger } = capturingLogger();
    const fake = new RejectingHostedTransport(provider, 'unauthorized', SYNTHETIC_KEY);
    await adapterFor(provider, fake, { logger })
      .run(baseRequest(), signal())
      .catch(() => undefined);
    const logged = JSON.stringify(lines);
    expect(logged).toContain('Incorrect API key provided: [REDACTED]');
    expect(logged).not.toContain(SYNTHETIC_KEY);
    expect(logged).not.toContain('wp106-synthetic');
  });

  it('a declined answer is model_refused; a body outside the documented shape is model_protocol_error', async () => {
    const refusing = new FakeHostedTransport(() =>
      ok(recordedReply(provider, '', { refused: true })),
    );
    await expect(adapterFor(provider, refusing).run(baseRequest(), signal())).rejects.toMatchObject(
      {
        code: 'model_refused',
      },
    );
    const odd = new FakeHostedTransport(() => ok(JSON.stringify({ unexpected: true })));
    await expect(adapterFor(provider, odd).run(baseRequest(), signal())).rejects.toMatchObject({
      code: 'model_protocol_error',
    });
  });

  it('timeout: a provider that never answers ends at the configured timeout, and the socket is told to close', async () => {
    let seen: AbortSignal | undefined;
    const hanging = new FakeHostedTransport(() => new Promise(() => undefined));
    const fake = Object.assign(Object.create(hanging) as FakeHostedTransport, {
      transport: (request: Parameters<FakeHostedTransport['transport']>[0]) => {
        seen = request.signal;
        return new Promise<never>((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('socket destroyed')));
        });
      },
    });
    const started = Date.now();
    await expect(
      adapterFor(provider, fake, { timeoutMs: 50 }).run(baseRequest(), signal()),
    ).rejects.toMatchObject({ code: 'model_timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen?.aborted).toBe(true);
  });

  it('the caller’s signal (a kill switch) reaches the socket: aborted, not a timeout', async () => {
    const controller = new AbortController();
    const fake = Object.assign(
      Object.create(FakeHostedTransport.prototype) as FakeHostedTransport,
      {
        calls: [],
        transport: (request: { signal?: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('socket destroyed')));
            setTimeout(() => controller.abort(), 5);
          }),
      },
    );
    await expect(
      adapterFor(provider, fake, { timeoutMs: 60_000 }).run(baseRequest(), controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('the timeout ceiling is the local model’s 300 s: a longer one is refused at construction', () => {
    expect(() =>
      createHostedModelAdapter({
        provider,
        model: MODEL[provider],
        timeoutMs: HOSTED_TIMEOUT_CEILING_MS + 1,
        key: { reveal: () => SYNTHETIC_KEY },
      }),
    ).toThrow(RangeError);
  });

  it('the budget window: a spent window sends nothing', async () => {
    const fake = FakeHostedTransport.answering(provider, narrationJson());
    const adapter = createHostedModelAdapter(
      { provider, model: MODEL[provider], timeoutMs: 1_000, key: { reveal: () => SYNTHETIC_KEY } },
      {
        transport: fake.transport,
        resolve: PUBLIC_RESOLVE,
        budget: createHostedBudget({ maxRequests: 1, windowMs: 60_000 }),
      },
    );
    await adapter.run(baseRequest(), signal());
    await expect(adapter.run(baseRequest(), signal())).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('the probe sends PROBE_MESSAGES and nothing from any snapshot, and reports the round trip', async () => {
    const fake = FakeHostedTransport.answering(provider, '{"insights": []}');
    const result = await adapterFor(provider, fake).probe(signal());
    expect(result).toMatchObject({ provider, outcome: 'ok', status: 200, replyShaped: true });
    const body = JSON.stringify(fake.calls[0]?.body);
    for (const message of PROBE_MESSAGES)
      expect(body).toContain(JSON.stringify(message.content).slice(1, -1));
    expect(body).not.toContain('House deposit');
    expect(body).not.toContain('MERCHANT_');

    const refused = await adapterFor(
      provider,
      new RejectingHostedTransport(provider, 'unauthorized'),
    ).probe(signal());
    expect(refused).toMatchObject({ outcome: 'key_rejected', status: 401, replyShaped: false });
  });
});

describe('the egress allow-list', () => {
  it('names exactly the three vendors’ API hosts, one per adapter', () => {
    expect(HOSTED_MODEL_HOSTS).toEqual({
      openai: 'api.openai.com',
      openrouter: 'openrouter.ai',
      anthropic: 'api.anthropic.com',
    });
    expect(new Set(Object.values(HOSTED_MODEL_HOSTS)).size).toBe(3);
  });
});

describe('approval shapes', () => {
  it('the template hash differs per provider and per model, and from the local model’s', () => {
    const hashes = new Set<string>();
    for (const provider of HOSTED_PROVIDERS) {
      for (const model of ['a-model', 'b-model']) {
        hashes.add(
          createHostedModelAdapter({
            provider,
            model,
            timeoutMs: 1_000,
            key: { reveal: () => 'x' },
          }).promptTemplateHash,
        );
      }
    }
    const local = createLocalModelAdapter(
      {
        endpoint: '',
        name: MODEL_NAME,
        digest: PINNED_DIGEST,
        timeoutMs: 1_000,
        allowRemote: false,
      },
      { transport: { request: () => Promise.reject(new Error('unused')) } },
    );
    hashes.add(local.promptTemplateHash);
    expect(hashes.size).toBe(7);
    expect(local.promptRenderer.provider).toBe('ollama');
  });
});

describe('redactProviderText', () => {
  it('removes every held secret, any sk-… token and any bearer value, and caps the text', () => {
    const text = `bad key ${SYNTHETIC_KEY} and sk-proj-abcdefghij1234 and Bearer abc.def ${'x'.repeat(400)}`; // gitleaks:allow — synthetic
    const out = redactProviderText(text, [SYNTHETIC_KEY]);
    expect(out).not.toContain(SYNTHETIC_KEY);
    expect(out).not.toContain('sk-proj-abcdefghij1234'); // gitleaks:allow — synthetic
    expect(out).not.toContain('abc.def');
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
