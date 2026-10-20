// SPDX-License-Identifier: MIT
/**
 * WP 10.16 — the adapters' reach for the GenAI controls self-test: the fixed
 * control probes (the narration's own render plus one constant instruction),
 * the abort counter the level-4 check reads, the egress policy as a pure
 * classifier (never a DNS lookup, never a connect), the window, and the local
 * model's pin. Hermetic: the hosted fake and the local fake server.
 */
import { fixedClock, systemClock } from '@core/kernel';
import { createLocalEndpointPolicy, createLocalEndpointTransport } from '@core/platform';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROL_PROBE_IDS,
  CONTROL_PROBE_INSTRUCTIONS,
  CONTROL_PROBE_NUMBER,
  createHostedBudget,
  createHostedModelAdapter,
  createLocalModelAdapter,
  HOSTED_PROVIDERS,
  renderPrompt,
  withControlInstruction,
  type HostedProvider,
} from '../src/index.ts';
import {
  FakeHostedTransport,
  narrationJson,
  ok,
  PUBLIC_RESOLVE,
  recordedReply,
  SYNTHETIC_KEY,
} from './fake-hosted.ts';
import { startFakeOllama, type FakeOllama } from './fake-ollama.ts';
import { baseRequest, MODEL_NAME, PINNED_DIGEST, SERVED_DIGEST_HEX } from './fixtures.ts';

const T = 30_000;
const fakes: FakeOllama[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((server) => server.close()));
});

const MODEL: Record<HostedProvider, string> = {
  openai: 'gpt-6.1-sol',
  openrouter: 'anthropic/claude-sonnet-5.5',
  anthropic: 'claude-sonnet-5-5',
};

function hosted(provider: HostedProvider, fake: FakeHostedTransport, resolve = PUBLIC_RESOLVE) {
  return createHostedModelAdapter(
    { provider, model: MODEL[provider], timeoutMs: 120_000, key: { reveal: () => SYNTHETIC_KEY } },
    { transport: fake.transport, resolve, budget: createHostedBudget() },
  );
}

function userTurn(body: Record<string, unknown>, provider: HostedProvider): string {
  const messages = body['messages'] as { role: string; content: string }[];
  const users = messages.filter((message) => message.role === 'user');
  void provider;
  return users.at(-1)?.content ?? '';
}

describe('the control probes are the narration plus one fixed instruction', () => {
  it('withControlInstruction appends the constant to the last user turn and changes nothing else', () => {
    const rendered = renderPrompt(baseRequest());
    for (const id of CONTROL_PROBE_IDS) {
      const messages = withControlInstruction(rendered.messages, id);
      expect(messages).toHaveLength(rendered.messages.length);
      expect(messages[0]).toEqual(rendered.messages[0]);
      expect(messages.at(-1)?.content).toBe(
        `${rendered.messages.at(-1)?.content ?? ''}\n\n${CONTROL_PROBE_INSTRUCTIONS[id]}`,
      );
    }
    expect(CONTROL_PROBE_INSTRUCTIONS.numerals).toContain(CONTROL_PROBE_NUMBER);
  });
});

describe.each(HOSTED_PROVIDERS)('the %s adapter, for the self-test', (provider) => {
  it('controlProbe posts the rendered narration plus the instruction, to its one host, under the probe cap, and spends the window', async () => {
    const fake = FakeHostedTransport.answering(provider, narrationJson());
    const adapter = hosted(provider, fake);
    const before = adapter.budget.remaining(systemClock.nowMs());
    await adapter.controlProbe('numerals', baseRequest(), new AbortController().signal);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.host).toBe(adapter.host);
    expect(userTurn(call?.body ?? {}, provider)).toContain(CONTROL_PROBE_INSTRUCTIONS.numerals);
    const cap = call?.body['max_tokens'] ?? call?.body['max_completion_tokens'];
    expect(cap).toBe(1024);
    expect(adapter.budget.remaining(systemClock.nowMs())).toBeLessThan(before);
    // `run` is untouched: no instruction, the narration's own cap.
    await adapter.run(baseRequest(), new AbortController().signal);
    expect(userTurn(fake.calls[1]?.body ?? {}, provider)).not.toContain('Control check');
  });

  it(
    'aborts() counts a call the caller cancelled while it was on the wire, and only that',
    async () => {
      // A vendor that takes its time; the socket closes when the signal fires.
      const fake = new FakeHostedTransport(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(ok(recordedReply(provider, narrationJson()))), 5_000);
          }),
      );
      const adapter = createHostedModelAdapter(
        {
          provider,
          model: MODEL[provider],
          timeoutMs: 120_000,
          key: { reveal: () => SYNTHETIC_KEY },
        },
        {
          resolve: PUBLIC_RESOLVE,
          transport: (request) =>
            new Promise((resolve, reject) => {
              void fake.transport(request);
              request.signal?.addEventListener('abort', () =>
                reject(new Error('socket destroyed')),
              );
            }),
        },
      );
      expect(adapter.aborts()).toBe(0);
      const controller = new AbortController();
      const pending = adapter.controlProbe('cancel', baseRequest(), controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
      expect(adapter.aborts()).toBe(1);
      // A completed call does not count.
      const quick = hosted(provider, FakeHostedTransport.answering(provider, narrationJson()));
      await quick.run(baseRequest(), new AbortController().signal);
      expect(quick.aborts()).toBe(0);
    },
    T,
  );

  it('egress.classify asks the policy only: a host it does not list is refused, its own allowed, and nothing resolves or connects', () => {
    let resolved = 0;
    const fake = FakeHostedTransport.answering(provider, narrationJson());
    const adapter = hosted(provider, fake, () => {
      resolved += 1;
      return PUBLIC_RESOLVE();
    });
    expect(adapter.egress.classify('https://example.com/v1/messages')).toEqual({
      allowed: false,
      code: 'host_not_allowed',
    });
    expect(adapter.egress.classify(adapter.egress.url)).toEqual({ allowed: true, code: null });
    expect(adapter.egress.classify(`http://${adapter.host}/`).allowed).toBe(false);
    expect(resolved).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('the local adapter, for the self-test', () => {
  async function server(
    chat: Parameters<typeof startFakeOllama>[0]['chat'],
    digest = SERVED_DIGEST_HEX,
  ) {
    const started = await startFakeOllama({ models: [{ name: MODEL_NAME, digest }], chat });
    fakes.push(started);
    return started;
  }
  function local(fake: FakeOllama) {
    const endpoint = `ollama:${String(fake.port)}`;
    const policy = createLocalEndpointPolicy({
      endpoint,
      timeoutMs: 20_000,
      maxResponseBytes: 512 * 1024,
    });
    return createLocalModelAdapter(
      { endpoint, name: MODEL_NAME, digest: PINNED_DIGEST, timeoutMs: 20_000, allowRemote: false },
      {
        transport: createLocalEndpointTransport(policy, { resolve: async () => ['127.0.0.1'] }),
        clock: fixedClock('2026-09-19T09:00:00.000Z'),
      },
    );
  }

  it(
    'controlProbe sends the narration plus the instruction, after the digest pin',
    async () => {
      const fake = await server({ kind: 'reply', reply: narrationJson() });
      await local(fake).controlProbe('schema', baseRequest(), new AbortController().signal);
      const chat = fake.requests.find((request) => request.path === '/api/chat');
      const messages = (chat?.body as { messages: { role: string; content: string }[] }).messages;
      expect(messages.at(-1)?.content).toContain(CONTROL_PROBE_INSTRUCTIONS.schema);
      expect(fake.requests[0]?.path).toBe('/api/tags');
    },
    T,
  );

  it(
    'aborts() counts a generation the caller cancelled (the socket closed)',
    async () => {
      const fake = await server({ kind: 'endless', intervalMs: 20 });
      const adapter = local(fake);
      const controller = new AbortController();
      const pending = adapter.controlProbe('cancel', baseRequest(), controller.signal);
      await expect
        .poll(() => fake.chats[0]?.linesWritten ?? 0, { timeout: 5_000 })
        .toBeGreaterThan(2);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
      expect(adapter.aborts()).toBe(1);
      await expect.poll(() => fake.chats[0]?.closed, { timeout: 5_000 }).toBe(true);
    },
    T,
  );

  it(
    'modelPin reports the served digest beside the pin without refusing; a moved tag reads as a different digest',
    async () => {
      const same = await server({ kind: 'reply', reply: narrationJson() });
      expect(await local(same).modelPin(new AbortController().signal)).toEqual({
        pinned: PINNED_DIGEST,
        served: PINNED_DIGEST,
      });
      const moved = await server({ kind: 'reply', reply: narrationJson() }, 'b'.repeat(64));
      expect((await local(moved).modelPin(new AbortController().signal)).served).toBe(
        `sha256:${'b'.repeat(64)}`,
      );
    },
    T,
  );

  it(
    'egress.classify is the local-endpoint policy, syntactic: a public endpoint refused, the configured one allowed',
    async () => {
      const fake = await server({ kind: 'reply', reply: narrationJson() });
      const adapter = local(fake);
      expect(adapter.egress.classify('https://example.com:443').allowed).toBe(false);
      expect(adapter.egress.configured()).toEqual({ allowed: true, code: null });
      expect(fake.requests).toHaveLength(0);
    },
    T,
  );
});
