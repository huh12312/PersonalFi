// SPDX-License-Identifier: MIT
/**
 * WP 11.5c: `scripts/advisor-eval.ts --ask` — the compile golden set (12 §5's
 * "Compilation" row). The set's own shape (at least forty questions, every
 * catalogue function expected at least twice, out-of-scope, not-computable
 * and injection cases), the replay's measurement pinned, and the same
 * measurement through the shipped compile adapter over the Ollama fake
 * answering the recorded replies: the compiler is a pure function of the
 * reply, so the two must agree exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOllama, type FakeOllama } from '../packages/advisors/local-model/test/index.ts';
import {
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
} from '../packages/platform/src/index.ts';
import {
  CATALOGUE,
  CATALOGUE_FUNCTION_NAMES,
  type CatalogueFunctionName,
} from '../packages/contexts/insights/src/catalogue/catalogue.ts';
import { precheckQuestion } from '../packages/contexts/insights/src/advisors/ask/precheck.ts';
import {
  askGoldenOverModel,
  formatAskReport,
  loadAskGolden,
  replayAskGolden,
} from './advisor-eval-ask.ts';

const MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '5'.repeat(64);

describe('advisor-eval --ask: the golden set', () => {
  const golden = loadAskGolden();

  it('holds at least forty questions over every kind, every catalogue function expected at least twice', () => {
    expect(golden.entries.length).toBeGreaterThanOrEqual(40);
    expect(new Set(golden.entries.map((entry) => entry.id)).size).toBe(golden.entries.length);
    const kinds = new Set(golden.entries.map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual(['calls', 'injection', 'not_computable', 'out_of_scope']);
    const expected = new Map<string, number>();
    for (const entry of golden.entries) {
      if (!('calls' in entry.expected)) continue;
      for (const call of entry.expected.calls)
        expected.set(call.name, (expected.get(call.name) ?? 0) + 1);
    }
    for (const name of CATALOGUE_FUNCTION_NAMES) {
      expect(expected.get(name) ?? 0, name).toBeGreaterThanOrEqual(2);
    }
  });

  it('every expected call is one its function’s own schema accepts; every question the pre-check passes has a reply', () => {
    for (const entry of golden.entries) {
      if ('calls' in entry.expected) {
        for (const call of entry.expected.calls) {
          const definition = CATALOGUE[call.name as CatalogueFunctionName];
          expect(definition.args.safeParse(call.args).success, `${entry.id}: ${call.name}`).toBe(
            true,
          );
        }
      }
      if (precheckQuestion(entry.question).kind === 'ok') {
        expect(entry.reply, entry.id).toBeDefined();
      }
    }
  });

  it('the replay: the deliberately wrong recorded replies, and only those, are wrong — and precision and recall say so', () => {
    const { judged, report } = replayAskGolden(golden);
    const wrong = judged.filter((entry) => !entry.correct).map((entry) => entry.id);
    const flagged = golden.entries
      .filter((entry) => entry.note?.startsWith('recorded reply') === true)
      .map((entry) => entry.id);
    expect(wrong).toEqual(flagged);
    expect(report).toMatchObject({
      entries: 64,
      correct: 58,
      answeredWithoutModel: 11,
      micro: { tp: 42, fp: 5, fn: 3, precision: 0.8936, recall: 0.9333 },
      screens: { correct: 6, total: 7 },
      refusals: { 'compile.invalid_arguments': 1, 'compile.unknown_function': 2 },
    });
    expect(report.byKind).toEqual({
      calls: { correct: 39, total: 43 },
      not_computable: { correct: 4, total: 5 },
      out_of_scope: { correct: 7, total: 8 },
      injection: { correct: 8, total: 8 },
    });
    expect(report.perFunction['retirement.claiming']).toMatchObject({
      precision: 0.5,
      recall: 0.5,
    });
    expect(report.perFunction['limits.contribution_room']).toMatchObject({
      precision: 1,
      recall: 1,
    });
    // Every injection is stopped: by the pre-check, or by the validator.
    expect(
      judged.filter((entry) => entry.kind === 'injection').every((entry) => entry.correct),
    ).toBe(true);
    // The printed report carries counts and rates, never a reply.
    const printed = formatAskReport(report).join('\n');
    expect(printed).toContain('precision 89.4%');
    expect(printed).not.toContain('{"');
  });

  describe('through the shipped compile adapter, over the Ollama fake', () => {
    let fake: FakeOllama;
    beforeAll(async () => {
      const byQuestion = new Map(golden.entries.map((entry) => [entry.question, entry.reply]));
      fake = await startFakeOllama({
        models: [{ name: MODEL, digest: DIGEST_HEX }],
        chat: {
          kind: 'respond',
          respond: (body) => {
            const messages = (body as { messages: { content: string }[] }).messages;
            const user = messages[messages.length - 1]?.content ?? '';
            const block = user.slice(user.indexOf('\n') + 1, user.indexOf('\n</untrusted_data>'));
            const question = (JSON.parse(block) as { subject: { question: string } }).subject
              .question;
            return JSON.stringify(byQuestion.get(question) ?? {});
          },
        },
      });
    }, 30_000);
    afterAll(async () => {
      await fake?.close();
    });

    it('measures exactly what the replay measures, one call per question the pre-check passes', async () => {
      const endpoint = `ollama:${String(fake.port)}`;
      const transport = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 }),
        { resolve: () => Promise.resolve(['127.0.0.1']) },
      );
      const before = fake.chats.length;
      const over = await askGoldenOverModel(
        { endpoint, model: MODEL, digest: `sha256:${DIGEST_HEX}`, timeoutMs: 20_000, transport },
        golden,
      );
      expect(over.calls).toBe(53);
      expect(fake.chats.length - before).toBe(53);
      expect(over.report).toEqual(replayAskGolden(golden).report);
    }, 120_000);
  });
});
