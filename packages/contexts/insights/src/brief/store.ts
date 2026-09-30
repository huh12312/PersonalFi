// SPDX-License-Identifier: MIT
/**
 * The Brief's database surface: reading candidates and history, and
 * publishing (05-phase-5-dispatch.md §3 WP 5.6; migration 0032).
 *
 * ## The engine call happens outside any transaction
 *
 * `publishWeeklyBrief` computes every item's retirement effect (a call
 * through `RetirementImpactPort`, which reads a baseline and runs the
 * deterministic engine) **before** it opens the transaction that writes the
 * Brief. WP 5.5's own carry (05 §2: *"the projection refresh job holds its
 * transaction across the ~1 s engine run"*) is exactly the shape this file
 * does not repeat — the transaction below wraps two `INSERT`s and nothing
 * that waits on compute.
 *
 * ## The immutability guard
 *
 * A Brief is a record of what was said (07 §7.3, extended to the Brief by 05
 * §3's WP 5.6 entry). `publishWeeklyBrief` never issues an `UPDATE` against
 * `advisory_briefs`/`advisory_brief_items`: the first insert for a
 * `(user_id, iso_week)` wins, `ON CONFLICT DO NOTHING` is the only thing a
 * second attempt can do, and a caller that lost the race reads the row the
 * first attempt wrote rather than writing its own beside or over it.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { Money, newId, type Clock, type Money as MoneyType } from '@core/kernel';
import { configHash } from '@core/platform';
import {
  advisorRuns,
  advisors,
  insightFeedback,
  advisoryBriefItems,
  advisoryBriefs,
  type AdvisorKindValue,
  type BriefItemSection,
  type NewAdvisoryBriefItemRow,
} from '../../schema/index.ts';
import type { InsightsDatabase, InsightsExecutor } from '../db.ts';
import { listInsights, type InsightView } from '../read.ts';
import type { Severity } from '../contract/response.ts';
import { previousIsoWeek } from './iso-week.ts';
import type { BriefCandidate } from './candidate.ts';
import type { AssembledBrief, BriefItemAssembly } from './assembly.ts';
import {
  NO_DOLLAR_FIGURE_ANSWER,
  RETIREMENT_EFFECT_ASSUMPTION,
  type MonthsOfSpendingEffect,
  type RetirementAgeEffect,
  type RetirementImpactAnswer,
} from './ports.ts';

/** `read.ts`'s `InsightView`, narrowed to what the Brief needs, as a `BriefCandidate`. */
export function candidateOf(view: InsightView): BriefCandidate {
  return {
    insightId: view.id,
    advisorId: view.advisorId,
    key: view.key,
    type: view.type,
    severity: view.severity,
    title: view.title,
    summaryMd: view.summaryMd,
    confidence: view.confidence,
    horizon: view.horizon,
    annualizedImpact: view.annualizedImpact,
    oneTimeImpact: view.oneTimeImpact,
    actionKinds: view.actions.map((action) => action.kind),
    evidence: view.evidence.map((row) => ({
      position: row.position,
      kind: row.kind,
      label: row.label,
      value: row.value,
      sourceRef: row.sourceRef,
      resolvedDisplay: row.resolvedDisplay,
      href: row.href,
    })),
    inputDigest: view.inputDigest,
  };
}

/**
 * Every candidate the Brief may consider: `listInsights` already applies
 * pending/unsuppressed/unexpired (`now` given, never a wall clock read here —
 * `read.ts`'s own rule, inherited).
 */
export async function loadCandidates(
  executor: InsightsExecutor,
  userId: string,
  now: Date,
): Promise<readonly BriefCandidate[]> {
  const views = await listInsights(executor, { userId, statuses: ['pending_review'], now });
  return views.map(candidateOf);
}

export async function loadAdvisorKinds(
  executor: InsightsExecutor,
  userId: string,
): Promise<ReadonlyMap<string, AdvisorKindValue>> {
  const rows = await executor
    .select({ advisorId: advisors.advisorId, kind: advisors.kind })
    .from(advisors)
    .where(eq(advisors.userId, userId));
  return new Map(rows.map((row) => [row.advisorId, row.kind]));
}

/**
 * Dismissed ÷ (dismissed + accepted) per advisor. The same query `read.ts`'s
 * private `loadDismissRates` runs (WP 5.9) — duplicated rather than imported
 * because it is not exported, and re-deriving one COUNT FILTER query here
 * costs less than widening `read.ts`'s surface for one caller outside it.
 */
export async function loadDismissRates(
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
 * Whole days since this holder's earliest advisor run, or `0` with none on
 * record — cold start by definition (E11), the same direction the cold-start
 * threshold reads on an empty history.
 */
export async function historyDaysAsOf(
  executor: InsightsExecutor,
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await executor
    .select({ earliest: sql<Date | null>`min(${advisorRuns.startedAt})` })
    .from(advisorRuns)
    .where(eq(advisorRuns.userId, userId));
  const earliest = rows[0]?.earliest ?? null;
  if (earliest === null) return 0;
  const days = Math.floor((now.getTime() - new Date(earliest).getTime()) / 86_400_000);
  return Math.max(0, days);
}

/** `${advisorId}|${key}` identities the previous ISO week's Brief carried — `assembly.ts`'s "carried" input. */
export async function loadCarriedIdentities(
  executor: InsightsExecutor,
  userId: string,
  isoWeek: string,
): Promise<ReadonlySet<string>> {
  const previous = previousIsoWeek(isoWeek);
  const briefRows = await executor
    .select({ id: advisoryBriefs.id })
    .from(advisoryBriefs)
    .where(and(eq(advisoryBriefs.userId, userId), eq(advisoryBriefs.isoWeek, previous)));
  const brief = briefRows[0];
  if (brief === undefined) return new Set();
  const items = await executor
    .select({ advisorId: advisoryBriefItems.advisorId, insightKey: advisoryBriefItems.insightKey })
    .from(advisoryBriefItems)
    .where(and(eq(advisoryBriefItems.userId, userId), eq(advisoryBriefItems.briefId, brief.id)));
  return new Set(items.map((item) => `${item.advisorId}|${item.insightKey}`));
}

export interface StoredBrief {
  readonly id: string;
  readonly isoWeek: string;
  readonly currency: string;
  readonly nothingMaterial: boolean;
  readonly coldStart: boolean;
  readonly coldStartNote: string | null;
  readonly inputDigest: string;
  readonly publishedAt: Date;
}

function storedBriefOf(row: typeof advisoryBriefs.$inferSelect): StoredBrief {
  return {
    id: row.id,
    isoWeek: row.isoWeek,
    currency: row.currency,
    nothingMaterial: row.nothingMaterial,
    coldStart: row.coldStart,
    coldStartNote: row.coldStartNote,
    inputDigest: row.inputDigest,
    publishedAt: row.publishedAt,
  };
}

export async function findBriefByWeek(
  executor: InsightsExecutor,
  userId: string,
  isoWeek: string,
): Promise<StoredBrief | null> {
  const rows = await executor
    .select()
    .from(advisoryBriefs)
    .where(and(eq(advisoryBriefs.userId, userId), eq(advisoryBriefs.isoWeek, isoWeek)));
  const row = rows[0];
  return row === undefined ? null : storedBriefOf(row);
}

export interface StoredBriefItem {
  readonly id: string;
  readonly section: BriefItemSection;
  readonly position: number;
  readonly insightId: string | null;
  readonly advisorId: string;
  readonly insightKey: string;
  readonly insightType: string;
  readonly severity: Severity;
  readonly title: string;
  readonly summaryMd: string;
  readonly confidence: number;
  readonly horizon: string;
  readonly carried: boolean;
  readonly annualizedImpact: MoneyType | null;
  readonly oneTimeImpact: MoneyType | null;
  readonly evidence: readonly Record<string, unknown>[];
  readonly score: number | null;
  readonly scoreFactors: Record<string, unknown> | null;
  readonly retirementEffect: RetirementImpactAnswer;
}

function moneyOrNull(minor: bigint | null, currency: string | null): MoneyType | null {
  return minor === null || currency === null ? null : Money.of(minor, currency);
}

function scoreOf(text: string | null): number | null {
  if (text === null) return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

export async function listBriefItems(
  executor: InsightsExecutor,
  userId: string,
  briefId: string,
): Promise<readonly StoredBriefItem[]> {
  const rows = await executor
    .select()
    .from(advisoryBriefItems)
    .where(and(eq(advisoryBriefItems.userId, userId), eq(advisoryBriefItems.briefId, briefId)))
    .orderBy(asc(advisoryBriefItems.section), asc(advisoryBriefItems.position));
  return rows.map((row) => ({
    id: row.id,
    section: row.section,
    position: row.position,
    insightId: row.insightId,
    advisorId: row.advisorId,
    insightKey: row.insightKey,
    insightType: row.insightType,
    severity: row.severity as Severity,
    title: row.title,
    summaryMd: row.summaryMd,
    confidence: Number.parseFloat(row.confidence),
    horizon: row.horizon,
    carried: row.carried,
    annualizedImpact: moneyOrNull(row.impactAnnualizedMinor, row.impactCurrency),
    oneTimeImpact: moneyOrNull(row.impactOneTimeMinor, row.impactCurrency),
    evidence: row.evidence,
    score: scoreOf(row.score),
    scoreFactors: row.scoreFactors,
    retirementEffect: deserializeRetirementEffect(row.retirementEffect),
  }));
}

// ---------------------------------------------------------------------------
// RetirementImpactAnswer <-> JSONB
// ---------------------------------------------------------------------------

function serializeMonthsOfSpending(effect: MonthsOfSpendingEffect): Record<string, unknown> {
  if (effect.months === null) return { months: null, reason: effect.reason };
  return {
    months: effect.months,
    atAge: effect.atAge,
    wealthDifference: Money.toJSON(effect.wealthDifference),
    firstYearSpending: Money.toJSON(effect.firstYearSpending),
    derivation: effect.derivation,
  };
}

function deserializeMonthsOfSpending(raw: Record<string, unknown>): MonthsOfSpendingEffect {
  if (raw['months'] === null) {
    return {
      months: null,
      reason: raw['reason'] as 'retirement_started' | 'no_retirement_spending',
    };
  }
  return {
    months: raw['months'] as number,
    atAge: raw['atAge'] as number,
    wealthDifference: Money.fromJSON(
      raw['wealthDifference'] as { minor: string; currency: string },
    ),
    firstYearSpending: Money.fromJSON(
      raw['firstYearSpending'] as { minor: string; currency: string },
    ),
    derivation: raw['derivation'] as string,
  };
}

/** `RetirementImpactAnswer` → the JSONB this Brief item stores. Never re-derived on read. */
export function serializeRetirementEffect(effect: RetirementImpactAnswer): Record<string, unknown> {
  if (effect.kind === 'not_computable') {
    return { kind: 'not_computable', reason: effect.reason };
  }
  return {
    kind: 'computed',
    engineVersion: effect.engineVersion,
    assumptionsVersion: effect.assumptionsVersion,
    plannedRetirementAge: effect.plannedRetirementAge,
    baseline: effect.baseline,
    withAction: effect.withAction,
    yearsEarlier: effect.yearsEarlier,
    monthsOfSpending: serializeMonthsOfSpending(effect.monthsOfSpending),
    assumption: effect.assumption,
  };
}

function deserializeRetirementEffect(raw: Record<string, unknown>): RetirementImpactAnswer {
  if (raw['kind'] === 'not_computable') {
    return { kind: 'not_computable', reason: String(raw['reason']) };
  }
  return {
    kind: 'computed',
    engineVersion: String(raw['engineVersion']),
    assumptionsVersion: String(raw['assumptionsVersion']),
    plannedRetirementAge: Number(raw['plannedRetirementAge']),
    baseline: raw['baseline'] as RetirementAgeEffect,
    withAction: raw['withAction'] as RetirementAgeEffect,
    yearsEarlier: raw['yearsEarlier'] as number | null,
    monthsOfSpending: deserializeMonthsOfSpending(
      raw['monthsOfSpending'] as Record<string, unknown>,
    ),
    assumption: RETIREMENT_EFFECT_ASSUMPTION,
  };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** sha256 over the canonical, sorted set of source insights this Brief was built from. */
export function briefInputDigest(items: readonly BriefItemAssembly[]): string {
  const sorted = items
    .map((item) => ({
      section: item.section,
      advisorId: item.candidate.advisorId,
      key: item.candidate.key,
      inputDigest: item.candidate.inputDigest,
    }))
    .sort((a, b) =>
      a.advisorId === b.advisorId
        ? a.key.localeCompare(b.key)
        : a.advisorId.localeCompare(b.advisorId),
    );
  return `sha256:${configHash({ items: sorted })}`;
}

function itemRowOf(
  userId: string,
  briefId: string,
  item: BriefItemAssembly,
  effect: RetirementImpactAnswer,
): NewAdvisoryBriefItemRow {
  const currency =
    item.candidate.annualizedImpact?.currency ?? item.candidate.oneTimeImpact?.currency ?? null;
  return {
    id: newId(),
    userId,
    briefId,
    section: item.section,
    position: item.position,
    insightId: item.candidate.insightId,
    advisorId: item.candidate.advisorId,
    insightKey: item.candidate.key,
    insightType: item.candidate.type,
    severity: item.candidate.severity,
    title: item.candidate.title,
    summaryMd: item.candidate.summaryMd,
    confidence: item.candidate.confidence.toFixed(6),
    horizon: item.candidate.horizon,
    carried: item.carried,
    impactAnnualizedMinor: item.candidate.annualizedImpact?.minor ?? null,
    impactOneTimeMinor: item.candidate.oneTimeImpact?.minor ?? null,
    impactCurrency: currency,
    evidence: item.candidate.evidence as unknown as readonly Record<string, unknown>[],
    score: item.score === null ? null : item.score.toFixed(6),
    scoreFactors: item.scoreFactors as unknown as Record<string, unknown> | null,
    retirementEffect: serializeRetirementEffect(effect),
  };
}

export interface PublishedBrief {
  readonly id: string;
  readonly isoWeek: string;
  /** `true` when this call found the week already published: nothing was written. */
  readonly alreadyPublished: boolean;
}

/**
 * Publish one week's Brief. Idempotent: a second call for a week already
 * published writes nothing and reports `alreadyPublished`.
 *
 * `retirementEffectOf` is called for every item **before** any transaction
 * opens — see this file's header.
 */
export async function publishWeeklyBrief(
  database: InsightsDatabase,
  input: {
    readonly userId: string;
    readonly isoWeek: string;
    readonly currencyCode: string;
    readonly assembled: AssembledBrief;
    readonly retirementEffectOf: (candidate: BriefCandidate) => Promise<RetirementImpactAnswer>;
    readonly clock: Clock;
  },
): Promise<PublishedBrief> {
  // Cheap short-circuit: on every tick after the first for a given week, this
  // is the only read the job needs to perform.
  const already = await findBriefByWeek(database, input.userId, input.isoWeek);
  if (already !== null) {
    return { id: already.id, isoWeek: input.isoWeek, alreadyPublished: true };
  }

  const allItems: readonly BriefItemAssembly[] = [
    ...input.assembled.ranked,
    ...input.assembled.attention,
  ];
  const effects = new Map<BriefItemAssembly, RetirementImpactAnswer>();
  for (const item of allItems) {
    effects.set(item, await input.retirementEffectOf(item.candidate));
  }

  const briefId = newId();
  const publishedAt = input.clock.now();
  const written = await database.transaction(async (tx) => {
    // The immutability guard: `ON CONFLICT DO NOTHING` rather than an
    // existence check followed by a plain `INSERT` is what makes "never
    // rewrite a published week" atomic against a second process racing the
    // same tick, not merely true in the common case.
    const inserted = await tx
      .insert(advisoryBriefs)
      .values({
        id: briefId,
        userId: input.userId,
        isoWeek: input.isoWeek,
        currency: input.currencyCode,
        nothingMaterial: input.assembled.nothingMaterial,
        coldStart: input.assembled.coldStart,
        coldStartNote: input.assembled.coldStartNote,
        inputDigest: briefInputDigest(allItems),
        publishedAt,
      })
      .onConflictDoNothing({ target: [advisoryBriefs.userId, advisoryBriefs.isoWeek] })
      .returning({ id: advisoryBriefs.id });
    if (inserted[0] === undefined) return null;

    if (allItems.length > 0) {
      await tx
        .insert(advisoryBriefItems)
        .values(
          allItems.map((item) =>
            itemRowOf(input.userId, briefId, item, effects.get(item) ?? NO_DOLLAR_FIGURE_ANSWER),
          ),
        );
    }
    return inserted[0].id;
  });

  if (written === null) {
    // Lost the race between the short-circuit read above and this insert:
    // another publish for this week won. Its rows stand; nothing of ours is
    // written.
    const existing = await findBriefByWeek(database, input.userId, input.isoWeek);
    return { id: existing?.id ?? briefId, isoWeek: input.isoWeek, alreadyPublished: true };
  }
  return { id: written, isoWeek: input.isoWeek, alreadyPublished: false };
}
