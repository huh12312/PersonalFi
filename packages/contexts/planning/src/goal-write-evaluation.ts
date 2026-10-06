// SPDX-License-Identifier: MIT
/**
 * Goals are evaluated on write (Phase 4 gate G4-14).
 *
 * `runGoalEvaluation` runs from `ProjectionCompleted`, so a goal created,
 * re-targeted or re-funded after the day's baseline run waited for the next
 * *fresh* run — normally the next night, and on any day the snapshot cannot seal
 * (a missing FX rate, G3-12's shape) until one does. Latency, not a wrong
 * answer, but nothing on screen said the goal had not been looked at.
 *
 * `createGoal` and `updateGoal` call this after their own write, on the same
 * executor, so the goal row and its `planning.GoalOffTrack` are one fact or
 * none. It is the same verdict (`evaluateGoalPace`, over the same facts the
 * consumer reads, `goalEvaluationStoreOf`) and the same event.
 *
 * ## No claim, and why that is safe
 *
 * The consumer needs a per-run claim (`goals_evaluated_at`) because an event
 * *delivery* can repeat. A write cannot: it is one request in one transaction.
 * So the evaluation id is a fresh id and "once per evaluation" holds by
 * construction. Only the goal that was written is judged and announced; the
 * others were announced by the evaluation that covered them.
 *
 * ## What it skips
 *
 *   * No sealed net-worth day: the position the consumer is in too — a
 *     projection needs a sealed day, so the first baseline run after one exists
 *     evaluates the goal. The write still succeeds.
 *   * A goal that is not `active`, is a retirement goal, or is `not_evaluable`
 *     (a currency mismatch): `evaluateGoalPace` returns no off-track verdict.
 */
import { appendEvent } from '@core/platform';
import { newId } from '@core/kernel';
import { GoalOffTrack } from './events.ts';
import type { GoalsContext } from './goals.ts';
import {
  evaluateGoalPace,
  goalEvaluationStoreOf,
  type GoalPaceVerdict,
} from './projection-service.ts';
import { balancesDay } from './projection-store.ts';
import { platformOf, type PlanningExecutor } from './store.ts';

/**
 * Judge `goalId` against the latest sealed day and append `GoalOffTrack` when it
 * is off track. Returns the verdict (`null` when nothing could be evaluated).
 */
export async function evaluateGoalOnWrite(
  executor: PlanningExecutor,
  context: GoalsContext,
  goalId: string,
): Promise<GoalPaceVerdict | null> {
  const day = await balancesDay(executor, context.userId, null);
  if (day === null) return null;
  const asOf = day.asOfDate;
  const facts = await goalEvaluationStoreOf(executor, context.clock).facts(context.userId, asOf);
  const verdict = evaluateGoalPace(facts, asOf).find((candidate) => candidate.goalId === goalId);
  if (verdict === undefined) return null;
  if (verdict.status !== 'off_track') return verdict;
  await appendEvent(
    platformOf(executor),
    GoalOffTrack.create(
      {
        goalId: verdict.goalId,
        evaluationId: newId(),
        asOfDate: String(day.asOfDate),
        fundedRatio: verdict.fundedRatio,
        requiredPace: verdict.requiredPace,
        monthsRemaining: verdict.monthsRemaining,
        fundedSource: verdict.fundedSource,
      },
      {
        userId: context.userId,
        aggregateId: verdict.goalId,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
  return verdict;
}
