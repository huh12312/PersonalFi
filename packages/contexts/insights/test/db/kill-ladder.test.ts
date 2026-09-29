// SPDX-License-Identifier: MIT
/**
 * The kill ladder, against a real Postgres and a run that is actually in
 * flight (WP 5.1; 05-phase-5-dispatch.md §3 and §5's risk row "a kill level
 * that does not actually stop an in-flight run").
 *
 * The advisor is a `local_model` fake that **blocks until aborted**: without
 * a working kill it waits for its 20-second deadline and the run closes
 * `failed`, so a broken level is a red with a reason, not a hang.
 *
 * Every level is flipped through the path production uses — the flag through
 * `FlagService.set`, the advisor through `setAdvisorEnabled` /
 * `quarantineAdvisor`, the run through `requestRunCancel` — and the time from
 * the flip to the run's return is measured in wall time and printed, which is
 * where the evidence's time-to-stop column comes from.
 *
 * **Sabotage record** (docs/evidence/phase-5/wp5.1-run-control.md §5): the
 * watcher removed → the in-flight cases red; the write barrier removed → the
 * barrier case red.
 */
import { platformExecutor, type FlagService } from '@core/platform';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisorRuns } from '../../schema/index.ts';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import type { InsightsContext } from '../../src/db.ts';
import { MODULE_FLAG_KEY } from '../../src/policy/kill-switches.ts';
import { revokePayloadApprovals } from '../../src/preview.ts';
import type { Advisor } from '../../src/registry.ts';
import { runAdvisor, type InsightsDependencies } from '../../src/service.ts';
import {
  clearQuarantine,
  quarantineAdvisor,
  requestRunCancel,
  setAdvisorEnabled,
} from '../../src/store.ts';
import { NO_DATABASE, contextFor, insightsDatabase, type TestDatabase } from './harness.ts';
import {
  LOCAL_FLAG,
  LOCAL_ID,
  answerFor,
  armAdvisor,
  blockingAdvisor,
  cancelledEvents,
  dependenciesFor,
  flagsFor,
  insightCount,
  liveSwitches,
  localManifest,
  wallMs,
} from './run-control-harness.ts';

type Level = 1 | 2 | 3 | 4;

interface Flip {
  readonly level: Level;
  readonly name: string;
  readonly expected: string;
  readonly flip: (input: {
    readonly database: TestDatabase;
    readonly context: InsightsContext;
    readonly flags: FlagService;
    readonly runId: string;
  }) => Promise<void>;
}

/** One kill per level, each through the path production uses. */
const FLIPS: readonly Flip[] = [
  {
    level: 1,
    name: 'module.insights off',
    expected: 'module_disabled',
    flip: async ({ database, context, flags }) =>
      flags.set(platformExecutor(database.db), context.userId, MODULE_FLAG_KEY, false),
  },
  {
    level: 2,
    name: 'advisors.kind.local_model off',
    expected: 'kind_disabled',
    flip: async ({ database, context, flags }) =>
      flags.set(platformExecutor(database.db), context.userId, LOCAL_FLAG, false),
  },
  {
    level: 3,
    name: 'advisors.enabled off',
    expected: 'advisor_disabled',
    flip: async ({ database, context }) => setAdvisorEnabled(database.db, context, LOCAL_ID, false),
  },
  {
    level: 4,
    name: 'POST …/cancel (requestRunCancel)',
    expected: 'run_cancelled',
    flip: async ({ database, context, runId }) => {
      expect(await requestRunCancel(database.db, context, runId)).toBe('requested');
    },
  },
];

/** The id of the run currently `started` for this advisor. */
async function startedRunId(database: TestDatabase): Promise<string> {
  const rows = await database.db
    .select({ id: advisorRuns.id })
    .from(advisorRuns)
    .where(and(eq(advisorRuns.advisorId, LOCAL_ID), eq(advisorRuns.status, 'started')));
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no started run');
  return id;
}

describe.skipIf(NO_DATABASE)('the kill ladder, in flight', () => {
  let database: TestDatabase;
  let flags: FlagService;
  let context: InsightsContext;

  beforeEach(async () => {
    database ??= await insightsDatabase('kill_ladder');
    await database.truncate();
    flags = flagsFor(database);
    context = contextFor(database.userId);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function armed(advisor: Advisor): Promise<InsightsDependencies> {
    const switches = liveSwitches(flags);
    const dependencies = dependenciesFor([advisor], switches);
    await armAdvisor(database, context, dependencies, flags, advisor.manifest);
    return dependencies;
  }

  describe('each of the four levels, flipped while a run is in flight, ends the run within two seconds and writes no insight', () => {
    for (const level of FLIPS) {
      it(`level ${level.level} — ${level.name}`, async () => {
        const advisor = blockingAdvisor(localManifest());
        const dependencies = await armed(advisor);

        const running = runAdvisor(database.db, context, dependencies, {
          advisorId: LOCAL_ID,
          trigger: 'manual',
          lane: 'local',
        });
        await advisor.started;
        const runId = await startedRunId(database);

        const flippedAt = wallMs();
        await level.flip({ database, context, flags, runId });
        const result = await running;
        const stopMs = wallMs() - flippedAt;
        // The evidence's time-to-stop column.
        console.info(
          `[kill-ladder] level ${level.level} (${level.name}): stopped in ${stopMs.toFixed(0)} ms`,
        );

        expect(result.status).toBe('cancelled');
        expect(result.cancelReason).toBe(level.expected);
        expect(stopMs).toBeLessThan(2_000);
        expect(advisor.aborted()).toBe(true);
        expect(await insightCount(database)).toBe(0);

        const [row] = await database.db
          .select()
          .from(advisorRuns)
          .where(eq(advisorRuns.id, result.runId));
        expect(row?.status).toBe('cancelled');
        expect(row?.cancelReason).toBe(level.expected);
        expect(row?.finishedAt).not.toBeNull();
        // It was allowed to start, so it built and sent something: the digest
        // of what the model saw before it was stopped is kept.
        expect(row?.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(row?.cancelRequestedAt === null).toBe(level.level !== 4);

        const events = await cancelledEvents(database, result.runId);
        expect(events).toEqual([
          expect.objectContaining({
            reason: level.expected,
            level: level.level,
            stage: 'in_flight',
          }),
        ]);
      }, 60_000);
    }
  });

  it('a run killed between the reply and the write lands nothing: the write barrier re-reads every switch', async () => {
    // The advisor flips the switch itself, in the instant before it answers:
    // after the watcher's last look (its first tick is a second away) and
    // before transaction 2. Only the barrier can see it. One case per level,
    // plus the quarantine half of level 3 and a revoked approval.
    const kills: readonly {
      readonly expected: string;
      readonly kill: (runId: string) => Promise<void>;
    }[] = [
      ...FLIPS.map((flip) => ({
        expected: flip.expected,
        kill: (runId: string) => flip.flip({ database, context, flags, runId }),
      })),
      {
        expected: 'advisor_quarantined',
        kill: () => quarantineAdvisor(database.db, context, LOCAL_ID, 'manual'),
      },
      {
        expected: 'payload_not_approved',
        kill: async () => {
          await revokePayloadApprovals(database.db, context, LOCAL_ID);
        },
      },
    ];

    for (const { expected, kill } of kills) {
      await database.truncate();
      const manifest: AdvisorManifest = localManifest();
      const advisor: Advisor = {
        manifest,
        run: async (request: AdvisorRequest) => {
          await kill(await startedRunId(database));
          return answerFor(request, manifest.kind);
        },
      };
      const dependencies = await armed(advisor);

      const result = await runAdvisor(database.db, context, dependencies, {
        advisorId: LOCAL_ID,
        trigger: 'manual',
        lane: 'local',
      });

      expect(result.status, expected).toBe('cancelled');
      expect(result.cancelReason, expected).toBe(expected);
      expect(await insightCount(database), expected).toBe(0);
      const events = await cancelledEvents(database, result.runId);
      expect(events, expected).toEqual([
        expect.objectContaining({ reason: expected, stage: 'write_barrier' }),
      ]);
    }

    // And the control: with no kill, the same advisor's answer lands.
    await database.truncate();
    const manifest = localManifest();
    const dependencies = await armed({
      manifest,
      run: (request) => Promise.resolve(answerFor(request, manifest.kind)),
    });
    const control = await runAdvisor(database.db, context, dependencies, {
      advisorId: LOCAL_ID,
      trigger: 'manual',
      lane: 'local',
    });
    expect(control.status).toBe('completed');
    expect(await insightCount(database)).toBe(1);
  }, 60_000);

  it('the refusal and the cancellation name the broadest level that applied', async () => {
    // Refusal: every switch off at once, then turned back on from the top;
    // each step must name exactly the broadest one still off.
    const advisor = blockingAdvisor(localManifest());
    const switches = liveSwitches(flags);
    const dependencies = dependenciesFor([advisor], switches);
    await armAdvisor(database, context, dependencies, flags, advisor.manifest);
    const db = platformExecutor(database.db);

    switches.operatorOn = false;
    await flags.set(db, context.userId, MODULE_FLAG_KEY, false);
    await flags.set(db, context.userId, LOCAL_FLAG, false);
    await setAdvisorEnabled(database.db, context, LOCAL_ID, false);
    await quarantineAdvisor(database.db, context, LOCAL_ID, 'manual');
    await revokePayloadApprovals(database.db, context, LOCAL_ID);

    const ladder: readonly [string, () => Promise<unknown>][] = [
      ['advisors_disabled', async () => undefined],
      ['module_disabled', async () => (switches.operatorOn = true)],
      ['kind_disabled', () => flags.set(db, context.userId, MODULE_FLAG_KEY, true)],
      ['advisor_disabled', () => flags.set(db, context.userId, LOCAL_FLAG, true)],
      ['advisor_quarantined', () => setAdvisorEnabled(database.db, context, LOCAL_ID, true)],
      ['payload_not_approved', () => clearQuarantine(database.db, context, LOCAL_ID)],
    ];
    for (const [expected, turnOn] of ladder) {
      await turnOn();
      const refused = await runAdvisor(database.db, context, dependencies, {
        advisorId: LOCAL_ID,
        trigger: 'manual',
        lane: 'local',
      });
      expect(refused.status, expected).toBe('refused');
      expect(refused.refusal, expected).toBe(expected);
    }
    expect(advisor.calls()).toBe(0);

    // Cancellation: three levels at once, in flight — the holder cancels,
    // switches the advisor off, and the module goes off. Module wins.
    await database.truncate();
    const second = blockingAdvisor(localManifest());
    const deps2 = dependenciesFor([second], liveSwitches(flags));
    await armAdvisor(database, context, deps2, flags, second.manifest);
    const running = runAdvisor(database.db, context, deps2, {
      advisorId: LOCAL_ID,
      trigger: 'manual',
      lane: 'local',
    });
    await second.started;
    const runId = await startedRunId(database);
    await requestRunCancel(database.db, context, runId);
    await setAdvisorEnabled(database.db, context, LOCAL_ID, false);
    await flags.set(db, context.userId, MODULE_FLAG_KEY, false);
    const cancelled = await running;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('module_disabled');
    expect(await cancelledEvents(database, runId)).toEqual([
      expect.objectContaining({ reason: 'module_disabled', level: 1 }),
    ]);
  }, 60_000);
});
