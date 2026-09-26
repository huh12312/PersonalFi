# `@ctx/investments` — table ownership

Investments & Market Data.

Securities, holdings, lots, prices, and FX. `SecurityResolver` is the hard part: Coinbase says ETH, Plaid says ETHEREUM, a wallet says a contract address, a brokerage says a CUSIP — one resolver, one securities table, everything else references security_id.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

`securities`, `security_identifiers` and `security_overlay` exist as of
`0013_securities.sql` (WP 3.1). `holdings`, `holdings_snapshots`,
`investment_transactions`, `cost_basis_lots` and `basis_method_elections` exist as
of `0014_lots.sql` (WP 3.2). `basis_method_elections` is the smallest of the five
and the least obvious: it is one row per account × security recording the elected
cost-basis method, and it is a _table_ rather than a column on `holdings` because
an election outlives every position it was made about — a user who sells out of a
fund entirely and buys back in is still bound by an `AVERAGE_COST` election made
years earlier (07 §4.4, "sticky per security per account"). A column on `holdings`
would be deleted with the holding and the stickiness would silently lapse.
`prices`, `fx_rates` and `price_source_priority` exist as of
`0015_market_data.sql` (WP 3.4) — this context owns and reads them, while
`@ctx/integrations` owns the _fetching_ and hands rows across through an
injected writer port (08 §1.3 #7). `wallet_addresses` lands in 0016 (WP 3.6) and
is still a claim.

`allocation_targets` and `security_tags` exist as of `0026_allocation_targets.sql`
(WP 4.7) — owned here and not by `@ctx/planning`, because 08 §1.6's arrows point
down and drift is an investments analytic (`GET /investments/drift` is this
context's own route). See that migration's header for the ownership argument in
full.

## Depends on

- Platform
- Identity
- Ledger (AccountRegistry)

## Tables

- `securities`
- `security_identifiers`
- `security_overlay`
- `holdings`
- `holdings_snapshots`
- `investment_transactions`
- `cost_basis_lots`
- `basis_method_elections`
- `prices`
- `fx_rates`
- `wallet_addresses`
- `price_source_priority`
- `allocation_targets`
- `security_tags`
