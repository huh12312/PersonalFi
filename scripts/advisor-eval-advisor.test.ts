// SPDX-License-Identifier: MIT
/**
 * WP 11.5d: `scripts/advisor-eval.ts --advisor` — the advisor-mode golden set
 * (12 §5). The set's own shape (at least twenty sessions, 12 §3's three worked
 * examples among them, every refusal class the protocol names exercised), the
 * replay's measurement pinned — outcomes, calls, option counts, refusals and
 * the rubric judge's scores — and the same measurement through the shipped
 * adapters over the Ollama fake answering the recorded replies: every step is
 * a pure function of its reply, so the two must agree exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOllama, type FakeOllama } from '../packages/advisors/local-model/test/index.ts';
import {
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
} from '../packages/platform/src/index.ts';
import {
  advisorGoldenOverModel,
  formatAdvisorReport,
  loadAdvisorGolden,
  replayAdvisorGolden,
} from './advisor-eval-advisor.ts';

const MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '3'.repeat(64);

describe('advisor-eval --advisor: the golden set', () => {
  const golden = loadAdvisorGolden();

  it('holds at least twenty sessions over every kind, the three worked examples of 12 §3 among them', () => {
    expect(golden.entries.length).toBeGreaterThanOrEqual(20);
    expect(new Set(golden.entries.map((entry) => entry.id)).size).toBe(golden.entries.length);
    expect(new Set(golden.entries.map((entry) => entry.kind))).toEqual(
      new Set(['session', 'out_of_scope', 'injection', 'refusal', 'not_computable']),
    );
    expect(
      golden.entries.filter((entry) => entry.example !== undefined).map((entry) => entry.question),
    ).toEqual([
      'Should I pay off my car loan or invest the extra $400 a month?',
      'Can I retire at 60?',
      'Where should I put $15,000 that’s sitting in checking?',
    ]);
    const refusals = new Set(
      golden.entries
        .map((entry) => entry.expected.refusal)
        .filter((refusal) => refusal !== undefined),
    );
    for (const refusal of [
      'tradeoffs.cost_missing',
      'options.unbacked',
      'plan.href_unlisted',
      'plan.external_url',
      'clarify.too_many_questions',
      'answer.merchant_token',
      'question.instruction',
    ]) {
      expect(refusals, refusal).toContain(refusal);
    }
  });

  it('replays to a pinned measurement: outcomes, calls, option counts, refusals and the judge’s scores', async () => {
    const { report, judged } = await replayAdvisorGolden(golden);
    expect(report.sessions).toBe(golden.entries.length);
    // The two deliberately wrong compile replies (each says so in its note) are the only misses.
    expect(
      judged
        .filter((entry) => !entry.correct)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['wrong-function', 'wrong-order']);
    expect(report.outcomes).toEqual({ precheck: 4, refused: 8, tracked: 14, unanswerable: 1 });
    expect(report.calls).toMatchObject({ tp: 26, fp: 2, fn: 2 });
    expect(report.options).toEqual({ correct: 17, total: 17, dropped: 1 });
    expect(report.refusals).toEqual({
      'answer.merchant_token': 1,
      'clarify.too_many_questions': 1,
      'gather.unknown_function': 1,
      'options.summary.numeral': 1,
      'options.unbacked': 1,
      'plan.external_url': 1,
      'plan.href_unlisted': 1,
      'tradeoffs.cost_missing': 1,
    });
    expect(report.judge).toEqual({
      scored: 15,
      mean: '0.911',
      distribution: { '0.333': 1, '0.667': 2, '1.000': 12 },
      refused: { 'judge.holder_data': 1 },
    });
    expect(report.answeredWithoutModel).toBe(4);
    for (const line of formatAdvisorReport(report))
      expect(line).not.toMatch(/MERCHANT_|untrusted_data/u);
  });

  describe('through the shipped adapters, over the Ollama fake answering the recorded replies', () => {
    let fake: FakeOllama;
    let next = '{}';

    beforeAll(async () => {
      fake = await startFakeOllama({
        models: [{ name: MODEL, digest: DIGEST_HEX }],
        chat: { kind: 'respond', respond: () => next },
      });
    }, 30_000);

    afterAll(async () => {
      await fake?.close();
    });

    it('agrees with the replay exactly, one chat per step a session reached', async () => {
      const endpoint = `ollama:${String(fake.port)}`;
      const transport = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 }),
        { resolve: () => Promise.resolve(['127.0.0.1']) },
      );
      const over = await advisorGoldenOverModel(
        {
          endpoint,
          model: MODEL,
          digest: `sha256:${DIGEST_HEX}`,
          timeoutMs: 20_000,
          transport,
          beforeCall: (entry, step) => {
            next = JSON.stringify(entry.replies[step] ?? {});
          },
        },
        golden,
      );
      const replay = await replayAdvisorGolden(golden);
      expect(over.report).toEqual(replay.report);
      expect(over.calls).toBe(replay.report.modelCalls);
    }, 60_000);
  });
});
