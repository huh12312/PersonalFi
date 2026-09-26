# `@ctx/planning` — table ownership

Planning.

Goals, assumptions, scenarios, deterministic projection, and Monte Carlo. Also the sole writer of the `net_worth_daily` read model, which is why that table lives here even though its inputs come from Ledger and Investments.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Ledger (read)
- Investments (read)

## Tables

- `goals`
- `goal_contributions`
- `risk_profile`
- `cash_earmarks`
- `plan_scenarios`
- `plan_assumptions`
- `projection_runs`
- `projection_percentiles`
- `net_worth_daily`

## Claimed by WP 4.2 — `plan_assumptions` (already listed under Tables, so not re-listed: a second bullet would be a double claim) is created by migration 0021 and typed in `schema/assumptions.ts`; it holds deltas only, against a named assumptions-file version.
