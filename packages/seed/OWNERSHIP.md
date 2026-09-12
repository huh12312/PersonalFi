# `@core/seed` — table ownership

The deterministic demo-seed generator (master plan §5, Phase 0: "demo-seed
generator skeleton"; §6.1, Quality engineer: "seed generator"). Given an integer
seed it produces 24 months of typed, in-memory data for one household —
accounts, merchants with realistic descriptor noise, transactions, recurring
series, transfers, refunds, holdings and prices — plus the ground-truth labels
(which transactions are the same recurring series, which pairs are transfers)
that a detection algorithm's golden tests are graded against.

It defines **no `pgTable` calls and owns no table**. `src/types.ts` is a plain
TypeScript description of the generated shapes, deliberately decoupled from any
context's schema; the comment at the top of that file says explicitly that
mapping a `SeedTransaction` to `@ctx/ledger`'s `transactions` row (or a
`SeedHolding` to `@ctx/investments`'s tables) is Phase 1's job, once those
contexts' schemas exist and are stable. Writing Drizzle tables here now would
mean the seed package either duplicates a schema decision the owning context
hasn't made yet, or reaches into a context's schema module and violates the
dependency rule (`@ctx/*` may not be imported by a `@core/*` package) the moment
it does.

## Depends on

- `@core/kernel` (`Money`, `Quantity`, `DateOnly`, `Clock`, ids) — nothing else.
  No `@core/db`, no Drizzle, no Postgres: the generator's output is plain
  objects and JSON, checked with `writeJson()`.

## Tables

_(none — this package owns no tables and defines no `pgTable` calls)_
