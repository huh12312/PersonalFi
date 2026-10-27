// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/insights`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database.
 *
 * `accounts`, `transactions`, `merchants`, `budget_lines` and `recurring_series`
 * are deliberately absent, and their absence is the point of this context.
 * Insights is the only one that reads broadly, and it does so through the three
 * ports in `src/snapshot/ports.ts` — never through a table definition and never
 * through a JOIN. `insight_evidence.source_ref` is therefore *text*: a path into
 * the snapshot we sent, resolved by the API at render time, with no foreign key
 * anywhere into another context's schema (decisions D8, D25).
 *
 * That is what makes "an advisor's evidence never cites data we did not send"
 * checkable at all. If a ref were a foreign key, resolving it would mean going
 * back to the database — and a ref citing data the advisor never received would
 * *resolve*, which is exactly the fabrication the check exists to catch.
 */
export {
  ADVISOR_KIND_VALUES,
  CANCEL_REASONS,
  ENABLED_SOURCES,
  QUARANTINE_REASONS,
  RUN_REFUSALS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SEVERITY_VALUES,
  advisorPayloadApprovals,
  advisorRunPayloads,
  advisorRuns,
  advisors,
  snapshotGrantEvents,
  snapshotGrants,
  GRANT_EVENT_KINDS,
  type AdvisorKindValue,
  type AdvisorPayloadApprovalRow,
  type AdvisorRow,
  type AdvisorRunPayloadRow,
  type AdvisorRunRow,
  type CancelReasonValue,
  type EnabledSource,
  type NewAdvisorPayloadApprovalRow,
  type NewAdvisorRunPayloadRow,
  type NewAdvisorRow,
  type NewAdvisorRunRow,
  type GrantEventKind,
  type NewSnapshotGrantEventRow,
  type NewSnapshotGrantRow,
  type QuarantineReasonValue,
  type RunRefusalValue,
  type RunStatus,
  type RunTrigger,
  type SeverityValue,
  type SnapshotGrantEventRow,
  type SnapshotGrantRow,
} from './advisors.ts';

export {
  CONFIDENCE_BASIS_VALUES,
  EVIDENCE_KINDS,
  FEEDBACK_ACTIONS,
  HORIZON_VALUES,
  INSIGHT_HELPFULNESS_VALUES,
  INSIGHT_STATUSES,
  OUTCOME_VALUES,
  PROPOSED_ACTION_KIND_VALUES,
  REASON_CODES,
  insightActions,
  insightDismissals,
  insightEvidence,
  insightFeedback,
  insightOutcomes,
  insights,
  type ConfidenceBasisValue,
  type EvidenceKind,
  type FeedbackAction,
  type HorizonValue,
  type InsightActionRow,
  type InsightDismissalRow,
  type InsightEvidenceRow,
  type InsightFeedbackRow,
  type InsightHelpfulness,
  type InsightOutcomeRow,
  type InsightRow,
  type InsightStatus,
  type NewInsightActionRow,
  type NewInsightDismissalRow,
  type NewInsightEvidenceRow,
  type NewInsightFeedbackRow,
  type NewInsightOutcomeRow,
  type NewInsightRow,
  type OutcomeValue,
  type ProposedActionKindValue,
  type ReasonCode,
} from './insights.ts';

// WP 5.6 — the Weekly Advisory Brief (migration 0032_advisory_briefs.sql).
export {
  BRIEF_ITEM_SECTIONS,
  advisoryBriefItems,
  advisoryBriefs,
  type AdvisoryBriefItemRow,
  type AdvisoryBriefRow,
  type BriefItemSection,
  type BriefPrimaryAction,
  type NewAdvisoryBriefItemRow,
  type NewAdvisoryBriefRow,
} from './briefs.ts';

// WP 10.6 — the language model in Settings (migration 0044_narrator_settings.sql).
export {
  HOSTED_NARRATOR_PROVIDERS,
  NARRATOR_PROVIDER_VALUES,
  narratorProviderConsents,
  narratorSettings,
  type HostedNarratorProvider,
  type NarratorProviderConsentRow,
  type NarratorProviderValue,
  type NarratorSettingsRow,
  type NewNarratorSettingsRow,
} from './narrator.ts';

// WP 5.8 — the health score with breakdown (migration 0033_health_scores.sql).
export { healthScores, type HealthScoreRow, type NewHealthScoreRow } from './health.ts';

// WP 10.12 — the health score once a day, with its pillars (migration 0048_health_score_snapshots.sql).
export {
  healthScoreSnapshots,
  type HealthScoreSnapshotRow,
  type NewHealthScoreSnapshotRow,
} from './health-snapshots.ts';

// WP 10.16 — the GenAI controls self-test's evidence rows (migration 0052_ops_control_checks.sql).
export { opsControlChecks, type OpsControlCheckRow } from './control-checks.ts';

// WP 11.3 — "Explain this", cached per evidence digest (migration 0057_insight_explanations.sql).
export {
  EXPLANATION_ENTITY_KINDS,
  insightExplanations,
  type ExplanationEntityKind,
  type InsightExplanationRow,
  type NewInsightExplanationRow,
} from './explanations.ts';
