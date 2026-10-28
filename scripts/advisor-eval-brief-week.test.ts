// SPDX-License-Identifier: MIT
/**
 * WP 11.4: `scripts/advisor-eval.ts --brief-week` over the Ollama fake (CI's
 * run; the live run against the pinned model is the orchestrator's). The five
 * item narrations go through the worker's narrator composition and the
 * composition through the shipped brief-narrate adapter, judged by the
 * production validator: one composition call, its titles the five the Brief
 * chose in the Brief's order; a reply carrying an outside figure is refused.
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOllama, type FakeOllama } from '../packages/advisors/local-model/test/index.ts';
import {
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
} from '../packages/platform/src/index.ts';
import { briefWeek, type BriefWeekOptions } from './advisor-eval-brief-week.ts';

const MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '9'.repeat(64);

describe('advisor-eval --brief-week (over the Ollama fake)', () => {
  let fake: FakeOllama;
  let options: Omit<BriefWeekOptions, 'onPhase'>;

  beforeAll(async () => {
    fake = await startFakeOllama({
      models: [{ name: MODEL, digest: DIGEST_HEX }],
      chat: { kind: 'reply', reply: '{"insights":[]}' },
    });
    const endpoint = `ollama:${String(fake.port)}`;
    const transport = createLocalEndpointTransport(
      createLocalEndpointPolicy({ endpoint, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 }),
      { resolve: () => Promise.resolve(['127.0.0.1']) },
    );
    options = {
      endpoint,
      model: MODEL,
      digest: `sha256:${DIGEST_HEX}`,
      timeoutMs: 20_000,
      transport,
    };
  }, 60_000);

  afterAll(async () => {
    await fake?.close();
  });

  it('narrates the five items, then composes the week in one call; an honest composition is accepted', async () => {
    const before = fake.chats.length;
    mkdirSync(join(homedir(), '.cache'), { recursive: true });
    const dir = mkdtempSync(join(homedir(), '.cache', 'wp114-eval-'));
    const report = await briefWeek({
      ...options,
      out: join(dir, 'brief-week.jsonl'),
      onPhase: (phase, subject) => {
        if (phase !== 'compose' || subject === null) return;
        const [first, second] = subject.items;
        fake.chat = {
          kind: 'reply',
          reply: JSON.stringify({
            narration: `${first?.title ?? ''} leads the week at ${first?.figure ?? ''}, then ${second?.title ?? ''}.`,
            recap: `Week ${subject.week} has ${subject.ranked_count} ranked actions and a health score of ${subject.health_score ?? ''}.`,
          }),
        };
      },
    });
    expect(report.items).toHaveLength(5);
    // Five item requests and exactly one composition call.
    expect(fake.chats.length - before).toBe(6);
    expect(report.composition).toMatchObject({ error: null, accepted: true, refusal: null });
    expect(report.composition.titlesSent).toHaveLength(5);
    const lines = readFileSync(join(dir, 'brief-week.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(6);
  }, 120_000);

  it('a composition carrying a figure outside the Brief is refused (numeral), never accepted', async () => {
    const report = await briefWeek({
      ...options,
      onPhase: (phase, subject) => {
        if (phase !== 'compose' || subject === null) return;
        fake.chat = {
          kind: 'reply',
          reply: JSON.stringify({
            narration: `${subject.items[0]?.title ?? ''} leads; together the week is worth $9,999.99.`,
            recap: 'A week of ranked actions.',
          }),
        };
      },
    });
    expect(report.composition).toMatchObject({ accepted: false, refusal: 'numeral' });
  }, 120_000);
});
