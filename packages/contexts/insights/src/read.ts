// SPDX-License-Identifier: MIT
/**
 * The read models: the feed, one insight with its evidence, and advisor health.
 *
 * ## The alert budget is applied here, not at write time
 *
 * Every validated proposal is persisted. The budget — 5 on the dashboard, 20 in
 * the list, a $50 annual floor — decides what is *shown*, and it is a read-time
 * decision on purpose:
 *
 *   * raising the ceiling shows more immediately, with no re-run;
 *   * lowering it loses nothing;
 *   * "why am I not seeing X?" is answerable by reading the row, which still
 *     exists, rather than by re-deriving what a past run decided to skip.
 *
 * The alternative — filtering at write time — makes the budget a property of
 * the night an insight was proposed, which is the one thing about it that
 * should not be historical.
 *
 * ## The feed ranks with the learned dismiss penalty (WP 5.9)
 *
 * `insightFeed` composed `applyAlertBudget` (`policy/alert-budget.ts`'s
 * `rank()`) — the platform's ranking, with no catalogue factors — even after
 * WP 2.7 shipped `advisors/ranking.ts`'s `rankBuiltin`/`applyCatalogueBudget`,
 * which multiply it by actionability, urgency and `(1 − 0.5·dismiss_rate)`.
 * The result: 07 §3.2's learned suppression was computed, tested
 * (`test/ranking.test.ts`), and never read on the one path a holder actually
 * sees (found while writing 05-phase-5-dispatch.md, `read.ts:307`, §2's row).
 * `rankFeed` is the fix, split from its IO so it can be tested without a
 * database: it takes the views `listInsights` already loaded and a per-advisor
 * dismiss-rate lookup, and calls `applyCatalogueBudget`. An advisor with no
 * feedback history yet is not in the map, `dismissRateOf` answers `0`, and it
 * ranks on `rankBuiltin`'s neutral value — on its merits, exactly as WP 2.7's
 * header promised.
 *
 * ## Suppression is checked here too, and that is not redundant
 *
 * `service.ts` refuses to *propose* a suppressed finding. This refuses to
 * *show* one. They are different windows: a cooldown that starts after an
 * insight was already written must hide the existing row, and a
 * dismissed-then-reopened finding must reappear without waiting for the next
 * run. Two checks, two moments, one predicate (`policy/cooldown.ts`).
 */
import { Money } from '@core/kernel';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { InsightsExecutor } from './db.ts';
import { type RankableInsight } from './policy/alert-budget.ts';
import { isSuppressed } from './policy/cooldown.ts';
import {
  applyCatalogueBudget,
  rankableBuiltinOf,
  type BudgetedFeed,
  type RankableFeedRow,
} from './advisors/ranking.ts';
import {
  advisorRuns,
  advisors,
  insightActions,
  insightDismissals,
  insightEvidence,
  insightFeedback,
  insights,
  type InsightHelpfulness,
  type InsightStatus,
  type ReasonCode,
  snapshotGrants,
} from '../schema/index.ts';
import type { Severity } from './contract/response.ts';

export interface EvidenceView {
  readonly position: number;
  readonly kind: string;
  readonly label: string;
  readonly value: string | null;
  /** The snapshot path, for the UI's click-through. Never a foreign key. */
  readonly sourceRef: string | null;
  readonly resolvedDisplay: string | null;
  readonly href: string | null;
}

export interface ActionView {
  readonly position: number;
  readonly kind: string;
  readonly label: string;
  readonly rationaleMd: string;
  readonly url: string | null;
}

export interface InsightView {
  readonly id: string;
  readonly advisorId: string;
  /**
   * `advisors.version` at the moment this row was written — carried in the
   * `insights` table since WP 2.6 (`upsertInsight`'s `advisorVersion`
   * column) but absent from this read model until WP 3.13 closed the carry:
   * "advisor_version absent from the evidence panel" (03-phase-3-dispatch.md
   * §2, wp2.10-insights-ui.md §7). An advisor's rules can change between the
   * run that proposed an insight and the day someone reviews it; without
   * this field there is no way to tell whether "why did it say this" is
   * asking about the code that is live today or a version that shipped
   * three releases ago.
   */
  readonly advisorVersion: string;
  readonly key: string;
  readonly period: string;
  readonly type: string;
  readonly severity: Severity;
  readonly severityClamped: boolean;
  readonly title: string;
  readonly summaryMd: string;
  readonly confidence: number;
  readonly confidenceBasis: string;
  readonly horizon: string;
  readonly status: InsightStatus;
  readonly annualizedImpact: Money | null;
  readonly oneTimeImpact: Money | null;
  readonly impactBasis: string;
  readonly caveats: readonly string[];
  readonly inputDigest: string;
  readonly firstProposedAt: Date;
  readonly lastProposedAt: Date;
  readonly expiresAt: Date | null;
  readonly evidence: readonly EvidenceView[];
  readonly actions: readonly ActionView[];
  /** WP 10.15 (0051): when the holder bookmarked it; `null` = not bookmarked. */
  readonly bookmarkedAt: Date | null;
  /** WP 10.15 (0051): "was this helpful?"; `null` = not answered. Never read by policy. */
  readonly feedback: InsightHelpfulness | null;
  /** WP 10.15 (0051): the reason code given with `not_helpful`, else `null`. */
  readonly feedbackReason: ReasonCode | null;
}

export interface FeedInput {
  readonly userId: string;
  /** Defaults to the review queue. Pass `[]` for every status. */
  readonly statuses?: readonly InsightStatus[];
  readonly advisorIds?: readonly string[];
  /** Rows to read before the budget is applied. A bound, not a page size. */
  readonly limit?: number;
  /**
   * The instant to judge expiry and suppression against, or `null` to skip
   * both.
   *
   * **Required**, with no default. A read model that reached for `new Date()`
   * would be the one place in this context that read a wall clock, and the
   * answer it gave would then differ from the answer the *writer* gave a
   * millisecond earlier from the injected `Clock`. The caller has a clock;
   * `null` is how a caller says it genuinely wants the unfiltered set.
   */
  readonly now: Date | null;
}

/** `confidence` comes back as a NUMERIC string. Parsed once, at the edge. */
function scoreOf(text: string): number {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function moneyOf(minor: bigint | null, code: string | null): Money | null {
  return minor === null || code === null ? null : Money.of(minor, code);
}

/**
 * Every insight matching the filter, with its evidence and actions attached.
 *
 * Three queries rather than one join, because a join over two one-to-many
 * children multiplies the rows and the de-duplication is more code than the
 * extra round trips are worth at this size. The bound on the parent query is
 * what keeps the `IN` lists finite.
 */
export async function listInsights(
  executor: InsightsExecutor,
  input: FeedInput,
): Promise<readonly InsightView[]> {
  const statuses = input.statuses ?? (['pending_review'] as const);
  // WP 5.3: a narration (`narrates_insight_id` set) is wording for a finding,
  // not a finding. It never takes a feed, dashboard or Brief slot of its own —
  // every reader that ranks or budgets reads through here, so it is excluded
  // here, once, whatever statuses or advisors the caller asked for.
  const conditions = [eq(insights.userId, input.userId), isNull(insights.narratesInsightId)];
  if (statuses.length > 0) conditions.push(inArray(insights.status, [...statuses]));
  if (input.advisorIds !== undefined) {
    if (input.advisorIds.length === 0) return [];
    conditions.push(inArray(insights.advisorId, [...input.advisorIds]));
  }

  const rows = await executor
    .select()
    .from(insights)
    .where(and(...conditions))
    .orderBy(desc(insights.lastProposedAt), asc(insights.key))
    .limit(Math.min(Math.max(input.limit ?? 200, 1), 1000));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [evidenceRows, actionRows] = await Promise.all([
    executor
      .select()
      .from(insightEvidence)
      .where(inArray(insightEvidence.insightId, ids))
      .orderBy(asc(insightEvidence.insightId), asc(insightEvidence.position)),
    executor
      .select()
      .from(insightActions)
      .where(inArray(insightActions.insightId, ids))
      .orderBy(asc(insightActions.insightId), asc(insightActions.position)),
  ]);

  const evidenceBy = new Map<string, EvidenceView[]>();
  for (const row of evidenceRows) {
    const list = evidenceBy.get(row.insightId) ?? [];
    list.push({
      position: row.position,
      kind: row.kind,
      label: row.label,
      value: row.value,
      sourceRef: row.sourceRef,
      resolvedDisplay: row.resolvedDisplay,
      href: row.href,
    });
    evidenceBy.set(row.insightId, list);
  }

  const actionsBy = new Map<string, ActionView[]>();
  for (const row of actionRows) {
    const list = actionsBy.get(row.insightId) ?? [];
    list.push({
      position: row.position,
      kind: row.kind,
      label: row.label,
      rationaleMd: row.rationaleMd,
      url: row.url,
    });
    actionsBy.set(row.insightId, list);
  }

  const now = input.now;
  const suppressions =
    now === null
      ? new Map<
          string,
          { dismissCount: number; suppressedUntil: Date | null; permanent: boolean }
        >()
      : await loadSuppressionMap(executor, input.userId);

  const views: InsightView[] = [];
  for (const row of rows) {
    if (now !== null && row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
      // Still `pending_review` in the table — nobody answered it — but it is no
      // longer true. See `0012_insights.sql` on why there is no `expired`
      // status to write instead.
      continue;
    }
    if (
      now !== null &&
      row.status === 'pending_review' &&
      isSuppressed(suppressions.get(`${row.advisorId}|${row.key}`) ?? null, now)
    ) {
      continue;
    }
    views.push({
      id: row.id,
      advisorId: row.advisorId,
      advisorVersion: row.advisorVersion,
      key: row.key,
      period: row.period,
      type: row.type,
      severity: row.severity as Severity,
      severityClamped: row.severityClamped,
      title: row.title,
      summaryMd: row.summaryMd,
      confidence: scoreOf(row.confidence),
      confidenceBasis: row.confidenceBasis,
      horizon: row.horizon,
      status: row.status,
      annualizedImpact: moneyOf(row.impactAnnualizedMinor, row.impactCurrency),
      oneTimeImpact: moneyOf(row.impactOneTimeMinor, row.impactCurrency),
      impactBasis: row.impactBasis,
      caveats: row.caveats,
      inputDigest: row.inputDigest,
      firstProposedAt: row.firstProposedAt,
      lastProposedAt: row.lastProposedAt,
      expiresAt: row.expiresAt,
      evidence: evidenceBy.get(row.id) ?? [],
      actions: actionsBy.get(row.id) ?? [],
      bookmarkedAt: row.bookmarkedAt,
      feedback: row.feedback,
      feedbackReason: row.feedbackReason,
    });
  }
  return views;
}

async function loadSuppressionMap(
  executor: InsightsExecutor,
  userId: string,
): Promise<
  Map<string, { dismissCount: number; suppressedUntil: Date | null; permanent: boolean }>
> {
  const rows = await executor
    .select()
    .from(insightDismissals)
    .where(eq(insightDismissals.userId, userId));
  const map = new Map<
    string,
    { dismissCount: number; suppressedUntil: Date | null; permanent: boolean }
  >();
  for (const row of rows) {
    map.set(`${row.advisorId}|${row.insightKey}`, {
      dismissCount: row.dismissCount,
      suppressedUntil: row.suppressedUntil,
      permanent: row.permanent,
    });
  }
  return map;
}

/** The ranking projection. One place, so the feed and a test agree on it. */
export function rankableOf(view: InsightView): RankableInsight {
  return {
    key: view.key,
    severity: view.severity,
    confidence: view.confidence,
    annualizedImpact: view.annualizedImpact,
    oneTimeImpact: view.oneTimeImpact,
  };
}

function rankableFeedRowOf(view: InsightView): RankableFeedRow {
  return {
    key: view.key,
    severity: view.severity,
    confidence: view.confidence,
    annualizedImpact: view.annualizedImpact,
    oneTimeImpact: view.oneTimeImpact,
    horizon: view.horizon,
    actions: view.actions,
  };
}

/**
 * The catalogue's ranking (07 §3.2) applied to views already fetched, over a
 * dismiss-rate lookup already loaded — pure, so `test/ranking.test.ts` can
 * assert the feed's ordering without a database.
 *
 * `dismissRateOf` answering `0` for an advisor with no entry is what makes a
 * newly registered rule rank on its merits: `rankBuiltin`'s penalty term is
 * `(1 − 0.5 × 0) = 1`, the neutral value.
 */
export function rankFeed(
  views: readonly InsightView[],
  dismissRateOf: (advisorId: string) => number,
  currencyCode: string,
): BudgetedFeed<InsightView> {
  return applyCatalogueBudget(
    views,
    (view) => rankableBuiltinOf(rankableFeedRowOf(view), dismissRateOf(view.advisorId)),
    currencyCode,
  );
}

/**
 * Per-advisor learned dismiss rate: dismissed ÷ (dismissed + accepted) over
 * this holder's `insight_feedback` history. Absent from the map — not `0` in
 * it — for an advisor with no accept or dismiss on record, so `rankFeed`'s
 * `dismissRateOf` can tell "no history" from "dismissed nothing" if it ever
 * needs to; today both read `0`.
 */
async function loadDismissRates(
  executor: InsightsExecutor,
  userId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await executor
    .select({
      advisorId: insightFeedback.advisorId,
      dismissed: sql<number>`count(*) filter (where ${insightFeedback.action} = 'dismiss')`,
      total: sql<number>`count(*) filter (where ${insightFeedback.action} IN ('dismiss', 'accept'))`,
    })
    .from(insightFeedback)
    .where(eq(insightFeedback.userId, userId))
    .groupBy(insightFeedback.advisorId);

  const map = new Map<string, number>();
  for (const row of rows) {
    const total = Number(row.total);
    if (total <= 0) continue;
    map.set(row.advisorId, Number(row.dismissed) / total);
  }
  return map;
}

/**
 * The feed with the alert budget applied, ranked by 07 §3.2's full formula.
 *
 * Returns all four slices rather than just the visible one, so a UI can say
 * "and 14 more" and a diagnostic screen can show what the floor excluded — the
 * question "why is this not in my feed?" has an answer in the return value
 * rather than requiring a second query.
 */
export async function insightFeed(
  executor: InsightsExecutor,
  input: FeedInput & { readonly currency: string },
): Promise<BudgetedFeed<InsightView>> {
  const [views, dismissRates] = await Promise.all([
    listInsights(executor, input),
    loadDismissRates(executor, input.userId),
  ]);
  return rankFeed(views, (advisorId) => dismissRates.get(advisorId) ?? 0, input.currency);
}

export interface AdvisorHealthView {
  readonly advisorId: string;
  readonly displayName: string;
  readonly kind: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly quarantinedAt: Date | null;
  readonly quarantineReason: string | null;
  readonly consecutiveFailures: number;
  readonly lastRunAt: Date | null;
  readonly grantedScopes: readonly string[];
  readonly lastRunStatus: string | null;
  readonly lastRunRejected: number | null;
}

/**
 * One row per registered advisor, with the state of the three kill switches and
 * the outcome of its most recent run.
 *
 * This is the screen an operator looks at when advice stops appearing, and the
 * two answers it has to be able to give are "it is switched off" and "it keeps
 * producing output we refuse" — which is why `quarantineReason` and
 * `lastRunRejected` are both here rather than one standing in for the other.
 */
export async function advisorHealth(
  executor: InsightsExecutor,
  userId: string,
): Promise<readonly AdvisorHealthView[]> {
  const rows = await executor
    .select()
    .from(advisors)
    .where(eq(advisors.userId, userId))
    .orderBy(asc(advisors.advisorId));
  if (rows.length === 0) return [];

  const latest = await executor
    .select({
      advisorId: advisorRuns.advisorId,
      status: advisorRuns.status,
      rejectedCount: advisorRuns.rejectedCount,
      startedAt: advisorRuns.startedAt,
      rank: sql<number>`row_number() OVER (PARTITION BY ${advisorRuns.advisorId} ORDER BY ${advisorRuns.startedAt} DESC)`.as(
        'rank',
      ),
    })
    .from(advisorRuns)
    .where(eq(advisorRuns.userId, userId));

  // The grants in force, one query for every advisor — never the manifest's
  // `requires_scopes`, which is what the advisor *asked* for (G4-17: the
  // consent summary said "granted" for every request, and a revocation did
  // not change it).
  const liveGrants = await executor
    .select({ advisorId: snapshotGrants.advisorId, scope: snapshotGrants.scope })
    .from(snapshotGrants)
    .where(and(eq(snapshotGrants.userId, userId), sql`${snapshotGrants.revokedAt} IS NULL`))
    .orderBy(asc(snapshotGrants.advisorId), asc(snapshotGrants.scope));
  const grantsByAdvisor = new Map<string, string[]>();
  for (const grant of liveGrants) {
    const list = grantsByAdvisor.get(grant.advisorId) ?? [];
    list.push(grant.scope);
    grantsByAdvisor.set(grant.advisorId, list);
  }

  const lastByAdvisor = new Map<string, { status: string; rejectedCount: number }>();
  for (const run of latest) {
    // `row_number()` is `bigint`, which `@core/db` parses to a `BigInt`: `1n
    // !== 1`, so a strict comparison skipped every run and both fields read
    // null for ever (Phase 4 gate G4-17). Compare the number.
    if (Number(run.rank) !== 1) continue;
    lastByAdvisor.set(run.advisorId, { status: run.status, rejectedCount: run.rejectedCount });
  }

  return rows.map((row) => {
    const last = lastByAdvisor.get(row.advisorId);
    return {
      advisorId: row.advisorId,
      displayName: row.displayName,
      kind: row.kind,
      version: row.version,
      enabled: row.enabled,
      quarantinedAt: row.quarantinedAt,
      quarantineReason: row.quarantineReason,
      consecutiveFailures: row.consecutiveFailures,
      lastRunAt: row.lastRunAt,
      grantedScopes: grantsByAdvisor.get(row.advisorId) ?? [],
      lastRunStatus: last?.status ?? null,
      lastRunRejected: last?.rejectedCount ?? null,
    };
  });
}
