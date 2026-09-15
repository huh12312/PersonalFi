<!-- SPDX-License-Identifier: MIT -->

# WP 1.3b — wiring `PlaidConnector` into `apps/api`

Scope: `packages/config` (the three Plaid secrets and their validation),
`apps/api/src/{domain,app,logging}.ts` (registration, feature-detection, the
boot log line), `apps/api/src/routes/{plaid,connections}.ts` (the three new
routes and the shared `linkConnection` helper they reuse), the regenerated
OpenAPI contract and web client, three lines of `apps/web` wiring, and the
test suites that prove all of it — including one run against real Plaid
Sandbox through the actual HTTP path.

Repo `/home/chris/Projects/PersonalFi`, branch `main`. Builds on WP 1.3
(`@connector/plaid`, proven against live Sandbox — `wp1.3-plaid.md`), WP 1.5
(the composition root and route table — `wp1.5-api.md`), and WP 1.6 (the UI
that has been waiting for this route since it shipped — `wp1.6-ui.md` §4).

---

## Summary

| Deliverable                                                                                              | Where                                                             |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `plaid_client_id` / `plaid_secret` / `plaid_env` as optional file secrets, `PLAID_ALLOW_PRODUCTION` gate | `packages/config/src/{schema,load}.ts`                            |
| `AppConfig.plaid: PlaidConfig \| null` — feature-detected                                                | `packages/config/src/load.ts`                                     |
| Registration, one info line, never a secret                                                              | `apps/api/src/domain.ts` (`createConnectorRegistry`)              |
| `POST /connections/plaid/link-token`                                                                     | `apps/api/src/routes/plaid.ts`                                    |
| `POST /connections/plaid/exchange` (custody + the D16 ratchet)                                           | `apps/api/src/routes/plaid.ts`                                    |
| `POST /connections/{id}/plaid/update-link-token`                                                         | `apps/api/src/routes/plaid.ts`                                    |
| `linkConnection`/`linkResultSchema` exported for reuse                                                   | `apps/api/src/routes/connections.ts`                              |
| `*.linkToken` added to the pino redaction paths                                                          | `apps/api/src/logging.ts`                                         |
| `FakePlaidApi`, exported for a consumer outside `@connector/plaid`                                       | `packages/connectors/plaid/{package.json,test/index.ts}`          |
| Route tests over the hermetic fake                                                                       | `apps/api/test/db/plaid-routes.test.ts` (10)                      |
| Live Sandbox smoke, through the real HTTP path, gated and self-cleaning                                  | `apps/api/test/db/plaid-sandbox.test.ts` (1, ran and passed — §5) |
| Config tests: feature-detect, partial config, `plaid_env`, D16 refusal                                   | `packages/config/src/load.test.ts` (13)                           |
| Registration wiring tests: feature-detect, no-secret-in-log                                              | `apps/api/test/domain.test.ts` (3)                                |
| Web wiring: `getLinkToken`/`getUpdateLinkToken` call the real endpoints                                  | `apps/web/src/{lib/plaid-link,features/connections/*}.ts`         |

**27 new tests, all passing** (13 config + 3 domain + 10 route + 1 live
Sandbox). The regenerated OpenAPI contract: **43 paths, 47 operations, 60
component schemas** (up from WP 1.5's 40/44/58).

---

## 1. Config: three optional file secrets, feature-detected

`packages/config/src/schema.ts`'s `SECRET_SPECS` gained `plaid_client_id`,
`plaid_secret`, `plaid_env` — file-only, **no `envFallback`**, the same
posture as `master_key` and for the same reason (01 §1.10: "you must never
publish, distribute, or share your … Client ID or Plaid API secret"). Six
non-secret env vars joined `environmentSchema`: `PLAID_CLIENT_NAME`,
`PLAID_COUNTRY_CODES`, `PLAID_LANGUAGE`, `PLAID_REDIRECT_URI`,
`PLAID_WEBHOOK_URL`, `PLAID_ALLOW_PRODUCTION`.

`load.ts`'s `resolvePlaid` (called from `loadConfig`, its problems folded into
the same one-shot report every other boot check uses) resolves the three
secrets into `AppConfig.plaid: PlaidConfig | null`:

- **Absent client id and secret → `null`, no problem.** This is the ordinary
  case for every deployment that has not configured Plaid, proven by
  `apps/api/test/domain.test.ts`'s "boots with no registry options at all"
  and by every other suite in the repo, which runs with no `plaid_*` secret
  files present and boots normally.
- **One present without the other → a problem naming which is missing.**
  Plaid cannot make a call with half a credential pair; catching that at boot
  beats discovering it the first time a user clicks "Connect a bank".
- **`plaid_env` validated against `sandbox | development | production`,
  exactly as asked, but `'development'` is refused by name** —
  `wp1.3-plaid.md` §1 already pins `PLAID_ENVIRONMENTS` to `sandbox` and
  `production` only ("'Development' no longer exists" as an API base path,
  01 §1.2), and `plaidBasePath` throws an unhelpful "unknown plaid
  environment" if a caller reaches it with anything else. Rejecting
  `'development'` here, by name, with a citation, turns a cryptic runtime
  throw three layers down into a clear boot-time refusal. Absent → defaults
  to `sandbox` (D16: sandbox-first).
- **`production` refused unless `PLAID_ALLOW_PRODUCTION=true` is also set**
  (D16: Trial plan, the hard ten-Item cap, `/item/remove` not freeing a
  slot). Two independent files/vars have to agree, so a single typo in
  `secrets/plaid_env` cannot silently flip a deployment into Production.
- **Country codes parsed and validated non-empty.**

All thirteen behaviours are `packages/config/src/load.test.ts`'s new `Plaid
(WP 1.3b — config)` block, including the two "never puts the client id or
secret in an error message / anywhere serialisable" tests that mirror the
existing `master_key`/`database_url` leak checks byte-for-byte.

```
pnpm exec vitest run --project config
# 2 files, 67 tests passed (54 existing + 13 new)
```

---

## 2. Registration: feature-detect, one info line, custody unchanged

`apps/api/src/domain.ts#createConnectorRegistry` gained a `plaid` option
(`AppConfig['plaid']`, i.e. `PlaidConfig | null`), a `clock`, and a `logger`.
`apps/api/src/app.ts` passes `config.plaid`, the app's own `clock`, and
`app.log` — the one call site, replacing the WP 1.5 hook comment
(`// registry.register({ connector: new PlaidConnector(...) ... })`) with the
real thing:

```ts
if (plaid === null) {
  logger?.info({ provider: PLAID_PROVIDER }, 'plaid not configured; connector not registered');
} else {
  const connector = new PlaidConnector({
    api: createPlaidApi({
      clientId: plaid.clientId.reveal(),
      secret: plaid.secret.reveal(),
      environment: plaid.environment,
    }),
    settings: { clientName: plaid.clientName, countryCodes: plaid.countryCodes, ... },
    clock: options.clock ?? systemClock,
  });
  registry.register({ connector, manifest: PLAID_MANIFEST });
  logger?.info({ provider: PLAID_PROVIDER, environment: plaid.environment }, 'plaid configured; connector registered');
}
```

`.reveal()` happens at exactly this one call site — the same pattern
`master_key` reaching `SecretBox.unlock()` uses — and the bytes go straight
into axios's default request headers (`client.ts`, unchanged from WP 1.3) and
are never stored, logged, or returned. `apps/api/test/domain.test.ts` proves
both branches log exactly one line, at `info`, and that neither the log lines
nor the whole `PlaidConfig` object (`JSON.stringify`) ever contain the
fixture client id or secret — `Redacted<T>`'s `toJSON`/`toString`/inspect
hooks (`packages/config/src/redacted.ts`) mean this is nearly impossible to
get wrong by accident, but the test is the evidence, not the belief.

**Custody is unchanged from WP 1.2/1.3.** `createConnection`
(`@ctx/connections`) still calls `connector.connect(input)`, still seals
whatever `credentials` comes back through `SecretBox.sealText` with an AAD
bound to the connection row, and still never holds it anywhere else —
nothing in this work package touches `packages/contexts/connections/src/connections.ts`.
What WP 1.3b adds is the first real caller reaching that path with Plaid
credentials instead of a manual/CSV adapter's `{}`. §4 below is the encrypted
custody proof against a live sealed row.

### Redaction

`apps/api/src/logging.ts`'s `REDACTED_PATHS` already covered `access_token`,
`public_token`, `client_secret`, `secret`, and the `PLAID-SECRET`/
`PLAID-CLIENT-ID` headers at every depth `censorDeep` walks (the primary
control) and at the enumerated `fast-redact` paths (the second layer,
WP 1.5's `apps/api/test/db/log-hygiene.test.ts` still exercises both). One
gap: the new routes' response field is `linkToken` (camelCase), and the
existing path list had `*.link_token` but no `*.linkToken` — every other
credential-shaped field name is listed in both cases
(`access_token`/`accessToken`, `public_token`/`publicToken`, …). Added
`'*.linkToken'`. `censorDeep`'s `SENSITIVE_KEYS` set already matches
case-insensitively, so the primary control was never the gap; this closes
the secondary one.

---

## 3. The three routes

`apps/api/src/routes/plaid.ts`, registered in `app.ts` alongside
`connectionRoutes`. All three sit beside `/connections/*`
(`tags: ['connections']`) rather than under a new tag, since they are the
same "provider seam" WP 1.5's route table already documents.

| Method | Path                                        | Auth        | What it does                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/connections/plaid/link-token`             | session     | `PlaidConnector.createLinkToken({ clientUserId: session.userId })` — the D16 pins (products, 730 days, PFC v2, the configured `redirect_uri`) are `PlaidConnector`'s own and already asserted by `packages/connectors/plaid/test/pins.test.ts`; this route just forwards the user id and shape the response. |
| POST   | `/connections/plaid/exchange`               | **step-up** | Exchanges the public token, creates (or re-links) the connection, schedules the first sync through the orchestrator, refuses an eleventh Plaid connection (D16). Returns `linkResultSchema` — the same shape `POST /connections` and `.../complete` return.                                                  |
| POST   | `/connections/{id}/plaid/update-link-token` | **step-up** | `PlaidConnector.createUpdateLinkToken(handle, ...)` — opens the connection's sealed credential (`openHandle`) to build the request. No `products` on the wire (01 §1.7). Refuses a connection whose provider isn't `plaid` (404).                                                                            |

### Why `link-token`/`update-link-token` need only a session, not step-up

Both routes only ever _read_: they ask Plaid to mint an ephemeral,
single-use token addressed to this user and this deployment. Nothing in this
application's data changes as a result of calling either — the actual
mutation (a stored credential, a new connection row) happens at `exchange`,
which does require step-up, for the same reason `POST /connections` already
does (D21: a stolen session cookie must not be enough to attach a new
institution). `update-link-token` is arguably borderline — it opens the
sealed credential to build the request — which is exactly why it is
step-up-gated even though it returns nothing derived from the plaintext
token; `reconnect`'s own step-up requirement was already precedent for
"touches the credential → needs a fresh assertion."

### Why `exchange` is a dedicated route rather than reusing generic `POST /connections`

`POST /connections` already links any registered provider, Plaid included,
once it is registered — nothing about `exchange` is functionally new. It
exists because `createLinkToken`/`createUpdateLinkToken` are not on the
`Connector` port (a provider-hosted flow needs a step _before_ `connect`'s
completion artifact, port comment in `connector.ts`) and so have no generic
route to live behind, and because a Plaid-shaped body
(`{ publicToken, institutionName? }`) is what `PlaidConnectCard`'s
`onSuccess` callback already produces — no generic `{ provider, input }`
envelope for the frontend to construct by hand. Internally, `exchange` calls
the exact same `linkConnection` helper `POST /connections` and
`.../complete` call (extracted from a route-local closure into an exported
function in `routes/connections.ts` for this purpose — same transaction
shape, same "createConnection and syncNow share one transaction" invariant,
same 409 on a link-artifact/connection-id mismatch), so there is one
implementation of "what does linking a provider actually do," not two that
can drift.

### The D16 ratchet

`exchange` counts every connection row with `provider = 'plaid'` for the
caller — **including a disconnected one**, because `DELETE /connections/{id}`
can leave `providerSlotMayRemain: true` (wp1.5-api.md §1: revocation at the
provider can fail while the local credential is still destroyed), so a
locally "gone" connection may still hold a Plaid Item slot. At ≥10, the
exchange refuses with `409 connections.plaid_item_limit` **before** calling
`connector.connect()` — no public token is spent on a refusal.
`plaid-routes.test.ts`'s ratchet test proves both halves: ten connections
succeed for a fresh user, the eleventh is refused, and
`item/public_token/exchange` was called exactly ten times against the fake,
not eleven.

---

## 4. Custody: encrypted, never plaintext (P0-1 pattern)

`plaid-routes.test.ts > exchanges a public token, creates the connection,
schedules the first sync, and stores the token encrypted — never as
plaintext (P0-1)` reads the raw `connections.sealed_credentials` column
exactly as `psql` would — the same pattern `packages/secretbox/test/secret-box.test.ts`'s
"leaves no plaintext in the column (P0-1 evidence)" test uses:

```ts
const result = await h.database.pool.query(
  `SELECT sealed_credentials FROM connections WHERE id = $1`,
  [body.connectionId],
);
const raw = Buffer.from(row.sealed_credentials);
expect(raw.toString('utf8')).not.toContain(accessToken);
expect(raw.toString('latin1')).not.toContain(accessToken);
for (let i = 0; i + 8 <= accessToken.length; i += 4) {
  expect(raw.toString('latin1')).not.toContain(accessToken.slice(i, i + 8));
}
```

— an 8-byte sliding window across the whole fake access token, not just a
whole-string check, so a cipher that leaked half the token would still fail
this. The HTTP response body is checked the same way. The access token used
(`access-plaid-exchange-DO-NOT-LEAK-9f2c4d7a1b6e`) is long and unmistakable
for the same reason WP 1.3's own harness tokens are — a short token risks a
false pass by coincidence.

This is an assertion against **real Postgres** (`describe.skipIf(NO_DATABASE)`,
`apps/api/test/helpers/api-harness.ts`'s `createApiHarness`), not a mock, and
against the real `SecretBox`/KEK plumbing WP 0.2 shipped — `createApiHarness`
derives a real (cheap-parameter, test-floor) KEK and calls
`security.initialise()` before any request is sent.

**Not sabotage-tested in this pass** — unlike WP 1.3's log-hygiene control,
which was proven able to fail by reverting a fix and watching six tests go
red (`wp1.3-plaid.md` §4), this custody test was not deliberately broken to
confirm it can catch a regression. It exercises the same `SecretBox`/
`createConnection` path WP 0.2's own sabotage-tested suite already covers,
so the mechanism is not new; what is new here is only that Plaid is now a
real caller of it.

---

## 5. Live Sandbox smoke — through `apps/api`, not just the connector

`packages/connectors/plaid/test/sandbox.test.ts` already proved
`PlaidConnector` agrees with real Plaid Sandbox (WP 1.3 §7/§7a). What that
test cannot prove is that the _wiring_ — config → `domain.ts` registration →
the new routes → the orchestrator — agrees too. `apps/api/test/db/plaid-sandbox.test.ts`
is the API-level equivalent: `describe.skipIf(NO_DATABASE || !configured)`,
same `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` gate, same refusal to run
against anything but Sandbox (D16).

### What it does

1. `api.sandboxPublicTokenCreate({ institution_id: 'ins_109508', initial_products: [...], options: { transactions: { days_requested: 730 } } })` — skips the Link UI, using the same widened `PlaidApiLike & PlaidSandboxApiLike` client `createPlaidApi` returns.
2. `POST /connections/plaid/exchange` over real HTTP (`app.inject`), with the real public token. Asserts `201`, at least one account id, a non-null `syncJobId`, and that the response body does not contain the substring `'access-'` (Plaid Sandbox access tokens are `access-sandbox-…`).
3. The exchange only **schedules** the backfill — Plaid is not process-local (`domain.ts`'s module comment), so nothing runs synchronously and nothing in this test runs the worker that would pick the job up. `apps/api/test/helpers/api-harness.ts`'s `ApiHarness` gained an `orchestrator` field (the exact `SyncOrchestrator` shape `domain.ts#createDomainRuntime` builds, over the harness's own registry and secret box) for exactly this: the test calls `orchestrator.syncConnection(...)` directly, retrying up to 20 times at a 3 s interval on anything but `'success'` — the same shape WP 1.3 §7a's retry loop uses, because a freshly linked Item's `/transactions/sync` can answer an empty, non-`has_more` page classified as `PRODUCT_NOT_READY` before the historical extract finishes.
4. Confirms `GET /connections/{id}/sync-runs` reports a `success` run too — not just the orchestrator's in-process return value.
5. `afterAll` calls the application's own `DELETE /connections/{id}` (step-up session), which revokes at Plaid (`/item/remove`) through `connector.disconnect()` exactly as a real user's "Disconnect" button would, then drops the whole scratch database. Runs even when the test body throws.

### The run (2026-09-15)

```
env PLAID_CLIENT_ID="$(cat secrets/plaid_client_id)" \
    PLAID_SECRET="$(cat secrets/plaid_secret)" \
    PLAID_ENV="$(cat secrets/plaid_env)" \
  DATABASE_URL="postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev" \
  TEST_ADMIN_DATABASE_URL="postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev" \
  pnpm exec vitest run --project api-db test/db/plaid-sandbox.test.ts --dir apps/api
```

**Result: PASS. 1 file, 1 test, 25.06 s.** Without credentials the same file
reports `1 skipped`, with the same "why, and how to run it" message
`sandbox.test.ts` prints, so a green CI run cannot be mistaken for one that
talked to Plaid. No client id, secret, public token or access token appeared
in the captured output at any point — the harness's `LOG_LEVEL` is `silent`
and this test asserts against response bodies and database rows, never
prints a credential, and the shell commands above read the three secret
files directly into `env`, never through an intermediate variable a shell
history or a log could capture.

**Housekeeping — reusing the credentials that already existed.** The three
secret files (`secrets/plaid_client_id`, `secrets/plaid_secret`,
`secrets/plaid_env`) were already present on disk from WP 1.3's own runbook;
this pass did not create, view, or modify them, and does not know their
values. `wp1.3-plaid.md` §7a already records that the Sandbox secret was
rotated after an earlier exposure; nothing in this pass reads or writes that
history.

---

## 6. `packages/connectors/plaid` — the one export addition

`FakePlaidApi` needed to reach `apps/api/test/db/plaid-routes.test.ts`
without a second, drifting fake being built one layer up.
`personalfi/layer-imports` no-ops for `apps/` (the composition root may wire
anything together), so the only real obstacle was `moduleResolution: nodenext`'s
strict `exports` map: `@connector/plaid`'s `package.json` gained
`"./test": "./test/index.ts"`, and `packages/connectors/plaid/test/index.ts`
(new) re-exports `FakePlaidApi` and the harness fixtures, plus one new
helper:

```ts
export function fakePlaidItem(options: {
  accessToken: string;
  publicToken: string;
  itemId: string;
}): FakeItemSpec;
```

— a distinct Plaid Item (namespaced account ids, so `@ctx/ledger`'s
`(user_id, provider, provider_account_id)` natural key does not collapse two
synthetic institutions into one ledger account, and `connection_accounts`'s
`(user_id, account_id)` unique index does not then refuse the second link).
**Found by running the ratchet test**: the first draft of `fakePlaidItem`
reused `ACCOUNTS` verbatim across every synthetic Item, and the second
`createConnection` in any test needing two Plaid connections for one user
failed with a genuine Postgres unique-violation on `connection_accounts_account_idx` —
a real invariant (08 §3.9's "losing account identity … is the classic way a
personal finance app silently doubles a user's net worth", enforced here as
"one connection owns a given ledger account") doing exactly its job against
a fixture that did not respect it.

`test/harness.ts`'s existing `defaultItemSpec`/`ACCOUNTS`/`ITEM`/`SYNC_PAGES`
etc. are also re-exported verbatim; nothing in `src/` was changed, and no
existing test in the package changed behaviour.

```
pnpm exec vitest run --project connector-plaid
# 7 files, 212 tests passed, 1 skipped — unchanged from wp1.3-plaid.md
```

---

## 7. `apps/web`: three call sites, nothing else

Per `wp1.6-ui.md` §4's own prediction, once the route existed "the only edit
`apps/web` needs is replacing `getLinkToken`'s body with that call; nothing
else in `PlaidConnectCard.tsx`/`ReconnectDialog.tsx`/`plaid-link.ts`
changes." That held, plus the symmetric edit for update mode and one new
hook:

- **`src/lib/plaid-link.ts`** — `PlaidLinkTokenUnavailableError` removed
  (nothing throws it any more); the header comment now points at this
  document instead of describing a gap. `openPlaidLink`/`loadPlaidLinkScript`
  are byte-for-byte unchanged.
- **`src/features/connections/PlaidConnectCard.tsx`** — `getLinkToken()`
  now calls `Sdk.__registry.get().createPlaidLinkToken({ throwOnError: true })`.
  The `onSuccess` handler now calls the new
  `useExchangePlaidTokenMutation()` (`POST /connections/plaid/exchange`)
  instead of the generic `useCreateConnectionMutation()` — the Plaid-shaped
  body the dedicated route wants, still wrapped in the same
  `useStepUpRetry()`.
- **`src/features/connections/ReconnectDialog.tsx`** — `getUpdateLinkToken(connectionId)`
  now calls `createPlaidUpdateLinkToken`. Completing the reauth still goes
  through the pre-existing `POST /connections/{id}/reconnect` — 01 §1.7 is
  explicit that update mode's access token does not change, so nothing needs
  re-exchanging, and that route already existed (WP 1.5).
- **`src/features/connections/useConnections.ts`** — gained
  `useExchangePlaidTokenMutation()`, the same shape as the existing
  `useCreateConnectionMutation`/`useReconnectConnectionMutation`
  (invalidates connections/accounts/net-worth on success).

```
just openapi                             # idempotent — 43 paths, 47 ops, 60 schemas
pnpm --filter @app/web gen               # 5 files, gitignored, regenerated clean
pnpm --filter @app/web typecheck         # gen + tsc -b --noEmit — clean
pnpm --filter web test                   # 14 files, 81 tests, all passing (unchanged)
```

No Plaid-specific web test was added: `PlaidConnectCard`/`ReconnectDialog`
were not exercised by WP 1.6's own suite (Plaid was not registered, so
`GET /connectors` never returned a `provider_hosted` manifest in any fixture)
and adding one was out of scope for a backend work package whose UI rule is
"minimal edits." The backend proof is the 11 apps/api tests in §3/§4/§5;
`pnpm --filter web test`'s unchanged 81/81 is the regression check that nothing
else moved.

---

## 8. Tests — full list

| File                                     | New tests | What it proves                                                                                                                                                                                             |
| ---------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config/src/load.test.ts`       | 13        | Feature-detect, partial-config refusal, `plaid_env` validation incl. `'development'`, the D16 production gate, country-code parsing, redirect/webhook passthrough, no secret in any error or serialisation |
| `apps/api/test/domain.test.ts`           | 3         | `createConnectorRegistry`'s two branches, one info line each, no secret in the log or in `JSON.stringify` of the config object                                                                             |
| `apps/api/test/db/plaid-routes.test.ts`  | 10        | Link-token pins forwarded, session-only auth, exchange custody (P0-1), step-up on exchange/update-link-token, update-mode omits `products`, wrong-provider 404, the D16 ratchet                            |
| `apps/api/test/db/plaid-sandbox.test.ts` | 1         | The whole path against real Plaid Sandbox — §5                                                                                                                                                             |
| **Total**                                | **27**    |                                                                                                                                                                                                            |

```
pnpm exec vitest run --project config --project api --project api-db --project connector-plaid
# 22 files passed, 1 skipped (23) · 405 tests passed, 2 skipped (407)
# the 2 skips: connector-plaid's own sandbox.test.ts and this work's plaid-sandbox.test.ts,
# both correctly skipped when PLAID_CLIENT_ID/PLAID_SECRET are unset
```

One unrelated, transient failure was observed during this work in
`apps/api/test/db/phase1-seed-e2e.test.ts` (a categorization-share assertion,
882 vs. 982) — that file is `apps/api/test/phase1-*.test.ts`, explicitly
owned by the concurrently running quality-engineer agent per this dispatch's
collision rules, and unrelated to anything this work package touched
(confirmed by `git diff` on the file showing no changes from this pass, and
by `packages/contexts/ledger/src/*` visibly changing mid-session from that
agent's own edits). Re-running the full suite afterward showed it passing
again; not investigated further here.

---

## 9. Commands

```
just openapi                                                        # idempotent, 43/47/60
pnpm --filter @app/web gen                                          # 5 files, no other apps/web change
pnpm exec vitest run --project config                                # 67 tests
pnpm exec vitest run --project api                                   # 50 tests
pnpm exec vitest run --project api-db                                 # 76 passed, 1 skipped (plaid-sandbox, no creds)
pnpm exec vitest run --project connector-plaid                        # 212 passed, 1 skipped (unchanged)
env PLAID_CLIENT_ID="$(cat secrets/plaid_client_id)" \
    PLAID_SECRET="$(cat secrets/plaid_secret)" \
    PLAID_ENV="$(cat secrets/plaid_env)" \
  pnpm exec vitest run --project api-db test/db/plaid-sandbox.test.ts # PASS, 25.06s
pnpm --filter web test                                                 # 81 tests, unchanged
```

`just check` and `just verify` results are recorded in the execution log
rather than duplicated here; see the RESUME POINT entry for this work
package's run.

---

## 10. Left open

- **`ConnectorHealth.checkedAt`/no-`SyncOptions`-on-`health()`** — wp1.3-plaid.md
  §8 item 2's port gap, unchanged; not this work package's to fix.
- **The port has no `ProviderInvestmentTransactionFact`** — §8 item 3,
  unchanged.
- **No web test exercises `PlaidConnectCard`/`ReconnectDialog` against a
  registered Plaid connector** — §7 above states the reasoning; a future UI
  pass could add one now that `GET /connectors` can genuinely return
  `provider_hosted`.
- **`/accounts/balance/get` is still never called by the orchestrator** —
  wp1.5-api.md §7.1's known gap, unchanged; balances still arrive `null` for
  every provider, Plaid included.
- **The `apps/api` → `@connector/plaid` dependency line and the
  `"./test"` export on `@connector/plaid`'s `package.json`** were added to
  `package.json` files directly, which the dispatch's RULES ask to avoid
  where possible and to report otherwise — see the final report for the
  exact lines. No other `package.json`, and no lockfile edit was made by
  hand; `pnpm-lock.yaml`'s one three-line addition (the new workspace
  dependency edge) was written by `pnpm` itself as a side effect of the
  first `pnpm exec` invocation after the `package.json` edit, not by an
  explicit `pnpm install` command.
