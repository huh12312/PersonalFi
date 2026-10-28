// SPDX-License-Identifier: MIT
/**
 * Where a Brief composition comes from — this context's own tables — and
 * where its outcome is kept (`brief_narrations`, migration 0059).
 *
 *   * `loadBriefNarrateSources`: the published Brief, its ranked items in the
 *     Brief's order with each item's source run's `emitted_scopes` (an item
 *     whose finding or source run is gone carries `null`, and is left out of
 *     the composition, fail closed — the narrator's laundering rule), the
 *     previous ISO week's Brief's outcomes as counts, and the titles of the
 *     holder's other live findings the Brief did not choose (the G5-15 check;
 *     never sent).
 *   * `claimBriefNarration` / `finishBriefNarration`: **one call per Brief**.
 *     The row is inserted (`calling`) in the transaction that opens the run,
 *     before the call; the unique index on (user, brief) makes a second claim
 *     a no-op, so a second job asks nothing. The outcome is written once onto
 *     the claimed row and never again.
 */
import { newId, type MoneyJson } from '@core/kernel';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  advisorRuns,
  advisoryBriefItems,
  advisoryBriefs,
  briefNarrations,
  insights,
  type BriefNarrationRow,
  type BriefNarrationStatus,
} from '../../../schema/index.ts';
import type { InsightsContext, InsightsExecutor } from '../../db.ts';
import { previousIsoWeek } from '../../brief/iso-week.ts';
import type { BriefNarrateItemSource, BriefOutcomeCounts } from './request.ts';

export interface StoredBriefNarration {
  readonly briefId: string;
  readonly status: BriefNarrationStatus;
  readonly narration: string | null;
  readonly recap: string | null;
  readonly refusal: string | null;
  readonly provider: string;
  readonly model: string;
  readonly runId: string;
  readonly inputDigest: string;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

function storedOf(row: BriefNarrationRow): StoredBriefNarration {
  return {
    briefId: row.briefId,
    status: row.status,
    narration: row.narrationText,
    recap: row.recapText,
    refusal: row.refusal,
    provider: row.llmProvider,
    model: row.llmModel,
    runId: row.runId,
    inputDigest: row.inputDigest,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export async function findBriefNarration(
  executor: InsightsExecutor,
  userId: string,
  briefId: string,
): Promise<StoredBriefNarration | null> {
  const rows = await executor
    .select()
    .from(briefNarrations)
    .where(and(eq(briefNarrations.userId, userId), eq(briefNarrations.briefId, briefId)));
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

/** Claim the Brief's one call. `false` when it was already claimed: nothing may be asked. */
export async function claimBriefNarration(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly briefId: string;
    readonly inputDigest: string;
    readonly provider: string;
    readonly model: string;
    readonly runId: string;
  },
): Promise<boolean> {
  const inserted = await executor
    .insert(briefNarrations)
    .values({
      id: newId(),
      userId: context.userId,
      briefId: input.briefId,
      status: 'calling',
      narrationText: null,
      recapText: null,
      refusal: null,
      inputDigest: input.inputDigest,
      llmProvider: input.provider,
      llmModel: input.model.slice(0, 200),
      runId: input.runId,
      createdAt: context.clock.now(),
      finishedAt: null,
    })
    .onConflictDoNothing({ target: [briefNarrations.userId, briefNarrations.briefId] })
    .returning({ id: briefNarrations.id });
  return inserted.length > 0;
}

/** Write the outcome onto the claimed row — once: only a row still `calling` is finished. */
export async function finishBriefNarration(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly briefId: string;
    readonly status: Exclude<BriefNarrationStatus, 'calling'>;
    readonly narration: string | null;
    readonly recap: string | null;
    readonly refusal: string | null;
    readonly model: string | null;
  },
): Promise<StoredBriefNarration | null> {
  const rows = await executor
    .update(briefNarrations)
    .set({
      status: input.status,
      narrationText: input.narration,
      recapText: input.recap,
      refusal: input.refusal,
      ...(input.model === null ? {} : { llmModel: input.model.slice(0, 200) }),
      finishedAt: context.clock.now(),
    })
    .where(
      and(
        eq(briefNarrations.userId, context.userId),
        eq(briefNarrations.briefId, input.briefId),
        eq(briefNarrations.status, 'calling'),
      ),
    )
    .returning();
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

export interface BriefNarrateSources {
  readonly briefId: string;
  readonly isoWeek: string;
  readonly nothingMaterial: boolean;
  /** How many items the Brief's attention strip carries (a count the overview shows). */
  readonly attentionCount: number;
  /** The Brief's ranked items, in its order, with the insight id (for the per-item narration lookup). */
  readonly ranked: readonly (BriefNarrateItemSource & { readonly insightId: string | null })[];
  readonly lastWeek: BriefOutcomeCounts | null;
  readonly foreignTitles: readonly string[];
}

/** The Brief as stored, its items' source scopes, last week's outcomes and the titles it did not choose. */
export async function loadBriefNarrateSources(
  executor: InsightsExecutor,
  userId: string,
  briefId: string,
): Promise<BriefNarrateSources | null> {
  const briefs = await executor
    .select()
    .from(advisoryBriefs)
    .where(and(eq(advisoryBriefs.userId, userId), eq(advisoryBriefs.id, briefId)));
  const brief = briefs[0];
  if (brief === undefined) return null;
  const items = await executor
    .select()
    .from(advisoryBriefItems)
    .where(and(eq(advisoryBriefItems.userId, userId), eq(advisoryBriefItems.briefId, briefId)))
    .orderBy(asc(advisoryBriefItems.section), asc(advisoryBriefItems.position));
  const ranked = items.filter((item) => item.section === 'ranked');
  const chosenIds = items.flatMap((item) => (item.insightId === null ? [] : [item.insightId]));

  // Each ranked item's finding's source run, for its emitted scopes.
  const findingRows =
    chosenIds.length === 0
      ? []
      : await executor
          .select({ id: insights.id, runId: insights.runId })
          .from(insights)
          .where(and(eq(insights.userId, userId), inArray(insights.id, chosenIds)));
  const runIdOf = new Map(findingRows.map((row) => [row.id, row.runId]));
  const runIds = [
    ...new Set(findingRows.flatMap((row) => (row.runId === null ? [] : [row.runId]))),
  ];
  const runs =
    runIds.length === 0
      ? []
      : await executor
          .select({ id: advisorRuns.id, emittedScopes: advisorRuns.emittedScopes })
          .from(advisorRuns)
          .where(and(eq(advisorRuns.userId, userId), inArray(advisorRuns.id, runIds)));
  const scopesOfRun = new Map(runs.map((run) => [run.id, run.emittedScopes]));

  const money = (minor: bigint | null, currency: string | null): MoneyJson | null =>
    minor === null || currency === null ? null : { minor: minor.toString(), currency };

  const sources = ranked.map((item) => {
    const runId = item.insightId === null ? null : (runIdOf.get(item.insightId) ?? null);
    const scopes = runId === null ? null : (scopesOfRun.get(runId) ?? null);
    const evidence = (item.evidence as readonly Record<string, unknown>[]).map((row) => ({
      label: typeof row['label'] === 'string' ? row['label'] : '',
      value: typeof row['value'] === 'string' ? row['value'] : null,
      sourceRef: typeof row['sourceRef'] === 'string' ? row['sourceRef'] : null,
      resolvedDisplay: typeof row['resolvedDisplay'] === 'string' ? row['resolvedDisplay'] : null,
    }));
    return {
      insightId: item.insightId,
      title: item.title,
      summaryMd: item.summaryMd,
      narrationText: null,
      annualizedImpact: money(item.impactAnnualizedMinor, item.impactCurrency),
      oneTimeImpact: money(item.impactOneTimeMinor, item.impactCurrency),
      carried: item.carried,
      evidence,
      scopes: scopes === null ? null : [...scopes],
    };
  });

  // Last week: of the previous Brief's items, accepted and dismissed (their findings' status now).
  const previous = await executor
    .select({ id: advisoryBriefs.id })
    .from(advisoryBriefs)
    .where(
      and(
        eq(advisoryBriefs.userId, userId),
        eq(advisoryBriefs.isoWeek, previousIsoWeek(brief.isoWeek)),
      ),
    );
  let lastWeek: BriefOutcomeCounts | null = null;
  const previousBrief = previous[0];
  if (previousBrief !== undefined) {
    const previousItems = await executor
      .select({ insightId: advisoryBriefItems.insightId })
      .from(advisoryBriefItems)
      .where(
        and(
          eq(advisoryBriefItems.userId, userId),
          eq(advisoryBriefItems.briefId, previousBrief.id),
        ),
      );
    const previousIds = previousItems.flatMap((row) =>
      row.insightId === null ? [] : [row.insightId],
    );
    const statuses =
      previousIds.length === 0
        ? []
        : await executor
            .select({ status: insights.status })
            .from(insights)
            .where(and(eq(insights.userId, userId), inArray(insights.id, previousIds)));
    lastWeek = {
      accepted: statuses.filter((row) => row.status === 'accepted').length,
      dismissed: statuses.filter((row) => row.status === 'dismissed').length,
      carried: items.filter((item) => item.carried).length,
    };
  }

  // G5-15: the holder's other live findings — the titles a composition may never name.
  const others = await executor
    .select({ id: insights.id, title: insights.title })
    .from(insights)
    .where(
      and(
        eq(insights.userId, userId),
        isNull(insights.narratesInsightId),
        sql`${insights.status} IN ('pending_review', 'snoozed')`,
      ),
    );
  const chosen = new Set(chosenIds);
  const foreignTitles = others.filter((row) => !chosen.has(row.id)).map((row) => row.title);

  return {
    briefId: brief.id,
    isoWeek: brief.isoWeek,
    nothingMaterial: brief.nothingMaterial,
    attentionCount: items.filter((item) => item.section === 'attention').length,
    ranked: sources,
    lastWeek,
    foreignTitles,
  };
}

/** The `brief.narrate` run for a Brief, from its row (the route's "why refused" and the tests). */
export async function briefNarrationRun(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
): Promise<{ readonly status: string; readonly errorCode: string | null } | null> {
  const rows = await executor
    .select({ status: advisorRuns.status, errorCode: advisorRuns.errorCode })
    .from(advisorRuns)
    .where(and(eq(advisorRuns.userId, userId), eq(advisorRuns.id, runId)));
  return rows[0] ?? null;
}
