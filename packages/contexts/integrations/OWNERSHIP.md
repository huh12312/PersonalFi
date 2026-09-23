# `@ctx/integrations` — table ownership

Integrations.

The anti-corruption layer for every external process — the Vibe-Trading sidecar, a local LLM, a future tax tool. Each is spoken to over the versioned Advisor contract, never over our internal ports, and must not be able to read Ledger, Connections, or Identity.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Insights (implements ExternalAdvisor)

## Tables

- `integrations`
- `integration_runs`
- `integration_artifacts`
- `integration_contract_versions`
- `market_data_runs`

`market_data_runs` exists as of `0015_market_data.sql` (WP 3.4): one row per
outbound market-data call, with the spend against each provider's published rate
budget and the egress refusal code when the guard says no. The rest are still
claims.

Note what this context deliberately does **not** own: `prices` and `fx_rates`.
It is the only context that fetches them, and 08 §1.3 #7 still gives them to
`@ctx/investments`, whose `PriceReader.price(securityId, date, currency)` and
`FxReader.rate(from, to, date)` are the published ports over them. Rows cross
that seam through an injected writer port wired in `apps/api`, never through a
table handle — which is what keeps "exactly one context may write a table" true
for a table whose data is produced somewhere else.
