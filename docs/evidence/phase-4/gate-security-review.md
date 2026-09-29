<!-- SPDX-License-Identifier: MIT -->

# Phase 4 security gate — independent review

**Reviewer:** Opus `security-engineer`, independent of every Phase 4 work package.
Wrote none of this code; every evidence document under `docs/evidence/phase-4/` was
read as a _claim_, not as a result.
**Tree:** `/home/chris/Projects/PersonalFi`, branch `main`, HEAD `088fe4d`
(`chore: prettier-format WP 4.14's reference-case sidecar`). The working tree at
dispatch carried one uncommitted orchestrator edit (`docs/plan/01-execution-log.md`,
+2 lines) that this gate did not touch.
**CI:** see §1.
**Date:** 2026-09-28.

Written incrementally, section by section, so a session kill loses nothing already
appended. No secret value appears anywhere in this file; every transcript was redacted
at the shell before it was pasted.

**Resume note for a fresh reviewer:** each section below says whether it is COMPLETE
or IN PROGRESS / NOT STARTED. Start at the first section not marked COMPLETE. The
compose stack is this gate's alone; if §3 is IN PROGRESS, assume the stack may be up and
run `docker compose down -v` (and remove any `compose.override.yml`, stop/rm the
dev-sinks containers, remove the `returns_cache` volume) before anything else. The
sabotage harness lives outside the repo at `/tmp/gate4/`; every sabotage restores the
file byte-for-byte and checks `git diff --quiet` on it.

---

## 0. Verdict

_NOT STARTED — written last._

---

## 1. Independent re-verification (Standard A)

_COMPLETE._

The counts below were re-derived by this gate, not read out of any WP evidence doc.
`just verify` was run as its component recipes in separate foreground calls; the vitest
step as explicit `--project` chunks naming all 41 projects, with the three perf files
(`planning-perf`, `projection-perf.test.ts`, `investments-perf.test.ts`) run **alone on an
otherwise idle machine** afterwards (load average printed with each).

**Tree during Standard A.** Dispatch HEAD was `088fe4d`. While this gate ran, the
orchestrator committed and pushed `ab0b5e4` (CI fix: `market-data.spec.ts` asserts the
self-hosted CoinGecko `img`; the two whole-path perf timings `it.skipIf(CI)`), `33e3c9c`
(Phase 5 plan, docs only) and `691435f` (`market-data.spec.ts` takes the `evidenceDir`
option). `git diff --stat 088fe4d 691435f` = `projection-perf.test.ts`,
`market-data.spec.ts`, two `docs/plan/*` files — **no production source changed**. The
local runs below saw the working tree with the `ab0b5e4` test edits present (uncommitted
at the time); the code under review is `088fe4d`'s.

**Hygiene before anything else:** `compose.override.yml` absent; `docker ps` — only
`personalfi-dev-db-1` (`127.0.0.1:5433`) plus unrelated non-PersonalFi containers; no warm
PersonalFi stack. Host: AMD Ryzen 5 3501U, 8 logical, Node v26.9.0.

| Stage                                                                             | Result                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `just typecheck` (`tsc -p tsconfig.json`)                                         | pass (33 s)                                                                                                                                                                                                                                                                                                        |
| `just lint` — prettier + eslint                                                   | pass; 0 errors, the 1 pre-existing warning (`react-hooks/incompatible-library`, TanStack `useVirtualizer`)                                                                                                                                                                                                         |
| `just lint` — schema ownership                                                    | pass — `103 table(s) claimed across 14 package(s), 90 defined`                                                                                                                                                                                                                                                     |
| `just lint` — `check-numeric-boundaries` (alias-aware since WP 4.14)              | self-test PASS (8 bad declarations caught); **PASS — 781 files, 0 violations, 74 exempt identifiers** (wp4.14 said 780; the one extra file is 4.11/4.12c's)                                                                                                                                                       |
| `check-proxy-routes`                                                              | PASS — **30** contract prefixes (Phase 4 adds `/advisors`, `/assumptions`, `/goals`, `/plan`, `/risk-profile`)                                                                                                                                                                                                    |
| `check-ci-projects`                                                               | self-test PASS; **PASS — 41/41** (26 in `test`, 16 in `migration-test`). §5 item 5 said "should read 40/40"; the 41st is `planning-perf`, created by the orchestrator to isolate the budget (execution log 2026-09-26 23:45). Ruling: **accepted** — it is in `ci.yml` and ran on the runner (below)           |
| vitest, 25 non-db projects                                                        | **Test Files 183 passed / Tests 2168 passed \| 6 skipped**, 75 s                                                                                                                                                                                                                                                   |
| vitest, 14 db projects (all `*-db` + `db`, except `api-db`)                       | **Test Files 65 passed / Tests 530 passed**, 540 s                                                                                                                                                                                                                                                                 |
| vitest `api-db`, files 1–25 (alphabetical, perf files excluded)                   | **25 passed / 142 passed \| 1 skipped**, 148 s                                                                                                                                                                                                                                                                     |
| vitest `api-db`, files 26–49                                                      | **23 passed \| 1 skipped / 156 passed \| 3 skipped**, 212 s                                                                                                                                                                                                                                                        |
| `planning-perf`, alone (load 2.21 before, 2.57 after)                             | **1 passed.** 10,000 paths × 40 y, scale seed (200 positions), 25 samples, 3 warm-ups excluded: **wall p50 570.3 / p95 605.6 / p99 616.8 ms**; thread CPU p95 594.4 ms; budget 800; `success 9568/10000`                                                                                                         |
| `api-db` `projection-perf` + `investments-perf`, alone (load 2.37 → 2.67)         | **6 passed.** `POST /plan/scenarios/{id}/projections` over real HTTP **p50 540.7 / p95 634.6 ms** (12 samples 480…635); `GET /net-worth/series` 1,825 points **p95 41.4 ms** (150); `/holdings` p95 26.1, `/investments/allocation` p95 31.3, 180-day series p95 11.9 ms (200)                                |
| web vitest (`pnpm --filter @app/web test`)                                        | **Test Files 58 passed / Tests 332 passed**, 35 s                                                                                                                                                                                                                                                                  |
| `pnpm --filter @app/web build`                                                    | pass — 98 source maps removed, precache 110 entries excludes the kitchen-sink chunk, 1 HTML file with no inline `<script>`/`style=`                                                                                                                                                                              |
| `just playwright-check`                                                           | **50 passed, 1 failed, 2 skipped** (1.9 m). The red: `investments.spec.ts:373 every investments screen is axe clean in both themes` — `Test timeout of 30000ms exceeded` **inside `page.screenshot`**, no assertion failed. Re-run alone: **9/9 passed** (41 s). Classified a load flake, not a defect. 2 skips = `cold-start.spec.ts` (needs a live stack; §3) |
| gitleaks, full history, CI's pinned digest                                        | pass — 264 commits, no leaks                                                                                                                                                                                                                                                                                       |
| `check-history-rewrite-before-push.sh`                                            | PASS                                                                                                                                                                                                                                                                                                               |
| license gate + `THIRD_PARTY.md` drift                                             | PASS, no drift                                                                                                                                                                                                                                                                                                     |
| `just hardening-check`                                                            | compose self-test + real files **PASS** (0 violations, 1 documented exception); **`check-secret-ownership` FAIL on this host** — `secrets/age_recipient` is `10002:10002 0400`, the pre-C-5 single-consumer shape; C-5 needs `10001:10002 0440` so the api (uid 10001) can read it. Operator state, not code: RUNBOOK says re-run `sudo just harden-secrets`; this gate has no non-interactive sudo. **Hand item for Chris** (§6). Consequence for the walk in §3.13 |
| `.trivyignore` expiry + trivy filesystem scan                                     | pass — 0 vulnerabilities in `pnpm-lock.yaml`, 0 misconfigurations in the three Dockerfiles                                                                                                                                                                                                                        |

**Totals.** Backend: **300 files / 3,003 tests passed, 10 skipped** (2168 + 530 + 142 +
156 + 1 + 3 + 3). Web: **58 files / 332 tests**. Playwright: **50 + 1 load flake (green
alone) + 2 skipped**. These equal the orchestrator's claim for `088fe4d` exactly (execution
log 14:15: "3,003 backend + 332 web").

**The 10 skipped backend tests, named** — the same ten, for the same reasons, as the Phase 3
gate: `connector-coinbase` live smoke, `connector-plaid` live Sandbox, `integrations`
live smokes ×4 (no keys in the shell); `api-db` `plaid-sandbox`, `market-data-routes` live
fetch, `notifications-delivery` ntfy + SMTP (dev-sinks down — exercised in §3). With the
return-series cache present on this host, `phase4-wiring.test.ts`'s two real-series tests
**ran and passed** (they skip only where the cache is absent — ruled in §5 input 1).

**Evidence-screenshot hygiene (C-16 O-3) — observed NOT closed.** Before Playwright this
gate hashed all 219 PNGs under `docs/evidence` and tarred them to `/tmp/gate4`. State
found **before** this gate ran anything: four `docs/evidence/phase-3/screenshots/wp3.12-*.png`
already modified in the working tree (the orchestrator's own re-run of `market-data.spec.ts`
while fixing CI — this gate never set `PLAYWRIGHT_EVIDENCE_DIR`). After `just
playwright-check`: **seven committed Phase 4 screenshots rewritten**
(`wp4.10-life-event-keyboard-move`, `wp4.10-required-savings-required`,
`wp4.10-required-savings-unreachable`, `wp4.10-scenario-compare`,
`wp4.11-dragging-reshapes-bands`, `wp4.11-releasing-refines`, `wp4.11-sliders-light`) —
`apps/web/e2e/plan.spec.ts:20` and `plan-sliders.spec.ts:24` still hard-code
`docs/evidence/phase-4/screenshots/`. `investments.spec.ts` alone wrote nothing there (its
fix holds). All eleven files were restored from the tarball to their exact pre-run bytes
(`sha256sum` diff empty). The orchestrator's `691435f` closes `market-data.spec.ts`; **`plan`
and `plan-sliders` remain open** → G4-3. The commit message of `71a1258` ("an e2e run left
docs/evidence untouched for the first time") is true only of the two specs 4.12c converted.

**CI on the real runner.**

- `088fe4d` (run 36462110921): **11/13 — RED.** (1) `migration test`:
  `projection-perf.test.ts › GET /net-worth/series over 1825 points is within 150 ms p95` —
  `expected 242.72 to be ≤ 150` on GitHub's shared 2-vCPU runner (41–54 ms here). (2)
  `web`: `market-data.spec.ts:111` — `expect(providerLink.locator('svg')).toHaveCount(1)`
  got 0: WP 4.12c's C-15 replaced the `lucide` SVG with `<img src="/icons/coingecko-symbol.png">`
  and did not run this spec (4.12c §5 says "the existing CoinGecko-attribution assertions
  re-run green… since they assert on data-testid/text, not the icon" — this one asserted the
  icon). Both are test-side; neither is a production defect.
- `ab0b5e4` (run 36464091257): **13/13 green**, one known flake
  (`recurring-insights.spec.ts:91`, passes on retry, known since Phase 2). The runner's
  `planning-perf` printed `wall p95 501.9 ms … success 9568/10000` — **the same success
  count this host produced**: identical seed ⇒ identical result on a different CPU, an
  independent corroboration of exit criterion (b).
- `691435f` (spec + docs only) — not yet run at the time of writing; the code is `ab0b5e4`'s.

**Ruling on the CI perf skip (`ab0b5e4`, orchestrator's request).** `it.skipIf(CI)` on the
two whole-path timings is **accepted, narrowly**: a 150 ms budget on a shared 2-vCPU runner
measures the runner, and the engine-alone 800 ms budget (`planning-perf`) still runs and
asserts on CI (above), so CI is not budget-blind. But after this change **no CI job asserts
the whole-path Monte Carlo budget at all** — it skipped already because the runner has no
return series (409 → named skip) — so the only place criterion (a)'s whole-path half is
ever measured is a local `just verify` on the target hardware, which this gate did (634.6 ms).
Recorded as condition C-9: the whole-path budget must be re-measured and printed by every
future gate and by the Phase 5 quality pass, with the skip reason visible in CI's log (it is:
`it.skipIf` reports the test as skipped by name).

**Verdict — Standard A: PASS at the reviewed code** (every local stage green or a
load-flake green alone; CI 13/13 on `ab0b5e4`, whose code equals `088fe4d`'s), **with
two recorded exceptions**: CI was red at the dispatched commit itself (two stale test-side
assertions, since fixed by the orchestrator), and `check-secret-ownership` fails on this
host's secret files (operator state). Section COMPLETE.

---

## 2. Sabotage log (Standard B)

_COMPLETE._

**Method.** Every control below was broken by this gate in the _source_ (or the migration
a scratch database is built from), never in the test. The harness
(`/tmp/gate4/sab.py`, outside the repo) reads each file's bytes, applies an edit only if
its old text occurs **exactly once**, runs the targeted suite(s), writes the original
bytes back, asserts byte equality and reports `git diff --quiet` on the file. Every row's
restore printed `git-diff-clean=True`. No `git checkout`/`stash`. **"Red first try"** =
red on the first _valid_ attempt; an edit whose anchor did not match is "not applied" and
is not an attempt. Test names are quoted from the runner's output.

### 2.1 The §5 item 4 "never" list — float, reproducibility, drift, hash, seal, stale, delta, once

| #    | Never / control                                                         | Sabotage (source, not test)                                                                                                                                         | Observed                                                                                                                                                                                                                                                                                                  | Red first try  |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| NB1  | a float never reaches money outside `boundary.ts` (the check)           | `projection-service.ts`: `export const gateLeakedBalance: number = 1.5;`                                                                                          | `check-numeric-boundaries` FAIL (violation + the Money/Quantity explainer)                                                                                                                                                                                                                                | yes            |
| NB2  | (same — WP 4.14's alias resolution, a **local** alias)                  | same file: `type GateDollars = number; export const gateLeakedBalance: GateDollars = 1.5;`                                                                          | FAIL                                                                                                                                                                                                                                                                                                      | yes            |
| NB5  | (same — only `toEngineAmount` is allowed in `boundary.ts`)              | `boundary.ts`: a second `export function toEngineBalance(): EngineDollars`                                                                                          | FAIL                                                                                                                                                                                                                                                                                                      | yes            |
| NB6  | (same — the ALLOW_LIST entry is load-bearing; wp4.14 S2 reproduced)     | `check-numeric-boundaries.ts`: the entry's identifier renamed                                                                                                       | FAIL on `boundary.ts` `toEngineAmount()`                                                                                                                                                                                                                                                                  | yes            |
| NB3  | (same — an **imported** alias, gate input 6)                            | `projection-service.ts`: `import type { EngineDollars } from './engine/boundary.ts'; export const gateLeakedBalance: EngineDollars = 1.5;`                          | **GREEN** — `PASS — 781 files, 0 violations`                                                                                                                                                                                                                                                              | **no — green** |
| NB4  | (same — through the package barrel into `apps/api`)                     | `routes/plan.ts`: `import type { EngineDollars } from '@ctx/planning'; export function projectedBalance(): EngineDollars`                                           | **GREEN** — `EngineDollars` is re-exported by `engine/index.ts` → `@ctx/planning`'s public surface                                                                                                                                                                                                         | **no — green** |
| BD1  | the boundary rounds half-even exactly once                              | `fromEngineAmount`: `roundHalfEven(scaled)` → `Math.round(scaled)`                                                                                                  | `× rounds half to even, exactly once, on exactly representable halves` — `expected 13n to be 12n`                                                                                                                                                                                                        | yes            |
| BD2  | nothing past 2^53 − 1 minor units crosses                               | `toEngineAmount`: the range guard → `if (false)`                                                                                                                    | `× refuses what cannot cross exactly, and never clamps it`                                                                                                                                                                                                                                                | yes            |
| REP1 | identical seed ⇒ identical bytes **across two processes**               | `montecarlo.ts` `drawShocks`: `seedHalves(job.seed)` → `seedHalves(job.seed ^ BigInt(process.pid))` (identical within a process, different across processes)     | `× an identical seed produces byte-identical output across two processes` — `bootstrap: the two processes' bytes differ`; every single-process test stayed green, so **only** the cross-process test sees this class. `montecarlo.ts` restored to `cbfea2c4…`, WP 4.5's recorded final hash                | yes            |
| GD1  | a golden MC value never drifts > 0.5 pp silently (lognormal)            | `montecarlo.ts` `transformFor`: lognormal drift `-0.5σ²` → `-0.55σ²`                                                                                                | `golden-drift.test.ts` `× lognormal … has not drifted more than 0.5 percentage points` — `current 54.30% vs golden 56.43%`; **and** `golden-vector.test.ts` server half `× the server engine reproduces the same committed golden vector` — `expected 491 to be 509`. Deterministic `reference.test.ts` stayed green (correct: no volatility term there) | yes            |
| GD2  | (same, bootstrap)                                                       | bootstrap re-centring `6·s²` → `6.6·s²`                                                                                                                             | `× bootstrap: … not drifted more than 0.5 pp` — `current 55.43% vs golden 57.43%`                                                                                                                                                                                                                         | yes            |
| CK1  | the return series is refused unless it hashes to the pin (load side)    | `series.ts` `loadReturnSeries`: `if (actual !== pinned)` → `if (false)`                                                                                             | `× the return series is refused unless its bytes hash to the committed pin` — `expected function to throw`                                                                                                                                                                                                | yes            |
| CK2  | (same, fetch side — wp4.5 §6 "a bad download → nothing cached")         | `series.ts` `ensureReturnSeries`: the post-derive `actual !== pinned` refusal → `if (false)`                                                                        | **GREEN** — the named test and all of `planning` + `planning-db` (176) + `phase4-wiring` (8). The test's "bad download" is one that fails to _parse_, never one that parses to the wrong bytes. The load-side pin (CK1) still refuses such a cache on first read, so this is defence in depth with no test | **no — green** |
| SC1  | a scenario never stores a copy of the baseline                          | `scenarios.ts` `createScenario`: `leversToJson(diffLevers(…))` → `leversToJson(input.levers)`                                                                       | `× a scenario stores lever deltas and never a copy of the baseline` (first anchor matched twice — not applied; re-anchored)                                                                                                                                                                              | yes            |
| GO1  | GoalOffTrack never fires on a redelivery                                | `projection-service.ts`: `if (!(await store.claim(…)))` → `… && false`                                                                                              | `× … emits GoalOffTrack exactly once per evaluation, not once per consumer delivery` — `expected 3 to be 1`; `× a redelivered ProjectionCompleted claims the goal evaluation once…` (Postgres) — `expected [0, 1, 2] to deeply equal [0, 1, 1]`                                                           | yes            |
| ST0  | a run under retired assumptions is never silently current (override variant) | `readProjection`'s catch for `UnknownAssumptionsVersion` (the run's version is still held, the **holder's override** version is retired): `current = {version: error.requested, overrides: {}}` → the run's own version and overrides | **GREEN** — `planning` + `planning-db` 176/176. The branch (a known run version, a retired override version → `assumptions_changed`) has no test; with the edit such a run reads back `staleness: null` | **no — green** |
| ST1  | (same — the retired **run** version; wp4.6 S4b's shape)                 | `readProjection`: `if (!registry.has(run.assumptionsVersion))` → `if (false)`                                                                                       | `× a run against a retired assumptions version reads back as stale and is never silently recomputed` — `{ reason: 'assumptions_changed' … }` instead of `assumptions_version_retired`                                                                                                                    | yes            |
| ST2  | (same — silent recompute; wp4.6 S4's shape, placed in `resolveForUser`) | `assumptions.ts` `resolveForUser`: an override row naming an unheld version → treated as "no overrides", today's defaults                                           | `× … never silently recomputed` — `expected stale, got computed`; `× a stored override resolves against its named file version, and an unknown version refuses`                                                                                                                                         | yes            |
| SL1  | a projection never reads the open day in place of a sealed one          | `projection-store.ts` `balancesDay`: `AND sealed_at IS NOT NULL` dropped                                                                                            | `× a projection dated to a sealed day reproduces byte-identically after a re-sync changes today` — `2026-09-25 is still the open day…`                                                                                                                                                                    | yes            |
| SL2  | (same — the refusal itself)                                             | `createProjectionInputsReader`: `if (!day.sealed && !input.allowOpenDay)` → `if (false)`                                                                            | same test — `expected undefined to be 'planning.projection_balances_unsealed'`                                                                                                                                                                                                                           | yes            |

**NB3/NB4 (gate input 6).** The check says in its own header that it resolves only
_local_ aliases ("a syntactic pass has no module graph to resolve an imported alias").
Today no file outside `boundary.ts` imports `EngineDollars` (grep), so the hole is latent —
but the alias is exported on `@ctx/planning`'s barrel, so the next consumer that imports it
at a magnitude name is invisible to the check. → **G4-6 (Low)**. The §5 grep of the whole
Phase 4 diff (`git diff 6391428 691435f`, non-test sources, including `apps/web`, which the
check does not scan) found **no** `number` at a magnitude name outside `engine/`, and every
new `toFixed(` is on a ratio or a returns-series statistic (`derive.ts`, `fromEngineRatio`).
**Observation O-1:** the "one named pair" is one named _file_: `boundary.ts` also carries
`solverMoney`, `monthlyFromAnnual`, `annualFromMonthly`, `toEngineTarget` and
`toEngineCeiling`, each a Money↔`number` crossing whose name does not match
`MAGNITUDE_PATTERN`. All live in the one file, which is what the risk row actually needs.

### 2.2 Cross-user isolation (§5 item 8) — every Planning predicate, alone, then together

Each `user_id` predicate in Planning's stores was dropped alone and the route suites run
(`api-db` `plan-routes` + `assumptions-routes`, 41 tests); a predicate that stayed green
at the route was then run against the store suites (`planning` + `planning-db`, 176 tests).

| #    | Predicate dropped (file:line)                                         | Route suites                                                                                    | Store suites                                                | Red first try  |
| ---- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------- |
| XU1  | `getGoal` (`goals-store.ts:295`)                                      | red — `× refuses another user's goal — 404` (`200`), `× refuses another user's goal id` (`409`) | —                                                           | yes            |
| XU2  | `listGoals` (`:307`)                                                  | red — `expected [ {…} ] to deeply equal []`                                                     | —                                                           | yes            |
| XU3  | `updateGoal` (`:350`)                                                 | green (PATCH pre-reads through the scoped `getGoal`)                                            | red — `× every new table carries user_id and refuses another user's row` | yes (store)    |
| XU4  | `deleteGoal` (`:365`)                                                 | red — `200` for Bob                                                                             | —                                                           | yes            |
| XU5  | `listContributions` (`:411`)                                          | green (behind `getGoal`)                                                                        | red — same WP 4.1 test                                      | yes (store)    |
| XU6  | `removeContribution` (`:425`)                                         | green (behind the route's membership check)                                                     | red — same                                                  | yes (store)    |
| XU7  | `currentRiskProfile` (`:465`)                                         | **green** — see note                                                                            | red — `expected '…a470…' to be '…a45a…'`                    | yes (store)    |
| XU8  | `listLifeEvents` (`life-events.ts:176`)                               | red — `× refuses another user's life event`                                                     | —                                                           | yes            |
| XU9  | `updateLifeEvent` pre-read `FOR UPDATE` (`:202`)                      | red — `expected 500 to be 404` (fails closed, wrong status)                                     | —                                                           | yes            |
| XU10 | `deleteLifeEvent` (`:239`)                                            | red — `200` for Bob                                                                             | —                                                           | yes            |
| XU11 | `getScenario` (`scenarios.ts:815`)                                    | red — `expected 500 to be 404` ×2 (fails closed, wrong status)                                  | —                                                           | yes            |
| XU12 | `listScenarios` (`:831`)                                              | red — `× Bob's scenario list never contains Alice's baseline or fork`                           | —                                                           | yes            |
| XU14 | `findRun` (`projection-store.ts:293`)                                 | red — `× refuses another user's scenario and run, 404` (`200`)                                  | —                                                           | yes            |
| XU18 | overrides read (`assumptions.ts:889`)                                 | red — `× refuses another user's overrides: each holder sees only their own`                    | —                                                           | yes            |
| XU13 | **`getBaseline`** (`scenarios.ts:801`)                                | **green**                                                                                       | **green** (176/176)                                         | **no — green** |
| XU15 | `percentilesOf` (`projection-store.ts:341`)                           | green (behind `findRun`)                                                                        | **green**                                                   | **no — green** |
| XU16 | `latestRunForScenario` (`:308`)                                       | green (behind `getScenario`)                                                                    | **green**                                                   | **no — green** |
| XU17 | the cache lookup `findRunByCacheKey` (`:279`)                         | green                                                                                           | **green**                                                   | **no — green** |
| XU19 | **`balancesDay`**, newest sealed day (`:491`)                         | **green**                                                                                       | **green** (+ `phase4-wiring` 8/8)                           | **no — green** |

**Together** (the §5 item 8 half): `getGoal`+`updateGoal` dropped together → red
(`200`/`409` for Bob, the goal tests); `getGoal`+`listContributions`+`removeContribution`
together → red, **but only through the goal tests** — the contribution cross-user tests
stayed green, because none of them attempts the real attack (Bob naming Alice's goal _and_
Alice's contribution): "predicate 1" uses Bob's own contribution id, which the route's
membership check refuses whatever the scoping. `plan-routes.test.ts`'s risk-profile
cross-user test is order-dependent (Bob answers after Alice, so "the newest row of anyone"
is Bob's own and XU7 cannot go red there; the store test catches it).

**What the greens mean.** XU15 and XU16 sit behind a scoped read of a UUID-keyed parent,
and XU17's key is a SHA-256 over inputs that include a per-baseline random seed, so none of
the three is reachable cross-user today. **XU19 and XU13 are not behind anything.**
`balancesDay` is the first — and only — read of `net_worth_daily` on the projection path,
and `getBaseline` is the first read of the baseline on `POST /plan/required-savings` and
the baseline upsert. With either predicate gone, one holder's projection is computed from
another holder's net-worth breakdown or plan, and **every suite in the tree stays green**.
Latent under D6's single holder, but it is exactly what §5 item 8 exists to catch → **G4-4
(Medium)**. (`balancesDay`'s dated branch, `:498`, has the same shape and was not
separately run.)

### 2.3 The consent route (D21's first standing-grant surface) and the scope registration

| #   | Control                                                                         | Sabotage                                                                                          | Observed                                                                                                                                                                                                                                                                                                     | Red first try |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| CG1 | `PUT /advisors/{id}/grants` is step-up gated                                    | `requireFreshSession` → `requireSession`                                                          | `× granting a scope requires a fresh session` — `expected 200 to be 403`                                                                                                                                                                                                                                    | yes           |
| CG2 | an uncatalogued scope is refused by the route before the database — **both layers dropped together** (wp4.8 §11 item 1, never run) | `z.array(z.enum(ADVISOR_SCOPES))` → `z.array(z.string())` **and** the `permittedSet` refusal → `if (false)` | `× a scope absent from the published catalogue is refused by the route before the database refuses it` — `expected 500 to be 400`: the unpublished scope reached Postgres and **0024's CHECK refused it** (fail-closed backstop observed); `× a published scope not permitted for an external advisor…` — `expected 200 to be 422`: the database **cannot** backstop the per-kind rule | yes           |
| CG3 | the consent route refuses another user's advisor                                | `findAdvisor`: `eq(advisors.userId, userId)` dropped                                             | `× refuses another user's advisor and never reads or changes their grants` — `200` for Bob                                                                                                                                                                                                                 | yes           |
| CG5 | a scope never reaches the enum before its migration and published contract (§5 risk row, verbatim) | `scopes.ts`: `'gate.sixteenth'` appended to `ADVISOR_SCOPES`, no migration                        | `phase3-registration` `× every advisor scope has a reader` and `× every advisor scope can actually be granted` — `expected [ 'gate.sixteenth' ] to deeply equal []`; `insights` `× every published document is exactly what the zod definitions emit`, `× the published schemas match the source at 1.3.0`, `× the published scope enum is the catalogue` | yes           |

### 2.4 The Monte Carlo worker's envelope, the wire, the client worker, the budget

| #   | Control                                                                   | Sabotage                                                                                          | Observed                                                                                                                                                                                 | Red first try |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| WL1 | the worker declares `resourceLimits`                                      | `workerOptions`: the `resourceLimits` line removed                                                | `× the worker inherits no environment and no execArgv` — `expected { maxYoungGenerationSizeMb: 96, … } to match object { maxOldGenerationSizeMb: 64, … }`                             | yes           |
| WL2 | the worker never inherits an environment (§5 item 4)                      | `env: {}` removed                                                                                 | same test — `expected [ 'PROD', 'DEV', 'MODE', …(97) ] to deeply equal []`                                                                                                             | yes           |
| WL3 | the deadline **terminates**, never merely answers                         | `void worker.terminate();` removed, the typed timeout kept                                        | `× a worker that exceeds its deadline is terminated…` — `the spinning thread: still pending after 2000 ms — a hang`                                                                    | yes           |
| WL4 | the envelope refuses before a worker exists                               | `runJobInWorker`: `assertWithinEnvelope(job)` removed                                             | `× a request for 10,000,000 paths is refused before a worker is spawned` — `MonteCarloWorkerFailed` where `MonteCarloRefused` was required                                             | yes           |
| WL5 | concurrent workers are capped (wp4.5 §4.5's open item, closed by wiring)  | `domain.ts` `createSemaphore`: `if (active < limit)` → `if (true)`                                | `× the adapter's own semaphore admits at most maxConcurrent runs and queues the rest` — `expected 5 to be 2`                                                                           | yes           |
| SP1 | a success probability never crosses the wire as a JSON number             | `routes/plan.ts` `runSchema`: `z.string()` → `z.number()`, `serialiseRun` emits `Number(…)`       | `× runs a real Monte Carlo projection…` — `expected '{"status":"computed",…' to match /"successProbability":"[^"]*"/` (+ 2 dependent reds)                                             | yes           |
| MR1 | `MonteCarloRefused` → 422 (never a 500)                                   | `domain-errors.ts`: `status: 422` → `500`                                                         | `× the Monte Carlo binding refuses a 20,001-path request … and the route mapping is 422` — `expected 500 to be 422`                                                                    | yes           |
| CW1 | the client worker never sends paths                                       | `projection.worker.ts` `toBands`: a `paths × years` array                                         | `× the worker's own reply carries bands sized levels × years, never a per-path array` — `expected 35000 to be 245`                                                                    | yes           |
| CW2 | the golden-vector pair keeps the two kernels equal (client half)          | `kernel/prng.ts`: `GAMMA_HI` `0x9e3779b9` → `…b8`                                                  | `× the client worker reproduces the committed golden vector for its seed` — `expected 520 to be 509`; the server half stayed green (the pair is directional — see GD1 for the server direction) | yes           |
| PF1 | the 800 ms p95 on the scale seed                                          | `montecarlo.ts` `simulate`: `stepYear(…, false)` → `true` (a record allocated every path-year)    | `planning-perf` `× 10,000 paths over 40 years complete within 800 ms p95 on one core` — `wall p95 2190.0 ms` (the committed code: 605.6 ms, §1)                                         | yes           |

### 2.5 The sixteen Phase 3 conditions' closing controls (gate input 8 included)

WP 4.12a's C-2 and C-14 sabotage records were lost with its session; both were re-run here.

| #       | Condition                                                       | Sabotage                                                                                                                       | Observed                                                                                                                                                                                                                                              | Red first try  |
| ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| P3-C1   | C-1 worker polls for the holder in place                        | `worker.ts`: `return;` before `awaitAccountHolder`                                                                             | `× main()'s no-holder branch polls in place and never returns while idle` (the live half is §3)                                                                                                                                                      | yes            |
| P3-C2   | **C-2** a funded wallet becomes a holding (input 8)             | `walletrpc` `syncHoldings`: throws `DATA_UNAVAILABLE` for a non-zero quantity again                                            | `× a Coinbase ETH sighting and a funded wallet ETH sighting resolve to one securities row, and the wallet holding is a non-zero position…` — `DATA_UNAVAILABLE`; `connector-walletrpc` 2 red                                                         | yes            |
| P3-C5   | C-5 `age` absent never downgrades to plaintext (T13-5b)         | `bundle.ts`: `ENOENT` → `resolve(Buffer.from(plaintext))`                                                                      | `× rejects with AgeUnavailableError naming the binary`, `× never resolves with the plaintext bytes`                                                                                                                                                  | yes            |
| P3-C6a  | C-6 the pool guard fails the boot                               | `if (poolMax > pinned \|\| true) return;` (S-P1)                                                                               | 4 of 6 red in `worker-pool-guard.test.ts` — `expected [Function] to throw`                                                                                                                                                                             | yes            |
| P3-C6b  | (same, the reservation arithmetic)                              | `0 * MODULE_FLAGS.length` (S-P2)                                                                                               | `× WORKER_PINNED_CONNECTIONS is 3 LISTEN + 2 leader leases + one per module flag` — `expected 5 to be 15`                                                                                                                                             | yes            |
| P3-C7   | C-7 the export round-trips the plan                             | `registry.ts`: `'plan_scenarios'` removed from `TABLE_ORDER`                                                                   | `× every user-scoped table appears in the manifest` — `[ 'plan_scenarios' ]`; `× a full export round-trips the plan — goals, assumptions, scenarios and runs — into a clean instance`                                                                | yes            |
| P3-C10  | C-10 a non-USD account never breaks the snapshot                | `builder.ts` `#netWorth`: the balance folded unconverted                                                                       | 3 of 5 red — `cannot combine USD with CAD`                                                                                                                                                                                                            | yes            |
| P3-C14  | **C-14** cross-user security reference is structural (input 8)  | `0025`: `holdings_security_belongs_to_user` FK (and its `COMMENT ON CONSTRAINT`) removed                                       | `× a holding whose security belongs to another user is refused by the database (holdings_security_belongs_to_user)…` — `a foreign_key_violation (23503), not a silent success`. _(First attempt removed the FK but not the comment naming it, so the migration failed to apply — not a valid attempt; re-run.)_ | yes            |
| P3-C3   | C-3 the on-ramp is a transfer                                   | `pfc-map.ts`: `TRANSFER_IN_ACCOUNT_TRANSFER` → `shopping.other_shopping`                                                       | `× pfc-map.ts maps both on-ramp PFC codes to a transfer-kind leaf` (the end-to-end deposit test stays green by design — wp4.12b §7: the mapping never reaches the ledger; the **outflow** leg is still counted as spending, pinned by a characterisation test) | yes            |
| P3-C11  | C-11 half-even                                                  | `net-worth.ts`: the tie → `scaled + 1n`                                                                                        | `× 12.5 shares at $0.01 is exactly $0.125 — half-even rounds to $0.12` — `expected 13n to be 12n`                                                                                                                                                    | yes            |
| P3-C12  | C-12 `checkUrl` passes its parsed scheme                        | literal `'https'` restored                                                                                                     | `× checkUrl's call to checkDestination carries the variable scheme`                                                                                                                                                                                  | yes            |
| P3-C8d  | C-8 the resolution-failure notice de-dupes on identity          | `render.ts`: `syncRunId` appended to the dedupe key                                                                            | `× the resolution-failure dedupe key is the identity of the failure, not the sync run`                                                                                                                                                                | yes            |
| P3-C9w  | C-9 the full view's caption counts missing days                 | `series.ts` `missingCount` → `return 0`                                                                                        | `× counts every day with no net worth value…`; `× the caption names a genuinely missing day…`                                                                                                                                                         | yes            |
| P3-C9b  | C-9 the FX-failure banner renders                               | `NetWorthFullView.tsx`: `false && …`                                                                                           | `× surfaces a failed snapshot's missing FX rate and lets the user enter it manually`                                                                                                                                                                  | yes            |
| P3-C15  | C-15 CoinGecko's own mark                                       | `Attribution.tsx`: the `coingecko` branch never taken (generic glyph)                                                          | web unit tests green (they assert text); **e2e** `market-data.spec.ts` `✘ the CoinGecko attribution is present…` — `img[src="/icons/coingecko-symbol.png"]` count 0 (the orchestrator's `ab0b5e4` assertion)                                        | yes            |
| P3-C8r  | C-8 route half — `unresolved` is the caller's own               | `routes/investments.ts` `readUnresolvedSecurities`: `WHERE user_id = …` dropped                                                | **GREEN** — `investments-routes` + `net-worth-routes` 25/25. No api-db test references `unresolved` at all                                                                                                                                           | **no — green** |
| P3-C9r  | C-9 route half — `lastSnapshotFailure` is the caller's own      | `routes/net-worth.ts` `readLastSnapshotFxFailure`: `AND user_id = $2` → `AND $2::uuid IS NOT NULL`                             | **GREEN** — 25/25. No test references `lastSnapshotFailure`                                                                                                                                                                                           | **no — green** |
| P3-C9s  | C-9 — `POST /net-worth/fx-rates` is step-up gated (D21)         | `requireFreshSession` → `requireSession` on that handler                                                                       | **GREEN** — `investments-routes`, `net-worth-routes`, `gate-phase1`, `insufficient-scope` 35/35. No test calls the route                                                                                                                              | **no — green** |
| P3-C13  | C-13 the descriptor is sealed                                   | `domain.ts` `write()`: the plaintext `descriptor` written **beside** its sealed copy (`descriptorColumn = record.descriptor`)   | **GREEN** — `wallet-holdings-valuation`, `investments-routes`, `investments-sync`, `investments-db` all green. There is no raw-column custody test (4.12c §1.1 says so; the commit message of `71a1258` says "raw-column custody test"). And §3 shows the seal is **not wired** in either composition root | **no — green** |

### 2.6 Other Phase 4 controls

| #   | Control                                                                  | Sabotage                                                                                                        | Observed                                                                                                                                                                                                                                         | Red first try  |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| AH1 | an assumption never changes without the content hash moving              | `assumptions.ts` `hashable`: every `bigint` (every `Money` limit) → the constant `'0'`                         | `× the content hash changes when any value changes and not when a comment does` — `changing $.marketReference.fdicInsuranceLimit must change the version`                                                                                       | yes            |
| OV1 | overrides are deltas, never a copy (the database half)                   | `0021`: `plan_assumptions_deltas_are_a_delta` → `CHECK (true)`                                                  | `planning-db` 1 red — `expected the insert to be refused`                                                                                                                                                                                        | yes            |
| RP1 | the questionnaire moves the score conservative                           | `risk-profile.ts`: `credited = 2 * Math.min(…)` → `Math.max`                                                    | 2 red in `planning`/`planning-db`                                                                                                                                                                                                                | yes            |
| MF1 | a module flag that is off registers nothing                              | `platform.ts` `resolveModules`: the `continue` after `disabled.push` removed                                   | `× a flag that is off contributes no event, no consumer, no job and no schedule` — `got 7`                                                                                                                                                        | yes            |
| SN1 | the refresh schedule's name is one the platform accepts                  | `PROJECTION_REFRESH_SCHEDULE_NAME = 'planning.projection-refresh'`                                              | `× registers the 04:30 refresh and the goal-pace consumer under names the platform accepts` — `PlatformError: schedule name …`                                                                                                                  | yes            |
| CI1 | every vitest project is in `ci.yml` (§5 item 5)                          | `ci.yml`: `--project planning-db` removed                                                                       | `check-ci-projects: FAIL — 'planning-db' is declared in vitest.config.ts but appears in neither ci.yml job's --project list`                                                                                                                     | yes            |
| R2a | R2 fires **below** the success target (07 R2, §6 Q5)                     | `success.ts`: `success >= target` → `success > target` (fires at exactly the target)                            | **GREEN** — `insights` 230/230. No case sits on the boundary                                                                                                                                                                                     | **no — green** |
| EM1 | **an employer-stock tag is never inferred** (§5 item 4, 07 I5)          | `domain.ts` I5 composition: `employerStockOf` → `… \|\| securityId.length > 0` (every holding is employer stock) | **GREEN** — `phase3-advisors` 5/5, `investments`, `insights`. The structural test scans only `packages/contexts/investments/src` for the literal; the behavioural twin (`classifying a security named … after a real company sets no tag`) builds a fresh store `classify()` never touches and cannot fail; the I5 firing test tags the portfolio's only security, so "tagged" and "everything" look alike | **no — green** |

**Probe, not counted — the Phase 5 planner's input (1).** A temporary api-db test (written,
run, deleted; `git status` clean afterwards) stored `module.insights = false` for the
holder, then `POST /advisors/run` with a fresh session: **HTTP 200, 31 advisors
`completed`, 6 `refused: advisor_disabled`** (the six that ship off), 37 `advisor_runs`
rows. `routes/insights.ts:217–218` and `modules.ts:810–811` hard-code `advisorsEnabled:
true, moduleEnabled: true`; the insights routes read no flag. The nightly path is honest
(`resolveModules` skips the whole module, MF1), but the on-demand path runs every enabled
advisor — including, once granted, an `external` advisor that receives a snapshot — with
the module switched off. The "a flag that is off contributes nothing" claim is true of
registration and false of the route. → **G4-9 (Medium)**.

### 2.7 Scorecard

| Group                                                       | Valid sabotages | Red first valid attempt | Green (no test fails)                             |
| ----------------------------------------------------------- | --------------- | ----------------------- | ------------------------------------------------- |
| §2.1 the "never" list                                       | 20              | 16                      | NB3, NB4, CK2, ST0                                |
| §2.2 cross-user, alone + together                           | 21              | 16                      | XU13, XU15, XU16, XU17, XU19                      |
| §2.3 consent route + registration                           | 4               | 4                       | —                                                 |
| §2.4 worker, wire, client worker, budget                    | 10              | 10                      | —                                                 |
| §2.5 the Phase 3 conditions                                 | 19              | 15                      | P3-C8r, P3-C9r, P3-C9s, P3-C13                    |
| §2.6 other Phase 4 controls                                 | 8               | 6                       | R2a, EM1                                          |
| **Total**                                                   | **82**          | **67**                  | **15**                                            |

XU3, XU5, XU6 and XU7 are counted red because a store-level test in the same run set failed
(the route suite alone stayed green — the S1 shape, recorded in §2.2). **Not counted:**
three not-applied anchors (SC1 ×2 matched twice / zero times, CK1's first anchor matched
twice, P3-C9s's first anchor matched twice) and one invalid attempt (P3-C14's first,
incidental migration failure); the numeric-boundary grep and the `module.insights` probe,
which test claims rather than controls.

**The shape of the greens.** Phase 4's _own_ engine controls — reproducibility, the
boundary, the worker, the drift and golden-vector pair, the consent route, the wire format —
went red on the first try every time they were aimed at a named exit test (30 of 30: the
16 red rows of §2.1, all of §2.3 and §2.4). The
greens cluster in three places: (i) **scoping predicates** whose only tests are
route-level and which sit on the first read of their path (G4-4); (ii) the **4.12c
surfaces** (C-8/C-9 route halves, C-13) whose evidence says, honestly, that no test could
be written in the granted files — and whose commit message says the opposite (G4-5, G4-8;
_renumbered by the finishing reviewer — this line said "G4-2" before §3.2 assigned that
number to the KEK race_);
(iii) two "never" claims whose tests look in the wrong place (employer stock at the
composition root, G4-7; the imported alias, G4-6). This gate wrote no permanent test.

_Section §2 COMPLETE._

---

## 3. The cold walk (Standard C)

_IN PROGRESS — the stack may be up. Teardown list: `docker compose down -v`; remove
`compose.override.yml`; stop/rm `mailpit`/`ntfy` dev-sinks containers and remove
`personalfi_backend` if it survives; remove the `personalfi_returns_cache` volume if it
survives; delete the seven empty placeholders listed in `/tmp/gate4/created-placeholders.txt`._

### 3.1 Preparation (gate-only, all undone at teardown)

- **Seven empty provider-key placeholders** created, mode 0444, per RUNBOOK step 2/8
  (`coinbase_key_name`, `coinbase_private_key`, `coingecko_api_key`, `etherscan_api_key`,
  `fred_api_key`, `openfigi_api_key`, `tiingo_api_key`) — a **zero-provider-key install**,
  as in Phase 3. `ls -ln` metadata only; no secret file was read.
- **A gate-only `age` keypair** (`age-keygen` into `/tmp/gate4/age/`, identity 0600 owned
  by the gate's user; the public recipient 0444). A throwaway `compose.override.yml`
  points the `age_recipient` secret at that public key, because this host's real
  `secrets/age_recipient` is still `10002:10002 0400` (§1) and the api (uid 10001) could
  not read it — the walk would otherwise stop at `EACCES` rather than exercise C-5. The
  deployment's real recipient was not touched or read. Nothing else is overridden:
  in particular **the api is given no return-series volume**, so the walk sees the
  Monte Carlo binding exactly as shipped.

### 3.2 Cold boot, bootstrap, and C-1's claim

HEAD at walk start `691435f` (production code identical to `088fe4d`, §1). `docker compose
down -v` (nothing was up), `docker compose build` (api, proxy, backup), `docker compose up
-d --wait` at 19:35:19Z. The built api image carries `age` v1.3.1 and
`data/returns/fetch.ts`, and **no** `data/returns/cache/` (the non-redistribution holds in
the image).

| Observation                                   | Result                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrator`                                    | exit 0, `migrations complete: 26 applied, 0 already present` — 0001…0022, **0024** (`snapshot_grant_scopes_v1_3`), **0025** (`investments_security_scoping`), **0026** (`allocation_targets`), **0027** (`wallet_addresses_seal_descriptor`). 0023 does not exist (burned in Wave B, execution log 17:40) — "0001–0027" is 26 files                                                                                    |
| services                                      | db, api, worker, proxy, backup all `healthy` in 19 s                                                                                                                                                                                                                                                                                                                                    |
| api at boot                                   | `planning.returns_series_unavailable: Monte Carlo is bound to null` — the api process has no return series and no volume to find one on (§3.4)                                                                                                                                                                                                                                         |
| worker at boot, no holder                     | `no account holder yet; polling for one — main() does not return while idle`; `RestartCount=0` at 19:35:55Z, 23 s after boot and past nothing (C-1's poll holds while idle)                                                                                                                                                                                                              |
| `just bootstrap-user` (inside api, 19:35:55Z) | `taxonomy 153`, **`advisors 37 manifests registered`** (31 + R1–R4, R6, R7), schedules as Phase 3's six, `key custody unlocked · argon2id m=1048576 KiB t=4 p=4 · 5624 ms · KEK generation 1`                                                                                                                                                                                     |
| **worker, 19:36:08Z, unprompted**             | **`worker failed to start: duplicate key value violates unique constraint "encryption_keys_scope_version_key"`** — the process exited and Compose restarted it (**`RestartCount=1`**, `StartedAt 19:36:08.437Z`). The restarted process unlocked (`key custody: unlocked`, `kekVersion 1`) and came up. → **G4-2**, below                                                               |
| worker after the restart                      | `modules resolved` — all 10 enabled, `disabled: []`; `consumer pump started` with **8 consumers** incl. `planning.net_worth@v1` and **`planning.goal_pace@v1`**; `job runner started` with 10 kinds incl. **`planning.net_worth_snapshot`** and **`planning.projection_refresh`**; `scheduler leadership acquired`; `worker ready`. Its own `planning.returns_series_unavailable … bound to null` |
| `schedules`                                   | 8 rows; `planning.projection_refresh` cron `30 4 * * *`, `America/New_York`, next `2026-09-29 08:30Z` (registered by the worker; not in `bootstrap-user`'s printed list, which is Phase 3's six)                                                                                                                                                                                         |
| passkey enrolment through Caddy               | Playwright Chromium, CDP virtual authenticator (ctap2/internal, resident key, UV), `--host-resolver-rules=MAP personalfi.lan 127.0.0.1`: `GET /api/auth/unlock-state 200`, `POST …/register/options 200`, `POST …/register/verify 200`, **zero 403s**, session `authMethod: webauthn, fresh: true`. `gate-01-register.png`, `gate-02-enrolled.png` |

**G4-2 — C-1 is not closed on the cold path; a keyring race replaces the idle exit.**
`@core/secretbox`'s `unlock()` (`secret-box.ts:147`) reads "is there a KEK row?"; if not,
`#initialiseKeyring` draws a random salt, spends ~5.6 s in argon2id, and only then
`INSERT`s the row. `bootstrap-user` creates the user **before** that derivation, and C-1's
worker — which now polls every `JOB_POLL_INTERVAL_MS` (5 s) instead of exiting — finds the
user inside the 5.6 s window and runs the same check-then-insert. Two processes derive two
KEKs under two salts; the first `INSERT` wins, the second dies on
`encryption_keys_scope_version_key`. Because derivation (5.6 s) outlasts the poll interval
(5 s), the worker's loss is close to certain on every cold install. What saves the data:
the loser installs its key only after a successful insert, so no process holds a KEK that
disagrees with the stored verifier. What it costs: C-1's exit criterion ("the worker must
show RestartCount=0 after bootstrap") is **not met**; RUNBOOK step 4 says "A worker that
restarts here on the current build is a regression, not a known quirk"; and in the other
order (a slower bootstrap host) the loser would be `bootstrap-user` itself, after the user
row is written. The C-1 test (`worker-account-holder-poll.test.ts`) drives a fake
`findPrimary` and never unlocks a keyring, so it cannot see this. Phase 3's gate could not
either: its worker only ever came back after the row existed. Not fixed in place — the fix
is in key custody (on a unique violation, re-read the winner's row and unlock against its
salt), and a gate does not edit the KEK path; → C-2.

**Resume (finishing reviewer, 2026-09-28 ~21:00 EDT).** The first reviewer was killed by an
account limit here. A second Opus `security-engineer` continued from this file with the stack
still up (all five services `healthy`, ~5 h; `RestartCount` unchanged since §3.2), the
override, the `returns_cache` volume and `/tmp/gate4/` intact. Nothing was rebuilt; the
cold-boot observations above stand as recorded. The walk driver is
`/tmp/gate4/walk/lib.mjs` (Playwright Chromium, persistent profile, the CDP virtual
authenticator re-imported from the credential saved at enrolment). One harness change:
`waitUntil: 'networkidle'` never settles because the shell holds `GET /api/sync/stream`
(SSE) open, so every probe waits for `load` plus a fixed 6 s.

### 3.3 `/plan` as a fresh install sees it

| Observation | Result |
| --- | --- |
| nav | `Plan` present in the Wealth group, active state on `/plan` |
| first paint, zero accounts, no baseline | an empty state, **"Start your plan"** — plan name (`My plan`), birth date, retirement age `65`, plan end age `95`, annual retirement spending "optional — leave blank to derive it from your observed spending". No fan chart, no fabricated number, no error banner |
| API calls on load | `GET /auth/session`, `/sync/stream`, `/plan/life-events`, `/assumptions`, `/connections`, `/plan/scenarios` — **all 200, zero 4xx/5xx** (every one of the five new Phase 4 prefixes that the screen touches reaches the api through Caddy, not the SPA shell) |
| screenshot | `gate-03-plan-fresh.png` |

### 3.4 Baseline through the UI; what the screen does with a 409

Submitted the empty-state form (birth date 1980-06-15, the other fields as defaulted,
spending blank → "derive"). `POST /plan/scenarios` **201**; the baseline reads back with a
stored `seed` (`"13551924450590139445"` — a string, never a JSON number), `annualSpending:
null`, `withdrawalPolicy: guardrails`, `taxDeferredRate: "0.22"`. The screen then posts
`POST /plan/scenarios/{id}/projections` **twice, both 409**:
`planning.projection_no_balances` — "no sealed net-worth day exists yet; a projection starts
from a sealed day (08 §3.5)". The server is right: this install has no sealed
`net_worth_daily` row, and refusing is the §5 "never reads a live balance" control behaving
as designed.

**What the user sees** (`gate-04-plan-baseline.png`): the headline **"Projecting your
plan…" indefinitely**, an empty chart frame with the band legend, and — directly below it —
the "Try adjustments" panel showing **"Median at age 94: $177,339 — 61% of simulated paths
succeed"**, computed in the browser from a **$250,000 starting balance, $1,500/month
savings and $40,000/year spending that this user never entered** (the install has zero
accounts). Two findings:

- **G4-10 (Medium) — the plan screen swallows every projection error.**
  `PlanScreen.tsx` branches on `projectionQuery.isLoading` and `run !== null` only; the
  query's `isError` is never read. Every refusal the server words carefully —
  `projection_no_balances` here, `planning.monte_carlo_unavailable` on every install that has
  not run the operator fetch (§3.9, G4-1), `projection_balances_unsealed` — becomes a spinner
  sentence that never resolves. This is the "silent false state" shape Phases 1 and 3 each
  shipped once (the SPA-shell 200s; the placeholder hero net worth). Not fixed in place: the
  honest rendering needs copy per problem code and a test per state, a WP not a one-liner.
- **G4-11 (Medium) — the slider preview presents a success rate computed from placeholder
  money.** `sliders/buildPreviewJob.ts:57–59` seeds `DEFAULT_STARTING_BALANCE = 250_000`,
  `DEFAULT_MONTHLY_SAVINGS = 1_500`, `DEFAULT_ANNUAL_SPENDING = 40_000` whenever the profile
  is silent, and the starting balance **always** (the header discloses it: "seeded from a
  placeholder default when nothing better is known"). The panel's caption says it is "a
  quick, local what-if preview", but the sentence it renders — a median in dollars and "61% of
  simulated paths succeed" — reads as the user's number, and on this install it is the only
  number on the screen. The Phase 3 gate's G3-2 (`$88,904.00` placeholder hero) is the
  precedent. Remedy: seed the starting balance from the sealed net-worth figure the
  projection uses (or show no preview until one exists), and label placeholder levers as such.

**Also observed here (feeds G4-10):** the plan screen never sends `allowOpenDay`, and a
fresh install has no sealed day until the first `planning.net_worth_snapshot` that runs
after 02:00 local on the **following** day (`seal.ts` `isSealable`). So the fan chart of a
genuinely new install is empty until roughly 04:00 the next morning, with nothing on screen
saying why. There is no user-authored goal or questionnaire on screen at all — see §3.6.

### 3.5 The operator series fetch — why it failed, reproduced

RUNBOOK.md has **no step** for the return series (grep: no "return series", "returns",
"Monte Carlo" or `fetch.ts` anywhere in it). The only instructions are the fetch script's
own header and a compose comment ("An operator fetches WP 4.5's pinned return series onto
it once"). Run as documented, inside the worker (the one service that mounts the volume):

```
docker compose exec -T worker node packages/contexts/planning/data/returns/fetch.ts --cache-dir /var/lib/personalfi/returns
source last-modified: Wed, 02 Sep 2026 17:51:53 GMT
source sha256:       044196da… (1674752 bytes; not pinned)
window:              1871-02..2024-12, 1847 months
cross-check vs Shiller's index columns: equity 4.44e-16, bond 4.44e-16
derived sha256:      cbdefda1752eac2bd393efbae29a8dfb8d0af2b79a9d7cf2baa5f0e292851e80
matches the pin
Error: EACCES: permission denied, open '/var/lib/personalfi/returns/shiller-monthly.csv'
```

The download, the derivation and the checksum pin all work from this host. **The write
fails because Docker created the `returns_cache` named volume `root:root 0755`** (the mount
point does not exist in the image, so nothing seeds its ownership) and the worker runs as
`10001:10001`. This is the first attempt's failure, now with its reason. It is not host
state: it happens on every compose install. Together with the facts below it forms
**G4-1**:

- **(a)** the worker, the only service with the volume, cannot write it (above);
- **(b)** the **api has neither the volume nor `PLANNING_RETURNS_CACHE_DIR`** (`compose.yml`
  mounts `returns_cache` on `worker` only; its comment says "`api` binds no `monteCarlo`"),
  yet `app.ts:498` builds the interactive route's runner from that variable. So every
  interactive `POST /plan/scenarios/{id}/projections` asking for Monte Carlo is bound to
  `null` on every compose install, whatever an operator fetches;
- **(c)** `createMonteCarloRunnerFromCache` reads the series **once at process start**, so
  a successful fetch has no effect until a restart, and no document says so;
- **(d)** RUNBOOK has no step at all.

Consequence: exit criterion "10k paths ≤ 800 ms" is met by the engine, but **no shipped
install can serve a Monte Carlo projection to the user**. Severity is ruled in §4
(`HIGH` candidate: it is the phase's headline feature, and it fails silently on screen per
G4-10). Not fixable in place in one file: the remedy spans `docker/api.Dockerfile` (create
`/var/lib/personalfi/returns` owned by 10001 — the image has no `mkdir`/`chown` for it today so an empty volume inherits it), `compose.yml`
(mount it read-only on `api` with the variable), and a RUNBOOK step including the restart →
C-1.

### 3.6 A goal and the risk questionnaire — through the API, because there is no screen

**There is no screen for either.** `apps/web/src` has no file that calls `/goals`,
`/goals/{id}/contributions` or `/risk-profile` (grep over every non-generated `.ts`/`.tsx`;
the word "risk" appears only in `recurring`'s `AT_RISK` and two comments). The plan
screen's "Set goal" form writes `goalTargetMinor`/`goalDate` into the **URL**
(`features/plan/search.ts`, a disclosed WP 4.10 simplification: "building a full
goal-management screen is outside this WP's five named exit tests"). WP 4.10's brief in 04 §3
never asked for a questionnaire screen, yet 04 §5 item 3 makes "the questionnaire is
answered inconsistently and the score moves conservative **on screen**" a walk step. A
user of the UI alone therefore never creates a `goals` row, so `GoalOffTrack` (and every
R-rule reading `goals.list`) can never fire for them, and never has a risk profile. →
**G4-12 (Medium)**: the phase's user-authored planning inputs (goals, contributions, risk
questionnaire, earmarks) are API-only; the gate step is unwalkable on screen. This is a
planning gap between 04 §3 and 04 §5, not a WP failing its brief.

Walked instead through the same session in the real browser (same-origin `fetch` with the
CSRF echo, through Caddy):

| Step | Result |
| --- | --- |
| `GET /risk-profile` | 200, instrument `risk-v1`, six items — three dispositions (drawdown, volatility, risk identity) each asked twice, `stated` and `revealed`; every `revealed` item has a `no_evidence` option with `points: null`. `current: null` |
| `PUT /risk-profile`, consistent (stated 5 / revealed 5 ×3) | 200 — `aggressive`, composite **30**/30, penalty **0**, "Your answers were consistent." |
| `PUT /risk-profile`, **inconsistent** (stated 5 ×3; revealed `sold_all` 1, `stocks_under_20` 1, `mostly_safe` 2), with an income of $140,000 single | 200 — **`conservative`, composite 8**, unpenalised 19, **penalty 11**, `toleranceIfAveraged: moderate`. Every disposition's sentence names both answers: "…The score takes the more conservative answer, 1, not the average, 3. Penalty 4." Total: "Averaging the two framings would have given 19 (moderate); the 11-point consistency penalty is the difference." **The score moved conservative, and the penalty is shown in words** |
| stored `risk_profile` rows | two rows (history kept); `tax_bracket_band` `22-32` on the second, `NULL` on the first (income declined). **The income never reaches the row**: `row_to_json(t)::text ~ '14000000'` is false on both |
| `POST /goals` retirement, $3,000,000 by 2045-06-15, priority 1, funded from the three investment accounts | 201, `status: active` |

### 3.7 Balances, a sealed day, and the first projection on the shipped api

**Seed.** One manual connection (`POST /connections`, provider `manual`, step-up — 201):
checking $30,000, brokerage $180,000, 401k $320,000, Roth IRA $60,000, balances recorded
through `POST /accounts/{id}/balance` (200 ×4) with `asOf` 2026-09-26T16:00Z.

**First snapshot tick.** `UPDATE schedules SET next_run_at = now()` on
`planning.net_worth_snapshot` (the Phase 3 precedent — the real scheduler then enqueues and
the real runner executes). The scheduler enqueued at 00:52:24Z with `run_after` 01:00:06Z;
the job `succeeded` at 01:00:09Z. `net_worth_daily` 2026-09-28, revision 1, **open**,
`net_worth_minor 3000000`, `accounts_counted 1`, **`accounts_unvalued 3`**: an investment
account is valued only as Σ quantity × price (`net-worth.ts` `valueByQuantityTimesPrice`,
"never backfilled by transaction subtraction"), and a manual investment account has no
holdings, so its hand-entered balance — accepted with 200 — counts nowhere. Honest by the
module's own rule (unvalued, not zero), and observation **O-2**: nothing on the balance
route or the plan screen tells a user that the $560,000 they just typed is outside the
projection.

**Walk accommodation — one row's date.** Sealing needs a snapshot after 02:00 local on the
following day (§3.4), about seven hours away. The gate moved the one open row's
`as_of_date` from 2026-09-28 to 2026-09-27 (`UPDATE net_worth_daily … WHERE sealed_at IS
NULL`) — the row the real snapshot would have written had it run on the 27th, since every
balance was observed on the 26th — and fired the schedule again. The **real code** then
sealed 2026-09-27 (`sealed_at 01:08:39Z`) and computed 2026-09-28 as the new open day
(job `succeeded` 01:08:39Z). No other row was written by hand at any point in the walk.

**What the screen and the api did next:**

| Request | Result |
| --- | --- |
| `/plan` reload (the UI's own call, body `{}`) | **422 ×2 `planning.projection_spending_unknown`** — "the baseline states no retirement spending and none could be derived from twelve months of spending (09 GOAL-4); state it in the baseline". The empty-state form's own hint ("leave blank to derive it from your observed spending") leads straight here on any install without twelve months of history, and **once a baseline exists the UI has no field to state spending** (the form renders only in the empty state). Screen: "Projecting your plan…" again (`gate-05-plan-sealed-no-series.png`) → adds to G4-10 |
| baseline upsert via API (spending $60,000; contributions TAX_DEFERRED $23,000, ROTH $7,000, TAXABLE $6,000; SS PIA $2,800 at 67y0m, `stressAfter2034`) | 201, **same id and seed** (`13551924450590139445`) — the upsert keeps both, as documented |
| `POST …/projections` `{}` | **200 `computed`**, `method: deterministic`, `paths: 1`, `engineVersion personalfi.deterministic/1`, `asOfDate 2026-09-27`, **`balancesSealed: true`**, `assumptionsVersion sha256:d2947…`, `successProbability: "1.000000"` (a string), 11 ms |
| `POST …/projections` `{"method":"monte_carlo","paths":10000}` | **409 `planning.monte_carlo_unavailable`** — "no Monte Carlo engine is bound in this process (WP 4.5); the deterministic projection is available, and is never substituted silently" — the honest refusal, on the shipped wiring (G4-1 (b)) |
| `/plan` reload | the chart draws (`gate-06-plan-deterministic.png`): one line, **labelled "median" in words on the line itself and in the legend**; x-axis 2030…2070; the three band swatches in the legend with no bands drawn |

**G4-13 (Medium) — the headline states a deterministic path as a probability.** The
headline reads **"You're on track for +$46,821.89 at age 94 — 100% of plans succeed."** The
run behind it is `method: deterministic, paths: 1`: its `successProbability` can only be 0
or 1, and "100% of plans succeed" presents that as a Monte Carlo result. Nothing on the
screen names the engine (`PlanScreen.tsx`/`FanChart.tsx` never read `run.method`; the page
text contains "determin…" nowhere). Directly below, the slider panel says **"65% of
simulated paths succeed"** from its placeholder $250,000 (G4-11). One screen, two
success figures, neither honestly labelled — and because of G4-1 the deterministic one is
what **every** shipped install shows. The server keeps its promise ("never substituted
silently"); the screen breaks it one layer up. The "on track" wording also ignores the
active $3,000,000 goal, which this run cannot meet (§3.8).

### 3.8 The dotted gap line, and every assumption cited

Driven in the browser (`/tmp/gate4/walk/08-gap.mjs`):

| Step | Result |
| --- | --- |
| "Set goal" $3,000,000 by 2045-06-15, ceiling $5,000/mo | the dotted gap line renders; accessible name "Calculate the monthly saving required to close the gap between the projected path and your goal" |
| gap line clicked | `POST /plan/required-savings` **200** → **"Save an additional $3,642.27 per month to reach this goal."** (`gate-07-required-savings.png`). The `Money` component prints it as "+$3,642.27" — a sign on a required amount, cosmetic (O-3) |
| "Set goal" $10,000,000 by 2027-01-01, ceiling $2,000 → gap clicked | 200 → **"This goal is unreachable: the target date is less than a year away: there is no whole year left in which an additional contribution could be made and grow"** — the constraint named in words; **0** `.money-sensitive` elements inside the unreachable block; no "Save an additional" (`gate-08-required-savings-unreachable.png`) |
| the goal's persistence | the URL now carries `goalTargetMinor="1000000000"&goalDate=2027-01-01…`; nothing was written to `goals` (G4-12) |
| assumptions panel, no click | header "Assumptions file version sha256:d294715e…. 92 cited figures." **92 `Source:` lines, 92 with `· As of YYYY-MM-DD`**, five distinct dates (2025-12-31 … 2026-09-24); 0 `<details>`, 0 collapsed buttons; 17 `Edit` affordances (the overridable paths) (`gate-09-assumptions.png`) |

The server-side gap computations are the deterministic engine's (every install, G4-1).

### 3.9 Sliders, a life event by keyboard, scenario compare

**Harness note.** Two scripts failed at login here with `POST /auth/login/verify` **429** —
the harness opened a fresh browser process per step and Chromium does not persist session
cookies across processes, so every step re-authenticated and the api's login throttle
tripped. That is the control working, not a defect. The harness now persists the cookie
jar (0600, never printed) and the gate waited the lockout out (4 min) before one retry.

**Sliders (WP 4.11), real pointer drag on "Monthly savings"** (`10-sliders.mjs`, a request
listener registered after the mount's own 250-path preview had resolved):

| Observation | Result |
| --- | --- |
| at rest | "Preview based on 250 simulated paths" |
| mid-drag (mouse down, 12 intermediate moves, not released) | median **$461,380 → $3,039,504** — the bands reshaped; **0 requests of any kind** (not only `/api/`) during the drag (`gate-10-slider-dragging.png`) |
| on release | status sequence **"Refining…" → "Preview based on 5,000 simulated paths"**; **0 `/api/` requests** after release either — the preview is worker-local and the saved plan untouched, as the caption says (`gate-11-slider-refined.png`) |

The panel's caption says the saved plan "is unchanged until you act on it", but the panel
has **no action** (no button, no mutation in `GoalSliders.tsx`) — part of G4-12.

**Life event, keyboard only** (`11-events.mjs`): created through the "Add a life event"
form (Inheritance, "Aunt estate", 2034-03-01, $50,000) → `POST /plan/life-events` **201**.
The timeline's native range input focused; ten `ArrowRight` and one `PageUp`, no pointer
event → `aria-valuetext` **"Mar 1, 2034" → "Feb 3, 2039"**, `PATCH
/plan/life-events/{id}` **200**, `occursOn: 2039-02-03` read back from `GET` — persisted
(`gate-12-life-event-keyboard.png`).

**Scenario compare.** The UI has **no way to create a fork** (the only `'fork'` in
`features/plan` is a test fixture; G4-12), so "Retire at 62" (`levers: {retireAge: 62}`) was
created via `POST /plan/scenarios` (201; the stored fork holds only that lever). Then, in
the browser, Scenario A "My plan", Scenario B "Retire at 62" → `GET /plan/compare?a=&b=` 200:

| | |
| --- | --- |
| A | My plan — success probability **100%**, retirement date 2045-06-15 |
| B | Retire at 62 — success probability **0%**, retirement date 2042-06-15 |
| delta | "Δ success probability: −100%"; "Δ retirement date: **-36 months earlier**" |

(`gate-13-scenario-compare.png`.) Two side by side with the delta — the step is met. Two
remarks: the 100% / 0% / −100% are deterministic outcomes shown as probabilities (G4-13 — a
compare between two single paths can only ever say 0, 100 or ±100); "-36 months earlier" is a
double negative (O-4, cosmetic).

---

## 4. Threat model and findings (Standard D)

_NOT STARTED._

---

## 5. Rulings on the eleven gate inputs

_NOT STARTED._

---

## 6. Conditions

_NOT STARTED._

---

## 7. Teardown and final state

_NOT STARTED._
