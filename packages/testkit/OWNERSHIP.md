# `@core/testkit` — table ownership

Shared test infrastructure: a scratch Postgres per suite, process-spawning
helpers for drills like `worker-restart.test.ts`, golden-fixture I/O, and small
deterministic doubles (`fixedClock`, `recordingLogger`). It is dev/test tooling,
never imported by production code (`apps/*/src`, `packages/*/src` outside a
`test/` tree or a `*.test.ts` file).

`createTestDatabase` creates and drops whole scratch **databases** — that is
infrastructure a test harness needs, not a claim on any table inside them. Every
row it writes (the seeded `users` row used to satisfy foreign keys) is written
into a table another package already owns and claims; see
`packages/contexts/identity/OWNERSHIP.md` for `users`.

## Why this package's source lives in `test/`, not `src/`

Every other package in the repo points its `exports` at `src/*.ts`
(`docs/CONVENTIONS.md`). This one points at `test/index.ts`, deliberately: two
repo-wide lint rules — `process.env` restricted to `@core/config`, `Date.now()`/
`new Date()` restricted to `Clock` — carry a `**/test/**` exemption (alongside
`*.test.ts`) for exactly the reason this package exists: a harness has to read
`TEST_ADMIN_DATABASE_URL` and poll a real wall clock while it waits on a spawned
process or a database. Calling the directory `src/` and then fighting the
linter file-by-file would say the opposite of what the code is. `check-schema-
ownership.ts`'s raw-SQL check carries the same `test/` exemption, which is also
why `createTestDatabase`'s `INSERT INTO users` does not need this file listed as
an owner of anything.

## Depends on

- `@core/kernel` (ids, `fixedClock`)
- `@core/db` (pool, migration runner)
- `@core/platform` (`toInstant`/`toInstantOrNull`, re-exported — raw
  `db.execute(sql\`...\`)`reads come back as strings; nothing else here uses`@core/platform`)

## Tables

_(none — this package owns no tables and defines no `pgTable` calls)_
