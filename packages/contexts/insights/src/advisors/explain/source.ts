// SPDX-License-Identifier: MIT
/**
 * Where an explanation's subject comes from: this context's own tables, read
 * the way the narrator's envelope reads them (`advisors/local/findings.ts`),
 * and the cache of explanations already given (`insight_explanations`,
 * migration 0057).
 *
 * An insight is explainable when it is a built-in's own finding (never a
 * narration, never a non-built-in's row), has evidence, and its source run
 * is still on record — the run's `emitted_scopes` are the scopes the request
 * carries, and a finding with no provable source is excluded, fail closed,
 * exactly as the narrator's laundering rule excludes it. A pillar is
 * explainable when today's latest stored health snapshot scores it.
 */
import { newId } from '@core/kernel';
import { and, desc, eq } from 'drizzle-orm';
import {
  advisorRuns,
  healthScoreSnapshots,
  insightEvidence,
  insightExplanations,
  insights,
  type ExplanationEntityKind,
  type InsightExplanationRow,
} from '../../../schema/index.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_SCOPES } from '../../contract/scopes.ts';
import type { MoneyJson } from '../../contract/snapshot.ts';
import type { Severity } from '../../contract/response.ts';
import type { InsightsContext, InsightsExecutor } from '../../db.ts';
import type { HealthPillar } from '../../health/pillars.ts';
import { HEALTH_COMPONENT_IDS, type HealthComponentId } from '../../health/thresholds.ts';
import { BUILTIN_CATALOGUE } from '../catalogue.ts';
import { INSIGHT_EXPLAIN_ADVISOR_ID } from './manifest.ts';
import type { FindingSource } from '../local/findings.ts';
import {
  insightSubjectOf,
  pillarSubjectOf,
  PILLAR_SCOPES,
  type ExplainTarget,
  type RuleText,
} from './request.ts';

export type ExplainSourceOutcome =
  | { readonly status: 'found'; readonly target: ExplainTarget }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'not_explainable';
      readonly reason:
        | 'not_builtin'
        | 'narration'
        | 'no_evidence'
        | 'source_run_unknown'
        | 'pillar_not_scored'
        | 'health_not_computed';
    };

/** The catalogue's words for a built-in rule: its display name and its purpose. */
export function ruleTextOf(advisorId: string): RuleText | null {
  const entry = BUILTIN_CATALOGUE.find((item) => item.advisorId === advisorId);
  if (entry === undefined) return null;
  return {
    name: entry.advisor.manifest.display_name,
    text: entry.advisor.manifest.purpose,
  };
}

/** Catalogue order, and only scopes the contract knows. */
function catalogueOrder(scopes: readonly string[]): AdvisorScope[] {
  const wanted = new Set(scopes);
  return ADVISOR_SCOPES.filter((scope) => wanted.has(scope));
}

export async function loadInsightExplainTarget(
  executor: InsightsExecutor,
  userId: string,
  insightId: string,
): Promise<ExplainSourceOutcome> {
  const rows = await executor
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.id, insightId)));
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (row.narratesInsightId !== null) return { status: 'not_explainable', reason: 'narration' };
  const rule = ruleTextOf(row.advisorId);
  if (rule === null) return { status: 'not_explainable', reason: 'not_builtin' };
  const evidence = (
    await executor
      .select()
      .from(insightEvidence)
      .where(and(eq(insightEvidence.userId, userId), eq(insightEvidence.insightId, insightId)))
  ).sort((left, right) => left.position - right.position);
  if (evidence.length === 0) return { status: 'not_explainable', reason: 'no_evidence' };
  if (row.runId === null) return { status: 'not_explainable', reason: 'source_run_unknown' };
  const runs = await executor
    .select({ emittedScopes: advisorRuns.emittedScopes })
    .from(advisorRuns)
    .where(and(eq(advisorRuns.userId, userId), eq(advisorRuns.id, row.runId)));
  const run = runs[0];
  if (run === undefined) return { status: 'not_explainable', reason: 'source_run_unknown' };

  const currency = row.impactCurrency;
  const money = (minor: bigint | null): MoneyJson | null =>
    minor === null || currency === null ? null : { minor: minor.toString(), currency };
  const source: FindingSource = {
    key: row.key,
    period: row.period,
    type: row.type,
    severity: row.severity as Severity,
    title: row.title,
    summaryMd: row.summaryMd,
    evidence: evidence.map((entry) => ({
      label: entry.label,
      value: entry.value,
      sourceRef: entry.sourceRef,
      resolvedDisplay: entry.resolvedDisplay,
    })),
    derived: [],
    impact: {
      annualized: money(row.impactAnnualizedMinor),
      oneTime: money(row.impactOneTimeMinor),
      basis: row.impactBasis,
    },
  };
  return {
    status: 'found',
    target: {
      entityKind: 'insight',
      entityId: row.id,
      subject: insightSubjectOf(source, rule),
      scopes: catalogueOrder(run.emittedScopes),
    },
  };
}

export function isHealthComponentId(value: string): value is HealthComponentId {
  return (HEALTH_COMPONENT_IDS as readonly string[]).includes(value);
}

export async function loadPillarExplainTarget(
  executor: InsightsExecutor,
  userId: string,
  component: HealthComponentId,
): Promise<ExplainSourceOutcome> {
  const rows = await executor
    .select({ pillars: healthScoreSnapshots.pillars })
    .from(healthScoreSnapshots)
    .where(eq(healthScoreSnapshots.userId, userId))
    .orderBy(desc(healthScoreSnapshots.asOfDate))
    .limit(1);
  const latest = rows[0];
  if (latest === undefined) return { status: 'not_explainable', reason: 'health_not_computed' };
  const pillar = (latest.pillars as unknown as readonly HealthPillar[]).find(
    (entry) => entry.component === component,
  );
  if (pillar === undefined || pillar.status !== 'scored') {
    return { status: 'not_explainable', reason: 'pillar_not_scored' };
  }
  return {
    status: 'found',
    target: {
      entityKind: 'health_pillar',
      entityId: component,
      subject: pillarSubjectOf(pillar),
      scopes: catalogueOrder(PILLAR_SCOPES[component]),
    },
  };
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

export interface StoredExplanation {
  readonly id: string;
  readonly entityKind: ExplanationEntityKind;
  readonly entityId: string;
  readonly evidenceDigest: string;
  /** `null` exactly when `refusal` is set. */
  readonly text: string | null;
  readonly refusal: string | null;
  readonly provider: string;
  readonly model: string;
  readonly runId: string;
  readonly createdAt: Date;
}

function storedOf(row: InsightExplanationRow): StoredExplanation {
  return {
    id: row.id,
    entityKind: row.entityKind,
    entityId: row.entityId,
    evidenceDigest: row.evidenceDigest,
    text: row.explanationText,
    refusal: row.refusal,
    provider: row.llmProvider,
    model: row.llmModel,
    runId: row.runId,
    createdAt: row.createdAt,
  };
}

/** The explanation already given for exactly this evidence, or `null`. */
export async function findExplanation(
  executor: InsightsExecutor,
  userId: string,
  key: {
    readonly entityKind: ExplanationEntityKind;
    readonly entityId: string;
    readonly evidenceDigest: string;
  },
): Promise<StoredExplanation | null> {
  const rows = await executor
    .select()
    .from(insightExplanations)
    .where(
      and(
        eq(insightExplanations.userId, userId),
        eq(insightExplanations.entityKind, key.entityKind),
        eq(insightExplanations.entityId, key.entityId),
        eq(insightExplanations.evidenceDigest, key.evidenceDigest),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

/** Every explanation of one entity, newest first: the audit trail a new digest never erases. */
export async function listExplanations(
  executor: InsightsExecutor,
  userId: string,
  entityKind: ExplanationEntityKind,
  entityId: string,
): Promise<StoredExplanation[]> {
  const rows = await executor
    .select()
    .from(insightExplanations)
    .where(
      and(
        eq(insightExplanations.userId, userId),
        eq(insightExplanations.entityKind, entityKind),
        eq(insightExplanations.entityId, entityId),
      ),
    )
    .orderBy(desc(insightExplanations.createdAt));
  return rows.map(storedOf);
}

/**
 * Write one explanation (or its refusal). Idempotent per (holder, entity,
 * digest): a second write for the same evidence keeps the first — the cache
 * is computed once per digest and never overwritten.
 */
export async function recordExplanation(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly entityKind: ExplanationEntityKind;
    readonly entityId: string;
    readonly evidenceDigest: string;
    readonly text: string | null;
    readonly refusal: string | null;
    readonly provider: string;
    readonly model: string;
    readonly runId: string;
  },
): Promise<StoredExplanation | null> {
  const rows = await executor
    .insert(insightExplanations)
    .values({
      id: newId(),
      userId: context.userId,
      entityKind: input.entityKind,
      entityId: input.entityId,
      evidenceDigest: input.evidenceDigest,
      explanationText: input.text,
      refusal: input.refusal,
      llmProvider: input.provider,
      llmModel: input.model.slice(0, 200),
      runId: input.runId,
      createdAt: context.clock.now(),
    })
    .onConflictDoNothing({
      target: [
        insightExplanations.userId,
        insightExplanations.entityKind,
        insightExplanations.entityId,
        insightExplanations.evidenceDigest,
      ],
    })
    .returning();
  const row = rows[0];
  return row === undefined ? null : storedOf(row);
}

/**
 * The newest `insight.explain` run that carried exactly this digest, for the
 * screen's poll: a run that failed or was cancelled is said so, and the
 * holder may ask again.
 */
export async function latestExplainRun(
  executor: InsightsExecutor,
  userId: string,
  evidenceDigest: string,
): Promise<{
  readonly id: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly cancelReason: string | null;
  readonly startedAt: Date;
} | null> {
  const rows = await executor
    .select({
      id: advisorRuns.id,
      status: advisorRuns.status,
      errorCode: advisorRuns.errorCode,
      cancelReason: advisorRuns.cancelReason,
      startedAt: advisorRuns.startedAt,
    })
    .from(advisorRuns)
    .where(
      and(
        eq(advisorRuns.userId, userId),
        eq(advisorRuns.advisorId, INSIGHT_EXPLAIN_ADVISOR_ID),
        eq(advisorRuns.inputDigest, evidenceDigest),
      ),
    )
    .orderBy(desc(advisorRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}
