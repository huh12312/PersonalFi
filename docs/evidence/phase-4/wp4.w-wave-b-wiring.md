# WP 4.w — Phase 4 Wave B wiring batch

Orchestrator's evidence for the finishing pass over `apps/api/src/{domain,main,worker}.ts`,
`RUNBOOK.md`, and two `apps/api/test` files, closing WP 4.3 §8, WP 4.2 §9 item 5, WP 4.7's
orchestrator section, and WP 4.12a §4's RUNBOOK line.

## 0. Starting state

A previous agent was killed by an account limit mid-batch. What it had written was
snapshot-committed (`5f3df45`, not pushed) and turned out to be **complete and correct** for three
of the four bindings: `apps/api/src/domain.ts` already carried WP 4.3's
`planningCashflowReaderFor` / `planningSpendingReaderFor` / `planningRevealedPortsFor` and WP 4.7's
`targets`/`employerStock`/`idleCash` composition inside `createInsightsInvestmentsPort`, verbatim
against §8.1 and §7.1 of their respective evidence docs; `apps/api/src/main.ts` and
`apps/api/src/worker.ts` already carried the two `loadAssumptions()` calls; `RUNBOOK.md` already
carried WP 4.12a §4's sentence; `apps/api/test/db/phase3-advisors.test.ts` already had
`wrapWithGapFieldSources` retired in favour of calling the real port. What was missing was the
runtime proof for WP 4.3 (`apps/api/test/db/revealed-ports.test.ts` did not exist), a boot test for
WP 4.2's item 5, and — found only by running the retired-decorator test for real — one live defect
and one un-exercised composition path in WP 4.7's own binding. This document is the finishing pass:
what was verified as-is, what was added, what was found broken and fixed, and every sabotage run to
prove each control.

`git diff apps/api/src/{domain,main,worker}.ts` against `HEAD~1` and `RUNBOOK.md`'s diff were read
in full before anything below; none of the four needed a further line changed. Every code change in
this pass is confined to the two test files this batch owns.

## 1. WP 4.3 — the two revealed-behaviour ports

| Binding                          | `apps/api/src/domain.ts`               | Real-thing test                           |
| -------------------------------- | -------------------------------------- | ----------------------------------------- |
| `CashflowReader`                 | `planningCashflowReaderFor`, line 2750 | `apps/api/test/db/revealed-ports.test.ts` |
| `SpendingReader`                 | `planningSpendingReaderFor`, line 2845 | same                                      |
| `RevealedPorts` (both, composed) | `planningRevealedPortsFor`, line 2854  | same                                      |

**New file: `apps/api/test/db/revealed-ports.test.ts`** (project `api-db`). This is the committed
runtime twin WP 4.3 §8.4 asked for, over `generateDemoData(1)` loaded through `@ctx/ledger`'s real
`loadSeedDataset` (real write path, real `pairTransfers` heuristic, real refund detector) and read
back through `planningRevealedPortsFor` exactly as `domain.ts` composes it — not a second
implementation of the arithmetic.

Asserted, before any budget exists:

- `income.takeHome.total` = `80600.00`, `observationCount` = 26
- `contributions.byBucket.TAXABLE.total` = `4000.00`; `TAX_DEFERRED`/`ROTH`/`HSA` = `not_derivable`
- `savingsRate` = `{ status: 'derived', rate: '0.0496' }`
- income exclusions: 12 `internal_transfer` + 2 `refund` = 14 total; 0 `contributions`, 0 `spending`
- `spending.essential.status` = `not_derivable` (no budget yet), `spending.budgetId` = `null`

Then a real budget is built over the real ledger — `createBudget` / `openPeriod` (both exported by
`@ctx/budgeting`) for the 13 calendar months 2025-08…2026-08, one `Rent` (`NEED`, $2,000.00/mo), one
`Dining` (`WANT`, $300.00/mo), one `Miscellaneous` (`class: null`, $150.00/mo) line per period, with
the 2025-08 period **planted at 100×** ($200,000.00/$30,000.00/$15,000.00) — one calendar month
_before_ the derivation's trailing 12-month window, so reading it would show by two orders of
magnitude. Each line is created through the real `POST /budgets/lines` route (`upsertLine` is not on
`@ctx/budgeting`'s public surface — `apps/api/src/routes/budgets.ts`'s own comment says so, "not on
the context's public surface, re-implemented here against its published `./schema`" — so the route
is the real thing here, exactly as `apps/api/test/db/budgets-dirty-on-create.test.ts` already
established), and each period is recomputed through the real `recomputePeriod` over
`createBudgetingLedgerPort` (the identical adapter `apps/api/src/modules.ts` registers for the
production actuals consumer).

**A finding along the way, fixed in the harness, not in `createBudget`**: the seed's credit card
account has real historic activity and no card-payment envelope of its own. Left on-budget, the
first `POST /budgets/lines` call failed `budgeting.card_identity_violation`
("owed 3908.02 ≠ available -1886.35 + unfunded 0.00") — a real invariant (`identityHolds`,
`packages/contexts/budgeting/src/rta.ts`), correctly enforced, tripped by a fixture that had no
business touching that card at all. Fixed by passing `offBudgetAccountIds: [creditAccountId]` to
`createBudget`, which is also the honest modelling choice: nothing in this fixture builds that
card's own payment tracking.

After the budget: `savingsRate` and `income.takeHome` unchanged; `spending.budgetId` = the new
budget's id; `spending.essential` = `24000.00`, `discretionary` = `3600.00`, `unclassified` =
`1800.00`, `nonSavings` = `29400.00`; spending exclusions = 0 (twelve equal months per line clears
nothing); income exclusions unchanged at 14.

**Why 14, not 15.** `packages/contexts/planning/test/revealed-seed.test.ts`'s fake-port walk totals
15 exclusions because its fixture also runs the seed's own merchant categories through a
planning-test-only `SEED_CATEGORY_CLASS` mapping and picks up one spending one-off. This file's own
budget has three lines with constant monthly amounts and nothing to flag. WP 4.3's own evidence says
so directly, §7.2: "the real ledger with the real heuristic gives exactly the fake-port walk of §3
(same totals, **same 14 named rows**)". 14 is asserted here for that reason.

### Sabotage — wrong context function in a reader

`planningCashflowReaderFor`'s `accounts()` (domain.ts:2764) — `taxBucket: defaultTaxBucketFor(...)`
→ `taxBucket: null`.

```
AssertionError: TAXABLE contributions: expected 'not_derivable' to be 'derived'
```

Restored; `git diff --stat apps/api/src/domain.ts` empty afterwards. Re-run: green (17/17 across the
three `api-db` files below).

## 2. WP 4.2 §9 item 5 — `loadAssumptions()` at boot

| Process | `apps/api/src/{main,worker}.ts`                         |
| ------- | ------------------------------------------------------- |
| API     | `main.ts:34`, before `createPool` at `main.ts:36`       |
| worker  | `worker.ts:146`, before `createPool` at `worker.ts:148` |

**New file: `apps/api/test/assumptions-boot.test.ts`** (project `api`, no database). `@core/testkit`
has no equivalent of `withTempSecretsDir` for this: `loadAssumptions()` memoises its result in a
module-level `current` variable (`current ??= parseAssumptions(ASSUMPTIONS_FILE)`,
`packages/contexts/planning/src/assumptions.ts`) and `ASSUMPTIONS_FILE` is a compiled TypeScript
data module (`packages/contexts/planning/data/assumptions.ts`), not a path read off disk at runtime
— there is no file for a test to corrupt and restore. `main.ts` and `worker.ts` are also not
designed to be imported for a unit test (`main()` is unexported and runs immediately as a top-level
`try { await main(); } catch { ... }` on import). `apps/api/test/regate-worker-boot.test.ts` (the
N-4/N-5 re-gate) already established the pattern this follows for exactly that reason — "these
assertions are deliberately made against the source... as committed, not against a rebuilt
runtime... a test that boots a worker would need a database, a KEK and 1 GiB of RAM to say the same
thing" — so this file makes the same kind of claim, against the source, four ways:

1. both files import `loadAssumptions` from `@ctx/planning` and call it as its own statement;
2. the call is not preceded, inside `main()`, by a `try {` or an `if`/`catch` that could swallow its
   throw — the shape this file's own `recordConfigSnapshot` call uses two lines later, deliberately,
   for a different and genuinely non-fatal failure;
3. the call runs before `createPool(...)`, the first stateful step in both files;
4. the top-level `catch` around `main()` never exits 0 on any branch, so a throw that does reach it
   is observable from the outside (a process exit code), not merely logged.

### Sabotage — `loadAssumptions()` call removed

`main.ts:34` and, separately, `worker.ts:146` — `loadAssumptions();` → a comment.

```
AssertionError: apps/api/src/main.ts must call loadAssumptions() as its own statement: expected null not to be null
AssertionError: apps/api/src/worker.ts must call loadAssumptions() as its own statement: expected null not to be null
```

Each restored individually; `git diff --stat` empty after each. Re-run: green (4/4).

## 3. WP 4.7 — the gap-field composition, including its never-exercised half

| Field           | Source                                                                                                                  | `domain.ts`   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| `targets`       | `@ctx/investments`' `allocation_targets` via `drizzleAllocationTargetsStore`                                            | line 987 body |
| `employerStock` | `@ctx/investments`' `security_tags` via `drizzleSecurityTagsStore`                                                      | same          |
| `idleCash`      | `@ctx/investments`' `cashSnapshotHistory`/`cashPositionFor` **+** `@ctx/planning`'s `liveEarmarksByAccount` (line 1102) | same          |

`apps/api/test/db/phase3-advisors.test.ts`'s `'I1, I3 and I5 now fire...'` test already called the
real `createInsightsInvestmentsPort` with `wrapWithGapFieldSources` retired (the previous agent's
work). Running it for the first time found a real defect and a real gap.

### 3.1 A live defect: `cash` ladder vs. `insertPrice`'s hardcoded `'tiingo'`

The test's `insertPrice` helper always wrote `source: 'tiingo'`. `DEFAULT_LADDERS.cash` is
`['user_override', 'last_known']` (`packages/contexts/investments/src/prices.ts:154`) — a `'tiingo'`
row is never on a cash security's ladder at all, so `PriceReader.price()` returned `null` for the
fixture's cash holding, `valueHoldings` dropped it (`price_unknown`), `cashByAccount(set)` was empty,
and `idle_cash` could not fire for a reason that had nothing to do with WP 4.7's own composition.
Confirmed with a temporary debug print (`console.error` in `domain.ts`, removed — `git diff` was
empty before and after; see §5) showing `set.valued` held only the VTI position.

**Fixed in `apps/api/test/db/phase3-advisors.test.ts`**: `insertPrice` gained an optional `source`
parameter (default unchanged, `'tiingo'`), and the cash security's own price is now inserted with
`source: 'user_override'` — the rung the cash ladder actually has. Not `domain.ts`'s bug; the test
fixture's.

### 3.2 A real gap: the earmark half of the composition was never exercised

Every existing fixture's `liveEarmarksByAccount` map was empty, so `earmarkedAmount:
earmarksByAccount.get(accountId) ?? Money.zero(BASE_CURRENCY)` and `earmarkedAmount:
Money.zero(BASE_CURRENCY)` (dropping the read outright) produce identical output against every test
that existed before this pass — a control with no test that could ever fail it, exactly the shape
`personalfi-gate-lessons.md` warns about.

**New test**, appended to `apps/api/test/db/phase3-advisors.test.ts`'s existing `describe` block:
`"an earmark on the same idle cash suppresses I3 — the composition's other real source, exercised
for the first time"`. It reuses the previous test's account, cash and twenty days of dwell history
(nothing is truncated between `it`s in this file), creates a real goal (`createGoal`, `@ctx/planning`)
and a real earmark (`createEarmark`) covering the full $12,000 against the same brokerage account,
and re-runs `builtin.investing.idle_cash` alone: `proposed` must be `0` — the same cash, the same
age, now earmarked.

### Sabotage — earmark dropped from the composition

`domain.ts:1102` — `earmarkedAmount: earmarksByAccount.get(accountId) ?? Money.zero(BASE_CURRENCY)`
→ `earmarkedAmount: Money.zero(BASE_CURRENCY)`.

- **Before the new test existed** (i.e. against every test this batch inherited): full `api-db` run
  over `phase3-advisors`/`phase3-wiring`/`revealed-ports` — **16/16 green**. The sabotage was
  invisible. This is the finding written up in §3.2, kept here rather than only in prose, because a
  gate should be able to reproduce it.
- **After the new test**: same sabotage —

  ```
  AssertionError: the same cash, aged the same twenty days, over the same threshold — earmarked
  now, and I3 must fall silent because of it: expected 1 to be +0
  ```

Restored; `git diff --stat apps/api/src/domain.ts` empty afterwards. Re-run: green (5/5 in
`phase3-advisors.test.ts`).

## 4. WP 4.12a §4 — the RUNBOOK sentence

Already landed at `RUNBOOK.md:211`–219, verbatim against §4's own wording ("a funded wallet's
balance still cannot sync, only its holdings"). Verified present; no change needed.

## 5. The temporary debug prints (§3.1)

Two `console.error` lines were added to `apps/api/src/domain.ts` (inside `createInsightsInvestmentsPort`'s
`holdings()`, immediately after `const idle = ...` and after `const set = ...`) to find the §3.1
defect, run once each, then removed. `git diff apps/api/src/domain.ts` was empty (`git diff --stat`,
zero output) both times the file was checked afterwards, and again at the end of this pass — see §6's
final `git status`.

## 6. Open items

1. **WP 4.3 §9 item 3** (investment-side cash arrivals) and **item 6** (budget choice is "the
   oldest") are unchanged by this batch — they are WP 4.3's own open items, not this batch's to
   close.
2. **The credit-card off-budget fix (§1)** is local to `revealed-ports.test.ts`'s own fixture. It is
   not a claim that every budget in production must exclude every credit card — only that a fixture
   with no card-payment tracking of its own must not pretend to have any.
3. **`docs/plan/01-execution-log.md`** was not touched by this batch (visible as modified in `git
status` at the time of writing — another agent's concurrent edit, per the working tree's own
   collision rules).
4. **`packages/contexts/planning/**`** is WP 4.5/4.6's, untouched here, and had 0 outstanding `tsc`
   errors at the final run below (the 5 the orchestrator's brief warned about were gone by the time
   this pass ran `tsc` — resolved by those agents in the meantime, not by this batch).

## 7. Checks (final run)

| Command                                                                                                               | Result                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm exec tsc -p tsconfig.json --noEmit`                                                                             | clean, exit 0 (whole tree)                                             |
| `pnpm exec eslint apps/api`                                                                                           | clean, exit 0                                                          |
| `pnpm exec prettier --write` (every file this batch touched)                                                          | all "unchanged" except the two files edited, which reformatted cleanly |
| `node scripts/check-numeric-boundaries.ts`                                                                            | PASS — 758 files, 0 violations                                         |
| `DATABASE_URL=… pnpm exec vitest run --project api`                                                                   | **12 files, 79 passed**                                                |
| `DATABASE_URL=… pnpm exec vitest run --project api-db test/db/{revealed-ports,phase3-advisors,phase3-wiring}.test.ts` | **3 files, 17 passed**                                                 |

`git diff --cached --name-only`: empty. Files this batch changed: `apps/api/test/db/phase3-advisors.test.ts`
(modified), `apps/api/test/db/revealed-ports.test.ts` (new), `apps/api/test/assumptions-boot.test.ts`
(new), this document (new). `apps/api/src/{domain,main,worker}.ts` and `RUNBOOK.md`: byte-identical
to `HEAD` — verified with `git diff --stat`, zero output, immediately before this line was written.

## 8. Final re-run (after this document was first written)

Repeated the full battery once more, against the state as it stands at the end of §7, with no
further code changes in between:

| Command                                                                                                               | Result                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec prettier --check` (every file this batch touched, including this document)                                 | "All matched files use Prettier code style!"                                                                                                                                               |
| `pnpm exec tsc -p tsconfig.json --noEmit`                                                                             | clean, exit 0                                                                                                                                                                              |
| `DATABASE_URL=… pnpm exec vitest run --project api`                                                                   | **12 files, 79 passed**                                                                                                                                                                    |
| `DATABASE_URL=… pnpm exec vitest run --project api-db test/db/{revealed-ports,phase3-advisors,phase3-wiring}.test.ts` | **3 files, 17 passed**                                                                                                                                                                     |
| `git diff --stat apps/api/src/{domain,main,worker}.ts RUNBOOK.md`                                                     | empty                                                                                                                                                                                      |
| `git diff --cached --name-only`                                                                                       | empty                                                                                                                                                                                      |
| `git status --short` (this batch's paths only)                                                                        | `M apps/api/test/db/phase3-advisors.test.ts`; `??` for `apps/api/test/assumptions-boot.test.ts`, `apps/api/test/db/revealed-ports.test.ts`, `docs/evidence/phase-4/wp4.w-wave-b-wiring.md` |

Unchanged from §7: identical pass counts, identical clean exits, no new diagnostics. Nothing left
in a red or half-restored state.
