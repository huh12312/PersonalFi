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

### Built (migration 0005)

- `connections`
- `connection_accounts`
- `sync_runs`

### Built (migration 0008)

- `connection_staged_facts` — durable staging for the process-local connectors
  (Manual, CSV/OFX/QIF), decision D-5. See the migration's header for why this
  is one table with a `kind` column rather than three, and why the dedupe key
  is `provider_transaction_id` rather than `fingerprint`.

### Built (migration 0018)

- `connection_sync_facts` — what a provider's `holdings` / `investment_txns` /
  `liabilities` leg observed, keyed on the provider's natural key and pointing at
  the run that last saw it (WP 3.7). The sibling of `connection_staged_facts` and
  its mirror image: staged facts are _inbound, not yet applied_; sync facts are
  _already observed, published for another context to read_ through
  `InvestmentSyncPort.factsForRun`. See the migration header for why the row is
  keyed on the natural key rather than on the run.

### Claimed, not yet built

- `providers`
- `sync_run_items`
- `provider_webhooks`
- `connection_health`

## Notes on the names

Two claims from the original sketch are gone, because the built schema answers
the same need with fewer tables and a stale claim reserves a name nobody intends
to use:

- `connection_secrets` → **`connections.sealed_credentials`**. A separate table
  buys nothing: there is exactly one credential envelope per connection, its
  lifetime is the connection's, and `SecretBox`'s AAD already binds the
  ciphertext to `(table, column, row id)` — so a column _is_ the binding, while a
  side table would need its own row id in the AAD and a join on every sync.
  Destroying the secret on disconnect is then one `UPDATE`, inside the same
  transaction as the status change, rather than a `DELETE` that can be half-done.
- `sync_cursors` → **`connections.transactions_cursor`**. The decisive property
  of the cursor is that it commits in the same transaction as the page's data
  (01 §5.1). Keeping it on the connection row means that transaction touches one
  row of one table; a separate cursor table would put a second table in the hot
  path of the one write that must never be partially applied. When a second
  dataset needs a cursor (investments, which per 01 §5.5 has no cursor model at
  all) it gets its own column, by migration.

`sync_runs.restart_count` is new since the sketch: it counts how many times the
page loop restarted from the page-one cursor because the provider mutated the
stream mid-pagination. Without it, a busy institution and a bug in our loop look
identical in the history view.

## Ledger is a port, not an import

This context depends on the Ledger and must never import it: `personalfi/layer-imports`
denies `@ctx/*` → `@ctx/*` unconditionally, and its own message names the
alternative — "through a domain event or its published port". So `LedgerWriter`
in `src/ledger-writer.ts` is an interface this context declares and `apps/api`
satisfies with `@ctx/ledger`'s `applyProviderTransactions`, `upsertAccount` and
`recordBalance` (WP 1.5 wires it). The asymmetry is the point: Ledger has no idea
Plaid exists, and swapping the aggregator stays a one-context change.
