# `@ctx/recurring` — table ownership

Recurring.

Subscription and bill detection as a _candidate_ pipeline with human confirmation. A false 'you have a subscription' is a trust-destroying bug, so nothing is acted on silently.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Ledger (read)
- Categorization (read)

## Tables

- `recurring_series`
- `recurring_occurrences`
- `recurring_candidates`
- `subscription_metadata`
- `price_change_events`
