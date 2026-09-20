# WP 2.8 — Reports read models and export/import bundle

Status: implemented, tests green, `tsc`/`eslint`/`prettier` clean on every file this WP owns.
Written incrementally while the work package was built; the sabotage output below is real,
captured by hand during that work, not reconstructed afterward.

## 1. Scope actually delivered

- **Reports** (`apps/api/src/reports/**`): spending by category/month, income by category/month,
  a Sankey (income → category → top-N merchants → other), budget-vs-actual per period. All four
  are pure aggregation over existing context read models; no new tables, no migration.
- **Routes**: `GET /reports/{spending,income,sankey,budget-vs-actual}`, `GET /export`,
  `POST /import`, plus `GET /export/manifest-check` (a route wrapper around the manifest-completeness
  self-check, so the gate's independent reviewer can re-run it against the booted stack without a
  database console).
- **Export/import bundle** (`apps/api/src/reports/export/**`): a versioned JSONL bundle with a
  manifest (contract version, per-stream row count + sha256, `created_at`, app version),
  `age`-encryptable via `?encrypt=true`, and an import that loads into a clean instance only,
  re-running `@ctx/ledger`'s own projection rather than trusting exported `effective_*` columns.
- **OpenAPI**: regenerated (`just openapi`), `just check-proxy-routes` green, `pnpm --filter
@app/web gen` regenerated the (gitignored) web client with no errors.

## 2. A load-bearing deviation from the dispatch text, and why

`docs/plan/02-phase-2-dispatch.md` §3 WP 2.8 and D3/D11 both assume reports and export can `import
computeActuals` from `@ctx/budgeting` and read `@ctx/budgeting`'s `getPeriod` directly. Neither is
possible as written: **`apps/api/package.json` does not declare a dependency on `@ctx/budgeting`**
(master plan §4 item 8's "dependency batch" — adding `@ctx/*` workspace entries to
`apps/api/package.json` and running one `pnpm install` — is explicitly an orchestrator step applied
_between_ waves, and this work package's own rules forbid editing `package.json`, the lockfile, or
running `pnpm install`). Attempting the import fails to compile (`Cannot find module
'@ctx/budgeting'`) because pnpm's per-package `node_modules` isolation means a workspace package
that exists on disk but is not a declared dependency is invisible to the consumer.

Two files carry a **documented port** as a result, each citing the exact source it reproduces and
naming the open item for when the dependency lands:

- `apps/api/src/reports/netting.ts` — a line-for-line port of `@ctx/budgeting/src/actuals.ts`'s
  `computeActuals`, reduced to the fields a report needs (no `funding`/`creditAccountId`/card-payment
  tracking — reports don't render the cash/credit split). Both `spending-income.ts` and `sankey.ts`
  call this, not a re-derivation each.
- `apps/api/src/reports/budget-vs-actual.ts` — raw SQL against `budget_periods`/`budget_lines`/
  `budget_line_actuals`, reading the **cached** columns `@ctx/budgeting`'s own recompute cascade
  already wrote (no envelope math to duplicate, only a read). This is not a table-ownership
  violation: `scripts/check-schema-ownership.ts` exempts `apps/` from its cross-package raw-SQL
  check by design (`NON_OWNING_PREFIXES = ['apps/']`) — the same exemption every stream in
  `reports/export/**` already relies on.

**Open item for the orchestrator:** once `@ctx/budgeting` is added to `apps/api/package.json`'s
dependencies, delete `reports/netting.ts`, import `computeActuals` directly in `spending-income.ts`
and `sankey.ts`, and replace `budget-vs-actual.ts`'s raw SQL with a call to `getPeriod`.

## 3. Aggregation rules (memo lines)

- **Grouping.** Spending/income group on the ledger's resolved `effective.date` truncated to
  `YYYY-MM` — never a `@ctx/budgeting` period (a period can be biweekly/semimonthly; a report month
  must mean the same thing whether or not budgeting is on).
- **Transfers.** Both legs of a paired or flagged transfer are dropped from every category's
  activity entirely (not netted to zero — dropped), and counted in `transferExcludedCount` on
  whichever bucket they'd otherwise have landed in. Verified by
  `reports-aggregation.test.ts`'s `'spending totals contain zero internal transfers'`: a $1,000
  transfer pair contributes `0` to the sum of every returned cell, and `transferExcludedCount` is
  `2` (both legs).
- **Refunds.** A refund with no category of its own inherits the _purchase's_ category
  (`categoryOfPurchase`, built once over the whole requested window so a refund in a later month
  than its purchase still nets correctly), and its signed amount adds into that category's total.
  Verified by `'a refund nets against its original'`: a $100 purchase + $40 refund nets to exactly
  `-6000` minor units ($60), not `-10000` and not `0`.
- **Uncategorised.** The `categoryId: null` bucket is reported as spending for a month it was net
  negative and as income for a month it was net positive; a category tagged `kind: 'income'` always
  reports as income regardless of sign.
- **Currency.** Every aggregation groups by currency first; a Sankey renders exactly one currency
  (the one with the most absolute activity, or an explicit `?currency=`) — no cross-currency sum,
  per decision D4.
- **Drill-through** (`reports/drill-through.ts`): every cell/link carries a `drillThrough` object
  that is literally `GET /transactions`'s own `categoryIds`/`from`/`to` (plus `merchantIds` on a
  Sankey merchant band) — reused, not a second filter language. `reports-aggregation.test.ts`'s
  `'drill-through params reproduce the same filtered list'` calls `GET /transactions` with each
  cell's own `drillThrough` params and checks the returned summary total against the cell (for a
  category with no refund in it — the plain list total isn't refund-netted the way a report cell
  is, so the comparison is only meaningful, not vacuous, for such a category).
- **Budget-vs-actual.** `assigned`/`activity`/`available`/`cashOverspend`/`creditOverspend` are
  read straight off `budget_lines`/`budget_line_actuals`, `kind = 'category'` only (CCP lines are a
  budgeting-screen concern, not a report).

## 4. Bundle spec

```
line 1:   {"version":1,"createdAt":"...","appVersion":"...","userId":"...","streams":[
            {"table":"accounts","count":3,"sha256":"..."}, ...
          ]}
line 2..: one JSON object per row, TABLE_ORDER order, `manifest.streams[i].count` rows per table
```

- **Row encoding** (`reports/export/codec.ts`): every column, alphabetised, with `bigint` marked
  `__bigint__:<value>` and `Buffer` marked `__bytes__:<base64>` so `JSON.stringify`/`JSON.parse`
  round-trip exactly; `@core/db`'s global type parsers already hand `DATE` back as a plain string
  and `TIMESTAMPTZ` as a `Date` (ISO-serialised), so neither needs a marker.
- **Hashing**: sha256 (via `@core/secretbox`'s one-shot `sha256`, this application's sole
  cryptography chokepoint — `node:crypto` is `no-restricted-imports`-banned everywhere else) over
  `line + "\n"` for every line of a stream, in emission order. Import re-hashes the same way before
  a single row reaches Postgres.
- **Dependency order** (`reports/export/registry.ts`'s `TABLE_ORDER`, 32 tables): derived from a
  grep of every `.references(...)` this repository actually declares (2026-09-19). Real FK
  constraints exist **only** within `ledger` and `categorization`; `budgeting`, `recurring` and
  `connections` declare no FK constraints between their own tables at all (every cross-row pointer
  is a plain `uuid` column — table-ownership discipline extended inward). `transactions
.superseded_by_id` is self-referencing but carries no DB FK, so no two-phase insert is needed.
- **Sensitive columns**: `connections.sealed_credentials` is dropped by name, plus a defence-in-depth
  pattern (`sealed|credential|_secret$|access_token|api_key`, case-insensitive) that drops any
  matching column from any table. The row itself is still exported — only the column is dropped
  (D5's scope rule: "key loss = re-link providers, never = lose the ledger").
- **Manifest completeness**: `assertRegistryIsComplete` asks `information_schema` which tables
  actually carry `user_id` (D6's own definition of "user-scoped") and fails if `TABLE_ORDER` is
  missing one that isn't in `EXEMPT_TABLES` (each entry reasoned, not guessed — see §6, "how the
  exemption list was actually built").
- **`?encrypt=true`**: shells out to `age --encrypt --recipients-file
${SECRETS_DIR}/age_recipients` (`node:child_process.spawn`, no new dependency), the same
  recipients file `docker/backup/backup.sh` already writes against. A missing recipients file or a
  missing `age` binary on `PATH` is a 503 (`export.encryption_unavailable`), never a silent
  plaintext fallback.
- **Encryption status — honest gap, not a claimed PASS.** Neither this dev host nor
  `export-import.test.ts` has the `age` binary or a recipients file present, and no automated test
  in this WP hits `?encrypt=true` (success or the 503 branch) — `grep -n encrypt
apps/api/test/db/export-import.test.ts` returns nothing but this file's own header comment. The
  code path (`encryptWithAge` in `reports/export/bundle.ts`, wired into `GET /export` in
  `routes/export.ts`) exists, is typed, and is reviewable, but it is a **documented deferral, not a
  sabotage-tested control**: nobody has watched `?encrypt=true` produce real `age` ciphertext, and
  nobody has watched the missing-binary/missing-recipients-file branch return the 503 from a live
  route rather than by inspection. Open item for whoever gates this: install `age`, drop a
  recipients file at `${SECRETS_DIR}/age_recipients` in a test fixture, and add two cases — one
  round-tripping `?encrypt=true` output through `age --decrypt`, one deleting the recipients file
  and asserting the 503 — to `export-import.test.ts` or a route-level test.
- **`user_id` is rewritten on import, not preserved.** Every user-scoped table's `user_id` column
  carries a real database foreign key to `users.id` (`@core/db`'s `userIdColumn()`: "the foreign
  key is declared in SQL" — Drizzle can't express a cross-context reference, so migrations declare
  it directly). A clean instance's own bootstrap user has a different id than whoever the export
  came from, so `importBundle(pool, parsed, targetUserId)` overwrites every row's `user_id` with the
  importing (step-up) session's own id during insert. This was caught by the round-trip test itself
  on the first run (`connections_user_id_fkey` violation) — see §5.
- **`json`/`jsonb` columns are pre-serialised on import**, not left to node-postgres's default
  parameter encoding. `pg`'s `prepareValue` treats _any_ JS array as a native Postgres array literal
  before it asks what the target column type is, so a `jsonb` column whose value is a JSON array
  (`budgets.off_budget_account_ids`, `recurring_series.account_ids`) got a curly-brace array literal
  instead of JSON text and Postgres refused it. `import.ts`'s `jsonColumnsOf` reads the target
  table's own `information_schema.columns` and `JSON.stringify`s exactly those columns' values
  before sending them as parameters. Also caught by the round-trip test on the first run.

## 5. Round-trip proof

`apps/api/test/db/export-import.test.ts`, against a real Postgres (`personalfi_dev`, admin
connection; each test opens its own scratch database via `@core/testkit`):

```
✓ every user-scoped table appears in the manifest
✓ an export never contains a sealed credential or a Plaid access token
✓ a tampered stream hash is refused
✓ export round-trips into a clean instance
✓ export then import into a clean instance reproduces every read model
✓ import into a non-empty instance is refused
```

`'export then import into a clean instance reproduces every read model'` builds a source instance
through the real API (manual connector, a transaction, a fake sealed connection), exports it,
imports the bundle into a freshly migrated, empty database (its own bootstrap user, a different id
than the source), and asserts `computeCategoryMonthActivity` returns **identical** output
(`toEqual`) against both databases for the same window, plus that `accounts` row counts match. The
projection re-run (`reprojectTransactions`) is exercised implicitly: the imported `transactions`
rows' `effective_*` columns are recomputed from `transactions_provider` facts and `merchants`, not
copied from the export, and the aggregation above only produces the right numbers if that
recomputation is correct.

Two real bugs were caught by this test on its first run, both fixed before this evidence was
written (not hidden):

1. **FK violation on `connections.user_id`** — every user-scoped table's `user_id` carries a real
   database FK to `users.id`, which the initial "preserve the exported user_id verbatim" design
   didn't account for. Fixed by rewriting `user_id` to the importing session's own id (§4).
2. **`invalid input syntax for type json`** — node-postgres's default array encoding collided with
   `jsonb` columns whose value happens to be a JSON array. Fixed by pre-serialising exactly the
   target table's `json`/`jsonb` columns (§4).

Both are exactly the kind of finding `docs/plan/00-master-implementation-plan.md`'s gate standard
wants surfaced rather than smoothed over: the round-trip test found them, not a reviewer three
weeks later.

## 6. Sabotage output (gate lessons: demand red-then-green, not a claimed PASS)

Both controls DELIVER named were sabotaged by hand, observed red, then reverted. Exact commands and
output:

**Credential exclusion** — `isSensitiveColumn` forced to `return false` unconditionally:

```
$ vitest run --project api-db export-import.test.ts -t "sealed credential"
 FAIL  export/import bundle (WP 2.8) > an export never contains a sealed credential or a Plaid access token
AssertionError: expected '...{"category_id":...}\n...' not to contain 'sealed_credentials'
  ❯ test/db/export-import.test.ts:105
    expect(text.toLowerCase()).not.toContain('sealed_credentials');
```

Reverted; re-run green (`1 passed`).

**Hash check** — the mismatch branch in `parseAndVerifyBundle` short-circuited (`if (false &&
digest !== stream.sha256)`):

```
$ vitest run --project api-db export-import.test.ts -t "tampered"
 FAIL  export/import bundle (WP 2.8) > a tampered stream hash is refused
AssertionError: expected function to throw an error, but it didn't
  ❯ test/db/export-import.test.ts:129
    expect(() => parseAndVerifyBundle(tampered)).toThrow(BundleValidationError);
```

Reverted; re-run green (`1 passed`). Full suite re-run after both reverts: `10 passed (10)` across
`reports-aggregation.test.ts` + `export-import.test.ts`.

## 7. How the manifest exemption list was actually built (not guessed)

The first draft of `EXEMPT_TABLES` in `reports/export/registry.ts` guessed plausible-sounding names
(`sessions`, `credentials`, `outbox`, `job_queue`, `login_attempts`...). Running
`'every user-scoped table appears in the manifest'` against a real migrated database immediately
returned the _actual_ list `information_schema` reports — 25 real tables, several under names the
guess got wrong (`domain_events` not `outbox`; `jobs`/`job_runs`/`schedules` not `job_queue`;
`webauthn_credentials` not `credentials`; no `login_attempts`, but `auth_attempts`/`auth_lockouts`/
`security_events`). The exemption list in the committed file is that real output, with a reason
attached to each entry — not the guess. This is exactly the mechanism the module header promises
("computed from `information_schema`, never a hand list") exercising itself during development, and
it caught its own first draft being wrong.

## 8. What WP 2.9 renders

- `GET /reports/spending` / `GET /reports/income`: category × month cells, each with a `drillThrough`
  ready to hand to the transactions list — the budget/reports screen's category rows and the visx
  chart's stacked bars both read straight off `cells`, no client-side money math beyond formatting.
- `GET /reports/sankey`: `nodes`/`links` ready for a visx Sankey — `kind` on each node
  (`income`/`category`/`merchant`/`other`) is what a renderer keys its layer on, and each link's
  `drillThrough` (with `merchantIds` on a merchant band) is the click target.
- `GET /reports/budget-vs-actual`: one row per category line, `assigned` vs `activity` vs
  `available`, with `cashOverspend`/`creditOverspend` for the red/yellow split 07 §1.3 asks for.
- `GET /export` / `POST /import`: a "download my data" / "restore from backup" pair. WP 2.9 is not
  expected to build a UI for these in Phase 2 (not named in its own dispatch scope) — flagged here
  as available if wanted.

## 9. Verification commands and results

```
pnpm exec tsc -p tsconfig.json --noEmit         # clean on every file this WP owns
                                                  # (packages/contexts/insights/test/no-fabricated-numbers.test.ts
                                                  #  has one pre-existing error — a concurrent agent's file)
pnpm exec eslint <this WP's files>              # clean
pnpm exec prettier --check <this WP's files>    # clean
pnpm exec vitest run --project api --project api-db
  # 26 files passed, 1 skipped (Plaid Sandbox smoke, network-gated), 183 tests passed, 1 skipped
just openapi                                    # wrote packages/contracts/openapi/openapi.json
just check-proxy-routes                          # PASS — 16 contract prefixes, incl. /export, /reports
pnpm --filter @app/web gen                       # regenerated apps/web/src/api/generated (gitignored)
```

`just check` output: see the final report for this run (typecheck + lint + full test suite,
verbatim; failures outside `apps/api/src/reports/**`, `routes/{reports,export}.ts` and this WP's own
test files belong to concurrent Wave B agents — `insights`/`notifications` — per the dispatch note).

## 10. Files touched

- `apps/api/src/reports/**` (new): `types.ts`, `ledger-source.ts`, `netting.ts`,
  `spending-income.ts`, `sankey.ts`, `budget-vs-actual.ts`, `drill-through.ts`,
  `export/{registry,codec,bundle,import}.ts`
- `apps/api/src/routes/reports.ts`, `apps/api/src/routes/export.ts` (new)
- `apps/api/src/app.ts` (registration lines + two OpenAPI tag entries)
- `apps/api/test/db/reports-aggregation.test.ts`, `apps/api/test/db/export-import.test.ts` (new)
- `packages/contracts/openapi/openapi.json` (regenerated)
- `apps/web/src/api/generated/**` (regenerated; gitignored, not committed)
- This file.

Not touched: `packages/contexts/**`, `apps/api/src/modules.ts`, `apps/api/src/platform.ts`,
`apps/api/src/routes/deps.ts`, any `package.json`, the lockfile, migrations, `migrate.test.ts`, or
docker.

## 11. Open items

1. **`@ctx/budgeting` dependency** (§2) — add to `apps/api/package.json`, then delete
   `reports/netting.ts` and `reports/budget-vs-actual.ts`'s raw SQL in favour of direct imports.
2. **Insights and notifications tables** are real (both landed mid-flight during this work package)
   but are out of this WP's named export scope (dispatch §3) and are listed as exempt with a reason,
   not silently dropped.
3. **`connection_staged_facts`** is intentionally not exported (ephemeral sync buffer,
   re-derivable by re-sync).
4. **No confirm-refund HTTP route exists yet** — `detectRefundHints` has no route wrapper in this
   phase; `reports-aggregation.test.ts` calls it directly, the same way a sync consumer eventually
   will. Flagged, not worked around.
5. **`p95 < 200 ms`** is measured in-process (aggregation function latency, not full HTTP round
   trip) against `generateDemoData(1)` loaded via `@ctx/ledger`'s `loadSeedDataset` — the same
   ~50k-row, 24-month fixture named throughout Phase 1/2 docs as "Phase 1's 50k-row budget".
   WP 2.12's own perf-budget work is the place a full HTTP-level measurement belongs.
6. **`?encrypt=true` is untested** (§4, "Encryption status") — no `age` binary or recipients file on
   this machine, no automated test exercises either branch. Documented deferral, not a
   sabotage-tested control.
