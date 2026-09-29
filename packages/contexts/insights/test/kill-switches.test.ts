// SPDX-License-Identifier: MIT
/**
 * The kill ladder's pure half (WP 5.1): `decideRun` over every input
 * combination, `decideContinue`, the per-kind breaker, the switch reader, the
 * run watcher's timing, and the query shape.
 *
 * `fast-check` 4.9.0 is already a devDependency of `@ctx/insights`
 * (`package.json`), so the property needs no lockfile change. The input space
 * is small (2⁶ with the quarantine as a boolean), so the property is backed by
 * an exhaustive enumeration as well — a property that samples a space it could
 * simply walk is weaker than it looks.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BREAKER_THRESHOLDS,
  LADDER_LEVEL,
  createRunSwitches,
  decideContinue,
  decideRun,
  shouldQuarantine,
  staticRunSwitches,
  type KillSwitchInputs,
  type RunRefusal,
} from '../src/policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, RunCancelled, watchRun } from '../src/policy/run-watch.ts';
import { queryShape } from '../src/preview.ts';

/** Blast-radius order: the broadest switch first. */
const ORDER: readonly [keyof KillSwitchInputs, RunRefusal][] = [
  ['advisorsEnabled', 'advisors_disabled'],
  ['moduleEnabled', 'module_disabled'],
  ['kindEnabled', 'kind_disabled'],
  ['advisorEnabled', 'advisor_disabled'],
  ['quarantinedAt', 'advisor_quarantined'],
  ['payloadApproved', 'payload_not_approved'],
];

/** Is this one switch saying yes? */
function says(inputs: KillSwitchInputs, key: keyof KillSwitchInputs): boolean {
  return key === 'quarantinedAt' ? inputs.quarantinedAt === null : inputs[key] === true;
}

const inputsArbitrary: fc.Arbitrary<KillSwitchInputs> = fc.record({
  advisorsEnabled: fc.boolean(),
  moduleEnabled: fc.boolean(),
  kindEnabled: fc.boolean(),
  advisorEnabled: fc.boolean(),
  quarantinedAt: fc.option(fc.date({ noInvalidDate: true }), { nil: null }),
  payloadApproved: fc.boolean(),
});

function checkDecision(inputs: KillSwitchInputs): void {
  const decision = decideRun(inputs);
  const everyYes = ORDER.every(([key]) => says(inputs, key));
  expect(decision.run).toBe(everyYes);
  if (!decision.run) {
    const broadest = ORDER.find(([key]) => !says(inputs, key));
    expect(decision.refusal).toBe(broadest?.[1]);
  }
}

describe('decideRun', () => {
  it('decideRun runs only when every switch says yes', () => {
    // The property, as the plan names it…
    fc.assert(
      fc.property(inputsArbitrary, (inputs) => checkDecision(inputs)),
      { numRuns: 500 },
    );
    // …and the whole space, walked: 64 combinations, each checked.
    let walked = 0;
    for (let mask = 0; mask < 1 << ORDER.length; mask += 1) {
      const bit = (index: number) => (mask & (1 << index)) !== 0;
      checkDecision({
        advisorsEnabled: bit(0),
        moduleEnabled: bit(1),
        kindEnabled: bit(2),
        advisorEnabled: bit(3),
        quarantinedAt: bit(4) ? null : new Date('2026-09-01T00:00:00Z'),
        payloadApproved: bit(5),
      });
      walked += 1;
    }
    expect(walked).toBe(64);
  });

  it('a run in flight stops for any switch, and for its own cancel only after every switch', () => {
    fc.assert(
      fc.property(inputsArbitrary, fc.boolean(), (inputs, cancelled) => {
        const cancelRequestedAt = cancelled ? new Date('2026-09-01T00:00:00Z') : null;
        const reason = decideContinue({ ...inputs, cancelRequestedAt });
        const decision = decideRun(inputs);
        if (!decision.run) expect(reason).toBe(decision.refusal);
        else expect(reason).toBe(cancelled ? 'run_cancelled' : null);
      }),
      { numRuns: 500 },
    );
  });

  it('every refusal and cancellation belongs to its ladder level', () => {
    expect(LADDER_LEVEL).toEqual({
      advisors_disabled: 1,
      module_disabled: 1,
      kind_disabled: 2,
      advisor_disabled: 3,
      advisor_quarantined: 3,
      payload_not_approved: null,
      run_cancelled: 4,
    });
  });
});

describe('the switch reader', () => {
  const flagsFrom = (values: Record<string, boolean>) => ({
    isEnabled: (_userId: string, key: string) => Promise.resolve(values[key] ?? false),
  });

  it('reads level 1 from config and the module flag, and level 2 from the kind flag and configuration', async () => {
    const on = createRunSwitches({
      advisorsEnabled: true,
      flags: flagsFrom({ 'module.insights': true, 'advisors.kind.local_model': true }),
      configuredKinds: new Set(['builtin', 'local_model']),
    });
    expect(await on.advisorsEnabled()).toBe(true);
    expect(await on.moduleEnabled('u')).toBe(true);
    expect(await on.kindEnabled('u', 'builtin')).toBe(true);
    expect(await on.kindEnabled('u', 'local_model')).toBe(true);
    // `external` has no flag yet: off.
    expect(await on.kindEnabled('u', 'external')).toBe(false);

    const unconfigured = createRunSwitches({
      advisorsEnabled: false,
      flags: flagsFrom({ 'module.insights': false, 'advisors.kind.local_model': true }),
      configuredKinds: new Set(['builtin']),
    });
    expect(await unconfigured.advisorsEnabled()).toBe(false);
    expect(await unconfigured.moduleEnabled('u')).toBe(false);
    // The flag is on, but no local model is configured: off.
    expect(await unconfigured.kindEnabled('u', 'local_model')).toBe(false);
  });

  it('the pre-WP 5.1 static booleans fail closed', async () => {
    const absent = staticRunSwitches({});
    expect(await absent.advisorsEnabled()).toBe(false);
    expect(await absent.moduleEnabled('u')).toBe(false);
    expect(await absent.kindEnabled('u', 'local_model')).toBe(false);
    expect(await absent.kindEnabled('u', 'builtin')).toBe(true);
  });
});

describe('the breaker, per kind', () => {
  it('keeps the builtin numbers and applies 08 §4.4 to a local model', () => {
    expect(BREAKER_THRESHOLDS.builtin).toEqual({
      consecutiveFailures: 5,
      rejectionRate: 0.5,
      rejectionFloor: 4,
      rejectionsIn24h: null,
    });
    expect(BREAKER_THRESHOLDS.local_model).toEqual({
      consecutiveFailures: 3,
      rejectionRate: null,
      rejectionFloor: 0,
      rejectionsIn24h: 5,
    });
    const at = (
      kind: 'builtin' | 'local_model',
      consecutiveFailures: number,
      rejectionsIn24h = 0,
    ) => shouldQuarantine({ kind, consecutiveFailures, accepted: 0, rejected: 0, rejectionsIn24h });
    expect(at('local_model', 2)).toBeNull();
    expect(at('local_model', 3)).toBe('consecutive_failures');
    expect(at('builtin', 4)).toBeNull();
    expect(at('builtin', 5)).toBe('consecutive_failures');
    expect(at('local_model', 0, 4)).toBeNull();
    expect(at('local_model', 0, 5)).toBe('rejection_rate');
    // The 24 h rule is not the builtin's: its rule is the per-run rate.
    expect(at('builtin', 0, 50)).toBeNull();
    expect(
      shouldQuarantine({ kind: 'builtin', consecutiveFailures: 0, accepted: 2, rejected: 2 }),
    ).toBe('rejection_rate');
    expect(
      shouldQuarantine({ kind: 'local_model', consecutiveFailures: 0, accepted: 2, rejected: 2 }),
    ).toBeNull();
  });
});

describe('the run watcher', () => {
  it('polls at most once a second, aborts on the first "no", and keeps polling past a failed probe', async () => {
    expect(RUN_WATCH_POLL_MS).toBeLessThanOrEqual(1_000);
    const controller = new AbortController();
    const ticks: number[] = [];
    const started = performance.now();
    let calls = 0;
    const watch = watchRun({
      controller,
      pollMs: 50,
      onProbeError: () => undefined,
      probe: () => {
        calls += 1;
        ticks.push(performance.now() - started);
        if (calls === 2) return Promise.reject(new Error('pool timeout'));
        return Promise.resolve(calls >= 4 ? 'kind_disabled' : null);
      },
    });
    await new Promise<void>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    await watch.stop();
    expect(calls).toBe(4);
    expect(watch.reason()).toBe('kind_disabled');
    expect(controller.signal.reason).toBeInstanceOf(RunCancelled);
    expect((controller.signal.reason as RunCancelled).reason).toBe('kind_disabled');
    // Spaced by the interval, not a busy loop.
    for (let index = 1; index < ticks.length; index += 1) {
      expect((ticks[index] ?? 0) - (ticks[index - 1] ?? 0)).toBeGreaterThanOrEqual(40);
    }
  }, 30_000);

  it('stop() ends the polling', async () => {
    let calls = 0;
    const watch = watchRun({
      controller: new AbortController(),
      pollMs: 20,
      probe: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    await watch.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(after);
    expect(watch.reason()).toBeNull();
  }, 30_000);
});

describe('the query shape', () => {
  const base = {
    advisorId: 'local.narrator',
    advisorVersion: '1.0.0',
    kind: 'local_model' as const,
    scopes: ['cash.summary', 'goals.list'] as const,
    promptTemplateHash: `sha256:${'a'.repeat(64)}`,
  };

  it('ignores scope order and moves with every other input', () => {
    const shape = queryShape(base);
    expect(shape).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(queryShape({ ...base, scopes: ['goals.list', 'cash.summary'] })).toBe(shape);
    for (const changed of [
      { advisorId: 'local.other' },
      { advisorVersion: '1.0.1' },
      { kind: 'external' as const },
      { scopes: ['cash.summary'] as const },
      { promptTemplateHash: `sha256:${'b'.repeat(64)}` },
      { promptTemplateHash: null },
    ]) {
      expect(queryShape({ ...base, ...changed }), JSON.stringify(changed)).not.toBe(shape);
    }
  });
});
