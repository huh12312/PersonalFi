# WP 4.12b — Phase 3 gate conditions, backend half (second pass)

Finishing agent for the second pass over `docs/evidence/phase-3/gate-security-review.md`
§6's conditions, after a session-limit kill left C-10/C-1/C-6/C-5/C-7 code and tests on
disk (snapshot commit `2fbaf46`, `wip: … NOT for push`) with no evidence. This document
covers that snapshot's verification, C-7's completion, the Wave C wiring handover
(`wp4.w-wave-c-wiring.md` §4), and as many of C-3/C-8/C-11/C-12/C-4/C-16 as the session
reached. C-13 was investigated and is left for 4.12c (§9).

**A note on working conditions.** For most of this session another agent (WP 4.8, later
WP 4.9) was live in the same working tree, landing `apps/api/src/app.ts`,
`routes/plan.ts`, `routes/goals.ts`, `routes/advisor-grants.ts`, `routes/deps.ts`,
`routes/domain-errors.ts` and `docs/plan/01-execution-log.md`. None of those files are
touched here. Several `tsc -b` and route-level test runs below transiently failed against
that agent's in-flight state (a missing route file, then two pre-existing type errors in
`routes/goals.ts` unrelated to this WP) and were re-run once it stabilised; every `tsc`
and test result quoted below is from a run where the only errors, if any, are in
`routes/plan.ts`/`routes/goals.ts` (excluded explicitly, called out each time) — never in
a file this WP owns.

---

## 1. C-10 — `SnapshotBuilder` FX conversion (G3-13)

**State verified as-is, no code change needed beyond a version decision.**

`packages/contexts/insights/src/snapshot/builder.ts`'s `#netWorth`/`#cash` already convert
every non-base-currency account through an optional `FxPort` (`snapshot/ports.ts`),
excluding (never folding in at par) an account whose currency has no rate, and naming the
exclusion in `excluded_currencies`. `apps/api/test/insights-fx-summary.test.ts` (5 tests)
proves it against a CAD account, with and without an `FxPort`.

**Contract version decision.** The `excluded_currencies` field is additive (new optional
key in two existing, already-grantable snapshot blocks) and adds no new scope — per the
brief's own instruction, that means a **minor** bump, not a widening migration. Bumped:

- `packages/contracts/src/index.ts`: `ADVISOR_CONTRACT_VERSION` `'1.1.0'` → `'1.2.0'`
- `packages/contexts/insights/src/contract/json-schema.ts`: `ADVISOR_ARTEFACT_VERSION`
  `'1.1.0'` → `'1.2.0'`
- `packages/contracts/advisor/advisor.schema.json`: `artefactVersion` bumped by hand (this
  file is not emitted by `advisorSchemaDocuments()`; `contract-parity.test.ts`'s second
  test reads it directly and would have gone red otherwise)
- Regenerated `packages/contracts/advisor/v1/{request,response,manifest}.schema.json` with
  the exact command `wp3.10-advisor-catalog-v2.md` §9.1 specifies, then
  `pnpm exec prettier --write` (the generator's raw `JSON.stringify` output is not
  prettier-formatted; the semantic diff before formatting was version-stamp-only)
- `ADVISOR_CONTRACT_MAJOR` unchanged at `1` — no scope added, no wire-major bump

`pnpm exec vitest run --project insights --project insights-db`: **213 passed (22 files)**,
including `contract-parity.test.ts`'s three assertions (byte parity, index document, the
two version numbers agreeing).

**Sabotage (re-run, not newly written).** `builder.ts`'s `#netWorth` loop reverted to the
pre-fix `Money.add(assets, account.balance)` with no conversion:

```
- for (const account of open) {
-   const converted = await this.#convertToBase(...)
-   ...
- }
+ for (const account of open) {
+   if (account.balance.minor >= 0n) assets = Money.add(assets, account.balance);
+   else liabilities = Money.add(liabilities, Money.absolute(account.balance));
+ }
```

Red: 3 of 5 tests in `insights-fx-summary.test.ts` fail with
`CurrencyMismatchError: cannot combine USD with CAD`. Restored; `git diff --stat` on
`builder.ts` is empty; re-ran green (5/5).

---

## 2. C-1 — worker polls for the account holder in place (G3-1)

**State verified as-is.** `apps/api/src/worker.ts`'s `awaitAccountHolder` loops on
`findPrimary()` with a real (not `unref()`'d) `setTimeout`, and `main()`'s no-holder
branch calls it and never returns while idle — the second `if (user === null)` handles
only the `stopping` case. `apps/api/test/worker-account-holder-poll.test.ts` (5 tests):
resolves from one call across null/null/user, stops without sleeping once `isStopping()`
flips mid-poll, and two source-shape assertions (no early `return;` before the poll; the
`sleep()` helper does not call `.unref()`).

**Both sabotages re-run against the real source, not reproduced:**

1. `sleep(ms)`: `setTimeout(resolve, ms)` → `setTimeout(resolve, ms).unref()`. Red:
   1 test fails (`sleepFn must not include unref`). Restored, `git diff --stat` empty.
2. `main()`'s no-holder branch: added `return;` immediately after the
   `logger.warn(...)` line, before `awaitAccountHolder(...)`. Red: 1 test fails (`the
   no-holder branch returns before polling`). Restored, `git diff --stat` empty.

Re-run green: `worker-account-holder-poll.test.ts` + `worker-pool-guard.test.ts` (below),
**11/11**.

---

## 3. C-6 — pool guard fails the boot (G3-5)

**State verified as-is.** `assertPoolCoversLeases` (exported, with `WORKER_PINNED_CONNECTIONS`)
throws `PoolCannotCoverPinnedConnectionsError` (`packages/platform/src/errors.ts`) rather
than logging and continuing. `apps/api/test/worker-pool-guard.test.ts` (6 tests) calls the
real exported function directly.

**Both sabotages re-run against the real source** (the test file's own comments call
these "reproduced," i.e. re-derived inside the test rather than by editing `worker.ts`;
re-run here against the actual file instead, since a re-derivation is not what the RULES
ask for):

1. `worker.ts`: `if (poolMax > pinned) return;` → `if (poolMax > pinned || true) return;`.
   Red: **4 of 6** tests fail (the guard never throws). Restored.
2. `worker.ts`: `WORKER_PINNED_CONNECTIONS`'s consumer term `MODULE_FLAGS.length` →
   `0 * MODULE_FLAGS.length`. Red: **2 of 6** tests fail (`correctPoolMax` no longer
   throws at real numbers; the exported constant itself disagrees with the arithmetic).
   Restored.

`git diff --stat` on `worker.ts` after both restores: empty. Re-run green, 6/6.

---

## 4. C-5 — encrypted export (G3-4)

**State verified as-is.** One recipients filename, `age_recipient` (singular), across
`bundle.ts`'s default, `compose.yml`'s secret and its `api`/`backup` mount, `justfile`'s
`harden-secrets`, and RUNBOOK.md. `age` is pinned in `docker/api.Dockerfile`'s runtime
stage (`age=1.3.1-r6`, same Alpine 3.24 index `docker/backup.Dockerfile` already pins
against). `apps/api/test/db/export-encrypt.test.ts` (age present, real binary) and
`export-encrypt-age-absent.test.ts` (T13-5b's isolated branch: recipients file present,
`PATH` emptied so the real `ENOENT` fires) both green — 5 tests.

**T13-5b re-run against the real source.** `bundle.ts`'s `child.on('error', ...)`:

```
- if (error.code === 'ENOENT') reject(new AgeUnavailableError('the `age` binary is not on PATH'));
+ if (error.code === 'ENOENT') resolve(Buffer.from(plaintext));
```

Red: 2/2 tests in `export-encrypt-age-absent.test.ts` fail (`encryptWithAge` resolves
with the plaintext bytes instead of rejecting). Restored, `git diff --stat` empty.

**Fixed in this pass:** a stale comment in `apps/api/src/routes/export.ts`
(`ExportRouteOptions.secretsDir`'s doc still said `age_recipients`, plural) corrected to
`age_recipient`.

**check-secret-ownership.sh, real run on this host:** correctly reports `age_recipient`
as owned `10002:10002` mode `0400` (the pre-C-5 single-consumer shape) rather than the
new `10001:10002` mode `0440` two-consumer shape — this is RUNBOOK.md's own documented,
expected finding (`just harden-secrets` needs re-running with `sudo`, which this session
did not do, matching the RULES' no-destructive-host-ops posture). Not a regression.
`compose-hardening-check.sh --self-test && compose-hardening-check.sh`: **PASS**, 0
violations across all three compose files, both before and after this session's compose
changes (§7).

**Not re-walked live** (unchanged from the snapshot's own RUNBOOK note): downloading
`?encrypt=true` from a running `api` container built from this Dockerfile and decrypting
with `age` needs the compose stack up, which this WP's rules forbid.

---

## 5. C-7 — export bundle covers the Phase 3/4 tables (G3-7)

**Finished this pass.** `apps/api/src/reports/export/registry.ts`'s `TABLE_ORDER` already
carried every Phase 3/4 table (investments through the planning batch) on disk; the
`EXEMPT_TABLES` deferral reasons ("exported … by WP 3.7"/"by WP 4.12") had already been
deleted for every table that moved. Two real defects surfaced running
`apps/api/test/db/export-import-phase3-phase4.test.ts`, neither of them pre-existing on
disk in a working state — both are **new findings from this session**, not carried over:

### 5.1 `sealed_at` and `balances_sealed` were silently redacted on export

`registry.ts`'s `SENSITIVE_NAME_PATTERN` (`/sealed|credential|_secret$|access_token|api_key/iu`)
matched "sealed" as a bare substring, so it also matched `net_worth_daily.sealed_at`
(a timestamp, not a secret) and `projection_runs.balances_sealed` (a boolean). Both
columns were dropped from every export, silently. Consequence, reproduced directly with a
standalone script (`createTestDatabase` + `buildExportBundle` + `importBundle`, no
`app.ts` dependency, run while the concurrent agent had `app.ts` in a broken transient
state): a two-revision `net_worth_daily` correction chain lost `sealed_at` on **both**
rows on export, so the import saw two "open" (`sealed_at IS NULL`) revisions for the same
day and hit `net_worth_daily_one_open_day_idx`; `projection_runs` lost `balances_sealed`
entirely, hitting its `NOT NULL` constraint on import.

**Fix**, `registry.ts`: anchored the "sealed" branch to `^sealed_(?!at$)` — a whole-string
prefix, not a substring — which matches `sealed_config`/`sealed_credentials`/`sealed_secret`
(every real SecretBox envelope column) and excludes both `sealed_at` (prefix, but the
excluded suffix) and `balances_sealed` (suffix position, never matches `^sealed_` at all).

**Sabotage, real source, twice:**

1. Reverted the pattern to the original `/sealed|credential|_secret$|access_token|api_key/iu`.
   Red: 3/4 tests in `export-import-phase3-phase4.test.ts` fail — both the
   `net_worth_daily_one_open_day_idx` violation and, separately confirmed, the
   `projection_runs` `NOT NULL` violation. Restored.
2. Removed `net_worth_daily` from `TABLE_ORDER` (the original G3-7 defect shape — a
   Phase 3/4 table silently missing). Red: 2/4 tests fail (`assertRegistryIsComplete`
   reports `missing: ['net_worth_daily']`; the round-trip test's own `netWorthStream`
   lookup returns `undefined`). Restored.

`git diff --stat` on `registry.ts` after both restores matches only this session's net
fix (the regex anchor). Re-run green: `export-import-phase3-phase4.test.ts` (4 tests),
`export-import.test.ts` (6), `export-encrypt.test.ts` + `-age-absent.test.ts` (5) — 15/15.

### 5.2 The test file's own bigint-vs-string assertions

Two `expect(...).toBe('123456')` assertions in the debugged test compared a raw pg
`BIGINT` result (which `@core/db`'s installed type parsers hand back as a real `bigint`,
per `codec.ts`'s own header) against a string literal. Fixed the two type annotations and
assertions (`net_worth_minor`, `p50_minor`) to `bigint`/`123456n`. This is what "finish
that test" (the brief's own phrase for this file) meant in practice — the previous agent
was mid-debugging exactly this class of failure when the kill hit.

### 5.3 "Delete migrate.test.ts's Phase 3 export exemptions"

**Searched, found nothing to delete.** `packages/db/test/migrate.test.ts` contains no
reference to "export" at all (`grep -ni export packages/db/test/migrate.test.ts` — zero
hits) and no `EXEMPT_TABLES`-shaped list beyond its own, unrelated
`declare user_id on every user-scoped table` exemption set (`schema_migrations`, `users`,
`event_consumer_offsets`, `config_snapshots` — a different check, about `user_id`
columns, not exports). This file was not touched by the previous agent's wip commit
either. **For the orchestrator:** either this instruction referred to content already
removed before the kill, or to a different file; nothing in the current tree matches the
description. No lines were deleted because none exist.

---

## 6. The Wave C wiring handover (`wp4.w-wave-c-wiring.md` §4.1–4.4)

All four items closed.

### 6.1 §4.1 — the D6 comment

`apps/api/src/worker.ts`, the comment inside the `appModules({...})` call, replaced
verbatim with the suggested text ("D6: one holder — this deployment's assumption, no
longer a structural refusal…").

### 6.2 §4.2 — the Monte Carlo binding

`worker.ts` now imports `createMonteCarloRunnerFromCache` from `./domain.ts`, constructs
`monteCarlo` once per process (`cacheDir` from `config.planning.returnsCacheDir` when set,
`logger`), and passes `monteCarlo` into the `appModules({...})` call, mirroring
`marketDataRuntime`'s construction a few lines above. `exactOptionalPropertyTypes` needed
a conditional spread for `cacheDir` rather than `cacheDir: string | undefined`.

### 6.3 §4.3 — the config key

`packages/config/src/schema.ts`: added `PLANNING_RETURNS_CACHE_DIR: z.string().default('')`
beside the market-data block, with the comment the wiring doc specified.
`packages/config/src/load.ts`: added `PlanningConfig { returnsCacheDir: string | undefined }`
and `AppConfig.planning`, surfaced the same way `marketData`/`crypto` are (empty string →
`undefined`, mirroring the "empty means the code's own default" convention every other
override in this file states). New tests, `packages/config/src/load.test.ts`
(`PLANNING_RETURNS_CACHE_DIR` describe block, 3 tests): defaults to `undefined`; an empty
string is `undefined` too, not `''`; a non-empty value passes through verbatim.
`pnpm exec vitest run --project config`: **148/148**.

### 6.4 §4.4 — the compose volume

`compose.yml`: `returns_cache` named volume, mounted read-write on `worker` only at
`/var/lib/personalfi/returns`, with `PLANNING_RETURNS_CACHE_DIR` set to match; `api` binds
neither. `scripts/compose-hardening-check.sh`'s `WRITABLE_NAMED_VOLUMES` map updated with
a `returns_cache:worker` entry (the same hand-maintained "who may write this volume"
allow-list `pgdata`/`backups`/`caddy_data` already use) — without it the hardening check
would have flagged the new volume as an undocumented writable mount.
`compose-hardening-check.sh --self-test && compose-hardening-check.sh`: **PASS**, 0
violations. `docker compose config` (the real `compose.yml` alone): parses; the volume
and env var both appear in the rendered output at the expected path.

**Test proving the boot path itself, not just the underlying function**
(`apps/api/test/db/phase4-wiring.test.ts`, one test added — the file's own 8th):

- a source-shape half (the `worker-account-holder-poll.test.ts` style): asserts
  `worker.ts` actually calls `createMonteCarloRunnerFromCache(` with
  `config.planning.returnsCacheDir` and passes the constructed `monteCarlo` into the
  `appModules({...})` call — not merely that the standalone function behaves correctly;
- a behavioural half, over the exact function `worker.ts` calls: with no `cacheDir`
  override (this tree's own `data/returns/cache/` already carries WP 4.5's fetched
  series, so `undefined` — an operator's default state — binds non-null); with an
  explicit missing path, binds `null`.

**Sabotage, real source:** removed the `monteCarlo,` line from the `appModules({...})`
call in `worker.ts` (constructed but never wired in). Red: the source-shape assertion
fails (`the constructed monteCarlo value must be passed into appModules`). Restored,
`git diff --stat` on `worker.ts` for this line: empty.
`apps/api/test/db/phase4-wiring.test.ts`: **8/8**.

### 6.5 An unrelated lint fix found along the way

`worker.ts`'s `process.env['VITEST']` guard (the module-load-vs-`main()` seam every C-1
test depends on) predates this session and was never lint-clean:
`no-restricted-properties` flags any `process.env` read outside `@core/config`. It cannot
route through `@core/config` here — it decides whether to call `loadConfig()` at all — so
this is the same narrow, reasoned exception `packages/contexts/planning/src/engine/monte-carlo.worker.ts:56`
already uses for the identical shape. Added a one-line `eslint-disable-next-line` with
the reason. `pnpm exec eslint apps/api/src/worker.ts`: clean.

---

## 7. C-3 — the fiat on-ramp never becomes spending (G3-3)

**`pfc-map.ts` (this WP's one categorization/recurring file, read first per the brief) is
already correct and needed no change.** `TRANSFER_IN_ACCOUNT_TRANSFER` and
`TRANSFER_OUT_ACCOUNT_TRANSFER` both map to `transfers.between_accounts`, a
`kind: 'transfer'` leaf, both directions.

**What running the real end-to-end pipeline found, which the condition's own text did not
predict:** `packages/contexts/categorization/src/service.ts`'s `categorizeTransactions`
(the consumer `worker.ts` runs) persists only a **tier-2 (rule)** decision into
`@ctx/ledger`'s effective category — its own comment: "every other source
(merchant_default, provider, classifier, none) is a tier ledger has no column for — it
stays entirely in this context's own `category_assignments`." A provider-category
(tier-4) match — what an on-ramp deposit with no rule written for it gets — is **never
auto-applied**; the transaction's effective `categoryId` stays `null`.
`apps/api/src/reports/spending-income.ts`'s `spendingRowsOf` treats a `categoryId: null`
cell as spending only when its amount is **not positive**. So an unpaired on-ramp
deposit (a positive inflow, uncategorised) is excluded from spending **by that rule**,
never by `pfc-map.ts`'s mapping ever reaching the ledger.

Sabotaging `pfc-map.ts` directly (`TRANSFER_IN_ACCOUNT_TRANSFER` → `dining.restaurants`)
against the real end-to-end pipeline (real `POST /connections` → `SyncOrchestrator` →
`applyProviderTransactions` → the real categorization consumer pump → the real
`computeCategoryMonthActivity`/`spendingRowsOf`) leaves the deposit's spending
contribution **unchanged** — the mapping the gate's own S-CB5b sabotage targets is not,
in the current architecture, load-bearing for this specific claim.

**The real residual risk, characterised and recorded, not fixed** (outside this WP's
`pfc-map.ts`-only grant — the fix belongs in `@ctx/budgeting`'s `computeActuals` or
`apps/api/src/reports/spending-income.ts`, excluding `kind: 'transfer'` categories
structurally the way `kind: 'income'` already is): an unpaired, uncategorised **outflow**
carrying the same `TRANSFER_OUT_ACCOUNT_TRANSFER` PFC shape (the bank-side leg funding an
on-ramp, before `POST /transfers/pair` ever runs) **is** counted as spending today — the
`categoryId: null` + negative-amount case `spendingRowsOf`'s rule does not protect.

New file, `apps/api/test/db/onramp-spending-e2e.test.ts` (3 tests, real orchestrator/real
categorization consumer/real reports aggregation throughout):

1. the $5,000 deposit, PFC-tagged with `@connector/coinbase`'s own real
   `COINBASE_TRANSFER_IN_PFC` object, contributes exactly `0n` to the spending report —
   green;
2. a companion outflow (a different month, so the two never net against each other in
   `computeCategoryMonthActivity`'s per-cell aggregation) documents the current, verified
   `-500000n` result as a **characterisation test**, with a comment naming it a gap and
   instructing a future fixer to flip the assertion to `0n` rather than delete it;
3. `pfc-map.ts`'s own mapping, sabotage-tested against the real map: both PFC codes
   resolve to `transfers.between_accounts`; sabotaging the map (`dining.restaurants`) is
   red on this test alone, confirming it (and only it) actually exercises `pfc-map.ts`.

`pnpm exec vitest run --project api-db apps/api/test/db/onramp-spending-e2e.test.ts`:
**3/3.**

---

## 8. C-8 — OpenFIGI (G3-11)

### 8.1 Anonymous registration and RUNBOOK — a real defect found and fixed

RUNBOOK.md's own claim ("also answers anonymously, at 10 jobs per batch instead of 100")
was already correct and needed no correction. The **code** did not match it fully:
`packages/contexts/integrations/src/adapters/openfigi.ts` already batches at 10
jobs/request without a key (`OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST`), but
`createOpenFigiMapper`'s default rate budget was unconditionally `OPENFIGI_WINDOWS` — the
**keyed** tier, 25,000 jobs/minute — applied to the anonymous case too. OpenFIGI's
published anonymous tier is 25 **requests**/minute, not jobs; billing an anonymous
process's calls against the keyed window would let it call far faster than the real
unauthenticated quota permits, exactly the "throttled into a resolution failure that
looks like 'this security does not exist'" risk `openfigi.ts`'s own header already
warned about for the batch-size half of this same problem.

**Fix:** `packages/contexts/integrations/src/rate-limit.ts` — new
`OPENFIGI_ANONYMOUS_WINDOWS` (25/minute, `unit: 'request'`).
`openfigi.ts` — the default budget is now `options.key.present ? OPENFIGI_WINDOWS :
OPENFIGI_ANONYMOUS_WINDOWS`, and the anonymous `cost` passed per call is `1` (a request),
not `batch.length` (a job count) — billing by the unit the tier is actually denominated
in.

**Sabotage, real source, twice** (`packages/contexts/integrations/test/openfigi.test.ts`,
one new test): (1) reverted the default-budget selection to unconditional
`OPENFIGI_WINDOWS` — red (`window.limit` reads `25000`, expected `25`); (2) reverted the
anonymous `cost` to `batch.length` — red (`window.used` reads `25`, expected `3`, after
25 jobs sent as 3 batched requests). Both restored, `git diff --stat` on `openfigi.ts`
after restore matches only the net fix. `pnpm exec vitest run --project integrations`:
**56 passed, 4 skipped** (the skips are the pre-existing live-network smokes, unrelated).

### 8.2 Surfacing `SecurityResolutionFailed` — investigated, not built, left for 4.12c/a UI WP

Confirmed empirically (`grep` across `apps/web/src`, `apps/api/src`,
`packages/contexts/notifications/src/render.ts`) that `investments.SecurityResolutionFailed`
has **no consumer, no notification-render case, and no route** anywhere in the tree — a
position the resolver could not identify is genuinely invisible today, exactly as G3-11
states. **Not fixed here**, for two reasons stated together: (a) the gate's own proposed
owner for this half is explicitly split — "WP 4.12 **(+ a UI WP for the surface)**" — and
(b) the minimal backend path (a `render.ts` case in `@ctx/notifications`, or a new read
route) reaches into files this WP's ownership does not cover for this condition
(`packages/contexts/investments/**` is granted "C-13 only"; `apps/api/src/domain.ts` and
`apps/api/src/routes/*` are not granted at all). **For 4.12c:** the minimal fix is a
`case 'investments.SecurityResolutionFailed':` in
`packages/contexts/notifications/src/render.ts` (mirroring the existing
`budgeting.BudgetThresholdCrossed` case) plus a way for that rule to exist for a user
without manual creation (there is currently no default-rule seeding at all — every
`notification_rules` row today is user-created) — or, more simply, a new field on
`GET /holdings`/`GET /accounts/:id` reading `domain_events` for this type, joined by
`(provider, providerSecurityId)`.

---

## 9. C-13 — seal `wallet_addresses.descriptor` (§4.1(c)) — investigated, left for 4.12c

**Not built.** `wallet_addresses` is owned by `@ctx/investments`
(`packages/contexts/investments/OWNERSHIP.md`), matching this WP's "C-13 only" grant for
that package — but the actual column (migration `0016_wallet_addresses.sql`, plain
`TEXT NOT NULL`) and its only reader/writer (`WalletAddressStore` in
`apps/api/src/domain.ts:3118` onward, raw SQL, no Drizzle table defined anywhere yet —
`@connector/walletrpc/OWNERSHIP.md`'s own note confirms "the actual Drizzle `pgTable`
definition… is still a claim") live entirely outside `packages/contexts/investments/**`.
Sealing the column needs both a new migration (0027 is the next free number, per the
brief's own accounting — **flagged here, not taken**) to move `descriptor` from `TEXT` to
a `SecretBox`-sealed `BYTEA`, and an edit to `domain.ts`'s `WalletAddressStore` to
seal/unseal on write/read using the `secretBox` it is already constructed with. Both are
outside this condition's granted files. **For 4.12c:** migration 0027, expand→backfill→
contract (a new sealed column, backfill existing rows, switch reads, drop the old column
in a later release, per `docs/CONVENTIONS.md`'s own migration discipline), plus the
`domain.ts` store change.

---

## 10. C-11 — half-even rounding in `net-worth.ts` (G3-6)

**Real defect found and fixed.** `packages/contexts/planning/src/net-worth.ts`'s
`toMinorUnits` rounded half-up away from zero (`(scaled + 5n) / 10n` over a 3-decimal
truncation of the fraction) — the one rounding call in the app that disagreed with
`docs/CONVENTIONS.md`'s "rounding is banker's (half-even) by default." Rewritten to
half-even over the **full** fractional remainder (not a 1-digit truncation, which could
misjudge a tie hidden behind more than 3 decimal places — an 18-decimal crypto quantity
times a many-digit price).

New file, `packages/contexts/planning/test/half-cent-rounding.test.ts` (4 tests), isolated
from the shared `hand-computation.json` fixture on purpose (that fixture's own investment
position does not land on a rounding boundary, and editing a fixture five other tests
reconcile against was judged too risky to attempt for a LOW condition): `12.5 x $0.01 =
$0.125` → half-even rounds to **$0.12** (12 is even); `13.5 x $0.01 = $0.135` → rounds to
**$0.14** (14 is 13's even neighbour); a value strictly past half always rounds up; a
value strictly before half always rounds down.

**Sabotage, real source:** the tie-break branch changed from
`scaled % 2n === 0n ? scaled : scaled + 1n` to unconditional `scaled + 1n` (half-up).
Red: 1/4 tests fails (`$0.125` rounds to `13n`, expected `12n`). Restored, `git diff
--stat` on `net-worth.ts` after restore matches only the net fix.
`pnpm exec vitest run --project planning`: **125/125** (all pre-existing planning tests,
including `reconcile.test.ts`'s hand-computation fixture, still pass unchanged).

---

## 11. C-12 — `checkUrl` passes its parsed scheme (gate input (2))

**Real fix, `packages/platform/src/egress/policy.ts`.** `checkUrl` refused any scheme
other than `'https'`, then handed `checkDestination` the **literal** `'https'` rather
than the `scheme` variable it had just parsed — inert today (the two values always
agree at that point) but a future scheme change would silently bypass
`checkDestination`'s own `allowedSchemes` policy rather than being decided by it. Changed
`{ scheme: 'https', ... }` to `{ scheme, ... }`.

New file, `packages/platform/src/egress/checkurl-scheme.test.ts` (2 tests, in `src/`
because the `platform` unit project's own convention keeps tests beside their source,
not under `test/` — that directory is the DB-backed project): a source-shape assertion
(the `worker-account-holder-poll.test.ts` style — the call must carry the variable, never
the literal), and a behavioural proof that `allowedSchemes` is genuinely consulted: a
policy with `https` removed from `allowedSchemes` still refuses an `https://` channel URL
via `checkDestination`'s own check.

**Sabotage, real source:** reverted to the literal `'https'`. Red: the source-shape
assertion fails; the behavioural test stays green (expected — the two values are
identical today, which is exactly why a behavioural-only proof would have missed this).
Restored, `git diff --stat` empty. `pnpm exec vitest run --project platform`: **34/34**.
`pnpm exec vitest run --project notifications` (the consumer of this policy): **24/24**.

---

## 12. C-4 — CDP key custody, the database half (WP 1.3b pattern)

**Built.** `docs/evidence/phase-3/wp3.5-coinbase.md` §2.1 specified the exact target —
`apps/api/test/db/coinbase-routes.test.ts`, the WP 1.3b `psql`-raw-column pattern
(`plaid-routes.test.ts:146-158`) reproduced for `cdp_key_name`/`cdp_private_key` —
explicitly noting the connector package itself cannot write it (`connector-coinbase` is
hermetic; `@ctx/connections`, the sealing, and a scratch database are all outside its
layer-import allowance).

`createConnectorRegistry` (`apps/api/src/domain.ts`) always builds a real,
network-bound Coinbase transport, so a route test needs a test-injectable connector.
Added `HarnessOptions.coinbaseConnector?: CoinbaseConnector` to
`apps/api/test/helpers/api-harness.ts`, mirroring the existing `plaidConnector` seam
exactly (same pattern, same reasoning, registered the same way) — the harness's own
established precedent for "a route test must never dial out."

New file, `apps/api/test/db/coinbase-routes.test.ts` (3 tests): real `CoinbaseConnector`
over `@connector/coinbase/test`'s `FakeCoinbaseApi`, linked through the real
`POST /connections`. Reads `connections.sealed_credentials` exactly as `psql` would and
asserts the raw buffer contains neither `TEST_KEY_NAME` nor `TEST_PRIVATE_KEY_BASE64` in
`utf8` or `latin1`, nor any 8-byte substring of either (the Plaid assertion, character
for character); the link response and a subsequent `GET /connections` also checked.
A negative control (WP 3.5's own custody suite calls this "the sabotage a custody test
most needs and is least likely to have"): concatenating the plaintext key onto the
sealed bytes and re-running the same assertion helper throws, proving the sweep is not
vacuous.

`pnpm exec vitest run --project api-db apps/api/test/db/coinbase-routes.test.ts`:
**3/3.** Re-ran `plaid-routes.test.ts` + `connections-routes.test.ts` after the
`api-harness.ts` change: **31/31**, no regression.

---

## 13. C-16 — docs/hygiene

- **G3-9, `compose.override.example.yml`'s dev-sinks block**: replaced the
  `NOTIFICATIONS_ALLOWED_HOSTS: 'mailpit,ntfy'` suggestion (which the gate proved from
  inside a real worker container can never work — the dev sinks resolve to private
  Docker-network addresses, which the egress guard's private-range refusal does not
  accept from any allow-list, and ntfy's dev-sink port is plain HTTP besides) with an
  explanation of why, and a pointer to `notifications-delivery.test.ts`'s actual idiom
  (swap the socket target after the guard runs, never widen the guard itself).
- **O-3, Playwright rewriting committed screenshots**: not reached this session — no
  time remained to audit `apps/web/e2e` for this; left for 4.12c.
- **O-5, `@connector/walletrpc`'s `./test` export**: **already fixed**, by WP 4.12a
  (`packages/connectors/walletrpc/test/index.ts` exists, is a real barrel, and its own
  header cites this exact O-5 finding as the reason it exists). Verified, not
  re-touched.
- **O-6, 04 §2 row 69**: struck. `docs/plan/04-phase-4-dispatch.md`'s row claiming
  `ProviderInvestmentTransactionFact.security` "is still one identifier" is stale — the
  field has been `ProviderSecurityFact | null` (the whole fact) since WP 3.14a
  (`git log` commit `9fb4191`, confirmed against the current
  `packages/connectors/port/src/facts.ts:341`), which landed *before* the Phase 3 gate
  wrote this row. Row struck with the commit reference.

---

## 14. Left for 4.12c

1. **C-13** (§9): seal `wallet_addresses.descriptor` — needs migration 0027 and a
   `domain.ts` change, both outside this WP's granted files.
2. **C-8's UI half** (§8.2): surface `investments.SecurityResolutionFailed` — needs a
   `packages/contexts/notifications/src/render.ts` case (or a new route field) plus a
   default-rule-seeding decision; outside this WP's granted files for this condition.
3. **C-9** (FX-unavailable on screen, the net-worth figure labels) — not attempted;
   the gate's own proposed owner is "Phase 4 UI WP (4.10) with WP 4.12 for the route,"
   and no route-level work was reached this session.
4. **C-14, C-15** — already closed by WP 4.12a (C-14) or owned by a Phase 4 UI WP (C-15,
   CoinGecko attribution asset); not re-touched.
5. **C-16's O-3** (Playwright rewriting committed screenshots) — not reached.
6. **§5.3** (this file, migrate.test.ts): confirmed nothing to delete; if the
   orchestrator knows of content that existed before the kill and is now gone, it was
   gone before this agent started (`grep -ni export packages/db/test/migrate.test.ts`
   returns zero hits on the tree as received).

---

## 15. Final verification

```
pnpm exec tsc -b --noEmit                       # 0 errors outside routes/plan.ts, routes/goals.ts (WP 4.9, concurrent, not this WP's)
pnpm exec eslint <every file this WP touched>    # 0 problems
node scripts/check-numeric-boundaries.ts         # self-test PASS; 766 files, 0 violations
pnpm run lint:schema-ownership                   # ok — 103 tables, 14 packages, 90 defined
node scripts/check-ci-projects.ts                # PASS — 41/41 projects covered
node scripts/check-proxy-routes.ts               # PASS — 30/30 contract prefixes routed
bash scripts/compose-hardening-check.sh --self-test && bash scripts/compose-hardening-check.sh
                                                  # PASS, 0 violations, all 3 compose files
git diff --cached --name-only                    # empty
```

Targeted vitest, foreground, against dev Postgres (`127.0.0.1:5433/personalfi_dev`):

| Project(s) | Result |
| --- | --- |
| `config` | 148/148 |
| `platform` | 34/34 |
| `notifications` | 24/24 |
| `integrations` | 56/56 (4 pre-existing live-smoke skips) |
| `planning` | 125/125 |
| `insights` + `insights-db` | 213/213 |
| `api` (full project) | 95/95 |
| `api-db` (targeted files: `export-import-phase3-phase4`, `export-import`, `export-encrypt`, `export-encrypt-age-absent`, `phase4-wiring`, `onramp-spending-e2e`, `coinbase-routes`, `plaid-routes`, `connections-routes`) | 15+8+2+4+31+3+3 = every file individually green; see §16 for the full `api-db` project run |

## 16. Full `api-db` project run (appended after this document was written, per instructions)

<!-- appended below once the background run completes -->
