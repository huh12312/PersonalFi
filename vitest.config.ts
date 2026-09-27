// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

/**
 * One root config with a project per package.
 *
 * Unit projects must not need Postgres: the whole point of pure kernel types and
 * pure engines is that most of the suite runs in milliseconds. The `db`
 * integration project is separate and skips itself when `DATABASE_URL` is unset,
 * so `pnpm test` works on a laptop with nothing running.
 */
export default defineConfig({
  test: {
    projects: [
      {
        root: './packages/kernel',
        test: { name: 'kernel', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        root: './packages/config',
        test: { name: 'config', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        root: './packages/db',
        test: {
          name: 'db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          // Applying migrations is not parallel-safe against one database.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        root: './packages/platform',
        test: { name: 'platform', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // Everything here needs a real Postgres, and says why in its own file:
        // SKIP LOCKED, advisory locks, ON CONFLICT and transaction rollback are
        // properties of the database, and a fake would only assert that the fake
        // works. Skips itself when DATABASE_URL is unset.
        root: './packages/platform',
        test: {
          name: 'platform-db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          // Each suite owns a scratch database, but they all share one server and
          // several take advisory locks; serial keeps failures readable.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // `@core/testkit`'s own source lives in `test/`, not `src/` (see its
        // package.json and OWNERSHIP.md): it reads TEST_ADMIN_DATABASE_URL and
        // spawns real processes, both of which the repo's lint rules — the
        // process.env ban outside @core/config, the Date.now() ban outside
        // Clock — only exempt for a `test/` directory. It is dev/test tooling
        // through and through, so the exemption fits the code, not just the
        // linter.
        //
        // Includes both plain unit tests (golden fixtures, `endPool` timeout)
        // and `describe.skipIf(ADMIN_URL === undefined)` suites that need a
        // real Postgres — see docs/TESTING.md. Not split into a `-db` project
        // like `platform`/`secretbox`/`identity`: every file here already
        // guards its own database-dependent `describe` blocks, so a laptop
        // with no database running still gets the (larger) unit-test share of
        // this project green.
        root: './packages/testkit',
        test: {
          name: 'testkit',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // WP 3.14 added `test/` to the include: the investments ground-truth
        // suite lives in `packages/seed/test/` (the path the Phase 3 dispatch
        // §3 names for it) rather than beside the generator in `src/`, because
        // it drives another package's engine over this package's output and is
        // not part of the generator itself.
        root: './packages/seed',
        test: {
          name: 'seed',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // WP 3.14. The repo's checked-in repo checks (`check-ci-projects.ts`,
        // `check-numeric-boundaries.ts`, ...) are TypeScript with exported pure
        // functions and their own `--self-test`; this project is where the
        // vitest half of that lives, so a check's rules can be driven over
        // fixture *strings* as well as over the real tree. No Postgres, no
        // build — it reads checked-in files only.
        root: './',
        test: { name: 'scripts', include: ['scripts/**/*.test.ts'], environment: 'node' },
      },
      {
        root: './packages/secretbox',
        test: { name: 'secretbox', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // The envelope's round trip is a property of the `bytea` column, and P0-1
        // ("read the raw column, assert no plaintext") cannot be asserted against
        // a fake at all. Skips itself when DATABASE_URL is unset.
        root: './packages/secretbox',
        test: {
          name: 'secretbox-db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        root: './packages/contexts/identity',
        test: { name: 'identity', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // Sessions, lockout and TOTP replay are all "does the database enforce
        // this?" questions: single-use is an `UPDATE ... WHERE used_at IS NULL`,
        // and rate limiting that survives a restart is by definition not in
        // memory. Skips itself when DATABASE_URL is unset.
        root: './packages/contexts/identity',
        test: {
          name: 'identity-db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        root: './packages/contexts/ledger',
        test: { name: 'ledger', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        root: './packages/contexts/categorization',
        test: {
          name: 'categorization',
          include: ['src/**/*.test.ts', 'test/golden.test.ts'],
          environment: 'node',
        },
      },
      {
        root: './packages/contexts/categorization',
        test: {
          name: 'categorization-db',
          include: ['test/**/*.test.ts'],
          exclude: ['test/golden.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
      {
        // Every claim in these suites is a claim about Postgres: a unique index
        // arbitrating a replayed sync page, a keyset scan that stays stable while
        // rows are inserted above it, a partial index making "what is pending?"
        // cheap, a `LEFT JOIN LATERAL` finding the latest balance per account. A
        // fake would only assert that the fake works. Skips itself when
        // DATABASE_URL is unset.
        //
        // Serial, and with a long timeout: the suites share one server, each owns
        // a scratch database, and two of them are deliberately heavy — the seed
        // loader pushes ~1,000 transactions through the real write path and
        // `perf.test.ts` loads 50,000 rows to measure the list page.
        root: './packages/contexts/ledger',
        test: {
          name: 'ledger-db',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
      {
        // WP 1.2. The `Connector` port: the error taxonomy's condition -> kind
        // table, the mandatory fingerprint, and the history-window clamp. Pure
        // functions over pure data; no database, no network, no adapter.
        root: './packages/connectors/port',
        test: { name: 'connector-port', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // The manual adapter's own unit tests: the append-only log the cursor is
        // an index into, and the sequence semantics every cursor property rests
        // on. The conformance suite runs against it from the `connections`
        // project, which is where the adapters are wired together.
        root: './packages/connectors/manual',
        test: { name: 'connector-manual', include: ['src/**/*.test.ts'], environment: 'node' },
      },
      {
        // CSV/OFX/QIF parsing, including the golden tests against the
        // hand-written fixtures in `test/fixtures/`. `src/` holds the scalar
        // parsers' unit tests and `test/` the fixture-driven ones, because a
        // golden fixture belongs to the package that owns the behaviour it pins
        // (docs/TESTING.md) and needs the file on disk.
        root: './packages/connectors/csv',
        test: {
          name: 'connector-csv',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // WP 1.3. The Plaid adapter, driven end to end by `FakePlaidApi` over
        // recorded-shape fixtures: the shared conformance suite, the request
        // pins, every row of the error map, the sign inversion, pending→posted,
        // and the log-hygiene check. No network and no database — the whole
        // point of an adapter that returns data instead of writing it. The live
        // Sandbox smoke lives in the same project and skips itself when
        // PLAID_CLIENT_ID/PLAID_SECRET are unset.
        root: './packages/connectors/plaid',
        test: {
          name: 'connector-plaid',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        // Phase 3 WP 3.5 (docs/plan/03-phase-3-dispatch.md §3): driven end to
        // end by a hermetic FakeCoinbaseApi, like connector-plaid; its live
        // smoke skips itself when the coinbase_* secret files are absent, which
        // they are in CI. Registered only once the package existed — a vitest
        // project whose root directory is missing breaks every run.
        root: './packages/connectors/coinbase',
        test: {
          name: 'connector-coinbase',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        // Phase 3 WP 3.6: the watch-only wallet connector. xpub derivation is
        // local (published BIP32/84 vectors), balances come from fake Esplora /
        // Etherscan servers; nothing here touches the network.
        root: './packages/connectors/walletrpc',
        test: {
          name: 'connector-walletrpc',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        // Phase 3 WP 3.1/3.2/3.3: the resolver's merge rules, lot maths and
        // portfolio analytics are pure over Quantity + Money; they run here.
        root: './packages/contexts/investments',
        test: {
          name: 'investments',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // One security_id per real security across identifier kinds, holdings
        // snapshots and lot persistence are claims about Postgres.
        root: './packages/contexts/investments',
        test: {
          name: 'investments-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // Phase 3 WP 3.4: the PriceSource port, its four provider adapters
        // (Tiingo, FRED, CoinGecko, OpenFIGI), rate-limit budgets and the
        // egress matrix — all against fakes and a local listener, never the
        // network. The live smokes skip without a key.
        root: './packages/contexts/integrations',
        test: {
          name: 'integrations',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Price/FX persistence, `price_source_priority` and the raw-column
        // custody read ('the raw column contains no plaintext API key') are
        // claims about Postgres.
        root: './packages/contexts/integrations',
        test: {
          name: 'integrations-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // Phase 3 WP 3.8 opens exactly one table of the Phase 4 planning
        // context (`net_worth_daily`). The pure parts — the four-boolean
        // aggregate, FX on the aggregate, interpolation policy — run here.
        root: './packages/contexts/planning',
        test: {
          name: 'planning',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          // WP 4.5's timing test runs in its own project below so it is never
          // measured under the rest of this suite's contention.
          exclude: ['src/engine/perf.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        // WP 4.5's 800 ms p95 exit criterion (docs/plan/04-phase-4-dispatch.md
        // §3 "WP 4.5"): 10,000 Monte Carlo paths over 40 years on one core.
        // Isolated from the `planning` project so no sibling file shares the
        // box while it samples — under a shared run p95 read 1,155 ms; alone
        // it reads ~590 ms (wp4.5-montecarlo.md §7). This isolates it from
        // this suite, not from other processes: a red here on a loaded machine
        // is re-run alone before it is believed.
        root: './packages/contexts/planning',
        test: {
          name: 'planning-perf',
          include: ['src/engine/perf.test.ts'],
          environment: 'node',
          fileParallelism: false,
          sequence: { groupOrder: 1 },
          testTimeout: 120_000,
        },
      },
      {
        // The seal ('a past date is byte-identical after a second snapshot
        // run'), the calendar spine and the hand-computed reconciliation are
        // claims about Postgres.
        root: './packages/contexts/planning',
        test: {
          name: 'planning-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // `@ctx/connections`, minus the database. The conformance suite lives
        // here — it needs three real adapters and no Postgres, which is exactly
        // the shape of a unit project.
        root: './packages/contexts/connections',
        test: {
          name: 'connections',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Phase 2 WP 2.2/2.3 (docs/plan/02-phase-2-dispatch.md §3). The engine
        // is pure; its golden-corpus gates live under test/ but need no
        // database, so they run here rather than in `recurring-db`.
        root: './packages/contexts/recurring',
        test: {
          name: 'recurring',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // WP 2.3's persistence, lifecycle and consumer claims are claims about
        // Postgres (idempotent replay, merchants-unchanged, forecast rows).
        // Skips itself when DATABASE_URL is unset, like every other `*-db`.
        root: './packages/contexts/recurring',
        test: {
          name: 'recurring-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // Phase 2 WP 2.1 (docs/plan/02-phase-2-dispatch.md §3): envelope math
        // and the RTA identity are pure over Money; those run here.
        root: './packages/contexts/budgeting',
        test: {
          name: 'budgeting',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Period rolls across DST, the actuals consumer, and the identity
        // asserted after every mutation on the seed are claims about Postgres.
        root: './packages/contexts/budgeting',
        test: {
          name: 'budgeting-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // Phase 2 WP 2.4 (docs/plan/02-phase-2-dispatch.md §3): the egress
        // allow-list, quiet-hours and coalescing rules are pure; they run here.
        root: './packages/contexts/notifications',
        test: {
          name: 'notifications',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // The outbox's at-most-once `dedupeKey`, the sealed channel-config
        // custody read, and dead-letter recovery are claims about Postgres.
        root: './packages/contexts/notifications',
        test: {
          name: 'notifications-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // Phase 2 WP 2.6/2.7 (docs/plan/02-phase-2-dispatch.md §3): the
        // Advisor-contract validation pipeline, the snapshot builder over a
        // fake port, and the built-in rule catalog are pure; they run here.
        root: './packages/contexts/insights',
        test: {
          name: 'insights',
          include: ['src/**/*.test.ts', 'test/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // `pending_review` persistence, dedupe/cooldown and the kill switches
        // are claims about Postgres.
        root: './packages/contexts/insights',
        test: {
          name: 'insights-db',
          include: ['test/db/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
      {
        // The orchestrator's claims are all claims about Postgres: that a page's
        // ledger rows and its cursor advance commit together, that an injected
        // failure mid-pagination leaves both consistent, that a restart rewinds
        // the stored cursor, that `sync_runs` records every attempt. A fake
        // would only assert that the fake works. Skips itself when DATABASE_URL
        // is unset.
        root: './packages/contexts/connections',
        test: {
          name: 'connections-db',
          include: ['test/db/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        root: './apps/api',
        test: { name: 'api', include: ['test/*.test.ts'], environment: 'node' },
      },
      {
        // The log-hygiene evidence (P0-12) boots the real application against a
        // real database, because what it asserts is that nothing secret reaches
        // the log on the path a real boot takes.
        root: './apps/api',
        test: {
          name: 'api-db',
          include: ['test/db/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/cli/**'],
    },
  },
});
