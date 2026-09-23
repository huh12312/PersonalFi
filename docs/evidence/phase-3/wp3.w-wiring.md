# WP 3.w — the Wave A′ wiring batch

_The composition-root work `docs/plan/03-phase-3-dispatch.md` §4 reserves for the orchestrator: items
**3** (`MODULE_FLAGS`), **4** (`modules.ts` / `domain.ts`), **7** (the OpenAPI regeneration) and **8**
(the config-and-secrets batch). Items 1, 2, 5, 6 and 9 were applied before or during this batch by the
orchestrator. Same shape and same format as
[`docs/evidence/phase-2/wp2.w-wiring.md`](../phase-2/wp2.w-wiring.md), the batch this one follows._

---

## 1. Flags, and their final defaults

Both landed `defaultEnabled: false` and were flipped `true` at the end of the batch, in that order,
with `apps/api/test/db/phase3-wiring.test.ts` green in between. The flip is the whole reason the
dispatch reserves this work for the orchestrator: a context can prove its own engine, and only the
composition root can prove it is wired.

| Flag                  | Landed  | Final      | What made the flip defensible                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module.investments`  | `false` | **`true`** | `phase3-wiring.test.ts` drove a real `connections.SyncRunCompleted` through the real pump into `@ctx/investments`' lot consumer, which opened a real lot and appended a real `investments.LotsUpdated`. Inert on an install with no investment accounts: `InvestmentSyncPort.factsForRun` returns no facts until WP 3.7's provider legs land, and a derivation over no facts writes nothing. |
| `module.integrations` | `false` | **`true`** | Same file: the `integrations.price_refresh` job registers, the schedule row lands through the real `upsertSchedule`, and `createMarketDataRuntime` on a zero-key install registers **no** `PriceSource` at all — so the refresh runs, asks nobody and records that honestly. 03 §6: "Phase 3 completes with zero keys."                                                                      |

`apps/api/test/module-flag-defaults.test.ts` pins both, and its "nothing undocumented sneaked in"
assertion means a third Phase 3 flag cannot appear without a line there and in `RUNBOOK.md`.

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

## 9. Cold walk — **BLOCKED, and it found a real defect**

```
docker compose down -v          # clean
docker compose up -d --build    # image rebuilt from this working tree
```

**What went right.** `db` healthy; `migrator` exited 0 with `migrations complete: 16 applied, 0
already present`, including `0013_securities`, `0014_lots`, `0015_market_data` and
`0016_wallet_addresses` against a genuinely empty volume; all nine Phase 3 tables present
(`securities`, `holdings`, `holdings_snapshots`, `investment_transactions`, `cost_basis_lots`,
`prices`, `fx_rates`, `price_source_priority`, `market_data_runs`).

**What went wrong.** `api` and `worker` both crash-loop, with the entrypoint's own diagnosis
(redacted only of container ids):

```
api-1  | entrypoint: ROLE=api target "./apps/api/src/main.ts" exists, but something it imports does not resolve.
api-1  |   Cannot find package '@core/platform' imported from /app/packages/contexts/integrations/src/events.ts
api-1  |   This usually means the image build pruned a workspace package that is in the
api-1  |   production dependency closure. Check api.Dockerfile's deploy stage.
worker-1  | entrypoint: ROLE=worker target "./apps/api/src/worker.ts" exists, but something it imports does not resolve.
worker-1  |   Cannot find package '@core/platform' imported from /app/packages/contexts/integrations/src/events.ts
```

**Cause — not the Dockerfile.** `packages/contexts/integrations/package.json` declares three
dependencies (`@core/db`, `@core/kernel`, `drizzle-orm`) and its source imports **five**. Two are
undeclared:

| Imported by                                                           | Undeclared dependency |
| --------------------------------------------------------------------- | --------------------- |
| `src/events.ts`, `src/egress.ts`, `src/http.ts`, `src/market-data.ts` | `@core/platform`      |
| `src/events.ts`, `schema/market-data.ts`                              | `zod`                 |

This is invisible in development because pnpm hoists both into the workspace **root**
`node_modules`, and Node's resolution walks up and finds them there. The production image is
`pnpm install --frozen-lockfile --prod --filter-prod=@app/api...`, which materialises only each
project's declared closure — so the walk-up finds nothing and the first import of
`@ctx/integrations` fails. Exactly the failure mode `docker/api.Dockerfile`'s header documents twice
already (`@ctx/identity` in Phase 0, `packages/connectors` in Phase 1); this is the third instance
and the first caused by a _manifest_ rather than by the prune.

An audit of every package in `apps/api`'s closure found no other undeclared runtime import.

**The exact fix, which this batch may not make** (`packages/contexts/**` is outside its allowed paths,
and so are `package.json` and the lockfile). In `packages/contexts/integrations/package.json`:

```json
  "dependencies": {
    "@core/db": "workspace:*",
    "@core/kernel": "workspace:*",
    "@core/platform": "workspace:*",
    "drizzle-orm": "0.45.2",
    "zod": "4.5.4"
  },
```

`@core/platform` and `zod` are the two added lines; the versions match `@ctx/investments`'
`package.json` exactly, so no new third-party version enters the tree and `THIRD_PARTY.md` does not
move. It needs one `pnpm install` afterwards — `--frozen-lockfile` in the image build will refuse a
manifest the lockfile does not match — and then `docker compose down -v && docker compose up -d
--build` re-run to complete this section.

**Therefore not yet observed on the cold path, and owed to the Phase 3 gate:**

- the api booting with `module.investments` and `module.integrations` in its enabled list;
- the worker registering `integrations.price_refresh` **without a crash-loop** (the Phase 2 lesson);
- the `schedules` row for `integrations.price_refresh` existing after `just bootstrap-user`;
- the `price_source_priority` rows for a user created after boot.

All four are asserted against a real database by `phase3-wiring.test.ts` and
`phase3-cold-install.test.ts`, which is _not_ the same thing as observing them in the shipped image,
and this section should not be read as if it were.

The stack was left `docker compose down` (volumes preserved) and the six placeholder secret files
removed, so `check-secret-ownership` stays green.

---

## 10. Open, and owed

1. **`ConsumerContext` should carry a database handle** (§4). A `@core/platform` change this wave may
   not make; `assertDrizzleTransaction` is the interim guard.
2. **`factsForRun` is empty until WP 3.7** (§5). Named, not worked around.
3. **The six new secret files must exist before `docker compose up`.** Compose has no optional-secret
   model. `RUNBOOK.md` "Create secrets" needs a step for them; **`RUNBOOK.md` is outside this batch's
   allowed paths**, so it is recorded here and in `.env.example` instead.
4. **`just harden-secrets` needs `sudo`** and could not be run non-interactively in this environment.
   The recipe is updated and correct; running it is an operator step.
5. **`gate-image-closure.test.ts` fails against a stale `personalfi/api:dev`** until the image is
   rebuilt — the dependency batch added four workspace projects to `apps/api`'s runtime closure. The
   cold walk's `--build` is what clears it.
6. **`MARKET_DATA_ALLOWED_HOSTS` narrows by _host_, not by provider name.** An operator switching one
   source off has to know which host belongs to which provider; `.env.example` lists all four. A
   provider-name form would be friendlier and is a Phase 9 polish item, not a correctness gap.
