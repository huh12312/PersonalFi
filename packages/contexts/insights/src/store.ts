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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from './db.ts';
import type { AdvisorManifest } from './contract/manifest.ts';
import type { AdvisorScope } from './contract/scopes.ts';
import type { ValidatedInsight } from './validate/pipeline.ts';
import {
  advisorRunPayloads,
  advisorRuns,
  advisors,
  insightActions,
  insightDismissals,
  insightEvidence,
  insightFeedback,
  insights,
  snapshotGrantEvents,
  snapshotGrants,
  type AdvisorRow,
  type AdvisorRunPayloadRow,
  type AdvisorRunRow,
  type CancelReasonValue,
  type EnabledSource,
  type FeedbackAction,
  type GrantEventKind,
  type InsightDismissalRow,
  type InsightRow,
  type QuarantineReasonValue,
  type ReasonCode,
  type RunRefusalValue,
  type RunTrigger,
} from '../schema/index.ts';
import type { SuppressionState } from './policy/cooldown.ts';
import { decideFeedbackEffects, reasonCodeForPreset } from './policy/feedback.ts';
import { recordOutcomeOnAccept } from './policy/outcomes.ts';

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

/**
 * The `advisors` row for one advisor, locked `FOR UPDATE` until the caller's
 * transaction ends.
 *
 * The write barrier's lock (WP 5.1). Every writer of a level-3 or level-4
 * switch — `setAdvisorEnabled`, `quarantineAdvisor`, `requestRunCancel`, an
 * approval change — updates or locks this same row, so a barrier holding it
 * and a kill arriving at the same moment are serialised: either the barrier
 * reads the kill and writes nothing, or the kill waits and lands after the
 * insert has committed. There is no third interleaving.
 */
export async function lockAdvisor(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
): Promise<AdvisorRow | null> {
  const rows = await executor
    .select()
    .from(advisors)
    .where(and(eq(advisors.userId, userId), eq(advisors.advisorId, advisorId)))
    .for('update');
  return rows[0] ?? null;
}

export interface RegisterAdvisorInput {
  readonly manifest: AdvisorManifest;
  /**
   * The catalogue's default for this advisor. On a new row it is the value;
   * on an existing row it is applied **only while `enabled_source` is
   * `default`** — nobody has touched it — so a wave released later reaches an
   * existing install and a human's switch survives every restart. Absent
   * means "leave `enabled` alone" on an existing row, and off on a new one.
   */
  readonly enabled?: boolean;
}

/**
 * Write the registry row for a manifest, creating or refreshing it.
 *
 * The conflict target is `(user_id, advisor_id)` and the update deliberately
 * does not touch `quarantined_at` or `consecutive_failures`: those are
 * *operational* state about this deployment's experience of the advisor, and a
 * version bump is not a reason to forget that the breaker tripped last night.
 *
 * `enabled` moves only on a row whose `enabled_source` is still `default`
 * (migration 0028). Before WP 5.1 this branch wrote `input.enabled`
 * unconditionally, and `apps/api`'s boot pass passes the catalogue default
 * every boot — so a restart undid the holder's own switch
 * (docs/evidence/phase-5/wp5.1-run-control.md §7).
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
      enabledSource: 'default',
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
        ...(input.enabled === undefined
          ? {}
          : {
              // The existing row's own columns, qualified, against the
              // proposed row's `excluded` value: only an untouched default
              // follows the catalogue.
              enabled: sql`CASE WHEN "advisors"."enabled_source" = 'default' THEN excluded."enabled" ELSE "advisors"."enabled" END`,
            }),
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`failed to register advisor ${manifest.advisor_id}`);
  return row;
}

/**
 * Kill switch level 3, set by someone: a human through the step-up route
 * (`user`, the default) or WP 5.9's feedback loop (`feedback`). Either way the
 * row stops following the catalogue — see `registerAdvisor`.
 */
export async function setAdvisorEnabled(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  enabled: boolean,
  source: Exclude<EnabledSource, 'default'> = 'user',
): Promise<void> {
  await executor
    .update(advisors)
    .set({ enabled, enabledSource: source, updatedAt: context.clock.now() })
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

/** Who authorised a consent change (O-9). Optional: a change made outside a request has no session. */
export interface GrantChangeOptions {
  /**
   * The session whose fresh step-up assertion authorised the change (D21),
   * recorded on the event. A reference, not a foreign key: the record outlives
   * the session. The consent route always supplies it.
   */
  readonly stepUpSessionId?: string | null;
}

/**
 * Grant scopes, and record each change that actually changed something in
 * `snapshot_grant_events` (O-9) in the same executor — so, in the consent
 * route's transaction, atomically with the state row.
 *
 * What an event says: `granted` — never granted before; `re_granted` — it had
 * been revoked; nothing at all when the scope was already live (the state row
 * is re-stamped as it always was, but no change of consent happened). The
 * state row is still overwritten on a re-grant ("the grant in force is the one
 * that started today"); the events are what is never overwritten.
 */
export async function grantScopes(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  scopes: readonly AdvisorScope[],
  perRunConsent = false,
  options: GrantChangeOptions = {},
): Promise<void> {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) return;
  const now = context.clock.now();

  // What each scope was before this call. Row-locked, so a concurrent writer
  // cannot make this call classify against a state that is about to change.
  const prior = await executor
    .select({ scope: snapshotGrants.scope, revokedAt: snapshotGrants.revokedAt })
    .from(snapshotGrants)
    .where(
      and(
        eq(snapshotGrants.userId, context.userId),
        eq(snapshotGrants.advisorId, advisorId),
        inArray(snapshotGrants.scope, unique),
      ),
    )
    .for('update');
  const before = new Map(
    prior.map((row) => [row.scope, row.revokedAt === null ? 'live' : 'revoked'] as const),
  );

  await executor
    .insert(snapshotGrants)
    .values(
      unique.map((scope) => ({
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

  const changed = unique.filter((scope) => before.get(scope) !== 'live');
  if (changed.length === 0) return;
  await executor.insert(snapshotGrantEvents).values(
    changed.map((scope) => ({
      id: newId(),
      userId: context.userId,
      advisorId,
      scope,
      event: before.get(scope) === 'revoked' ? ('re_granted' as const) : ('granted' as const),
      perRunConsent,
      stepUpSessionId: options.stepUpSessionId ?? null,
      occurredAt: now,
      createdAt: now,
    })),
  );
}

/**
 * Revoke scopes: a revocation, not a delete, and one `revoked` event per grant
 * that was live. A scope that is not currently granted (never granted, or
 * already revoked) changes nothing and records nothing.
 */
export async function revokeScopes(
  executor: InsightsExecutor,
  context: InsightsContext,
  advisorId: string,
  scopes: readonly AdvisorScope[],
  options: GrantChangeOptions = {},
): Promise<void> {
  if (scopes.length === 0) return;
  const now = context.clock.now();
  const revoked = await executor
    .update(snapshotGrants)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(snapshotGrants.userId, context.userId),
        eq(snapshotGrants.advisorId, advisorId),
        inArray(snapshotGrants.scope, [...scopes]),
        sql`${snapshotGrants.revokedAt} IS NULL`,
      ),
    )
    .returning({ scope: snapshotGrants.scope, perRunConsent: snapshotGrants.perRunConsent });
  if (revoked.length === 0) return;
  await executor.insert(snapshotGrantEvents).values(
    revoked.map((row) => ({
      id: newId(),
      userId: context.userId,
      advisorId,
      scope: row.scope,
      event: 'revoked' as const,
      perRunConsent: row.perRunConsent,
      stepUpSessionId: options.stepUpSessionId ?? null,
      occurredAt: now,
      createdAt: now,
    })),
  );
}

/** One row of a scope's consent history (O-9). */
export interface GrantEventView {
  readonly id: string;
  readonly advisorId: string;
  readonly scope: AdvisorScope;
  readonly event: GrantEventKind;
  readonly perRunConsent: boolean;
  readonly stepUpSessionId: string | null;
  readonly occurredAt: Date;
}

/** Newest first. Scoped to the holder AND the advisor: both predicates are tested alone (`grant-history.test.ts`). */
export async function listGrantEvents(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
  limit = 200,
): Promise<readonly GrantEventView[]> {
  const rows = await executor
    .select()
    .from(snapshotGrantEvents)
    .where(
      and(eq(snapshotGrantEvents.userId, userId), eq(snapshotGrantEvents.advisorId, advisorId)),
    )
    .orderBy(desc(snapshotGrantEvents.occurredAt), desc(snapshotGrantEvents.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    advisorId: row.advisorId,
    scope: row.scope as AdvisorScope,
    event: row.event,
    perRunConsent: row.perRunConsent,
    stepUpSessionId: row.stepUpSessionId,
    occurredAt: row.occurredAt,
  }));
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
  readonly status: 'completed' | 'failed' | 'refused' | 'cancelled';
  readonly refusal?: RunRefusalValue | null;
  /** Exactly when `status` is `cancelled`: the broadest level that applied. */
  readonly cancelReason?: CancelReasonValue | null;
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
      cancelReason: input.cancelReason ?? null,
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

export async function findRun(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
): Promise<AdvisorRunRow | null> {
  const rows = await executor
    .select()
    .from(advisorRuns)
    .where(and(eq(advisorRuns.userId, userId), eq(advisorRuns.id, runId)));
  return rows[0] ?? null;
}

/**
 * What a `local_model` run sent its prompt to, and the hash of the prompt —
 * written before the call, so a run that never returns still says which model
 * it was waiting on.
 */
export async function recordRunModel(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: { readonly runId: string; readonly llmModel: string; readonly llmPromptHash: string },
): Promise<void> {
  await executor
    .update(advisorRuns)
    .set({ llmModel: input.llmModel, llmPromptHash: input.llmPromptHash })
    .where(and(eq(advisorRuns.userId, context.userId), eq(advisorRuns.id, input.runId)));
}

export type CancelRequestOutcome = 'requested' | 'not_found' | 'not_running';

/**
 * Kill level 4: ask one run to stop.
 *
 * Its own transaction, and it takes the `advisors` row lock first — the same
 * lock the write barrier holds — so a cancel and a barrier are serialised: a
 * cancel that commits first is seen by the barrier; one that waits finds the
 * run already `completed` and changes nothing (`not_running`). The run itself
 * notices within a second through the run watcher and closes `cancelled`
 * with `run_cancelled`. A second request on a run already cancelling keeps
 * the first request's timestamp.
 */
export async function requestRunCancel(
  database: InsightsDatabase,
  context: InsightsContext,
  runId: string,
): Promise<CancelRequestOutcome> {
  return database.transaction(async (tx) => {
    const run = await findRun(tx, context.userId, runId);
    if (run === null) return 'not_found';
    await lockAdvisor(tx, context.userId, run.advisorId);
    return (await markCancelRequested(tx, context.userId, runId, context.clock.now()))
      ? 'requested'
      : 'not_running';
  });
}

/**
 * The cancel `UPDATE` on its own: stamps `cancel_requested_at` on a `started`
 * run of this holder and reports whether a row was touched. Split out of
 * `requestRunCancel` (C5-6, G5-17) so its own `userId` predicate can be
 * tested directly: inside `requestRunCancel`, `findRun`'s `userId` guard
 * refuses a foreign run first, which shadows this one (gate §2.5 R4a stayed
 * green with it dropped). `requestRunCancel` calls exactly this function, so
 * the test and the route exercise the same query.
 */
export async function markCancelRequested(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
  now: Date,
): Promise<boolean> {
  const updated = await executor
    .update(advisorRuns)
    .set({ cancelRequestedAt: sql`COALESCE(${advisorRuns.cancelRequestedAt}, ${now})` })
    .where(
      and(
        eq(advisorRuns.userId, userId),
        eq(advisorRuns.id, runId),
        eq(advisorRuns.status, 'started'),
      ),
    )
    .returning({ id: advisorRuns.id });
  return updated.length > 0;
}

/**
 * Validator rejections for one advisor in `[since, ∞)`: refused insights
 * (steps 4–7, `rejected_count`) plus whole responses refused at steps 1–3
 * (a `failed` run whose `error_code` names one of those steps). The rolling
 * 24 h input of the `local_model` breaker (08 §4.4's "5 schema violations in
 * 24h").
 */
export async function rejectionsSince(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
  since: Date,
): Promise<number> {
  const rows = await executor
    .select({
      insights: sql<string>`COALESCE(SUM(${advisorRuns.rejectedCount}), 0)::text`,
      responses: sql<string>`COUNT(*) FILTER (WHERE ${advisorRuns.status} = 'failed'
        AND ${advisorRuns.errorCode} ~ '^(transport|schema|envelope):')::text`,
    })
    .from(advisorRuns)
    .where(
      and(
        eq(advisorRuns.userId, userId),
        eq(advisorRuns.advisorId, advisorId),
        sql`${advisorRuns.startedAt} >= ${since}`,
      ),
    );
  const row = rows[0];
  return row === undefined ? 0 : Number(row.insights) + Number(row.responses);
}

// ---------------------------------------------------------------------------
// advisor_run_payloads — what a local_model / external run was sent (0028)
// ---------------------------------------------------------------------------

/** 05 §3 WP 5.1: thirty days, and the table's CHECK refuses more. */
export const RUN_PAYLOAD_RETENTION_DAYS = 30;

export async function retainRunPayload(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: {
    readonly runId: string;
    readonly advisorId: string;
    readonly queryShape: string;
    readonly payload: Record<string, unknown>;
    readonly payloadBytes: number;
  },
): Promise<void> {
  const now = context.clock.now();
  await executor.insert(advisorRunPayloads).values({
    runId: input.runId,
    userId: context.userId,
    advisorId: input.advisorId,
    queryShape: input.queryShape,
    payload: input.payload,
    payloadBytes: input.payloadBytes,
    retainedAt: now,
    expiresAt: new Date(now.getTime() + RUN_PAYLOAD_RETENTION_DAYS * 86_400_000),
    createdAt: now,
  });
}

/** The retained payload, or `null` when there is none or it has expired. */
export async function findRunPayload(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
  now: Date,
): Promise<AdvisorRunPayloadRow | null> {
  const rows = await executor
    .select()
    .from(advisorRunPayloads)
    .where(
      and(
        eq(advisorRunPayloads.userId, userId),
        eq(advisorRunPayloads.runId, runId),
        sql`${advisorRunPayloads.expiresAt} > ${now}`,
      ),
    );
  return rows[0] ?? null;
}

/** Delete what has outlived its bound. The local lane calls it before every run. */
export async function pruneRunPayloads(
  executor: InsightsExecutor,
  userId: string,
  now: Date,
): Promise<number> {
  const deleted = await executor
    .delete(advisorRunPayloads)
    .where(
      and(eq(advisorRunPayloads.userId, userId), sql`${advisorRunPayloads.expiresAt} <= ${now}`),
    )
    .returning({ runId: advisorRunPayloads.runId });
  return deleted.length;
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
  /**
   * The 07 §8.3 taxonomy. When omitted, `reason` is matched against the
   * three presets `DismissReasonDialog.tsx` has been storing
   * (`policy/feedback.ts`'s `reasonCodeForPreset`) — the same mapping
   * migration `0030_insight_feedback_reasons.sql` applies once to rows
   * already written. Anything else keeps its text with no code.
   */
  readonly reasonCode?: ReasonCode | null;
  /** Required for `snooze`, forbidden otherwise. The schema enforces both. */
  readonly snoozeUntil?: Date | null;
  /** Verification horizon for `accept`. Defaults to `policy/outcomes.ts`'s. */
  readonly outcomeHorizonDays?: number;
}

export interface FeedbackResult {
  readonly status: string;
  readonly suppression: SuppressionState | null;
  /** What the reason resolved to — explicit, or matched from a preset, or `null`. */
  readonly reasonCode: ReasonCode | null;
  /** `true` when this event crossed the `NOT_TRUE` threshold and quarantined it. */
  readonly quarantined: boolean;
  /** `true` when `DONT_CARE` switched the rule off for this holder. */
  readonly ruleDisabledForHolder: boolean;
}

/**
 * How many `dismiss` responses this advisor has already received from this
 * holder, and how many of those carried `NOT_TRUE` — the denominator and
 * numerator `policy/feedback.ts`'s quarantine check needs, read fresh so a
 * concurrent second dismissal cannot under-count. Excludes the row this call
 * is about to write; `decideFeedbackEffects` adds it back in.
 */
async function priorDismissFirings(
  executor: InsightsExecutor,
  userId: string,
  advisorId: string,
): Promise<{ readonly priorDismissTotal: number; readonly priorNotTrue: number }> {
  const rows = await executor
    .select({
      total: sql<number>`count(*)`,
      notTrue: sql<number>`count(*) filter (where ${insightFeedback.reasonCode} = 'NOT_TRUE')`,
    })
    .from(insightFeedback)
    .where(
      and(
        eq(insightFeedback.userId, userId),
        eq(insightFeedback.advisorId, advisorId),
        eq(insightFeedback.action, 'dismiss'),
      ),
    );
  const row = rows[0];
  return {
    priorDismissTotal: Number(row?.total ?? 0),
    priorNotTrue: Number(row?.notTrue ?? 0),
  };
}

/**
 * Record what the user did, in one transaction: the log, the row's status,
 * the ladder, and — WP 5.9 — the dismiss-reason taxonomy's effects.
 *
 * The log, the status change and the ladder are inseparable, as they were
 * before this migration: a dismissal that advanced the ladder but left
 * `insights.status` at `pending_review` would show the user a finding they
 * had just refused; a status change with no ladder row would offer it again
 * tomorrow. The reason-code effects join the same transaction for the same
 * reason — `DONT_CARE` writing `enabled_source` in a second call could land
 * after a crash between the two and leave the rule showing as still on.
 *
 * Every ladder decision and every side effect (quarantine, `enabled_source`)
 * is decided by `policy/feedback.ts`'s pure `decideFeedbackEffects`; this
 * function only reads the state that function needs and writes what it
 * returns.
 */
export async function recordFeedback(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: FeedbackInput,
): Promise<FeedbackResult> {
  const now = context.clock.now();
  const insight = await findInsight(executor, context.userId, input.insightId);
  if (insight === null) throw new Error(`no insight ${input.insightId}`);

  const resolvedReasonCode: ReasonCode | null =
    input.reasonCode ?? reasonCodeForPreset(input.reason ?? null);

  await executor.insert(insightFeedback).values({
    id: newId(),
    userId: context.userId,
    insightId: insight.id,
    advisorId: insight.advisorId,
    insightKey: insight.key,
    action: input.action,
    reason: input.reason ?? null,
    reasonCode: input.action === 'dismiss' || input.action === 'snooze' ? resolvedReasonCode : null,
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
    await recordOutcomeOnAccept(executor, context, insight, now, input.outcomeHorizonDays);
    return {
      status,
      suppression: null,
      reasonCode: null,
      quarantined: false,
      ruleDisabledForHolder: false,
    };
  }

  const [previous, advisor, firings] = await Promise.all([
    loadSuppression(executor, context.userId, insight.advisorId, insight.key),
    findAdvisor(executor, context.userId, insight.advisorId),
    priorDismissFirings(executor, context.userId, insight.advisorId),
  ]);

  const effects = decideFeedbackEffects({
    action: input.action,
    reasonCode: resolvedReasonCode,
    previousSuppression: previous,
    now,
    snoozeUntil: input.snoozeUntil ?? null,
    advisorQuarantined: advisor !== null && advisor.quarantinedAt !== null,
    firings,
  });
  const next = effects.suppression;

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

  if (effects.setEnabled !== null) {
    await setAdvisorEnabled(
      executor,
      context,
      insight.advisorId,
      effects.setEnabled.enabled,
      effects.setEnabled.source,
    );
  }
  if (effects.quarantine !== null) {
    await quarantineAdvisor(executor, context, insight.advisorId, effects.quarantine.reason);
  }

  return {
    status,
    suppression: next,
    reasonCode: resolvedReasonCode,
    quarantined: effects.quarantine !== null,
    ruleDisabledForHolder: effects.setEnabled !== null,
  };
}
