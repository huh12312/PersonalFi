// SPDX-License-Identifier: MIT
/**
 * `insights`, `insight_evidence`, `insight_actions`, `insight_feedback` and
 * `insight_dismissals` — migration `0012_insights.sql`.
 *
 * See that file's header for the design. Four things are worth repeating at the
 * query surface:
 *
 *   * **There is no `requiresReview` column and there is no writable path to
 *     `status`.** The wire field is the literal `true`, so a column would hold
 *     one value forever; what it means is `status`, which starts
 *     `'pending_review'` and can only move when `reviewedAt` is written with it
 *     (`insights_reviewed_has_timestamp`). The insert in `store.ts` takes a
 *     `ValidatedInsight` and never reads a status from the advisor's payload,
 *     because there is none to read.
 *   * **The identity is `(userId, advisorId, key, period)`**, and the upsert is
 *     on exactly that. `id` is a surrogate for the foreign keys below; nothing
 *     should look an insight up by it except a route that was handed one.
 *   * **`confidence` is `NUMERIC(7,6)` read back as a string.** A float is
 *     correct for a confidence score and is banned across this schema
 *     (`packages/db/test/migrate.test.ts`), so it is parsed at the edge, the
 *     same treatment `@ctx/recurring` and `@ctx/categorization` give theirs.
 *   * **`insightDismissals` is keyed without a period.** The ladder counts
 *     refusals of a *finding*; a cooldown that carried the period would expire
 *     with the month and ask the same question again on the 1st.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** The four states a proposal can be in. `expired` is deliberately not one. */
export const INSIGHT_STATUSES = ['pending_review', 'accepted', 'dismissed', 'snoozed'] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export const CONFIDENCE_BASIS_VALUES = ['deterministic', 'heuristic', 'model'] as const;
export type ConfidenceBasisValue = (typeof CONFIDENCE_BASIS_VALUES)[number];

export const HORIZON_VALUES = [
  'immediate',
  'this_period',
  'next_quarter',
  'this_year',
  'long_term',
] as const;
export type HorizonValue = (typeof HORIZON_VALUES)[number];

/** A unit-interval score as exact decimal. See the header on floats. */
function scoreColumn(name: string) {
  return numeric(name, { precision: 7, scale: 6, mode: 'string' });
}

export const insights = pgTable(
  'insights',
  {
    id: idColumn(),
    userId: userIdColumn(),
    advisorId: text('advisor_id').notNull(),
    advisorVersion: text('advisor_version').notNull(),
    /** The run that most recently proposed it. `SET NULL` when runs are pruned. */
    runId: uuid('run_id'),
    key: text('key').notNull(),
    /** `2026-09`, `2026-Q3` or `all_time`. Part of the identity. */
    period: text('period').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    /** True when the manifest's ceiling lowered what the advisor asked for. */
    severityClamped: flagColumn('severity_clamped').notNull(),
    title: text('title').notNull(),
    summaryMd: text('summary_md').notNull(),
    confidence: scoreColumn('confidence').notNull(),
    confidenceBasis: text('confidence_basis').$type<ConfidenceBasisValue>().notNull(),
    horizon: text('horizon').$type<HorizonValue>().notNull(),
    status: text('status').$type<InsightStatus>().notNull(),

    impactAnnualizedMinor: amountMinorColumn('impact_annualized_minor'),
    impactOneTimeMinor: amountMinorColumn('impact_one_time_minor'),
    impactCurrency: currencyColumn('impact_currency'),
    impactBasis: text('impact_basis').notNull(),
    impactDerivationId: text('impact_derivation_id'),
    /**
     * The arithmetic the advisor declared, beside the values we computed.
     *
     * Stored so the UI's "how was this computed?" line shows the expression
     * that was actually checked rather than a re-derivation that might not be
     * the same one.
     */
    derivations: jsonb('derivations').$type<readonly Record<string, unknown>[]>().notNull(),
    caveats: jsonb('caveats').$type<readonly string[]>().notNull(),

    /**
     * WP 5.3, migration `0031_insight_narrations.sql`. `null` for a finding;
     * set on a narration — alternative wording of the finding it names (same
     * user, composite FK, cascades with its finding). A narration is never
     * ranked, never shown on its own and emits no `InsightProposed`:
     * `read.ts`'s `listInsights` reads only rows where this is `null`.
     */
    narratesInsightId: uuid('narrates_insight_id'),

    /** What this insight stood on when it was last proposed. */
    inputDigest: text('input_digest').notNull(),
    firstProposedAt: instantColumn('first_proposed_at').notNull(),
    lastProposedAt: instantColumn('last_proposed_at').notNull(),
    reviewedAt: instantColumn('reviewed_at'),
    expiresAt: instantColumn('expires_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('insights_identity_idx').on(table.userId, table.advisorId, table.key, table.period),
    index('insights_feed_idx').on(table.userId, table.status, table.severity, table.lastProposedAt),
    index('insights_advisor_idx').on(table.userId, table.advisorId),
    // 0031: the composite FK's target, and the card's narration lookup.
    uniqueIndex('insights_narration_target_idx').on(table.userId, table.id),
    index('insights_narrates_idx').on(table.userId, table.narratesInsightId),
  ],
);

export type InsightRow = typeof insights.$inferSelect;
export type NewInsightRow = typeof insights.$inferInsert;

export const EVIDENCE_KINDS = [
  'metric',
  'transaction',
  'series',
  'budget_line',
  'external',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const insightEvidence = pgTable(
  'insight_evidence',
  {
    id: idColumn(),
    userId: userIdColumn(),
    insightId: uuid('insight_id').notNull(),
    /** Position in the advisor's own array: the order the argument was made. */
    position: integer('position').notNull(),
    kind: text('kind').$type<EvidenceKind>().notNull(),
    label: text('label').notNull(),
    value: text('value'),
    /**
     * `snapshot:cash_summary.accounts[0].balance.minor`, or `external:https://…`.
     *
     * Text, and deliberately not a foreign key into `@ctx/ledger`: an insight
     * must survive a re-categorisation, a DELETE over there must not cascade
     * into a review queue, and this context does not read another's tables.
     */
    sourceRef: text('source_ref'),
    /** What the ref resolved to, as we rendered it, at proposal time. */
    resolvedDisplay: text('resolved_display'),
    href: text('href'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('insight_evidence_position_idx').on(table.insightId, table.position),
    index('insight_evidence_user_idx').on(table.userId, table.insightId),
  ],
);

export type InsightEvidenceRow = typeof insightEvidence.$inferSelect;
export type NewInsightEvidenceRow = typeof insightEvidence.$inferInsert;

/** The four non-acting members. `execute`, `transfer` and `trade` do not exist. */
export const PROPOSED_ACTION_KIND_VALUES = [
  'suggest_only',
  'open_url',
  'create_goal_draft',
  'create_rule_draft',
] as const;
export type ProposedActionKindValue = (typeof PROPOSED_ACTION_KIND_VALUES)[number];

export const insightActions = pgTable(
  'insight_actions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    insightId: uuid('insight_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<ProposedActionKindValue>().notNull(),
    label: text('label').notNull(),
    rationaleMd: text('rationale_md').notNull(),
    url: text('url'),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('insight_actions_position_idx').on(table.insightId, table.position)],
);

export type InsightActionRow = typeof insightActions.$inferSelect;
export type NewInsightActionRow = typeof insightActions.$inferInsert;

export const FEEDBACK_ACTIONS = ['accept', 'dismiss', 'snooze', 'reopen'] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

/**
 * The dismiss-reason taxonomy (07 §8.3; migration `0030_insight_feedback_
 * reasons.sql`; WP 5.9). Beside the free-text `reason`, which stays the note —
 * expand, never contract. Each code's effect is in
 * `src/policy/feedback.ts`'s header; the short version:
 *
 *   * `NOT_TRUE` — the facts are wrong. Counts toward the rule's rate; over
 *     0.2 across five or more firings it quarantines the advisor
 *     (`not_true_rate`, widened onto `advisors.quarantine_reason` below).
 *   * `ALREADY_KNOW` — true but known. Skips straight to the 90-day rung.
 *   * `NOT_ACTIONABLE` — true, can't act. Feeds the ordinary dismiss penalty.
 *   * `DONT_CARE` — true, don't value it. Turns the rule off for this holder
 *     (`advisors.enabled_source = 'feedback'`), undoable by a human.
 *   * `WRONG_AMOUNT` — right finding, wrong number. Flags the insight's
 *     derivations and digest for review on rule health.
 *   * `INTENTIONAL` — "I meant to do that." That entity is suppressed
 *     permanently, immediately — not earned over three dismissals.
 *   * `LATER` — a snooze, paired with `action = 'snooze'`.
 */
export const REASON_CODES = [
  'NOT_TRUE',
  'ALREADY_KNOW',
  'NOT_ACTIONABLE',
  'DONT_CARE',
  'WRONG_AMOUNT',
  'INTENTIONAL',
  'LATER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const insightFeedback = pgTable(
  'insight_feedback',
  {
    id: idColumn(),
    userId: userIdColumn(),
    insightId: uuid('insight_id').notNull(),
    /** Denormalised so the ladder can be counted without joining `insights`. */
    advisorId: text('advisor_id').notNull(),
    insightKey: text('insight_key').notNull(),
    action: text('action').$type<FeedbackAction>().notNull(),
    reason: text('reason'),
    /** The taxonomy above. `NULL` for free text that matched no preset. */
    reasonCode: text('reason_code').$type<ReasonCode | null>(),
    snoozeUntil: instantColumn('snooze_until'),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('insight_feedback_insight_idx').on(table.insightId, table.createdAt),
    index('insight_feedback_finding_idx').on(
      table.userId,
      table.advisorId,
      table.insightKey,
      table.createdAt,
    ),
    // Rule health and the NOT_TRUE-rate check both group by advisor.
    index('insight_feedback_reason_idx').on(table.userId, table.advisorId, table.reasonCode),
  ],
);

export type InsightFeedbackRow = typeof insightFeedback.$inferSelect;
export type NewInsightFeedbackRow = typeof insightFeedback.$inferInsert;

/**
 * Outcome verification (09 ADV-4) and forward validation (05 §1 cut line 2):
 * one row per acceptance, evaluated exactly once at its horizon.
 *
 * `insights.last_proposed_at` is the only signal available without a
 * bitemporal store: an advisor's nightly re-run upserts the same identity row
 * and advances it whether or not the row is `accepted` (`store.ts`'s
 * `upsertInsight` — status is deliberately left alone by a re-proposal). So
 * "was this finding proposed again after its horizon?" is exactly "did
 * `last_proposed_at` move past `due_at`?", and evaluating it is forward-only
 * *by construction*: the only value read is a timestamp that can only ever
 * advance, and it is compared against `due_at`, which was fixed at
 * acceptance — never against anything that predates it. A reader that
 * substituted `insights.first_proposed_at` (frozen at the *first* proposal,
 * always earlier than the acceptance that created this row) would leak the
 * past into the verdict, which is exactly the failure a bitemporal store
 * exists to prevent and exactly what `policy/outcomes.ts` is written not to
 * do.
 */
export const OUTCOME_VALUES = ['ACTED', 'INCOMPLETE'] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

export const insightOutcomes = pgTable(
  'insight_outcomes',
  {
    id: idColumn(),
    userId: userIdColumn(),
    insightId: uuid('insight_id').notNull(),
    /** Denormalised, the `insight_feedback` precedent: no join for a read. */
    advisorId: text('advisor_id').notNull(),
    insightKey: text('insight_key').notNull(),
    /** When the user accepted it — the forward-validation reference point. */
    acceptedAt: instantColumn('accepted_at').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    dueAt: instantColumn('due_at').notNull(),
    /** `NULL` until evaluated. Set at most once — see `evaluateDueOutcomes`. */
    outcome: text('outcome').$type<OutcomeValue | null>(),
    evaluatedAt: instantColumn('evaluated_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('insight_outcomes_user_insight_idx').on(table.userId, table.insightId),
    index('insight_outcomes_due_idx').on(table.userId, table.dueAt),
  ],
);

export type InsightOutcomeRow = typeof insightOutcomes.$inferSelect;
export type NewInsightOutcomeRow = typeof insightOutcomes.$inferInsert;

export const insightDismissals = pgTable(
  'insight_dismissals',
  {
    id: idColumn(),
    userId: userIdColumn(),
    advisorId: text('advisor_id').notNull(),
    /** No period: the ladder counts refusals of the finding, not of the month. */
    insightKey: text('insight_key').notNull(),
    dismissCount: integer('dismiss_count').notNull(),
    suppressedUntil: instantColumn('suppressed_until'),
    /** Reachable only at three dismissals; a snooze never advances the count. */
    permanent: flagColumn('permanent').notNull(),
    lastAction: text('last_action').$type<'dismiss' | 'snooze' | 'reopen'>(),
    lastActionAt: instantColumn('last_action_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('insight_dismissals_finding_idx').on(
      table.userId,
      table.advisorId,
      table.insightKey,
    ),
    index('insight_dismissals_live_idx').on(table.userId),
  ],
);

export type InsightDismissalRow = typeof insightDismissals.$inferSelect;
export type NewInsightDismissalRow = typeof insightDismissals.$inferInsert;
