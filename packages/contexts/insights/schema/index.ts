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
  QUARANTINE_REASONS,
  RUN_REFUSALS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SEVERITY_VALUES,
  advisorRuns,
  advisors,
  snapshotGrants,
  type AdvisorKindValue,
  type AdvisorRow,
  type AdvisorRunRow,
  type NewAdvisorRow,
  type NewAdvisorRunRow,
  type NewSnapshotGrantRow,
  type QuarantineReasonValue,
  type RunRefusalValue,
  type RunStatus,
  type RunTrigger,
  type SeverityValue,
  type SnapshotGrantRow,
} from './advisors.ts';

export {
  CONFIDENCE_BASIS_VALUES,
  EVIDENCE_KINDS,
  FEEDBACK_ACTIONS,
  HORIZON_VALUES,
  INSIGHT_STATUSES,
  PROPOSED_ACTION_KIND_VALUES,
  insightActions,
  insightDismissals,
  insightEvidence,
  insightFeedback,
  insights,
  type ConfidenceBasisValue,
  type EvidenceKind,
  type FeedbackAction,
  type HorizonValue,
  type InsightActionRow,
  type InsightDismissalRow,
  type InsightEvidenceRow,
  type InsightFeedbackRow,
  type InsightRow,
  type InsightStatus,
  type NewInsightActionRow,
  type NewInsightDismissalRow,
  type NewInsightEvidenceRow,
  type NewInsightFeedbackRow,
  type NewInsightRow,
  type ProposedActionKindValue,
} from './insights.ts';
