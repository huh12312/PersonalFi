<!-- SPDX-License-Identifier: MIT -->

# WP 1.3 — `@connector/plaid`: the request pins, the field map, the error map, and what the fake proves

Scope: `packages/connectors/plaid` — the `Connector` implementation over
`/transactions/sync`, the Plaid → canonical field map, the Plaid → port error
map, `FakePlaidApi` and its recorded-shape fixtures, the shared conformance
suite run against the adapter, and the live Sandbox runbook.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Node 26, pnpm, `plaid`
47.0.0. Most of what follows comes from the hermetic suite, which needs no
credentials; §7 is the runbook for the one test that talks to Plaid, and §7a is
the record of running it — against real Sandbox credentials, held only as file
secrets under `SECRETS_DIR` — for the first time.

---

## Summary

| Deliverable                                                        | Where                         |
| ------------------------------------------------------------------ | ----------------------------- |
| `PlaidConnector` — the port, plus Link/update-mode/investments     | `src/connector.ts`            |
| Manifest, capabilities, and the pinned constants                   | `src/provider.ts`             |
| The one file that builds an HTTP client (and pins `Plaid-Version`) | `src/client.ts`               |
| Provider shapes → canonical facts                                  | `src/map.ts`, `src/amount.ts` |
| Plaid error vocabulary → the port's six kinds, as a table          | `src/errors.ts`               |
| The eleven-method slice of the SDK the adapter may use             | `src/api.ts`                  |
| `FakePlaidApi` — cursor chain, mutation, broken Item, rate limit   | `test/fake.ts`                |
| Recorded-shape fixtures (accounts, item, sync, investments, liabs) | `test/fixtures/`              |
| Shared conformance suite, wrapped for vitest                       | `test/conformance.test.ts`    |
| Request pins asserted on outgoing bodies                           | `test/pins.test.ts`           |
| Every error-map row                                                | `test/errors.test.ts`         |
| Sign inversion, pending→posted, paging, lifecycle                  | `test/connector.test.ts`      |
| Field map, row by row                                              | `test/map.test.ts`            |
| No-token-in-logs, with a scanner proven able to fail               | `test/log-hygiene.test.ts`    |
| Live Sandbox smoke, gated and self-cleaning                        | `test/sandbox.test.ts`        |

**213 tests, 212 passing, 1 skipped** (the live Sandbox smoke, with no
credentials present — see §7a for the run where it wasn't). 5,427 lines across
`src/` and `test/`.

---

## 1. Request pins

Every pin is a decision that is invisible at runtime and expensive to get wrong.
All are asserted against the request body the fake **recorded**, not against the
source line that built it (`test/pins.test.ts`).

| Pin                                             | Value                                          | Why it is pinned                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plaid-Version` header                          | `2020-09-14`, on every request                 | 01 §1.9: "if the header is omitted, the Dashboard-configured default applies". A response _shape_ that depends on a browser checkbox is not a contract.                |
| `products` (link)                               | `['transactions','investments','liabilities']` | D16 exactly. **Not** Auth (exists to move money by ACH; we never do), **not** Identity (verifies an owner who, single-user, is the user). Both add friction and a fee. |
| `transactions.days_requested` (link)            | `730`                                          | Plaid's default is 90. This fixes the window **for the life of the Item** (01 §5.1); shipping 90 costs `/item/remove` + a re-link — and on Trial, a slot, forever.     |
| `redirect_uri` (link)                           | from `PUBLIC_HOST`, **key omitted** when null  | D12. Empty string is a hard `INVALID_FIELD`, so "no redirect" must be absence, not `''`.                                                                               |
| `webhook` (link)                                | **absent** unless configured                   | D12: polling is the ingestion path. Registering a URL we do not serve makes Plaid retry into a black hole — and makes `supportsWebhooks` a lie.                        |
| `products` (**update mode**)                    | **absent**                                     | 01 §1.7: "Do not populate `products` during standard update mode." A `products` array re-initialises the Item's product set and can re-bill it.                        |
| `update.account_selection_enabled`              | **absent** unless asked                        | 01 §1.7 warns "any de-selected accounts will no longer be shared with you". A routine reauth must not be able to silently drop an account.                             |
| `count` (`/transactions/sync`)                  | `min(pageSize, 500)`, floor 1                  | 500 is Plaid's ceiling (01 §5.1).                                                                                                                                      |
| `options.personal_finance_category_version`     | `v2`                                           | 01 §5.4. Pinned even though a post-2025 account defaults to v2, so the taxonomy WP 1.4's classifier was built against cannot change under us silently.                 |
| `options.include_original_description`          | `true`                                         | The raw institution descriptor is what a CSV/OFX export of the same account contains, and therefore what the cross-provider fingerprint keys on.                       |
| `options.days_requested` (`/transactions/sync`) | `min(historyDays, 730)`, floor 1               | Belt and braces. No effect on an Item linked with `transactions` in `products`; an Item linked otherwise would silently get 90 days.                                   |
| `cursor` on the first call                      | **key omitted**, not `null`                    | Plaid's contract is "if omitted, the entire history of updates will be returned". `cursor: null` is a different request.                                               |
| `/investments/transactions/get` window          | `[today − 730, today]`, UTC, `count 500`       | 01 §5.5: there is no `/investments/transactions/sync`. Offset-paged, because the endpoint caps a response at 500 and truncation is silent.                             |
| `PLAID_ENVIRONMENTS`                            | `sandbox`, `production` only                   | 01 §1.2: "Development" no longer exists. A third value throws.                                                                                                         |

---

## 2. Field map

Plaid shape → canonical fact. Every row is asserted in `test/map.test.ts`
against a recorded fixture.

### Accounts (`/accounts/get` → `ProviderAccountFact`)

| Plaid                                                    | Canonical               | Note                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account_id`                                             | `providerAccountId`     |                                                                                                                                                                                                                                      |
| `name` / `official_name`                                 | `name` / `officialName` |                                                                                                                                                                                                                                      |
| `type` + `subtype`                                       | `type`                  | `brokerage`→`investment` (legacy spelling Plaid still returns); `other`→`depository` (cash-management/prepaid); `investment` + subtype `crypto exchange`→`crypto`. An unknown type raises `MALFORMED_RESPONSE` rather than guessing. |
| `balances.iso_currency_code ?? unofficial_currency_code` | `currency`              | A code the kernel cannot scale raises rather than coercing: wrong number beats missing number.                                                                                                                                       |
| `mask`                                                   | `mask`                  | Already 2–4 digits. We do not request Auth, so Plaid never offers more.                                                                                                                                                              |
| —                                                        | `closed: false`         | `/accounts/get` cannot express closure — a closed account stops being _returned_. `linkAccounts` notices; claiming would be a guess.                                                                                                 |
| derived from `type`                                      | `capabilities`          | Per-**account**, not per-connector (08 §2.5).                                                                                                                                                                                        |

### Balances (`/accounts/balance/get` → `ProviderBalanceFact`)

| Plaid                            | Canonical   | Note                                                                                                                                    |
| -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `balances.current`               | `current`   | **Signed as a net-worth contribution**: `credit` and `loan` are negated. A card you owe \$420 on reports `-42000n`.                     |
| `balances.available`             | `available` | **Magnitude.** A card's `available` is available _credit_; inverting it would produce a number that looks like money and means nothing. |
| `balances.limit`                 | `limit`     | Magnitude, per the port.                                                                                                                |
| `balances.last_updated_datetime` | `asOf`      | Falls back to the run clock when the institution states none.                                                                           |
| `current === null`               | —           | Raises `MALFORMED_RESPONSE`. Zero is a balance; null is "not stated"; inventing a zero puts a fabricated number in the ledger.          |

### Transactions (`/transactions/sync` → `ProviderTransactionFact`)

| Plaid                                           | Canonical                       | Note                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `amount`                                        | `amount`                        | **Sign inverted.** 01 §5.3 / 08 §2.5: Plaid positive = outflow; we are negative = outflow, and "that inversion lives in the Plaid adapter and nowhere else". One function, `signedAmountOf`.           |
| `pending_transaction_id`                        | `pendingTransactionId`          | Verbatim, never inferred. 01 §5.2: when a pending row posts, Plaid puts the old id in `removed[]` and the new row in `added[]` pointing back. D10's "one transaction, not two" rests entirely on this. |
| `date` / `authorized_date`                      | `postedDate` / `authorizedDate` | `DateOnly`, no timezone anywhere near it.                                                                                                                                                              |
| `datetime` / `authorized_datetime`              | `postedAt` / `authorizedAt`     | Rejected rather than silently `Invalid Date`.                                                                                                                                                          |
| `name`, `merchant_name`, `original_description` | same                            |                                                                                                                                                                                                        |
| `payment_channel`, `pending`, `location`        | same                            |                                                                                                                                                                                                        |
| `personal_finance_category{,_version}`          | `providerCategory`              | A **hint**, never a category id (08 §2.5 / 01 §5.4). Stored as a source field and fed to the classifier as a feature, so a future PFC revision cannot shift budget history.                            |
| `counterparties[]`                              | `counterparties`                | `entity_id` is the useful part — stable across descriptor noise and across providers. Empty list → `null`.                                                                                             |
| the whole object                                | `raw`                           | Verbatim, so a Phase 3 question has a Phase 1 answer. A Plaid transaction object carries no credential, and `log-hygiene.test.ts` proves it rather than asserting it.                                  |
| `original_description ?? name`                  | `fingerprint` input             | See below.                                                                                                                                                                                             |
| `removed[]`                                     | `removed[]`                     | Ids only, plus `account_id` to route the removal (01 §5.1: "IDs only, not objects").                                                                                                                   |
| `accounts[]`                                    | `accounts`                      | Passed through on **every** page, not just the first: an institution can add an account mid-backfill, and a page naming an unmapped account is a hard `MALFORMED_RESPONSE` in the orchestrator.        |
| `next_cursor`                                   | `nextCursor`                    | Verbatim. No wrapping, no encoding, no composite.                                                                                                                                                      |

**The fingerprint keys on `original_description`, not on `name`.**
`fingerprintOf` is the cross-provider dedupe key — "the dedupe key when a CSV
import overlaps a Plaid backfill" (08 §2.5) — and what a CSV or OFX export of
the same account contains is the institution's raw descriptor
(`SQ *BLUE BOTTLE 4471 OAKLAND CA`), not Plaid's cleaned `name`
(`SQ *BLUE BOTTLE 4471`). **Known cost:** `original_description` is not filled
by every institution, so a row whose fill flips between syncs gets a new
fingerprint. That degrades cross-provider matching for that row; it cannot
duplicate or lose it, because same-provider identity is
`providerTransactionId` plus the ledger's natural key, not the fingerprint.

### Holdings, investment transactions, liabilities

| Plaid                                                 | Canonical                            | Note                                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Holding.quantity`, `institution_value`, `cost_basis` | `quantity`, `value`, `costBasis`     | `cost_basis` carried as reported; 01 §5.5 notes fill rates vary and it is often _total_ rather than per-share.                                                             |
| `institution_price_datetime` → `_as_of` → run clock   | `asOf`                               | All three branches are reachable in the wild and all three are fixtures.                                                                                                   |
| `Security.ticker_symbol`                              | `symbol`                             | `null` rather than invented when the security has no ticker.                                                                                                               |
| `InvestmentTransaction.amount`                        | `amount`                             | Sign inverted, like every other money value.                                                                                                                               |
| `InvestmentTransaction.quantity` / `price`            | `quantity` / `price`                 | Decimal **strings**, in Plaid's sign: a sale of two shares is `-2`, and inverting it would say the position grew.                                                          |
| `CreditCardLiability.aprs[]`                          | `apr`                                | The **purchase** APR, or the first listed. The fixture deliberately lists `balance_transfer_apr` (0 %) first, so `aprs[0]` would be wrong. Every rate survives in `raw`.   |
| `last_statement_balance`, `minimum_payment_amount`    | `statementBalance`, `minimumPayment` | **Positive magnitudes.** `ProviderBalanceFact.current` carries the net-worth sign; mixing conventions inside one fact is how a payoff projection adds a debt to net worth. |
| `MortgageLiability`                                   | `statementBalance: null`             | Plaid has no statement balance for a mortgage; the outstanding principal is the account balance and arrives via `syncBalances`.                                            |
| a liability with `account_id: null`                   | **dropped**                          | The orchestrator keys every fact by provider account. The drop is visible — that account still syncs its balance.                                                          |

### Two scalar conversions, and a bug this work package found

`amount.ts` turns a Plaid JSON number into `Money`. `Money.parseAmount` refuses
extra decimal places because "rounding money is always a deliberate act"; a
provider float is exactly the case where the act has to be _performed_, so it
happens here in one named function, with the pre-rounded value preserved in
`raw`. Recorded behaviour: `1.005` in source is the double
`1.00499999999999989`, so `toFixed(2)` answers `'1.00'`. That is the only
self-consistent reading of a value that arrived as a JSON number, and `toFixed`
is specified tightly enough to be the same answer on every engine. It is pinned
by a test so it is a decision rather than a surprise.

**Bug found and fixed:** `decimalStringOf` (quantities, prices, APRs) used
`value.toFixed(QUANTITY_SCALE)`. `(268.4).toFixed(18)` is
`'268.399999999999977263'` — the exact value of the double, faithfully printed
to eighteen places. Padding every quantity out to the column's full scale
therefore **manufactured seventeen digits of garbage** from a price the
institution stated as `268.4`, and those digits would have landed in
`NUMERIC(38,18)` and in every derived cost-basis figure. It now prefers
`String(value)` (the shortest decimal that round-trips to the same double) and
falls back to `toFixed(scale)` only for exponential notation — `String(1e-7)`
is `'1e-7'`, which is not a NUMERIC literal — and for a value with more decimal
places than the column can hold. Regression tests:
`map.test.ts > decimalStringOf > never manufactures float noise…` and
`> clamps a value with more decimal places than the column can hold`.

---

## 3. Error map

`src/errors.ts` is a **table**, not a `switch`, so it is enumerable — and
`test/errors.test.ts` iterates `PLAID_CONDITION_BY_CODE` and
`PLAID_CONDITION_BY_TYPE` rather than sampling them. The expected values live in
a second table in the test, spelled out independently, so changing one requires
deliberately changing the other. **All 36 code rows and all 10 type rows are
asserted.** A row added without a decision about its kind fails the
"same codes" test rather than shipping.

### By `error_code` (consulted first — the code is the specific statement)

| Plaid `error_code`                                                                                                                                               | Condition                    | Kind                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- |
| `ITEM_LOGIN_REQUIRED`, `USER_SETUP_REQUIRED`                                                                                                                     | `AUTH_REQUIRED`              | `auth_required`                        |
| `MFA_NOT_SUPPORTED`                                                                                                                                              | `MFA_REQUIRED`               | `auth_required`                        |
| `PENDING_EXPIRATION`, `PENDING_DISCONNECT`, `ACCESS_NOT_GRANTED`, `ADDITIONAL_CONSENT_REQUIRED`, `USER_PERMISSION_REVOKED`, `USER_ACCOUNT_REVOKED`               | `CONSENT_EXPIRED`            | `auth_required`                        |
| `RATE_LIMIT_EXCEEDED`                                                                                                                                            | `RATE_LIMITED`               | `rate_limited`                         |
| `ITEM_LOCKED`                                                                                                                                                    | `ITEM_LOCKED`                | `provider_unavailable`                 |
| `INSTITUTION_DOWN`, `INSTITUTION_NOT_RESPONDING`, `INSTITUTION_NOT_AVAILABLE`, `INTERNAL_SERVER_ERROR`, `PLANNED_MAINTENANCE`                                    | `PROVIDER_DOWN`              | `provider_unavailable`                 |
| `PRODUCT_NOT_READY`                                                                                                                                              | _(none)_                     | `transient`                            |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`                                                                                                                   | `MUTATION_DURING_PAGINATION` | `transient`, **`restart: 'page_one'`** |
| `INVALID_ACCESS_TOKEN`, `ITEM_NOT_FOUND`, `ITEM_NOT_SUPPORTED`, `INSTITUTION_NO_LONGER_SUPPORTED`                                                                | _(none)_                     | `permanent`                            |
| `PRODUCTS_NOT_SUPPORTED`, `PRODUCT_NOT_ENABLED`, `NO_ACCOUNTS`, `NO_INVESTMENT_ACCOUNTS`, `NO_LIABILITY_ACCOUNTS`                                                | `INSUFFICIENT_SCOPE`         | `permanent`                            |
| `INVALID_API_KEYS`, `INVALID_CLIENT_ID`, `UNAUTHORIZED_ENVIRONMENT`, `INVALID_PUBLIC_TOKEN`, `INVALID_FIELD`, `INVALID_BODY`, `MISSING_FIELDS`, `UNKNOWN_FIELDS` | `CONFIG_ERROR`               | `invalid_input`                        |

### By `error_type`, for a code the table has never seen

`ITEM_ERROR`→`AUTH_REQUIRED`; `INSTITUTION_ERROR`, `API_ERROR`→`PROVIDER_DOWN`;
`RATE_LIMIT_EXCEEDED`→`RATE_LIMITED`; `OAUTH_ERROR`, `RECAPTCHA_ERROR`→`AUTH_REQUIRED`;
`INVALID_REQUEST`, `INVALID_INPUT`, `SANDBOX_ERROR`→`CONFIG_ERROR`;
`INVALID_RESULT`→`MALFORMED_RESPONSE`. Plaid adds codes continuously; a new
`INSTITUTION_ERROR` code should back off and retry, not stop a healthy
connection. Neither table matching falls through to `INTERNAL`/`permanent`.

### The three rows whose recovery is special

- **`MUTATION_DURING_PAGINATION` → `restart: 'page_one'`.** 01 §5.1: "the entire
  pagination request loop must be restarted beginning with the cursor for the
  first page". Retrying the single failed call splices two inconsistent
  snapshots together. Asserted end-to-end: the fake fails page two once, and the
  adapter's caller reaches the end by restarting from the run's first cursor.
- **`RATE_LIMITED` carries the provider's `Retry-After`**, in ms, when one was
  sent — seconds form only; the HTTP-date form is legal but Plaid does not send
  it, and parsing a date here would need a `Clock` this function has no business
  holding. Unparseable → `null`, and the orchestrator uses its own jittered
  backoff, which is the safe direction.
- **`AUTH_REQUIRED` is `retryable: false`.** 04 §4.5: every further call is
  guaranteed to fail and burns the rate limit the _reconnect_ will need.

### Three rows carry a kind and no condition, deliberately

An access token that is simply invalid (not "re-authenticate" — the token is
_wrong_), a product that is not ready yet, and an institution Plaid has dropped
have no honest home among the port's twelve conditions. Inventing one would put
a wrong word in the sync-run detail UI; claiming `INTERNAL` would say Plaid
broke its own contract. Those rows carry the kind only, and the verbatim Plaid
code travels in `providerCode` — which is exactly what the orchestrator writes
to `sync_runs.error_code` when `condition` is null. The test asserts
`providerCode !== null` on every such row.

### Transport failures are `PROVIDER_DOWN`, not `permanent`

A deliberate departure from `asConnectorError`'s "unrecognised is permanent":
here we _know_ it is a network call to someone else's service, and classifying
an unplugged cable as permanent would disable a healthy connection. The message
is reduced to the error's class name so an axios message containing a URL,
header dump or body cannot travel with it.

---

## 4. No token in logs — and the control is sabotage-tested

Plaid access tokens **do not expire** (01 §1.10). A leaked bearer token with a
lifetime is an incident with a clock on it; this one is an incident until
somebody notices and calls `/item/remove`.

Three mechanisms, each with a test that can fail:

1. **The adapter never holds the token.** Not on `this`, not in a module cache,
   not in a closure that outlives one call. Every method reads
   `handle.secret(PLAID_ACCESS_TOKEN)` and drops it on return. `connect` hands it
   back once so `@ctx/connections` can seal it — asserted, and asserted that a
   second tokenless handle then fails rather than reusing something squirrelled
   away during linking.
2. **`errors.ts` never attaches the axios error as a `cause`.** An axios error
   carries `config.data` (the request body — `access_token` on every call after
   linking) and `config.headers` (`PLAID-SECRET`). `new Error(msg, {cause})`
   keeps that object alive, and `sync_runs.last_error`, a pino serialiser, a
   `util.inspect` in a debugger and an unhandled-rejection dump all walk it. The
   classifier reads four fields into `redactedContext` and lets the object go.
3. **`FakePlaidApi` throws a loaded gun.** `plaidAxiosError` builds errors with
   `config.data` set to the _real_ request body and `config.headers` carrying a
   stand-in `PLAID-SECRET`, exactly as axios does — so the trap is armed on every
   failure path rather than described in a comment.

`test/log-hygiene.test.ts` scans every artefact through
`util.inspect(…, {depth: null, showHidden: true, getters: true})` **and**
`JSON.stringify`, plus every own property and the whole `cause` chain of thrown
errors: log lines and their context objects, thrown `ConnectorError`s, the
`ConnectionHandle`, and every fact including its `raw` payload.

**The scanner is itself tested.** Seven `it.each` rows plant each of four
secrets in a log context field, a nested request body, an error message, a
one-level and a two-level `cause` chain, a non-enumerable property and a getter,
and assert the scanner finds every one. A hygiene test that cannot fail is worse
than no hygiene test, because it reads like evidence.

**Sabotage run (2026-09-14).** Attaching the axios error as a `cause` in
`asPlaidConnectorError`:

```
× survives a broken Item on every call
× survives a rate limit on every call
× survives an institution outage on every call
× survives a product that was never linked on every call
× survives a Plaid-side fault on every call
× never attaches the axios error, whose config.data is the request body
AssertionError: a thrown ConnectorError leaked a credential: expected [ …(2) ] to deeply equal []
Tests  6 failed | 14 passed (20)
```

The sabotage was reverted; `prettier --check` and the full suite are green at
HEAD of this work.

Also asserted: the success log line carries exactly
`{provider, endpoint, requestId}` and the failure line exactly
`{provider, endpoint, kind, condition, providerCode}` — never the request body,
never the response object, never the error.

---

## 5. Conformance results

`test/conformance.test.ts` wraps `connectorConformanceChecks` from
`@connector/port` as a vitest `describe`. It does **not** import
`describeConnectorConformance` from `@ctx/connections`, because
`personalfi/layer-imports` denies `packages/connectors/*` → `@ctx/*` — which is
exactly why `conformance.ts` was written runner-agnostic. The wrapper is eleven
lines, as its own comment predicted.

**12 of 12 green**, first run, no adapter changes required:

| Check                                                           | Result | What the fake made non-vacuous                                                                  |
| --------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `capabilities/declared datasets work and undeclared ones throw` | pass   | All eight declared capabilities are implemented; `webhooks` is declared only when a URL is set. |
| `sync/idempotent`                                               | pass   | Cursors resolve to pages by lookup, so replaying one returns the identical page.                |
| `cursor/monotonic and never null mid-stream`                    | pass   | Three distinct cursors across three pages.                                                      |
| `sync/terminates and the terminal page repeats its cursor`      | pass   | Past the end the fake returns an empty update with the cursor **unchanged**, as Plaid does.     |
| `sync/resumable`                                                | pass   | Stopping at page two and resuming lands on the same terminal cursor with no ids lost.           |
| `removed/never reappears in the same stream`                    | pass   | The pending coffee row is added on page 1 and removed on page 2.                                |
| `money/every amount carries a currency and the sign holds`      | pass   |                                                                                                 |
| `fingerprint/present on every transaction`                      | pass   |                                                                                                 |
| `pending/a settled transaction links back to the pending one`   | pass   | `txn-0003-posted-coffee` → `txn-0001-pending-coffee`, which was genuinely `pending: true`.      |
| `errors/every failure is a typed ConnectorError`                | pass   | A cursor nobody issued is `INVALID_FIELD`; `provokeFailure` is a real `ITEM_LOGIN_REQUIRED`.    |
| `secrets/a serialised handle contains no credential`            | pass   | The subject handle genuinely holds `ACCESS_TOKEN`, so the check has something to find.          |
| `disconnect/revokes: a disconnected connection refuses to sync` | pass   | A second, throwaway Item, so the shared subject survives.                                       |

### What `FakePlaidApi` models

- **The cursor chain**, by lookup rather than by counter, so a replay is exact.
- **Mutation during pagination** — one scripted page index raises
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` _once_ and then succeeds, which
  is the real condition's shape.
- **An Item that is broken, rate limited, or gone** (`failWith`), including
  `Retry-After` headers.
- **A removal that fails at Plaid but not at the bank** (`failRemoveWith`) —
  added during this work, because `/item/remove` revokes a token at Plaid and
  never touches the institution, so `INSTITUTION_DOWN` must _not_ fail it while
  `INTERNAL_SERVER_ERROR` must.
- **Real offset/count paging** for `/investments/transactions/get`, so a missing
  `offset` is a failure rather than an untested branch.
- **Axios-shaped errors carrying secrets**, per §4.

### Test counts

| File                       | Tests                      |
| -------------------------- | -------------------------- |
| `test/errors.test.ts`      | 76                         |
| `test/map.test.ts`         | 53                         |
| `test/connector.test.ts`   | 37                         |
| `test/log-hygiene.test.ts` | 20                         |
| `test/conformance.test.ts` | 12                         |
| `test/pins.test.ts`        | 12                         |
| `test/sandbox.test.ts`     | 2 + 1 skipped              |
| **Total**                  | **212 passing, 1 skipped** |

`connector.test.ts` gained four tests (33 → 37) for the
`transactions_update_status` behaviour §7a's live run confirmed: see "a page
that arrives before the historical extract has finished" in that file.

---

## 6. Shared-file entries

### `vitest.config.ts` — already present at HEAD `1516394`

```ts
{
  root: './packages/connectors/plaid',
  test: {
    name: 'connector-plaid',
    include: ['src/**/*.test.ts', 'test/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
},
```

No change was needed. (`src/**/*.test.ts` currently matches nothing; every suite
lives in `test/`, because all of them need a fixture on disk.)

### `scripts/eslint-boundaries.js` — one layer added, one line removed

At HEAD, `plaid` was on the **generic** `connectors` allow-list. Because the
layer policy is keyed by path prefix rather than by package, that let _every_
adapter import `plaid` — and a SimpleFIN or Akahu adapter reaching for Plaid's
client is not a tidiness concern: it is how "swap the aggregator" (D16's whole
reason for the port) quietly stops being a config change, because the
replacement grows a dependency on the thing it was meant to replace.

A `connector-plaid` layer now sits **before** the generic `connectors` entry
(`layerFor` takes the first matching prefix) with the generic connector set plus
`plaid`, and `plaid` was removed from the generic entry.

**Sabotage-tested.** A probe file importing `plaid`:

```
packages/connectors/csv/src/__boundary_probe.ts
  2:34  error  @connector/csv may not import 'plaid'. …  personalfi/layer-imports
✖ 1 problem

packages/connectors/plaid/src/__boundary_probe.ts
(no output — allowed)
```

Both probes were deleted after the run.

### No `eslint-disable` anywhere in the package

`grep -rn "eslint-disable" packages/connectors/plaid/` returns nothing. The
`test/` directory exemption in `eslint-boundaries.js` and `eslint.config.js`
(which grants `vitest`, `node:` builtins, `process.env` and `new Date()`) is
what `test/harness.ts` and `test/sandbox.test.ts` rely on, and it is declared in
the rule rather than suppressed at each site.

### `pnpm-workspace.yaml`

No change needed: `packages/connectors/*` already covers it.

---

## 7. Live Sandbox runbook — for Chris

This is the only test that checks Plaid _agrees_. The hermetic suite proves the
adapter is self-consistent; recorded fixtures are a snapshot of a belief.

### What you need

A Plaid account with **Sandbox** keys — free, no card, no review. Dashboard →
Developers → Keys. You want `client_id` and the **Sandbox** secret. You do
**not** need Production keys for this, and you should not use them: D16 —
Production has a hard ten-Item cap and `/item/remove` **does not free a slot**.
The test refuses to run against anything but Sandbox and throws at module load
if `PLAID_ENV` says otherwise.

### Run it

Credentials are read from files under `SECRETS_DIR` (`secrets/` in this repo),
mode `0400`, never typed on the command line and never committed — the same
convention `docs/CONVENTIONS.md` §Configuration requires for every other
secret. Create the three files once:

```bash
install -m 0400 /dev/stdin secrets/plaid_client_id <<<'<your client id>'
install -m 0400 /dev/stdin secrets/plaid_secret    <<<'<your sandbox secret>'
install -m 0400 /dev/stdin secrets/plaid_env       <<<'sandbox'
```

Then run the smoke test by reading them straight into the single test process,
without ever echoing them to a terminal or a log:

```bash
export PATH=$HOME/.local/bin:$PATH
cd /home/chris/Projects/PersonalFi

env PLAID_CLIENT_ID="$(cat secrets/plaid_client_id)" \
    PLAID_SECRET="$(cat secrets/plaid_secret)" \
    PLAID_ENV="$(cat secrets/plaid_env)" \
  pnpm vitest run --project connector-plaid test/sandbox.test.ts
```

Do not put the keys in a file tracked by git, and do not paste them into a
chat transcript, an agent prompt, or a commit message — see §7a below for what
happened the one time that rule was broken. When `packages/config` grows the
schema in §8, the same three values move from ad hoc files to the validated
`PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` config keys, still sourced
from `SECRETS_DIR`.

### What it does, in order

1. `/sandbox/public_token/create` against `ins_109508` (Plaid's test bank) with
   `initial_products` = the three D16 products and
   `options.transactions.days_requested = 730`. This skips the Link UI, which is
   what makes it runnable headlessly.
2. `connect()` — exchange, `/item/get`, `/accounts/get`. Asserts an item id,
   at least one account, and that the access token came back exactly once.
3. `createLinkToken()` — a real `link-sandbox-…` with the §1 pins on the wire.
4. `/transactions/sync` to exhaustion, retrying `PRODUCT_NOT_READY` every 3 s
   for up to 20 attempts (Plaid is still running the first extract for a moment
   after linking; retrying is the documented fix). Asserts pages > 0 and
   transactions > 0.
5. `listAccounts`, `syncBalances`, `health` — proves the shapes `map.ts` decoded
   really are the shapes Plaid sent.
6. **`/sandbox/item/reset_login`**, then a sync — provokes a _real_
   `ITEM_LOGIN_REQUIRED` and asserts it classifies as
   `auth_required` / `AUTH_REQUIRED`, and that `health().reachable` goes false.
   This is the single most important classification in the adapter.
7. `createUpdateLinkToken()` — proves Plaid accepts a link token with
   `access_token` and **no** `products` (01 §1.7), which is the reconnect flow
   WP 1.6's UI will drive.
8. `disconnect()` → `/item/remove`, then asserts the Item refuses to sync.
9. Asserts no log line contains the public token, the secret or the client id.

An `afterAll` removes the Item even when the body fails, so a crashed run does
not leave one behind.

### When it is skipped

With no credentials the suite prints, once:

```
  [connector-plaid] live Sandbox smoke SKIPPED: PLAID_CLIENT_ID / PLAID_SECRET are unset.
  This is expected — no Plaid credentials exist on this machine and none belong in CI.
  The hermetic suite (conformance, pins, error map, log hygiene) covers everything it can
  without a network; this test is the only one that checks Plaid agrees.
  To run it, see docs/evidence/phase-1/wp1.3-plaid.md §7 (Sandbox runbook).
```

A separate, always-running test asserts the gate is honest, so a green CI run
cannot quietly stop meaning what it says.

### The one thing code cannot check

For **Production** OAuth institutions, the `redirect_uri` must also be
registered under **Allowed redirect URIs** in the Plaid Dashboard (01 §1.7,
D12). Nothing in this repo can verify that, which is why it is written here.

---

## 7a. Live Sandbox run (2026-09-15)

**Outcome: PASS.** `test/sandbox.test.ts` ran against real Plaid Sandbox for
the first time, closing the largest open risk this work package carried (§9,
"Live Sandbox smoke has never been run"). Credentials came from
`secrets/plaid_client_id`, `secrets/plaid_secret`, `secrets/plaid_env` (mode
`0400`, gitignored) per the updated §7 runbook; no secret value was echoed,
logged, or written anywhere by this run.

```
env PLAID_CLIENT_ID="$(cat secrets/plaid_client_id)" \
    PLAID_SECRET="$(cat secrets/plaid_secret)" \
    PLAID_ENV="$(cat secrets/plaid_env)" \
  pnpm vitest run --project connector-plaid test/sandbox.test.ts
```

Result: **1 file, 3 tests passed**, 26.04 s. (Without credentials the same
file runs 2 passing + 1 skipped — see §5's test-count table — because the
`describe.skipIf(!configured)` block that does the real linking becomes live.)
The log was grepped for the client id and the secret before this document was
written; neither appears in it, matching the test's own in-band assertion that
the recording logger never captured them.

### What it found

A freshly linked Sandbox Item's `/transactions/sync` does **not** raise
`PRODUCT_NOT_READY` while Plaid's historical extract is still running, which
is what `01`'s error-map narrative assumed and `test/errors.test.ts` had only
ever exercised as a thrown error. Instead it answers `200` with an empty page
(`added`/`modified`/`removed: []`, `has_more: false`) and
`transactions_update_status: 'NOT_READY'`, then `'INITIAL_UPDATE_COMPLETE'`
(still possibly empty), before finally `'HISTORICAL_UPDATE_COMPLETE'` once real
rows exist. A caller's retry loop that only watches for a thrown
`PRODUCT_NOT_READY` would read the empty `NOT_READY`/`INITIAL_UPDATE_COMPLETE`
page as "this Item is done and has no transactions" and never come back for
the real ones.

This was fixed in the same change that discovered it (snapshot commit
`05f254b`, already on `main` at the time this closeout ran):

- `PLAID_HISTORICAL_UPDATE_COMPLETE` (`src/provider.ts`) names the one status
  value that means "actually finished."
- `syncTransactions` (`src/connector.ts`) now classifies an empty,
  non-`has_more` page whose status is anything **other** than
  `HISTORICAL_UPDATE_COMPLETE` as the same `PRODUCT_NOT_READY` / `transient`
  condition the error map already carries, so every existing retry loop —
  including this test's own 3 s/20-attempt loop and the future orchestrator's
  — needs no new code path. A genuinely empty, finished account (steady state
  after backfill) still returns normally instead of retrying forever, because
  `HISTORICAL_UPDATE_COMPLETE` is excluded from the rule.
- Four hermetic tests in `test/connector.test.ts` ("a page that arrives before
  the historical extract has finished") pin this against `NOT_READY`,
  `INITIAL_UPDATE_COMPLETE` (empty and non-empty), and
  `HISTORICAL_UPDATE_COMPLETE`, using `FakePlaidApi`'s existing per-page
  `transactions_update_status` field — no fake changes were needed, since
  `FakePlaidApi.transactionsSync` already returns whatever
  `TransactionsSyncResponse` a scripted page specifies (`test/fake.ts`).

No further real-Plaid behaviour surfaced in this run that the hermetic suite
does not already model: `connect`, `createLinkToken`, the sync-to-exhaustion
loop, `listAccounts`, `syncBalances`, `health`, a real `sandbox/item/reset_login`
→ `ITEM_LOGIN_REQUIRED` → `auth_required`/`AUTH_REQUIRED` classification,
`createUpdateLinkToken`, and `disconnect` → a post-revoke sync rejection all
behaved exactly as `test/fixtures/` and `FakePlaidApi` already assumed.

### Step results (from the single 120 s test body)

| Step                                                  | Result                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sandbox/public_token/create` + `connect()`          | pass — item id, ≥1 account, access token returned exactly once                                                                                                  |
| `createLinkToken()`                                   | pass — real `link-sandbox-…` token, pins on the wire                                                                                                            |
| `/transactions/sync` to exhaustion                    | pass — pages > 0, transactions > 0 (retried through the not-ready statuses above without any caller-visible difference from a normal `PRODUCT_NOT_READY` retry) |
| `listAccounts`, `syncBalances`, `health`              | pass — decoded shapes matched what `map.ts` expects                                                                                                             |
| `sandbox/item/reset_login` → sync                     | pass — real `ITEM_LOGIN_REQUIRED` → `auth_required`/`AUTH_REQUIRED`; `health().reachable` false                                                                 |
| `createUpdateLinkToken()`                             | pass — real link token, no `products` in the request                                                                                                            |
| `disconnect()` → sync                                 | pass — rejects as a `ConnectorError`                                                                                                                            |
| No public token / secret / client id in logger output | pass                                                                                                                                                            |
| `afterAll` Item cleanup                               | ran; no orphaned Sandbox Item                                                                                                                                   |

Total wall time: 26.04 s, well inside the 120 s test timeout and the 110 s
sync deadline passed to `syncOptions`.

### Housekeeping

The Sandbox secret was pasted into a chat transcript during this work package
(see `docs/plan/01-execution-log.md`, 2026-09-14 23:24 entry). **Rotate the
Plaid Sandbox secret** (Dashboard → Developers → Keys → regenerate) and update
`secrets/plaid_secret` before relying on it again. Sandbox has no financial
blast radius, but a secret that has left the file it belongs in is not a
secret; treat this the same as any other credential exposure.

---

## 8. What the port and the config lacked

Reported rather than worked around.

1. **`packages/config` has no Plaid schema.** WP 1.3 does not own it, so
   `createPlaidApi` takes credentials as an argument and `PlaidConnector` takes
   a `PlaidLinkSettings` object. The lines wanted:

   ```ts
   PLAID_CLIENT_ID:   z.string().min(1).optional(),   // secret file
   PLAID_SECRET:      z.string().min(1).optional(),   // secret file
   PLAID_ENV:         z.enum(['sandbox', 'production']).default('sandbox'),
   PLAID_CLIENT_NAME: z.string().min(1).default('PersonalFi'),
   PLAID_COUNTRY_CODES: z.string().default('US'),     // comma-separated
   PLAID_LANGUAGE:    z.string().length(2).default('en'),
   // Derived from PUBLIC_HOST (D12); null disables OAuth institutions.
   PLAID_REDIRECT_URI: z.url().nullable().default(null),
   // D12: null by default. Non-null is what makes supportsWebhooks honest.
   PLAID_WEBHOOK_URL:  z.url().nullable().default(null),
   ```

   `PLAID_CLIENT_ID` / `PLAID_SECRET` must be read from `SECRETS_DIR`, never
   from a `.env` that reaches a log or a process listing.

2. **`Connector.health()` takes no `SyncOptions`, and therefore no `Clock`**,
   while `ConnectorHealth.checkedAt` is a timestamp and `docs/CONVENTIONS.md`
   bans `new Date()` outside a `Clock`. `PlaidConnector` holds a `Clock` on the
   constructor for this one method. The tidier fix is
   `health(handle, clock)` or a `HealthOptions`; it is a port change, so it is
   noted here rather than made.

3. **The port has no `ProviderInvestmentTransactionFact` and no method that
   returns one.** 01 §5.5: there is no `/investments/transactions/sync`, so
   these arrive by date window and are idempotent on
   `investment_transaction_id`. `PlaidInvestmentTransactionFact` is declared
   locally in `map.ts` and `syncInvestmentTransactions` is not a port method.
   Smuggling it through `ProviderTransactionFact` would lose the quantity, the
   price and the fees. A port addition is wanted before a second adapter grows
   its own copy.

4. **The port's twelve conditions have no home for three real Plaid
   conditions** — see §3. Candidate additions: `CREDENTIAL_INVALID` (a token
   that is wrong, as distinct from one that needs re-auth), `NOT_READY`, and
   `PROVIDER_DROPPED_INSTITUTION`.

5. **`describeConnectorConformance` lives in `@ctx/connections/test/`**, which
   no adapter package may import. `@connector/port` exports the runner-agnostic
   checks, so the cost is an eleven-line wrapper per adapter package — but the
   wrapper is now duplicated twice and will be duplicated once per adapter. It
   belongs beside `conformance.ts` in `@connector/port`, guarded so the `vitest`
   import stays dev-only.

6. **`ConnectorCapabilities` cannot express a per-endpoint rate limit.**
   `refreshBudgetPerDay` is a daily number; Plaid's tightest limit is
   `/accounts/balance/get` at **5/min and 30/hr per Item** (01 §1.8), which is
   what actually constrains a manual "refresh balances" button. The adapter
   documents it and declines to call it on transaction sync (asserted), but the
   orchestrator has no declared figure to rate-limit against.

---

## 9. Deferred

| Item                                                                                            | Why, and when                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Live Sandbox smoke has never been run~~                                                       | **Done, §7a (2026-09-15): PASS.** The empty-page/`NOT_READY` behaviour it found is fixed and covered by four hermetic tests; nothing else diverged from the recorded fixtures.                                                                                                                                    |
| Webhooks (`TRANSACTIONS_REMOVED`, `ITEM_ERROR`, `NEW_ACCOUNTS_AVAILABLE`, `PENDING_DISCONNECT`) | D12: polling is the default; webhooks are an optional compose profile. `PlaidConnector.classifyItemError` already exists for the out-of-band path, so the receiver is the missing half.                                                                                                                           |
| Webhook signature verification (JWT, `/webhook_verification_key/get`)                           | Follows the webhook receiver. Must land in the same change, not after it.                                                                                                                                                                                                                                         |
| `/accounts/balance/get` rate limiting (5/min, 30/hr per Item)                                   | Needs a port field — §8 item 6. Today the adapter simply does not call it on sync.                                                                                                                                                                                                                                |
| Cost-basis derivation from investment transactions                                              | 01 §5.5: `Holding.cost_basis` fill rates vary and are often _total_ rather than per-share. Phase 3 prefers deriving; Phase 1 carries what Plaid reports.                                                                                                                                                          |
| `is_investments_fallback_item` handling                                                         | Present on both investments responses; not yet read. Signals a degraded investments extract.                                                                                                                                                                                                                      |
| `LiabilitiesObject.loan` and `.line_of_credit`                                                  | Newer Plaid arrays, no fixture, no account type that would produce one in Sandbox. `credit`, `student` and `mortgage` are mapped and tested.                                                                                                                                                                      |
| Crypto (`subtype: crypto exchange`) beyond the type mapping                                     | Mapped to `crypto` and unit-tested, but no end-to-end fixture: Plaid Sandbox has no crypto institution.                                                                                                                                                                                                           |
| `transactions_update_status`, surfaced past the not-ready check                                 | §7a: now _read_, to classify an empty pre-backfill page as `PRODUCT_NOT_READY` instead of "done." Still not exposed to a caller or the UI as a distinct "backfill genuinely finished" signal — `HISTORICAL_UPDATE_COMPLETE` only suppresses the retry classification, it is not returned from `syncTransactions`. |
