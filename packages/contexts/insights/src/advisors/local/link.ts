// SPDX-License-Identifier: MIT
/**
 * Linked, never ranked (migration 0031; 07 §7.5 rules 1 and 3).
 *
 * A narration is written by the ordinary upsert — it passed the same seven
 * steps as everything else — and then linked to the finding it narrates. Both
 * happen inside the run's write transaction, so no reader ever sees the row
 * unlinked (and so, for an instant, looking like a finding).
 *
 * `narrationsFor` is the card's read: the WP 5.10 route and the WP 5.11 badge
 * show a finding's narration as **alternative wording** beside the template
 * text, never in place of its figures. A narration is shown only while it is
 * at least as new as its finding: if the built-in has re-proposed the finding
 * since (new figures, perhaps), the older wording no longer describes it and is
 * not offered — and a later narration that the validator refused writes
 * nothing, so the built-in's own text is what stands (07 §7.5 rule 1).
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { advisorRuns, insights } from '../../../schema/index.ts';
import type { InsightsExecutor } from '../../db.ts';

/**
 * Point `narrationId` at `findingId`. `false` — and the narration row is
 * removed — when the finding is gone or is itself a narration: a narration of
 * nothing is never left standing as if it were a finding.
 */
export async function linkNarration(
  executor: InsightsExecutor,
  userId: string,
  narrationId: string,
  findingId: string,
): Promise<boolean> {
  const updated = await executor
    .update(insights)
    .set({ narratesInsightId: findingId })
    .where(
      and(
        eq(insights.userId, userId),
        eq(insights.id, narrationId),
        sql`EXISTS (SELECT 1 FROM insights AS finding
                     WHERE finding.user_id = ${userId}
                       AND finding.id = ${findingId}
                       AND finding.narrates_insight_id IS NULL
                       AND finding.id <> ${narrationId})`,
      ),
    )
    .returning({ id: insights.id });
  if (updated.length > 0) return true;
  await executor
    .delete(insights)
    .where(and(eq(insights.userId, userId), eq(insights.id, narrationId)));
  return false;
}

export interface NarrationView {
  readonly narrationId: string;
  readonly findingId: string;
  readonly advisorId: string;
  readonly title: string;
  readonly summaryMd: string;
  readonly lastProposedAt: Date;
  /**
   * WP 10.6: the model that wrote it, as its run recorded it
   * (`advisor_runs.llm_model`: `name@sha256:…` for the local model,
   * `provider:model` for a hosted one), so the Brief's badge can name it.
   * `null` when the run row is gone or recorded none.
   */
  readonly llmModel: string | null;
}

/** The live narration of each finding, keyed by the finding's id. At most one each: the newest. */
export async function narrationsFor(
  executor: InsightsExecutor,
  userId: string,
  findingIds: readonly string[],
): Promise<ReadonlyMap<string, NarrationView>> {
  if (findingIds.length === 0) return new Map();
  const [narrations, findings] = await Promise.all([
    executor
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.userId, userId),
          isNotNull(insights.narratesInsightId),
          inArray(insights.narratesInsightId, [...findingIds]),
        ),
      ),
    executor
      .select({ id: insights.id, lastProposedAt: insights.lastProposedAt })
      .from(insights)
      .where(
        and(
          eq(insights.userId, userId),
          isNull(insights.narratesInsightId),
          inArray(insights.id, [...findingIds]),
        ),
      ),
  ]);
  const findingProposedAt = new Map(findings.map((row) => [row.id, row.lastProposedAt]));
  const out = new Map<string, NarrationView>();
  const runOf = new Map<string, string | null>();
  for (const row of narrations) {
    const findingId = row.narratesInsightId;
    if (findingId === null) continue;
    const proposedAt = findingProposedAt.get(findingId);
    if (proposedAt === undefined || row.lastProposedAt.getTime() < proposedAt.getTime()) continue;
    const current = out.get(findingId);
    if (current !== undefined && current.lastProposedAt.getTime() >= row.lastProposedAt.getTime()) {
      continue;
    }
    out.set(findingId, {
      narrationId: row.id,
      findingId,
      advisorId: row.advisorId,
      title: row.title,
      summaryMd: row.summaryMd,
      lastProposedAt: row.lastProposedAt,
      llmModel: null,
    });
    runOf.set(findingId, row.runId);
  }
  // WP 10.6: one more read, for the model each kept narration's run recorded.
  const runIds = [...new Set([...runOf.values()].filter((id): id is string => id !== null))];
  if (runIds.length > 0) {
    const runs = await executor
      .select({ id: advisorRuns.id, llmModel: advisorRuns.llmModel })
      .from(advisorRuns)
      .where(and(eq(advisorRuns.userId, userId), inArray(advisorRuns.id, runIds)));
    const models = new Map(runs.map((run) => [run.id, run.llmModel]));
    for (const [findingId, view] of out) {
      const runId = runOf.get(findingId) ?? null;
      out.set(findingId, {
        ...view,
        llmModel: runId === null ? null : (models.get(runId) ?? null),
      });
    }
  }
  return out;
}
