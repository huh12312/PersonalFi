// SPDX-License-Identifier: MIT
/**
 * `ask_sessions` (migration 0060): where a question and everything done for
 * it is kept (WP 11.5c).
 *
 *   * `createAskSession` — written by the api: `compiling` for a question the
 *     pre-check passed, or already finished (`refused` / `unanswerable`) for
 *     one it did not, in which case no job is enqueued and no model is asked.
 *   * `claimAskStep` — **one model call per step**: the step's run id, input
 *     digest, provider and model are written onto the row in the transaction
 *     that opens the run, only while the step is unclaimed and the session is
 *     in that step's status. A second job finds the claim and asks nothing.
 *   * `advanceAskSession` / `finishAskSession` — every transition is
 *     conditional on the status it leaves, so a transition is made once.
 */
import { newId } from '@core/kernel';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  askSessions,
  ASK_SESSION_IN_FLIGHT,
  type AskSessionRow,
  type AskSessionStatus,
  type AskUnanswerableReason,
} from '../../../schema/index.ts';
import type { InsightsContext, InsightsExecutor } from '../../db.ts';
import type { AskCompiledCall } from './compile.ts';
import type { AskResultView } from './results.ts';

export type StoredAskSession = AskSessionRow;

export async function findAskSession(
  executor: InsightsExecutor,
  userId: string,
  sessionId: string,
): Promise<StoredAskSession | null> {
  const rows = await executor
    .select()
    .from(askSessions)
    .where(and(eq(askSessions.userId, userId), eq(askSessions.id, sessionId)));
  return rows[0] ?? null;
}

/** This holder's questions, newest first. */
export async function listAskSessions(
  executor: InsightsExecutor,
  userId: string,
  limit = 20,
): Promise<readonly StoredAskSession[]> {
  return executor
    .select()
    .from(askSessions)
    .where(eq(askSessions.userId, userId))
    .orderBy(desc(askSessions.createdAt), desc(askSessions.id))
    .limit(Math.max(1, Math.min(100, limit)));
}

/** A session of this holder's still in flight and created after `since`, if any. */
export async function inFlightAskSession(
  executor: InsightsExecutor,
  userId: string,
  since: Date,
): Promise<StoredAskSession | null> {
  const rows = await executor
    .select()
    .from(askSessions)
    .where(
      and(
        eq(askSessions.userId, userId),
        inArray(askSessions.status, [...ASK_SESSION_IN_FLIGHT]),
        sql`${askSessions.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(askSessions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export type AskSessionOpening =
  | { readonly status: 'compiling' }
  | { readonly status: 'refused'; readonly refusal: string }
  | {
      readonly status: 'unanswerable';
      readonly reason: AskUnanswerableReason;
      readonly topic: string | null;
      readonly nearestScreen: string;
    };

export async function createAskSession(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly question: string;
    readonly catalogueVersion: string;
    readonly opening: AskSessionOpening;
  },
): Promise<StoredAskSession> {
  const now = context.clock.now();
  const { opening } = input;
  const rows = await executor
    .insert(askSessions)
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
      createdAt: now,
      finishedAt: opening.status === 'compiling' ? null : now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('failed to create an ask session');
  return row;
}

/** Claim one step's model call. `false` when it was already claimed, or the session is not in that step. */
export async function claimAskStep(
  executor: InsightsExecutor,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly step: 'compile' | 'narrate';
    readonly runId: string;
    readonly inputDigest: string;
    readonly provider: string;
    readonly model: string;
  },
): Promise<boolean> {
  const model = input.model.slice(0, 200);
  const rows =
    input.step === 'compile'
      ? await executor
          .update(askSessions)
          .set({
            compileRunId: input.runId,
            compileInputDigest: input.inputDigest,
            llmProvider: input.provider,
            llmModel: model,
          })
          .where(
            and(
              eq(askSessions.userId, input.userId),
              eq(askSessions.id, input.sessionId),
              eq(askSessions.status, 'compiling'),
              isNull(askSessions.compileRunId),
            ),
          )
          .returning({ id: askSessions.id })
      : await executor
          .update(askSessions)
          .set({
            narrateRunId: input.runId,
            narrateInputDigest: input.inputDigest,
            llmProvider: input.provider,
            llmModel: model,
          })
          .where(
            and(
              eq(askSessions.userId, input.userId),
              eq(askSessions.id, input.sessionId),
              eq(askSessions.status, 'narrating'),
              isNull(askSessions.narrateRunId),
            ),
          )
          .returning({ id: askSessions.id });
  return rows.length > 0;
}

export interface AskSessionFields {
  readonly compiledCalls?: readonly AskCompiledCall[];
  readonly results?: readonly AskResultView[];
  readonly narrationText?: string;
  readonly refusal?: string;
  readonly unanswerable?: {
    readonly reason: AskUnanswerableReason;
    readonly topic: string | null;
    readonly nearestScreen: string;
  };
  readonly errorCode?: string;
  readonly knowledgeRead?: Record<string, unknown>;
  readonly compileMs?: number;
  readonly callsMs?: number;
  readonly narrateMs?: number;
}

function fieldsOf(fields: AskSessionFields): Partial<typeof askSessions.$inferInsert> {
  return {
    ...(fields.compiledCalls === undefined
      ? {}
      : {
          compiledCalls: fields.compiledCalls.map((call) => ({
            name: call.name,
            args: call.args,
          })),
        }),
    ...(fields.results === undefined
      ? {}
      : { results: fields.results as unknown as Record<string, unknown>[] }),
    ...(fields.narrationText === undefined ? {} : { narrationText: fields.narrationText }),
    ...(fields.refusal === undefined ? {} : { refusal: fields.refusal }),
    ...(fields.unanswerable === undefined
      ? {}
      : {
          unanswerableReason: fields.unanswerable.reason,
          unanswerableTopic: fields.unanswerable.topic,
          nearestScreen: fields.unanswerable.nearestScreen,
        }),
    ...(fields.errorCode === undefined ? {} : { errorCode: fields.errorCode.slice(0, 64) }),
    ...(fields.knowledgeRead === undefined ? {} : { knowledgeRead: fields.knowledgeRead }),
    ...(fields.compileMs === undefined
      ? {}
      : { compileMs: Math.max(0, Math.round(fields.compileMs)) }),
    ...(fields.callsMs === undefined ? {} : { callsMs: Math.max(0, Math.round(fields.callsMs)) }),
    ...(fields.narrateMs === undefined
      ? {}
      : { narrateMs: Math.max(0, Math.round(fields.narrateMs)) }),
  };
}

/** `from → to` for an in-flight transition. `false` when the session was not in `from`. */
export async function advanceAskSession(
  executor: InsightsExecutor,
  input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly from: AskSessionStatus;
    readonly to: 'running' | 'narrating';
    readonly fields?: AskSessionFields;
  },
): Promise<boolean> {
  const rows = await executor
    .update(askSessions)
    .set({ status: input.to, ...fieldsOf(input.fields ?? {}) })
    .where(
      and(
        eq(askSessions.userId, input.userId),
        eq(askSessions.id, input.sessionId),
        eq(askSessions.status, input.from),
      ),
    )
    .returning({ id: askSessions.id });
  return rows.length > 0;
}

export type AskFinalStatus = Exclude<AskSessionStatus, 'compiling' | 'running' | 'narrating'>;

/** The outcome, written once: only a session still in flight is finished. */
export async function finishAskSession(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly sessionId: string;
    readonly status: AskFinalStatus;
    readonly fields?: AskSessionFields;
  },
): Promise<StoredAskSession | null> {
  const rows = await executor
    .update(askSessions)
    .set({ status: input.status, ...fieldsOf(input.fields ?? {}), finishedAt: context.clock.now() })
    .where(
      and(
        eq(askSessions.userId, context.userId),
        eq(askSessions.id, input.sessionId),
        inArray(askSessions.status, [...ASK_SESSION_IN_FLIGHT]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
