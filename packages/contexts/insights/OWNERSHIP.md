# `@ctx/insights` — table ownership

Insights / Advisory.

The `Advisor` contract and the insight feed. The only context that reads broadly, and it does so through a single assembler (`SnapshotBuilder`) so data minimisation has exactly one implementation point.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

The first eight tables below exist as of migration `0012_insights.sql` (WP 2.6); the next two as of
`0028_advisor_run_control.sql` (WP 5.1); one as of `0030_insight_feedback_reasons.sql` (WP 5.9); two as
of `0032_advisory_briefs.sql` (WP 5.6), each with a user-scoped composite FK into this
context's own tables; the last as of `0033_health_scores.sql` (WP 5.8), computed alongside the Brief by
the weekly job but carrying no foreign key toward either of its tables — 05 §4's rule that two
migrations landing in one wave never reference each other's objects. None of
them carries a foreign key into another context's schema: an insight's link back to
the data is `insight_evidence.source_ref`, a path into the snapshot we sent, resolved
by the API at render time. That is not squeamishness about joins — it is what makes
"an advisor's evidence never cites data we did not send" checkable. If a ref were a
foreign key, resolving it would mean going back to the database, and a ref citing
data the advisor never received would _resolve_.

## Depends on

- Platform
- Ledger / Budgeting / Recurring / Investments / Planning — read-only, through their public readers

## Tables

- `advisors`
- `advisor_runs`
- `insights`
- `insight_evidence`
- `insight_actions`
- `insight_feedback`
- `insight_dismissals`
- `snapshot_grants`
- `advisor_payload_approvals`
- `advisor_run_payloads`
- `insight_outcomes`
- `advisory_briefs`
- `advisory_brief_items`
- `health_scores`
