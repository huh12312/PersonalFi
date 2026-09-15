# `@connector/plaid` — table ownership

`PlaidConnector`: Plaid Link (including update mode), `/transactions/sync`,
`/accounts/get`, `/accounts/balance/get`, `/investments/holdings/get`,
`/investments/transactions/get`, `/liabilities/get`, `/item/get`, `/item/remove`.

## Tables

None. An adapter never writes to the database.

Two things this package deliberately does **not** claim:

- **The access token.** `connect` returns it once under the key
  `PLAID_ACCESS_TOKEN` (`'access_token'`) and forgets it. `@ctx/connections`
  seals it into `connections.sealed_credentials` with `SecretBox` and hands it
  back through `ConnectionHandle.secret()` on every call. The token exists in
  plaintext on this machine only inside one method body at a time — never on
  `this`, never in a module cache, never in a log line. Plaid access tokens do
  not expire (01 §1.10), which is why that matters more here than it would for a
  short-lived bearer token.
- **The cursor.** `transactions_cursor` is a `connections` column. This package
  reads Plaid's `next_cursor` and returns it; the orchestrator is the only thing
  that may write one, and only inside the transaction that commits the page's
  data (08 §2.3 rule 2).

## Configuration

`PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV` belong in `packages/config`,
which WP 1.3 does not own. Until they land there, `createPlaidApi` takes them as
an argument and the exact schema lines wanted are written out in
`docs/evidence/phase-1/wp1.3-plaid.md`.

## Third party

`plaid` (npm, MIT, pinned to 47.0.0 — published 2026-09-01, past D14's seven-day
cooldown). It is a generated axios client; the only runtime dependency it adds is
`axios`. Nothing is vendored.
