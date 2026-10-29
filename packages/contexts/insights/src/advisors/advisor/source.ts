// SPDX-License-Identifier: MIT
/**
 * `advisor_sessions` and `advisor_session_steps` (migration 0061): where an
 * advisor conversation and every model call made for it are kept (WP 11.5d).
 *
 *   * `createAdvisorSession` — the api's write: `clarifying` for a question the
 *     pre-check passed, or already finished for one it did not (no job, no
 *     model);
 *   * `claimAdvisorStep` — **one model call per step**: under the session row's
 *     lock and only while the session is in that step's status, an
 *     `advisor_session_steps` row is inserted with the step's run id, input
 *     digest, provider and model — and the table's UNIQUE (session, step)
 *     leaves room for exactly one. A second pass finds the claim and asks
 *     nothing;
 *   * `transitionAdvisorSession` — every transition is conditional on the
 *     status it leaves, so it is made once.
 */
import { newId } from '@core/kernel';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  ADVISOR_SESSION_OPEN,
  advisorSessions,
  advisorSessionSteps,
  type AdvisorSessionRow,
  type AdvisorSessionStatus,
  type AdvisorSessionStepRow,
  type AdvisorStep,
  type AdvisorStepOutcome,
  type NewAdvisorSessionRow,
} from '../../../schema/index.ts';
import type { InsightsContext, InsightsExecutor } from '../../db.ts';

export type StoredAdvisorSession = AdvisorSessionRow;
export type StoredAdvisorStep = AdvisorSessionStepRow;

export async function findAdvisorSession(
  executor: InsightsExecutor,
  userId: string,
  sessionId: string,
): Promise<StoredAdvisorSession | null> {
  const rows = await executor
    .select()
    .from(advisorSessions)
    .where(and(eq(advisorSessions.userId, userId), eq(advisorSessions.id, sessionId)));
  return rows[0] ?? null;
}

/** This holder's sessions, newest first. */
export async function listAdvisorSessions(
  executor: InsightsExecutor,
  userId: string,
  limit = 20,
): Promise<readonly StoredAdvisorSession[]> {
  return executor
    .select()
    .from(advisorSessions)
    .where(eq(advisorSessions.userId, userId))
    .orderBy(desc(advisorSessions.createdAt), desc(advisorSessions.id))
    .limit(Math.max(1, Math.min(100, limit)));
}

/** Every tracked session of this holder (the follow-up job's read). */
export async function listTrackedAdvisorSessions(
  executor: InsightsExecutor,
  userId: string,
): Promise<readonly StoredAdvisorSession[]> {
  return executor
    .select()
    .from(advisorSessions)
    .where(and(eq(advisorSessions.userId, userId), eq(advisorSessions.status, 'tracked')))
    .orderBy(asc(advisorSessions.createdAt));
}

/** A session of this holder with a model step due, created after `since`, if any. */
export async function busyAdvisorSession(
  executor: InsightsExecutor,
  userId: string,
  since: Date,
): Promise<StoredAdvisorSession | null> {
  const rows = await executor
    .select()
    .from(advisorSessions)
    .where(
      and(
        eq(advisorSessions.userId, userId),
        sql`(${advisorSessions.status} IN ('gathering', 'options', 'tradeoffs', 'planning')
             OR (${advisorSessions.status} = 'clarifying' AND ${advisorSessions.clarification} IS NULL))`,
        sql`${advisorSessions.updatedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(advisorSessions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAdvisorSteps(
  executor: InsightsExecutor,
  userId: string,
  sessionId: string,
): Promise<readonly StoredAdvisorStep[]> {
  return executor
    .select()
    .from(advisorSessionSteps)
    .where(
      and(eq(advisorSessionSteps.userId, userId), eq(advisorSessionSteps.sessionId, sessionId)),
    )
    .orderBy(asc(advisorSessionSteps.createdAt));
}

export type AdvisorSessionOpening =
  | { readonly status: 'clarifying' }
  | { readonly status: 'refused'; readonly refusal: string }
  | {
      readonly status: 'unanswerable';
      readonly reason: 'out_of_scope' | 'not_computable';
      readonly topic: string | null;
      readonly nearestScreen: string;
    };

/**
 * WP 11.5e: the finding a "Talk this through" session was opened from. Written
 * whole or not at all (0062's `advisor_sessions_origin_pair`).
 */
export interface AdvisorSessionOrigin {
  readonly insightRef: string;
  readonly ruleId: string;
  readonly title: string;
  readonly briefWeek: string | null;
}

export async function createAdvisorSession(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly question: string;
    readonly catalogueVersion: string;
    readonly tokenBudget: number;
    readonly opening: AdvisorSessionOpening;
    readonly origin?: AdvisorSessionOrigin | null;
  },
): Promise<StoredAdvisorSession> {
  const now = context.clock.now();
  const { opening } = input;
  const rows = await executor
    .insert(advisorSessions)
    .values({
      id: newId(),
      userId: context.userId,
      question: input.question,
      status: opening.status,
      catalogueVersion: input.catalogueVersion,
      refusal: opening.status === 'refused' ? opening.refusal : null,
      unanswerableReason: opening.status === 'unanswerable' ? opening.reason : null,
      unanswerableTopic: opening.status === 'unanswerable' ? opening.topic : null,
      nearestScreen: opening.status === 'unanswerable' ? opening.nearestScreen : null,
      tokenBudget: input.tokenBudget,
      tokensUsed: 0,
      originInsightRef: input.origin?.insightRef ?? null,
      originRuleId: input.origin?.ruleId ?? null,
      originTitle: input.origin?.title ?? null,
      originBriefWeek: input.origin?.briefWeek ?? null,
      createdAt: now,
      updatedAt: now,
      finishedAt: opening.status === 'clarifying' ? null : now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('failed to create an advisor session');
  return row;
}

/** What a step may expect of its session when it is claimed. */
export interface StepClaimCondition {
  readonly status: AdvisorSessionStatus;
}

/**
 * Claim one step's model call, in the caller's transaction. `false` when the
 * step was already claimed (the UNIQUE leaves room for one row) or the session
 * is not in the step's status.
 */
export async function claimAdvisorStep(
  executor: InsightsExecutor,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly step: AdvisorStep;
    readonly expect: StepClaimCondition;
    readonly runId: string;
    readonly inputDigest: string;
    readonly provider: string;
    readonly model: string;
    readonly egress: 'local' | 'hosted';
    readonly now: Date;
  },
): Promise<boolean> {
  const locked = await executor.execute<{ status: string }>(sql`
    SELECT status FROM advisor_sessions
     WHERE user_id = ${input.userId} AND id = ${input.sessionId}
     FOR UPDATE
  `);
  if (locked.rows[0]?.status !== input.expect.status) return false;
  const rows = await executor
    .insert(advisorSessionSteps)
    .values({
      id: newId(),
      userId: input.userId,
      sessionId: input.sessionId,
      step: input.step,
      runId: input.runId,
      inputDigest: input.inputDigest,
      llmProvider: input.provider,
      llmModel: input.model.slice(0, 200),
      egress: input.egress,
      createdAt: input.now,
    })
    .onConflictDoNothing({ target: [advisorSessionSteps.sessionId, advisorSessionSteps.step] })
    .returning({ id: advisorSessionSteps.id });
  return rows.length > 0;
}

/** The step's outcome, written once. */
export async function finishAdvisorStep(
  executor: InsightsExecutor,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly step: AdvisorStep;
    readonly outcome: AdvisorStepOutcome;
    readonly refusal?: string | null;
    readonly errorCode?: string | null;
    readonly knowledgeRead?: Record<string, unknown> | null;
    readonly tokens?: number | null;
    readonly durationMs?: number | null;
    readonly now: Date;
  },
): Promise<void> {
  await executor
    .update(advisorSessionSteps)
    .set({
      outcome: input.outcome,
      refusal: input.outcome === 'refused' ? (input.refusal ?? 'unknown.refused') : null,
      errorCode:
        input.errorCode === undefined || input.errorCode === null
          ? null
          : input.errorCode.slice(0, 64),
      knowledgeRead: input.knowledgeRead ?? null,
      tokens: input.tokens ?? null,
      durationMs:
        input.durationMs === undefined || input.durationMs === null
          ? null
          : Math.max(0, Math.round(input.durationMs)),
      finishedAt: input.now,
    })
    .where(
      and(
        eq(advisorSessionSteps.userId, input.userId),
        eq(advisorSessionSteps.sessionId, input.sessionId),
        eq(advisorSessionSteps.step, input.step),
        sql`${advisorSessionSteps.outcome} IS NULL`,
      ),
    );
}

export type AdvisorSessionFields = Partial<
  Pick<
    NewAdvisorSessionRow,
    | 'clarification'
    | 'answers'
    | 'gathered'
    | 'contextDigest'
    | 'options'
    | 'tradeoffs'
    | 'pickedOption'
    | 'plan'
    | 'watcherId'
    | 'watcher'
    | 'judgeScore'
    | 'judgeRunId'
    | 'judgeDetail'
    | 'judgeError'
    | 'refusal'
    | 'unanswerableReason'
    | 'unanswerableTopic'
    | 'nearestScreen'
    | 'errorCode'
    | 'hostedWindowLeft'
  >
>;

const FINAL: ReadonlySet<AdvisorSessionStatus> = new Set([
  'tracked',
  'completed',
  'refused',
  'unanswerable',
  'failed',
  'cancelled',
]);

/**
 * `from → to`, with fields, made once: only a session in one of `from` moves.
 * `to` omitted keeps the status (a field written within a status). A final
 * status stamps `finished_at`.
 */
export async function transitionAdvisorSession(
  executor: InsightsExecutor,
  context: Pick<InsightsContext, 'userId' | 'clock'>,
  input: {
    readonly sessionId: string;
    readonly from: readonly AdvisorSessionStatus[];
    readonly to?: AdvisorSessionStatus;
    readonly fields?: AdvisorSessionFields;
    /** Extra SQL condition (a field still null, say). */
    readonly where?: ReturnType<typeof sql>;
  },
): Promise<StoredAdvisorSession | null> {
  const now = context.clock.now();
  const fields = { ...(input.fields ?? {}) };
  if (fields.errorCode !== undefined && fields.errorCode !== null) {
    fields.errorCode = fields.errorCode.slice(0, 64);
  }
  const rows = await executor
    .update(advisorSessions)
    .set({
      ...fields,
      ...(input.to === undefined ? {} : { status: input.to }),
      ...(input.to !== undefined && FINAL.has(input.to) ? { finishedAt: now } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(advisorSessions.userId, context.userId),
        eq(advisorSessions.id, input.sessionId),
        inArray(advisorSessions.status, [...input.from]),
        ...(input.where === undefined ? [] : [input.where]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Add a call's tokens (and, hosted, the window it left) to the session's count. */
export async function recordAdvisorTokens(
  executor: InsightsExecutor,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly tokens: number;
    readonly windowLeft: number | null;
  },
): Promise<void> {
  await executor
    .update(advisorSessions)
    .set({
      tokensUsed: sql`${advisorSessions.tokensUsed} + ${Math.max(0, Math.round(input.tokens))}`,
      ...(input.windowLeft === null ? {} : { hostedWindowLeft: Math.max(0, input.windowLeft) }),
    })
    .where(and(eq(advisorSessions.userId, input.userId), eq(advisorSessions.id, input.sessionId)));
}

/** Every open status: what cancel may close. */
export const ADVISOR_CANCELLABLE: readonly AdvisorSessionStatus[] = ADVISOR_SESSION_OPEN;

/**
 * WP 11.5e: the sessions behind the Brief's follow-up items, by watcher id
 * (the item's key is `advisor.follow_up.<watcher id>`): tracked or completed.
 */
export async function findAdvisorSessionsByWatcher(
  executor: InsightsExecutor,
  userId: string,
  watcherIds: readonly string[],
): Promise<readonly StoredAdvisorSession[]> {
  if (watcherIds.length === 0) return [];
  return executor
    .select()
    .from(advisorSessions)
    .where(
      and(
        eq(advisorSessions.userId, userId),
        inArray(advisorSessions.watcherId, [...watcherIds]),
        inArray(advisorSessions.status, ['tracked', 'completed']),
      ),
    );
}
