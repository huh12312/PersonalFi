// SPDX-License-Identifier: MIT
/**
 * `advisors`, `snapshot_grants` and `advisor_runs` — migration
 * `0012_insights.sql`.
 *
 * See that file's header for the design. Three things are worth repeating at
 * the query surface, because they are what a reader of this file is about to
 * get wrong:
 *
 *   * **`enabled` defaults to `FALSE`.** A newly registered advisor is off. Any
 *     code that inserts a row and expects it to run needs to say so explicitly,
 *     which is kill switch 2 having a safe direction rather than a default
 *     somebody can pass `true` past.
 *   * **`quarantinedAt` does not decay.** There is no "quarantined until"; a
 *     tripped breaker is cleared by a human writing `NULL`. A query that treats
 *     an old `quarantined_at` as expired is reviving an advisor nobody looked
 *     at.
 *   * **`advisorId` is text, not this table's `id`.** Every other table in this
 *     package joins on the *string* — `insights.advisor_id`,
 *     `advisor_runs.advisor_id`, `insight_dismissals.advisor_id` — because an
 *     advisor's identity is its published id, and a built-in's id must mean the
 *     same thing after a re-registration that gave it a new uuid.
 */
import {
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const ADVISOR_KIND_VALUES = ['builtin', 'local_model', 'external'] as const;
export type AdvisorKindValue = (typeof ADVISOR_KIND_VALUES)[number];

export const SEVERITY_VALUES = ['info', 'notable', 'warning', 'urgent'] as const;
export type SeverityValue = (typeof SEVERITY_VALUES)[number];

/**
 * Who last decided `advisors.enabled` (migration 0028). Only a `default` row
 * follows the catalogue when it is re-registered; `user` is a human through
 * the step-up route, `feedback` is WP 5.9's dismiss-reason loop.
 */
export const ENABLED_SOURCES = ['default', 'user', 'feedback'] as const;
export type EnabledSource = (typeof ENABLED_SOURCES)[number];

/** Why the breaker tripped, or that a human did it. */
export const QUARANTINE_REASONS = ['consecutive_failures', 'rejection_rate', 'manual'] as const;
export type QuarantineReasonValue = (typeof QUARANTINE_REASONS)[number];

export const advisors = pgTable(
  'advisors',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** The published id. `builtin.subscriptions.price_increase`. */
    advisorId: text('advisor_id').notNull(),
    version: text('version').notNull(),
    kind: text('kind').$type<AdvisorKindValue>().notNull(),
    /** The wire major (08 §4.4). The artefact semver is a property of the files. */
    contractVersion: integer('contract_version').notNull(),
    displayName: text('display_name').notNull(),
    purpose: text('purpose').notNull(),
    /**
     * The manifest as registered, verbatim.
     *
     * Stored whole because it is the artefact a human reviewed; rebuilding it
     * from the columns beside it would produce something equivalent rather than
     * something that is *it*, and a registration review that cannot be
     * reproduced byte-for-byte is a review of something else.
     */
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    requiresScopes: text('requires_scopes').array().notNull(),
    maxSeverity: text('max_severity').$type<SeverityValue>().notNull(),
    deterministic: flagColumn('deterministic').notNull(),
    producesImpact: flagColumn('produces_impact').notNull(),
    narratesOnly: flagColumn('narrates_only').notNull(),
    egressAllowlist: text('egress_allowlist').array().notNull(),

    /** Kill switch 2. Defaults false in DDL; a row must be turned on. */
    enabled: flagColumn('enabled').notNull(),
    /** Who last set `enabled`. `default` rows follow the catalogue (0028). */
    enabledSource: text('enabled_source').$type<EnabledSource>().notNull(),
    /** Kill switch 3. Non-null means tripped. */
    quarantinedAt: instantColumn('quarantined_at'),
    quarantineReason: text('quarantine_reason').$type<QuarantineReasonValue>(),
    consecutiveFailures: integer('consecutive_failures').notNull(),
    lastRunAt: instantColumn('last_run_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('advisors_user_advisor_idx').on(table.userId, table.advisorId),
    index('advisors_user_enabled_idx').on(table.userId),
  ],
);

export type AdvisorRow = typeof advisors.$inferSelect;
export type NewAdvisorRow = typeof advisors.$inferInsert;

export const snapshotGrants = pgTable(
  'snapshot_grants',
  {
    id: idColumn(),
    userId: userIdColumn(),
    advisorId: text('advisor_id').notNull(),
    scope: text('scope').notNull(),
    perRunConsent: flagColumn('per_run_consent').notNull(),
    grantedAt: instantColumn('granted_at').notNull(),
    /**
     * A revocation, not a delete.
     *
     * "When did I stop letting it read my transactions?" is a question a
     * privacy screen has to answer, and a DELETE erases the answer along with
     * the grant.
     */
    revokedAt: instantColumn('revoked_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('snapshot_grants_user_advisor_scope_idx').on(
      table.userId,
      table.advisorId,
      table.scope,
    ),
    index('snapshot_grants_live_idx').on(table.userId, table.advisorId),
  ],
);

export type SnapshotGrantRow = typeof snapshotGrants.$inferSelect;
export type NewSnapshotGrantRow = typeof snapshotGrants.$inferInsert;

export const RUN_TRIGGERS = ['schedule', 'event', 'manual', 'backfill'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * `cancelled` (0028): allowed to start, then stopped by a kill level in flight
 * or at the write barrier. Not `failed` — the breaker does not count it.
 */
export const RUN_STATUSES = ['started', 'completed', 'failed', 'refused', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Blast-radius order: level 1 (global, module), level 2 (kind), level 3
 * (advisor, quarantine), then the payload preview gate. 0028's CHECK carries
 * the same list.
 */
export const RUN_REFUSALS = [
  'advisors_disabled',
  'module_disabled',
  'kind_disabled',
  'advisor_disabled',
  'advisor_quarantined',
  'payload_not_approved',
] as const;
export type RunRefusalValue = (typeof RUN_REFUSALS)[number];

/** A refusal's vocabulary, plus level 4: the holder's own per-run cancel. */
export const CANCEL_REASONS = [...RUN_REFUSALS, 'run_cancelled'] as const;
export type CancelReasonValue = (typeof CANCEL_REASONS)[number];

export const advisorRuns = pgTable(
  'advisor_runs',
  {
    id: idColumn(),
    userId: userIdColumn(),
    advisorId: text('advisor_id').notNull(),
    advisorVersion: text('advisor_version'),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    triggerEventType: text('trigger_event_type'),
    status: text('status').$type<RunStatus>().notNull(),
    /** Which kill switch refused it. `null` on every run that actually ran. */
    refusal: text('refusal').$type<RunRefusalValue>(),
    /** `sha256:` over the canonical JSON of what we sent. Null when refused. */
    inputDigest: text('input_digest'),
    grantedScopes: text('granted_scopes').array().notNull(),
    emittedScopes: text('emitted_scopes').array().notNull(),
    proposedCount: integer('proposed_count').notNull(),
    acceptedCount: integer('accepted_count').notNull(),
    rejectedCount: integer('rejected_count').notNull(),
    /** `[{ step, reason, index, key, detail }]`. Per-step, because a count cannot. */
    rejections: jsonb('rejections').$type<readonly Record<string, unknown>[]>().notNull(),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
    correlationId: uuid('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    startedAt: instantColumn('started_at').notNull(),
    finishedAt: instantColumn('finished_at'),
    createdAt: createdAtColumn(),
    /** Kill level 4 (0028): when the holder asked this run to stop. Polled. */
    cancelRequestedAt: instantColumn('cancel_requested_at'),
    /** Set exactly when `status = 'cancelled'`: the broadest level that applied. */
    cancelReason: text('cancel_reason').$type<CancelReasonValue>(),
    /** A `local_model` run's pinned model, `name@sha256:…`. */
    llmModel: text('llm_model'),
    /** `sha256:` of the exact prompt bytes a `local_model` run sent. */
    llmPromptHash: text('llm_prompt_hash'),
  },
  (table) => [
    index('advisor_runs_user_advisor_idx').on(table.userId, table.advisorId, table.startedAt),
    index('advisor_runs_failed_idx').on(table.userId, table.startedAt),
    uniqueIndex('advisor_runs_user_id_idx').on(table.userId, table.id),
  ],
);

export type AdvisorRunRow = typeof advisorRuns.$inferSelect;
export type NewAdvisorRunRow = typeof advisorRuns.$inferInsert;

/**
 * The payload preview gate (0028; 03 §8.3). One row per approved query shape;
 * `revokedAt` non-null means the approval no longer stands.
 */
export const advisorPayloadApprovals = pgTable(
  'advisor_payload_approvals',
  {
    id: idColumn(),
    userId: userIdColumn(),
    advisorId: text('advisor_id').notNull(),
    /** `sha256:` over the canonical shape — see `src/preview.ts`. */
    queryShape: text('query_shape').notNull(),
    advisorVersion: text('advisor_version').notNull(),
    kind: text('kind').$type<Exclude<AdvisorKindValue, 'builtin'>>().notNull(),
    scopes: text('scopes').array().notNull(),
    promptTemplateHash: text('prompt_template_hash'),
    approvedAt: instantColumn('approved_at').notNull(),
    revokedAt: instantColumn('revoked_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('advisor_payload_approvals_user_advisor_shape_idx').on(
      table.userId,
      table.advisorId,
      table.queryShape,
    ),
  ],
);

export type AdvisorPayloadApprovalRow = typeof advisorPayloadApprovals.$inferSelect;
export type NewAdvisorPayloadApprovalRow = typeof advisorPayloadApprovals.$inferInsert;

/**
 * What a `local_model` or `external` run was sent, for at most 30 days (0028).
 * No digest column on purpose: the inspector re-digests `payload.snapshot`
 * against `advisor_runs.input_digest`, the authority computed before the call.
 */
export const advisorRunPayloads = pgTable(
  'advisor_run_payloads',
  {
    runId: uuid('run_id').primaryKey(),
    userId: userIdColumn(),
    advisorId: text('advisor_id').notNull(),
    queryShape: text('query_shape').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    retainedAt: instantColumn('retained_at').notNull(),
    expiresAt: instantColumn('expires_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [index('advisor_run_payloads_expiry_idx').on(table.userId, table.expiresAt)],
);

export type AdvisorRunPayloadRow = typeof advisorRunPayloads.$inferSelect;
export type NewAdvisorRunPayloadRow = typeof advisorRunPayloads.$inferInsert;
