// SPDX-License-Identifier: MIT
/**
 * An insight's bookmark and the holder's "was this helpful?" answer (WP 10.15, V8; migration
 * `0051_insight_feedback.sql`).
 *
 * **State on the row, never policy.** Both are the holder's current opinion of one insight, replaced when it
 * changes. Neither writes `insight_feedback` (the review-action log) and neither is read by the cooldown ladder,
 * the NOT_TRUE quarantine rate or rule health (`policy/feedback.ts`): a "not helpful" with `NOT_TRUE` records
 * what the holder said and changes nothing about the advisor. Dismissing, through `reviewInsight`, remains the one
 * path whose reason moves policy.
 *
 * **Two predicates on every write**: the row must be the caller's (`user_id`) and the one named (`id`). A foreign
 * id updates nothing and returns `null`, which the route turns into a 404 — the same answer as an unknown id.
 *
 * Clearing the answer (`feedback: null`) clears its reason; a reason without `not_helpful` is refused here, and by
 * the database (`insights_feedback_reason_requires_not_helpful`) if this check were ever bypassed.
 */
import { and, eq } from 'drizzle-orm';
import type { InsightsExecutor } from './db.ts';
import { insights, type InsightHelpfulness, type ReasonCode } from '../schema/index.ts';

export class InsightFeedbackReasonError extends Error {
  constructor() {
    super('a feedback reason is recorded only with a "not helpful" answer');
    this.name = 'InsightFeedbackReasonError';
  }
}

/** Bookmark (`true`, stamped `now`) or un-bookmark (`false`). `null` when the caller has no such insight. */
export async function setInsightBookmark(
  executor: InsightsExecutor,
  userId: string,
  insightId: string,
  bookmarked: boolean,
  now: Date,
): Promise<{ readonly insightId: string; readonly bookmarkedAt: Date | null } | null> {
  const rows = await executor
    .update(insights)
    .set({ bookmarkedAt: bookmarked ? now : null })
    .where(and(eq(insights.userId, userId), eq(insights.id, insightId)))
    .returning({ insightId: insights.id, bookmarkedAt: insights.bookmarkedAt });
  return rows[0] ?? null;
}

/**
 * Record (or clear, with `null`) the holder's answer. A reason is kept only with `not_helpful`.
 * `null` when the caller has no such insight.
 */
export async function setInsightFeedback(
  executor: InsightsExecutor,
  userId: string,
  insightId: string,
  feedback: InsightHelpfulness | null,
  reasonCode: ReasonCode | null,
): Promise<{
  readonly insightId: string;
  readonly feedback: InsightHelpfulness | null;
  readonly feedbackReason: ReasonCode | null;
} | null> {
  if (reasonCode !== null && feedback !== 'not_helpful') throw new InsightFeedbackReasonError();
  const rows = await executor
    .update(insights)
    .set({ feedback, feedbackReason: feedback === 'not_helpful' ? reasonCode : null })
    .where(and(eq(insights.userId, userId), eq(insights.id, insightId)))
    .returning({
      insightId: insights.id,
      feedback: insights.feedback,
      feedbackReason: insights.feedbackReason,
    });
  return rows[0] ?? null;
}
