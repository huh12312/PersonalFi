// SPDX-License-Identifier: MIT
/**
 * WP 11.6: `scripts/advisor-eval.ts --merchant-name` — the golden set (at least
 * forty descriptors, noise and not; every refusal class at least once; the
 * accepted-but-wrong names a substring rule cannot catch, labelled), the
 * replay's measurement pinned, and the same measurement through the shipped
 * merchant-name adapter over the Ollama fake answering the recorded replies:
 * the validator is a pure function of the reply, so the two must agree exactly,
 * and the fake must see one call per noise descriptor and none for the rest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOllama, type FakeOllama } from '../packages/advisors/local-model/test/index.ts';
import {
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
} from '../packages/platform/src/index.ts';
import { MERCHANT_NAME_REFUSAL_CLASSES } from '../packages/contexts/insights/src/advisors/merchant-name/reply.ts';
import { detectMerchantNoise } from '../packages/contexts/ledger/src/merchant-noise.ts';
import {
  formatMerchantNameReport,
  loadMerchantNameGolden,
  merchantNameGoldenOverModel,
  replayMerchantNameGolden,
} from './advisor-eval-merchant-name.ts';

const MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '5'.repeat(64);

describe('advisor-eval --merchant-name: the golden set', () => {
  const golden = loadMerchantNameGolden();

  it('holds at least forty descriptors, noise and not, every refusal class at least once, a reply exactly for the noise', () => {
    expect(golden.entries.length).toBeGreaterThanOrEqual(40);
    expect(new Set(golden.entries.map((entry) => entry.id)).size).toBe(golden.entries.length);
    const noise = golden.entries.filter(
      (entry) => detectMerchantNoise({ name: entry.descriptor }).noise,
    );
    expect(noise.length).toBeGreaterThanOrEqual(30);
    expect(golden.entries.length - noise.length).toBeGreaterThanOrEqual(10);
    for (const entry of golden.entries) {
      expect('reply' in entry, entry.id).toBe(
        detectMerchantNoise({ name: entry.descriptor }).noise,
      );
    }
    const classes = new Set(
      golden.entries.flatMap((entry) =>
        'refused' in entry.expected ? [entry.expected.refused] : [],
      ),
    );
    expect([...classes].sort()).toEqual([...MERCHANT_NAME_REFUSAL_CLASSES].sort());
  });

  it('the replay: every outcome as expected; precision of accepted names and the refusal rate pinned', () => {
    const { judged, report } = replayMerchantNameGolden(golden);
    expect(judged.filter((entry) => !entry.correct).map((entry) => entry.id)).toEqual([]);
    expect(report).toEqual({
      entries: 53,
      correct: 53,
      notNoise: 13,
      asked: 40,
      suggested: 22,
      good: 19,
      precision: 0.8636,
      abstained: 3,
      refused: 15,
      refusalRate: 0.375,
      abstentionRate: 0.075,
      refusals: {
        'name.copy': 1,
        'name.digits_only': 1,
        'name.empty': 1,
        'name.invented': 4,
        'name.link': 1,
        'name.markup': 1,
        'name.out_of_order': 2,
        'name.too_long': 1,
        'name.unchanged': 1,
        schema: 2,
      },
    });
    // The three accepted names the golden set calls wrong are the labelled residual risk.
    const wrong = judged.filter((entry) => entry.good === false).map((entry) => entry.id);
    expect(wrong).toEqual(
      golden.entries
        .filter((entry) => 'suggestion' in entry.expected && !entry.expected.good)
        .map((entry) => entry.id),
    );
    const printed = formatMerchantNameReport(report).join('\n');
    expect(printed).toContain('precision 86.4%');
    expect(printed).toContain('refusal rate 37.5%');
    // Counts and rates only: never a descriptor or a reply.
    expect(printed).not.toMatch(/EBAY|Ebay|\{"/u);
  });

  describe('through the shipped merchant-name adapter, over the Ollama fake', () => {
    let fake: FakeOllama;
    beforeAll(async () => {
      // The adapter is called once per noise descriptor, in golden order: the fake answers the
      // recorded replies in that order. (Matching by the descriptor the prompt carries would not
      // do: the sanitiser rewrites an injection inside the fence, which is its job.)
      const replies = golden.entries
        .filter((entry) => detectMerchantNoise({ name: entry.descriptor }).noise)
        .map((entry) => entry.reply);
      let next = 0;
      fake = await startFakeOllama({
        models: [{ name: MODEL, digest: DIGEST_HEX }],
        chat: {
          kind: 'respond',
          respond: () => {
            const reply = replies[next];
            next += 1;
            // A recorded "not JSON" reply is sent as prose.
            return reply === null ? 'Sure, here is a name.' : JSON.stringify(reply ?? {});
          },
        },
      });
    }, 30_000);
    afterAll(async () => {
      await fake?.close();
    });

    it('measures exactly what the replay measures, one call per noise descriptor and none for the rest', async () => {
      const endpoint = `ollama:${String(fake.port)}`;
      const transport = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 }),
        { resolve: () => Promise.resolve(['127.0.0.1']) },
      );
      const before = fake.chats.length;
      const over = await merchantNameGoldenOverModel(
        { endpoint, model: MODEL, digest: `sha256:${DIGEST_HEX}`, timeoutMs: 20_000, transport },
        golden,
      );
      expect(over.calls).toBe(40);
      expect(fake.chats.length - before).toBe(40);
      expect(over.report).toEqual(replayMerchantNameGolden(golden).report);
    }, 120_000);
  });
});
