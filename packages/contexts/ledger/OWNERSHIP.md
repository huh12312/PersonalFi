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

Everything migration `0004_ledger.sql` creates is claimed here, in the order the
migration creates it, followed by the tables this context still expects to own and
has not built yet.

### Built (migration 0004)

- `merchants`
- `accounts`
- `account_balances`
- `transactions_provider`
- `transactions`
- `transaction_splits`
- `transfer_links`
- `rejected_transfer_pairs`
- `ledger_dedup_keys`

### Built (migration 0035)

The holder's overlay on an account (WP 9.2): a tax treatment, a role and a
valuation basis that outrank what the provider's metadata implies. One row per
`(user, account)`; a user-scoped composite foreign key to `accounts`. Provider
facts on `accounts` are never mutated; `resolveAccountOverlay` decides.

- `account_overrides`

### Built (migration 0058, WP 11.2b): columns, not a table

The automatic tiers' answer (3 a merchant default, 4 the provider's category, 5 the classifier above
its floor) is a **projection this context owns**: six nullable `auto_*` columns on `transactions`
(`auto_category_id`, `auto_tier`, `auto_confidence`, `auto_decided_at`, `auto_assignment_id`,
`auto_superseded_at`), written only by `setAutoCategories` and read through `resolveCategoryId`
(`user ?? rule ?? auto`). Columns rather than a side table for the overlay's own reason (below): every
reader of the effective category reads `transactions`. It is derived data: the export omits it and the
import re-derives it from `@ctx/categorization`'s `category_assignments`. The ledger never reads that
table; the categorisation pass hands the placements over through its `LedgerPort`.

### Built (migration 0063, WP 11.6)

A local model's display-name suggestion for a **noise** merchant (`merchant.name`), one row per
`(user, normalized_key)`, asked once. It sits here, beside `merchants`, rather than in `@ctx/insights`
(which owns the query type's kill ladder, approval and validator) or `@ctx/categorization` (which owns
naming-adjacent profiles) for three reasons: its key is a `merchants.normalized_key`; deciding which
merchants are noise reads `merchants`, `transactions` and `transactions_provider`, all this context's; and
the only thing an accepted suggestion does is write the `user_merchant_name` overlay through
`setTransactionOverlay`, the manual rename's own path. Any other owner would have to read three ledger
tables directly, which the ownership rule forbids. `merchants.display_name` and
`transactions.effective_name` are never written from it.

- `merchant_name_suggestions`

### Claimed, not yet built

- `institutions`
- `account_balance_history`
- `attachments`

## Notes on the names

Two claims from the original sketch are gone because the built schema answers the
same need with fewer tables, and leaving a stale claim in this file would reserve a
name nobody intends to use:

- `transaction_facts` → **`transactions_provider`**. Same idea (immutable provider
  truth), named for what writes it. See migration 0004's header.
- `transaction_overlays` → **columns on `transactions`**. The overlay is four
  sparse `user_*` columns on the row it belongs to, not a second table: every read
  path needs the overlay, so a separate table would put a join on the app's
  hottest query to save a few NULLs. `resolveEffective()` is the seam that a real
  overlay table would have provided, and it is a function rather than a join.

`rejected_transfer_pairs` and `ledger_dedup_keys` are new since the sketch. Both
exist because a _negative_ decision is data: "these two are not a transfer" and
"this row duplicates that one" have to survive the next sync, or the heuristics
re-propose what the user already dismissed.
