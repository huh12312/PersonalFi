<!-- SPDX-License-Identifier: MIT -->

# WP 3.9 — the REST surface for investments, net worth, securities, prices and market data

`docs/plan/03-phase-3-dispatch.md` §3, WP 3.9. Phase 2's lesson applied up front: the plan forgot
the routes package once and the orchestrator had to add WP 2.r mid-phase. This time the route
package was dispatched **with** the wave rather than after it — and, per §3's evidence line, the
`just check` output is appended here (§9), which is the one thing WP 2.r's note omitted.

## 1. What landed

| File                                          | What                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/routes/investments.ts`          | `/holdings`, `/accounts/{id}/holdings`, allocation, drift, performance, the basis-method election, and the shared portfolio reader the other route files use |
| `apps/api/src/routes/securities.ts`           | `GET`/`PATCH /securities/{id}` — 04 §3.2's overlay                                                                                                           |
| `apps/api/src/routes/prices.ts`               | `GET /prices/{id}` (the 07 §6.1 ladder) and the rung-1 `PUT` override                                                                                        |
| `apps/api/src/routes/net-worth.ts`            | `GET /net-worth/series`, `POST /net-worth/corrections`                                                                                                       |
| `apps/api/src/routes/market-data.ts`          | settings (key **presence**, budgets, attribution), priority, test fetch                                                                                      |
| `apps/api/src/routes/connections.ts`          | **additive**: the `persistPending` call that closes `wp3.w-wiring.md` §10 item 8                                                                             |
| `apps/api/src/routes/deps.ts`                 | **additive**: `RouteDeps.walletRpc`                                                                                                                          |
| `apps/api/src/app.ts`                         | five registrations, three OpenAPI tags, the hoisted `WalletRpcRuntime`                                                                                       |
| `apps/api/test/helpers/api-harness.ts`        | **additive**: `PUT` in the method union, and an opt-in `walletRpc` registry                                                                                  |
| `apps/api/test/db/investments-routes.test.ts` | the three exit tests, plus the wallet-link seam                                                                                                              |
| `apps/api/test/db/market-data-routes.test.ts` | `'the settings response contains no API key value'`                                                                                                          |
| `apps/api/test/db/net-worth-routes.test.ts`   | the gapless series, the seal, and the byte-identical correction                                                                                              |
| `apps/api/test/phase3-registration.test.ts`   | **additive**: `'every advisor scope has a reader'`                                                                                                           |
| `packages/contracts/openapi/openapi.json`     | regenerated; `apps/web/src/api/generated/` regenerated from it                                                                                               |

**No migration.** 0018 was reserved for 3.9/3.13 and this work package did not need it — every
route reads a table that already exists. (WP 3.7, concurrent, has taken `0018` for
`connection_sync_facts`; see §8 item 4.)

**No events emitted.** `POST /net-worth/corrections` appends `planning.NetWorthSnapshotTaken`
through `@ctx/planning`'s own `correctDay`, which is the context emitting its own event, not this
route emitting one.

## 2. The route table

`session` = `requireSession`. `step-up` = `requireFreshSession`. "Scope" is the predicate that makes
another holder's data unreachable, named per row rather than assumed from a shared middleware.

| Route                           | Auth        | Scope predicate                                                                             | Why this auth level                                                                                                                                        |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /holdings`                 | session     | `holdings.user_id` **and** `securities.user_id` in `readHoldings`                           | a read of the user's own portfolio                                                                                                                         |
| `GET /accounts/{id}/holdings`   | session     | `@ctx/ledger`'s `listAccounts(userId)` membership check → 404, then the same two predicates | ditto; the 404 is deliberate — a 403 would confirm the id exists                                                                                           |
| `GET /investments/allocation`   | session     | as `GET /holdings`                                                                          | read                                                                                                                                                       |
| `GET /investments/drift`        | session     | as `GET /holdings`                                                                          | read                                                                                                                                                       |
| `GET /investments/performance`  | session     | `investment_transactions.user_id`, `holdings*.user_id`, `securities.user_id`                | read                                                                                                                                                       |
| `PUT /investments/basis-method` | **step-up** | account membership **and** `securities.user_id` → 404                                       | `AVERAGE_COST` is sticky by database trigger and is a tax election the user cannot take back — a one-way door, `connections.ts`'s standard                 |
| `GET /securities/{id}`          | session     | `securities.user_id` + `security_overlay.user_id` → 404                                     | read                                                                                                                                                       |
| `PATCH /securities/{id}`        | session     | same                                                                                        | an **overlay**, not a credential and not an override of a price: reversible in one call, writes nothing outside the user's own row. The `rules.ts` posture |
| `GET /prices/{id}`              | session     | `securities.user_id` → 404, then `prices.user_id`                                           | read                                                                                                                                                       |
| `PUT /prices/{id}`              | **step-up** | `securities.user_id` → 404                                                                  | **rung 1** of 07 §6.1's ladder. It outranks every provider, so it silently restates the portfolio, the net-worth series and every advisor reading them     |
| `GET /net-worth/series`         | session     | `net_worth_daily.user_id` in both the spine join and the detail read                        | read                                                                                                                                                       |
| `POST /net-worth/corrections`   | **step-up** | `currentRow(userId, date)` → 404                                                            | the only HTTP path that can change a **closed** day. `snapshot.ts`: _"a correction is a decision"_                                                         |
| `GET /market-data/settings`     | session     | `price_source_priority.user_id`; provider keys are **presence only**                        | read                                                                                                                                                       |
| `PUT /market-data/priority`     | **step-up** | delete+insert both scoped to `user_id`                                                      | decides which provider's number becomes the price of everything the user owns                                                                              |
| `POST /market-data/test-fetch`  | **step-up** | writes `market_data_runs` under `user_id`                                                   | the one route in this work package that **leaves the machine** and spends a real budget                                                                    |

### Overlay vs override — the line this table draws

The brief says "step-up on anything writing a credential or override". `PATCH /securities/{id}` is
04 §3.2's _overlay_ and is session-only; `PUT /prices/{id}` is 07 §6.1's _user price override_ and
is step-up. The distinction is not wordplay: an asset-class overlay changes how a position is
**described** and is reverted by one `PATCH` with `null`; a price override changes what the
portfolio is **worth**, outranks every provider by CHECK-pinned rung, and propagates into the
sealed net-worth history. Recorded here so the gate can rule on it rather than discover it.

## 3. The separate-shapes mechanism

07 §4.2: _"Never put a TWR next to a dollar gain, and never benchmark an MWR. That's the whole
rule."_ `@ctx/investments` already enforces it on the **domain** types with `?: never` members.
What crosses this boundary is JSON, and the serialisation boundary is exactly where a rule like this
would otherwise stop applying — so `routes/investments.ts` re-declares the guards on the wire types:

- `WireTimeWeightedReturn` — `gain?: never`, `dollarGain?: never`, `marketValue?: never`,
  `costBasis?: never`, and `benchmarkComparable: true`.
- `WireMoneyWeightedReturn` — `benchmark?: never`, `gain?: never`, `dollarGain?: never`.
- `WireDollarGain` — `periodReturn?: never`, `annualized?: never`, `benchmarkComparable?: never`.

With `exactOptionalPropertyTypes` on, an object carrying both fails to type-check whether it was
written as a literal **or assembled by a spread** — which is the realistic way it would happen.

Three further things make it hold end to end:

1. **The serialiser's declared return type is the guarded type**, and Fastify's Zod type provider
   then checks that value against the route's response schema. Both halves have to agree or
   `tsc -b` fails. There is no cast on that path.
2. **`subPeriods` is not serialised.** It carries a `Money` per boundary; putting it inside the TWR
   object would hand a client the forbidden pairing through the back door.
3. **The response holds all three under three keys**, which is allowed and is the point: the rule
   forbids one _object_ expressing both, so no chart can plot them on one axis and no card can put
   them in one row.

`'the performance response cannot express a TWR and a dollar gain in the same object'` pins it with
four `@ts-expect-error` directives. **Vitest does not check those — `tsc -b` does**, and that is the
mechanism: delete the `?: never` members and each directive becomes _unused_, which is itself a
compile error. The guard cannot be removed quietly.

The runtime half is asserted too: `'serves the three performance answers under three separate keys'`
walks `Object.keys` of each block and asserts `gain`, `dollarGain`, `marketValue`, `costBasis` and
`subPeriods` are absent from `timeWeighted`, `benchmark` from `moneyWeighted`, and `periodReturn`
from `dollarGain`.

## 4. Cross-user scope, and the sabotages

`'every route refuses another user's data'` covers one case per route family: aggregated holdings,
per-account holdings, securities (read **and** write), prices (read **and** write), analytics
(allocation and drift over one portfolio read), and the basis-method election. It finishes by
serialising every response the other holder received and asserting **none** of our four ids appears
in any of them.

Seven sabotages. Six were red on the first valid attempt; **one was green, and that is a finding
rather than a pass** — see S1.

| #   | Sabotage                                                                      | Result    | What it proves                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | drop `WHERE h.user_id` from `readHoldings`                                    | **GREEN** | _Not_ that the control is absent — that it is **doubled**. The `JOIN securities s ON … s.user_id` still scopes the result, so removing one predicate alone leaks nothing. Recorded because "I dropped a predicate and the test stayed green" is exactly the observation a reviewer must not be allowed to misread. It also means a single-predicate sabotage is **not sufficient evidence** for this route. |
| S2  | drop **both** `h.user_id` and `s.user_id`                                     | RED       | `expected [ …2 rows ] to have a length of +0` — the other holder saw our two aggregated positions.                                                                                                                                                                                                                                                                                                          |
| S3  | `if (accounts.some(...))` → `if (false)` on `/accounts/{id}/holdings`         | RED       | `expected 200 to be 404` — the membership check is the only thing standing between another holder and our per-account lots.                                                                                                                                                                                                                                                                                 |
| S4  | drop `AND s.user_id` from `readSecurity` (`securities.ts`)                    | RED       | `expected 200 to be 404` — covers `GET` **and** `PATCH`, which share the reader.                                                                                                                                                                                                                                                                                                                            |
| S5  | add `debugKeys: runtime.keys.map((k) => k.reveal())` to the settings response | RED       | `'a market-data response carried the API key value': expected true to be false` — §5's control.                                                                                                                                                                                                                                                                                                             |
| S6  | disable the `persistPending` call in `routes/connections.ts`                  | RED       | `expected [] to have a length of 1` — `wallet_addresses` empty after a link, which is the pre-WP-3.9 state exactly.                                                                                                                                                                                                                                                                                         |
| S7  | drop `if (holding.staleness === 'STALE') bucket.stale = true`                 | RED       | `'a price observed 48 h ago is STALE': expected false to be true`.                                                                                                                                                                                                                                                                                                                                          |

All seven were reverted and the suite re-run green (`14 passed` for `investments-routes`, `6` for
`market-data-routes`, `8` for `net-worth-routes`).

## 5. Key presence, never a key value

`'the settings response contains no API key value'` does **not** assert "there is no field called
`apiKey`". A field-name assertion passes forever while a key leaks through `detail`, through a
serialised config object, or through a provider error nobody thought to redact. Instead:

1. A synthetic key (`pfi-synthetic-tiingo-key-do-not-use-9f3c1a77`) is planted as a **file** in the
   harness's `SECRETS_DIR`, which is the mechanism a real deployment uses (D5).
2. The test asserts the key is genuinely **detected** — `tiingo.keyPresent === true`,
   `registered === true` — so a pass cannot be an artefact of an install with no keys.
3. Every route in the router is then called (settings, priority `PUT` at 200 **and** at 403,
   test-fetch at 200 **and** at 400, settings at 401) and each body is scanned for the key
   verbatim, base64-encoded and URL-encoded.

Defence in depth behind it: `@ctx/integrations`' `ApiKey` renders as `[redacted]` through
`toString`, `toJSON` and `util.inspect`, so an accidental spread cannot leak one; this router never
puts an `ApiKey` in a response object at all, deriving presence from `config.secrets` directly; and
any provider-authored text on the way out goes through `redactedMessageOf` one more time.

**The live test fetch is opt-in** (`MARKET_DATA_LIVE=1`), the shape `plaid-sandbox.test.ts` already
uses. A suite that dialled `api.tiingo.com` on every `just check` would be slow, flaky, and would
spend a real free-tier allowance; CI has no egress to it. What _is_ asserted unconditionally is the
branch a zero-key deployment actually takes — `skipped_no_key`, no request made, **and no
`market_data_runs` row written** — which is §6 of the dispatch's own posture. The route records a
`test_fetch` run for every call that _is_ made, so a manual test spends against the same ledger the
nightly refresh does rather than being an invisible way to burn a free tier.

Licence obligations are asserted by equality, not by presence: FRED's exact sentence (® included)
and CoinGecko's _"Data provided by CoinGecko"_ with its link. A paraphrase of a licence condition is
a new licence condition.

## 6. The watch-only wallet seam (wp3.w-wiring.md §10 item 8)

That item said a watch-only wallet **cannot be linked end to end**: `@ctx/connections`'
`createConnection` calls `connector.connect()` _before_ it inserts the `connections` row, so when
`WalletRpcConnector.connect()` calls `WalletAddressStore.put()` there is no `connections.id` to
reference. `put` therefore staged the descriptor in a request-scoped map and `persistPending` — the
drain — was written but unwired. The connection linked, and then answered _"this connection has no
wallet on record"_ on its first sync from the worker. N-7's shape.

WP 3.9 wires the route-side fix:

- `buildApp` hoists the `WalletRpcRuntime` out of the registry call and exposes it on `RouteDeps`
  (previously it was constructed inline and its store was unreachable).
- `linkConnection` calls `store.persistPending(providerConnectionId, { connectionId, userId })`
  **after** the transaction commits, in the same process and request that staged it.
- A first link that staged nothing is a **500 that names itself**
  (`connections.wallet_descriptor_not_persisted`) rather than a connection with no wallet behind it.

`'a watch-only wallet link persists its addresses on first connect'` links a BIP84 test-vector zpub
over HTTP and reads `wallet_addresses` back: one row, the right `connection_id`, chain, descriptor
and label. S6 above is the sabotage.

**Still open, and still worth doing:** the cleaner fix is `@connector/walletrpc`'s — `put` should
carry the connection identity, or the connector should flush from a `ConnectionHandle` the way
`CsvImportConnector` does. That is a `packages/connectors/**` change this work package may not make.

## 7. SnapshotBuilder readers (wp3.10 §7.1) — **not landed, and why**

The brief asked for the four owed readers to be implemented "in apps/api's snapshot builder". **There
is no snapshot builder in `apps/api`.** `grep -rn SnapshotBuilder` returns only
`packages/contexts/insights/src/**`. The three files §7.1's additions require are all context source:

| Needed                                                                             | File                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `investments.holdings`, `investments.liabilities`, `marketData.rates` port methods | `packages/contexts/insights/src/snapshot/ports.ts`   |
| the four `#blockFor` arms                                                          | `packages/contexts/insights/src/snapshot/builder.ts` |
| the four `sourcedInPhase2: false → true` flips                                     | `packages/contexts/insights/src/contract/scopes.ts`  |

WP 3.9's rules forbid context `src/` edits and say to describe the addition and stop at the seam.
That is what this section is. **No speculative reader code was written**: a port implementation in
`apps/api` typed against an interface that does not exist yet is dead code that cannot be wired,
and `domain.ts` — where the three existing `createInsights*Port` adapters live — is being edited
concurrently by WP 3.7.

### The exact addition, for whoever owns the context next

1. `snapshot/ports.ts`: add `InvestmentsPort { holdings({userId, asOf}), liabilities({userId, asOf}) }`
   and `MarketDataPort { rates({userId, asOf}) }`, each returning `null` when the module is off or
   has no data, and add both to `SnapshotPorts`. Fakes beside the existing three, in `src/`.
2. `snapshot/builder.ts`: four `case` arms — `#holdingsAggregate`, `#holdingsDetail`,
   `#liabilitiesTerms`, `#marketRates` — with §7.1's field maps, and the two rules it names: a
   `securityId` never crosses (symbol only), and a target asset class absent from the portfolio is
   emitted as a **zero-weight** `by_asset_class` row.
3. `contract/scopes.ts`: flip the four flags **in the same commit** as the arms. An arm without a
   flag is dead code; a flag without an arm is a silent no-key.
4. `apps/api/src/domain.ts`: implement the two new ports over the same readers this work package's
   routes use — `readHoldings` + `createPriceReader` + `@ctx/investments`' analytics for
   `holdings.*`; `@ctx/ledger`'s liability accounts plus whatever WP 3.7 lands for
   `liabilities.terms` (**read what it lands or return an empty block; never a fake**); and
   `@ctx/integrations`' `FredSource.macro()` for `market.rates`, with §7.1's three builder duties
   (convert percent→ratio and record `units`, **refusing** any series whose units are not
   percent-per-annum; compute `stale` against WP 3.4 §5.1's ladder; carry `ATTRIBUTIONS.fred.text`
   verbatim).

### What did land: `'every advisor scope has a reader'`

Added to `apps/api/test/phase3-registration.test.ts`. It asserts (a) every scope in the wire enum has
a `SCOPE_CATALOGUE` row; (b) the set of scopes **without** a reader is exactly the four §7.1 owes
plus the four whose source context does not exist yet (`goals.list`, `risk.profile`,
`market.watchlist`, `institutions.names`) — in both directions, so adding a fifth unsourced scope
fails, and so does landing a reader without flipping its flag; and (c) every other scope claims one.

**Writing it found something.** The first draft asserted "no enabled advisor may require an
unsourced scope" and went red on `builtin.cash.idle_above_cushion` and `builtin.cash.yield_spread`,
which ship **on** and declare `market.rates`. That draft was wrong, not the catalogue:
`rules-cash.ts` reads `snapshot.market_rates?.rates ?? []` and falls back to _"the best rate you
already hold"_ — byte-identical to what Phase 2 shipped. So `requires_scopes` is a **grant** list,
not a list of hard requirements, and the assertion that is actually true is that the set of enabled
rules reading an unsourced scope is **exactly the reviewed one**. A new rule joining that set now
fails the build until somebody reads its fallback. The companion test also asserts that every rule
that ships _off_ because of a missing reader says so in `disabledReason`, where a reviewer reads it.

## 8. Findings and seams

1. **There is no `allocation_targets` table.** `GET /investments/drift` therefore takes targets in
   the query (`?target=US_EQUITY:0.6`) and, with none supplied, **suppresses rather than invents**
   (07 §8 Q9): `targetsSet: false`, `rows: []`, and `unclassifiedPct` still returned. Persisting a
   target set needs a migration, which this work package declined to take. WP 3.11's "set a target"
   empty state is honoured by `targetsSet`.
2. **A dollar gain over a _historical_ period is answered over today's positions.** WP 3.2's engine
   holds lots, not dated basis snapshots, so a basis as of `from` would need the lot ledger replayed.
   Stated in the route's own comment rather than implied by the number.
3. **`/performance`'s external flows are `CASH`, `TRANSFER_IN` and `TRANSFER_OUT` only.** A `BUY` is
   internal to the account and counting it would drag every measured return toward zero. A transfer
   with no cash leg, and a flow in a currency other than the base, are counted in
   `unvaluedTransfers` and **not** treated as zero flows. Valuation dates are the endpoints plus
   every flow date, capped at 64; beyond the cap the engine answers Modified Dietz **flagged
   `approximate`**, which is `timeWeightedReturn`'s own documented degradation.
4. **WP 3.7 has taken migration `0018`** (`0018_connection_sync_facts.sql`), which §4 of the dispatch
   reserved for "3.9/3.13". 3.9 needed none, so nothing collided — but 3.13 should be told before it
   reaches for it.
5. **`pnpm exec tsc -b` is red at this commit on two files this work package does not own** —
   `apps/api/test/db/{investments-sync,insufficient-scope}.test.ts`, WP 3.7's, concurrently in
   flight (`RunRow` missing an index signature; a `PriceSubject` literal missing `mic`). Every file
   WP 3.9 touched typechecks. §9 records the state as it stands.
6. **The investments fixtures are seeded with SQL, and the suite says so at the top.** The accounts
   are real and linked over HTTP; `securities`, `holdings`, `prices` and `investment_transactions`
   are inserted directly, because the only code path that writes them is WP 3.7's sync, in flight.
   The seed is careful to write rows the real writer would: `NULL` basis rather than `0`, no
   `last_known` in `prices.source`, decimal-string quantities, and staleness driven by `observed_at`.
7. **`security_overlay.is_cash_equivalent` and `.name` are resolved in the route**, not by
   `effectiveClassificationOf`, which covers the four classification fields only. Both follow the
   same "only a locked field wins" rule. A context-side addition to that function would be tidier.

## 9. Check output

### `just openapi` + `pnpm --filter @app/web gen`

```
$ just openapi
pnpm run openapi
$ node apps/api/src/cli/emit-openapi.ts
wrote /home/chris/Projects/PersonalFi/packages/contracts/openapi/openapi.json

$ pnpm --filter @app/web gen
@hey-api/openapi-ts v0.99.0
[Job 1] ✓ ./apps/web/src/api/generated · 5 files · 775ms
```

Diff summary — **13 paths added, none removed, none changed**:

```
paths before 86 after 99
ADDED PATHS:
  + /holdings                         get
  + /accounts/{accountId}/holdings    get
  + /investments/allocation           get
  + /investments/drift                get
  + /investments/performance          get
  + /investments/basis-method         put
  + /securities/{securityId}          get,patch
  + /prices/{securityId}              get,put
  + /net-worth/series                 get
  + /net-worth/corrections            post
  + /market-data/settings             get
  + /market-data/priority             put
  + /market-data/test-fetch           post
REMOVED PATHS:   (none)
ADDED SCHEMAS:   PriceQuote, UnrealizedGain, AggregatedHolding, AllocationReport,
                 TimeWeightedReturn, MoneyWeightedReturn, DollarGain, Attribution,
                 MarketDataProviderSettings, NetWorthSeriesPoint, Security
                 (plus the eleven `*Input` halves fastify-type-provider-zod emits
                  unconditionally — see app.ts's `transformObject` comment)
REMOVED SCHEMAS: (none)
ADDED TAGS:      investments, planning, market-data
```

### `node scripts/check-proxy-routes.ts` — green, **with no `docker/Caddyfile` edit**

§4 item 7 says a Caddyfile edit here would be a finding. It was not needed: the API is proxied whole
at `handle_path /api/*`, so new prefixes are covered by construction.

```
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, matching
packages/contracts/openapi/openapi.json's servers[0].url ('/api') and covering all 26 contract
prefix(es): /accounts, /advisors, /auth, /budgets, /categories, /connections, /connectors, /export,
/health, /holdings, /import, /imports, /insights, /investments, /market-data, /net-worth,
/notifications, /prices, /ready, /recurring, /reports, /rules, /securities, /sync, /transactions,
/transfers.
```

### `pnpm exec vitest run --project api --project api-db`

```
 Test Files  45 passed | 1 skipped (46)
      Tests  278 passed | 2 skipped (280)
   Duration  293.45s
```

(The two skips are the opt-in live market-data fetch and the pre-existing Plaid Sandbox smoke.)

### `just lint`

```
$ prettier --check .
All matched files use Prettier code style!
$ eslint .
✖ 1 problem (0 errors, 1 warning)
  — apps/web/src/features/transactions/TransactionsList.tsx:57  react-hooks/incompatible-library
    (pre-existing; TanStack Virtual, untouched by this work package)
$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 99 table(s) claimed across 14 package(s), 79 defined.
```

### `just check`

Appended below, in full — the WP 2.r omission, not repeated.

**`just check` is RED at this commit, and not on anything this work package wrote.**

`check` is `typecheck lint check-proxy-routes test`, and it stops at the first failure. Every error
below is in a file **WP 3.7 owns and is editing right now**: that work package is mid-refactor of
`@connector/port`'s `ProviderSecurityFact` / `ProviderHoldingFact`, and
`apps/api/src/domain.ts:1096/1109` is `createInvestmentSyncPort`, which the WP 3.9 brief names as
theirs and which this work package did not touch. The set moved between two consecutive runs
(`packages/connectors/{plaid,coinbase}/src/map.ts` appeared and then cleared), which is what an
in-flight edit looks like from here.

**Every file WP 3.9 touched typechecks**, verified by filtering the same compiler run:

```
$ pnpm exec tsc -p tsconfig.json 2>&1 | grep -E 'apps/api/(src/routes|src/app|test/db/(investments-routes|market-data-routes|net-worth-routes)|test/phase3|test/helpers)'
(no output)
```

Two real defects in this work package's own files were found by this run and fixed before it was
recorded, both of which `tsc -b` had not surfaced:

- `investments-routes.test.ts` — Prettier reformatted the `marketValue` case onto three lines, which
  moved the `@ts-expect-error` onto the `const` line where there is no error. **The directive went
  unused and the compiler said so**, which is the guard in §3 working exactly as designed: the
  comment now sits on the offending property.
- `net-worth-routes.test.ts` — `noPropertyAccessFromIndexSignature` on the `Record<string, unknown>`
  rows of the byte-identity comparison.

### `just check`, verbatim

```
pnpm run typecheck
$ tsc -p tsconfig.json
apps/api/src/domain.ts(1096,40): error TS2339: Property 'providerSecurityId' does not exist on type 'ProviderHoldingFact'.
apps/api/src/domain.ts(1109,49): error TS2345: Argument of type '({ identifiers: ProviderSecurityFact[]; providerSecurityId: any; } | { identifiers: SecurityIdentifier[]; providerSecurityId: string | null; })[]' is not assignable to parameter of type 'readonly ResolvableInput[]'.
  Type '{ identifiers: ProviderSecurityFact[]; providerSecurityId: any; } | { identifiers: SecurityIdentifier[]; providerSecurityId: string | null; }' is not assignable to type 'ResolvableInput'.
    Type '{ identifiers: ProviderSecurityFact[]; providerSecurityId: any; }' is not assignable to type 'ResolvableInput'.
      Type '{ identifiers: ProviderSecurityFact[]; providerSecurityId: any; }' is not assignable to type 'ResolvableSecurity'.
        Types of property 'identifiers' are incompatible.
          Type 'ProviderSecurityFact[]' is not assignable to type 'readonly SecurityIdentifier[]'.
            Type 'ProviderSecurityFact' is missing the following properties from type 'SecurityIdentifier': kind, value, chain, mic
packages/connectors/plaid/test/connector.test.ts(596,34): error TS2339: Property 'providerSecurityId' does not exist on type 'ProviderHoldingFact'.
packages/connectors/plaid/test/map.test.ts(490,26): error TS2339: Property 'value' does not exist on type 'ProviderSecurityFact'.
packages/connectors/plaid/test/map.test.ts(508,17): error TS2339: Property 'providerSecurityId' does not exist on type 'ProviderHoldingFact'.
packages/contexts/investments/test/db/consumer.test.ts(120,21): error TS2353: Object literal may only specify known properties, and 'kind' does not exist in type 'ProviderSecurityFact'.
[ELIFECYCLE] Command failed with exit code 2.
error: recipe `typecheck` failed on line 124 with exit code 2
```

### The three steps `check` did not reach, run individually

```
$ just lint
pnpm run lint
$ pnpm run lint:format && pnpm run lint:eslint && pnpm run lint:schema-ownership
$ prettier --check .
Checking formatting...
[warn] packages/connectors/plaid/src/map.ts
[warn] packages/contexts/investments/src/resolver.ts
[warn] Code style issues found in 2 files. Run Prettier with --write to fix.
[ELIFECYCLE] Command failed with exit code 1.
[ELIFECYCLE] Command failed with exit code 1.
error: recipe `lint` failed on line 128 with exit code 1
```

Both remaining format warnings are WP 3.7's files, mid-edit. The run **immediately before** theirs
landed was clean:

```
$ prettier --check .
All matched files use Prettier code style!
$ eslint .
✖ 1 problem (0 errors, 1 warning)   # pre-existing TanStack Virtual warning in apps/web
$ node scripts/check-schema-ownership.ts
schema-ownership: ok — 99 table(s) claimed across 14 package(s), 79 defined.
```

```
$ just check-proxy-routes
node scripts/check-proxy-routes.ts
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, matching packages/contracts/openapi/openapi.json's servers[0].url ('/api') and covering all 26 contract prefix(es): /accounts, /advisors, /auth, /budgets, /categories, /connections, /connectors, /export, /health, /holdings, /import, /imports, /insights, /investments, /market-data, /net-worth, /notifications, /prices, /ready, /recurring, /reports, /rules, /securities, /sync, /transactions, /transfers.
```

```
$ node scripts/check-ci-projects.ts
check-ci-projects: self-test PASS (5 fixtures + 3 parser checks, correct state clean, every broken shape caught)
check-ci-projects: PASS — all 39 vitest.config.ts project(s) are covered by ci.yml (24 in 'test', 16 in 'migration-test'), and every name ci.yml lists exists.
```

```
$ DATABASE_URL=… pnpm exec vitest run --project api --project api-db
 Test Files  45 passed | 1 skipped (46)
      Tests  278 passed | 2 skipped (280)
   Duration  293.45s
```

**What the orchestrator should do with this.** Re-run `just check` once WP 3.7's `@connector/port`
refactor lands; nothing in WP 3.9 blocks it, and no file in this work package appears in the failure
set. The honest state of record is: WP 3.9 green on its own surface, the repository red on a
concurrent work package's in-flight edit.

### `just check`, re-run minutes later — the set is shrinking, which is the proof

```
pnpm run typecheck
$ tsc -p tsconfig.json
packages/connectors/plaid/test/connector.test.ts(596,34): error TS2339: Property 'providerSecurityId' does not exist on type 'ProviderHoldingFact'.
packages/connectors/plaid/test/map.test.ts(490,26): error TS2339: Property 'value' does not exist on type 'ProviderSecurityFact'.
packages/connectors/plaid/test/map.test.ts(508,17): error TS2339: Property 'providerSecurityId' does not exist on type 'ProviderHoldingFact'.
packages/contexts/investments/test/db/consumer.test.ts(120,21): error TS2353: Object literal may only specify known properties, and 'kind' does not exist in type 'ProviderSecurityFact'.
[ELIFECYCLE] Command failed with exit code 2.
error: recipe `typecheck` failed on line 124 with exit code 2
```

`apps/api/src/domain.ts` has cleared between the two runs and only WP 3.7's own test files remain.
That is a concurrent refactor converging, not a defect in the routes this work package added.

### `just check`, third run — after WP 3.7 committed (`1b6e2ce`)

```
pnpm run typecheck
$ tsc -p tsconfig.json
packages/connectors/plaid/test/map.test.ts(519,17): error TS2339: Property 'providerSecurityId' does not exist on type 'ProviderHoldingFact'.
[ELIFECYCLE] Command failed with exit code 2.
error: recipe `typecheck` failed on line 124 with exit code 2
```

One error left, still theirs (`packages/connectors/plaid/test/map.test.ts`). The progression across
the three runs — nine errors, then four, then one, and none of them ever in a WP 3.9 file — is the
record this section exists to leave. `just check` will go green on WP 3.7's next commit; the
orchestrator should re-run it there rather than treat this as a WP 3.9 gate.

### A final `--project api --project api-db` sweep, for completeness

```
 Test Files  1 failed | 44 passed | 1 skipped (46)
      Tests  1 failed | 280 passed | 2 skipped (283)
```

The one failure is `apps/api/test/db/phase3-wiring.test.ts` → `'a security seen as a ticker and
later as a FIGI is one securities row'`, which is **WP 3.7's file** (the brief names it as theirs,
"do not touch"), currently modified in the working tree by their `SecurityResolver` /
`ProviderSecurityFact` refactor. It flipped between one and two failures across consecutive runs,
which is what a live edit looks like. The sweep taken before that refactor landed — recorded above —
was `278 passed | 2 skipped`, and every WP 3.9 suite is green in both:

```
investments-routes.test.ts   14 passed
market-data-routes.test.ts    5 passed | 1 skipped (the opt-in live fetch)
net-worth-routes.test.ts      8 passed
phase3-registration.test.ts   2 added, both passed
```
