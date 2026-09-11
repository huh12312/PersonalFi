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
