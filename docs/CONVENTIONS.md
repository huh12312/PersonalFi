# PersonalFi conventions

The rules every work package builds on. Most are mechanised — if a rule here is
not enforced by `pnpm lint`, `pnpm typecheck`, or a test, say so and fix it.

## Running everything

```bash
just install        # pnpm install --frozen-lockfile
just db-up          # dev Postgres on 127.0.0.1:5433 (docker compose)
just migrate        # apply pending migrations under an advisory lock
just check          # typecheck + lint + test, exactly what CI runs
just typecheck      # tsc -p tsconfig.json
just lint           # prettier --check, eslint (+ boundaries), schema ownership
just test           # full vitest suite
just test-unit      # unit projects only; needs no database
just openapi        # regenerate packages/contracts/openapi/openapi.json
just dev            # run the API against the dev database
just migrate-new name=add_holdings
just db-down        # stop the database (volume survives)
just db-reset       # stop it and destroy the volume
```

There is **no build step** in development or CI. Node 26 strips types at runtime
and every package's `exports` points at `src/*.ts`, so `node apps/api/src/main.ts`
just runs. Bundling for the container image is WP 0.4's problem, not a daily one.

## Package layout

```
apps/api               Fastify shell: health/ready, OpenAPI, problem details, logging
apps/web               placeholder (WP 0.5)
packages/kernel        @core/kernel    Money, Quantity, DateOnly, Clock, ids, Result
packages/config        @core/config    zod-validated config, Redacted<T>
packages/db            @core/db        Drizzle columns, pool, migration runner, platform tables
packages/contracts     @core/contracts openapi.json + advisor.schema.json
packages/contexts/*    @ctx/<name>     the eleven bounded contexts
scripts/               boundary rule, schema-ownership check
```

## The dependency rule

```
kernel                     imports nothing (decimal.js and uuid only)
  ^
config, contracts, db      may import kernel
  ^
contexts                   may import kernel, config, db, contracts — NEVER another context
  ^
apps                       the composition root; the only layer allowed to wire things up
```

Enforced by `personalfi/layer-imports` in `eslint.config.js` (implemented in
`scripts/eslint-boundaries.js`). It is an **allow-list**: a package not named in
the layer's policy is denied. Adding a runtime dependency to a context means
editing that policy, deliberately, in a reviewable diff.

Where a cycle seems necessary, the answer is a domain event, not an import.

Two more bans, same file:

- `process.env` outside `@core/config`. Config that can be read anywhere cannot be
  validated anywhere.
- `Date.now()` and `new Date()` outside `Clock`. Time-dependent bugs are the
  dominant bug class in budgeting and recurring detection.

## Table ownership

Exactly one package may own a table. `pnpm lint:schema-ownership` reads every
`OWNERSHIP.md` and fails if a table is claimed twice, defined outside its owner,
created by a migration without an owner, or referenced in another package's SQL.

Claims may run ahead of reality: each context already claims the tables it will
own, so a naming collision surfaces at design time rather than at migration time.

## Adding a bounded context

1. `packages/contexts/<name>/` with `package.json` (`@ctx/<name>`, `exports` for
   `.` and `./schema`), `src/index.ts`, `schema/index.ts`, `OWNERSHIP.md`.
2. `src/index.ts` is the **only** public surface. Everything else is internal.
3. List the tables it will own under `## Tables` in `OWNERSHIP.md`.
4. Add a project to `vitest.config.ts` once it has tests.
5. Ship it behind `module.<name>` in `feature_flags`. A disabled module registers
   no consumers and no schedules, so a half-finished phase can merge to `main`
   instead of living on a branch for six weeks.

## Adding a migration

1. `just migrate-new name=add_holdings` — creates `packages/db/migrations/NNNN_add_holdings.sql`.
2. Write plain SQL. Forward-only: there are no down migrations. The recovery path
   for a single-user app is restore-from-backup, and an untested `down` script is
   false comfort.
3. Define the Drizzle table in the **owning context's** `schema/` directory and
   claim it in that package's `OWNERSHIP.md`.
4. `just migrate`, then `just psql` to confirm.

**Once merged, a migration file is immutable.** The runner records a SHA-256 and
refuses to start if the file changes. To alter a table, add a new migration.

Anything destructive uses expand → backfill → contract across releases: add a
nullable column, backfill in a job, switch reads, switch writes, drop the old
column later. Migrations run at API boot, so one that locks `transactions` for
40 seconds is how a nightly sync gets missed.

## Money

- `Money = { minor: bigint; currency: CurrencyCode }`. Integer minor units, always
  paired with a currency. **Never a float, anywhere, in the ledger.**
- Columns: `BIGINT` + `CHAR(3)`, via `amountMinorColumn()` and `currencyColumn()`.
- Arithmetic only through `Money.*`. `add` on mismatched currencies throws; it
  does not coerce.
- `Money.allocate` uses largest-remainder distribution, so splitting $10 three
  ways gives 3.34 / 3.33 / 3.33 and no cent is lost.
- Rounding is banker's (half-even) by default and must be an explicit act.
- On the wire: `{ "minor": "1234", "currency": "USD" }` — minor units as a
  **string**. `bigint` and IEEE-754 both make a JSON number a liability.
- **Sign convention: negative = outflow, positive = inflow.** Every provider
  adapter normalises to it at the edge. Plaid uses the opposite convention.
- Quantities are **not** money: `Quantity` is a decimal string in
  `NUMERIC(38,18)`. A BTC balance is a quantity of a security with a price, not
  money in BTC.
- Prices and FX rates are `NUMERIC(20,10)`, not minor units.
- Floats are correct for Monte Carlo, percentages, and confidence scores. They may
  never flow back into a `*_minor` column without an explicit, rounded conversion.

## Time

- Instants are `TIMESTAMPTZ`, stored UTC, carried as `Date`. Business dates are
  `DATE`, carried as `DateOnly` (`YYYY-MM-DD`), with no zone. Never mix them.
- Converting a bank's posted date through a timezone is how a 2026-03-01
  transaction becomes 2026-02-28 for a user in UTC-5. `DateOnly` makes that
  impossible; the `date` type parser is overridden so the driver cannot undo it.
- Every period boundary — budget months, "today", digests, the daily snapshot
  seal — is computed in the _user's_ zone via `todayIn(clock, zone)`. Never the
  container's `TZ`, never the browser's.
- `Clock` is injected everywhere. `systemClock` in production, `fixedClock` and
  `mutableClock` in tests.

## Identifiers

UUIDv7, generated app-side with `newId()`, never `gen_random_uuid()`. Time-ordered
keys keep inserts at the right edge of the b-tree, and knowing the id before the
`INSERT` is what lets an aggregate and its outbox event share one transaction.
Provider natural keys are separate unique columns.

## Ownership column

Every user-scoped table carries `user_id` from the first migration (decision D6).
Single user now; multi-user is additive later. A migration test asserts it.

## Errors

RFC 9457 problem details, `application/problem+json`. Clients switch on `code`,
never on `detail`: user-facing copy gets rewritten a dozen times.

| Family      | Meaning                                    | HTTP    | Logged at      |
| ----------- | ------------------------------------------ | ------- | -------------- |
| `user`      | The request was invalid or not permitted   | 4xx     | `info`         |
| `domain`    | A business invariant refuses the operation | 409/422 | `warn`         |
| `connector` | Something outside our boundary failed      | 502/503 | `warn`/`error` |
| `internal`  | Our bug                                    | 500     | `error`        |

An unrecognised exception is `internal`: fail closed, return an id, leak nothing.

## Logging

Structured JSON (pino) with a `correlationId` on every line, taken from the
caller's `x-correlation-id` when supplied so one id spans a browser request, the
API, and a background job. `REDACTED_PATHS` in `apps/api/src/logging.ts` scrubs
tokens, keys, and account numbers; a secret should already be a `Redacted<T>`, and
this is the second line of defence.

## Configuration

Non-secrets from env, validated by zod at boot; secrets from files under
`SECRETS_DIR`. Boot fails fast and prints **every** problem at once — a container
that starts half-configured and dies at 03:15 mid-sync is far worse than one that
never starts. No secret value ever appears in an error message. User _preferences_
(base currency, period start, quiet hours) live in the database, not in env: they
are user data and belong in the export and the backup.

## Dependencies

Pinned to exact versions (`save-exact=true`), install scripts disabled
(`ignore-scripts=true`), and a seven-day `minimumReleaseAge` before any package
may be installed. Licences: MIT, BSD, ISC, Apache-2.0 only. Check the npm
registry `license` field before adding anything, and prefer not adding it.
