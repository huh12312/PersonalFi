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
 * itself what it can narrate; this job only asks it to run — and only when
 * `BriefJobDependencies.narratorConfigured` is true (W-C's decision,
 * `apps/api/src/modules.ts`'s `insightsModule`, the same flag that decides
 * whether the narrator is registered at all). With no model configured this
 * job enqueues nothing for it: publishing does not depend on the model, and
 * neither does the choice of whether to ask it to say anything.
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
import { MAX_NARRATED_FINDINGS } from '../contract/request.ts';
import { RUN_LOCAL_JOB_KIND } from '../jobs.ts';
import { BriefPublished } from '../events.ts';
import { assembleBrief } from './assembly.ts';
import { HEALTH_SNAPSHOT_SCOPES, computeAndStoreHealthScore } from '../health/store.ts';
import { SnapshotBuilder } from '../snapshot/builder.ts';
import type { SnapshotPorts } from '../snapshot/ports.ts';
import { deriveTokenKey } from '../snapshot/tokens.ts';
import { isoWeekOf } from './iso-week.ts';
import { briefPrefetchIds } from '../advisors/explain/jobs.ts';
import type { RetirementImpactPort } from './ports.ts';
import type { BriefCandidate } from './candidate.ts';
import { ADVISOR_FOLLOW_UP_ADVISOR_ID } from '../advisors/advisor/manifest.ts';
import { briefProgressOf } from '../advisors/advisor/progress.ts';
import { findAdvisorSessionsByWatcher } from '../advisors/advisor/source.ts';
import type { InsightsExecutor } from '../db.ts';
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
  /**
   * Whether `local.narrator` is registered this boot — the same flag
   * `insightsModule` reads to decide whether to register it at all (W-C,
   * 05-phase-5-dispatch.md §4 W-C; this package's own §8 "Needs the
   * orchestrator" item 2 named the choice and left it to the composition
   * root). `false` (the default, matching kill level 2's own default):
   * nothing is enqueued on `insights.run_local` for the narrator, because
   * nothing would claim it — a bounded but real `job_runs` failure every
   * week otherwise, "unknown advisor local.narrator", `service.ts`'s
   * `runAdvisor` refusing what nothing has a handler for.
   */
  readonly narratorConfigured?: boolean;
  /**
   * WP 10.6 (D30): the same question per holder — does this holder have a
   * narrator (their chosen provider, or the local model), or Off? When bound
   * it replaces `narratorConfigured`. Off enqueues nothing: the Brief keeps
   * its own wording, as with no model at all.
   */
  readonly narratorConfiguredFor?: (userId: string) => Promise<boolean>;
  /**
   * WP 5.8 folded into the weekly job (05 §4 W-C: "the health score … folded
   * into the weekly job"; wp5.8-health.md §6): the same `SnapshotPorts` the
   * advisor-run path builds its snapshot from, and the token secret
   * `deriveTokenKey` needs. Both or neither — a composition root that binds
   * no ports gets a Brief and no score (logged, never a silent zero), which
   * is what `GET /insights/health-score`'s 404 then says.
   */
  readonly snapshotPorts?: SnapshotPorts;
  readonly tokenSecret?: string;
  /**
   * WP 11.3: prefetch "Explain this" for **the week's ranked items only** —
   * `briefPrefetchIds`, at most `EXPLAIN_PREFETCH_MAX` (five), in rank order,
   * never the backlog and never the attention list. The composition root
   * binds it (it owns the explain model's template hash, which the approval
   * check needs) and enqueues `insights.explain` only for an item the holder
   * could explain now (narrator on, the shape approved, the scopes granted)
   * and the cache does not already hold. Enqueued, never awaited: the Brief
   * never waits on a model. A failure here is logged; the Brief stands.
   */
  readonly explainPrefetch?: (input: {
    readonly userId: string;
    readonly insightIds: readonly string[];
    readonly correlationId: string;
  }) => Promise<void>;
  /**
   * WP 11.4 (G5-15): the Brief's own composition — once per **published**
   * Brief, after the per-item narrations above are enqueued. The composition
   * root binds it (it owns the model, the Brief's blocks and the wait for the
   * item narrations) and enqueues one `insights.brief_narrate` job; that job
   * asks the model at most once per Brief and announces the Brief
   * (`insights.BriefRecapReady`) whatever the model does. Enqueued, never
   * awaited past the enqueue: the Brief never waits on a model. A failure
   * here is logged; the Brief stands.
   */
  readonly briefNarration?: (input: {
    readonly userId: string;
    readonly briefId: string;
    readonly isoWeek: string;
    readonly correlationId: string;
  }) => Promise<void>;
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

      // WP 5.8: the health score is computed with the Brief each week,
      // independent of whether the week has anything material — a quiet week
      // still has a score. It reads the seven builtin-sourced scopes over a
      // `kind: 'builtin'` snapshot (the score is not an advisor and holds no
      // grant row; 09 TRD-6). A failure here is logged and does not fail the
      // Brief: the route answers "not computed" for the week rather than the
      // holder losing the Brief too.
      if (input.snapshotPorts !== undefined && input.tokenSecret !== undefined) {
        try {
          const built = await new SnapshotBuilder(input.snapshotPorts).build({
            userId: context.userId,
            kind: 'builtin',
            grantedScopes: HEALTH_SNAPSHOT_SCOPES,
            today: todayIn(clock, input.timeZone),
            baseCurrency: input.currencyCode,
            tokenKey: deriveTokenKey(input.tokenSecret, context.userId),
          });
          await computeAndStoreHealthScore(input.database, {
            userId: context.userId,
            isoWeek,
            snapshot: built.snapshot,
            clock,
          });
        } catch (error) {
          context.logger.warn(
            { job: BRIEF_JOB_KIND, isoWeek, err: error },
            'health score not computed this week; the Brief proceeds',
          );
        }
      } else {
        context.logger.info(
          { job: BRIEF_JOB_KIND, isoWeek },
          'health score not computed: no snapshot ports bound to the Brief job',
        );
      }

      const [candidates, advisorKinds, dismissRates, historyDays, carried] = await Promise.all([
        loadCandidates(input.database, context.userId, now),
        loadAdvisorKinds(input.database, context.userId),
        loadDismissRates(input.database, context.userId),
        historyDaysAsOf(input.database, context.userId, now),
        loadCarriedIdentities(input.database, context.userId, isoWeek),
      ]);

      const assembled = assembleBrief({
        candidates: await withBriefProgress(input.database, context.userId, candidates),
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
      // never delays a publish that has already happened. Gated on
      // `narratorConfigured` (W-C's decision, §8 item 2 of this package's
      // own evidence): with no model configured, `local.narrator` is never
      // registered (`insightsModule`), and enqueueing for it anyway would be
      // a job nothing claims — bounded, but a named failure every week on
      // every install with the local model off, which is the default.
      const narratorConfigured =
        input.narratorConfiguredFor === undefined
          ? (input.narratorConfigured ?? false)
          : await input.narratorConfiguredFor(context.userId);
      if (narratorConfigured) {
        // WP 9.5 (Phase 5 gate C5-2; G5-7, G5-15): the Brief narrates **its own
        // items**, one finding per job — `narrateInsightIds: [id]`, so the
        // narrator is sent the finding this Brief chose and not the feed's top
        // five, and each request is one bounded model call. `maxAttempts: 1`:
        // a failed narration (a `model_timeout` included) is not re-run by the
        // queue — the breaker already counts it, and re-asking a model whose
        // reply the validator refused is retry-until-valid.
        const items = [...assembled.ranked, ...assembled.attention].slice(0, MAX_NARRATED_FINDINGS);
        for (const item of items) {
          const insightId = item.candidate.insightId;
          await enqueueJob(platformOf(input.database), {
            kind: RUN_LOCAL_JOB_KIND,
            userId: context.userId,
            payload: {
              advisorId: WEEKLY_BRIEF_NARRATOR_ADVISOR_ID,
              trigger: 'event',
              triggerEventType: BriefPublished.type,
              narrateInsightIds: [insightId],
            },
            // WP 5.14 put `userId` in the key; WP 9.5 adds the item, so each
            // of the week's narrations has its own row.
            dedupeKey: `${RUN_LOCAL_JOB_KIND}:${WEEKLY_BRIEF_NARRATOR_ADVISOR_ID}:${context.userId}:${isoWeek}:${insightId}`,
            correlationId: context.correlationId,
            maxAttempts: 1,
          });
        }
      }

      if (input.explainPrefetch !== undefined) {
        const insightIds = briefPrefetchIds(
          assembled.ranked.map((item) => item.candidate.insightId),
        );
        try {
          await input.explainPrefetch({
            userId: context.userId,
            insightIds,
            correlationId: context.correlationId,
          });
        } catch (error) {
          context.logger.warn(
            { job: BRIEF_JOB_KIND, isoWeek, err: error },
            'Explain-this prefetch not enqueued; the Brief stands',
          );
        }
      }

      if (input.briefNarration !== undefined) {
        try {
          await input.briefNarration({
            userId: context.userId,
            briefId: published.id,
            isoWeek,
            correlationId: context.correlationId,
          });
        } catch (error) {
          context.logger.warn(
            { job: BRIEF_JOB_KIND, isoWeek, err: error },
            "the Brief's own narration not enqueued; the Brief stands",
          );
        }
      }
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

const FOLLOW_UP_KEY = /^advisor\.follow_up\.([0-9a-f-]{36})$/u;

/**
 * WP 11.5e: each follow-up candidate gains its plan's progress — the session
 * behind it (by the watcher id its key carries), tracked or completed — so the
 * Brief can report it and dedupe the finding it is working on. Read-only.
 */
export async function withBriefProgress(
  executor: InsightsExecutor,
  userId: string,
  candidates: readonly BriefCandidate[],
): Promise<readonly BriefCandidate[]> {
  const watcherIds = candidates.flatMap((candidate) => {
    if (candidate.advisorId !== ADVISOR_FOLLOW_UP_ADVISOR_ID) return [];
    const match = FOLLOW_UP_KEY.exec(candidate.key);
    return match === null ? [] : [match[1] ?? ''];
  });
  if (watcherIds.length === 0) return candidates;
  const sessions = await findAdvisorSessionsByWatcher(executor, userId, watcherIds);
  const byWatcher = new Map(sessions.map((session) => [session.watcherId, session]));
  return candidates.map((candidate) => {
    if (candidate.advisorId !== ADVISOR_FOLLOW_UP_ADVISOR_ID) return candidate;
    const match = FOLLOW_UP_KEY.exec(candidate.key);
    const session = match === null ? undefined : byWatcher.get(match[1] ?? '');
    if (session === undefined) return candidate;
    return { ...candidate, progress: briefProgressOf(session) };
  });
}
