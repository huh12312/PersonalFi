# WP 3.w — the Wave A′ wiring batch

_The composition-root work `docs/plan/03-phase-3-dispatch.md` §4 reserves for the orchestrator: items
**3** (`MODULE_FLAGS`), **4** (`modules.ts` / `domain.ts`), **7** (the OpenAPI regeneration) and **8**
(the config-and-secrets batch). Items 1, 2, 5, 6 and 9 were applied before or during this batch by the
orchestrator. Same shape and same format as
[`docs/evidence/phase-2/wp2.w-wiring.md`](../phase-2/wp2.w-wiring.md), the batch this one follows._

---

## 1. Flags, and their final defaults

All three landed `defaultEnabled: false` and were flipped `true`, in that order, with
`apps/api/test/db/phase3-wiring.test.ts` green in between each time. The flip is the whole reason the
dispatch reserves this work for the orchestrator: a context can prove its own engine, and only the
composition root can prove it is wired. `module.planning` is WP 3.8's and landed after the snapshot;
it was flipped last, once the planning half of that file was green (6 tests, up from 4).

| Flag                  | Landed  | Final      | What made the flip defensible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module.investments`  | `false` | **`true`** | `phase3-wiring.test.ts` drove a real `connections.SyncRunCompleted` through the real pump into `@ctx/investments`' lot consumer, which opened a real lot and appended a real `investments.LotsUpdated`. Inert on an install with no investment accounts: `InvestmentSyncPort.factsForRun` returns no facts until WP 3.7's provider legs land, and a derivation over no facts writes nothing.                                                                                                                                                                                                                                                                                                                                                                         |
| `module.integrations` | `false` | **`true`** | Same file: the `integrations.price_refresh` job registers, the schedule row lands through the real `upsertSchedule`, and `createMarketDataRuntime` on a zero-key install registers **no** `PriceSource` at all — so the refresh runs, asks nobody and records that honestly. 03 §6: "Phase 3 completes with zero keys."                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `module.planning`     | `false` | **`true`** | Same file, added this run: a real `ledger.BalanceRecorded` — written by the real `recordBalance` — reaches `planning.net_worth@v1` through the real pump built with `drizzleTransactionalExecutor`, with `event_consumer_offsets.failed_error` **null** afterwards, which is the only way to know `executorFor: (c) => assertDrizzleTransaction(c.tx)` is satisfied; and the `planning.net_worth_snapshot` row lands through the real `registerNetWorthSnapshotSchedule` with cron `0 4 * * *`. Inert on a fresh install: the consumer's handler is an UPDATE (`markDirty`) that marks nothing when no open day exists, and the 04:00 job computes a day from whatever the ledger holds — for a holder with no accounts, nothing. It never writes a placeholder row. |

`apps/api/test/module-flag-defaults.test.ts` pins all three, and its "nothing undocumented sneaked
in" assertion means a fourth Phase 3 flag cannot appear without a line there.

---

## 2. Every file touched, with the line

### Composition root

| File                                             | What changed                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/platform.ts:127-172`               | `MODULE_FLAGS` gains `module.investments` and `module.integrations`, each with an `owner` and a reasoned `removeWhen`.                                                                                                                                                                   |
| `apps/api/src/modules.ts:75-90`                  | Imports `INVESTMENTS_EVENTS`, `createLotConsumer`, `drizzleLotStore`, `outboxOf`; `INTEGRATIONS_EVENTS`, `createPriceRefreshJob`.                                                                                                                                                        |
| `apps/api/src/modules.ts:116-122`                | `ModuleWiringOptions.database` intersection gains `InvestmentsDatabase`.                                                                                                                                                                                                                 |
| `apps/api/src/modules.ts:157-…`                  | New options: `investmentSyncPort` (required) and `marketData` (optional — its absence is the `app.ts` shape).                                                                                                                                                                            |
| `apps/api/src/modules.ts` (`PRICE_REFRESH_*`)    | `PRICE_REFRESH_JOB_KIND` / `PRICE_REFRESH_SCHEDULE_NAME` = `integrations.price_refresh`, `PRICE_REFRESH_CRON` = `45 3 * * *` (03:45 **local**, 08 §3.7).                                                                                                                                 |
| `apps/api/src/modules.ts` (`appModules`)         | `module.investments`: `INVESTMENTS_EVENTS` + the lot consumer, `storeFor`/`outboxFor` built over the pump's transaction. No jobs, no schedules — nothing here is time-driven.                                                                                                            |
| `apps/api/src/modules.ts` (`integrationsModule`) | `module.integrations`: `INTEGRATIONS_EVENTS`, the `defineJob` wrapper around `createPriceRefreshJob`, and the 03:45 schedule. No consumer: `@ctx/integrations` reacts to nothing (08 §1.3 #11).                                                                                          |
| `apps/api/src/domain.ts`                         | Eight new exports — see §3.                                                                                                                                                                                                                                                              |
| `apps/api/src/bootstrap-seed.ts`                 | `seedPriceSourcePriority` (unconditional) and the `integrations.price_refresh` schedule (flag-gated). `SeedUserStateResult.priceLadderRows` added.                                                                                                                                       |
| `apps/api/src/worker.ts`                         | Builds the market-data runtime, hydrates its budgets from `market_data_runs`, passes `investmentSyncPort` + `marketData` to `appModules`, adds `coinbase: config.coinbase` to the registry, and builds the pump with `drizzleTransactionalExecutor(database)` rather than `platform.db`. |
| `apps/api/src/app.ts`                            | `createConnectorRegistry({ …, coinbase: config.coinbase, … })` — the API needs the manifest for the "Add a connection" screen and runs the link ceremony inline.                                                                                                                         |

### Composition root — added after the snapshot (this run)

| File                                                 | What changed                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/platform.ts` (`MODULE_FLAGS`)          | `module.planning`, with its own `owner`/`removeWhen` and the reasoning for why `true` is inert on a fresh install.                                                                                                                                                                                                       |
| `apps/api/src/modules.ts` (`planningModule`)         | `PLANNING_EVENTS`, `createNetWorthConsumer` (with `executorFor` over the pump's Drizzle transaction), `netWorthSnapshotJobHandler` and `registerNetWorthSnapshotSchedule`. The job registration is **wrapped**: a job whose `context.userId` is not the holder these modules were built for is refused by name — see §3. |
| `apps/api/src/modules.ts` (`ModuleWiringOptions`)    | `userId` (required) and `baseCurrency` (optional, `USD`); `database` gains `PlanningDatabase`. `NET_WORTH_SNAPSHOT_{CRON,JOB_KIND,SCHEDULE_NAME}` and `NET_WORTH_CONSUMER_NAME` are re-exported from `@ctx/planning` rather than restated, so the names that reach a CHECK constraint have one definition.               |
| `apps/api/src/domain.ts` (`planningPortsFor`)        | The four snapshot ports — see §3.                                                                                                                                                                                                                                                                                        |
| `apps/api/src/domain.ts` (`createWalletRpcRuntime`)  | WP 3.6's Postgres `WalletAddressStore` over `wallet_addresses`, and the two egress transports — see §3.                                                                                                                                                                                                                  |
| `apps/api/src/domain.ts` (`createConnectorRegistry`) | The `walletRpc` option and the `WALLETRPC_PROVIDER`/`WALLETRPC_MANIFEST` registration. Deliberately **not** a credential feature-detection like Plaid's and Coinbase's: this connector is useful with no key at all.                                                                                                     |
| `apps/api/src/bootstrap-seed.ts`                     | The `planning.net_worth_snapshot` schedule, flag-gated, registered after the price refresh so the list reads in the order the night runs.                                                                                                                                                                                |
| `apps/api/src/worker.ts`                             | `userId` passed to `appModules`; the walletrpc runtime passed to `createConnectorRegistry`; **`WORKER_PINNED_CONNECTIONS` and `assertPoolCoversLeases`** — the cold walk's own finding, §9.2.                                                                                                                            |
| `apps/api/src/app.ts`                                | The walletrpc runtime, bound to the `database` built one line above it.                                                                                                                                                                                                                                                  |
| `apps/api/src/reports/export/registry.ts`            | `wallet_addresses` and `net_worth_daily` declared as deferred, each with its reason. The manifest-completeness test caught their arrival the day 0016/0017 landed, which is what it is for — the second time this phase.                                                                                                 |
| `packages/config/src/schema.ts`                      | `etherscan_api_key` in `SECRET_SPECS` (file-only, no `envFallback`, required for no role).                                                                                                                                                                                                                               |
| `compose.yml`                                        | `etherscan_api_key` declared, and added to **api and worker only**. `migrator` still has `secrets: [database_url]`.                                                                                                                                                                                                      |
| `justfile` (`harden-secrets`)                        | The 10001-owned loop grows from twelve files to thirteen, in the same edit — N-1's lesson, again.                                                                                                                                                                                                                        |
| `.env.example`                                       | `etherscan_api_key` documented with what it does and does not gate; the `CRYPTO_ALLOWED_HOSTS` note gains a narrowing example.                                                                                                                                                                                           |
| `RUNBOOK.md` ("Create secrets")                      | **Step 8**, the one the previous agent could not write: all seven optional Phase 3 secret files created empty, with what each buys and what happens without it. Closes §10 item 3.                                                                                                                                       |
| `apps/api/test/regate-worker-boot.test.ts`           | A source assertion re-gating §9.2's pool-sizing defect.                                                                                                                                                                                                                                                                  |

### Config and secrets

| File                                            | What changed                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config/src/schema.ts`                 | `MARKET_DATA_ALLOWED_HOSTS` and `CRYPTO_ALLOWED_HOSTS` in `environmentSchema`; `coinbase_key_name` and `coinbase_private_key` in `SECRET_SPECS` (file-only, no `envFallback`, required for no role). The four market-data keys were already there from WP 3.4. |
| `packages/config/src/load.ts`                   | `resolveNotificationsAllowedHosts` generalised to `resolveAllowedHosts(key, raw, example)` and called three times; `AllowedHostsConfig` and `CoinbaseConfig` types; `resolveCoinbase`; `config.marketData`, `config.crypto`, `config.coinbase`.                |
| `packages/config/src/index.ts`                  | Re-exports `AllowedHostsConfig`, `CoinbaseConfig`, `NotificationsConfig`.                                                                                                                                                                                      |
| `compose.yml:164-211`                           | Six new `secrets:` entries (`tiingo_api_key`, `fred_api_key`, `coingecko_api_key`, `openfigi_api_key`, `coinbase_key_name`, `coinbase_private_key`).                                                                                                           |
| `compose.yml` (`api.secrets`, `worker.secrets`) | All six added to **api and worker only**. `migrator` keeps `secrets: [database_url]`.                                                                                                                                                                          |
| `justfile` (`harden-secrets`)                   | The 10001-owned loop grows from six files to twelve, in the same edit that added them to `compose.yml` — the whole lesson of N-1.                                                                                                                              |
| `.env.example`                                  | A Phase 3 section: both allow-list variables with their _narrowing_ semantics spelled out, and all six secret file names with what each is for.                                                                                                                |
| `scripts/check-secret-ownership.sh`             | **Unchanged, deliberately.** It derives the expected owner and mode from `compose.yml`'s own `secrets:`/`user:` declarations, so the six new files are covered the moment they are declared. That is the property D-4 bought; a hand-edit here would undo it.  |

### Tests

| File                                                                             | What changed                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/phase3-registration.test.ts`                                      | **New**, 8 tests, `api` project (no database).                                                                      |
| `apps/api/test/db/phase3-wiring.test.ts`                                         | **New**, 4 tests, `api-db` project.                                                                                 |
| `apps/api/test/db/phase3-cold-install.test.ts`                                   | Extended: `price_source_priority` rows and the `integrations.price_refresh` schedule.                               |
| `apps/api/test/module-flag-defaults.test.ts`                                     | Both new flags documented with their defaults.                                                                      |
| `apps/api/test/domain.test.ts`                                                   | Plaid log-line assertions filtered by provider, now that Coinbase emits a feature-detection line of the same shape. |
| `packages/config/src/load.test.ts`                                               | +25 tests (see §6).                                                                                                 |
| `apps/api/test/db/{categorization-wiring,phase1-seed-e2e,phase2-wiring}.test.ts` | `investmentSyncPort: createInvestmentSyncPort(h.database.db)` at each `appModules` call site.                       |

---

## 3. The `domain.ts` adapters

Every cross-context read below is a port the owning context declared and this file implements. No
context imports another.

| Export                                                                    | What it bridges                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `securityResolverFor(executor, clock, figi?)`                             | WP 3.1's resolver, built **per transaction** so a `SecurityResolutionFailed` cannot outlive a rolled-back sync. An absent `figi` is a supported mode: the FIGI tier abstains by name and the weaker tiers still decide.                                                                                                             |
| `createInvestmentSyncPort(database, clock?)`                              | `@ctx/investments` ← `@ctx/connections` (`sync_runs`) and `@ctx/ledger` (`accounts`). `factsForRun` returns the run's provider and date with two empty arrays — see §5. `isRetirementAccount` matches `RETIREMENT_SUBTYPE_MARKERS` against the provider's free-text subtype; `isDigitalAsset` reads `securities.type === 'crypto'`. |
| `createMarketDataWriter(database)`                                        | `@ctx/integrations`' `MarketDataWriter` → `@ctx/investments`' `prices` / `fx_rates`. Idempotent on each table's own natural key.                                                                                                                                                                                                    |
| `createMarketDataRunRecorder(database)`                                   | `MarketDataRunRecorder` → `market_data_runs`. Nothing is redacted here: the message arrives already redacted, and a second pass would make the first untestable.                                                                                                                                                                    |
| `createMarketDataRuntime({ secrets, allowedHosts, clock?, logger? })`     | The four WP 3.4 adapters, feature-detected on their key files exactly as Plaid's credentials are, each behind `policyFor(provider)` — one host, https, :443. `createOpenFigiMapper` is assigned to `@ctx/investments`' `FigiMapper` port, which is where TypeScript checks the two structural mirrors still fit.                    |
| `hydrateMarketDataBudgets(database, userId, budgets, clock?)`             | `budget.hydrate` at boot from `market_data_runs`, so a restart does not reset the day's spend. Best-effort; the worker logs and continues.                                                                                                                                                                                          |
| `seedPriceSourcePriority(database, userId)`                               | `ladderRows(DEFAULT_LADDERS)` → `price_source_priority`, `onConflictDoNothing` so a repair pass never undoes a user's reordering.                                                                                                                                                                                                   |
| `drizzleTransactionalExecutor(database)` + `assertDrizzleTransaction(tx)` | The defect this batch found — see §4.                                                                                                                                                                                                                                                                                               |
| `createConnectorRegistry({ …, coinbase })`                                | WP 3.5's connector, feature-detected on `config.coinbase`. No credential is passed to the constructor: every request reads the sealed pair from the `ConnectionHandle`.                                                                                                                                                             |
| `planningPortsFor(executor, { userId, timeZone, clock })`                 | **New this run.** `@ctx/planning` ← `@ctx/ledger` (`accounts`, `account_balances`, `transactions`), `@ctx/investments` (`holdings`, `holdings_snapshots`, `prices`, `fx_rates`) and `@ctx/budgeting` (`budgets.off_budget_account_ids`). Built per transaction — see §3.1.                                                          |
| `createWalletRpcRuntime({ database, allowedHosts, etherscanApiKey })`     | **New this run.** WP 3.6's `WalletAddressStore` over `wallet_addresses`, plus one `@core/platform`-guarded transport per host — see §3.2.                                                                                                                                                                                           |

---

### 3.1 `planningPortsFor`, and the decisions inside it

**`prices` and `fx` are assigned straight through, with no adapter.** `@ctx/planning` declares
`PriceReader` and `FxReader` as deliberate structural mirrors of `@ctx/investments`' readers
(`ports.ts`'s own doc), so this assignment is where TypeScript checks the two halves still fit — the
same build-time check `createMarketDataRuntime`'s `FigiMapper` assignment is.

**`onBudget` is the one flag with a second source of truth.** `defaultFlagsFor(kind, inNetWorth)`
states 07 §4.1's class table; `budgets.off_budget_account_ids` overrides it, and only ever towards
`false`. The union across every budget rather than `budgets[0]`, so the answer does not depend on
`created_at` ordering the day a second budget exists. `isLiquid` and `isInvestable` still have no
column anywhere (wp3.8-net-worth.md §7 records the gap); `planningKindOf` is where the two mappings
that are decisions rather than transcription live — `crypto → investment`, because selling BTC to buy
groceries is not what 07 §4.1 means by liquid, and `manual` splitting on `classification`.

**`accounts()` ignores its `asOf` and carries `closedAt` instead.** `accounts` is not a versioned
table, so "which accounts existed on 2025-03-04" has no honest answer from it — and `computeNetWorth`
already refuses to count an account from the day it closed. Filtering here _and_ there would be two
copies of one rule.

**`transactionsTotalOn` sums what moved, not what a report would count.** `user_excluded` rows and
transfers are **included** — excluding a transaction from the budget does not un-spend the money, and
subtracting a smaller sum reconstructs a balance the bank never held; superseded and
provider-removed rows are excluded.

**Local days, not UTC days.** `account_balances.as_of` is a `timestamptz` and
`balanceOnOrBefore(userId, accountId, date)` is a question about a local calendar day (08 §3.5), so
the reader compares `(as_of AT TIME ZONE <holder's zone>)::date`. Truncating in UTC would move a
21:00-local observation onto the next day for every holder west of Greenwich.

**One holder, checked rather than assumed.** `SnapshotJobDependencies.portsFor` receives the job's
transaction and no user id, so `planningPortsFor` closes over `ModuleWiringOptions.userId` (D6 — the
same assumption `secretBoxFor: () => options.secretBox` already makes). That is not left to a
comment: `planningModule` wraps the job registration and refuses, **by name**, a job whose
`context.userId` differs. Without it, user B's net worth would be computed from user A's prices and
A's ladder — a wrong number, no error, and invisible in every test that has one user. Asserted in
`phase3-registration.test.ts`. The clean fix is `@ctx/planning`'s: §10 item 7.

### 3.2 `createWalletRpcRuntime`, and the ordering defect it surfaced

The store resolves every call through `connections.(provider, provider_connection_id)` — the natural
key `createConnection` writes and `findByProviderKey` already reads — so a wallet linked by the api
is findable by the **worker**. That matters more here than for CSV or Manual: `wallet_rpc` is not in
`PROCESS_LOCAL_PROVIDERS`, so every wallet sync runs in the worker and nowhere else.

The two transports are `@core/platform`'s `guardUrl` + `createNodeTransport` + `classifyStatus`, with
**one host each**, https/:443 only, no redirect followed, a bounded body — and `CRYPTO_ALLOWED_HOSTS`
able only to narrow. `@connector/walletrpc` imports none of that (its boundary layer forbids it) and
takes a function instead; its own contribution is that `ESPLORA_HOST` and `ETHERSCAN_HOST` are
source-code constants, so no xpub, address or label a user types can become the destination host.

**The defect, named rather than worked around.** `createConnection` calls `connector.connect()`
**before** it inserts the `connections` row, and does both inside one transaction. So at the moment
`WalletRpcConnector.connect()` calls `store.put()` there is no `connections.id` for
`wallet_addresses.connection_id` to reference, and no row this pool-backed store could see if there
were. `put` therefore upserts only when the connection resolves — the **re-link** path, where a
changed descriptor or label must land — and otherwise stages the record for
`persistPending(providerConnectionId, { connectionId, userId })`.

**`persistPending` has no caller yet.** Wiring it belongs with WP 3.6's link ceremony in
`routes/connections.ts`, and the clean fix is a `packages/connectors/**` change this batch may not
make: `WalletAddressStore.put` should carry the connection identity, or the connector should flush
from a `ConnectionHandle` the way `CsvImportConnector` does. Until one of the two lands, **a first
link of a watch-only wallet will not persist its descriptor** — §10 item 8. The registry entry, the
manifest, the egress binding and the secret are all real and proven on the cold walk; the link
ceremony is the seam left open, and it is left open loudly.

---

## 4. The defect this batch found: `ConsumerContext.tx` is not a Drizzle handle

**Symptom.** `investments.lots@v1 failed on event seq 3: db.insert is not a function`, recorded in
`event_consumer_offsets.failed_error` and nowhere a reader would look.

**Cause.** `@core/platform`'s `platformExecutor` (`packages/platform/src/database.ts:21-29`) builds a
_fresh object_ carrying only `execute` and discards the Drizzle transaction. Every Phase 1 and Phase 2
consumer is fine with that — they write raw SQL. WP 3.2's lot consumer is the first that is not:
`createLotConsumer` takes `storeFor(context)` as a factory over the pump's transaction precisely so a
`LotsUpdated` cannot outlive a rolled-back derivation, and `drizzleLotStore` is written against
Drizzle's query builder.

**Fix, inside the composition root's remit.** `createConsumerPump` takes its `TransactionalExecutor`
from the caller, and the caller is this application. `drizzleTransactionalExecutor` passes the Drizzle
transaction through; it satisfies `Executor` structurally, so every existing consumer is unaffected,
and the one consumer that needs more finds it. `assertDrizzleTransaction` turns the recovery from a
cast into a checked contract that fails **by name** at the boundary.

**Sabotage, observed red.** `phase3-wiring.test.ts` → _"a pump built with platformExecutor is refused
by name, not by a TypeError five frames down"_ runs `assertDrizzleTransaction` against a real
`platformExecutor` transaction and asserts the guard's message, not merely that it threw.

**Owed to `@core/platform`, and not this wave's to make:** `ConsumerContext` should carry the
transaction's database handle as a declared field rather than leaving it to be recovered structurally.
Until then the guard is what keeps the arrangement honest.

**Second defect, same file.** `factsForRun` read `sync_runs.started_at` as a `Date`; a raw `execute`
returns a `timestamptz` **string**, so the first real sync run this port ever saw threw
`startedAt.toISOString is not a function`. Both shapes are handled now, with the reason in the code.

**Third, found by the same test.** `investment_transactions.security_id` carries a foreign key into
`securities`, so the wiring test uses the _real_ `securityResolverFor` to place a security rather than
a fabricated UUID — which is a better test than the one originally written.

---

## 5. What is honest-but-empty today, and why that is the right shape

`createInvestmentSyncPort(...).factsForRun` returns the run's provider and date with **no holdings and
no transactions**. No provider leg persists such a fact yet: `@connector/port` grew
`ProviderHoldingFact` and `ProviderInvestmentTransactionFact` in WP 3.1, and `@connector/coinbase` can
produce them, but the orchestrator legs that call `syncHoldings` / `syncInvestmentTransactions` and
write the results down are **WP 3.7's**.

Registering the consumer anyway buys one thing and costs nothing: the consumer's offset advances over
the full event history from first boot, so WP 3.7's first run is not _also_ a replay of every
`connections.SyncRunCompleted` ever recorded (08 §3.4 — a new context's consumer starts at `seq = 0`).
WP 3.7's change is confined to this one function; nothing in `modules.ts` or `@ctx/investments` moves.

The same reasoning applies to `MarketDataWiringOptions.planFor`, which defaults to the empty plan.

---

## 6. Tests added, with counts

| Project  | File                                  | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`    | `test/phase3-registration.test.ts`    | **8 new** — every `INVESTMENTS_EVENTS` / `INTEGRATIONS_EVENTS` type is registered; event names are namespaced to their context; **schedule/job/event names match the CHECK constraints read out of `packages/db/migrations/0003_platform.sql` itself**, not a copy; the job kind, schedule name and cron are the documented ones; the lot consumer's name and filter; `module.integrations` registers a job and a schedule and no consumer; it registers events _only_ when no market-data wiring is supplied; and a flag that is off contributes no event, consumer, job or schedule. |
| `api`    | `test/module-flag-defaults.test.ts`   | 2 existing, extended to cover both new flags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `api`    | `test/domain.test.ts`                 | 3 existing, updated for the Coinbase log line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `api-db` | `test/db/phase3-wiring.test.ts`       | **4 new** — the pump/transaction proof and its rollback sabotage; the `platformExecutor` guard sabotage; the real `InvestmentSyncPort` answering honestly for a real `sync_runs` row; `isRetirementAccount` over a real `accounts` row including the `roth ira` case.                                                                                                                                                                                                                                                                                                                  |
| `api-db` | `test/db/phase3-cold-install.test.ts` | 1 existing, extended — a user created **after boot** has all `price_source_priority` rows (pinned rungs 1 and 99 included) and the `integrations.price_refresh` schedule, with no restart.                                                                                                                                                                                                                                                                                                                                                                                             |
| `config` | `src/load.test.ts`                    | **+25** — 118 → 143. Nine each for `MARKET_DATA_ALLOWED_HOSTS` and `CRYPTO_ALLOWED_HOSTS` (default, parse, de-dup, IPv4 literal, IPv6 literal, wildcard, bad hostname, empty-means-no-override, and _names itself in the problem_ so the generalisation cannot cross-wire two lists), and seven for the Coinbase secret pair including "carries no credential on the config object" and "never echoes the private key into a boot problem".                                                                                                                                            |

Run counts at the close of the batch: `--project api` **68 passed** (1 pre-existing failure, see §8);
`--project api-db phase3` **5 passed**; `--project config` **143 passed**.

---

## 7. OpenAPI

**No route changed and the spec is byte-identical.** This batch registers events, consumers, a job
handler and a schedule; it adds no handler to `apps/api/src/routes/`. `just openapi` and
`pnpm --filter @app/web gen` were run and left `packages/contracts/openapi/openapi.json` and
`apps/web/src/api/generated/` unmodified — confirmed by `git diff --exit-code` on both paths.

---

## 8. `just verify`

<!-- filled in below, after the cold walk -->

---

## 9. Cold walk — **completed**

The section this batch owed. Run twice: once as the previous agent left it (which is what found the
integrations manifest defect, kept below because the finding is the record), and once to completion
after that defect and the one _this_ run found were both fixed.

```
docker compose down -v          # clean: volumes removed, not just containers
docker compose up -d --build    # image rebuilt from this working tree
```

### 9.1 First pass — the undeclared-dependency defect (fixed before the second)

`db` healthy; `migrator` exited 0 with `migrations complete: 16 applied, 0 already present`, including
`0013_securities`, `0014_lots`, `0015_market_data` and `0016_wallet_addresses` against a genuinely
empty volume. `api` and `worker` then both crash-looped, with the entrypoint's own diagnosis
(redacted only of container ids):

```
api-1  | entrypoint: ROLE=api target "./apps/api/src/main.ts" exists, but something it imports does not resolve.
api-1  |   Cannot find package '@core/platform' imported from /app/packages/contexts/integrations/src/events.ts
```

**Cause — not the Dockerfile.** `packages/contexts/integrations/package.json` declared three
dependencies and its source imported five; `@core/platform` and `zod` were undeclared. Invisible in
development, because pnpm hoists both into the workspace root `node_modules` and Node's resolution
walks up to find them. The production image is
`pnpm install --frozen-lockfile --prod --filter-prod=@app/api...`, which materialises only each
project's declared closure, so the walk-up finds nothing. Third instance of the failure mode
`docker/api.Dockerfile`'s header documents, and the first caused by a _manifest_ rather than by the
prune. Declared in `123c767`; an audit of every package in `apps/api`'s closure found no other
undeclared runtime import.

### 9.2 Second pass — the defect the cold walk exists to find

With the manifests fixed, `api` and `worker` both start. And then the worker does nothing, for ever,
without crashing.

**Observed**, on a fresh volume with an account holder and seven registered consumers:

- all ten pool connections checked out and **idle**, `pg_stat_activity` showing exactly
  `3 × LISTEN` (`personalfi_feature_flags`, `personalfi_domain_events`, `personalfi_jobs`),
  `2 × pg_try_advisory_lock($1::bigint)` and `5 × pg_try_advisory_lock($1::int, $2::int)`;
- `worker ready` **never logged** — `main()` was queued inside `outboxHealth` on an eleventh
  connection that could never arrive;
- `job-runner.heartbeat` and `scheduler.heartbeat` both frozen ~14 s after boot and never touched
  again;
- the process alive at **0 % CPU**, `/proc/7/wchan = do_epoll_wait`, `RestartCount=0`, no error line
  anywhere in the log, no crash and no restart.

**Cause.** The worker pins a connection per `LISTEN` channel (3), per leader lease (scheduler, job
reaper — `tryAcquireAdvisoryLease` holds the `pg.PoolClient` for the life of the lease, which is what
makes "this process is the scheduler until it dies" true) and **per registered consumer**
(`createConsumerPump`'s `leases` map, released only in `stop()`). That is `5 + consumers`, pinned
before the process does one unit of work — and `DATABASE_POOL_MAX=10` was being read as the _whole_
pool rather than as the working headroom. Seven consumers means twelve pinned against ten: a
self-inflicted deadlock, not a load problem. The pool is not busy, it is pinned.

**Attribution, measured rather than assumed.** Disabling `module.planning` through a real
`feature_flags` row and restarting left the worker with six consumers — and `worker ready` still never
logged, the heartbeats still froze, and `pg_stat_activity` still showed 10/10. So this is **not**
WP 3.8's consumer: the margin had already gone. It disappeared when the sixth consumer
(`investments.lots@v1`, snapshot `123c767`) landed on an install that also has
`advisor_token_secret` present — five Phase 2 consumers plus one is `5 + 6 = 11 > 10`. Nothing said
that adding a consumer is a pool-sizing change.

**Fix, inside the composition root's remit** (`apps/api/src/worker.ts`):
`WORKER_PINNED_CONNECTIONS = 3 + 2 + MODULE_FLAGS.length`, added to `DATABASE_POOL_MAX` when the
worker builds its pool — so the operator's number means what an operator reads it to mean
(connections available for queries) and the reservation grows with the module list by construction.
`assertPoolCoversLeases` then re-checks the arithmetic at the one moment the real consumer count is
known, and logs an error **naming both sides**, because a pool that cannot cover its pinned
connections does not fail, it hangs.

**What noticed, and what did not.** No test did. No log line did. `docker compose ps` said
`healthy` for the first thirty seconds. The only thing that caught it was D-3's liveness healthcheck —
`job-runner heartbeat missing or stale (age=71335ms max=15000ms)` — which is exactly the failure mode
N-4 added it for, and this is the first time it has caught one in the shipped image. Re-gated as a
source assertion in `apps/api/test/regate-worker-boot.test.ts`.

### 9.3 Third pass — the cold walk, completed

`docker compose down -v && docker compose up -d --build`, fresh volume, with both fixes in place.

| Observation                     | Result                                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrator`                      | exit **0**, `migrations complete: **17 applied, 0 already present**`, ending `applied 0016_wallet_addresses in 9ms` / `applied 0017_net_worth_daily in 14ms`                                                                                       |
| `api`                           | `running (healthy)`, `RestartCount=0`, up > 60 s with no crash-loop                                                                                                                                                                                |
| `worker`                        | `running (healthy)`, `RestartCount=0`, up > 60 s; `worker ready` logged **12 s** after start                                                                                                                                                       |
| api connector registration      | `plaid configured; connector registered` (this box has Sandbox key files), `coinbase not configured; connector not registered`, and `walletrpc connector registered` with `hosts:["blockstream.info","api.etherscan.io"]`, `etherscanKey:"absent"` |
| worker market-data registration | four `… not configured; price source not registered` lines — the zero-key install `module.integrations: true` depends on                                                                                                                           |
| enabled modules                 | `["module.ledger","module.connections","module.categorization","module.budgeting","module.recurring","module.notifications","module.insights","module.investments","module.integrations","module.planning"]`, `disabled: []`                       |
| registered consumers            | `["categorization.assignments@v1","budgeting.actuals@v1","recurring.detection@v1","notifications.rules@v1","insights.advisors@v1","investments.lots@v1","planning.net_worth@v1"]`                                                                  |
| registered job kinds            | `[…,"integrations.price_refresh","planning.net_worth_snapshot"]` — both Phase 3 jobs present                                                                                                                                                       |
| liveness                        | `job-runner.heartbeat age_ms=154`, `scheduler.heartbeat age_ms=10208` — both fresh, i.e. both loops turning                                                                                                                                        |

**`just bootstrap-user name="Cold Walk Holder" timezone="America/New_York"`** (enrolment token
deliberately not recorded here — it is single-use, stored only as a SHA-256 digest, and printed once):

```
user created      Cold Walk Holder (<uuid>)
time zone         America/New_York
taxonomy          153 categories seeded
advisors          31 manifests registered
schedules         categorization.retrain_weekly, notifications.deliver, notifications.digest,
                  insights.nightly, integrations.price_refresh, planning.net_worth_snapshot
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 5024 ms · KEK generation 1
```

Both Phase 3 schedules are seeded **at user creation**, with no restart — condition C-1's claim,
observed rather than asserted against a test database. (31 advisor manifests, not 14: the concurrent
WP 3.10 catalogue expansion was in the working tree this image was built from. Attributed, not this
batch's.)

**`docker compose exec db psql` — `schedules` for the new holder:**

```
categorization.retrain_weekly | categorization.retrain       | 0 4 * * 0  | America/New_York | t | 1800 | 2026-09-27 08:00:00+00
connections.nightly_sync      | connections.sync_all         | 15 3 * * * | America/New_York | t | 1200 | 2026-09-24 07:15:00+00
insights.nightly              | insights.run_all             | 15 4 * * * | America/New_York | t |  180 | 2026-09-24 08:15:00+00
integrations.price_refresh    | integrations.price_refresh   | 45 3 * * * | America/New_York | t |  900 | 2026-09-24 07:45:00+00
notifications.deliver.<uuid>  | notifications.deliver        | */5 * * * *| America/New_York | t |   30 | 2026-09-24 00:10:00+00
notifications.digest.<uuid>   | notifications.digest         | 5 * * * *  | America/New_York | t |   60 | 2026-09-24 01:05:00+00
planning.net_worth_snapshot   | planning.net_worth_snapshot  | 0 4 * * *  | America/New_York | t |  600 | 2026-09-24 08:00:00+00
```

The two numbers worth reading twice: `integrations.price_refresh` next runs at **07:45 UTC** and
`planning.net_worth_snapshot` at **08:00 UTC**, which are 03:45 and 04:00 in `America/New_York`. The
cron is resolved in the holder's zone, not the container's — which is the assertion that would have
failed if either had been registered in UTC (08 §3.7).

**`price_source_priority` for the new holder: 24 rows**, across all seven security kinds
(`bond` 3, `cash` 2, `crypto` 4, `equity` 4, `etf` 4, `mutual_fund` 4, `other` 3), every kind's rungs
running from 1 to 99 — the two values `0015_market_data.sql` pins by CHECK (`user_override` first,
`last_known` last).

### 9.4 One thing the cold walk shows that is not a defect of this batch

On a genuinely cold install the worker starts **before** any account holder exists, logs
`no account holder yet; the worker will idle until one is enrolled`, and does not re-check. So
`just bootstrap-user` must be followed by a worker restart before the modules resolve for that
holder. That is `worker.ts`'s stated behaviour ("come back after a restart rather than
crash-looping") and it is why the RUNBOOK's first-install order matters; it is recorded here because
it is the reason this walk restarts the worker after step 7, not because it changed.

### 9.5 Teardown

`docker compose down` (volumes preserved) and the seven placeholder secret files removed, so
`just check-secret-ownership` stays green on a working tree that has no real provider keys.

---

## 10. Open, and owed

1. **`ConsumerContext` should carry a database handle** (§4). A `@core/platform` change this wave may
   not make; `assertDrizzleTransaction` is the interim guard.
2. **`factsForRun` is empty until WP 3.7** (§5). Named, not worked around.
3. ~~**The six new secret files must exist before `docker compose up`.**~~ **Closed.** `RUNBOOK.md`
   "Create secrets" step 8 now creates all **seven** (the six plus WP 3.6's `etherscan_api_key`),
   empty, with what each one buys.
4. **`just harden-secrets` needs `sudo`** and could not be run non-interactively here. The recipe is
   updated and correct — `check-secret-ownership` derives `etherscan_api_key`'s expected owner from
   `compose.yml` with no edit of its own, which is the property D-4 bought — but running it is an
   operator step.
5. ~~**`gate-image-closure.test.ts` fails against a stale `personalfi/api:dev`.**~~ **Closed.** The
   cold walk's `--build` cleared it; `--project api` is 72/72 green.
6. **`MARKET_DATA_ALLOWED_HOSTS` narrows by _host_, not by provider name.** Unchanged; a Phase 9
   polish item, not a correctness gap. The same is now true of `CRYPTO_ALLOWED_HOSTS`.
7. **`SnapshotJobDependencies.portsFor` should take the job's `userId`** (§3.1). Until it does, the
   composition root binds one holder and `planningModule` refuses a job for any other by name. A
   `@ctx/planning` change, which this batch may not make.
8. **`WalletAddressStore.put` cannot persist on a first link** (§3.2), because `createConnection`
   calls `connect()` before it inserts the `connections` row. `persistPending` exists and is
   unwired; the real fix is either a `routes/connections.ts` call at the end of the link ceremony or
   a `@connector/walletrpc` change so `put` carries the connection identity. **A watch-only wallet
   cannot be linked end to end until one of the two lands** — the registry entry, egress binding and
   secret are proven, the link ceremony is not.
9. **`net_worth_daily` and `wallet_addresses` are deferred from the export bundle, not excluded**
   (§2). `net_worth_daily` in particular carries correction provenance a recomputation cannot
   rebuild, so it belongs in a bundle with its revision ladder intact — WP 3.7's batch.
10. **`packages/contexts/insights/**` was being edited concurrently (WP 3.10) while this ran.**
    `pnpm lint:schema-ownership` is red on
    `packages/contexts/insights/src/advisors/builtin/crypto/positions.ts` — _"raw SQL references
    `securities`, which is owned by `@ctx/investments`"_ — and the advisor catalogue is 31 manifests
    rather than 14. Both are that work package's, attributed here and deliberately untouched.
