<!-- SPDX-License-Identifier: MIT -->

# WP 1.5 — API composition root and the REST/SSE surface

Scope: the composition root (`apps/api/src/{app,platform,modules,domain,worker}.ts`),
the accounts / transactions / connections routers, the two server-sent event
streams, the regenerated OpenAPI contract, and the route test suites.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Node 26, pnpm, Postgres 18
on `127.0.0.1:5433`. Every count below is from a command run against this working
tree.

---

## Summary

| Deliverable                                               | Where                                         |
| --------------------------------------------------------- | --------------------------------------------- |
| Route registration, OpenAPI tags, CSRF gate at the root   | `apps/api/src/app.ts`                         |
| Module flags, `resolveModules`                            | `apps/api/src/platform.ts`                    |
| `MODULES` — ledger + connections, events/jobs/schedules   | `apps/api/src/modules.ts`                     |
| `LedgerWriter` wiring, connector registry, Plaid hook     | `apps/api/src/domain.ts`                      |
| Worker: sync job handler + nightly schedule               | `apps/api/src/worker.ts`                      |
| 24 operations across three routers                        | `apps/api/src/routes/`                        |
| Transaction splits writer (temporary home)                | `apps/api/src/ledger-splits.ts`               |
| Domain error → RFC 9457 mapping                           | `apps/api/src/routes/domain-errors.ts`        |
| Wire scalars (`Money`, dates, id lists)                   | `apps/api/src/wire.ts`                        |
| Regenerated contract: 40 paths, 44 operations, 58 schemas | `packages/contracts/openapi/openapi.json`     |
| 55 route tests over a real database                       | `apps/api/test/db/`, `apps/api/test/helpers/` |

---

## 1. The route table

24 operations. **Every route requires a session.** Mutations additionally pass the
CSRF gate, which is an `onRequest` hook on the whole application rather than a
per-router hook — a per-router copy is a control a future router forgets to add.
"Step-up" is decision D21: a WebAuthn assertion from within the last five minutes,
checked by `guards.requireFreshSession`.

| Method | Path                          | Operation                | Auth           | Notes                                                     |
| ------ | ----------------------------- | ------------------------ | -------------- | --------------------------------------------------------- |
| GET    | `/accounts`                   | `listAccounts`           | session        | `?includeClosed`; closed accounts hidden by default       |
| PATCH  | `/accounts/{accountId}`       | `updateAccount`          | session + CSRF | `includeInNetWorth`, `closed`; empty body is 400          |
| GET    | `/net-worth`                  | `getNetWorth`            | session        | Per currency, never summed across them                    |
| GET    | `/transactions`               | `listTransactions`       | session        | Keyset page + first-page summary                          |
| GET    | `/transactions/{id}`          | `getTransaction`         | session        | Adds `provenance`, `splits`, `transfer`                   |
| PATCH  | `/transactions/{id}`          | `updateTransaction`      | session + CSRF | Writes the user overlay                                   |
| POST   | `/transactions/bulk`          | `bulkUpdateTransactions` | session + CSRF | One transaction; a bad id fails the whole batch           |
| POST   | `/transactions/{id}/splits`   | `setTransactionSplits`   | session + CSRF | Replaces wholesale; must sum to the cent                  |
| DELETE | `/transactions/{id}/splits`   | `clearTransactionSplits` | session + CSRF | Back to one line                                          |
| POST   | `/transfers/pair`             | `pairTransfer`           | session + CSRF | Confidence 1.0, `user_confirmed`                          |
| POST   | `/transfers/{id}/reject`      | `rejectTransfer`         | session + CSRF | Either leg; rejection is recorded as well as undone       |
| GET    | `/transactions/export.csv`    | `exportTransactions`     | **step-up**    | Same filters as the list; RFC 4180                        |
| GET    | `/connectors`                 | `listConnectors`         | session        | The "add a connection" screen, as data                    |
| GET    | `/connections`                | `listConnections`        | session        | No credential in the payload, in any form                 |
| GET    | `/connections/{id}`           | `getConnection`          | session        | Accounts + recent runs                                    |
| POST   | `/connections`                | `createConnection`       | **step-up**    | 201; `input` is opaque and adapter-validated              |
| POST   | `/connections/{id}/complete`  | `completeConnection`     | **step-up**    | 409 if the artifact belongs to another connection         |
| POST   | `/connections/{id}/reconnect` | `reconnectConnection`    | **step-up**    | Cursor and account identity survive                       |
| POST   | `/connections/{id}/sync`      | `syncConnection`         | session + CSRF | **202**; `mode: queued \| inline`, deduped and singleton  |
| GET    | `/connections/{id}/sync-runs` | `listSyncRuns`           | session        | Every attempt, including ones that failed before page one |
| DELETE | `/connections/{id}`           | `disconnectConnection`   | **step-up**    | Keeps data; reports `providerSlotMayRemain`               |
| POST   | `/imports/csv`                | `importFiles`            | session + CSRF | Synchronous; re-upload is a no-op                         |
| GET    | `/sync/stream`                | `streamSyncEvents`       | session        | SSE, all six event names                                  |
| GET    | `/connections/{id}/events`    | `streamConnectionEvents` | session        | SSE, the three connection-aggregate events                |

Five routes need a step-up: **add, complete, reconnect, remove a connection, and
export the ledger**. The class of attack is a stolen session cookie — possession
of the cookie must not be enough to attach an institution, destroy a credential,
or walk out with the complete transaction history.

`DELETE /connections/{id}` returns `providerSlotMayRemain`. For a manual or
file-import connection revocation always succeeds locally, so it is `false`. **The
Plaid caveat:** when revocation at the provider fails, the local credential is
still destroyed (a provider that is down must not be able to stop a user from
disconnecting) but the Item continues to occupy a billing slot until it is removed
in Plaid's dashboard. The flag exists so the UI can say so rather than implying a
clean removal.

### Problem shapes

RFC 9457 throughout, `application/problem+json`, with a `correlationId` that
matches the `x-correlation-id` response header. **Clients switch on `code`, never
on `detail`,** and the code is the domain's own — `ledger.splits_do_not_sum`
reaches the browser spelled exactly that way. A `ConnectorError`'s _message_ never
crosses the wire (it is a provider's prose and may name an institution or a token
prefix); what crosses is the typed kind as `connector.<kind>`, the provider's own
code, and a sentence we wrote.

---

## 2. The pagination contract

`GET /transactions` is **keyset** over `(effective_date DESC, id DESC)`.

- `cursor` is **opaque**: base64url of `<effective_date>|<id>`, minted by
  `@ctx/ledger`. **Pass `nextCursor` back verbatim.** A client that parses it
  breaks the first time the ordering gains a tiebreaker; one that substitutes an
  offset sees transactions twice or never, because a sync inserts rows _into the
  middle_ of a date-ordered feed. That makes offset pagination not slow but
  **wrong** (04 §6.3).
- `nextCursor` is `null` on the last page, and only then.
- `limit` defaults to `DEFAULT_PAGE_SIZE` and is capped at `MAX_PAGE_SIZE`.
- A cursor the server did not mint is `400 ledger.cursor_invalid`, not a silent
  reset to page one.
- **`summary` is returned on the first page of a filter (no `cursor`) and is
  `null` on every subsequent page.** Both halves — the count and the per-currency
  totals — are aggregates over the whole filter rather than the page, and they are
  the slow half of the query; an infinite-scroll client throws them away on page
  two anyway.
- Filters are repeatable in either spelling: `?accountIds=a&accountIds=b` and
  `?accountIds=a,b` mean the same thing. Both are accepted because a client that
  guesses wrong would otherwise get a silently single-element filter.
- Money is `{ minor: string, currency }` everywhere, including in query strings
  (`amountMin`, `amountMax`). `bigint` does not survive `JSON.stringify` and an
  IEEE-754 number cannot hold a cent.

The export uses the same keyset loop internally at 1 000 rows per chunk, so it
holds no more than a chunk in memory and stays stable while a sync writes.

---

## 3. The SSE contract

Two routes, one implementation. `text/event-stream`, written to `reply.raw`
because an SSE body is an open socket rather than a value.

**Where the events come from:** the outbox (`domain_events`), read directly — not
a second in-process bus. The sync that produces them runs in the _worker_, a
different container, so an in-process `EventEmitter` would see nothing at all.
`LISTEN`/`NOTIFY` on `personalfi_domain_events` is the wake-up, never the
mechanism: every wait has a 1 s timeout and re-reads the table regardless, so a
dropped listener, a lost notification or a Postgres restart costs latency and
nothing else.

| SSE event            | Domain event                          | `/sync/stream` | `/connections/{id}/events` |
| -------------------- | ------------------------------------- | -------------- | -------------------------- |
| `connection.created` | `connections.ConnectionCreated`       | yes            | yes                        |
| `connection.status`  | `connections.ConnectionStatusChanged` | yes            | yes                        |
| `sync.completed`     | `connections.SyncRunCompleted`        | yes            | yes                        |
| `sync.progress`      | `ledger.TransactionsUpserted`         | yes            | no                         |
| `account.upserted`   | `ledger.AccountUpserted`              | yes            | no                         |
| `balance.recorded`   | `ledger.BalanceRecorded`              | yes            | no                         |

The client-facing names are deliberately **not** the domain event types: a domain
event type is an internal contract a context may version; an SSE event name is in
a browser's `addEventListener` and in a `switch`. `routes/events.ts` is the only
place the two vocabularies meet.

The per-connection stream carries only the three events whose `aggregate_id` _is_
a connection. The ledger's are aggregated on an account or a transaction, so
filtering them by connection would need a join the outbox deliberately does not
support. Per-row progress is on `/sync/stream`.

Frame shape:

```
id: <outbox seq>
event: sync.progress
data: {"type":"sync.progress","aggregateId":"…","occurredAt":"…","correlationId":"…","payload":{…}}
```

- **`id:` is the outbox sequence**, which `seq` takes under a transaction-scoped
  advisory lock — so a reader that has seen 6 can never miss a 5.
- **Resume** with `Last-Event-ID` (a browser reconnecting on its own) or `?from=`
  (a client managing its own retries). The comparison is `seq > cursor`, so the
  resume point itself is not resent. A malformed value is **ignored, not
  rejected**: a bad header on a reconnect must not turn a network blip into a 400
  the user sees.
- A **fresh** stream starts at the outbox high-water mark, not at zero, so opening
  the dashboard does not replay the day.
- **Heartbeat: `: heartbeat\n\n` every 15 seconds.** An idle SSE connection behind
  a reverse proxy is reaped somewhere between 30 and 120 seconds depending on
  whose default is in force, and a client has no other way to distinguish "nothing
  is happening" from "the connection died quietly". It is a `:` comment, so an
  `EventSource` ignores it. The interval is read from the injected `clock`, which
  is what makes it testable in a second instead of fifteen.
- `x-accel-buffering: no` and `cache-control: no-cache, no-store` on the way out;
  the first is what Caddy and every nginx-shaped proxy understand as "do not
  buffer this".
- **Clean close.** Each stream checks one client out of the pool for its lifetime
  to hold the `LISTEN`. It is released in a `finally` that runs whatever happens,
  including the client vanishing mid-write. A handler that leaked it would cost
  one connection per browser tab and the tenth reload would exhaust the pool.

---

## 4. Composition root

### `LedgerWriter` wiring

`@ctx/connections` declares the three ledger functions it needs as a **port**,
because `personalfi/layer-imports` denies `@ctx/*` → `@ctx/*` unconditionally.
`apps/api/src/domain.ts` is the one place the two halves meet:

```ts
export const ledgerWriter: LedgerWriter = {
  applyProviderTransactions,
  upsertAccount,
  recordBalance,
};
```

Three bare references to `@ctx/ledger`'s exports, **not adapter functions**. That
is the entire safety mechanism: the day the ledger changes
`applyProviderTransactions`'s signature, `pnpm typecheck` fails _here_, in the
eleven lines that assert the two halves still fit. WP 1.2's evidence note lists
"nothing in `@ctx/connections`'s own test suite can prove the shapes still match"
as its one deferred item, and this closes it.

### Registry, and the Plaid hook

`createConnectorRegistry()` registers `ManualConnector` and `CsvImportConnector`.
The Plaid hook is one commented line in `apps/api/src/domain.ts`:

```ts
// WP 1.3 hook — one line, and the Plaid adapter is live:
// registry.register({ connector: new PlaidConnector(plaidOptions), manifest: PLAID_MANIFEST });
```

That is 08 §2.7's test of the abstraction: the "Add a connection" screen renders
from `registry.manifests()`, so a new adapter reaches the UI by being registered
here and by no UI change at all. `GET /connectors` returns the registry verbatim.

### Modules, flags, and the worker

`apps/api/src/modules.ts` declares what each bounded context contributes, and both
the API and the worker build the list the same way, so "which events exist" cannot
differ between the two processes:

| Module               | Events | Consumers | Jobs                            | Schedule |
| -------------------- | ------ | --------- | ------------------------------- | -------- |
| `module.ledger`      | 5      | —         | —                               | —        |
| `module.connections` | 3      | —         | `connections.sync`, `…sync_all` | nightly  |

The Ledger registers **no consumer**, deliberately: it is the writer, it states
facts and reacts to none. Both flags default to `true` — a freshly migrated
database with no `feature_flags` rows should be a working application — and the
switch exists for turning a module _off_ during an incident without a redeploy.
`resolveModules` skips a disabled module entirely, so it contributes no events, no
consumers, no jobs and no schedules and cannot half-fill a read model nobody is
reading (08 §6.9).

The worker runs the consumer pump, the job runners and the scheduler; it derives
the KEK too, because a sync opens a sealed credential and there is no arrangement
in which the API unseals on the worker's behalf that does not amount to passing a
plaintext token between containers. The nightly schedule is registered at 03:15
**local** to the account holder's display timezone (08 §3.7), never the
container's `TZ`: 03:15 UTC for a user in UTC-5 is 22:15 their time, which is
neither quiet hours nor the start of a banking day. One schedule enqueues one
fan-out job which enqueues one job per connection — a schedule row per connection
would mean a newly linked bank does not sync until something remembers to add a
row.

### Why some syncs run inline

`ManualConnector`, `CsvImportConnector` and `SeedConnector` stage their rows in
**process memory**. A job the API enqueued for one of them would be picked up by
the worker, which has a different, empty store, and would report a successful sync
of nothing. `PROCESS_LOCAL_PROVIDERS` therefore runs those inline and everything
else through the queue. `POST /connections/{id}/sync` is 202 either way, because
the authoritative answer is in `sync_runs` and on the event stream, not in the
response body; `mode` says which happened.

---

## 5. The contract

`just openapi` → `packages/contracts/openapi/openapi.json`.

- **Idempotent.** Running it twice leaves `git diff --stat packages/contracts/`
  empty.
- **40 paths, 44 operations, 58 component schemas, 38 `$ref`s, 0 dangling.**
  Every `$ref` resolves within the document; none is external.
- `pnpm --filter @app/web gen` succeeds and produces five files in
  `apps/web/src/api/generated` with no other change to `apps/web`.

`servers[0].url` is `/`, relative and deliberately so. `openapi-ts` bakes it into
the frontend client as its base URL, and an absolute one freezes whatever host the
_generator_ ran on into the bundle — the previously committed spec carried
`http://127.0.0.1:8080`, which would have made every browser call from
`https://personalfi.lan` a cross-origin request to a loopback address: a
mixed-content block, a CORS failure and a request that never arrives, all from a
value nobody set on purpose.

`transformObject: jsonSchemaTransformObject` is what actually emits
`components.schemas`. Without it the document has `$ref`s pointing into an empty
object; Fastify serves that happily (nothing validates a served spec) and the
breakage lands one layer away, where every dangling ref becomes `unknown` in the
generated client. A typed client that types its payloads as `unknown` is worse
than no client, because it compiles.

---

## 6. Tests

`apps/api/test/db/`, run by the `api-db` vitest project against a scratch database
per suite (unique name per run, dropped in `afterAll`).

| Suite                         | Tests  | What it pins                                                       |
| ----------------------------- | ------ | ------------------------------------------------------------------ |
| `transactions-routes.test.ts` | 23     | Pagination, filters, overlay, bulk, splits, transfers, export      |
| `connections-routes.test.ts`  | 21     | Connectors, step-up, sync, reconnect, imports, accounts, net worth |
| `sse.test.ts`                 | 11     | Both streams, resume, filtering, heartbeat, clean close            |
| **WP 1.5 total**              | **55** |                                                                    |

`pnpm exec vitest run --project api --project api-db` → **9 files, 111 tests
passed**, 29.5 s.

**Nothing is inserted into `transactions` directly.** Every row under test was
staged into a `ManualConnector` and applied by the real `SyncOrchestrator` through
`applyProviderTransactions` — the same path a bank's rows take. A suite that
seeded with raw SQL would assert against rows no production code path can produce
and would keep passing after the apply layer broke.

The claims worth naming:

- **Keyset pagination is stable under a concurrent write.** A full walk with
  `limit=10` visits every row exactly once _while a sync inserts a transaction
  into the middle of the ordering between two pages_. This is precisely the
  property offset pagination lacks.
- **The overlay outlives a provider restatement.** A row is given a note, a
  category, an exclusion and a payee name; the provider then restates the same
  natural key with a different name and a different amount. Every user-owned field
  survives, the correction lands underneath it in `provenance` with an incremented
  `revision`, and the amount — which has no override — shows through.
- **A bulk patch is one transaction.** A batch containing one id that does not
  exist returns `404 ledger.transaction_not_found` _and the good id is verified
  unchanged afterwards_, so the rollback is asserted rather than assumed.
- **Splits must sum to the cent**, in the parent's currency: `422
ledger.splits_do_not_sum` and `409 ledger.currency_mismatch`, with the round
  trip and the position ordering checked on the way back.
- **Step-up is enforced and the refusal leaves nothing behind.** The link test
  asserts the 403 _and_ that no connection row was created.
- **No credential appears in a connections payload** — the assertion is a
  substring sweep of the whole serialised body for `access_token`, `credential`,
  `secret` and `hasToken`, not a check of named fields.
- **Reconnect preserves account identity**: the assertion is that the account ids
  are the _same ids_, not merely that there are as many. 08 §3.9 calls losing this
  "the classic way a personal finance app silently doubles a user's net worth".
- **SSE is tested over a real socket**, not `app.inject` — an SSE body is an open
  socket that the handler writes to until the client goes away, and `inject` has
  no client to go away. The suite listens on an ephemeral port and drives it with
  `fetch` and an `AbortController`.
- **The heartbeat is driven by the injected clock**, not by fifteen seconds of
  wall time: the test asserts silence while the clock is still, advances it 20 s,
  and then waits for the `:` comment.
- **Clean close is measured on the pool's checkout count**, not on
  `pg_stat_activity`. The first draft used the latter and was silently vacuous —
  a checked-out client is usually an already-established backend being handed out,
  so the server-side count does not move. Ten opens-and-drops must return the
  checkout count to its baseline exactly.

---

## 7. Deferred, and one gap worth raising before WP 1.6

### 7.1 Balances are never recorded through a sync — `@ctx/connections`

**`SyncOrchestrator` never calls `connector.syncBalances`, and nothing in
`@ctx/connections` ever calls the `LedgerWriter.recordBalance` port it declares.**
`grep -rn recordBalance` over the repository finds the ledger's own definition,
the port declaration, the composition-root wiring in `domain.ts` — and one real
caller, `@ctx/ledger`'s `seed-loader`, which bypasses connectors entirely. Every
adapter implements `syncBalances`; the port declares it; `apps/api` wires it; the
sync loop never reaches it.

The consequence is user-visible and lands on WP 1.6: an account linked through
_any_ provider has `balance: null` for ever, so `GET /accounts` renders no
balances and `GET /net-worth` returns `totals: []` with every account carrying
`excludedReason: 'no_balance'`. The accounts page and the net-worth figure are
blank in Phase 1 as things stand.

The fix is a call in `SyncOrchestrator`'s sync loop — one page of balances after
the transaction loop, through the `recordBalance` port it already holds — in a
file WP 1.5 does not own. Until then:

- `connections-routes.test.ts` pins the current behaviour in a test named
  `records no balance from a sync — the orchestrator never asks for one (known
gap)`, so fixing the orchestrator turns it red and whoever does it is sent here.
- A second test writes a balance through `@ctx/ledger`'s real `recordBalance` —
  the exact function the port hands over — and asserts what the _routes_ do with
  it, so the serialisation, the `asOf` caption and the per-currency netting stay
  under test rather than blocked behind a defect in another context.

### 7.2 Transaction splits live in the composition root

`apps/api/src/ledger-splits.ts` writes `transaction_splits`. That is the ledger's
table and `@ctx/ledger`'s `OWNERSHIP.md` claims it, but WP 1.1 shipped the table,
the read path and the error code **without a writer**. The choice was between
shipping `POST /transactions/{id}/splits` as a 501 and writing eighty lines in
`apps/`, the one layer the boundary rule allows to reach across.

**It belongs in `@ctx/ledger` as `setTransactionSplits` and should move there
unchanged.** It is written to make that a file rename: it takes a
`LedgerExecutor`-shaped handle, throws `LedgerError` with the ledger's own codes,
and touches exactly one table.

### 7.3 Smaller items

- **No account nickname.** `PATCH /accounts/{id}` takes `includeInNetWorth` and
  `closed` only; the name comes from the provider and there is no nickname column
  in the Phase 1 schema.
- **Durable staging for manual and CSV.** `PROCESS_LOCAL_PROVIDERS` exists because
  those adapters stage in process memory, which is why their syncs run inline in
  the API instead of on the worker. Making the staging area durable is
  `@ctx/connections`'s to do; it would delete the special case and the branch in
  `POST /connections/{id}/sync` with it.
- **`*Input` schemas in the contract.** `jsonSchemaTransformObject` emits two
  entries per `.meta({ id })` schema because a Zod schema's input and output types
  can differ. Every schema here is response-only, so the `*Input` halves reach the
  frontend as unused generated types. That is the library default and it stays:
  suppressing it means post-processing the emitted document, and a hand-edited
  generated artefact is a worse thing to own than a few dead type aliases.
- **Multi-currency net worth.** Totals are reported per currency and never summed
  across them. There is no FX table in Phase 1, and adding dollars to euros would
  be a wrong number rendered confidently.

---

## 8. Commands

```
just db-up
pnpm typecheck                                          # clean
pnpm exec eslint apps/api packages/contracts            # clean
pnpm exec prettier --check "apps/api/**/*.ts"           # clean
just openapi && git diff --stat packages/contracts/     # empty: idempotent
pnpm --filter @app/web gen                              # 5 files, no other change
pnpm exec vitest run --project api --project api-db     # 9 files, 111 tests
```
