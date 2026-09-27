<!-- SPDX-License-Identifier: MIT -->

# WP 4.13 — The scale seed and the perf harness

_Closes wp3.14-quality.md §8 item 6: "the perf dataset is a correctness seed, not a scale seed."
Dispatch: `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.13". Owns `packages/seed/src/phase4-scale.ts`
(new) + a one-line export in `packages/seed/src/index.ts`, `packages/seed/test/phase4-scale.test.ts`
(new), `packages/contexts/planning/src/engine/perf.test.ts` (extended), `apps/api/test/db/projection-perf.test.ts`
(new), `docs/TESTING.md` additions. Written in a shared tree with the Wave C wiring batch and WP
4.12b in flight (`git status` at the time of writing shows `apps/api/src/{domain,modules,worker}.ts`
and others modified by concurrent agents; none of those files are touched here)._

---

## 1. What shipped

| File                                                 | What                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/seed/src/phase4-scale.ts` (new)            | `generatePhase4Scale(seed, options?)` — 200 positions across eleven accounts spanning four tax buckets, five years of daily prices/holdings-snapshots/net-worth, a CAD account with an FX series carrying one declared gap, and a plan (two goals, their contribution plans, two life events). Generic shapes only — no `@ctx/planning` import (see its own header). |
| `packages/seed/src/index.ts`                         | One additive export block for `phase4-scale.ts`                                                                                                                                                                                                                                                                                                                      |
| `packages/seed/test/phase4-scale.test.ts` (new)      | The named exit test, plus the correctness-seed non-interference test                                                                                                                                                                                                                                                                                                 |
| `packages/contexts/planning/src/engine/perf.test.ts` | WP 4.5's engine-alone budget now reads the scale seed's last day instead of a hand-built equivalent                                                                                                                                                                                                                                                                  |
| `apps/api/test/db/projection-perf.test.ts` (new)     | The two named exit tests, over real Postgres                                                                                                                                                                                                                                                                                                                         |
| `docs/TESTING.md`                                    | A new section, "The Phase 4 scale seed…"                                                                                                                                                                                                                                                                                                                             |

No `vitest.config.ts` edit was needed: the `seed` project's `include` already covers
`test/**/*.test.ts` (WP 3.14 added it), and `planning-perf`'s `include` is `src/engine/perf.test.ts`
by path, which this WP edits rather than replaces.

---

## 2. The dataset's shape, with row counts

`generatePhase4Scale(1)` (the seed `apps/api/test/db/projection-perf.test.ts` loads), asserted by
`packages/seed/test/phase4-scale.test.ts` before anything else runs:

| Table / series            | Rows                      | How                                                                                                                                                                              |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `days`                    | **1,825**                 | 5 × 365, ending on `asOf` (2026-09-25)                                                                                                                                           |
| `accounts`                | 11                        | 10 USD across `TAXABLE`/`TAX_DEFERRED`/`ROTH`/`HSA`, 1 CAD `TAXABLE`                                                                                                             |
| `securities` / `holdings` | **200** / **200**         | one distinct security per position, `new Set(holdings.map(h => h.securityId)).size === 200`                                                                                      |
| `prices`                  | 200 × 1,825 = **365,000** | every security, every day                                                                                                                                                        |
| `holdingsSnapshots`       | 200 × 1,825 = **365,000** | every holding, every day — quantity held **constant** across the window (declared in the file's header: this dataset is about row _scale_, not about trading activity within it) |
| `fx`                      | 1,825 − 1 = **1,824**     | CAD/USD, one declared gap at the window's midpoint                                                                                                                               |
| `netWorthDaily`           | **1,825**                 | one point per day, one breakdown line per account                                                                                                                                |
| `goals`                   | 2                         | `retirement` ($3,000,000 target, +25y), `purchase` ($120,000, +5y)                                                                                                               |
| `contributions`           | 2                         | one per goal, monthly                                                                                                                                                            |
| `lifeEvents`              | 2                         | one `inheritance` (+3y, engine-expressible), one `home_purchase` (+5y, −$120,000, the engine's own documented `unapplied` case)                                                  |

**What actually lands in Postgres, and why not everything does.** `apps/api/test/db/projection-perf.test.ts`
loads `netWorthDaily` (all 1,825 rows, by direct SQL) and the plan (goals/contributions/life events,
through the real `@ctx/planning` service calls) — that is everything either of the two timed queries
touches. `prices` and `holdingsSnapshots` are asserted at their declared row counts in
`phase4-scale.test.ts` (in memory) but are **not** written to Postgres by this WP: no route this WP
measures reads them, and writing 365,000 rows twice over (prices and snapshots) to prove a budget
that does not depend on them would be spending minutes to test nothing. `investments-perf.test.ts`
(WP 3.14) already exercises `GET /holdings` and `GET /investments/allocation` — the routes that _do_
read `holdings`/`prices` — against the correctness seed; re-seeding those tables at 200-position scale
for this WP's two budgets would be scope creep past what either exit test needs.

---

## 3. Determinism: the byte-identical proof, and the sabotage that moved it

`'the scale seed generates 200 positions and five years of daily snapshots, byte-identically for a
fixed seed'` (`packages/seed/test/phase4-scale.test.ts`):

```
$ pnpm exec vitest run --project seed test/phase4-scale.test.ts
 ✓ |seed| test/phase4-scale.test.ts (2 tests) 6.2s
```

`JSON.stringify(generatePhase4Scale(1))` compared byte-for-byte against a second, independent call
with the same seed (equal) and against `generatePhase4Scale(2)` (not equal) — the same shape of proof
`phase3-investments.ts`'s own determinism claim uses.

**Sabotage 1 — a byte flip that breaks determinism goes red.** `walkDaily`'s opening value was changed
from `openMinor` to `openMinor + BigInt(Math.floor(Math.random() * 7))` (one line). Re-run:

```
FAIL  |seed| test/phase4-scale.test.ts > generatePhase4Scale > the scale seed generates 200 positions
and five years of daily snapshots, byte-identically for a fixed seed
AssertionError: expected '{"seed":1,"baseCurrency":"USD","asOf"…' to be '{"seed":1,"baseCurrency":"USD","asOf"…'
```

Red on the first attempt. Restored; `sha256sum packages/seed/src/phase4-scale.ts` before and after
the sabotage: `30ec58a571e1b8123a376b5c230fc182747e0f28bae76809c1c547a9b2e1da3d` both times.

**Sabotage 2 — a perf number over an empty table goes red.** In
`apps/api/test/db/projection-perf.test.ts`, the `await loadNetWorthDaily(...)` call was commented out
in `beforeAll`. Re-run of the row-count test alone:

```
FAIL  |api-db| test/db/projection-perf.test.ts > […] > the scale seed is actually in the database
(a perf number over an empty table is a lie)
AssertionError: expected +0 to be 1825 // Object.is equality
```

Red on the first attempt. Restored; `sha256sum apps/api/test/db/projection-perf.test.ts` before and
after: `21d19cfbb757dc454c7e5813d027fff7e9a7828b4834b717144337f67df36dce` both times.

**The correctness seed's digest, unchanged.** `generatePhase3Investments(1)` — the ground-truth
dataset WP 3.14's basis engine is graded against — is touched by nothing in this WP: this generator
imports nothing from `phase3-investments.ts`, shares no PRNG stream with it (each generator seeds its
own `mulberry32` instance from `seed ^ <its own constant>`), and `packages/seed/src/index.ts`'s only
change is an additive export block. Digest, computed via a throwaway `node -e` script (not a committed
file — `node:crypto` is banned everywhere under `packages/**` except two audited call sites, neither of
which this is) over `JSON.stringify(generatePhase3Investments(1))`:

```
digest before (working tree at the start of this WP): 2331ae7dac3623c7775babb2e1aec311add8356e1b4085b077539f8fd4238ccf  (39,152 bytes)
digest after  (working tree with every file this WP touched):  2331ae7dac3623c7775babb2e1aec311add8356e1b4085b077539f8fd4238ccf  (39,152 bytes)
matches: true
```

`phase4-scale.test.ts`'s own `'leaves the Phase 3 correctness seed untouched'` calls
`generatePhase3Investments(1)` before and after a `generatePhase4Scale(1)` call in the same process,
for the same reason, and is green.

---

## 4. Why daily bps are not monthly bps — a finding, not a footnote

The first working version of the daily price walk reused `phase3-investments.ts`'s `walkTo` bps
magnitudes (driftBps up to 60, volatilityBps up to 400) directly, only changing the step count from
24 months to 1,825 days. The result, observed directly before the fix (from `perf.test.ts`'s own
console output at the time): **`TAXABLE $2,480,548,617.09`** — two and a half billion dollars in one
tax bucket. The arithmetic: a mean daily drift of ~25 bps compounds over 1,825 steps to
`(1.0025)^1825 ≈ 95×`; layered on top of 150–400 bps/day of multiplicative volatility (itself compounding
for 1,825 draws), realised paths land far from that naïve estimate, and enough of 200 independent
walks landed absurdly high to blow the aggregate into the billions. Bps sized for a _monthly_ step
compound roughly 76× too many times when applied _daily_ over the same five-year window — this is
exactly the mistake CONVENTIONS' numeric-boundary rule cannot catch (both values are legitimate decimal
strings; the error is in the model, not the type), so it is recorded here instead.

Fixed to daily-appropriate magnitudes (`phase4-scale.ts` §"securities + holdings" and §"FX"): equities
60–150 bps/day volatility (~1–1.5%, a realistic single-name daily figure), 0–4 bps/day drift (~0–11%/yr
compounded); FX 40 bps/day volatility, 0–1 bp/day drift. Re-run, the same 200 positions now total a
plausible household net worth:

```
TAXABLE $761,471.19, TAX_DEFERRED $681,161.94, ROTH $419,498.90, HSA $98,401.88, crypto $89,711.92
(net worth ≈ $2,050,245.83 across the four buckets + the crypto sleeve)
```

---

## 5. `packages/contexts/planning/src/engine/perf.test.ts` — the engine-alone budget, now on the real seed

The file's own header previously said _"That seed does not exist yet … When WP 4.13's seed lands, this
file should read it instead of building one."_ It now does: `scaleBalances()` calls
`generatePhase4Scale(20_260_926)`, asserts 200 positions / 200 distinct securities before anything is
timed, sums the last day's per-account breakdown into `byBucket` (excluding the `crypto-wallet`
account, which becomes `cryptoHolding`) the way WP 4.6 sums `net_worth_daily`'s own breakdown. Every
other part of the file — the plan's glidepaths, guardrails, Social Security, pension, part-time income,
the synthetic 1,847-month return series, the warm-up/sample loop, the sample printing — is unchanged
from WP 4.5's own version.

```
$ pnpm exec vitest run --project planning-perf --reporter=verbose
[perf] AMD Ryzen 5 3501U with Radeon Vega Mobile Gfx × 8 logical, Node v26.9.0, load 2.19 2.29 2.52;
WP 4.13 scale seed, 200 positions → buckets TAXABLE 761471.19, TAX_DEFERRED 681161.94,
ROTH 419498.90, HSA 98401.88, crypto 89711.92; 10000 paths × 40 years, bootstrap over 1847 months

[perf] warm-ups (excluded), thread cpu/wall: 553.9/562.7, 573.7/583.4, 608.7/618.3 ms
[perf] thread cpu samples: 670.8, 641.9, 626.8, 566.4, 596.1, 604.8, 607.0, 566.2, 581.2, 571.8,
616.4, 609.1, 567.9, 544.6, 535.7, 557.3, 512.1, 535.5, 533.0, 599.7, 552.0, 529.2, 645.8, 501.4,
591.5 ms
[perf] wall samples (spawn to reply): 707.8, 651.0, 634.1, 574.4, 609.1, 613.6, 615.8, 573.0, 587.8,
585.7, 660.4, 622.3, 575.8, 550.1, 541.2, 563.5, 518.2, 541.3, 538.1, 621.6, 558.7, 535.0, 655.5,
506.5, 597.8 ms
[perf] n=25 thread cpu: p50 571.8 ms, p95 645.0 ms, p99 664.8 ms (min 501.4, max 670.8); budget 800 ms
[perf] n=25 wall: p50 585.7 ms, p95 659.4 ms, p99 696.4 ms (min 506.5, max 707.8); success 9568/10000;
load average after 2.99 2.47 2.58

 ✓ |planning-perf| src/engine/perf.test.ts › the 08 §7.2 budget › 10,000 paths over 40 years
   complete within 800 ms p95 on one core  17314ms
```

**Hardware.** AMD Ryzen 5 3501U (4 cores / 8 threads), Node v26.9.0, dev laptop. **p95: 659.4 ms wall /
645.0 ms thread CPU, against an 800 ms budget** — margin 1.21× (wall), 1.24× (thread CPU). Success
9,568/10,000 (95.68%) — the plan's own guardrail-adjusted answer, unrelated to timing.

---

## 6. `apps/api/test/db/projection-perf.test.ts` — the whole-path budgets, over real Postgres

### 6.1 Row counts, asserted before either timer starts

```
✓ the scale seed is actually in the database (a perf number over an empty table is a lie)
```

`net_worth_daily` = 1,825 rows (`scale.days.length`), `goals` = 2, `plan_life_events` = 2 — every count
read back from Postgres with `count(*)`, compared to the in-memory dataset's own lengths.

### 6.2 `POST /plan/scenarios/{id}/projections` — not over HTTP; see §7

Driven through `@ctx/planning`'s real `runProjection`, over this harness's real Postgres: a real
`plan_scenarios` fork read, a real `net_worth_daily` balance read (through a `ProjectionInputsReader`
this file writes, reading the newest sealed day the same way `@ctx/planning`'s own un-exported
`balancesDay` does — same table, same columns, same ordering), a real Monte Carlo run through WP 4.5's
`runMonteCarloInWorker` (a fresh `worker_thread`, 10,000 paths, the real bootstrap engine over a
1,847-month synthetic return series), a real `projection_runs` + `projection_percentiles` insert, and a
real `planning.ProjectionCompleted` event append. 12 samples, 3 warm-ups excluded, each a **fresh**
scenario fork (`annual_spending` one dollar larger each time) so `runProjection`'s own cache — proven in
`wp4.6-projection-service.md` §2 — never turns a sample into a no-op; every sample asserted
`status === 'computed'`, never `'cached'`.

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api-db test/db/projection-perf.test.ts
perf POST /plan/scenarios/{id}/projections (in-process): p50=568.2ms p95=641.5ms
  samples=[510,524,530,547,563,563,568,571,578,604,641,641]
perf GET /net-worth/series (1825 days): p50=54.7ms p95=70.5ms
  samples=[46,47,49,51,53,53,55,55,55,56,58,59,61,64,70]

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**p50 568.2 ms, p95 641.5 ms**, against the same **800 ms** budget the engine-alone test measures —
margin 1.25×. The gap between this number and §5's engine-alone p95 (659.4 ms wall) is the DB round
trips (scenario read, balance read, run insert, event append) plus a fresh fork's `createScenario` call
per sample (untimed, but its own small cost is why the two numbers are close rather than this one being
strictly larger by a fixed DB overhead): in practice the two overlap because both are dominated by the
same worker spawn + 10,000-path kernel cost, and the service-layer DB work is single-digit milliseconds
against a ~600 ms kernel.

### 6.3 `GET /net-worth/series` over 1,825 points

Real `fetch()` against `ApiHarness.listen()` — the `investments-perf.test.ts` pattern. 2 warm-ups, 15
samples.

**p50 54.7 ms, p95 70.5 ms**, against 08 §7.1's **150 ms** budget for exactly this figure (1,825
points) — margin 2.13×. This is the first time that specific budget has been measured at its own stated
scale: WP 3.14's own perf evidence (§6 below) measured 180 days against a looser 200 ms budget and said
so explicitly.

---

## 7. The Phase 3 numbers, restated against the scale dataset

| Route                                          | Phase 3 seed (wp3.14-quality.md §6)                                                                                                                                                   | Scale seed (this WP)                                                                                  | Budget | Difference                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /net-worth/series`                        | 180 days, p95 **13.3 ms** (against a looser 200 ms — 08 §7.1's own 1,825-point/150 ms figure was not yet measurable)                                                                  | **1,825 days, p95 70.5 ms**, against 08 §7.1's own 150 ms                                             | 150 ms | **5.3× the latency, for 10.1× the days** — sub-linear, consistent with one indexed range scan plus the calendar-spine join rather than per-row work; the correctness seed's number was never comparable to this budget in the first place, and now there is a number that is                                                                             |
| Monte Carlo (engine alone)                     | n/a — WP 4.5's own perf test built an equivalent 200-position plan by hand before this WP landed (671/664 ms wall/thread CPU alone, per `wp4.5-montecarlo.md` §7, on the same laptop) | **200 real positions from a generated, row-counted dataset**, p95 659.4 ms wall / 645.0 ms thread CPU | 800 ms | Within a few percent of the hand-built plan's own numbers — expected, because WP 4.6 sums positions into four bucket totals before the engine ever sees them (§5's own point: "what 200 positions change here is the buckets' sizes and the crypto sleeve"), and the bucket totals here are close in magnitude to the hand-picked ones the old plan used |
| Monte Carlo (whole path)                       | not measured at all (no route, no service test at this scale)                                                                                                                         | **p95 641.5 ms** over real Postgres                                                                   | 800 ms | New measurement; not a regression against anything, because nothing measured this before                                                                                                                                                                                                                                                                 |
| `GET /holdings`, `GET /investments/allocation` | 32.7 ms p95, 6 accounts / 7 securities                                                                                                                                                | not remeasured — out of this WP's scope (§2)                                                          | 200 ms | Left for whichever WP next needs `holdings`/`prices` written at scale; `phase4-scale.ts`'s `prices`/`holdingsSnapshots` are already shaped for it                                                                                                                                                                                                        |

**The honest caveat wp3.14-quality.md §6 named is now closed for two of its three routes, and named as
still open for the third.** Quoting 32.7 ms p95 as headroom against a six-account seed was the error
this WP exists to fix; the net-worth series and the Monte Carlo budget both now have a number measured
at the scale the budget is actually about. `GET /holdings`/`GET /investments/allocation` still have
only their six-account number, because measuring them at 200-position scale needs `holdings`/`prices`
written to Postgres, which is outside this WP's two named exit tests (§2's "what actually lands"
paragraph) — recorded as an open item, §9 below.

---

## 8. Verification

**One test bug, found by running it rather than by inspection.** The first full run of
`projection-perf.test.ts` failed its own assertion, not the budget: `outcome.run.successProbability`
came back `'1.000000'` (`fromEngineRatio`'s six-decimal-place form), and this file's own regex
(`/^(0|1|0\.\d+)$/`) does not accept `'1.000000'` — only `'1'` or `'0.…'`. Fixed to the same pattern
`projection-service.ts`'s own `checkedOutcome` uses (`SIX_PLACES`,
`/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/`) rather than a narrower one invented for this file; the dead
`successCount` marker variable that existed only to make the old assertion read sensibly was removed
in the same pass. Re-run, green — §6.2's numbers above are from this corrected file.

```
$ pnpm exec tsc -b --noEmit
(clean)

$ pnpm exec eslint packages/seed packages/contexts/planning/src/engine apps/api/test/db/projection-perf.test.ts
(clean)

$ pnpm exec prettier --write packages/seed/src/phase4-scale.ts packages/seed/src/index.ts \
    packages/seed/test/phase4-scale.test.ts packages/contexts/planning/src/engine/perf.test.ts \
    apps/api/test/db/projection-perf.test.ts docs/TESTING.md
(all matched Prettier's style)

$ node scripts/check-numeric-boundaries.ts | tail -2
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 760 file(s) scanned, 0 violations, 72 exempt identifier(s)

$ pnpm exec vitest run --project seed --project planning-perf
 Test Files  6 passed (6)
      Tests  41 passed (41)

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api-db test/db/projection-perf.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)

$ git diff --cached --name-only
(empty)
```

This WP's tree touches exactly: `packages/seed/src/{phase4-scale.ts (new),index.ts}`,
`packages/seed/test/phase4-scale.test.ts` (new), `packages/contexts/planning/src/engine/perf.test.ts`,
`apps/api/test/db/projection-perf.test.ts` (new), `docs/TESTING.md`,
`docs/evidence/phase-4/wp4.13-scale-seed.md` (new). No migration, no `git add`, no lockfile or
`package.json` edit, no `docker compose`, no `just` recipe run.

---

## 9. For the orchestrator

1. **No `vitest.config.ts` edit needed.** The `seed` project's `include` already covers
   `test/**/*.test.ts` (WP 3.14's own edit); `planning-perf`'s `include` names
   `src/engine/perf.test.ts` by path, which this WP edits in place rather than replacing.
2. **`docs/TESTING.md`** gained one new section, "The Phase 4 scale seed (`@core/seed`), and the two
   whole-path budgets it feeds" — additive, after the existing "Investments perf budgets" section.
3. **Open item — the HTTP rebinding for WP 4.8.** `apps/api/test/db/projection-perf.test.ts`'s
   `'POST /plan/scenarios/{id}/projections p95 is within budget over real HTTP'` test does **not**
   run over real HTTP today: that route does not exist (`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.8").
   It calls `@ctx/planning`'s `runProjection` directly, over this harness's real Postgres, and builds a
   local `MonteCarloRunner` adapter (`monteCarloRunnerOverWorker`) wrapping WP 4.5's real
   `runMonteCarloInWorker` — the shape `apps/api/src/domain.ts` will eventually bind that port to,
   built here only because this test needed a real one to measure a real budget. **When WP 4.8 lands
   the route, this test's body should be rebound to `h.listen()` + `fetch()` (the `investments-perf.test.ts`
   pattern this file already uses for its net-worth half) without changing the test's name** — the name
   is the dispatch's own exit-test string, and WP 4.8 inherits the obligation to make it literally true.
4. **Item 4 as first written here said the `MonteCarloRunner` binding did not exist in
   `apps/api/src/domain.ts` — it landed in this same shared tree while this WP was in flight** (a
   concurrent Wave C wiring agent's `createMonteCarloRunner`/`createMonteCarloRunnerFromCache`,
   `apps/api/src/domain.ts` around line 2954, independently built to the same shape this file's
   `monteCarloRunnerOverWorker` uses for the same reason — `PERCENTILE_LEVELS` order, the seed passed
   through unconverted, `engineVersion` folding the series checksum). **Still open, and not this WP's
   to close:** at the time of writing, `worker.ts` does not yet call `createMonteCarloRunnerFromCache`
   (`grep -n "createMonteCarloRunnerFromCache" apps/api/src/worker.ts` returns nothing), so
   `ModuleWiringOptions.monteCarlo` still defaults to `null` (`modules.ts:582`,
   `monteCarlo: options.monteCarlo ?? null`) until boot actually passes one in. Whichever WP finishes
   that wiring should re-run this file's projection test once bound in production, not just via this
   test's own local adapter, and confirm the p95 still holds end to end.
5. **Open item — the port carries no crypto holding.** `ports.ts`'s `MonteCarloRequest` (what
   `runProjection` hands the bound runner) has `plan`/`assumptions`/`seed`/`paths` only — no
   `cryptoHolding` field — so a projection driven through this exact seam never simulates the crypto
   sleeve (07 §6.4's own draw), even though the scale seed's `crypto-wallet` account holds a real
   balance. Not a defect this WP introduces or can fix (the port is WP 4.6's, the binding is WP 4.8's or
   the wiring batch's); recorded here because this test is the first thing to actually exercise the seam
   end to end and observe the gap.
6. **Open item — `GET /holdings` / `GET /investments/allocation` still have only their six-account
   number.** §7's table names it: measuring those two routes at 200-position scale would need
   `phase4-scale.ts`'s `holdings`/`prices` (already shaped, 200 × 1,825 rows each, generated and
   row-count-asserted in `phase4-scale.test.ts`) written into Postgres, which no exit test this WP owns
   asks for. A future WP that wants that number can load them the same way
   `investments-perf.test.ts` loads the Phase 3 seed's.

---

## 10. Final re-run (after §8's regex fix)

Written after the report above; appended rather than edited into §8, per the convention this
dispatch's other WPs use.

```
$ pnpm exec tsc -b --noEmit
(clean)

$ pnpm exec eslint packages/seed packages/contexts/planning/src/engine apps/api/test/db/projection-perf.test.ts
(clean)

$ pnpm exec prettier --write packages/seed/src/phase4-scale.ts packages/seed/src/index.ts \
    packages/seed/test/phase4-scale.test.ts packages/contexts/planning/src/engine/perf.test.ts \
    apps/api/test/db/projection-perf.test.ts docs/TESTING.md docs/evidence/phase-4/wp4.13-scale-seed.md
(all unchanged — already Prettier's style)

$ node scripts/check-numeric-boundaries.ts | tail -3
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 760 file(s) scanned, 0 violations, 72 exempt identifier(s)

$ pnpm exec vitest run --project seed --project planning-perf
 Test Files  6 passed (6)
      Tests  41 passed (41)
[perf] n=25 thread cpu: p50 569.3 ms, p95 654.3 ms, p99 676.1 ms (min 541.3, max 680.8); budget 800 ms
[perf] n=25 wall: p50 575.9 ms, p95 665.1 ms, p99 685.1 ms (min 547.3, max 689.0); success 9568/10000

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api-db test/db/projection-perf.test.ts
perf POST /plan/scenarios/{id}/projections (in-process): p50=551.8ms p95=607.7ms
  samples=[487,520,524,524,530,535,552,554,558,560,572,608]
perf GET /net-worth/series (1825 days): p50=39.6ms p95=53.9ms
  samples=[35,36,37,39,39,40,40,40,40,40,41,41,41,41,54]
 Test Files  1 passed (1)
      Tests  3 passed (3)

$ git diff --cached --name-only
(empty)
```

Every number stays inside its budget with room to spare: engine-alone 665.1 ms wall p95 / 800 ms
(1.20×); whole-path projection 607.7 ms p95 / 800 ms (1.32×); net-worth series 53.9 ms p95 / 150 ms
(2.78×). `pnpm exec tsc -b --noEmit` is clean across the whole workspace at this point (an earlier
run in this same shared tree showed two errors in `apps/api/src/modules.ts` — `PROJECTION_REFRESH_CRON`/
`PROJECTION_REFRESH_JOB_KIND` not found — which were a concurrent Wave C wiring agent's file mid-edit,
not this WP's; they were gone by this final run without this WP touching that file).
