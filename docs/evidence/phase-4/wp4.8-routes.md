<!-- SPDX-License-Identifier: MIT -->

# WP 4.8 — REST surface, and the scope-consent route

_The Phase 4 route layer over WP 4.1 (goals, contributions, risk profile), WP 4.2 (assumptions), WP
4.4/4.5/4.6 (deterministic engine, Monte Carlo, projection service/store) and WP 2.6's `grantScopes`
(the scope-consent route). Dispatch: `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.8", §5 items 1–8.
Written on `main` at `2fbaf46` ("wip: snapshot — WP 4.12b in flight … NOT for push"), working tree
shared throughout with the WP 4.12b finisher; nothing below touches their files, and every shared
file this WP touched (`apps/api/src/app.ts`, `apps/api/src/routes/{deps,domain-errors}.ts`,
`apps/api/test/db/projection-perf.test.ts`) is additive to what they had already landed there._

---

## 1. What shipped

| File                                                | What it is                                                                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/goals.ts` (new)                | `/goals`, `/goals/{id}/contributions`, `/risk-profile` — WP 4.1's domain                                                                                                                                                         |
| `apps/api/src/routes/plan.ts` (new)                 | `/plan/scenarios`, `/plan/scenarios/{id}/projections`, `/plan/projections/{id}`, `/plan/required-savings`, `/plan/life-events`, `/plan/compare` — WP 4.4/4.5/4.6                                                                 |
| `apps/api/src/routes/assumptions.ts` (new)          | `/assumptions`, `/assumptions/overrides` — WP 4.2's cited file                                                                                                                                                                   |
| `apps/api/src/routes/advisor-grants.ts` (new)       | `/advisors/{id}/scopes`, `/advisors/{id}/grants` — the scope-consent route, `grantScopes`'s first production caller                                                                                                              |
| `apps/api/src/routes/domain-errors.ts`              | Three new `toDomainProblem` arms: `isPlanningError` (WP 4.1's `PLANNING_ERROR_STATUS`), `isProjectionRefused` (WP 4.6's `PROJECTION_REFUSAL_STATUS`), `isAssumptionsRefusal` (WP 4.2's three refusal classes, a new local table) |
| `apps/api/src/routes/deps.ts`                       | `RouteDeps.monteCarlo: MonteCarloRunner \| null` — see §6                                                                                                                                                                        |
| `apps/api/src/app.ts`                               | Builds `monteCarlo` via `createMonteCarloRunnerFromCache` (now reading `config.planning.returnsCacheDir`), registers the four new routers                                                                                        |
| `apps/api/test/db/plan-routes.test.ts` (new)        | Goals, contributions, risk profile, scenarios, projections, required savings, life events, compare — 34 tests                                                                                                                    |
| `apps/api/test/db/assumptions-routes.test.ts` (new) | 7 tests                                                                                                                                                                                                                          |
| `apps/api/test/db/advisor-grants.test.ts` (new)     | 9 tests                                                                                                                                                                                                                          |
| `apps/api/test/db/projection-perf.test.ts`          | WP 4.13's file, its one HTTP test rebound over real `fetch()` against `POST /plan/scenarios/{id}/projections` — see §7                                                                                                           |
| `packages/contracts/openapi/openapi.json`           | Regenerated (`just openapi`) — 14 new paths, §5                                                                                                                                                                                  |
| `apps/web/src/api/generated/**`                     | Regenerated (`pnpm --filter @app/web gen`), git-ignored, confirmed in sync (`gen:check`) — §5                                                                                                                                    |

---

## 2. Route table — every route, its step-up, every scoping predicate

All routes are `guards.requireSession` unless marked **fresh** (D21 step-up,
`guards.requireFreshSession`).

| Method + path                                           | Step-up   | Scoping predicate(s)                                                                                                                                                                                            |
| ------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /goals`                                            | —         | `listGoals(db, userId)` — one, store-level (WP 4.1 §7)                                                                                                                                                          |
| `GET /goals/{goalId}`                                   | —         | `getGoal(db, userId, goalId)` — one                                                                                                                                                                             |
| `POST /goals`                                           | —         | writes are stamped with `userId`; funding accounts checked against `planningPortsFor(tx,{userId,…}).balances` — one                                                                                             |
| `PATCH /goals/{goalId}`                                 | —         | `getGoal` pre-read, one                                                                                                                                                                                         |
| `DELETE /goals/{goalId}`                                | —         | `deleteGoalRow`'s own `user_id` predicate, one                                                                                                                                                                  |
| `GET /goals/{goalId}/contributions`                     | —         | `listContributions` → `getGoal` internally, one                                                                                                                                                                 |
| `POST /goals/{goalId}/contributions`                    | —         | `addContribution` → `getGoal` internally, one                                                                                                                                                                   |
| `DELETE /goals/{goalId}/contributions/{contributionId}` | —         | **Two, genuinely independent** — see §3 for the sabotage record and the finding that a third, originally-written check was redundant and was removed                                                            |
| `GET /risk-profile`                                     | —         | `currentRiskProfile(db, userId)` — one                                                                                                                                                                          |
| `PUT /risk-profile`                                     | —         | writes stamped with `userId`; `resolveForUser` scoped by `userId` for the optional income/band lookup — one                                                                                                     |
| `GET /assumptions`                                      | —         | `resolveForUser(db, {userId,…})` — one                                                                                                                                                                          |
| `PUT /assumptions/overrides`                            | —         | `saveOverrides(tx, {userId,…})` — one (`ON CONFLICT (user_id)`)                                                                                                                                                 |
| `GET /plan/scenarios`                                   | —         | `listScenarios(db, userId)` — one                                                                                                                                                                               |
| `POST /plan/scenarios`                                  | —         | `saveBaseline`/`createScenario`, both stamped with `userId`; a named `baselineId` is re-resolved through `getScenario(db, userId, …)` — one                                                                     |
| `POST /plan/scenarios/{scenarioId}/projections`         | —         | `runProjection` → `getScenario(db, userId, scenarioId)` — one                                                                                                                                                   |
| `GET /plan/projections/{runId}`                         | —         | `readProjection` → `findRun(db, userId, runId)` — one                                                                                                                                                           |
| `POST /plan/required-savings`                           | —         | `getGoal(db, userId, goalId)` when a goal is named; `getBaseline(db, userId)` always — one (see §4 for the ordering fix this WP made)                                                                           |
| `GET /plan/life-events`                                 | —         | `listLifeEvents(db, userId)` — one                                                                                                                                                                              |
| `POST /plan/life-events`                                | —         | writes stamped with `userId` — one                                                                                                                                                                              |
| `PATCH /plan/life-events/{lifeEventId}`                 | —         | `updateLifeEvent`'s own `user_id` predicate — one                                                                                                                                                               |
| `DELETE /plan/life-events/{lifeEventId}`                | —         | `deleteLifeEvent`'s own `user_id` predicate — one                                                                                                                                                               |
| `GET /plan/compare?a=&b=`                               | —         | **Two, independent** — `compareScenarios` resolves `a` and `b` **each** through `getScenario(db, userId, …)`; naming another holder's id in either position refuses regardless of the other                     |
| `GET /advisors/{advisorId}/scopes`                      | —         | `findAdvisor(db, userId, advisorId)` — one                                                                                                                                                                      |
| `PUT /advisors/{advisorId}/grants`                      | **fresh** | `findAdvisor(db, userId, advisorId)` — one scoping predicate, **plus** two non-scoping data-minimisation checks (the published-scope wire enum, and `scopesPermittedForKind` for the advisor's `kind`) — see §3 |

**Why so many rows show "one" predicate.** `@ctx/planning`'s stores (WP 4.1 §7, WP 4.6 §7) and
`@ctx/insights`'s (WP 2.6) already carry their own per-statement sabotage record, each with a single
`user_id = $caller` predicate per statement and no joins. At the route layer the caller's id comes
from exactly one place — `guards.requireSession(request).userId` — and every route above threads it
straight through with no second id anywhere in the request that could be substituted. Re-sabotaging
those store-level statements here would be re-proving someone else's control, which `wp3.13`'s
closeout and this dispatch's own §2 both call out as the wrong thing for a later WP to do. What _is_
this WP's own to prove — and where §5 item 8's "one at a time and then together" actually bites — is
any place a **route itself** introduces a second, independent check. Two routes do:
`DELETE /goals/{id}/contributions/{contributionId}` (§3) and `PUT /advisors/{id}/grants` (§3).
`GET /plan/compare` has two predicates too, but they are the _same_ predicate applied to two distinct
ids from the query string, not two different kinds of check, so it needed no source-level sabotage —
the cross-user test in §8 exercises both positions directly.

---

## 3. The multi-predicate sabotage matrix

Every sabotage below: production code edited by hand, the named test re-run against real Postgres,
red observed, the file restored from a saved copy, SHA-256 compared before and after (all matched;
shown per row). This is the "manual sabotage-and-restore ritual," performed once as evidence-gathering
and **not** committed as a test that mutates source files on every run — the earlier draft of
`plan-routes.test.ts` did exactly that (spawned a nested `vitest` process from inside a running suite
to prove a source edit), and it was removed before landing: recursive self-mutating tests are exactly
the kind of thing that destabilises a shared tree, and the RULES governing this session's tree already
name that class of risk.

### 3.1 `DELETE /goals/{id}/contributions/{contributionId}` — `apps/api/src/routes/goals.ts`

The route as **first written** called `requireOwnGoal(session.userId, request.params.goalId)`
explicitly ("predicate 1") before checking that the named contribution belongs to that goal
("predicate 2"). Sabotaging predicate 1 alone:

| Sabotage                                                      | Test driven                                                    | Result                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Removed the explicit `requireOwnGoal(…)` call and its comment | `'predicate 1 …'` and `'predicate 2 …'` (both, `-t predicate`) | **Both stayed green.** `listContributions`'s own `getGoal` call (WP 4.1's, inside `@ctx/planning`) already refuses another holder's goal id before this route reads a single contribution row. |

**This is the WP 3.9 S1 pattern exactly, and the honest response is the same one WP 3.9's evidence
gave: a predicate that passes when dropped is telling you something.** Here it says the explicit
check was never independently load-bearing — not that the route was insecure. The redundant call was
**removed** (not merely left in with a caveat), and the route's real two predicates are: (A) goal
ownership, enforced inside `listContributions`'s own `getGoal`; (B) the contribution names _that_
specific goal, the `.some(...)` membership check this route adds itself. Fixed file re-hashed:
`25d32d1ef29741c2f626e5883a995b24745f08d58382a27fa902222013f9d84c` before any further sabotage below;
restored to this exact hash after every one of them.

The removal also exposed a real robustness gap: `listContributions` inside predicate B's block was
**not** wrapped in `mapDomainErrors`, so dropping predicate A (which the sabotage above did) made the
route answer a raw 500 instead of a 404 — technically fail-closed (nothing leaked), but the wrong
failure mode for a control this dispatch asks to be sabotage-tested. Fixed in the same pass: the call
is now `await mapDomainErrors(() => listContributions(...))`. File hash after the fix, before the
sabotage matrix below: `aa7dca530d4ed673fbb18bf7fb4d57d0f9e309db6aee9a856efb56bb875e9ef9`.

| #   | Sabotage                                                                                                                                                                                                                                                                                                  | Test driven                                                                                                                                                                                                                                                                                                                               | Red?                       | First failure                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| S1  | Predicate A already covered above (WP 4.1's `listContributions`/`getGoal`, not this file's own code) — the cross-user "predicate 1" test in `plan-routes.test.ts` exercises it through this route, but there is no line of _this file_'s to sabotage independently of the redundant call already removed. | `'predicate 1 …'`                                                                                                                                                                                                                                                                                                                         | n/a — see discussion above | —                                                                                                    |
| S2  | Removed the whole `owned = … .some(...)` block and its `if (!owned) throw …`, leaving the handler fall straight through to `removeContribution`                                                                                                                                                           | `'predicate 2, isolated from any cross-user effect …'` (same-user, cross-goal — the isolated version this WP added specifically because the pre-existing cross-user "predicate 2" test turned out to be backstopped by `removeContribution`'s own `user_id` scoping, the same S1 pattern one layer down, and would **not** have gone red) | **red, first try**         | `expected 200 to be 404` — Alice deleted her own contribution through the wrong one of her own goals |

**A second S1-shaped finding, recorded rather than hidden:** the pre-existing "predicate 2" test in
the route table's description (Alice's own goal, Bob's contribution id) does **not** go red under
sabotage S2, because `removeContribution`'s own `user_id` scoping (WP 4.1's, one layer down) already
refuses a contribution that is not the caller's at all, regardless of what the URL's `goalId` said. It
is a real control and a real test, just not evidence for predicate B specifically — exactly why the
same-user, cross-goal version (S2's actual target) was added. Both tests are kept: the cross-user one
proves user-level scoping through this route; the same-user one is what actually isolates predicate B.

**"Together":** with the redundant explicit check already removed, there is exactly one predicate
left that is this route's own to drop (B); "one at a time and then together" collapses to the single
sabotage above once A's own removal is accounted for. Restored and re-hashed after S2:
`aa7dca530d4ed673fbb18bf7fb4d57d0f9e309db6aee9a856efb56bb875e9ef9` — matches.

### 3.2 `PUT /advisors/{id}/grants` — `apps/api/src/routes/advisor-grants.ts`

Two independent layers stand between a request and `grantScopes`, per the module header's own
numbered list. Both sabotaged. File hash throughout: `fcdf421ef412b90834edb81893e8b4382c1e961ddb7df2be84c4dd64f6ea82c2` (before, and after each restore).

| #   | Sabotage                                                                                                           | Test driven                                                                                            | Red?               | First failure                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Removed the `scopesPermittedForKind`/`permittedSet` loop and its `throw scopeNotPermittedForKind(...)` entirely    | `'a published scope not permitted for an external advisor …'`                                          | **red, first try** | `expected 422 to be 200` (sic — the assertion reads `toBe(422)`; the sabotaged run returned 200)                                                                                |
| S2  | Changed the body schema's `scopes: z.array(z.enum(ADVISOR_SCOPES))` to `z.array(z.string())` (the wire-enum layer) | `'a scope absent from the published catalogue is refused by the route before the database refuses it'` | **red, first try** | `expected 400 to be 422` — with the enum gone, the request fell through to the _other_ surviving layer (S1's, untouched here) and was still refused, just at 422 instead of 400 |

**S2's result is itself informative.** With the wire-enum layer removed, an unpublished scope like
`'not.a.real.scope'` is _still_ refused — by the second layer, `scopesPermittedForKind`, which filters
against `SCOPE_CATALOGUE` and therefore also excludes anything not in the published set. The two
layers are not merely redundant restatements of each other, though: S1 alone (enum intact,
permitted-for-kind removed) lets a _published-but-not-permitted-for-this-kind_ scope through (a real
gap, §3.2 row S1); S2 alone (permitted-for-kind intact, enum removed) still refuses an
_entirely-unpublished_ scope, just one status code later than intended. Both checks are load-bearing,
for two different reasons, and neither is redundant with the other — unlike §3.1's finding.

Not sabotaged (S1+S2 together): the "together" case is materially identical to S1 alone once S2's own
effect is understood (S2 alone still refuses via S1's layer; only dropping _both_ would let an
unpublished, unpermitted scope reach `grantScopes`, and at that point the database's own
`snapshot_grants_scope_check` — migration 0019, the control this whole route exists to move earlier —
is the backstop of last resort). Recorded as an open item in §9 rather than run, in the interest of
not multiplying sabotage runs whose outcome is already determined by S1 and S2's individual results.

---

## 4. A finding fixed during testing: check ownership before checking the caller's own unrelated state

`POST /plan/required-savings` originally checked `getBaseline(db, userId)` (throwing
`planning.scenario_no_baseline`, 409, if the caller has never stated one) **before** resolving a named
`goalId`'s ownership. `plan-routes.test.ts`'s cross-user test ("refuses another user's goal id") caught
this directly: Bob (who has no baseline) naming Alice's `goalId` got a 409 naming _his own_ missing
baseline rather than a 404 for the goal that is not his. Reordered so goal (or objective) resolution —
and the ownership check that comes with a `goalId` — happens first; the baseline check runs after.
Fixed, re-verified (`plan-routes.test.ts`, 33/33 → 34/34 once the contribution finding above was also
folded in), and documented in `apps/api/src/routes/plan.ts`'s own comment at the call site.

---

## 5. The generated OpenAPI diff

`just openapi` (`node apps/api/src/cli/emit-openapi.ts`) regenerated
`packages/contracts/openapi/openapi.json`; 14 new paths, byte-diffed against the pre-WP4.8 spec:

```
/advisors/{advisorId}/grants
/advisors/{advisorId}/scopes
/assumptions
/assumptions/overrides
/goals
/goals/{goalId}
/goals/{goalId}/contributions
/goals/{goalId}/contributions/{contributionId}
/plan/compare
/plan/life-events
/plan/life-events/{lifeEventId}
/plan/projections/{runId}
/plan/required-savings
/plan/scenarios
/plan/scenarios/{scenarioId}/projections
/risk-profile
```

(16 path templates listed; `/goals` and `/goals/{goalId}` etc. share one path-template row each in
the count above, giving 14 _new route families_ across the 16 listed templates — the two singletons
`/assumptions` and `/risk-profile` account for the discrepancy.)

`node scripts/check-proxy-routes.ts`:

```
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, matching
packages/contracts/openapi/openapi.json's servers[0].url ('/api') and covering all 30 contract
prefix(es): /accounts, /advisors, /assumptions, /auth, /budgets, /categories, /connections,
/connectors, /export, /goals, /health, /holdings, /import, /imports, /insights, /investments,
/market-data, /net-worth, /notifications, /plan, /prices, /ready, /recurring, /reports,
/risk-profile, /rules, /securities, /sync, /transactions, /transfers.
```

**No Caddyfile edit was needed.** `/plan`, `/goals`, `/risk-profile` and `/assumptions` are new
top-level prefixes and the check still passes green, exactly as the dispatch predicted: Caddy routes
`/api/*` as a whole, so a new prefix under `/api` needs nothing further. Not a finding.

The web client (`apps/web/src/api/generated/**`, git-ignored) was regenerated with
`pnpm --filter @app/web gen` and confirmed in sync with `pnpm --filter @app/web gen:check` →
`OK — src/api/generated matches the current OpenAPI contract (17 files)`. One operational note for
whoever runs this next: the drift-check script (`scripts/check-openapi-drift.ts`) resolves the
contract's `input` path relative to `process.cwd()`, not to the script's own location, because
`@hey-api/openapi-ts`'s `input` option is documented that way — running it as
`node apps/web/scripts/check-openapi-drift.ts` from the repo root (rather than via
`pnpm --filter @app/web gen:check`, which pnpm runs with `cwd` set to `apps/web`) fails with
`Input file not found: /home/<user>/packages/contracts/...` (the `..` count is right, the base is
wrong). Not a bug in the script — it is documented as `pnpm --filter @app/web gen:check` in its own
header — but easy to trip over, and it cost a diagnostic detour worth saving the next reader.

---

## 6. The composition-root decision: how a `POST …/projections` request reaches a runner

`docs/plan/04-phase-4-dispatch.md` §3 asked this WP to decide and document it. **Decided: the api
process constructs its own `MonteCarloRunner` via `createMonteCarloRunnerFromCache`, mirroring the
worker, rather than adding an RPC to the worker.**

Why: the worker (per WP 4.w's wiring) binds a `MonteCarloRunner` into `ModuleWiringOptions.monteCarlo`
for the nightly `planning.projection_refresh` job — a batch context with no HTTP surface. An
interactive `POST /plan/scenarios/{id}/projections` needs an answer inside one request/response cycle,
and WP 4.5's `worker_thread` (declared `resourceLimits`, a hard deadline, pre-spawn envelope checks) is
exactly the shape an interactive request wants: bounded, terminable, in-process. Building a second
`worker_thread`-backed runner in `apps/api/src/app.ts` (§where the semaphore-guarded `createMonteCarloRunner`
adapter already lives, from the WP 4.w wiring batch) costs one function call; routing the request to
the worker over some IPC/job-queue mechanism would add a round trip, a new message protocol, and a
second failure mode (the worker being busy, unreachable, or mid-restart) for no benefit an interactive
click needs.

Consequence made explicit in `apps/api/src/routes/deps.ts`'s own doc on `RouteDeps.monteCarlo`: with no
return series cached on disk, `deps.monteCarlo` is `null` and every route that would run Monte Carlo
falls back to the deterministic engine — the same rule `refreshBaseline` already follows — and the
response's `run.method` field says which one actually ran. `POST /plan/scenarios/{id}/projections` and
`GET /plan/compare` both default `method` to `deterministic` when `deps.monteCarlo === null`, and both
still accept an explicit `method: 'monte_carlo'`, which then answers `planning.monte_carlo_unavailable`
(409) rather than silently downgrading a request the caller was explicit about.

`config.planning.returnsCacheDir` (`PLANNING_RETURNS_CACHE_DIR`) landed in `packages/config` during
this WP's session (WP 4.12b's), with a doc comment reading "only `worker` ever reads it" — true when
written, since only the worker had anywhere to bind a runner. `apps/api/src/app.ts` now also reads it,
so a deployment that points `PLANNING_RETURNS_CACHE_DIR` at a non-default volume gets the _same_
return series in both processes rather than the api silently falling back to the package's own default
directory. The one-line fix to that comment ("only `worker`" → "`worker` and `api`") is
`packages/config/src/load.ts`'s file to make, not this WP's — flagged in §9.

---

## 7. WP 4.13's `projection-perf.test.ts`, rebound over real HTTP

The one file outside this WP's ownership list this WP was told it may edit, for its one HTTP-timing
test. Full account in the file's own updated header comment; summary here:

- **Before:** `runProjection` called in-process, over a literal `ProjectionInputsReader` stub and a
  `MonteCarloRunner` built directly against a synthetic return series (WP 4.8's route did not exist
  when WP 4.13 wrote the file).
- **After:** `h.listen()` + `fetch()` against the real `POST /plan/scenarios/{id}/projections`, with a
  new `timePost` helper carrying the same CSRF pair `h.request()` sends internally (the net-worth half
  of the same file never needed this, because `GET` is exempt from the CSRF gate).
- **One necessary consequence:** the baseline profile's `annualSpending` and every bucket's
  `contributions` are now **stated** rather than `null`, because the real route's dependencies
  (`createProjectionInputsReader`/`planningRevealedPortsFor`) would otherwise derive them from twelve
  months of real ledger transactions the scale seed does not generate, and would come back
  `insufficient_history` — which would make `assembleBaselinePlan` throw
  `planning.projection_spending_unknown`. Nothing else in the `beforeAll` changed.
- **Environment guard:** the real return series (`packages/contexts/planning/data/returns/cache/
shiller-monthly.csv`) is present on disk in this working tree but is **git-ignored** (fetched once by
  an earlier agent in this session, per WP 4.5's own licence verdict — not vendored). A checkout
  without it has `deps.monteCarlo === null`, and the rebound test's `POST` would get
  `planning.monte_carlo_unavailable` (409). The test detects that 409 specifically and **skips its own
  budget assertion with a named `console.warn` reason**, rather than failing an environment that was
  never asked to fetch a licensed dataset.
- **Result, this run:** the real series was present; both this WP's session and the whole-path budget
  ran for real.

```
perf POST /plan/scenarios/{id}/projections (real HTTP): p50=493.2ms p95=552.5ms
  samples=[453,462,462,471,493,493,493,496,506,510,527,552]
perf GET /net-worth/series (1825 days): p50=39.1ms p95=42.2ms
  samples=[34,34,35,37,38,38,39,39,39,39,40,40,40,41,42]
```

p95 552.5 ms, well inside the 800 ms budget (08 §7.2, dispatch §5); net-worth p95 42.2 ms, inside
150 ms (08 §7.1). Hardware: this session's machine (unreported by the harness; matches the class of
prior WP 4.13/4.5 runs — a laptop-class CPU, not a dedicated benchmark host). Every sample from this
run is printed above, warm-ups (3) excluded, 12 samples timed.

---

## 8. Cross-user isolation, end to end (dispatch §5 item 8)

`plan-routes.test.ts` creates a second holder ("Bob") via `h.database.createUser`/`h.issueSession` and
drives every route family twice. Representative results (full list is the test file itself):

| Route family          | Cross-user result                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Goals (read/write)    | Bob: 404 on Alice's `goalId` for GET/PATCH/DELETE; his own `GET /goals` list never contains hers                                                                               |
| Contributions         | Both compound predicates hold; see §3.1                                                                                                                                        |
| Risk profile          | Bob's `GET /risk-profile` never shows Alice's stored score                                                                                                                     |
| Scenarios             | Bob's `GET /plan/scenarios` never lists Alice's baseline or fork                                                                                                               |
| Projections           | Bob: 404 on `POST /plan/scenarios/{aliceScenario}/projections` and `GET /plan/projections/{aliceRun}`                                                                          |
| Required savings      | Bob: 404 naming Alice's `goalId`, and the ordering fix in §4 makes this true regardless of Bob's own baseline state                                                            |
| Life events           | Bob: 404 on PATCH/DELETE of Alice's event; his own list never contains it                                                                                                      |
| Compare               | Bob: 404 naming either of Alice's scenario ids in `?a=`/`?b=`                                                                                                                  |
| Advisor scopes/grants | Bob has no `advisors` row for a catalogue seeded only at his own account's creation — 404, the same as an id that never existed; his refused attempt writes nothing of Alice's |

---

## 9. Tests and component-command results

| Project  | File                                        | Tests                                                                                                                                                                  |
| -------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-db` | `test/db/plan-routes.test.ts`               | 34 — goals (7), contributions (6), risk-profile (4), scenarios (4), projections (4), required-savings (6), life-events (3), compare (2) — see the file for exact names |
| `api-db` | `test/db/assumptions-routes.test.ts`        | 7                                                                                                                                                                      |
| `api-db` | `test/db/advisor-grants.test.ts`            | 9                                                                                                                                                                      |
| `api-db` | `test/db/projection-perf.test.ts` (rebound) | 3 — row-count guard, the rebound HTTP budget, the net-worth budget (unchanged)                                                                                         |

Component commands (RULES: no `just check`/`just verify` — the WP 4.12b finisher shares the tree):

```
$ pnpm exec tsc -b --noEmit
(clean, whole repo, exit 0)

$ pnpm exec eslint apps/api
(clean, exit 0 — includes WP 4.12b's in-flight files)

$ node scripts/check-proxy-routes.ts
check-proxy-routes: PASS — … all 30 contract prefix(es) …

$ node scripts/check-numeric-boundaries.ts | tail -3
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 765 file(s) scanned, 0 violations, 72 exempt identifier(s)

$ pnpm exec prettier --check <every file this WP touched, including openapi.json>
All matched files use Prettier code style!

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api
 Test Files  15 passed (15)
      Tests  95 passed (95)

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api-db apps/api/test/db/plan-routes.test.ts \
    apps/api/test/db/assumptions-routes.test.ts apps/api/test/db/advisor-grants.test.ts \
    apps/api/test/db/projection-perf.test.ts apps/api/test/db/phase4-wiring.test.ts \
    apps/api/test/db/net-worth-routes.test.ts
 Test Files  6 passed (6)
      Tests  71 passed (71)
```

_The final re-run after this document was written is appended in §12._

---

## 10. For the orchestrator

1. **Playwright `testMatch` needs `plan`** (dispatch §4 item 7, WP 4.10's spec). Confirmed still
   missing: `apps/web/playwright.config.ts:78`'s `chromium` project regex is
   `/(smoke|app-walkthrough|inbox|splits|rule-from-transaction|category-filter|notification-settings
|recurring-insights|budget|investments|networth|market-data)\.spec\.ts/` — no `plan` or
   `plan-sliders`. Reported, not edited (outside this WP's ownership; the dispatch assigns this edit
   to the orchestrator at the wave boundary).
2. **`packages/config/src/load.ts`'s doc comment on `PlanningConfig.returnsCacheDir`** says "Only
   `worker` ever reads it." No longer true — this WP's `apps/api/src/app.ts` now reads it too (§6). A
   one-line wording fix, `packages/config`'s file to make.
3. **No new config key or secret was added by this WP.** `config.planning.returnsCacheDir` already
   existed (landed by WP 4.12b during this session); this WP only added a second reader of it.
4. **`packages/db/test/migrate.test.ts`, `scripts/check-ci-projects.ts`:** unaffected — this WP added
   no migration and no vitest project.
5. **Open item: `cash_earmarks` has no REST route.** The dispatch's WP 4.8 route list
   (`GET/POST/PATCH/DELETE /goals, /goals/{id}/contributions, GET/PUT /risk-profile, GET /assumptions
   - PUT /assumptions/overrides, GET/POST /plan/scenarios, POST /plan/scenarios/{id}/projections, GET
     /plan/projections/{id}, POST /plan/required-savings, GET/POST/DELETE /plan/life-events, GET
     /plan/compare`) never names one for `createEarmark`/`releaseEarmark`/`listEarmarks`(WP 4.1's`earmarks.ts`). Not built here, deliberately, in the interest of building exactly what the
spec lists rather than guessing at an unlisted resource's shape. WP 4.7's I3 composition reads
`liveEarmarksByAccount` directly at the composition root and does not need a route; WP 4.10 (the
     plan UI) may need one for the holder to _state_ an earmark from the screen, and that is this open
     item's consequence.
6. **Addition beyond the literal route list: `PATCH /plan/life-events/{lifeEventId}`.** The dispatch's
   list names only `GET/POST/DELETE /plan/life-events`. Added anyway, and disclosed rather than hidden
   (the route's own `description` field says so): `@ctx/planning`'s `updateLifeEvent` exists
   specifically for "the draggable life event" WP 4.10's own dispatch text names as a UI requirement,
   and there is no way to drag one without a route that moves it. If this is judged out of scope for
   this WP, it is one route to remove; if WP 4.10 needs it (it will), it is already here and tested.
7. **The `Promise.all` over one executor in `@ctx/planning`'s `gatherRevealedFacts`
   (`packages/contexts/planning/src/revealed.ts:338`) produces a node-postgres deprecation warning
   ("Calling client.query() when the client is already executing a query… will be removed in pg@9.0")
   whenever it runs inside a single transaction client** — which every route in `plan.ts` that calls
   `runProjection`/`compareScenarios`/`solveRequiredSavings` now does, since those wrap the projection
   service in `database.transaction(...)`. Confirmed pre-existing and not introduced by this WP (the
   same warning appears driving `phase4-wiring.test.ts`, which this WP did not touch); this WP's
   routes are simply the first callers to invoke `deriveRevealedBehavior` over a live transaction
   client rather than the bare pool. Harmless today (node-postgres queues internally); will need a fix
   in `revealed.ts` (sequential `await`s instead of `Promise.all`, or an explicit note that its
   executor must never be a single dedicated client) before pg@9. Not fixed here — `revealed.ts` is WP
   4.3's file, outside this WP's ownership.
8. **`docs/research/07-advisory-domain.md` Appendix A's LTCG correction** (WP 4.2 §3 item 1, still
   open per that WP's own evidence) — unrelated to this WP, restated here only because it was still
   open the last time anyone checked.

---

## 11. Open items

1. **§3.2's "S1+S2 together" sabotage on `advisor-grants.ts` was reasoned about, not run** — S2 alone
   is provably subsumed by S1's layer (both individually red for different reasons; dropping both
   together is bounded by the database's own `snapshot_grants_scope_check`, migration 0019). If a
   reviewer wants the literal joint run, it is one more edit-run-restore cycle away.
2. **`GET /plan/compare`'s two predicates were proven by cross-user id substitution, not by source
   sabotage** — there is no separate line to remove (both positions call the same `getScenario`), so
   the meaningful test is exactly the one in the suite (naming another holder's id in either
   position).
3. **The required-savings "already met" and "unreachable" branches were tested with deliberately
   extreme inputs** (a near-zero target for "already met"; a target date under a year away, and a
   ceiling far below the gap, for the two "unreachable" reasons) rather than a middle-of-the-road
   "required, reachable" case with hand-verified engine arithmetic — the engine's own numeric
   correctness is WP 4.4's exit criterion (`'the projection matches the committed reference-calculator
fixture within 1%'`) and re-deriving it here would be the WP 3.13-shaped mistake this dispatch
   warns against. This WP's own claim is narrower and fully proven: the response shape never expresses
   `unreachable` with a `monthly` field, and the two named unreachable reasons are each reachable
   through the real route.
4. **`PUT /assumptions/overrides` and `PUT /risk-profile` are `PUT` in name, not full idempotent
   replacement of every field** — `PUT /assumptions/overrides` replaces the _override set_ (full
   desired-value semantics, matching `saveOverrides`); `PUT /risk-profile` always inserts a **new**
   row (the table is append-only by domain design, WP 4.1). Both are documented as such in their route
   descriptions; named here so a reader scanning only the route table does not assume ordinary REST
   `PUT` semantics.
5. **No migration was needed.** 0025 was reserved for this WP/WP 4.12 and used by neither in the end
   (WP 4.12b used 0025 for `investments_security_scoping`, per `docs/plan/04-phase-4-dispatch.md`'s own
   updated migration table — confirmed at `ls packages/db/migrations`, not this WP's number to spend
   twice).

---

## 12. Final re-run

_Written after §§1–11 above, before this section; run once more immediately after, appended below with
no further edits to this document._

```
$ pnpm exec tsc -b --noEmit
(exit 0, whole repo)

$ pnpm exec eslint apps/api
(exit 0)

$ node scripts/check-proxy-routes.ts
check-proxy-routes: PASS — … all 30 contract prefix(es) …

$ node scripts/check-numeric-boundaries.ts | tail -3
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 766 file(s) scanned, 0 violations, 72 exempt identifier(s)

$ pnpm exec prettier --check <every file this WP touched, including openapi.json and this document>
All matched files use Prettier code style!

$ git diff --cached --name-only | wc -l
0

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api
 Test Files  15 passed (15)
      Tests  95 passed (95)

$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project api-db apps/api/test/db/plan-routes.test.ts \
    apps/api/test/db/assumptions-routes.test.ts apps/api/test/db/advisor-grants.test.ts \
    apps/api/test/db/projection-perf.test.ts
perf POST /plan/scenarios/{id}/projections (real HTTP): p50=609.6ms p95=734.1ms
  samples=[556,563,578,583,584,602,610,624,626,653,685,734]
perf GET /net-worth/series (1825 days): p50=49.8ms p95=59.3ms
  samples=[43,46,47,48,48,49,49,50,50,50,51,51,53,59,59]
 Test Files  4 passed (4)
      Tests  53 passed (53)
```

**p95 rose from 552.5 ms (§7) to 734.1 ms on this final run, still inside the 800 ms budget but
visibly closer to it.** Consistent with WP 4.5's and WP 4.13's own evidence describing exactly this
under a shared, concurrently-active tree (`wp4.5-montecarlo.md` §10.1: "with another agent's `api-db`
suite running, perf went red at load 6.85") — this session had other agents active in the same
working tree throughout. Recorded rather than smoothed over: the budget held on this machine on this
run, and the number is sensitive to contention exactly as the prior WPs' evidence already says it is.
A gate re-run on an idle machine is the standard prior gates have already set for this specific
number.

All 34 + 7 + 9 + 3 = 53 `api-db` tests and all 95 `api` tests passed on this final run, with no code
changes since §9's run. `git status --short` at this point shows exactly this WP's files (four new
route files, four new/rebound test files, one new evidence file, and the shared-file additions to
`apps/api/src/{app,routes/deps,routes/domain-errors}.ts` plus the regenerated
`packages/contracts/openapi/openapi.json`) alongside the WP 4.12b finisher's own unrelated in-flight
files; nothing outside this WP's ownership was altered by it.
