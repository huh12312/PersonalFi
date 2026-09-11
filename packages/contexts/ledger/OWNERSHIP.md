# `@ctx/ledger` — table ownership

Ledger.

The system of record and the gravitational centre of the app. Deliberately dumb: it stores facts and their provenance, and does not categorise, budget, or interpret. Provider-sourced rows are immutable; user intent lives in an overlay resolved on read.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Identity

## Tables

- `institutions`
- `accounts`
- `account_balances`
- `account_balance_history`
- `transactions`
- `transaction_facts`
- `transaction_overlays`
- `transaction_splits`
- `merchants`
- `transfer_links`
- `attachments`
