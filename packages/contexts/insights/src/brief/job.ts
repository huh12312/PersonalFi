// SPDX-License-Identifier: MIT
/**
 * `insights.brief` -- the weekly job, and the `insights.weekly_brief`
 * schedule (05-phase-5-dispatch.md §3 WP 5.6; §4 item 4, the composition
 * root's to register).
 *
 * Sunday 06:00 local, after the 04:15 advisor pass and the 04:30 projection
 * refresh (`jobs.ts`'s own `DEFAULT_ADVISOR_CRON` header) -- both need to have
 * run so the week's candidates and the baseline plan the retirement effect
 * reads are current. `registerWeeklyBriefSchedule` and `createBriefJob` are
 * declared here and **exported for the composition root** (W-C wiring, per
 * this package's `index.ts`): registering a job kind and a schedule is an
 * act `apps/api/src/modules.ts` performs, the same split `jobs.ts` already
 * makes for `insights.run_local`.
 *
 * The narration of this week's items is enqueued on `insights.run_local`
 * **after** publication, never awaited: the Brief is a deterministic
 * assembly over stored rows and a Money-facing engine call, and nothing in
 * it depends on the local model. `local.narrator` (WP 5.3) decides for
 * itself what it can narrate; this job only asks it to run.
 */
import { systemClock, todayIn, type Clock } from '@core/kernel';
import {
  appendEvent,
  defineJob,
  enqueueJob,
  upsertSchedule,
  type JobContext,
  type JobHandlerRegistration,
} from '@core/platform';
import { platformOf, type InsightsDatabase } from '../db.ts';
import { RUN_LOCAL_JOB_KIND } from '../jobs.ts';
import { BriefPublished } from '../events.ts';
import { assembleBrief } from './assembly.ts';
import { isoWeekOf } from './iso-week.ts';
import type { RetirementImpactPort } from './ports.ts';
import { retirementEffectOf } from './retirement.ts';
import {
  findBriefByWeek,
  historyDaysAsOf,
  loadAdvisorKinds,
  loadCandidates,
  loadCarriedIdentities,
  loadDismissRates,
  publishWeeklyBrief,
} from './store.ts';

export const BRIEF_JOB_KIND = 'insights.brief';
export const WEEKLY_BRIEF_SCHEDULE_NAME = 'insights.weekly_brief';
/** Sunday 06:00 local. */
export const DEFAULT_WEEKLY_BRIEF_CRON = '0 6 * * 0';
/**
 * WP 5.3's narrator, named verbatim by 05 §3's WP 5.3 entry —
 * `advisors/local/manifest.ts`'s own `NARRATOR_ADVISOR_ID` is the same
 * string; this file names its own constant rather than importing that one,
 * so this package's two Phase 5 work packages stay decoupled at the file
 * level exactly as their ownership split intends.
 */
export const WEEKLY_BRIEF_NARRATOR_ADVISOR_ID = 'local.narrator';

export interface BriefJobDependencies {
  readonly database: InsightsDatabase;
  readonly retirementImpactPort: RetirementImpactPort;
  readonly timeZone: string;
  readonly currencyCode: string;
  readonly clock?: Clock;
}

/**
 * `insights.brief` -- one holder, one ISO week, idempotent.
 *
 * `concurrency: 1`: two ticks the same minute would both read the same
 * candidates and both call the engine for every item; `publishWeeklyBrief`'s
 * `ON CONFLICT` makes a second write harmless, but there is no reason to pay
 * for the engine calls twice when one job slot already serialises them.
 */
export function createBriefJob(input: BriefJobDependencies): JobHandlerRegistration {
  return defineJob(
    BRIEF_JOB_KIND,
    async (_payload: unknown, context: JobContext) => {
      const clock = input.clock ?? systemClock;
      const now = clock.now();
      const isoWeek = isoWeekOf(todayIn(clock, input.timeZone));

      const already = await findBriefByWeek(input.database, context.userId, isoWeek);
      if (already !== null) {
        context.logger.info(
          { job: BRIEF_JOB_KIND, isoWeek, briefId: already.id },
          'weekly Brief already published; nothing to do',
        );
        return;
      }

      const [candidates, advisorKinds, dismissRates, historyDays, carried] = await Promise.all([
        loadCandidates(input.database, context.userId, now),
        loadAdvisorKinds(input.database, context.userId),
        loadDismissRates(input.database, context.userId),
        historyDaysAsOf(input.database, context.userId, now),
        loadCarriedIdentities(input.database, context.userId, isoWeek),
      ]);

      const assembled = assembleBrief({
        candidates,
        advisorKindOf: (advisorId) => advisorKinds.get(advisorId),
        dismissRateOf: (advisorId) => dismissRates.get(advisorId) ?? 0,
        carriedIdentities: carried,
        currencyCode: input.currencyCode,
        historyDays,
      });

      const published = await publishWeeklyBrief(input.database, {
        userId: context.userId,
        isoWeek,
        currencyCode: input.currencyCode,
        assembled,
        retirementEffectOf: retirementEffectOf(input.retirementImpactPort, context.userId),
        clock,
      });

      context.logger.info(
        {
          job: BRIEF_JOB_KIND,
          isoWeek,
          briefId: published.id,
          alreadyPublished: published.alreadyPublished,
          ranked: assembled.ranked.length,
          attention: assembled.attention.length,
          nothingMaterial: assembled.nothingMaterial,
          coldStart: assembled.coldStart,
        },
        'weekly Brief assembled',
      );

      // Edge-triggered, the InsightProposed precedent: a tick that found the
      // week already published emitted nothing above and enqueues nothing
      // below, so replaying the job or a schedule that ticks twice
      // announces and narrates nothing twice.
      if (published.alreadyPublished) return;

      await appendEvent(
        platformOf(input.database),
        BriefPublished.create(
          {
            briefId: published.id,
            isoWeek,
            rankedCount: assembled.ranked.length,
            attentionCount: assembled.attention.length,
            nothingMaterial: assembled.nothingMaterial,
            coldStart: assembled.coldStart,
          },
          {
            userId: context.userId,
            aggregateId: published.id,
            correlationId: context.correlationId,
            causationId: null,
          },
        ),
      );

      // The Brief never waits on the model (05 §3 WP 5.6): enqueued, not
      // awaited, in the narrator's own lane so a slow or unavailable model
      // never delays a publish that has already happened.
      await enqueueJob(platformOf(input.database), {
        kind: RUN_LOCAL_JOB_KIND,
        userId: context.userId,
        payload: {
          advisorId: WEEKLY_BRIEF_NARRATOR_ADVISOR_ID,
          trigger: 'event',
          triggerEventType: BriefPublished.type,
        },
        dedupeKey: `${RUN_LOCAL_JOB_KIND}:${WEEKLY_BRIEF_NARRATOR_ADVISOR_ID}:${isoWeek}`,
        correlationId: context.correlationId,
      });
    },
    { concurrency: 1 },
  );
}

/**
 * Declare the weekly schedule. Called at boot, and only when `module.insights`
 * is on -- a disabled module registers no schedules (08 §6.9), the same rule
 * `jobs.ts#registerNightlySchedule` follows.
 */
export async function registerWeeklyBriefSchedule(
  database: InsightsDatabase,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(database),
    {
      userId: input.userId,
      name: WEEKLY_BRIEF_SCHEDULE_NAME,
      cron: input.cron ?? DEFAULT_WEEKLY_BRIEF_CRON,
      timezone: input.timezone,
      jobKind: BRIEF_JOB_KIND,
      enabled: true,
      // A few minutes of jitter, the nightly schedule's own reason: harmless
      // at one holder, free to have right for a fleet.
      jitterSeconds: 180,
    },
    clock,
  );
}
