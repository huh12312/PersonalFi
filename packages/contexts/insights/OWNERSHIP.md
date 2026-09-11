# `@ctx/insights` — table ownership

Insights / Advisory.

The `Advisor` contract and the insight feed. The only context that reads broadly, and it does so through a single assembler (`SnapshotBuilder`) so data minimisation has exactly one implementation point.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

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
