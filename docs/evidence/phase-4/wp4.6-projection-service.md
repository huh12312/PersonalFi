<!-- SPDX-License-Identifier: MIT -->

# WP 4.6 — Projection service, scenarios, life events, store (migration 0022)

Package `@ctx/planning`. Four tables (`plan_scenarios`, `plan_life_events`, `projection_runs`,
`projection_percentiles`), the service that assembles a scenario, serves it from the cache or runs
an engine, stores the run and announces it, the R6 goal-pace evaluation, the 04:30
`planning.projection_refresh` job, and `SnapshotJobDependencies.portsFor(executor, userId)`.

Written 2026-09-26 on `main` at `5f3df45` (the "wip: snapshot" commit that holds this WP's first
pass, **not pushed**) plus this session's uncommitted edits: two tsc fixes and a prettier pass in
`test/db/projection-store.test.ts`, and two strengthened assertions in `test/ports.test.ts` (§7).
WP 4.5 (Monte Carlo) and the Wave B wiring batch were in flight in the same tree.

| File                                               | What                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/db/migrations/0022_plan_projections.sql` | the four tables, CHECKs, composite FKs, immutability triggers                        |
| `schema/projections.ts`, `schema/index.ts`         | Drizzle types and the ownership claim                                                |
| `src/scenarios.ts`                                 | baseline profile, fork lever deltas (`diffLevers`), `applyLevers`, storage           |
| `src/life-events.ts`                               | dated signed events; partition into what the engine can and cannot express           |
| `src/projection-store.ts`                          | sole writer of `projection_runs`/`projection_percentiles`; typed refusals; the claim |
| `src/projection-service.ts`                        | assembly, the cache, `runProjection`, `readProjection`, compare, refresh, goal pace  |
| `src/jobs.ts` (additions)                          | `portsFor(executor, userId)`; `planning.projection_refresh` job and 04:30 schedule   |
| `src/events.ts` (additions)                        | `planning.ProjectionCompleted`, `planning.GoalOffTrack`                              |
| `src/ports.ts` (additions)                         | the `MonteCarloRunner` port WP 4.5's worker host is bound to                         |
| `src/index.ts` (additions), `OWNERSHIP.md`         | public surface; `plan_life_events` claimed                                           |

---

## 1. Exit tests

All seven names the dispatch lists, verbatim, green (§9):

| File                                | Test                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `test/db/projection-store.test.ts`  | `'an identical request is served from projection_runs and does not re-run the engine'`                                       |
| `test/db/projection-store.test.ts`  | `'a run records its seed, engine version and assumptions version, and a missing one refuses the insert'`                     |
| `test/db/scenarios.test.ts`         | `'a scenario stores lever deltas and never a copy of the baseline'`                                                          |
| `test/db/scenarios.test.ts`         | `'a scenario compare reports the delta in success probability and in retirement date, computed under common random numbers'` |
| `test/goal-off-track.test.ts`       | `'a goal below its required pace emits GoalOffTrack exactly once per evaluation, not once per consumer delivery'`            |
| `test/db/stale-assumptions.test.ts` | `'a run against a retired assumptions version reads back as stale and is never silently recomputed'`                         |
| `test/ports.test.ts`                | `'portsFor takes a userId and a job for a second holder is served, not refused by name'`                                     |

Beyond the list: `'each cache-key input changed alone misses, and restoring it serves the original
run'` (§2), `'a redelivered ProjectionCompleted claims the goal evaluation once and appends
GoalOffTrack once'` (§4, against Postgres), `'a projection dated to a sealed day reproduces
byte-identically after a re-sync changes today'` (§6, the dispatch's §5 risk row), `'pace is exact:
funded + planned below target is off track, and R6 has its m and c'`, and `'registers the 04:30
refresh and the goal-pace consumer under names the platform accepts'` (§8).

Scratch databases (docs/TESTING.md): `personalfi_wp46_projection_store`, `personalfi_wp46_scenarios`,
`personalfi_wp46_stale_assumptions`, each created and dropped by its suite against the dev Postgres
at `127.0.0.1:5433`.

---

## 2. The cache key, one input at a time

`cache_key = sha256(assumptions + engine_version + seed + input)` (04 §5.6), `cacheKeyOf` in
`projection-service.ts`:

| Input          | What goes in                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assumptions    | the file's content-hash version **and** the holder's override deltas. `ResolvedAssumptions.version` is the file's hash even with overrides applied (WP 4.2), so the version alone would serve a 6.5%-equity run to a holder who has since overridden it to 5.5%                       |
| engine_version | `ENGINE_VERSION` for deterministic; `MonteCarloRunner.engineVersion` for Monte Carlo — a property of the port so it is known **before** the run                                                                                                                                       |
| seed           | the baseline's stored seed (a fork has none, 0022)                                                                                                                                                                                                                                    |
| input          | `input_digest`: sha256 over the canonical, number-free JSON of the whole assembled input — scenario id/kind/levers, method, paths, the balances' day/revision/sealed, the plan after levers and life events, which events applied and which did not and why, the input schema version |

`'each cache-key input changed alone misses, and restoring it serves the original run'`, one real
run against Postgres (fake Monte Carlo behind the port, real service, real store), printed by the
test:

| #   | Change (alone, from the original request) | Result       | Run id                                        |
| --- | ----------------------------------------- | ------------ | --------------------------------------------- |
| 1   | first request                             | **computed** | `01a0e0b5-c086-…-d912326fe533` (the original) |
| 2   | identical request                         | cached       | the original                                  |
| 3   | seed + 1                                  | **computed** | `01a0e0b5-c0cd-…`                             |
| 4   | seed restored                             | cached       | the original                                  |
| 5   | engine version `fake.montecarlo/2`        | **computed** | `01a0e0b5-c10c-…`                             |
| 6   | assumptions: `usEquity` override 0.055    | **computed** | `01a0e0b5-c14f-…`                             |
| 7   | assumptions: override cleared (engine v1) | cached       | the original                                  |
| 8   | input: balances revision 2                | **computed** | `01a0e0b5-c19a-…`                             |
| 9   | input: balances revision restored         | cached       | the original                                  |
| 10  | input: paths 5,000 → 6,000                | **computed** | `01a0e0b5-c1c5-…`                             |
| 11  | input: a life event added                 | **computed** | `01a0e0b5-c1fa-…`                             |

Every change misses; every restore lands on the original row (row 7 also restores the engine
version). The runner saw the baseline's seed on every call bar the deliberate move:
`[s, s+1, s, s, s, s]` — six computations, five cache hits that ran nothing.

`'an identical request is served from projection_runs and does not re-run the engine'`: the
deterministic engine (the real WP 4.4 one, wrapped to count) is called **once** for two identical
requests, one row exists, and `planning.ProjectionCompleted` is in `domain_events` **once** — a
cache hit is never re-announced (the WP 3.2 lesson, §4). The same holds through the Monte Carlo port.

A concurrent identical request that loses the race is handled in the store: `INSERT … ON CONFLICT
(user_id, cache_key) DO NOTHING` returns no row, `insertRun` returns the winner with
`inserted: false`, and the service serves it and emits nothing.

---

## 3. A scenario is a delta; a compare runs under common random numbers

**Delta, never a copy.** The fork is created with five levers, three of which restate the baseline;
the row stores the two that differ and nothing else:

```text
levers  = { retire_age: "67", annual_spending: { minor: "5500000", currency: "USD" } }
profile = null, seed = null
```

A fork whose every lever equals the baseline is refused `planning.scenario_levers_empty`; a fork of
a fork `planning.scenario_fork_of_fork`. Below the service the column cannot hold a copy:
`plan_scenarios_levers_are_deltas` refuses an unknown key (`"buckets"`) and a JSON number
(`{"retire_age": 66}`), `plan_scenarios_shape` a fork with a profile,
`plan_scenarios_seed_is_the_baselines` a fork with a seed. And because the fork holds only deltas,
restating the baseline's `taxDeferredRate` to 0.22 reaches the fork's next run.

**Compare.** `'a scenario compare reports the delta in success probability and in retirement date,
computed under common random numbers'` — baseline (retire 65) vs fork (retire 67), Monte Carlo
through a recording fake runner, 10,000 paths:

| Run           | Scenario kind | Seed (runner saw)     | Seed (stored)         | Success    | Retirement date |
| ------------- | ------------- | --------------------- | --------------------- | ---------- | --------------- |
| A `…1b39…`    | baseline      | `2568135071291954450` | `2568135071291954450` | `0.650000` | 2051-03-15      |
| B `…1b70…`    | fork          | `2568135071291954450` | `2568135071291954450` | `0.710000` | 2053-03-15      |
| **Δ (B − A)** |               | **equal**             | **equal**             | **`0.06`** | **+24 months**  |

The seed lives on the baseline only, so a fork _cannot_ run on another: common random numbers by
construction, and `compareScenarios` still asserts the two stored seeds are equal before
subtracting. The delta is a decimal string (micros, exact), never a float. Re-opening the compare
serves both runs from `projection_runs` (`['cached', 'cached']`, runner call count still 2) — D20,
server-authoritative.

---

## 4. `GoalOffTrack`: once per evaluation, not once per delivery

The WP 3.2 defect (wp3.2-lots.md, "Every re-delivery re-announced") was an emit site with no memory.
Here the memory is in the row: the goal-pace consumer (`planning.goal_pace@v1`, on a **baseline**
run's `ProjectionCompleted`) first claims the run —

```sql
UPDATE projection_runs SET goals_evaluated_at = $now
 WHERE user_id = $u AND id = $run AND goals_evaluated_at IS NULL
RETURNING id
```

— and only a claimed run is evaluated and emits. The claim comes **before** the emit, in the pump's
transaction; `projection_runs_are_immutable` refuses re-stamping it. A receipt in
`processed_events` would stop a redelivery but not a replay from 0 after a version bump; the
in-row claim stops both.

Event counts, both drivings of the real consumer:

| Driving                                                                                     | before | after 1st delivery | after redelivery            | after a new evaluation   |
| ------------------------------------------------------------------------------------------- | ------ | ------------------ | --------------------------- | ------------------------ |
| `test/goal-off-track.test.ts` (fake store with the SQL guard's semantics, recording outbox) | 0      | **1**              | **1** (two more deliveries) | 2 (the next night's run) |
| `test/db/projection-store.test.ts` (real Postgres claim, real `domain_events`)              | **0**  | **1**              | **1**                       | —                        |

Claims attempted in the fake: `[f1, f1, f1, f2]` — every delivery tried, two succeeded. A fork run
claims nothing and evaluates nothing. The payload carries ratios and months only
(`fundedRatio '0.1'`, `requiredPace '0.7'`, `monthsRemaining 12`, `fundedSource 'earmarks'`), never
an amount.

R6, made exact (`evaluateGoalPace`): funded = live earmarks, else the sealed balances of funding
accounts no other active goal also names (a shared account is excluded and reported), else zero;
planned = every contribution scheduled after `asOf` through the target date, exact; **off track iff
funded + planned < target**. R6's `m` and `c`: $20,000 − $2,000 over 12 months → `requiredMonthly`
$1,500; `plannedMonthly` $500. Retirement goals are R2's (success probability), not a pace.

---

## 5. A retired assumptions version reads back stale, and nothing recomputes

`'a run against a retired assumptions version reads back as stale and is never silently
recomputed'`. Last year's build held file X (the checked-in file with `inflation.mean` changed, so it
hashes differently); the holder overrode `usEquity` 0.06 against X and saved a run. This year's
build holds only Y.

```json
{
  "storedVersion": "sha256:4f1a3c56…d55d4cd",
  "buildHolds": ["sha256:d294715e…42ed67f"],
  "reopened": {
    "reason": "assumptions_version_retired",
    "assumptionsVersion": "sha256:4f1a3c56…d55d4cd",
    "known": ["sha256:d294715e…42ed67f"]
  },
  "opened": "stale",
  "nightly": "stale",
  "engineCalls": 1
}
```

- `readProjection` returns the stored run and bands **as stored**, labelled
  `assumptions_version_retired` with the version named.
- Opening the scenario (`runProjection`) and the nightly `refreshBaseline` both answer `stale` with
  the old run. Neither calls the engine (`engineCalls` stays 1), no row is added, no
  `ProjectionCompleted` is appended, and a full dump of `projection_runs` + bands is byte-identical
  before and after.

The service does not catch `UnknownAssumptionsVersion` and fall back to today's defaults: that would
drop the holder's overrides and present a new number under the scenario's old name. §7 S4 is
exactly that fallback, and it goes red.

---

## 6. Balances from a sealed day

Starting balances by tax bucket come from Planning's own `net_worth_daily` — the newest **sealed**
day, or the named day's current revision — never a live balance read; an open-day run is refused
`planning.projection_balances_unsealed` unless `allowOpenDay` asks, and the run records
`balances_sealed`. `'a projection dated to a sealed day reproduces byte-identically after a re-sync
changes today'`: a run from sealed 2026-09-24 (taxable $100,000, tax-deferred $250,000), then the open
day 2026-09-25 is re-synced; the re-run is a cache hit on the same row and the dump (run, input,
digest, key, bands) is byte-identical.

---

## 7. Sabotage

Each control broken once in production code, the named test run, red observed, the file restored
from saved bytes and SHA-256 re-checked (`projection-service.ts 32908f5e…`, `scenarios.ts
485aa519…`, `jobs.ts 677e951d…`). **All red on the first attempt; all restored byte-identical.**

| #   | Sabotage (production code)                                                                       | File                    | Red                                                                       | First failure                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0  | cache lookup skipped (`hit = null`); only `ON CONFLICT` keeps one row                            | `projection-service.ts` | identical request served…; each cache-key input…                          | `expected 2 to be 1` (engine calls)                                                                                                                                                                  |
| S1a | cache key ignores **seed**                                                                       | `projection-service.ts` | each cache-key input…                                                     | `seed + 1: expected 'cached' to be 'computed'`                                                                                                                                                       |
| S1b | cache key ignores the **override deltas** (version only)                                         | `projection-service.ts` | each cache-key input…                                                     | `assumptions: usEquity override 0.055: expected 'cached' to be 'computed'`                                                                                                                           |
| S2  | `createScenario` stores the levers as given, no `diffLevers`                                     | `scenarios.ts`          | a scenario stores lever deltas…                                           | stored `+ expected_return_shift: "0"`, `+ glidepath: "age_based"`, `+ ss_claim_age: "67y0m"`                                                                                                         |
| S3  | goal evaluation ignores its claim's answer (`await store.claim(…)` then evaluates)               | `projection-service.ts` | GoalOffTrack exactly once…; a redelivered ProjectionCompleted… (Postgres) | fake: `afterRedelivery 3`, `expected 3 to be 1`; Postgres: `expected [0, 1, 2] to deeply equal [0, 1, 1]`                                                                                            |
| S4  | on `UnknownAssumptionsVersion`, resolve against today's file with overrides dropped, and compute | `projection-service.ts` | a run against a retired assumptions version…                              | `expected stale, got computed`                                                                                                                                                                       |
| S4b | `readProjection` skips the retired-version check                                                 | `projection-service.ts` | a run against a retired assumptions version…                              | `expected { reason: 'assumptions_changed', … } to deeply equal { reason: 'assumptions_version_retired', … }`                                                                                         |
| S5a | snapshot job binds the **first holder it sees** (`portsFor(executor, bound ??= context.userId)`) | `jobs.ts`               | portsFor takes a userId…                                                  | asked for `[A, A]`, expected `[A, B]`                                                                                                                                                                |
| S5b | the same binding in the refresh job                                                              | `jobs.ts`               | portsFor takes a userId… (after the strengthening below)                  | `revealedAskedFor` `[A, A]`                                                                                                                                                                          |
| S6  | `PROJECTION_REFRESH_SCHEDULE_NAME = 'planning.projection-refresh'`                               | `jobs.ts`               | registers the 04:30 refresh…                                              | `PlatformError: schedule name "planning.projection-refresh" must match /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/` — `platform.schedule_name_invalid`, thrown by `upsertSchedule`'s own `assertScheduleName` |

**Two tests strengthened this session, both before their sabotage:**

- The refresh half of `'portsFor takes a userId…'` drove one holder only, so S5b (a first-holder
  binding in the refresh job) would have passed. It now drives A then B and expects `[A, B]`; green
  before S5b, red under it.
- `'registers the 04:30 refresh…'` checked the name against the regex read from 0003 only. It now
  also calls the production `registerProjectionRefreshSchedule` through `upsertSchedule`, so S6 is
  refused by the **platform guard itself** (the thing that turns the Phase 2 crash-loop into a
  refusal), and pins the `(user_id, name, cron, timezone, job_kind)` that reach `schedules`.

---

## 8. Names, pinned

| Kind              | Name                           | Value / filter                                                                                                    | Pinned by                                                 |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| schedule          | `planning.projection_refresh`  | cron `30 4 * * *`, holder's zone, jitter 600 s                                                                    | `test/ports.test.ts` (regex from 0003 + `upsertSchedule`) |
| job kind          | `planning.projection_refresh`  | concurrency 1                                                                                                     | `test/ports.test.ts` (0003 `kind` CHECK)                  |
| consumer          | `planning.goal_pace@v1`        | `['planning.ProjectionCompleted']`                                                                                | `test/ports.test.ts`, `test/goal-off-track.test.ts`       |
| event             | `planning.ProjectionCompleted` | only on a freshly computed run                                                                                    | `test/ports.test.ts` (0003 `event_type` CHECK)            |
| event             | `planning.GoalOffTrack`        | once per goal per evaluation                                                                                      | same                                                      |
| `PLANNING_EVENTS` | 6                              | NetWorthSnapshotTaken, GoalCreated, RiskProfileAnswered, AssumptionsOverridden, ProjectionCompleted, GoalOffTrack | `test/ports.test.ts`                                      |

---

## 9. Verification (before the report)

- `pnpm exec tsc -b --noEmit`: only WP 4.5's `src/engine/prng.ts(205)` errors (TS2532 ×8 at the time
  of the run; the file was being edited concurrently). None in this WP's files; the two
  `test/db/projection-store.test.ts` errors are fixed (line 559: the transaction callback now
  `await`s `consumer.handler` inside an `async` block; line 601: `valuation: 'holdings'` →
  `'quantity_times_price'`, a real `ValuationMethod`).
- `DATABASE_URL=… vitest run --project planning --project planning-db --project db`: **161 passed, 1
  failed** of 162 in 31 files. The one red is WP 4.5's `src/engine/invariants.test.ts` →
  `'the p5 estimate is stable within 1% across ten seeds at n=10,000'` (1.509% vs 1%), not touched.
  All 20 tests in this WP's five files green; `packages/db/test/migrate.test.ts` green.
- `pnpm exec eslint packages/contexts/planning packages/db`: 13 errors, all WP 4.5's
  (`data/returns/fetch.ts` no-console ×12, `src/engine/monte-carlo.worker.ts` `process.env` ×1). None in
  this WP's files.
- `pnpm exec prettier --write` over this WP's files: `test/db/projection-store.test.ts` reformatted
  (the import line), everything else unchanged.
- `node scripts/check-numeric-boundaries.ts`: PASS — 755 files, 0 violations.
- `pnpm run lint:schema-ownership`: ok — 103 tables claimed across 14 packages, 90 defined.
- `packages/db/test/migrate.test.ts`: the orchestrator's pre-applied table names (`plan_life_events`,
  `plan_scenarios`, `projection_percentiles`, `projection_runs`) and 0022 attribution block **match
  the migration exactly**. No mismatch.
- `apps/api/src/reports/export/registry.ts`: the four deferrals are present (lines 293–307), each a
  WP 4.12 reasoned deferral, none excluded.

---

## 10. For the orchestrator

### 10.1 `apps/api/src/modules.ts` — `planningModule` (today lines 516–566)

`portsFor` now takes `(executor, userId)`, so the D6 by-name refusal wrapper goes: that is what
`'…a job for a second holder is served, not refused by name'` asserts. Imports to add from
`@ctx/planning`: `createGoalPaceConsumer`, `goalEvaluationStoreOf`, `projectionRefreshJobHandler`,
`registerProjectionRefreshSchedule`, `type MonteCarloRunner`; from `./domain.ts`:
`planningRevealedPortsFor`.

```ts
function planningModule(options: ModuleWiringOptions, clock: Clock): ModuleRegistration {
  const database = options.database;
  const baseCurrency = options.baseCurrency ?? 'USD';
  const portOptions = (userId: string) => ({ userId, timeZone: options.timezone, clock });
  const snapshot = netWorthSnapshotJobHandler({
    database,
    portsFor: (executor, userId) => planningPortsFor(executor, portOptions(userId)),
    timeZone: options.timezone,
    baseCurrency,
  });
  const refresh = projectionRefreshJobHandler({
    database,
    portsFor: (executor, userId) => planningRevealedPortsFor(executor, portOptions(userId)),
    // null until 4.5 is bound (§10.2): the nightly baseline is then deterministic and says so.
    monteCarlo: options.monteCarlo ?? null,
    timeZone: options.timezone,
  });

  return {
    flagKey: 'module.planning',
    events: PLANNING_EVENTS,
    consumers: [
      createNetWorthConsumer({
        database,
        options: { timeZone: options.timezone },
        executorFor: (context) => assertDrizzleTransaction(context.tx),
      }),
      // planning.goal_pace@v1 on planning.ProjectionCompleted. Claim, reads and every
      // GoalOffTrack in the pump's transaction.
      createGoalPaceConsumer({
        storeFor: (context) =>
          goalEvaluationStoreOf(assertDrizzleTransaction(context.tx), context.clock),
        outboxFor: (context) => context.tx,
      }),
    ],
    jobs: [snapshot, refresh], // planning.net_worth_snapshot, planning.projection_refresh; both concurrency 1
    schedules: async (userId: string): Promise<void> => {
      await registerNetWorthSnapshotSchedule(
        database,
        { userId, timezone: options.timezone },
        clock,
      ); // 04:00
      await registerProjectionRefreshSchedule(
        database,
        { userId, timezone: options.timezone },
        clock,
      ); // 04:30
    },
  };
}
```

`ModuleWiringOptions` gains `readonly monteCarlo?: MonteCarloRunner | null`. After this,
`options.userId`'s doc comment (modules.ts:139–158), the header paragraph at 509–515 and
`worker.ts:291–293` describe a refusal that no longer exists; `options.userId` itself has no
remaining planning reader.

### 10.2 `apps/api/src/domain.ts` — binding `MonteCarloRunner` to WP 4.5's worker host

Read against `src/engine/worker-host.ts` as it stands tonight (4.5 still in flight — re-read before
wiring). Its Money-facing entry point is `runMonteCarloInWorker(request, { deadlineMs? })` →
`{ result, durationMs, summary: MonteCarloSummary }`. Three things the adapter must do that are not
obvious from the types:

1. **Seed range.** 0022 stores the seed unsigned (`NUMERIC(20,0)`, 0 … 2^64−1) and
   `defaultSeedFor` draws a full 64 bits, so about half of all baselines have a seed ≥ 2^63. 4.5's
   `MONTE_CARLO_ENVELOPE` refuses anything outside **signed** 64-bit (its comment says
   `projection_runs.seed` is a Postgres BIGINT; it is not). The two are reconciled without a schema
   change: `prng.ts`'s `seedHalves` seeds from `BigInt.asUintN(64, seed)`, so passing
   `BigInt.asIntN(64, seed)` produces the **identical** xoshiro stream. Convert the echoed seed back
   with `BigInt.asUintN(64, summary.seed)` so the service's echo check still compares against what
   it asked.
2. **The cache's engine input.** `engineVersion` must change whenever the bytes can change for a fixed
   (plan, assumptions, seed, paths): the Monte Carlo version, the deterministic step it shares, the
   engine kind, and the return series. `projection_runs.engine_version` is at most 64 characters.
3. **Bands are per level, not per period.** `summary.bands` is seven `{ level, byYear[] }` in
   `PERCENTILE_LEVELS` order (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95); period `t` is
   `(index t, age summary.startAge + t, calendarYear summary.startYear + t)`, the deterministic
   engine's convention.

```ts
export function createMonteCarloRunner(options: {
  readonly series: ReturnSeries; // loadReturnSeries() once at boot; it verifies the pinned SHA-256
  readonly deadlineMs?: number;
}): MonteCarloRunner {
  const det = ENGINE_VERSION.slice(ENGINE_VERSION.lastIndexOf('/') + 1);
  // e.g. 'personalfi.montecarlo/1;det/1;bootstrap;cbdefda1752e' — 52 chars.
  const engineVersion = `${MONTE_CARLO_VERSION};det/${det};bootstrap;${options.series.sha256.slice(0, 12)}`;
  if (engineVersion.length > 64) throw new Error(`${engineVersion} exceeds engine_version's 64`);
  return {
    engineVersion,
    async run(request) {
      const { summary } = await runMonteCarloInWorker(
        {
          plan: request.plan,
          assumptions: request.assumptions,
          seed: BigInt.asIntN(64, request.seed), // same stream: prng seeds from asUintN(64, ·)
          paths: request.paths,
          engine: 'bootstrap',
          series: options.series,
        },
        options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs },
      );
      const [p5, p10, p25, p50, p75, p90, p95] = summary.bands; // PERCENTILE_LEVELS order
      if (summary.bands.length !== 7 || p50 === undefined) throw new Error('expected p5…p95');
      return {
        engineVersion,
        seed: BigInt.asUintN(64, summary.seed),
        paths: summary.paths,
        successProbability: summary.successProbability,
        periods: p50.byYear.map((median, t) => ({
          index: t,
          age: summary.startAge + t,
          calendarYear: summary.startYear + t,
          p5: p5!.byYear[t]!,
          p10: p10!.byYear[t]!,
          p25: p25!.byYear[t]!,
          p50: median,
          p75: p75!.byYear[t]!,
          p90: p90!.byYear[t]!,
          p95: p95!.byYear[t]!,
        })),
      };
    },
  };
}
```

The service re-checks what comes back before storing a byte (`checkedOutcome`: engine version, seed
and paths echoed; success a six-place decimal in [0, 1]; every band in the plan's currency and
ordered) and refuses a mismatch `planning.monte_carlo_outcome_mismatch`. If the series is absent at
boot (`planning.returns_series_unavailable`), bind `monteCarlo: null` — the service then refuses a
Monte Carlo request by name and the nightly baseline runs deterministic, recorded as such. Do not
substitute the lognormal engine silently; if it is ever chosen, it goes in `engineVersion`.

**Prerequisite:** `@ctx/planning`'s public surface does not yet export `runMonteCarloInWorker`,
`MONTE_CARLO_VERSION`, `MonteCarloRefused`, `loadReturnSeries` or `ReturnSeries` (`src/engine/index.ts`
has no worker-host line, and `data/returns/` is outside the package's `exports`). That is 4.5's
surface to add, or the adapter can live inside `@ctx/planning` once 4.5 lands.

### 10.3 Pins in `apps/api/test/phase3-registration.test.ts` (report only — not edited)

- line 195: `expect(PLANNING_EVENTS).toHaveLength(4)` → **6** (`ProjectionCompleted`, `GoalOffTrack`).
  Red today, from this WP's `events.ts`.
- `'module.planning registers the net-worth consumer, the 04:00 job and its schedule'` (292–315),
  once §10.1 lands: consumers 1 → **2** (`planning.net_worth@v1`, `planning.goal_pace@v1`); job kinds
  `[planning.net_worth_snapshot]` → **`[planning.net_worth_snapshot, planning.projection_refresh]`**;
  `jobs[1].concurrency` 1. The test's name should say so.

### 10.4 Already confirmed

`packages/db/test/migrate.test.ts` table list and 0022 attribution match the migration (§9). The
export registry's four deferrals are in the tree (§9).

---

## 11. Open items

1. **Outflow life events are not modelled.** WP 4.4's `ProjectionPlan` has no one-time-flow input,
   and `otherIncome` is refused negative at the boundary. A home purchase, college or sabbatical is
   stored, **not applied, and named** in every run's input (`lifeEvents.unapplied`, reason
   `outflow_not_modelled`); the digest includes that list, so the day the engine gains the input
   every such run misses the cache. The field needed: a signed, dated one-time flow on
   `ProjectionPlan` (e.g. `oneTimeFlows: { age, amount: Money }[]`), drawn down in the withdrawal
   order. `src/engine/**` is 4.5's.
2. **Seed range** (§10.2 item 1): reconciled in the adapter; 4.5's envelope and `prng.ts` comments
   calling `projection_runs.seed` a BIGINT should be corrected by 4.5.
3. **Path ceilings differ.** The service and 0022 accept up to 1,000,000 paths (08 §7.2's queued
   power-user run); 4.5's interactive envelope is 20,000 and throws `MonteCarloRefused`, which is not a
   `ProjectionRefused` — the refresh job would retry it and WP 4.8 would map it to 500. Either the
   adapter translates it to `planning.projection_paths_invalid`, or WP 4.8 maps
   `MonteCarloRefused` itself.
4. **Crypto is not passed to the Monte Carlo.** 4.5 supports `cryptoHolding` (07 §6.4); the port's
   request has no such field and the balances are per tax bucket, where a crypto exchange is
   `TAXABLE`. Adding it is a port field plus a bucket split in `derivedFromDay`.
5. **Goal pace follows a baseline recompute.** `GoalOffTrack` is evaluated on a baseline run's
   `ProjectionCompleted`; a cache hit announces nothing. With a new sealed day every night the
   baseline misses the cache nightly, so this is nightly in practice; a goal edit between two runs
   is evaluated at the next one.
6. **The refresh job's transaction spans the engine run** (one connection held for the ~1 s of a
   10,000-path run). The ordering lock `appendEvent` takes is held only for the insert. Acceptable at
   D6's one holder; revisit if the refresh fans out.
7. WP 4.8 maps `PROJECTION_REFUSAL_STATUS` (each code's status and family beside it, the `errors.ts`
   pattern) — no judgement needed at the route.
8. WP 4.5's red `invariants.test.ts` (invariant 3, 1.509% vs 1%) and its tsc/eslint errors are in
   flight on its side; nothing here depends on them.

---

## 12. Final re-run (2026-09-26 22:37, after the report was written)

- `pnpm exec tsc -b --noEmit`: one error, WP 4.5's `src/engine/worker-limits.test.ts(113)` (`"sustain"`
  vs `"wealth_at" | "sustain_to_plan_end"`). The earlier `prng.ts` errors have been fixed on 4.5's
  side. None in this WP's files.
- `vitest run --project planning --project planning-db --project db`: **168 passed, 1 failed** of
  169 in 34 files. The red is WP 4.5's new `src/engine/perf.test.ts` →
  `'10,000 paths over 40 years complete within 800 ms p95 on one core'` (the box was under load
  from the concurrent agents). 4.5's `invariants.test.ts` is green on this run. This WP's five files:
  **20 of 20 green**.
- eslint: the same 13 errors, all WP 4.5's (`data/returns/fetch.ts`,
  `src/engine/monte-carlo.worker.ts`). numeric boundaries: PASS, 758 files, 0 violations.
  schema ownership: ok, 103 claimed, 90 defined. prettier `--check` on every file this WP owns
  (the .sql has no prettier parser): clean.
- The sabotaged files re-hashed after the pass: `projection-service.ts`, `scenarios.ts`, `jobs.ts`
  all OK against their pre-sabotage SHA-256.
- WP 4.5's `worker-host.ts` changed on disk during this session; the diff touches nothing §10.2
  relies on (exports, seed envelope, `bands`, `startAge`/`startYear`, `successProbability`).
- `git diff --cached --name-only`: empty. No git state changed by this session.
