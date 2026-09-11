# `@ctx/connections` — table ownership

Connections & Providers.

The `Connector` port and its adapters (Plaid, SimpleFIN, Coinbase, wallet RPC, CSV, manual), plus sync orchestration and connection health. Depends on Ledger, never the reverse — that asymmetry is what makes swapping the aggregator a one-context change.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Identity (SecretBox)
- Ledger (LedgerWriter)
- Investments (HoldingsWriter)

## Tables

- `providers`
- `connections`
- `connection_secrets`
- `connection_accounts`
- `sync_runs`
- `sync_run_items`
- `sync_cursors`
- `provider_webhooks`
- `connection_health`
