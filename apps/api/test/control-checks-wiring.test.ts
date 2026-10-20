// SPDX-License-Identifier: MIT
/**
 * WP 10.16 — the composition of the GenAI controls self-test, without a
 * database: only the worker's run-mode narrator carries control probes (the
 * api's preview runtime has none, so the api cannot reach a model through the
 * self-test either); the probe model is the narration's own adapter; the
 * recipe's text table and exit codes; the cost line's words; and the route
 * file builds no model adapter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PUBLIC_RESOLVE } from '@advisor/local-model/test';
import { CONTROL_CHECKS, type ControlCheckRun } from '@ctx/insights';
import { describe, expect, it } from 'vitest';
import { controlChecksCost, exitCodeOf, formatControlCheckRun } from '../src/control-checks.ts';
import {
  createNarratorRuntime,
  type NarratorSettingsSnapshot,
  type NarratorStores,
} from '../src/narrator-wiring.ts';

const DIGEST = `sha256:${'845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e'}`;
const KEY = 'sk-ant-wp1016-synthetic-key-000000000000001'; // gitleaks:allow — synthetic

function stores(settings: Partial<NarratorSettingsSnapshot>): NarratorStores {
  return {
    settings: () =>
      Promise.resolve({
        activeProvider: 'ollama',
        hasRow: true,
        models: {},
        ollama: null,
        consented: new Set(),
        ...settings,
      }),
    storedKey: () => Promise.resolve({ reveal: () => KEY }),
  };
}

const hosted = stores({ activeProvider: 'anthropic', consented: new Set(['anthropic']) });
const local = stores({
  activeProvider: 'ollama',
  ollama: { endpoint: 'ollama:11434', name: 'qwen2.5:7b-instruct-q4_K_M', digest: DIGEST },
});

function runtime(mode: 'run' | 'preview', store: NarratorStores) {
  return createNarratorRuntime({
    mode,
    stores: store,
    localModel: undefined,
    timeoutMs: 180_000,
    allowRemote: false,
    fileKeys: {},
    resolve: PUBLIC_RESOLVE,
  });
}

describe('the self-test reaches a model only through the worker', () => {
  it('a run-mode narrator carries control probes; the api’s preview-mode narrator carries none', async () => {
    for (const store of [hosted, local]) {
      expect((await runtime('run', store).forUser('u1'))?.control).toBeDefined();
      expect((await runtime('preview', store).forUser('u1'))?.control).toBeUndefined();
    }
  });

  it('the probe model is the narration’s own adapter: its label, window, egress host and (local) pin', async () => {
    const run = runtime('run', hosted);
    const narrator = await run.forUser('u1');
    const control = narrator?.control;
    expect(control?.label).toBe(narrator?.label);
    expect(control?.budget).toBe(run.budgets.get('anthropic'));
    expect(control?.egress.kind === 'hosted' ? control.egress.url : null).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(control?.modelPin).toBeUndefined();
    const ollama = (await runtime('run', local).forUser('u1'))?.control;
    expect(ollama?.provider).toBe('ollama');
    expect(ollama?.budget).toBeNull();
    expect(ollama?.modelPin).toBeDefined();
  });

  it('the route file builds no model adapter and opens no transport', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/routes/narrator-control-checks.ts', import.meta.url)),
      'utf8',
    );
    for (const forbidden of [
      'createHostedModelAdapter',
      'createLocalModelAdapter',
      'createNarratorWiring',
      'createNodeTransport',
      "mode: 'run'",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('the words', () => {
  it('states the cost before a press, per provider', () => {
    expect(controlChecksCost('anthropic', 'Anthropic').message).toBe(
      "This sends up to 3 calls to Anthropic with your key, from this install's hourly window of 30.",
    );
    expect(controlChecksCost('ollama', 'the local model')).toMatchObject({
      hosted: false,
      modelCalls: 3,
    });
    expect(controlChecksCost('off', '').modelCalls).toBe(0);
  });

  it('the recipe prints the same table as text and exits 0 pass, 2 partial, 1 fail', () => {
    const run: ControlCheckRun = {
      id: '01a10000-0000-7000-8000-000000000001',
      userId: 'u1',
      startedAt: new Date('2026-10-19T08:00:00Z'),
      finishedAt: new Date('2026-10-19T08:00:09Z'),
      provider: 'anthropic',
      model: 'anthropic:claude-sonnet-5-5',
      overall: 'partial',
      evidenceVersion: 'genai-controls/1',
      results: CONTROL_CHECKS.map((check, index) => ({
        id: check.id,
        name: check.name,
        proves: check.proves,
        side: check.side,
        status: index === 6 ? 'skipped' : index === 10 ? 'skipped' : 'pass',
        reason:
          index === 6
            ? 'No narration has run yet with its payload retained (the last 30 days).'
            : null,
        facts: index === 0 ? ['The model was never called.'] : [],
        notApplicable: index === 10,
        durationMs: 12,
      })),
    };
    const text = formatControlCheckRun(run);
    expect(text).toContain('narrator  anthropic:claude-sonnet-5-5');
    expect(text).toContain('overall   PARTIAL');
    expect(text).toMatch(/Payload approval gate\s+PASS\s+12 ms/u);
    expect(text).toMatch(/Run inspector digest\s+SKIPPED/u);
    expect(text).toMatch(/Local model pin\s+N\/A/u);
    expect(text).toContain('why: No narration has run yet');
    expect(text).toContain('- The model was never called.');
    expect([exitCodeOf('pass'), exitCodeOf('partial'), exitCodeOf('fail')]).toEqual([0, 2, 1]);
  });
});
