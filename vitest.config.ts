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
        root: './packages/seed',
        test: { name: 'seed', include: ['src/**/*.test.ts'], environment: 'node' },
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
