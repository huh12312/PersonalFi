# `@ctx/categorization` — table ownership

Categorization & Rules.

The taxonomy, the rules engine, merchant normalisation, and the classifier. Writes to a transaction's category through `LedgerWriter.applyCategorization`, never a direct UPDATE, so provenance and the resulting event stay in one place.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Ledger
- Categorization taxonomy consumers

## Tables

- `category_groups`
- `categories`
- `rules`
- `rule_conditions`
- `rule_actions`
- `rule_runs`
- `merchant_aliases`
- `categorization_feedback`
- `classifier_versions`
