# Testing

What runs where, how database-backed tests work, how golden fixtures work, and
what the demo-seed generator is for. Everything mechanised here is asserted by
`just check`; this document explains the _why_ behind the mechanism.

## Layout

`vitest.config.ts` is one root config with a project per package (`just
--list` / `pnpm exec vitest run --project <name>` to run one). Two shapes:

- **Unit projects** (`kernel`, `config`, `seed`, `platform`, `api`, ...) need no
  database and no network. `just test-unit` runs the unit-only subset.
- **The `scripts` project** (WP 3.14) is the one project rooted at the repo
  root rather than at a package: it runs `scripts/**/*.test.ts`, the vitest
  half of the checked-in repo checks. Those checks each also carry a
  `--self-test` they run on every invocation, because `just lint` and CI's
  `lint` job run the _script_, not vitest — see "Repo checks" below.
- **`*-db` projects** (`db`, `platform-db`, `secretbox-db`, `identity-db`) need
  a real Postgres and skip themselves — see below — when they do not have one.
  `@core/testkit`'s own project mixes both shapes in one file per suite (its
  own tests are the example): plain unit tests sit beside
  `describe.skipIf(ADMIN_URL === undefined)` blocks, rather than a separate
  `testkit-db` project, because every file already guards its own
  database-dependent blocks.

Run everything with a database up: `just db-up && DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev pnpm exec vitest run`.

## Database-backed tests (`@core/testkit`)

`packages/testkit` (`@core/testkit`) is where every `*-db` suite in the repo
gets its scratch database, generalised from `packages/platform/test/harness.ts`
(WP 0.3). Import it like any workspace package:

```ts
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '@core/testkit';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;
// or: describe.skipIf(ADMIN_URL === undefined)('...', () => { ... });

describeWithDb('my context', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('personalfi_myctx_suite');
  });
  afterAll(async () => {
    await database.drop();
  });
  // database.db, database.userId, database.pool, database.truncate(), ...
});
```

- **`ADMIN_URL`** is `TEST_ADMIN_DATABASE_URL ?? DATABASE_URL`. Point
  `TEST_ADMIN_DATABASE_URL` at a different server than `DATABASE_URL` (CI vs.
  local, say) without touching every suite's skip guard.
- **One scratch database per suite**, created fresh (`DROP DATABASE IF EXISTS
... WITH (FORCE)` then `CREATE DATABASE`), migrated, and seeded with one
  `users` row (`database.userId`) before the suite runs, and dropped the same
  way in `afterAll`. Nothing depends on execution order, and a suite that fails
  mid-test leaves every other suite's data alone.
- **`close()` vs. `drop()`**: `close()` ends the pool and leaves the database in
  place (handy if something outside the test — a spawned worker process, say —
  still needs to connect to it); `drop()` closes the pool _and_ deletes the
  database. Both route through `endPool()`, which bounds `pool.end()` to 5 s:
  unbounded, a test that threw before releasing a checked-out client (an
  advisory lease's `stop()` never ran, say) hangs the whole suite on a generic
  "hook timed out" instead of surfacing the assertion that actually failed.

### `truncate()` and the sequence rule

```ts
await database.truncate(); // every table except schema_migrations and users
await database.truncate(['jobs']); // just these tables
```

With no argument, `truncate()` discovers every base table in the `public`
schema via `information_schema.tables` and truncates all of them except
`schema_migrations` (the migration ledger) and `users` (what every other row's
`user_id` depends on for the life of the `TestDatabase`). This replaced a
hard-coded list of platform tables specifically so a new context's tables get
wiped between tests without anyone having to remember to add them here.

**Read this before asserting on a sequence.** `TRUNCATE ... RESTART IDENTITY
CASCADE` only restarts the identity sequence of the tables _named in the
statement_. A table dragged in only by `CASCADE` — because it has a foreign key
to a table you named — has its rows deleted but keeps counting from wherever it
was. Concretely: `truncate(['jobs'])` deletes `job_runs` rows too (FK cascade),
but `job_runs`'s own identity sequence does not reset, because `job_runs` was
never named. **A test must never assume a `serial`/`identity` column starts at
1** unless every table sharing that sequence was named explicitly, or you used
the no-argument form (which names all of them). Prefer asserting on content
(`WHERE ... = $1`) over position (`id = 1`).

### Other pieces of `@core/testkit`

- **`recordingLogger()`** — a logger that records `{level, obj, msg}` for every
  call, for asserting on a warn/error path without a real pino instance.
- **`fixedClock(instant)`** — re-exported from `@core/kernel` for convenience;
  the actual implementation lives there (WP 0.1).
- **`waitFor(predicate, options)`** — poll until `predicate` holds or
  `timeoutMs` passes. Beats an arbitrary `sleep`.
- **`spawnProcess(name, modulePath, options)`** — a real child process with
  line-buffered JSON stdout, `saw()`/`await()`/`exited()`, lifted from
  `worker-restart.test.ts`'s `startWorker()`. Never reads `process.env`
  itself — pass `options.env` explicitly (build it as `{ ...process.env, ... }`
  in your own test file, which the process-env lint ban already exempts) or
  omit it to inherit the parent environment untouched, same as `spawn()`'s own
  default.
- **`withTempSecretsDir(secrets, fn)`** — writes each entry of `secrets` to its
  own file (mode 0600) under a fresh temp directory, calls `fn(secretsDir)`,
  and removes the directory afterwards whether `fn` throws or not. For a test
  that boots the real API/`loadConfig` against real secret files instead of an
  env-var stand-in:

  ```ts
  await withTempSecretsDir({ master_key: 'unit test passphrase' }, async (secretsDir) => {
    const config = loadConfig({ secretsDir, env: { ...baseEnv, DATABASE_URL: url } });
    // ...
  });
  ```

- **`toInstant` / `toInstantOrNull`** — re-exported from `@core/platform`, not
  reimplemented. `@core/db` leaves node-postgres's own `TIMESTAMPTZ` parser
  alone for a raw `db.execute()` call with a tagged-template `sql` query, but
  Drizzle's node-postgres session installs its own parsers and maps a
  `TIMESTAMPTZ` column to a string, not a `Date`. Use
  `toInstant(row.created_at)` in any assertion on a raw-SQL timestamp column —
  `row.created_at.toISOString()` will throw three frames away from the actual
  cause otherwise.
- **Golden fixtures** — see below.

### Why `@core/testkit`'s source lives in `test/`, not `src/`

Every other package points its `exports` at `src/*.ts` (`docs/CONVENTIONS.md`).
`@core/testkit` points at `test/index.ts`, deliberately: the repo's
`process.env`-outside-`@core/config` ban and its `Date.now()`/`new
Date()`-outside-`Clock` ban both carry a `**/test/**` exemption (alongside
`*.test.ts`), because a harness legitimately has to read
`TEST_ADMIN_DATABASE_URL` and poll a real wall clock while it waits on a
spawned process or a database. `scripts/check-schema-ownership.ts`'s raw-SQL
check carries the same exemption, which is also why `createTestDatabase`'s
`INSERT INTO users` does not need this package listed as an owner of anything.
Calling the directory `src/` and then fighting the linter file-by-file would
say the opposite of what the code is.

### The platform harness was **not** migrated

`packages/platform/test/harness.ts` still has its own, near-identical
`createTestDatabase`/`recordingLogger`/`waitFor`. It was deliberately left
alone rather than rewritten to re-export from `@core/testkit`: doing so would
mean `packages/platform/test/harness.ts` imports `@core/testkit`, and
`personalfi/layer-imports`'s `platform` layer (`scripts/eslint-boundaries.js`)
does not allow it — that file is not in the forbidden-to-edit list for this
work package, so the fix is a one-line addition, not a redesign:

```js
// scripts/eslint-boundaries.js, the `platform` layer's `allow` array:
allow: ['@core/kernel', '@core/db', '@core/testkit', 'drizzle-orm', 'pg', 'cron-parser', ...UNIVERSAL],
```

Once that lands, `harness.ts` can become a thin wrapper — `createTestDatabase`
delegating to `@core/testkit`'s and wrapping `.db` with platform's own
`platformExecutor()` so the six existing `*.test.ts` files that call
`database.db.transaction(...)` need no changes at all — but making that edit
was out of scope here.

### Boundary-lint lines needed for `@core/testkit` and `@core/seed`

Neither package appears in `scripts/eslint-boundaries.js`'s `LAYERS` array, so
`personalfi/layer-imports` currently no-ops for both (an unlisted path prefix
skips the rule entirely rather than failing closed — see `layerFor()`). That
is a silent gap, not a passing check: add these before either package grows a
real consumer outside its own tests, so a future import from, say, a context's
`src/` into `@core/seed` gets caught instead of silently allowed.

```js
{
  name: 'testkit',
  prefix: 'packages/testkit/',
  allow: ['@core/kernel', '@core/db', '@core/platform', 'drizzle-orm', 'pg', ...UNIVERSAL],
  allowNodeBuiltins: true,
  why:
    'Test infrastructure shared by every *-db suite: a scratch database per suite, ' +
    'process-spawning helpers, golden-fixture I/O. Depends on nothing above db/platform ' +
    'so no context ever needs @core/testkit as a production dependency.',
},
{
  name: 'seed',
  prefix: 'packages/seed/',
  allow: ['@core/kernel', ...UNIVERSAL],
  allowNodeBuiltins: true,
  why:
    'The demo-seed generator is a pure function of a seed integer. It produces typed ' +
    'in-memory data — Phase 1 maps it to real schema — and must not depend on @core/db: ' +
    'it owns no table (see OWNERSHIP.md).',
},
```

(And, separately, the one-line `platform` layer change in the previous
section, for the harness migration.)

## Golden fixtures

`loadGolden`/`expectGolden` (`@core/testkit`) pin a detection algorithm's or a
reference calculator's output byte-for-byte, per 04 §7.3 and the master plan's
"labeled recurring/merchant golden set":

```ts
import { fileURLToPath } from 'node:url';
import { expectGolden, goldenUpdateRequested } from '@core/testkit';

const golden = { dir: fileURLToPath(new URL('./golden', import.meta.url)) };

it('matches the reference calculator', () => {
  expectGolden('reference-projection', computeProjection(fixture), {
    ...golden,
    update: goldenUpdateRequested(process.env),
  });
});
```

- `dir` is always supplied by the caller (never guessed from
  `import.meta.url`/`cwd`): a fixture belongs to the package that owns the
  behaviour it pins.
- **`UPDATE_GOLDEN=1 pnpm exec vitest run --project <name>`** writes the
  current value as the new golden instead of comparing. `@core/testkit` cannot
  read `process.env` itself (it is shipped `test/`, not a `*.test.ts` file, and
  the same lint ban that restricts `process.env` to `@core/config` restricts it
  everywhere else too) — `goldenUpdateRequested(env)` takes `env` from the
  caller, which is exempt, for exactly this reason. Always review the diff a
  golden update produces before committing it; that is the entire point of a
  golden fixture over a hand-written assertion.
- Comparison is on the canonical JSON text, not `JSON.parse` output: a fixture
  whose key order or number formatting silently drifts between two runs that
  are supposedly deterministic is exactly the bug this exists to catch.

## The demo-seed generator (`@core/seed`)

`generateDemoData(seed, options?)` (master plan §5 Phase 0, "demo-seed
generator skeleton"; §6.4, "quality seed generator") produces 24 months of
deterministic, in-memory history for one household — six accounts (checking,
savings, credit card, brokerage, crypto exchange, mortgage), ~30 merchants with
realistic statement-descriptor noise (`SQ *…`, `TST* …`, `AMZN Mktp US*…`,
store numbers, city/state tails), transactions with a pending→posted lifecycle,
recurring series (monthly/biweekly/annual, one price increase, one dormancy),
internal transfers and refunds, and investment holdings/prices — plus the
ground-truth labels (`dataset.labels`) a recurring-detection or transfer-pairing
algorithm's tests are graded against.

```ts
import { generateDemoData, writeJson } from '@core/seed';

const dataset = generateDemoData(1); // 24 months, fixed calendar anchor
// accounts/merchants/transactions/holdings/prices/labels/meta.json:
await writeJson('/tmp/demo-seed', dataset);
```

```bash
just seed-stats seed=1                              # or: node packages/seed/src/cli.ts --seed=1 --stats
node packages/seed/src/cli.ts --seed=1 --out=DIR
```

- **Determinism is the one hard requirement**: `generateDemoData(1)` called
  twice produces byte-identical `JSON.stringify` output
  (`packages/seed/src/generate.test.ts`). The PRNG is a from-scratch
  `mulberry32` (twelve lines, seeded by one integer) — not `Math.random()`
  (unseedable) and not `@core/kernel`'s `newId()` (a real UUIDv7, which embeds
  the wall-clock millisecond it was generated at and would make every id, and
  therefore every downstream byte, different on every run). Every id in the
  dataset is a UUID-_shaped_ string drawn from the same `Rng`
  (`randomUuid()`), never `newId()`.
- **No `Clock`, no `Date.now()`, no real "today"**: the window anchors to a
  fixed calendar constant, not the day the generator happens to run.
- **Ground-truth labels**: `dataset.labels.transfers` — every internal-transfer
  pair nets to zero (`Money.add` of the two legs equals `Money.zero(currency)`,
  asserted as a property test over many seeds); `dataset.labels.recurringSeries`
  — every transaction id in a series resolves
  to a real transaction on the claimed account and merchant, and the dataset
  always includes exactly one price-increase series and one dormant series;
  `dataset.labels.refunds` — every refund resolves to the purchase it reverses
  and never exceeds it.
- **Owns no table.** `src/types.ts` is a plain, JSON-serialisable description
  of the generated shapes; mapping `SeedTransaction` to `@ctx/ledger`'s real
  `transactions` row is explicitly Phase 1's job, once that schema exists. See
  `packages/seed/OWNERSHIP.md`.

## Property tests (fast-check)

`fast-check` (already a repo dependency) is the standard tool for an algebraic
invariant — a claim that should hold for _every_ input in a space, not just the
handful of examples someone thought to type. Existing style to follow:
`packages/kernel/src/money.test.ts` (sign convention, `allocate`'s
largest-remainder distribution, rounding) and
`packages/contexts/ledger/src/effective.test.ts` (`resolveEffective`'s purity
and the category tier order). A property lives beside the function it tests,
in the same file as the function's example-based tests, not in a separate
`*.property.test.ts`.

Two gaps a Phase 1 quality pass (WP 1.7a) found and closed, worth knowing as
the pattern for the next one:

- **`packages/connectors/port/src/fingerprint.test.ts`** had zero property
  coverage despite `fingerprintOf` being exactly the kind of function
  properties exist for (a hash over normalised input). Added: stability under
  independent whitespace/punctuation noise and case for the same underlying
  words, and "changes when any of amount/date/currency/account changes."
- **`packages/contexts/ledger/test/read.test.ts`** had only example-based
  keyset-pagination coverage, and the examples never planted two rows sharing
  the cursor boundary's `effective_date` — the exact case the id half of the
  compound `(effective_date, id) < (cursor)` predicate exists for. A property
  test (`property: keyset pagination is a total order with no dupes or gaps,
for any calendar and page size`) closed it, and independently reproduced a
  sabotage failure (see below) with a _smaller_ shrunk counterexample than the
  hand-written regression test needed. Database-backed property tests
  (`fc.asyncProperty`) must `await database.truncate()` and reseed their own
  fixture at the top of the property function itself: fast-check iterates the
  property many times inside one Vitest `it`, not once per `beforeEach`.

## Sabotage evidence

A control that has never been observed failing is not evidence (the Phase 0
security gate's founding lesson — every control that had never been exercised
turned out to be decoration). Every new invariant this repo adds should have,
somewhere in its work package's evidence doc, a sabotage record: the exact
production-code mutation, the test that was run, and the failure output —
not just "this is tested," but "this was watched breaking." Precedents:
`docs/evidence/phase-1/wp1.2-connections.md` §4 (the conformance suite itself),
`wp1.3-plaid.md` §4 (the log-hygiene scanner), `wp1.4-categorization.md` §3
(the golden accuracy gate's merchant-memory tautology). The Phase 1 quality
pass's own twelve-invariant sabotage log — spanning the ledger (immutable
overlay, ambiguous-match refusal, cross-provider dedup, rejected-pair
persistence, the user-beats-rule tier order, keyset total order), connections
(atomic per-run commit, `MAX_RESTARTS`, balances failure isolation),
categorization (the golden gate's non-leaky configurations, the user tier's
absolute precedence) and the connector port (fingerprint stability) — is
`docs/evidence/phase-1/wp1.7-quality.md` §3. Three route-layer invariants
(auth/step-up, CSRF, keyset pagination at the HTTP layer) were read-audited
rather than sabotaged in that pass, because `apps/api/src` was being edited
concurrently by another agent in the same working tree at the time; §3b of
that file explains why and names what the next gate should sabotage directly.

## Seed-based end-to-end proof

`apps/api/test/db/phase1-seed-e2e.test.ts` (`api-db` project) is the
highest-altitude test in the repo: it loads `generateDemoData(1)` through the
real `ManualConnector`, a real `POST /connections`, the real
`SyncOrchestrator`, a real consumer pump built from `appModules()` (the exact
shape `worker.ts` builds), and reads the result back through the real
`GET /transactions` / `/accounts` / `/net-worth`. What makes it worth its
~13-second runtime: every number it asserts — transaction count, each
account's balance, net worth's assets/liabilities/net, categorization
coverage — is computed **independently from the seed generator's own output**,
in the test file itself, never by calling the API twice or by importing
`@ctx/ledger`'s internals. See the file's own header comment for the scope
decisions (pending→posted is intentionally not re-modelled here; CSV import is
intentionally a separate concern) and §5 of
`docs/evidence/phase-1/wp1.7-quality.md` for the three-attempt debugging trail
that got the categorization-coverage assertion to an exact reconciliation
rather than a loose threshold — itself evidence the test is not vacuous.

## CI parity

`.github/workflows/ci.yml`'s header comment carries the current vitest
project → CI job map and must be kept in sync by hand: `vitest.config.ts`
defines the projects, but nothing mechanically checks that every project
named there also appears in a CI job. Phase 0's gate found this gap once (4 of
13 projects covered); Phase 1's own quality pass found it recurring on the ten
projects Phase 1 itself had added (`ledger`, `ledger-db`, `categorization`,
`categorization-db`, `connector-port`, `connector-manual`, `connector-csv`,
`connector-plaid`, `connections`, `connections-db` — all ten were completely
absent from CI, only ever run locally via `just check`/`just test`, which do
not filter by project and were never the gap). Re-verify the map any time a
project is added, with `grep -oP "name: '[a-z0-9-]+'" vitest.config.ts | sort
-u` against the `--project` flags in `ci.yml`'s `test` and `migration-test`
jobs.

**This is now mechanical, not just hand-verified.** WP 2.12
(`docs/evidence/phase-2/wp2.12-quality.md` §2) added
`scripts/check-ci-projects.ts`: parses both `--project` lists and
`vitest.config.ts`'s project names, fails if a project is in neither list, in
the wrong job (a `-db`/`db`-named project outside `migration-test`, or a
non-db project missing from `test`), or if a list names a project that no
longer exists. `--self-test` runs the same four rules against fixtures
first, the `compose-hardening-check.sh --self-test` pattern extended to
TypeScript. Wired into `just check`'s own body (after its declared
dependencies run) and into `ci.yml`'s `lint` job, beside
`check-proxy-routes`.

## R-5: the merchant and provider-revision growth bound

Phase 1's R-5 ("no bound on distinct merchants or on `transactions_provider`
revisions; never promoted to a condition" — `docs/plan/02-phase-2-dispatch.md`
§2) is `packages/contexts/ledger/test/growth-bound.test.ts` (WP 2.12): three
real syncs of the identical ~50,040-transaction corpus
(`generateDemoData(1, { monthCount: 1264 })` — `generateDemoData`'s existing
`monthCount` option, no `@core/seed` code change needed, verified to
`transactions.length === 50_040` before the test was written) through the
real write path (`loadSeedDataset` → `applyProviderTransactions` →
`resolveMerchants`), asserting `merchants` row count _and ids_ and
`sum(transactions_provider.revision)` are unchanged after the second and
third sync. Sabotage-tested (see the evidence doc §5): a random suffix on
the merchant upsert's lookup key fragmented one 50k-row sync into 53
merchants instead of 32, red on the first try.

## Standalone Phase 2 scenario fixtures (`@core/seed`)

`packages/seed/src/phase2-scenarios.ts` (WP 2.12) adds three deterministic,
independently-tested fixtures a Phase 2 engine can load on top of —
never instead of — `generateDemoData`'s pinned default output:
`generateCardMigration`, `generateDuplicateService`,
`generateCreditOverspend`. Each is its own `SeedAccount`/`SeedTransaction`
set on its own RNG stream, precisely so `generateDemoData(1)`'s exact,
widely-pinned counts (982 transactions, 32 merchants, 6 accounts) never move.
See the module's own header comment for why a fourth scenario (quiet-hours
notification) is deliberately not a `@core/seed` concept at all — it is a
timing claim `@ctx/notifications`'s own test harness already owns, not a
data shape this generator has vocabulary for.

## Reports p95, over real HTTP

`apps/api/test/db/phase2-reports-http-perf.test.ts` (WP 2.12) is the HTTP-
level companion to `reports-aggregation.test.ts`'s in-process
`computeCategoryMonthActivity` timing (WP 2.8): a real bound Fastify server
(`ApiHarness.listen()`) and real `fetch()` calls (an actual TCP round trip,
which `app.inject()` never opens) against `GET /reports/spending`, on the
same 50,040-row seed `growth-bound.test.ts` uses. `reports-aggregation.test.ts`'s
own comment claiming `generateDemoData(1)` is "~50k rows" is stale —
`generateDemoData(1)` with no options is 982 transactions, checked directly —
so this file asserts its own dataset's size rather than repeating the claim.

## The Phase 3 investments seed, with ground truth (`@core/seed`)

`packages/seed/src/phase3-investments.ts` (WP 3.14) —
`generatePhase3Investments(seed, options?)` — is the investments companion to
`generateDemoData`, and additive in exactly the same way and for the same
reason as the Phase 2 scenarios above: `generateDemoData`'s output is pinned by
`@ctx/categorization`'s golden accuracy set and `@ctx/recurring`'s corpora, so
adding accounts to it would re-roll two phases' golden numbers to gain a
fixture.

What it carries, and why each item is there:

| In the dataset                                                                                                      | Forces                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 7 securities (ETF, equity, crypto with its `chain`, cash) with `ticker`/`cusip`/`isin`/`chain_contract` identifiers | the §5 exit criterion "ETH on Coinbase and in a wallet resolves to one security" has a subject with three identifiers |
| 14 investment transactions over 10 lots                                                                             | a FIFO sale that crosses a lot boundary **and** the one-year line — one sale, both terms                              |
| a lot transferred in with **no basis**                                                                              | unrealised gain must read `unavailable`, never gain-from-zero (04 §5.5)                                               |
| a loss and a repurchase 16 days later; a second loss and a repurchase on day **31**                                 | both sides of the 61-day wash-sale boundary, the second in an IRA                                                     |
| an 18-decimal ETH quantity, disposed of across a lot boundary                                                       | `NUMERIC(38,18)` arithmetic, and `Money.allocate`'s exact split                                                       |
| a **CAD** account, and an FX series with **exactly one declared gap**                                               | a missing rate surfaces; it never becomes 1.0 (D4)                                                                    |
| a manual asset and a liability                                                                                      | the net-worth exit criterion names both                                                                               |
| a cash position                                                                                                     | the allocation denominator                                                                                            |

**The ground truth is declared, not computed.** Every lot's expected basis,
`quantity_remaining`, short-term/long-term split and every `POSSIBLE_WASH_SALE`
(including the one that must **not** be flagged) is a hand-computed literal
with its arithmetic beside it. `packages/seed/test/investments-ground-truth.test.ts`
feeds the generator's _transactions_ — never its expectations — into
`@ctx/investments`' pure engine and compares the two derivations. A fixture
generated by the code under test asserts only that the code is self-consistent;
this is the same rule WP 3.3's spreadsheet fixture states for allocation, and
that fixture is re-run from the seed's own vocabulary in the same file.

That test file is the one place `@core/seed` reaches across a package
boundary, by relative import, with `personalfi/layer-imports` disabled on the
line and the reason in the file header. Nothing under `packages/seed/src/`
imports a context: the shipped generator still depends on `@core/kernel` alone.

## Repo checks: `--self-test` first, then the real tree

`scripts/check-*.ts` and `scripts/*-check.sh` are static checks over
checked-in files — no database, no build. Every one of them runs its own
fixtures **before** it looks at the repository, so the check has been observed
catching the thing it exists for rather than only observed passing:

| Check                                                     | Catches                                                                             | Wired into                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| `check-ci-projects.ts`                                    | a vitest project in no CI job, a stale `--project` name, a project in the wrong job | `just check`, `ci.yml` `lint` |
| `check-proxy-routes.ts`                                   | an API prefix Caddy does not route                                                  | `just check`, `ci.yml` `lint` |
| `check-schema-ownership.ts`                               | a table claimed by two packages                                                     | `pnpm run lint`               |
| `check-numeric-boundaries.ts`                             | **a float at a money or quantity boundary**                                         | `just lint`, `ci.yml` `lint`  |
| `compose-hardening-check.sh`, `check-secret-ownership.sh` | container hardening, secret file ownership                                          | `just verify`                 |

### `check-numeric-boundaries.ts` (WP 3.14)

08 §6.5's lint rule, mechanised: _"a lint rule bans `number` in any identifier
matching `/amount|balance|price|value|cost/`"_, plus `quantity` from the Phase 3
dispatch. It parses `packages/**/*.ts` and `apps/api/src/**/*.ts` with the
TypeScript parser (syntax only — no `Program`, no type checker, ~1s over ~680
files) and reports two rules:

- **`number-at-a-magnitude-boundary`** — a property, parameter, variable, type
  alias, object-literal property or same-named function return typed `number`
  (including `number | null`, `number[]`, `Record<K, number>`), or with no
  annotation and a numeric-literal initialiser.
- **`tofixed-on-a-magnitude`** — `<magnitude>.toFixed(…)`. Phase 1 caught
  `toFixed(18)` manufacturing seventeen digits of garbage from `268.4`, and the
  §5 risk table asks the gate to grep for new ones; a grep a human runs once is
  not a control.

Exemptions are narrow and printed by `--explain`: name-shape categories (a
cardinality, a dimensionless statistic, a duration, a confidence score, a
`toNumberApproximate`-style presentation helper, `value`/`values` as a
_parameter_ — never as a property) and a file+identifier allow-list where every
entry states why the thing is not a magnitude. There is no `eslint-disable`-
shaped escape hatch: adding a violation means editing the script and writing
down why. Fixtures live in `scripts/fixtures/numeric-{bad,good}.ts` — the good
one exists so a future "fix" cannot make the rule flag everything.

```bash
node scripts/check-numeric-boundaries.ts             # self-test, then the real tree
node scripts/check-numeric-boundaries.ts --self-test # fixtures only
node scripts/check-numeric-boundaries.ts --explain   # list every exemption used
```

## Investments perf budgets, over real HTTP

`apps/api/test/db/investments-perf.test.ts` (WP 3.14) measures `GET /holdings`,
`GET /investments/allocation` and `GET /net-worth/series` the way
`phase2-reports-http-perf.test.ts` established: `ApiHarness.listen()` + real
`fetch()`, warm-ups excluded, every sample printed. The rows are the Phase 3
seed's own (`generatePhase3Investments`), so the dataset the budget is measured
over is the dataset the correctness suite reasons about; `net_worth_daily` is
written by `@ctx/planning`'s `computeNetWorth` → `upsertOpenDay`, the two calls
the 04:00 job makes. Budgets: **p95 < 200 ms** for each, against 08 §7.1's
150 ms for a 1,825-point net-worth chart. The suite asserts its own row counts
before it times anything — a perf number over an empty table is a lie.
