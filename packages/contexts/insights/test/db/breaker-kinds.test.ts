// SPDX-License-Identifier: MIT
/**
 * The breaker, per kind (WP 5.1): 08 §4.4's "3 consecutive failures or 5
 * schema violations in 24h" for a `local_model` advisor; Phase 2's five
 * consecutive failures (or one mostly-refused run) for a `builtin`, unchanged.
 *
 * The builtin's five is **not** 08's three, and that is deliberate and
 * recorded rather than resolved here: docs/evidence/phase-5/wp5.1-run-control.md
 * §9.
 */
import { fixedClock } from '@core/kernel';
import { type FlagService } from '@core/platform';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisors } from '../../schema/index.ts';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import type { InsightsContext } from '../../src/db.ts';
import type { Advisor } from '../../src/registry.ts';
import { runAdvisor, type InsightsDependencies, type RunLane } from '../../src/service.ts';
import { responseFor } from '../fixtures.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  contextFor,
  insightsDatabase,
  selfCiting,
  type TestDatabase,
} from './harness.ts';
import {
  BUILTIN_ID,
  LOCAL_ID,
  armAdvisor,
  builtinManifest,
  dependenciesFor,
  flagsFor,
  liveSwitches,
  localManifest,
} from './run-control-harness.ts';

function failing(manifest: AdvisorManifest): Advisor {
  return { manifest, run: () => Promise.reject(new Error('model_unreachable')) };
}

describe.skipIf(NO_DATABASE)('the breaker, per kind', () => {
  let database: TestDatabase;
  let flags: FlagService;
  let context: InsightsContext;

  beforeEach(async () => {
    database ??= await insightsDatabase('breaker_kinds');
    await database.truncate();
    flags = flagsFor(database);
    context = contextFor(database.userId);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function quarantine(advisorId: string) {
    const [row] = await database.db
      .select({ at: advisors.quarantinedAt, reason: advisors.quarantineReason })
      .from(advisors)
      .where(and(eq(advisors.userId, database.userId), eq(advisors.advisorId, advisorId)));
    return row;
  }

  async function runs(
    dependencies: InsightsDependencies,
    advisorId: string,
    lane: RunLane,
    count: number,
    at: InsightsContext = context,
  ) {
    const results = [];
    for (let index = 0; index < count; index += 1) {
      results.push(
        await runAdvisor(database.db, at, dependencies, { advisorId, trigger: 'schedule', lane }),
      );
    }
    return results;
  }

  it('three consecutive local-model failures quarantine it; a builtin needs five', async () => {
    const local = failing(localManifest());
    const builtin = failing(builtinManifest());
    const dependencies = dependenciesFor([local, builtin], liveSwitches(flags));
    await armAdvisor(database, context, dependencies, flags, local.manifest);
    await armAdvisor(database, context, dependencies, flags, builtin.manifest);

    // The local model: two failures are a bad night, the third is a pattern.
    const localRuns = await runs(dependencies, LOCAL_ID, 'local', 2);
    expect(localRuns.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect((await quarantine(LOCAL_ID))?.at).toBeNull();
    const third = await runs(dependencies, LOCAL_ID, 'local', 1);
    expect(third[0]?.quarantined).toBe(true);
    expect(await quarantine(LOCAL_ID)).toEqual({
      at: expect.any(Date),
      reason: 'consecutive_failures',
    });
    const fourth = await runs(dependencies, LOCAL_ID, 'local', 1);
    expect(fourth[0]?.refusal).toBe('advisor_quarantined');

    // The builtin, same failures: still running after three, and four.
    const builtinRuns = await runs(dependencies, BUILTIN_ID, 'builtin', 4);
    expect(builtinRuns.map((r) => r.quarantined)).toEqual([false, false, false, false]);
    expect((await quarantine(BUILTIN_ID))?.at).toBeNull();
    const fifth = await runs(dependencies, BUILTIN_ID, 'builtin', 1);
    expect(fifth[0]?.quarantined).toBe(true);
    expect(await quarantine(BUILTIN_ID)).toEqual({
      at: expect.any(Date),
      reason: 'consecutive_failures',
    });
  }, 60_000);

  it('five validator rejections in a rolling 24 h quarantine a local model; older ones do not count', async () => {
    // Each run proposes one insight the validator refuses (a fabricated figure
    // in the summary), so each run *completes* — the streak never grows — and
    // only the rolling window can trip the breaker.
    const manifest = localManifest();
    const lying: Advisor = {
      manifest,
      run: (request: AdvisorRequest) =>
        Promise.resolve(
          responseFor(request, [
            selfCiting(request, {
              confidence_basis: 'model',
              confidence: 0.5,
              summary_md: 'You could save $4,812.19 a year here.',
            }),
          ]),
        ),
    };
    const dependencies = dependenciesFor([lying], liveSwitches(flags));
    await armAdvisor(database, context, dependencies, flags, manifest);

    const at = (iso: string): InsightsContext => ({
      userId: database.userId,
      clock: fixedClock(iso),
      correlationId: CORRELATION_ID,
      causationId: null,
    });

    // Three refusals on the 1st: nothing yet.
    const early = await runs(dependencies, LOCAL_ID, 'local', 3, at('2026-09-01T09:00:00.000Z'));
    expect(early.map((r) => [r.status, r.rejected])).toEqual([
      ['completed', 1],
      ['completed', 1],
      ['completed', 1],
    ]);
    // Four more on the 3rd: the 1st's three are outside the window, so four in 24 h.
    const later = await runs(dependencies, LOCAL_ID, 'local', 4, at('2026-09-03T09:00:00.000Z'));
    expect(later.some((r) => r.quarantined)).toBe(false);
    expect((await quarantine(LOCAL_ID))?.at).toBeNull();
    // The fifth in the window trips it.
    const fifth = await runs(dependencies, LOCAL_ID, 'local', 1, at('2026-09-03T10:00:00.000Z'));
    expect(fifth[0]?.quarantined).toBe(true);
    expect(await quarantine(LOCAL_ID)).toEqual({ at: expect.any(Date), reason: 'rejection_rate' });
  }, 60_000);
});
