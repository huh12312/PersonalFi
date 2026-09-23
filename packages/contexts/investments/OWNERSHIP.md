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
`0013_securities.sql` (WP 3.1). The rest are still claims: `holdings`,
`holdings_snapshots`, `investment_transactions` and `cost_basis_lots` land in 0014
(WP 3.2). `prices`, `fx_rates` and `price_source_priority` exist as of
`0015_market_data.sql` (WP 3.4) — this context owns and reads them, while
`@ctx/integrations` owns the *fetching* and hands rows across through an
injected writer port (08 §1.3 #7). `wallet_addresses` lands in 0016 (WP 3.6) and
is still a claim.

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
- `prices`
- `fx_rates`
- `wallet_addresses`
- `price_source_priority`
