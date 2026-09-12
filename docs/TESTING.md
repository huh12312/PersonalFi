# Testing

What runs where, how database-backed tests work, how golden fixtures work, and
what the demo-seed generator is for. Everything mechanised here is asserted by
`just check`; this document explains the _why_ behind the mechanism.

## Layout

`vitest.config.ts` is one root config with a project per package (`just
--list` / `pnpm exec vitest run --project <name>` to run one). Two shapes:

- **Unit projects** (`kernel`, `config`, `seed`, `platform`, `api`, ...) need no
  database and no network. `just test-unit` runs the unit-only subset.
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
