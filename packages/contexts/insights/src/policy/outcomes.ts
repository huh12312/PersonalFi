// SPDX-License-Identifier: MIT
/**
 * Outcome verification (09 ADV-4) and forward validation — the §1 cut-line-2
 * substitute for 07 §8.2's point-in-time backtest, which needs a bitemporal
 * store this phase does not build.
 *
 * ## What "forward validation" can say, and what it cannot
 *
 * From the day this migration lands, every acceptance opens exactly one
 * `insight_outcomes` row, with `due_at` fixed at `accepted_at + horizon_days`
 * (60 by default). At its horizon, the row is judged against exactly one
 * fact: has `insights.last_proposed_at` — the identity row's own most recent
 * proposal — moved past `due_at`? If it has, the advisor kept finding the
 * same problem after the holder said "done"; the outcome is `INCOMPLETE`.
 * If it has not, the problem stopped recurring; the outcome is `ACTED`.
 *
 * That is a real claim — **forward-only, because `last_proposed_at` can only
 * advance, and the comparison is always against `due_at`, fixed at
 * acceptance, never against anything that predates it.** It is not 07 §8.2's
 * backtest: there is no counterfactual re-evaluation of the rule against
 * restated history, no `predicted_impact` vs `realized_impact` scatter, and
 * no way to ask "would this insight have fired a month earlier with today's
 * categorisation?" — those all need `valid_time`/`knowledge_time` on the
 * underlying facts, which this phase does not add (05 §6 Q4). What it buys
 * is a genuine, un-fakeable precision number *from now on*, per rule, on
 * `rule-health.ts`'s read. What it cannot buy is a single day of calibration
 * over history already accumulated without a knowledge time — that history
 * has no "before" to validate against, and no query here can manufacture one.
 *
 * ## "Exactly one follow-up"
 *
 * `evaluateDueOutcomes` only ever updates a row whose `outcome IS NULL`, and
 * the `UPDATE` itself repeats that guard — so calling it twice, or twice
 * concurrently, writes the verdict once. There is no separate "follow-up"
 * artefact in this migration; the follow-up *is* the outcome row moving from
 * pending to decided, once.
 */
import { and, eq, isNull, lte } from 'drizzle-orm';
import { newId } from '@core/kernel';
import type { InsightsContext, InsightsExecutor } from '../db.ts';
import {
  insightOutcomes,
  insights,
  type InsightOutcomeRow,
  type OutcomeValue,
} from '../../schema/index.ts';

/** 07 §8.3 names no number for this; 09 ADV-4's "re-run" carries no horizon
 * either, so the dispatch entry's own default is authoritative. */
export const OUTCOME_HORIZON_DAYS_DEFAULT = 60;

export function horizonDueAt(
  acceptedAt: Date,
  horizonDays: number = OUTCOME_HORIZON_DAYS_DEFAULT,
): Date {
  return new Date(acceptedAt.getTime() + horizonDays * 24 * 60 * 60 * 1000);
}

/**
 * The pure rule, isolated from the query that supplies its inputs: a
 * proposal instant counts as evidence of recurrence only when it is at or
 * after the reference point. `evaluateDueOutcomes` always calls this with
 * `referencePoint = dueAt`, never with anything earlier — a sabotage that
 * substituted `insights.firstProposedAt` (always earlier than the
 * acceptance that created the row) would make this `true` for every row
 * that had ever been proposed before it was accepted, which is every row.
 */
export function isForwardProposal(candidateProposedAt: Date, referencePoint: Date): boolean {
  return candidateProposedAt.getTime() > referencePoint.getTime();
}

/** `null` when `now` has not reached `dueAt` yet — not due, not evaluable. */
export function verdictFor(lastProposedAt: Date, dueAt: Date, now: Date): OutcomeValue | null {
  if (now.getTime() < dueAt.getTime()) return null;
  return isForwardProposal(lastProposedAt, dueAt) ? 'INCOMPLETE' : 'ACTED';
}

/**
 * Open (or reopen) verification for an accepted insight.
 *
 * Idempotent per `(userId, insightId)`: accept → reopen → accept again resets
 * the clock rather than accumulating a second, stale horizon — the unique
 * index `insight_outcomes_user_insight_idx` is the conflict target.
 */
export async function recordOutcomeOnAccept(
  executor: InsightsExecutor,
  context: InsightsContext,
  insight: { readonly id: string; readonly advisorId: string; readonly key: string },
  now: Date,
  horizonDays: number = OUTCOME_HORIZON_DAYS_DEFAULT,
): Promise<InsightOutcomeRow> {
  const dueAt = horizonDueAt(now, horizonDays);
  const rows = await executor
    .insert(insightOutcomes)
    .values({
      id: newId(),
      userId: context.userId,
      insightId: insight.id,
      advisorId: insight.advisorId,
      insightKey: insight.key,
      acceptedAt: now,
      horizonDays,
      dueAt,
      outcome: null,
      evaluatedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [insightOutcomes.userId, insightOutcomes.insightId],
      set: {
        acceptedAt: now,
        horizonDays,
        dueAt,
        outcome: null,
        evaluatedAt: null,
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`failed to record outcome for insight ${insight.id}`);
  return row;
}

/**
 * Evaluate every outcome row that is due and not yet decided.
 *
 * One query joins each pending row to its insight's current
 * `last_proposed_at`; the `UPDATE ... WHERE outcome IS NULL` beneath it is
 * the "exactly one follow-up" guarantee under concurrent or repeated calls —
 * a second evaluator racing this one updates zero rows the first one already
 * decided.
 */
export async function evaluateDueOutcomes(
  executor: InsightsExecutor,
  context: InsightsContext,
  now: Date,
): Promise<readonly InsightOutcomeRow[]> {
  const due = await executor
    .select({
      id: insightOutcomes.id,
      dueAt: insightOutcomes.dueAt,
      lastProposedAt: insights.lastProposedAt,
    })
    .from(insightOutcomes)
    .innerJoin(insights, eq(insights.id, insightOutcomes.insightId))
    .where(
      and(
        eq(insightOutcomes.userId, context.userId),
        isNull(insightOutcomes.outcome),
        lte(insightOutcomes.dueAt, now),
      ),
    );

  const evaluated: InsightOutcomeRow[] = [];
  for (const candidate of due) {
    const verdict = verdictFor(candidate.lastProposedAt, candidate.dueAt, now);
    if (verdict === null) continue; // defensive: the WHERE above already excludes this
    const rows = await executor
      .update(insightOutcomes)
      .set({ outcome: verdict, evaluatedAt: now, updatedAt: now })
      .where(
        and(
          eq(insightOutcomes.userId, context.userId),
          eq(insightOutcomes.id, candidate.id),
          isNull(insightOutcomes.outcome),
        ),
      )
      .returning();
    const row = rows[0];
    if (row !== undefined) evaluated.push(row);
  }
  return evaluated;
}

/** For `rule-health.ts`: outcomes grouped by verdict, `null` counted as pending. */
export interface OutcomeCounts {
  readonly acted: number;
  readonly incomplete: number;
  readonly pending: number;
}
