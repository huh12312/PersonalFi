// SPDX-License-Identifier: MIT
/**
 * WP 2.12 sabotage finding: `apps/api/src/platform.ts`'s own module comment
 * claims "a module whose flag is off contributes no events, no consumers, no
 * job handlers, and no schedules" (08 §6.9) — dispatch §3's exact wording is
 * "a module flag off registers no consumer" — but nothing in this repo ever
 * calls `resolveModules()` itself. Every wiring test that touches
 * `appModules()` (`apps/api/test/db/{categorization-wiring,phase2-wiring,
 * phase1-seed-e2e}.test.ts`) builds its own consumer pump directly from
 * `appModules()`'s raw registration array, bypassing the flag-gating function
 * entirely — `categorization-wiring.test.ts`'s own header says so explicitly
 * ("`apps/api/src/app.ts` never calls `appModules()`/`resolveModules()` —
 * that only happens in `worker.ts`"). `resolveModules` is only ever exercised
 * in production, inside `worker.ts`'s `main()`.
 *
 * This is a pure unit test — no database, no real flag rows — because
 * `resolveModules` only touches the two fields of `Platform` it actually
 * reads (`flags.isEnabled`, `registry.registerAll`); a fake standing in for
 * those two is a faithful test of the gating logic itself, not of
 * `createFlagService`'s own SQL (which `@core/platform`'s own suite covers).
 */
import { createEventRegistry, defineEvent, defineJob, registerConsumer } from '@core/platform';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resolveModules, type ModuleRegistration, type Platform } from '../src/platform.ts';

const FAKE_EVENT = defineEvent({
  type: 'wp212.FakeEvent',
  version: 1,
  aggregateType: 'test',
  description: 'A fake event, only for this file.',
  schema: z.object({}),
});

function fakePlatform(enabledFlagKeys: ReadonlySet<string>): Platform {
  return {
    db: undefined as never, // resolveModules never touches platform.db
    metrics: undefined as never, // or platform.metrics
    flags: {
      isEnabled: async (_userId: string, flagKey: string) => enabledFlagKeys.has(flagKey),
    } as Platform['flags'],
    registry: createEventRegistry(),
  };
}

describe('resolveModules (apps/api/src/platform.ts)', () => {
  it('a module flag off registers no consumer, no job, and never calls its schedules — a flag on registers all three', async () => {
    const onConsumerHandler = vi.fn();
    const offConsumerHandler = vi.fn();
    const onSchedules = vi.fn(async () => undefined);
    const offSchedules = vi.fn(async () => undefined);

    const onModule: ModuleRegistration = {
      flagKey: 'wp2.12.module.on',
      events: [FAKE_EVENT],
      consumers: [registerConsumer('wp2.12.on@v1', onConsumerHandler)],
      jobs: [defineJob('wp2.12.on.job', () => undefined)],
      schedules: onSchedules,
    };
    const offModule: ModuleRegistration = {
      flagKey: 'wp2.12.module.off',
      events: [FAKE_EVENT],
      consumers: [registerConsumer('wp2.12.off@v1', offConsumerHandler)],
      jobs: [defineJob('wp2.12.off.job', () => undefined)],
      schedules: offSchedules,
    };

    const platform = fakePlatform(new Set(['wp2.12.module.on']));
    const result = await resolveModules(platform, 'user-1', [onModule, offModule]);

    expect(result.enabled).toEqual(['wp2.12.module.on']);
    expect(result.disabled).toEqual(['wp2.12.module.off']);

    // The off module contributes literally nothing.
    expect(result.consumers.map((c) => c.name)).toEqual(['wp2.12.on@v1']);
    expect(result.jobs.map((j) => j.kind)).toEqual(['wp2.12.on.job']);
    expect(offSchedules).not.toHaveBeenCalled();

    // The on module contributes everything, including its schedule call.
    expect(onSchedules).toHaveBeenCalledTimes(1);
    expect(onSchedules).toHaveBeenCalledWith('user-1');
  });
});
