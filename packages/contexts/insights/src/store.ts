// SPDX-License-Identifier: MIT
/**
 * Persistence. The only writer of `insights`, and it takes a `ValidatedInsight`.
 *
 * That signature is the load-bearing part of this file. `upsertInsight` cannot
 * be called with an `Insight` straight off the wire, because `ValidatedInsight`
 * is constructed nowhere except `validate/pipeline.ts`. So "nothing reaches the
 * review queue without passing all seven steps" is a type error rather than a
 * code-review convention, and the sabotage test that tries to write around it
 * has to delete a type to succeed.
 *
 * ## The upsert, and what it deliberately does not touch
 *
 * The identity is `(user_id, advisor_id, key, period)`. A nightly re-run of a
 * finding that is still true updates the row; it does not insert a second one,
 * and `'a nightly re-run updates the row rather than inserting'` asserts it.
 *
 * On conflict the update refreshes what a *new proposal* legitimately changes —
 * the wording, the impact, the run it came from, `last_proposed_at`, the
 * digest — and leaves three things alone:
 *
 *   * **`first_proposed_at`**, because "since when has this been true?" is the
 *     most useful thing the feed knows and an upsert that moved it would reset
 *     the answer every night.
 *   * **`status` and `reviewed_at`**, because a re-proposal is not a review. A
 *     finding the user accepted in March does not become unanswered in April
 *     because the advisor said it again. (In practice a dismissed finding is
 *     suppressed before it is ever re-proposed — `policy/cooldown.ts` — but the
 *     write path must not depend on the read path for a correctness property.)
 *   * **`id`**, so every `insight_evidence` and `insight_actions` row that
 *     points at it survives; the children are replaced in place rather than
 *     re-parented.
 *
 * ## Evidence and actions are replaced, not merged
 *
 * The advisor's arrays are positional and the whole argument may have changed
 * shape between runs. Merging would leave a stale citation behind whenever a
 * re-run produced fewer rows, which is a citation that no longer supports the
 * sentence beside it — the worst kind of stale.
 */
import { newId } from '@core/kernel';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { InsightsContext, InsightsExecutor } from './db.ts';
import type { AdvisorManifest } from './contract/manifest.ts';
import type { AdvisorScope } from './contract/scopes.ts';
import type { ValidatedInsight } from './validate/pipeline.ts';
import {
  advisorRuns,
  advisors,
  insightActions,
  insightDismissals,
  insightEvidence,
  insightFeedback,
  insights,
  snapshotGrants,
  type AdvisorRow,
  type AdvisorRunRow,
  type FeedbackAction,
  type InsightDismissalRow,
  type InsightRow,
  type QuarantineReasonValue,
  type RunRefusalValue,
  type RunTrigger,
} from '../schema/index.ts';
import { afterDismissal, afterSnooze, type SuppressionState } from './policy/cooldown.ts';

/**
 * Advisory-lock class for this context.
 *
 * Distinct from every other context's so two contexts' locks cannot collide in
 * the shared `pg_advisory_lock` namespace. Used to serialise a user's advisor
 * runs: two workers running the same advisor for the same user at the same
 * moment would both build a snapshot, both upsert, and produce an
 * `advisor_runs` pair that is indistinguishable from a retry.
 */
export const INSIGHTS_ADVISORY_LOCK_CLASS = 0x1_69_00_06;

// ---------------------------------------------------------------------------
// advisors
// ---------------------------------------------------------------------------

export async function findAdvisor(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
): Promise<AdvisorRow | null> {
  const rows = await executor
    .select()
    .from(advisors)
    .where(and(eq(advisors.userId, userId), eq(advisors.advisorId, advisorId)));
  return rows[0] ?? null;
}

export async function listAdvisors(
  executor: InsightsExecutor,
  userId: string,
): Promise<readonly AdvisorRow[]> {
  return executor
    .select()
    .from(advisors)
    .where(eq(advisors.userId, userId))
    .orderBy(asc(advisors.advisorId));
}

export interface RegisterAdvisorInput {
  readonly manifest: AdvisorManifest;
  /**
   * Whether to turn it on. Absent means "leave whatever is there", which is
   * what a boot-time re-registration wants: restarting the API must not
   * re-enable an advisor the user switched off.
   */
  readonly enabled?: boolean;
}

/**
 * Write the registry row for a manifest, creating or refreshing it.
 *
 * The conflict target is `(user_id, advisor_id)` and the update deliberately
 * does not touch `enabled`, `quarantined_at` or `consecutive_failures`: those
 * are *operational* state about this deployment's experience of the advisor,
 * and a version bump is not a reason to forget that the breaker tripped last
 * night. Only an explicit `enabled` in the input moves the switch.
 */
export async function registerAdvisor(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: RegisterAdvisorInput,
): Promise<AdvisorRow> {
  const { manifest } = input;
  const now = context.clock.now();
  const rows = await executor
    .insert(advisors)
    .values({
      id: newId(),
      userId: context.userId,
      advisorId: manifest.advisor_id,
      version: manifest.version,
      kind: manifest.kind,
      contractVersion: manifest.contract_version,
      displayName: manifest.display_name,
      purpose: manifest.purpose,
      manifest: manifest as unknown as Record<string, unknown>,
      requiresScopes: [...manifest.requires_scopes],
      maxSeverity: manifest.capabilities.max_severity,
      deterministic: manifest.capabilities.deterministic,
      producesImpact: manifest.capabilities.produces_impact,
      narratesOnly: manifest.capabilities.narrates_only,
      egressAllowlist: [...manifest.egress_allowlist],
      enabled: input.enabled ?? false,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [advisors.userId, advisors.advisorId],
      set: {
        version: manifest.version,
        kind: manifest.kind,
        contractVersion: manifest.contract_version,
        displayName: manifest.display_name,
        purpose: manifest.purpose,
        manifest: manifest as unknown as Record<string, unknown>,
        requiresScopes: [...manifest.requires_scopes],
        maxSeverity: manifest.capabilities.max_severity,
        deterministic: manifest.capabilities.deterministic,
        producesImpact: manifest.capabilities.produces_impact,
        narratesOnly: manifest.capabilities.narrates_only,
        egressAllowlist: [...manifest.egress_allowlist],
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`failed to register advisor ${manifest.advisor_id}`);
  return row;
}

export async function setAdvisorEnabled(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  enabled: boolean,
): Promise<void> {
  await executor
    .update(advisors)
    .set({ enabled, updatedAt: context.clock.now() })
    .where(and(eq(advisors.userId, context.userId), eq(advisors.advisorId, advisorId)));
}

/** Trip the breaker. Cleared only by `clearQuarantine`, never by time. */
export async function quarantineAdvisor(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  reason: QuarantineReasonValue,
): Promise<void> {
  const now = context.clock.now();
  await executor
    .update(advisors)
    .set({ quarantinedAt: now, quarantineReason: reason, updatedAt: now })
    .where(and(eq(advisors.userId, context.userId), eq(advisors.advisorId, advisorId)));
}

export async function clearQuarantine(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
): Promise<void> {
  const now = context.clock.now();
  await executor
    .update(advisors)
    .set({
      quarantinedAt: null,
      quarantineReason: null,
      consecutiveFailures: 0,
      updatedAt: now,
    })
    .where(and(eq(advisors.userId, context.userId), eq(advisors.advisorId, advisorId)));
}

/**
 * Record the outcome of a run against the advisor's health.
 *
 * `succeeded` resets the failure streak to zero rather than decrementing it.
 * Five failures then one success is an advisor that works; treating it as "four
 * failures" would quarantine it on the next single bad night.
 */
export async function recordRunHealth(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  succeeded: boolean,
): Promise<number> {
  const now = context.clock.now();
  const rows = await executor
    .update(advisors)
    .set({
      consecutiveFailures: succeeded ? 0 : sql`${advisors.consecutiveFailures} + 1`,
      lastRunAt: now,
      updatedAt: now,
    })
    .where(and(eq(advisors.userId, context.userId), eq(advisors.advisorId, advisorId)))
    .returning({ consecutiveFailures: advisors.consecutiveFailures });
  return rows[0]?.consecutiveFailures ?? 0;
}

// ---------------------------------------------------------------------------
// snapshot_grants
// ---------------------------------------------------------------------------

/** The live grants for one advisor. Revoked rows are history, not a grant. */
export async function listGrants(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
): Promise<readonly AdvisorScope[]> {
  const rows = await executor
    .select({ scope: snapshotGrants.scope })
    .from(snapshotGrants)
    .where(
      and(
        eq(snapshotGrants.userId, userId),
        eq(snapshotGrants.advisorId, advisorId),
        sql`${snapshotGrants.revokedAt} IS NULL`,
      ),
    )
    .orderBy(asc(snapshotGrants.scope));
  return rows.map((row) => row.scope as AdvisorScope);
}

export async function grantScopes(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  scopes: readonly AdvisorScope[],
  perRunConsent = false,
): Promise<void> {
  if (scopes.length === 0) return;
  const now = context.clock.now();
  await executor
    .insert(snapshotGrants)
    .values(
      scopes.map((scope) => ({
        id: newId(),
        userId: context.userId,
        advisorId,
        scope,
        perRunConsent,
        grantedAt: now,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    )
    // Re-granting a revoked scope clears the revocation and re-stamps the
    // grant date, which is what the privacy screen should show: the grant in
    // force is the one that started today, not the one from March.
    .onConflictDoUpdate({
      target: [snapshotGrants.userId, snapshotGrants.advisorId, snapshotGrants.scope],
      set: { revokedAt: null, grantedAt: now, perRunConsent, updatedAt: now },
    });
}

export async function revokeScopes(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  scopes: readonly AdvisorScope[],
): Promise<void> {
  if (scopes.length === 0) return;
  const now = context.clock.now();
  await executor
    .update(snapshotGrants)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(snapshotGrants.userId, context.userId),
        eq(snapshotGrants.advisorId, advisorId),
        inArray(snapshotGrants.scope, [...scopes]),
      ),
    );
}

// ---------------------------------------------------------------------------
// advisor_runs
// ---------------------------------------------------------------------------

export interface StartRunInput {
  readonly advisorId: string;
  readonly advisorVersion: string | null;
  readonly trigger: RunTrigger;
  readonly triggerEventType?: string | null;
}

export async function startRun(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: StartRunInput,
): Promise<AdvisorRunRow> {
  const now = context.clock.now();
  const rows = await executor
    .insert(advisorRuns)
    .values({
      id: newId(),
      userId: context.userId,
      advisorId: input.advisorId,
      advisorVersion: input.advisorVersion,
      trigger: input.trigger,
      triggerEventType: input.triggerEventType ?? null,
      status: 'started',
      refusal: null,
      inputDigest: null,
      grantedScopes: [],
      emittedScopes: [],
      proposedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      rejections: [],
      correlationId: context.correlationId,
      causationId: context.causationId ?? null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('failed to open an advisor run');
  return row;
}

export interface FinishRunInput {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'refused';
  readonly refusal?: RunRefusalValue | null;
  readonly inputDigest?: string | null;
  readonly grantedScopes?: readonly string[];
  readonly emittedScopes?: readonly string[];
  readonly proposedCount?: number;
  readonly acceptedCount?: number;
  readonly rejectedCount?: number;
  readonly rejections?: readonly Record<string, unknown>[];
  readonly errorCode?: string | null;
  readonly durationMs?: number | null;
}

export async function finishRun(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: FinishRunInput,
): Promise<void> {
  await executor
    .update(advisorRuns)
    .set({
      status: input.status,
      refusal: input.refusal ?? null,
      inputDigest: input.inputDigest ?? null,
      grantedScopes: [...(input.grantedScopes ?? [])],
      emittedScopes: [...(input.emittedScopes ?? [])],
      proposedCount: input.proposedCount ?? 0,
      acceptedCount: input.acceptedCount ?? 0,
      rejectedCount: input.rejectedCount ?? 0,
      rejections: [...(input.rejections ?? [])],
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs ?? null,
      finishedAt: context.clock.now(),
    })
    .where(and(eq(advisorRuns.userId, context.userId), eq(advisorRuns.id, input.runId)));
}

export async function latestRuns(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
  limit = 20,
): Promise<readonly AdvisorRunRow[]> {
  return executor
    .select()
    .from(advisorRuns)
    .where(and(eq(advisorRuns.userId, userId), eq(advisorRuns.advisorId, advisorId)))
    .orderBy(sql`${advisorRuns.startedAt} DESC`)
    .limit(Math.min(Math.max(limit, 1), 200));
}

// ---------------------------------------------------------------------------
// insights
// ---------------------------------------------------------------------------

export interface UpsertInsightInput {
  readonly validated: ValidatedInsight;
  readonly advisorId: string;
  readonly advisorVersion: string;
  readonly runId: string;
  readonly inputDigest: string;
}

export interface UpsertInsightResult {
  readonly insightId: string;
  /** `true` when this run created the row rather than refreshing one. */
  readonly inserted: boolean;
  readonly status: string;
}

/**
 * Write one validated insight and its children, in the caller's transaction.
 *
 * Takes a `ValidatedInsight` and reads `status` from nowhere: the inserted
 * value is `'pending_review'`, the literal, and the conflict branch does not
 * name `status` at all. There is no code path from the advisor's payload to
 * this column, which is the plan's "no field an advisor can set to change it"
 * expressed as the absence of an assignment.
 */
export async function upsertInsight(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: UpsertInsightInput,
): Promise<UpsertInsightResult> {
  const { validated } = input;
  const insight = validated.insight;
  const now = context.clock.now();

  const impactCurrency =
    insight.impact.annualized?.currency ?? insight.impact.one_time?.currency ?? null;

  const rows = await executor
    .insert(insights)
    .values({
      id: newId(),
      userId: context.userId,
      advisorId: input.advisorId,
      advisorVersion: input.advisorVersion,
      runId: input.runId,
      key: insight.key,
      period: insight.period,
      type: insight.type,
      severity: validated.severity,
      severityClamped: validated.severityClamped,
      title: insight.title,
      summaryMd: insight.summary_md,
      confidence: insight.confidence.toFixed(6),
      confidenceBasis: insight.confidence_basis,
      horizon: insight.horizon,
      // The literal. Not `insight.status` — there is no such property — and not
      // a parameter. See this function's doc comment.
      status: 'pending_review',
      impactAnnualizedMinor:
        insight.impact.annualized === null ? null : BigInt(insight.impact.annualized.minor),
      impactOneTimeMinor:
        insight.impact.one_time === null ? null : BigInt(insight.impact.one_time.minor),
      impactCurrency,
      impactBasis: insight.impact.basis,
      impactDerivationId: insight.impact.derivation_id,
      derivations: insight.derivations as unknown as readonly Record<string, unknown>[],
      caveats: [...insight.caveats],
      inputDigest: input.inputDigest,
      firstProposedAt: now,
      lastProposedAt: now,
      reviewedAt: null,
      expiresAt: insight.expires_at === null ? null : new Date(insight.expires_at),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [insights.userId, insights.advisorId, insights.key, insights.period],
      set: {
        advisorVersion: input.advisorVersion,
        runId: input.runId,
        type: insight.type,
        severity: validated.severity,
        severityClamped: validated.severityClamped,
        title: insight.title,
        summaryMd: insight.summary_md,
        confidence: insight.confidence.toFixed(6),
        confidenceBasis: insight.confidence_basis,
        horizon: insight.horizon,
        impactAnnualizedMinor:
          insight.impact.annualized === null ? null : BigInt(insight.impact.annualized.minor),
        impactOneTimeMinor:
          insight.impact.one_time === null ? null : BigInt(insight.impact.one_time.minor),
        impactCurrency,
        impactBasis: insight.impact.basis,
        impactDerivationId: insight.impact.derivation_id,
        derivations: insight.derivations as unknown as readonly Record<string, unknown>[],
        caveats: [...insight.caveats],
        inputDigest: input.inputDigest,
        lastProposedAt: now,
        expiresAt: insight.expires_at === null ? null : new Date(insight.expires_at),
        updatedAt: now,
        // `firstProposedAt`, `status` and `reviewedAt` are absent on purpose.
        // See this file's header.
      },
    })
    .returning({
      id: insights.id,
      status: insights.status,
      firstProposedAt: insights.firstProposedAt,
      lastProposedAt: insights.lastProposedAt,
    });

  const row = rows[0];
  if (row === undefined) throw new Error(`failed to upsert insight ${insight.key}`);

  await executor.delete(insightEvidence).where(eq(insightEvidence.insightId, row.id));
  if (validated.evidence.length > 0) {
    await executor.insert(insightEvidence).values(
      validated.evidence.map((evidence, position) => ({
        id: newId(),
        userId: context.userId,
        insightId: row.id,
        position,
        kind: evidence.kind as 'metric',
        label: evidence.label,
        value: evidence.value,
        sourceRef: evidence.sourceRef,
        resolvedDisplay: evidence.resolvedDisplay,
        href: evidence.href,
        createdAt: now,
      })),
    );
  }

  await executor.delete(insightActions).where(eq(insightActions.insightId, row.id));
  if (insight.proposed_actions.length > 0) {
    await executor.insert(insightActions).values(
      insight.proposed_actions.map((action, position) => ({
        id: newId(),
        userId: context.userId,
        insightId: row.id,
        position,
        kind: action.kind,
        label: action.label,
        rationaleMd: action.rationale_md,
        url: action.url,
        createdAt: now,
      })),
    );
  }

  return {
    insightId: row.id,
    // `first === last` exactly when this statement created the row: the insert
    // branch writes both from the same `now`, and the conflict branch moves
    // only the second. A `RETURNING (xmax = 0)` would be the other way to ask
    // and needs raw SQL to express through this builder.
    inserted: row.firstProposedAt.getTime() === row.lastProposedAt.getTime(),
    status: row.status,
  };
}

export async function findInsight(
  executor: InsightsExecutor,
  userId: string,
  insightId: string,
): Promise<InsightRow | null> {
  const rows = await executor
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.id, insightId)));
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// insight_dismissals — the cooldown ladder's state
// ---------------------------------------------------------------------------

export async function loadSuppression(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
  insightKey: string,
): Promise<SuppressionState | null> {
  const rows = await executor
    .select()
    .from(insightDismissals)
    .where(
      and(
        eq(insightDismissals.userId, userId),
        eq(insightDismissals.advisorId, advisorId),
        eq(insightDismissals.insightKey, insightKey),
      ),
    );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    dismissCount: row.dismissCount,
    suppressedUntil: row.suppressedUntil,
    permanent: row.permanent,
  };
}

/**
 * Every finding this user has silenced, as a map keyed by `advisorId|key`.
 *
 * One query rather than one per proposal: a run producing twenty insights would
 * otherwise make twenty round trips to ask a question whose answer is a small
 * table. The map is built once per run in `service.ts`.
 */
export async function loadSuppressions(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
): Promise<ReadonlyMap<string, SuppressionState>> {
  const rows: readonly InsightDismissalRow[] = await executor
    .select()
    .from(insightDismissals)
    .where(and(eq(insightDismissals.userId, userId), eq(insightDismissals.advisorId, advisorId)));
  const map = new Map<string, SuppressionState>();
  for (const row of rows) {
    map.set(row.insightKey, {
      dismissCount: row.dismissCount,
      suppressedUntil: row.suppressedUntil,
      permanent: row.permanent,
    });
  }
  return map;
}

export interface FeedbackInput {
  readonly insightId: string;
  readonly action: FeedbackAction;
  readonly reason?: string | null;
  /** Required for `snooze`, forbidden otherwise. The schema enforces both. */
  readonly snoozeUntil?: Date | null;
}

export interface FeedbackResult {
  readonly status: string;
  readonly suppression: SuppressionState | null;
}

/**
 * Record what the user did, in one transaction: the log, the row's status, and
 * the ladder.
 *
 * The three are inseparable. A dismissal that advanced the ladder but left
 * `insights.status` at `pending_review` would show the user a finding they had
 * just refused; a status change with no ladder row would offer it again
 * tomorrow. Doing them in one call is how "dismiss" has one meaning.
 */
export async function recordFeedback(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: FeedbackInput,
): Promise<FeedbackResult> {
  const now = context.clock.now();
  const insight = await findInsight(executor, context.userId, input.insightId);
  if (insight === null) throw new Error(`no insight ${input.insightId}`);

  await executor.insert(insightFeedback).values({
    id: newId(),
    userId: context.userId,
    insightId: insight.id,
    advisorId: insight.advisorId,
    insightKey: insight.key,
    action: input.action,
    reason: input.reason ?? null,
    snoozeUntil: input.action === 'snooze' ? (input.snoozeUntil ?? now) : null,
    correlationId: context.correlationId,
    createdAt: now,
  });

  const status =
    input.action === 'accept'
      ? 'accepted'
      : input.action === 'dismiss'
        ? 'dismissed'
        : input.action === 'snooze'
          ? 'snoozed'
          : 'pending_review';

  await executor
    .update(insights)
    .set({
      status,
      // The constraint pairs these: `pending_review` has no review timestamp
      // and everything else has one. A `reopen` therefore clears it, which is
      // the honest record — the user un-answered the question.
      reviewedAt: status === 'pending_review' ? null : now,
      updatedAt: now,
    })
    .where(and(eq(insights.userId, context.userId), eq(insights.id, insight.id)));

  if (input.action === 'accept') {
    return { status, suppression: null };
  }

  const previous = await loadSuppression(executor, context.userId, insight.advisorId, insight.key);
  const next =
    input.action === 'dismiss'
      ? afterDismissal(previous, now)
      : input.action === 'snooze'
        ? afterSnooze(previous, input.snoozeUntil ?? now)
        : // `reopen`: the user took it back. The count stays — three refusals
          // are three refusals — but nothing is silenced right now.
          { dismissCount: previous?.dismissCount ?? 0, suppressedUntil: null, permanent: false };

  await executor
    .insert(insightDismissals)
    .values({
      id: newId(),
      userId: context.userId,
      advisorId: insight.advisorId,
      insightKey: insight.key,
      dismissCount: next.dismissCount,
      suppressedUntil: next.suppressedUntil,
      permanent: next.permanent,
      lastAction: input.action,
      lastActionAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [insightDismissals.userId, insightDismissals.advisorId, insightDismissals.insightKey],
      set: {
        dismissCount: next.dismissCount,
        suppressedUntil: next.suppressedUntil,
        permanent: next.permanent,
        lastAction: input.action,
        lastActionAt: now,
        updatedAt: now,
      },
    });

  return { status, suppression: next };
}
