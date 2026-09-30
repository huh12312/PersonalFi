// SPDX-License-Identifier: MIT
/**
 * Rule health (07 §8.3's "rule health dashboard"; 05-phase-5-dispatch.md §3
 * WP 5.9): per advisor, firings, accepted, dismissed by reason, the
 * `NOT_TRUE` rate, and verified outcomes. A read WP 5.10 exposes over REST;
 * nothing here writes.
 *
 * ## What "firings" means here
 *
 * `insights` keeps one row per `(user_id, advisor_id, key, period)` identity,
 * upserted in place by every re-run (`store.ts`'s `upsertInsight`) — there is
 * no per-run log of every time a rule proposed something, because that log
 * *is* the bitemporal store §1 cut line 2 declines to build. "Firings" is
 * therefore read as the count of distinct identities the advisor has ever
 * proposed for this holder: every row currently in `insights` for it,
 * regardless of status. It undercounts a rule that fired the same finding
 * ten nights running without a period change, and it is the only number this
 * schema can produce without a new table — stated here once so a reader of
 * the figure knows what it is a count of.
 *
 * `NOT_TRUE` rate uses a different, narrower denominator on purpose —
 * `policy/feedback.ts`'s dismiss-response count, the same one the quarantine
 * check itself reads, so the number on this screen and the number that
 * tripped the breaker are never two different arithmetics.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { InsightsExecutor } from '../db.ts';
import {
  advisors,
  insightFeedback,
  insightOutcomes,
  insights,
  type ReasonCode,
} from '../../schema/index.ts';
import { NOT_TRUE_MIN_FIRINGS, NOT_TRUE_RATE_THRESHOLD, notTrueRate } from './feedback.ts';

export interface WrongAmountFlag {
  readonly insightId: string;
  readonly key: string;
  readonly inputDigest: string;
  readonly derivations: readonly Record<string, unknown>[];
  readonly flaggedAt: Date;
}

export interface RuleHealthView {
  readonly advisorId: string;
  readonly firings: number;
  readonly accepted: number;
  /** `'none'` for a dismissal with no reason code. */
  readonly dismissedByReason: Readonly<Record<ReasonCode | 'none', number>>;
  readonly notTrueRate: number;
  readonly notTrueFiringsConsidered: number;
  readonly quarantinedForNotTrue: boolean;
  readonly outcomes: {
    readonly acted: number;
    readonly incomplete: number;
    readonly pending: number;
  };
  readonly wrongAmountFlags: readonly WrongAmountFlag[];
}

const EMPTY_REASON_COUNTS: Record<ReasonCode | 'none', number> = {
  NOT_TRUE: 0,
  ALREADY_KNOW: 0,
  NOT_ACTIONABLE: 0,
  DONT_CARE: 0,
  WRONG_AMOUNT: 0,
  INTENTIONAL: 0,
  LATER: 0,
  none: 0,
};

/** Every registered advisor's health, one query per aggregate. */
export async function ruleHealth(
  executor: InsightsExecutor,
  userId: string,
): Promise<readonly RuleHealthView[]> {
  const advisorRows = await executor
    .select({
      advisorId: advisors.advisorId,
      quarantineReason: advisors.quarantineReason,
    })
    .from(advisors)
    .where(eq(advisors.userId, userId));
  if (advisorRows.length === 0) return [];

  const firingRows = await executor
    .select({
      advisorId: insights.advisorId,
      firings: sql<number>`count(*)`,
      accepted: sql<number>`count(*) filter (where ${insights.status} = 'accepted')`,
    })
    .from(insights)
    .where(eq(insights.userId, userId))
    .groupBy(insights.advisorId);
  const firingsByAdvisor = new Map(firingRows.map((row) => [row.advisorId, row]));

  const dismissedRows = await executor
    .select({
      advisorId: insightFeedback.advisorId,
      reasonCode: insightFeedback.reasonCode,
      count: sql<number>`count(*)`,
    })
    .from(insightFeedback)
    .where(and(eq(insightFeedback.userId, userId), eq(insightFeedback.action, 'dismiss')))
    .groupBy(insightFeedback.advisorId, insightFeedback.reasonCode);
  const dismissedByAdvisor = new Map<string, Record<ReasonCode | 'none', number>>();
  for (const row of dismissedRows) {
    const bucket = dismissedByAdvisor.get(row.advisorId) ?? { ...EMPTY_REASON_COUNTS };
    const key = (row.reasonCode ?? 'none') as ReasonCode | 'none';
    bucket[key] = Number(row.count);
    dismissedByAdvisor.set(row.advisorId, bucket);
  }

  const outcomeRows = await executor
    .select({
      advisorId: insightOutcomes.advisorId,
      acted: sql<number>`count(*) filter (where ${insightOutcomes.outcome} = 'ACTED')`,
      incomplete: sql<number>`count(*) filter (where ${insightOutcomes.outcome} = 'INCOMPLETE')`,
      pending: sql<number>`count(*) filter (where ${insightOutcomes.outcome} IS NULL)`,
    })
    .from(insightOutcomes)
    .where(eq(insightOutcomes.userId, userId))
    .groupBy(insightOutcomes.advisorId);
  const outcomesByAdvisor = new Map(outcomeRows.map((row) => [row.advisorId, row]));

  const wrongAmountRows = await executor
    .select({
      advisorId: insightFeedback.advisorId,
      insightId: insights.id,
      key: insights.key,
      inputDigest: insights.inputDigest,
      derivations: insights.derivations,
      flaggedAt: insightFeedback.createdAt,
    })
    .from(insightFeedback)
    .innerJoin(insights, eq(insights.id, insightFeedback.insightId))
    .where(
      and(
        eq(insightFeedback.userId, userId),
        eq(insightFeedback.action, 'dismiss'),
        eq(insightFeedback.reasonCode, 'WRONG_AMOUNT'),
      ),
    )
    .orderBy(insightFeedback.createdAt);
  const wrongAmountByAdvisor = new Map<string, WrongAmountFlag[]>();
  for (const row of wrongAmountRows) {
    const list = wrongAmountByAdvisor.get(row.advisorId) ?? [];
    list.push({
      insightId: row.insightId,
      key: row.key,
      inputDigest: row.inputDigest,
      derivations: row.derivations,
      flaggedAt: row.flaggedAt,
    });
    wrongAmountByAdvisor.set(row.advisorId, list);
  }

  return advisorRows.map((advisor) => {
    const firing = firingsByAdvisor.get(advisor.advisorId);
    const dismissed = dismissedByAdvisor.get(advisor.advisorId) ?? { ...EMPTY_REASON_COUNTS };
    const dismissTotal = Object.values(dismissed).reduce((sum, count) => sum + count, 0);
    const outcomeCounts = outcomesByAdvisor.get(advisor.advisorId);
    return {
      advisorId: advisor.advisorId,
      firings: Number(firing?.firings ?? 0),
      accepted: Number(firing?.accepted ?? 0),
      dismissedByReason: dismissed,
      notTrueRate: notTrueRate(dismissed.NOT_TRUE, dismissTotal),
      notTrueFiringsConsidered: dismissTotal,
      quarantinedForNotTrue: advisor.quarantineReason === 'not_true_rate',
      outcomes: {
        acted: Number(outcomeCounts?.acted ?? 0),
        incomplete: Number(outcomeCounts?.incomplete ?? 0),
        pending: Number(outcomeCounts?.pending ?? 0),
      },
      wrongAmountFlags: wrongAmountByAdvisor.get(advisor.advisorId) ?? [],
    };
  });
}

/** The threshold rule-health screens quote beside the number. */
export { NOT_TRUE_MIN_FIRINGS, NOT_TRUE_RATE_THRESHOLD };
