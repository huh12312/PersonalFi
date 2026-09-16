<!-- SPDX-License-Identifier: MIT -->

# WP 1.2 — Connections & Providers: the port, the conformance suite, the orchestrator

Scope: the `Connector` port and its twelve-condition error taxonomy
(`@connector/port`), the shared conformance suite, the Manual, CSV/OFX/QIF and
Seed adapters, and `@ctx/connections` — the connection lifecycle, the registry,
the sync orchestrator, migration `0005_connections.sql`, and the zod wire shapes
WP 1.5 will serve.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Node 26, pnpm, Postgres
18 on `127.0.0.1:5433`. Every count below is from a command run against this
working tree.

---

## Summary

| Deliverable                                                            | Where                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Connector` port, capabilities, canonical facts, mandatory fingerprint | `packages/connectors/port/src/`                              |
| 12-condition → 6-kind error taxonomy with one policy function          | `packages/connectors/port/src/errors.ts`                     |
| Shared conformance suite (runner-agnostic) + vitest wrapper            | `port/src/conformance.ts`, `connections/test/conformance.ts` |
| Manual, CSV/OFX/QIF, Seed adapters                                     | `packages/connectors/{manual,csv}`                           |
| Connection lifecycle, registry, manifests                              | `packages/contexts/connections/src/`                         |
| `SyncOrchestrator` — the page loop and its five invariants             | `packages/contexts/connections/src/orchestrator.ts`          |
| Schema                                                                 | `packages/db/migrations/0005_connections.sql`                |
| Wire contracts (routes are WP 1.5)                                     | `packages/contexts/connections/src/schemas.ts`               |

---

## 1. The port

Nine methods, and nothing in them knows what HTTP is
(`packages/connectors/port/src/connector.ts`):

```ts
interface Connector {
  readonly provider: string; // matches accounts.provider and connections.provider
  readonly displayName: string;
  capabilities(): ConnectorCapabilities;
  connect(input: unknown): Promise<ConnectResult>;
  listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]>;
  syncTransactions(handle, cursor: Cursor | null, options: SyncOptions): Promise<TransactionPage>;
  syncBalances(handle, options): Promise<readonly ProviderBalanceFact[]>;
  syncHoldings?(handle, options): Promise<readonly ProviderHoldingFact[]>; // only if declared
  syncLiabilities?(handle, options): Promise<readonly ProviderLiabilityFact[]>;
  disconnect(handle: ConnectionHandle): Promise<void>;
  health?(handle: ConnectionHandle): Promise<ConnectorHealth>;
}
```

Four rules an adapter lives under, each mechanised rather than documented:

- **It never writes to the database.** A page is data; the caller owns
  persistence and the transaction boundary. Enforced by the boundary lint: the
  `connectors` layer's allow-list is `@core/kernel`, `@core/secretbox`,
  `@connector/port` and nothing else, so an adapter has no database handle to
  misuse.
- **It never persists a credential and never holds one as a field.**
  `ConnectionHandle.secret` is a **closure**, not a property, so a token cannot
  reach a log line by being part of an object somebody serialised. The
  conformance suite asserts `JSON.stringify(handle)` contains no secret.
- **It never decides retry policy.** It classifies the failure as a
  `ConnectorError` and stops. `retryPolicyFor` decides what happens next, once,
  for every provider.
- **Every `ProviderTransactionFact` carries a `fingerprint`**, including
  adapters with stable provider ids:
  `sha256(accountRef, postedDate, amount, normalisedDescription)`. It is the
  dedupe key when a CSV import overlaps a Plaid backfill and when a provider
  rotates its ids.

`ProviderTransactionFact` is deliberately **structurally identical to
`@ctx/ledger`'s `ProviderTransactionInput`, plus `providerAccountId` and
`fingerprint`**, so the orchestrator hands a page's array straight to the ledger
writer with no mapping step and no second "canonical transaction" to drift from.

Sign convention: **negative = outflow**, from the account's own perspective, on
every account type including credit cards. Normalised at the adapter edge, and
asserted by the conformance suite and again by the seed end-to-end test.

---

## 2. Error taxonomy and orchestrator policy

Two vocabularies, on purpose. `condition` is the provider-facing name for the
history UI; `kind` is the six-value discriminant the orchestrator branches on.
`KIND_OF_CONDITION` is the one place they meet, and it is unit-tested.

| Condition                    | Kind                   | Retryable | Restart     | User action | What the orchestrator does                                      |
| ---------------------------- | ---------------------- | --------- | ----------- | ----------- | --------------------------------------------------------------- |
| `AUTH_REQUIRED`              | `auth_required`        | no        | `resume`    | yes         | status → `reauth_required`, schedule stops, cursor+data kept    |
| `MFA_REQUIRED`               | `auth_required`        | no        | `resume`    | yes         | as above                                                        |
| `CONSENT_EXPIRED`            | `auth_required`        | no        | `resume`    | yes         | as above                                                        |
| `RATE_LIMITED`               | `rate_limited`         | yes       | `resume`    | no          | sleeps `retryAfterMs` when the provider gave one, else backoff  |
| `PROVIDER_DOWN`              | `provider_unavailable` | yes       | `resume`    | no          | full-jitter backoff, status → `error`                           |
| `ITEM_LOCKED`                | `provider_unavailable` | yes       | `resume`    | no          | as above                                                        |
| `CURSOR_EXPIRED`             | `transient`            | yes       | `from_null` | no          | restarts from `null`, heals by idempotent upsert, never deletes |
| `MUTATION_DURING_PAGINATION` | `transient`            | yes       | `page_one`  | no          | restarts the whole loop from the page-1 cursor, max 3           |
| `INSUFFICIENT_SCOPE`         | `permanent`            | no        | `resume`    | yes         | status → `error`, no retry                                      |
| `DATA_UNAVAILABLE`           | `permanent`            | no        | `resume`    | yes         | as above                                                        |
| `MALFORMED_RESPONSE`         | `permanent`            | no        | `resume`    | yes         | as above; the redacted context is kept for forensics            |
| `CONFIG_ERROR`               | `invalid_input`        | no        | `resume`    | yes         | as above — retrying identical input is a loop                   |
| `INTERNAL`                   | `permanent`            | no        | `resume`    | yes         | fail closed: anything unrecognised is ours and is loud          |

`asConnectorError` wraps anything an adapter threw that was not already typed,
as `INTERNAL`/`permanent` — **fail closed**, so an unrecognised exception is
loud rather than silently retried forever.

How long to wait is **not** in this table. `retryAfterMs` means "the provider
told us"; everything else is `@core/platform`'s `backoffDelayMs` — full jitter,
six-hour cap — so there is one backoff implementation in the repo.

The division of labour with the job queue: `syncConnection` never throws for a
provider failure (the failure is the return value, because every caller needs
the counts and the run id either way). `jobHandler` then rethrows **only when
`policy().retryable`** is true, because a throw is what makes the runner back
off. A non-retryable failure is already recorded in `sync_runs` and on the
connection's status, and retrying it five times would burn rate limit to reach
the same answer.

---

## 3. Orchestrator invariants and commit granularity

### Commit granularity: the cursor decides, not the page

08 §2.3 rule 2 says "per page"; 01 §5.1 and 04 §4.2 say "accumulate every page
and commit once", because that is Plaid's documented instruction. They are
talking about two different kinds of provider, and the orchestrator branches on
exactly that — the **`incremental_sync` capability**, which is the adapter's own
declaration that it has a cursor:

- **Cursor providers accumulate.** `/transactions/sync` is a _delta stream_:
  page 3 may retract a row page 1 added, so no prefix of the stream is a
  consistent statement of anything, and committing page 1 alone publishes a
  transaction the provider has already withdrawn. The run holds every page and
  one transaction writes the whole delta **and** the final cursor.
- **Window providers commit per page.** A file import, a manual log, a 90-day
  window pull: every page is independently true, `nextCursor` is a position
  rather than a delta token, and a 730-day backfill is thousands of rows.
  Holding one transaction open across sixty provider round trips locks
  `transactions` for the whole of it against a five-minute nightly budget; 04
  §4.7 says "chunk the writes (~500/transaction) to avoid long-running locks".

Pages inside one commit are applied **in order**, not merged first: a page that
retracts a row an earlier page added has to be applied after it, and a merged
`{added, removed}` would leave the outcome to the ledger's internal ordering.

`#commitPages` is the **only** function that writes `transactions_cursor`, and
it takes the pages and the cursor together — there is no signature in the class
that could commit one without the other.

### The five invariants

1. **The cursor never advances outside the write transaction.** A cursor that
   commits while its rows do not is permanent, silent data loss: the provider
   will never resend. Proven by injecting a failure mid-pagination and observing
   that both the rows and the cursor are unchanged (§5).
2. **Commit granularity follows the cursor** (above). `sync_runs.page_count`
   counts pages the provider sent, not transactions we opened.
3. **A mutation during pagination restarts the loop, not the call**, from the
   cursor the run began with (01 §5.1). For a cursor provider nothing has
   committed, so the accumulated pages are simply dropped; for a window provider
   the stored cursor is rewound in its own transaction first, so a crash during
   the restart resumes from page one rather than from the middle of a stream we
   have already decided to discard. Bounded by `MAX_RESTARTS = 3` (04 §4.2),
   counted separately from `maxAttempts` so a busy institution cannot consume
   the budget a genuinely transient failure needs.
4. **`auth_required` stops, it does not retry.** Every further call is
   guaranteed to fail and burns the rate limit the _reconnect_ will need. The
   connection goes to `reauth_required`, the cursor and every row are preserved,
   the scheduled fan-out skips it, and the job returns normally.
5. **Every attempt leaves a `sync_runs` row** — success, failure, and the
   failures that happen _before_ the first page. A run that never started and a
   run that failed look identical from the outside otherwise.

Two more, both structural rather than numbered:

- **One sync per connection.** `enqueueJob` is called with both
  `dedupeKey` and `singletonKey` set to `connections.sync:<connectionId>`, so a
  webhook, the nightly schedule and a user clicking refresh are one job. 04 §4.4
  calls two concurrent cursor loops on one connection "the fastest way to
  corrupt cursor state".
- **A transaction for an account the connection never listed is a contract
  violation, not a row to drop.** `groupByAccount` raises
  `MALFORMED_RESPONSE` with a _count_ — a provider account id identifies one of
  the user's bank accounts and does not belong in a column the UI renders.

Defaults: `DEFAULT_HISTORY_DAYS = 730` (D16), `DEFAULT_PAGE_SIZE = 500`,
`DEFAULT_MAX_ATTEMPTS = 5` (08 §6.2), `MAX_RESTARTS = 3`, `MAX_PAGES = 2000`,
`DEFAULT_DEADLINE_MS = 10 min`, nightly at `15 3 * * *` with ±20 min jitter.

Pre-flight refuses a call that would be rude or wasted: `minSyncIntervalSeconds`
is the politeness floor (a `manual` trigger bypasses it, because the user is
standing there watching) and `refreshBudgetPerDay` is the provider's own cap,
which **nothing** bypasses — spending the last SimpleFIN request of the day on an
impatient click is how the nightly sync fails. A refusal returns `skipped` and
writes no `sync_runs` row, so it cannot debit the budget twice.

---

## 4. Conformance results per adapter

The checks live in `@connector/port` (`src/conformance.ts`) as
runner-agnostic named async functions, **not** `it()` calls, and
`@ctx/connections/test/conformance.ts` wraps them as
`describeConnectorConformance(label, factory)` — eleven lines. The suite lives
beside the port rather than inside the context because `personalfi/layer-imports`
denies `packages/connectors/*` → `@ctx/*`: a suite an adapter package cannot
import is a suite only the adapters someone remembered to wire up will ever run.
WP 1.3's `packages/connectors/plaid/test/*.test.ts` writes its own eleven lines.

Twelve checks, covering the nine properties of 08 §2.7:

| Check              | What fails it                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `capabilities/`    | a declared dataset that does not work, or an undeclared one that returns `[]` instead of throwing |
| `sync/idempotent`  | the same cursor twice producing a different page                                                  |
| `cursor/monotonic` | a cursor repeated mid-stream, or `null` while `hasMore`                                           |
| `sync/terminates`  | `hasMore` never reaching `false`; a terminal page moving the cursor                               |
| `sync/resumable`   | stopping at page two and resuming reaching a different end state                                  |
| `removed/`         | an id re-added after being removed in the same stream                                             |
| `money/`           | an amount with no ISO currency, or a non-`bigint` minor unit                                      |
| `fingerprint/`     | a missing or non-sha256 fingerprint                                                               |
| `pending/`         | a settled row claiming to replace something that was never pending                                |
| `errors/`          | a bad cursor or bad link input rejected with an untyped `Error`                                   |
| `secrets/`         | a credential surviving `JSON.stringify(handle)`, or a credential-shaped field                     |
| `disconnect/`      | a disconnected connection still returning data                                                    |

**Results — all twelve green for all three adapters:**

| Adapter              | Provider id   | Shape                                                                      | Result  |
| -------------------- | ------------- | -------------------------------------------------------------------------- | ------- |
| `ManualConnector`    | `manual`      | in-memory append-only log, 11 rows, 3/page, one pending→posted lifecycle   | 12/12 ✓ |
| `CsvImportConnector` | `file_import` | parsed CSV, 10 rows incl. a deliberate duplicate, 4/page                   | 12/12 ✓ |
| `SeedConnector`      | `seed`        | `generateDemoData(1)`, ~1,000 transactions, 250/page, interleaved removals | 12/12 ✓ |

**The suite is itself sabotage-tested.** A gate that has never been observed
failing something is not evidence, so `test/conformance.test.ts` contains seven
tests that break `ManualConnector` in one specific way each and assert the
matching check _fails_: a declared-but-impossible dataset, a stream not
reproducible under replay, a cursor that never terminates, a row re-added after
retraction, a missing fingerprint, an untyped `connect` rejection, and a handle
carrying its credential as data (with the honest handle asserted to pass the
same check, so the test is not vacuous).

One gap worth naming: the `secrets/` check asserts that a **serialised handle**
carries no credential, which is the testable form of "no secret in any log
line". It cannot assert anything about a log line an adapter never emits,
because an adapter has no logger — the boundary lint gives it `@core/kernel`,
`@core/secretbox` and `@connector/port` and nothing else. The end-to-end
log-hygiene evidence for P0-12 is `apps/api`'s own suite.

---

## 5. Orchestrator evidence against a real database

`test/db/orchestrator.test.ts`, 20 tests, all green. The `LedgerWriter` double
writes **real rows through the executor it is handed**, so it participates in
the orchestrator's transaction for real and a rollback rolls its rows back too —
that is the only way "the delta and the cursor commit together" is observable at
all.

| Claim                                                 | How it is proven                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-run atomic commit (cursor provider)               | inject a ledger failure on the row that lands on page 3 of 4; assert `total = 0` rows, `transactions_cursor IS NULL`, `sync_runs.cursor_after IS NULL`, `page_count = 0`                                                                         |
| Per-page commit (window provider), cursor never ahead | same injection against a connector with `incremental_sync` removed; assert exactly 6 rows committed, cursor `= '6'`, run `partial`                                                                                                               |
| Restart from the page-1 cursor                        | `MUTATION_DURING_PAGINATION` on call 2; assert `log.asked[2] === null` — the loop asked for the _run's_ starting cursor again, not for page 1's output — and that no row arrived twice                                                           |
| `MAX_RESTARTS = 3`                                    | a connector that mutates on every attempt; assert `restartCount === 3`, run `failed`, `sync_runs.restart_count = 3`, zero rows committed                                                                                                         |
| `CURSOR_EXPIRED` → restart from `null`, idempotent    | a full sync, then an expired cursor on the next run; assert the stream is re-pulled, row count is **unchanged**, and `max(seen_count) = 2` — so the re-pull genuinely happened and the upsert absorbed it                                        |
| `AUTH_REQUIRED` → reauth + event + schedule paused    | assert status `reauth_required`, exactly **one** call to the adapter and **zero** sleeps, one `ConnectionStatusChanged` event with `to: 'reauth_required'`/`reason: 'auth_required'`, `listSyncableConnections` empty, cursor and rows preserved |
| `RATE_LIMITED` honours `retryAfter`                   | a 429 carrying `retryAfterMs: 30_000`; assert the recording sleeper saw exactly `[30000]` — not a jittered guess — and the run then succeeded                                                                                                    |
| Refresh budget is debited                             | `refreshBudgetPerDay: 2`; the third sync returns `skipped`/`refresh_budget` with `syncRunId === null`, and only two `sync_runs` rows exist                                                                                                       |
| One `sync_runs` row per attempt                       | three runs (success/failed/success); assert statuses, triggers, `errorKind`, `errorCode`, non-null `finishedAt`, `durationMs > 0` (the clock advances inside the provider call), and `cursor_before`/`cursor_after` on both sides                |
| A failure before the first page still leaves a row    | `listAccounts` rejects; assert one `failed` row with `page_count = 0`                                                                                                                                                                            |
| Dedupe: one sync per connection                       | three `syncNow` calls (scheduled, webhook, manual); assert `deduped` is `false,true,true` and exactly one `jobs` row keyed `connections.sync:<id>`                                                                                               |
| Two connections stay independent                      | both enqueue with `deduped === false`                                                                                                                                                                                                            |
| Reconnect preserves data and account identity         | sync, re-link, assert same `connectionId`, `relinked === true`, **identical** ledger row and account counts, cursor preserved; then a further sync adds only the new rows                                                                        |
| Seed through the port, end to end                     | §6                                                                                                                                                                                                                                               |

`test/db/connections.test.ts`, 16 tests: the credential column holds ciphertext
and no plaintext, a ciphertext moved between rows fails to open (AAD binding),
re-link is an update not a second row, a status change is announced once and not
on every repeat of the same nightly failure, `error_since` marks when the
trouble started rather than when we last noticed, disconnect destroys the secret
and keeps the history, a provider that refuses cannot block a local disconnect,
another user's connections are invisible, and neither the cursor nor a token
appears in any read model.

**One finding from writing these tests.** `connection_accounts_account_idx` is
`UNIQUE (user_id, account_id)` — one ledger account is claimed by at most one
connection. The pre-existing lifecycle fixture linked two different connections
onto the same `providerAccountId`, which the ledger writer's natural key
`(user_id, provider, provider_account_id)` resolves to one account, so the
second link was rejected. That is the schema being right; the fixture was
namespaced per connection and the invariant now has a test of its own
("refuses to let a second connection claim an account the first one owns").

### Balance sync (closed gap)

`SyncOrchestrator` originally never called `connector.syncBalances` — an
`apps/api/test/db/connections-routes.test.ts` test pinned the gap under the
name "records no balance from a sync — the orchestrator never asks for one
(known gap)". `#syncBalancesIfDue` (`src/orchestrator.ts`, called from
`syncConnection` after the transactions half is settled; design rationale in
the header comment's "Invariant 6") closes it. Three things about the fix are
load-bearing, and each has its own test:

- **Commit granularity: after the transactions write transaction, never
  inside it.** Balances is a second network call; making it before the
  transactions delta commits would hold that delta hostage to a request that
  has nothing to do with it, mirroring the "no remote call inside a
  transaction" rule `#runPages` already follows for `listAccounts`. Each
  recorded balance is still its own `INSERT ... ON CONFLICT DO NOTHING`
  inside a fresh transaction opened only for the balances step — proved by
  "records a balance for a cursor provider (Manual) after a successful
  transactions sync" and, for the other commit-granularity branch, "records a
  balance for a window provider, without disturbing its per-page cursor",
  which asserts the transactions cursor sits exactly where the last committed
  page left it once the balances step has also run.
- **Run-row semantics: two rows, one per operation, never one row claiming
  both.** A sync that both applies transactions and records a balance leaves
  a `sync_runs` row with `operation: 'transactions'` and a second with
  `operation: 'balances'`, each with its own status, counts and error columns
  — proved by the same two tests above (`runs.find((run) => run.operation ===
...)` against both) and against the seed dataset's full account set by
  "records a balance for every account the seed dataset describes, through
  the same port". A sync that finds nothing to report (CSV/QIF, or a manual
  connection nobody entered a balance on) writes no `balances` row at all —
  the existing non-balance orchestrator tests are the negative evidence,
  since none of them gained a second `sync_runs` row from this change.
- **Failure isolation: a balances error never fails or rolls back the
  transactions run.** `#syncBalancesIfDue` runs after the transactions run's
  own row is already written and its transaction already committed, so
  nothing it does from there can touch either. Proved by "records a balances
  failure without losing a transactions delta that already committed": the
  transactions `sync_runs` row stays `success`, the transactions row count
  and the connection's cursor are unchanged, and only the `balances` row
  records `status: 'failed'` with `errorKind: 'provider_unavailable'`. The
  reverse case — a transactions failure that leaves nothing committed — is
  proved by "does not ask for balances behind a transactions failure that
  committed nothing": `AUTH_REQUIRED` on the first call never reaches
  `syncBalances` at all (invariant 4's reasoning applies here too — asking
  would spend the same rate limit the reconnect needs), and exactly one
  `sync_runs` row exists.

The read-model side of the gap is closed the same way: the api-db test
formerly named "records no balance from a sync — the orchestrator never asks
for one (known gap)" (`apps/api/test/db/connections-routes.test.ts`) now
asserts the opposite — that the account the `GET /accounts` route renders
carries the exact balance staged on the connection's initial batch, recorded
by the real orchestrator and the real `@ctx/ledger` `recordBalance` through
`apps/api`'s composition root. That closes the last piece of
docs/evidence/phase-1/wp1.5-api.md §7's gap write-up from this package's side.

---

## 6. The seed dataset, end to end through the port

`generateDemoData(1)` is staged into `SeedConnector` and delivered as pages
through the real orchestrator, into the real `connection_accounts` mapping and
the ledger double. The assertion is arithmetic rather than a spot check:

- `live rows == dataset.transactions.length` — every seed transaction ends as
  exactly **one** live ledger row, whatever lifecycle it went through. That is
  decision D10 (pending→settled is one transaction, not two) proved _through the
  orchestrator_, not asserted about the adapter.
- `retracted rows == transactions with a pending phase that later posted`, and
  `total == live + retracted`.
- `accounts == dataset.accounts.length` — no duplicate accounts.
- `summary.removedCount == retracted`.
- Zero rows with a blank currency, and a non-zero count of negative amounts —
  the sign convention survived the trip.
- A second run adds nothing: `addedCount === 0` and the row count is unchanged.

The seed adapter emits the pending→posted lifecycle **the hard way** on purpose
(01 §5.2's delete-plus-insert: an `added` pending fact, a `removed` of that id,
then an `added` posted fact carrying `pendingTransactionId`). Emitting only the
final posted row would have made this test green while leaving D10's identity
migration completely untested through the orchestrator.

---

## 7. Registry and manifests

`ConnectorRegistry` is the one place `provider === 'plaid'` may appear, and even
here it is a map key rather than a branch. It refuses a manifest whose
`provider` does not match the adapter it describes (it would render the wrong
icon and, worse, be looked up under an id the adapter never writes into
`accounts.provider`), and an unregistered provider raises
`ConnectionsError('connections.unknown_provider')` — a **domain** error, not a
`ConnectorError`, so the orchestrator does not back off and retry for six hours
to discover that a module is disabled.

`ConnectorManifest` is what the "Add a connection" screen renders from, as data:

| Field         | Manual         | File import     | Seed           |
| ------------- | -------------- | --------------- | -------------- |
| `provider`    | `manual`       | `file_import`   | `seed`         |
| `displayName` | Manual account | File import     | Demo data      |
| `iconKey`     | `pencil`       | `file_arrow_up` | `beaker`       |
| `linkKind`    | `manual_entry` | `file_upload`   | `manual_entry` |
| `docsUrl`     | `null`         | `null`          | `null`         |

`iconKey` names an asset the web app already ships. It is deliberately **not** a
URL and not an SVG: a manifest is served from the API, and a server-controlled
field the browser renders as markup or fetches as a resource is a hole. An
unknown key maps to a generic bank glyph, so a Phase 2 adapter is renderable the
day it registers and pretty the day someone draws it.

`test/registry.test.ts` validates every shipped manifest against
`connectorManifestSchema` — the same schema `GET /connectors` will validate its
response with in WP 1.5, so a manifest that would fail there fails here instead.

---

## 8. Wire contracts (zod), exported; routes are WP 1.5

`src/schemas.ts`, re-exported from `src/index.ts`:
`connectorManifestSchema`, `capabilitiesSchema`, `connectionSummarySchema`,
`connectionAccountSchema`, `connectionDetailSchema`, `syncRunSchema`,
`createConnectionRequestSchema`, `createConnectionResponseSchema`,
`syncNowResponseSchema`.

No routes here. `apps/api`'s route structure, problem-details mapping and
OpenAPI emission are WP 1.5's, and adding handlers from a work package that does
not own that structure is how two packages end up owning one file. What can be
settled now is the contract, and settling it now is the point, because 1.5 and
the frontend's generated client both depend on it.

What is deliberately absent from every shape: `sealed_credentials`, obviously,
but also `transactions_cursor`. The cursor is opaque to us and meaningless to a
client, and a value that appears in an API response is a value somebody will
eventually parse. A test asserts the string `transactionsCursor` does not appear
in a serialised detail view.

---

## 9. CSV/OFX/QIF, and the licence-gate note

The parsers are **original implementations**; nothing is vendored.
`packages/connectors/csv/NOTICE` records that explicitly, along with the reason:
Actual Budget's `ofx2json`/`qif2json` are ISC (a licence this repo's policy
allows) but depend on `xml2js`, and this package takes no third-party runtime
dependency. Only the _idea_ of the SGML-to-XML repair was consulted; no code,
comments, structure or test fixtures were copied. `ofxtools` (GPL-3.0) is
denylisted, and Firefly III's import configurations (CC-BY-SA-4.0) and
Maybe/Sure/Ghostfolio (AGPL-3.0) were not consulted.

**The gate does not check this, and that is the point of writing it down.**
`just verify`'s licence step (`scripts/check-licenses.ts`) reads
`pnpm licenses list --prod` — that is, dependency _manifests_ — and `trivy fs`
runs `--scanners vuln,secret,misconfig`. Neither reads a single source-file
header. So if ISC-licensed parser code from Actual Budget (or anywhere else) is
vendored into this package in a later work package, **no automated check will
notice a missing attribution**: the ISC copyright notice has to be added by hand
in two places, the `NOTICE` file and a header comment at the top of each
vendored file, and a reviewer is the only mechanism that will catch its absence.
`NOTICE` carries that rule so the next person to vendor something reads it
before the reviewer has to.

### Parsers and their fixtures

112 tests over five files. Fixtures are hand-written and contain **no real bank
data** — invented institutions, invented account numbers. The multi-account OFX
case is pinned byte-for-byte against a checked-in
`ofx-multi-account.expected.json` compared with `toEqual`, rather than spot
checks on `transactions[0]`.

OFX SGML repair is now covered case by case: a stray/unmatched close tag, text
interrupted and concatenated, a self-closing tag that must not be pushed, header
and comment skipping, a tag that is never closed, a nameless tag, declarations
with no elements, no tags at all, decimal/hex/unknown entities, **three
statements for three different accounts in one file** (`STMTRS` plus
`CCSTMTRS`), the `PAYEE/NAME`→`MEMO` fallback chain, `CHECKNUM` present and
absent, and missing or malformed `ACCTID`/`FITID`/`DTPOSTED`/`TRNAMT`. Every
failure asserts the mapped `ConnectorError` (`invalid_input`/`CONFIG_ERROR`,
`policy()` not retryable) and that `redactedContext` carries only `{file, line}`
— never a row's contents.

Each repair rule was **sabotage-tested**: breaking `popTo`'s unmatched-close
guard fails 5 tests, always pushing a self-closing tag fails 4, overwriting
instead of concatenating interrupted text fails 1, dropping unknown-entity
preservation fails 1, and dropping `CCSTMTRS` from the statement loop fails 6.

### Re-import is zero new rows

A row's `providerTransactionId` is `sha256(provider, providerAccountId,
postedDate, amount, normalisedDescription, occurrence)` where `occurrence`
numbers rows within their `(date, amount, description)` group **in file order**
— not the line number, so a re-export with an extra row at the top does not
shift every id. OFX uses the bank's own `FITID` instead, when there is one.

Proven at two levels: `importFile` twice over the same file yields an identical,
all-distinct id set; and `CsvImportConnector.addFile` twice yields
`{ staged: 0, skipped: n }` the second time, including the overlapping case
(import January, then a January+February file, and only February is staged).
Removing `addFile`'s skip fails 6 tests.

### Mapping profiles are user data

08 §2.6: "Mapping profiles are user data, stored per institution." The five
`CSV_PRESETS` remain as defaults, and `src/config.ts` adds the validated storage
shape so a profile living in `connections.config` JSONB is _checked_ rather than
asserted:

```ts
csvColumnMappingSchema, csvProfileSchema, csvConnectionConfigSchema  // { profiles: Record<id, CsvProfile> }
parseCsvProfile(raw: unknown): CsvProfile                            // throws CONFIG_ERROR
parseCsvConnectionConfig(raw: unknown): CsvConnectionConfig
resolveCsvProfile(config, id): CsvProfile                            // stored profile shadows a preset of the same id
```

`resolveProfile` inside the connector now runs a profile _object_ through
`parseCsvProfile`, because a `CsvProfile` arriving from JSONB was previously
asserted by a type annotation and validated by nothing. The failure that matters
is silent: a stored `amountSign: "reversed"` that the parser reads as `natural`
imports `[3_150n, -20_000n]` where the correct profile gives `[-3_150n,
20_000n]` — every sign inverted, no error raised. `config.test.ts` demonstrates
exactly that inversion and then shows `parseCsvProfile` refusing the value.

Reading the stored config back on a sync is WP 1.5's wiring (§12).

---

## 10. Checklist: adding a new adapter

1. `packages/connectors/<provider>/` with `package.json`
   (`@connector/<provider>`, `exports` pointing at `src/index.ts`),
   `OWNERSHIP.md` (an adapter owns **no table**), and `src/index.ts` as the only
   public surface.
2. Implement `Connector`. Declare **honest** capabilities: a dataset you declare
   must work, and one you do not declare must **throw** `unsupported` rather
   than return `[]`. A silently-empty dataset is indistinguishable from "this
   account holds nothing", which is how a brokerage drops out of net worth for
   three weeks.
3. Normalise the sign at the edge (**negative = outflow**), put a currency on
   every `Money`, and compute `fingerprintOf(...)` for every transaction — even
   if the provider has stable ids.
4. Classify every failure as a `ConnectorError` with a `condition` from the
   twelve. Never retry, never sleep, never decide policy.
5. Take secrets only through `handle.secret(name)`. Never store one, never put
   one in `redactedContext`, never put one in a message.
6. Export a `ConnectorManifest` with an `iconKey`, a `linkKind` and a
   `docsUrl`. Do not touch the UI.
7. Write `test/conformance.test.ts`: eleven lines calling
   `describeConnectorConformance(label, factory)`. It must be green before
   anything else is.
8. Add the package to `pnpm-workspace.yaml` (already globbed by
   `packages/connectors/*`) and a project to `vitest.config.ts`.
9. Register it in `apps/api`'s composition root behind the module flag. Nothing
   in `@ctx/connections`, in the orchestrator, or in the UI changes.

If step 9 requires a change to the orchestrator, the adapter is doing something
the port should be doing — that is the signal to change the port, once, for
everyone.

---

## 11. Verification

```text
pnpm typecheck                                       clean for every path this WP owns
pnpm exec prettier --check <owned paths>             All matched files use Prettier code style!
pnpm exec eslint <owned paths>                       clean
node scripts/check-schema-ownership.ts               ok — 94 table(s) claimed across 14 package(s), 41 defined
```

Migration `0005_connections.sql` applies on a genuinely empty database, not just
onto the dev one:

```text
CREATE DATABASE wp12_fresh;  then runMigrations({ databaseUrl: .../wp12_fresh })

applied 0001_initial in 17ms
applied 0002_identity in 154ms
applied 0003_platform in 95ms
applied 0004_ledger in 136ms
applied 0005_connections in 36ms
applied 0006_categorization in 98ms
pending after: 0

SELECT table_name FROM information_schema.tables
 WHERE table_name IN ('connections','connection_accounts','sync_runs');
 -> connection_accounts, connections, sync_runs   (3 rows)
```

It also applies from scratch on every run of the `*-db` projects:
`@core/testkit`'s `createTestDatabase` creates a new database and runs the
migration runner over it from `0001`, and both `connections-db` suites do so per
run.

Vitest projects (`vitest.config.ts`, registered under the finer names
`connector-port` / `connector-manual` / `connector-csv` rather than one
`connectors` project, so a failing adapter names itself):

| Project            | Tests | Needs Postgres |
| ------------------ | ----- | -------------- |
| `connector-port`   | 26    | no             |
| `connector-manual` | 13    | no             |
| `connector-csv`    | 112   | no             |
| `connections`      | 51    | no             |
| `connections-db`   | 36    | yes            |
| **total**          | 238   |                |

(`connections-db` was 31 as of the original WP 1.2 write-up; the balance-sync
fix added five tests — see "Balance sync (closed gap)" in §5.)

`just check` **fails**, and only outside this work package: `typecheck` reports
three errors in `packages/contexts/categorization/test/consumer.test.ts` (a
`RecordingLogger.records` property and a drizzle `Database`/`Executor` variance
mismatch), from WP 1.4, which was in flight concurrently. Excluding that file,
`tsc -p tsconfig.json` is clean. `packages/db/test/migrate.test.ts` also fails
on `0006_categorization.sql` matching the banned `REAL|DOUBLE PRECISION|FLOAT|
MONEY` pattern — likewise WP 1.4's.

### One incidental fix

`packages/connectors/port/src/fingerprint.ts` contained a **literal NUL byte**
as its field separator. `file(1)` reported it as `data` and git as binary, so
the file never appeared in a diff, would not merge, and would drop silently out
of code review — for the module that computes the mandatory fingerprint every
dedupe decision rests on. Replaced with the `'\u0000'` escape: byte-identical at
runtime, so no fingerprint changes, and the file is now text
(`JavaScript source, Unicode text, UTF-8 text`). The port's fingerprint tests
are unchanged and green.

---

## 12. Deferred

**To WP 1.3 (Plaid):**

- The `plaid` adapter itself, and the `PLAID_*` condition mapping onto the
  twelve. The taxonomy and `retryPolicyFor` are already shaped for it —
  `MUTATION_DURING_PAGINATION` exists specifically because 01 §5.1 describes
  Plaid's `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` as a distinct recovery.
- Webhook ingestion. `supportsWebhooks` is on the capability set and
  `provider_webhooks` is claimed in `OWNERSHIP.md`; nothing implements it.
- `syncHoldings` / `syncLiabilities` through the orchestrator. The port carries
  the fact shapes and the orchestrator syncs transactions only; `sync_runs`
  already has the `operation` column that will separate them.

**To WP 1.5 (API + composition root):**

- **`LedgerWriter`'s shapes are not verified against the real ledger in this
  package's tests, and cannot be.** The boundary lint denies `@ctx/connections`
  → `@ctx/ledger` unconditionally, so the suite uses a double. The real check is
  the composition root's type-check: `const ledgerWriter: LedgerWriter = {
applyProviderTransactions, upsertAccount, recordBalance }` in `apps/api` is
  three references and a compile error the moment the ledger changes a
  signature. **That compile error is the entire safety mechanism for this seam**
  and it does not exist until 1.5 wires it. It should be the first thing 1.5
  does.
- Routes, problem-details mapping, OpenAPI emission for the schemas in §8.
- Registering `CONNECTIONS_EVENTS`, the sync job handler, the fan-out job and
  the nightly schedule behind `module.connections`.
- Feeding `connections.config` back to an adapter. The column exists, it is
  written at link time, and `@connector/csv` now exports
  `parseCsvConnectionConfig` / `resolveCsvProfile` to validate and resolve what
  it holds — but nothing **reads** the column yet. Until 1.5 threads it to
  `addFile`, a per-institution mapping profile is supplied per call rather than
  remembered.
- ~~`CsvImportConnector` stages rows in memory, so a process restart between
  upload and sync loses them and the cursor reads as `CURSOR_EXPIRED`. Correct
  but unhelpful; durable staging is 1.5's, once there is a route that receives
  the file.~~ **Closed by decision D-5** — see §13.

**Nothing the Ledger's API lacked.** `applyProviderTransactions`,
`upsertAccount` and `recordBalance` all take the executor first, which is the
one property this context could not have worked around: a writer that could only
take the pool could not participate in the orchestrator's transaction, and the
central invariant would have been unimplementable. `ProviderTransactionInput`
being structurally a subset of `ProviderTransactionFact` is the other thing that
went right — it is why the orchestrator has no mapping step.

---

## 13. Durable staging (decision D-5)

Phase 1 close-out condition D-5 (gate-security-review.md §8.6 N-7, §8.11):
`ManualStore` and `CsvImportConnector`'s own `#staged` map were per-process, in
memory. A user-triggered sync after an api restart failed
(`AUTH_REQUIRED`, "this manual connection has been disconnected"), and the
worker — a different process — could never sync one of these connections at
all; the nightly fan-out had to filter them out (`PROCESS_LOCAL_PROVIDERS` in
`apps/api/src/modules.ts`), which stopped the false failure but left both gaps
`domain.ts` named as this context's to close.

### Design, in five lines

1. One table, `connection_staged_facts` (migration
   `0008_connections_staging.sql`), owned by `@ctx/connections`, `kind`-
   discriminated into upserted **state** (`account`, `balance` — last write
   wins) and an append-only **log** (`transaction_added`/`_modified`/`_removed`).
2. The dedupe key on `transaction_added` is `(connection_id,
provider_transaction_id)`, not `fingerprint`: two genuinely identical
   same-day transactions share a fingerprint but not a `provider_transaction_id`
   (see the migration's header for the "two coffees" example).
3. `ManualConnector`/`CsvImportConnector` keep their existing in-memory buffer
   (`ManualStore`, `#staged`) as the fast, synchronous path `connect()`/
   `addFile()` already wrote to; `attachStagingStore` — called once by
   `apps/api/src/domain.ts`'s `attachDurableStaging`, itself called from
   `createDomainRuntime` (the one function `app.ts`, `worker.ts` and every test
   that builds a runtime already calls with a `database` and the `registry` it
   built, so neither composition root needed to change) — points both at a
   `StagingStore` built on this table.
4. Every connector method that carries a `ConnectionHandle` (`listAccounts`,
   `syncTransactions`, `syncBalances`) hydrates the in-memory buffer from the
   durable store on first use in this process, then flushes whatever the
   buffer holds back to the durable store before returning — see `#sync`/
   `#hydrate`/`#flush` in each connector's `connector.ts`.
5. There is no separate "consumed" column. The cursor **is** the consumption
   marker: a page is a slice of an immutable, ordered (`seq`) prefix, so the
   same cursor read twice returns the same rows twice, which is exactly the
   idempotent/monotonic/resumable contract the conformance suite already
   requires of every adapter.

### The table

| Column                                                                             | Meaning                                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `seq`                                                                              | `BIGSERIAL`, one sequence shared by every kind — the cursor, stringified                |
| `id`                                                                               | App-generated UUIDv7                                                                    |
| `user_id`, `connection_id`                                                         | Both `NOT NULL`, both `REFERENCES ... ON DELETE CASCADE`                                |
| `kind`                                                                             | `account` \| `balance` \| `transaction_added` \| `_modified` \| `_removed`              |
| `provider_account_id`                                                              | Always present                                                                          |
| `provider_transaction_id`                                                          | Transaction kinds only; the dedupe key with `connection_id`                             |
| `fingerprint`, `amount_minor`/`amount_currency`, `available_*`, `limit_*`, `as_of` | Typed money/decimal columns — never a float (see the migration's "no float, ever" note) |
| `fact`                                                                             | `JSONB`; everything else the fact carries that is not money                             |

Indexes: `(connection_id, seq)` for the cursor read; a partial unique index on
`(connection_id, provider_transaction_id) WHERE kind = 'transaction_added'` for
the dedupe; a partial unique index on `(connection_id, kind,
provider_account_id) WHERE kind IN ('account','balance')` for the state
upsert; `(user_id)` for defense-in-depth scoping.

### Invariants

- **A staged row is consumed at most once per cursor position.** Idempotence
  comes from the partial unique index above, not from application logic that
  could be bypassed — sabotaged red by removing `onConflictDoNothing` (below).
- **A connection's rows are visible only through its own `connection_id`.**
  Every read is `WHERE connection_id = $1`; `user_id` is carried for
  defense-in-depth but is not itself the isolation boundary (ownership of a
  `connection_id` is checked once, upstream, by `requireConnection`/
  `openHandle`, before any connector method is ever called with it) —
  sabotaged red by dropping the `connection_id` filter (below).
- **The orchestrator's own cursor-inside-write-tx invariant is unaffected.**
  Nothing here changes `SyncOrchestrator`'s commit boundary: staging a fact
  durably and applying it to the ledger remain two different writes, exactly
  as `connect()` staging an account and `linkAccounts()` upserting it always
  were (`src/staging.ts`'s module comment).
- **The nightly fan-out no longer needs to exclude these providers.** Durable
  staging means a process that never linked a Manual/CSV connection can
  correctly hydrate and sync it, so excluding it from the schedule only makes
  it stale. `PROCESS_LOCAL_PROVIDERS` still exists — `routes/connections.ts`
  reads it to decide whether a user-triggered sync runs inline or is queued,
  a latency choice now, not a correctness one — but `apps/api/src/modules.ts`'s
  `syncableConnectionIds` no longer consults it.

### Tests

| Project          | New/changed tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections-db` | `test/db/staging.test.ts` (new, 6 tests): "a fresh store instance sees exactly what an earlier one staged (restart survival)"; "the CSV staging store, not just the manual one, survives a fresh instance the same way"; "appendTransactions is idempotent on provider_transaction_id — replaying a batch stages nothing twice"; "two sync runs each consume only the rows staged since their own cursor — none twice, none missed"; "a second user's staged rows never appear under the first user's connection, or vice versa"; "close() purges everything staged for a connection, and only that connection" |
| `api-db`         | `test/db/closeout-staging.test.ts` (new, 4 tests): "a Manual connection staged in one process syncs correctly in a second process over the same database — restart survival, and each staged row consumed exactly once"; "a CSV import staged in one process syncs successfully in a second process over the same database"; "a second account holder cannot see or sync the first holder's connection"; "the nightly fan-out includes a Manual connection with no PROCESS_LOCAL_PROVIDERS filter, and a worker-shaped process completes its sync"                                                              |
| `api`            | `test/regate-worker-boot.test.ts`'s "nightly fan-out (re-gate N-7, closed by decision D-5)" block re-gated: "includes process-local providers in the scheduled fan-out — no PROCESS_LOCAL_PROVIDERS filter" (was "excludes…"), "keeps the process-local providers named — routes/connections.ts still uses the set for inline-vs-queued sync" (was "keeps the in-memory connectors in PROCESS_LOCAL_PROVIDERS", assertion direction unchanged)                                                                                                                                                                  |

All eleven affected projects green: `connector-manual` 13, `connector-csv` 112,
`connections` 51, `connections-db` 42 (36 pre-existing + 6 new), `db` 10,
`api` 57, `api-db` 97 (96 + 1 pre-existing skip, `plaid-sandbox.test.ts`,
needs a real network).

### Sabotage — each broken once, observed red, restored

Both breaks were made in `packages/contexts/connections/src/staging.ts`,
observed red against `connections-db`, then restored with a byte-identical
copy and confirmed with `git diff --quiet`.

**Idempotence** — `appendTransactions`'s `.onConflictDoNothing({...})` removed:

```
FAIL  |connections-db| test/db/staging.test.ts > durable staging (decision D-5) >
  appendTransactions is idempotent on provider_transaction_id — replaying a batch stages nothing twice
Caused by: error: duplicate key value violates unique constraint "connection_staged_facts_added_dedup_idx"
Detail: Key (connection_id, provider_transaction_id)=(…, txn-idem-1) already exists.
```

RED first try — and it fails loudly (a constraint violation) rather than
silently double-staging, because the partial unique index in the migration is
a second, independent enforcement of the same rule.

**User scoping** — `accounts()`'s `connectionId` filter dropped (query became
`WHERE kind = 'account'` with no connection scope):

```
FAIL  |connections-db| test/db/staging.test.ts > durable staging (decision D-5) >
  a second user's staged rows never appear under the first user's connection, or vice versa
AssertionError: expected [ 'acct-checking', 'second-holder-checking' ] to deeply equal [ 'acct-checking' ]
```

RED first try, correctly localised to the connection whose read leaked the
other's account.

### What is unchanged

`SeedConnector` is deliberately excluded from durable staging — it is a demo
fixture with no user data to protect, and its rows are meant to be
regenerable, not durable. `CsvImportConnector.addFile` stays synchronous (the
module comment on `packages/connectors/csv/src/connector.ts` explains why:
`apps/api/src/routes/connections.ts` calls it directly, unawaited, and does
not own the change needed to make it `async`); the durable flush still happens
at the next call that carries a `ConnectionHandle`, in the same request.
