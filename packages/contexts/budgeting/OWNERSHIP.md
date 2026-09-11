# `@ctx/budgeting` — table ownership

Budgeting.

Envelope-lite: flexible category targets, rollover, a to-be-budgeted pool, and sinking funds. Strict envelope and 50/30/20 are derived views over the same ledger, not separate models.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Ledger (read)
- Categorization (CategoryReader)

## Tables

- `budgets`
- `budget_periods`
- `budget_lines`
- `budget_line_actuals`
- `rollovers`
- `budget_alerts_state`
