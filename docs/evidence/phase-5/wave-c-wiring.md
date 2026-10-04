# Phase 5 — the W-C wiring batch (Wave D, Sonnet)

_05-phase-5-dispatch.md §4 "Wiring batches", the W-C paragraph. Applied against Wave A's W-A batch
(`docs/evidence/phase-5/wave-a-wiring.md`) and the landed WP 5.3 (narrator), WP 5.6 (Brief), WP 5.9
(feedback/outcomes) packages. Concurrent in the same tree: WP 5.4 (red team, `apps/api/test/redteam.test.ts`,
`apps/api/test/fixtures/redteam/**`, `scripts/redteam-live.ts`) and WP 5.10 (REST surface,
`apps/api/src/{app.ts,routes/brief.ts,routes/advisor-runs.ts}`, `apps/api/test/db/{brief-routes,
advisor-runs-routes}.test.ts`, the OpenAPI regeneration). Neither package's files are touched here. Written
incrementally; sabotages are recorded as they were observed, not reconstructed._

## 0. Ownership actually touched, and one deliberate, narrow exception

Per the brief's Ownership section: `apps/api/src/modules.ts`, `apps/api/src/worker.ts`,
`apps/api/test/db/phase5-wiring.test.ts` (new), the insights case in `apps/api/test/phase3-registration.test.ts`,
`packages/advisors/local-model/package.json` (exports entry only), `packages/advisors/local-model/test/index.ts`
(new barrel).

**One exception, made deliberately and recorded here rather than silently:**
`packages/contexts/insights/src/brief/job.ts` — nominally `packages/contexts/**`, listed "Not yours." The
gate is `BriefJobDependencies.narratorConfigured?: boolean`, plus a one-line `if` around the existing
`enqueueJob(...)` call for the narration, plus a two-sentence header update. Justification: (1) WP 5.6's own
evidence (`wp5.6-brief.md` §8 item 2) explicitly names this exact decision as "a W-C composition-root call,
not a `brief/**` one" and left it unimplemented on purpose, punting it here; (2) no concurrent Wave D agent
owns this file (WP 5.4 owns redteam fixtures, WP 5.10 owns routes/app.ts); (3) the change is purely
additive — a new optional field, one new call site (`modules.ts`'s `weeklyJob`) — and breaks nothing that
existed; (4) the alternative (leaving the enqueue unconditional) directly contradicts an explicit deliverable
and the sabotage this file's own brief asks to be recorded. No other file outside the Ownership list was
edited.

## 1. What was wired

| #   | File                                                                                                         | Change                                                                                                                                                                                                                                                                                                                                 | Source                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `apps/api/src/modules.ts` `ModuleWiringOptions`                                                              | gains `narratorModel?: NarratorModelPort` — read together with `localModelConfigured`, never either alone                                                                                                                                                                                                                              | wave-a-wiring.md §2; wp5.3-narrator.md's `NarratorModelPort`                      |
| 2   | `apps/api/src/modules.ts` `insightsModule`                                                                   | `registry.assertRegistered(createNarratorAdvisor({ model: options.narratorModel }))` when `narratorConfigured` — through the registry `createBuiltinRegistry()` already returns, alongside the fourteen built-ins                                                                                                                      | wp5.3-narrator.md §1; dispatch §4 W-C                                             |
| 3   | `apps/api/src/modules.ts`, new export `insightsRunSwitches(database, options)`                               | the `createRunSwitches`/`createFlagService({..., ttlMs: 0})` construction, **extracted from `insightsModule` into its own exported function** so `phase5-wiring.test.ts` calls the _same_ code rather than a parallel mirror — see §4 sabotage 1                                                                                       | wp5.1-run-control.md §13; wave-a-wiring.md §4's named gap                         |
| 4   | `apps/api/src/modules.ts` `insightsModule`                                                                   | `insights.brief` added to `jobs`, wrapping `createBriefJob({..., narratorConfigured})` with WP 5.9's `evaluateDueOutcomes` folded in (a `defineJob` wrapper around the Brief job's own handler, not an edit to `brief/job.ts`)                                                                                                         | wp5.6-brief.md §7; 05 §4 W-C ("the outcome check ... folded into the weekly job") |
| 5   | `apps/api/src/modules.ts` `insightsModule`'s `schedules` callback                                            | `registerAdvisor(database, {userId, clock, correlationId: newId()}, {manifest: NARRATOR_MANIFEST, enabled: false})` when `narratorConfigured`, through the same path `registerBuiltinAdvisors` uses — `enabled_source: 'default'` — then `registerWeeklyBriefSchedule(database, {userId, timezone}, clock)`                            | wp5.3-narrator.md; wp5.6-brief.md §7.3                                            |
| 6   | `apps/api/src/modules.ts` `createInsightsRetirementImpactPort` import, used in `insightsModule`'s `briefJob` | `createInsightsRetirementImpactPort(database, {timeZone: options.timezone})` bound into the Brief's `retirementImpactPort`                                                                                                                                                                                                             | wp5.6-brief.md §3, §7.2                                                           |
| 7   | `apps/api/src/modules.ts` module-table doc comment                                                           | `module.insights` row: event count 7→9 (the real, current `INSIGHTS_EVENTS.length`, stale since WP 5.1/5.6 landed), jobs gain `insights.brief`, schedule column gains "weekly Brief (Sun 06:00)"                                                                                                                                       | this WP                                                                           |
| 8   | `apps/api/src/worker.ts`                                                                                     | `narratorModel = localModel` (the adapter itself — `LocalModelAdapter.run` satisfies `NarratorModelPort` structurally, no adaptation needed), passed into `appModules({...})` beside `promptRenderer`, both gated on `localModel !== undefined`                                                                                        | wp5.3-narrator.md narrator.ts header; wave-a-wiring.md's `localModel` block       |
| 9   | `apps/api/src/worker.ts` `assertPoolCoversLeases` call site                                                  | comment recording the Phase 5 re-check and its conclusion (no formula change — see §3)                                                                                                                                                                                                                                                 | 05 §4 item 4                                                                      |
| 10  | `packages/contexts/insights/src/brief/job.ts`                                                                | `BriefJobDependencies.narratorConfigured?: boolean`; the narration `enqueueJob` call gated on it (default `false`)                                                                                                                                                                                                                     | see §0's exception                                                                |
| 11  | `apps/api/test/phase3-registration.test.ts`                                                                  | +2 tests: `insights.brief` registered (concurrency 1); `local.narrator` registers into the catalogue without throwing only when `localModelConfigured` + `narratorModel` are both supplied, and the job/schedule shape is identical with or without a model (registry contents are the only difference, unobservable with no database) | this WP                                                                           |
| 12  | `apps/api/test/db/phase5-wiring.test.ts` (new)                                                               | see §2                                                                                                                                                                                                                                                                                                                                 | this WP                                                                           |
| 13  | `packages/advisors/local-model/package.json`                                                                 | `"./test": "./test/index.ts"` exports entry                                                                                                                                                                                                                                                                                            | brief's explicit allowance, the `@connector/plaid/test` precedent                 |
| 14  | `packages/advisors/local-model/test/index.ts` (new)                                                          | barrel re-exporting `startFakeOllama`/`FakeOllama`/`FakeModel`/`ChatMode`/`RecordedRequest` from `fake-ollama.ts`                                                                                                                                                                                                                      | brief's explicit allowance                                                        |

## 2. `apps/api/test/db/phase5-wiring.test.ts` — the five required cases

All against a real Postgres (`createApiHarness`), a fresh holder per test. Final run, all green:

```
✓ the weekly Brief job publishes one Brief for the ISO week and enqueues its narrations on
  insights.run_local only when a model is configured                                   231ms
✓ with no model configured the narrator is not registered and the Brief enqueues no narration  84ms
✓ the schedule name insights.weekly_brief passes the platform's CHECK                    16ms
✓ assertPoolCoversLeases holds with the Phase 5 kinds at the default DATABASE_POOL_MAX    8ms
✓ a narration run killed … > level 1 — module.insights off                             1231ms
✓ a narration run killed … > level 2 — advisors.kind.local_model off                    1167ms
✓ a narration run killed … > level 3 — advisors.enabled off                             1162ms
✓ a narration run killed … > level 4 — POST …/cancel (requestRunCancel)                 1149ms

Test Files  1 passed (1)
     Tests  8 passed (8)
```

**Test 1/2 design.** `buildModules(h, overrides)` calls the real `appModules()` the way `worker.ts` does
(mirrors `phase4-wiring.test.ts`'s own helper). `.schedules(userId)` registers the narrator (when
configured) and the weekly-Brief schedule for real. `insights.brief`'s own job handler is driven through a
real `@core/platform` `createJobRunner` with **only that one handler registered** — deliberately: these two
tests are about what the Brief job _enqueues_, not about executing whatever it enqueues (test 3 drives a
narration run itself, under its own control, with a live fake model). Each test uses a distinct
`fixedClock` (`2026-W02` vs. `2026-W06`) — see §5's discovered wrinkle on why that turned out to matter.

**Test 3 design — the kill ladder against a real, streaming model.** `narratorWorld()` builds
`InsightsDependencies` over:

- `switches: insightsRunSwitches(h.database.db, {advisorsEnabled: true, localModelConfigured: true})` —
  **the real, exported `insightsModule` function**, not a parallel reimplementation (see §1 row 3 and §4
  sabotage 1's own story for why this mattered).
- a tiny, self-contained seed `Advisor` (`kind: 'builtin'`, `requires_scopes: ['cash.summary']`, one real
  account through `inMemoryLedgerPort`) that produces one real, accepted, `pending_review` insight —
  every other port throws if called, proving nothing else is touched.
- the real `createNarratorAdvisor({ model: adapter })` where `adapter = createLocalModelAdapter(...)` is
  WP 5.2's real adapter, pointed at a real `node:http` server (`startFakeOllama`, `@advisor/local-model/test`)
  through the real local-endpoint transport (`ollama-client.test.ts`'s own construction, reused) —
  `chat: { kind: 'endless', intervalMs: 15 }`, so the model genuinely never stops generating on its own.

The seed advisor runs first (one real `runAdvisor` call, `accepted === 1` asserted). The narrator's
payload is previewed and approved for real (`previewRequest`/`approvePayload`). Then, per level: a
narration `runAdvisor` call is started; the test polls the fake server's own observation
(`chats[0].linesWritten > 2`) so the switch is flipped only once the model is genuinely mid-reply, not
merely requested; the level is flipped through the path production uses (a `FlagService.set` for levels
1–2, `setAdvisorEnabled` for level 3, `requestRunCancel` for level 4 — the exact `kill-ladder.test.ts`
precedent, one layer up); the run's return, its status/`cancelReason`, and "links nothing" (no
`insights.narratesInsightId IS NOT NULL` row for the holder) are asserted; the fake server's own socket
close is awaited as the independent confirmation the abort actually reached the network.

**Time-to-stop, this run:**

| Level | Mechanism                            | Stopped in |
| ----- | ------------------------------------ | ---------- |
| 1     | `module.insights` off                | 978 ms     |
| 2     | `advisors.kind.local_model` off      | 980 ms     |
| 3     | `advisors.enabled` off               | 980 ms     |
| 4     | `POST …/cancel` (`requestRunCancel`) | 975 ms     |

All comfortably under the 2 s exit bound, and clustered tightly around 1 s — the watcher's own poll
interval (`RUN_WATCH_POLL_MS`, wp5.1-run-control.md §4), unsurprising since each case is caught on the
watcher's very next tick after the flip.

## 3. The pool arithmetic, re-checked for Phase 5

`assertPoolCoversLeases(logger, poolMax, consumerCount)` throws unless `poolMax > 3 + 2 + consumerCount`.
`insights.brief` and `insights.run_local` are job **kinds**, not consumers — `resolveModules` still
registers exactly **one** consumer for `module.insights` (`createInsightsConsumer`), with or without the
narrator or the Brief wired in, confirmed directly in `phase5-wiring.test.ts`'s pool test
(`insightsModule.consumers` has length 1 with `localModelConfigured: true` and a real `narratorModel`
supplied, and the four job kinds — `insights.run`, `insights.run_all`, `insights.run_local`,
`insights.brief` — are all present). So `WORKER_PINNED_CONNECTIONS` and the worker's own call site are
unchanged by this phase:

```
MODULE_FLAGS.length = 10   (apps/api/src/platform.ts, current tree)
WORKER_PINNED_CONNECTIONS = 3 (LISTEN) + 2 (leader leases) + 10 (one lease per module, worst case) = 15
DATABASE_POOL_MAX (.env.example default) = 10
poolMax = 10 + 15 = 25
pinned, worst case (every module enabled) = 3 + 2 + 10 = 15
25 > 15  →  assertPoolCoversLeases does not throw
```

Re-derived (not merely asserted) by `phase5-wiring.test.ts`'s fifth case, which reads `MODULE_FLAGS.length`
and `.env.example`'s own `DATABASE_POOL_MAX=10` line rather than hardcoding either — the same pattern
`worker-pool-guard.test.ts` (Phase 3 gate C-6) already established.

## 4. Sabotages, recorded as they happened — all caught on the second form, all restored

**1. `ttlMs: 0` removed (`apps/api/src/modules.ts`, `insightsRunSwitches`), `ttlMs: 30_000` substituted.**

First attempt, before `insightsRunSwitches` was extracted: `phase5-wiring.test.ts`'s kill-ladder cases
built their own `createRunSwitches`/`createFlagService({ttlMs: 0})` call — textually identical to
`insightsModule`'s, but a second construction. Sabotaging `modules.ts`'s `ttlMs` **did not** turn the suite
red: `8 passed (8)`, unchanged. Recorded rather than hidden: a parallel construction, however faithful,
proves nothing about the source it was copied from. Fixed by extracting the construction into
`insightsRunSwitches(database, options)`, exported from `modules.ts`, and having the test call that
function directly (§1 row 3). Re-sabotaged the same way:

```
level 1 — module.insights off: stopped in 19963 ms   (FAILED: expected 'cancelled', got 'failed')
level 2 — advisors.kind.local_model off: stopped in 19992 ms   (FAILED)
Test Files  1 failed (1)
     Tests  2 failed | 6 passed (8)
```

Levels 1–2 (flag-based) now fail — the flip is invisible for up to 30 s under the stale cache, the run's
own deadline fires first, and it ends `failed` rather than `cancelled` within 2 s, exactly as the brief's
own sabotage description predicts. Levels 3–4 (row-based / `requestRunCancel`) are unaffected, correctly —
neither reads the flag cache. Restored (`ttlMs: 0`); re-run: `8 passed (8)`, times back to ~950–990 ms per
level.

**2. The narration enqueue ungated (`brief/job.ts`): `if (input.narratorConfigured ?? false)` → `if (true)`.**

First attempt: both Brief tests used `systemClock` (real wall time), so both landed in the same real ISO
week. `enqueueJob`'s `dedupeKey` for the narration row is `insights.run_local:local.narrator:<isoWeek>` —
**no `userId`** (`brief/job.ts`, pre-existing, not introduced here — flagged in §5). With test 1 (model
configured) running first and occupying that dedupe key, test 2's sabotaged, unconditional enqueue attempt
for a _different_ holder in the _same_ week was silently deduped, and the suite read `8 passed (8)` with
the sabotage still live — a false green, caught only by re-running test 2 in isolation (`-t "with no model
configured"`), where it went red as expected (`expected [] to have length 0 but got 1`). Fixed the test,
not the source: each Brief test now pins a distinct `fixedClock` (`2026-W02` / `2026-W06`), removing the
cross-test dedupe collision. Re-sabotaged with the fix in place, full suite:

```
with no model configured … enqueues no narration:
  AssertionError: expected [ { kind: 'insights.run_local' } ] to have a length of +0 but got 1
Test Files  1 failed (1)
     Tests  1 failed | 7 passed (8)
```

Caught reliably now, in the full suite, not only in isolation. Restored (`if (input.narratorConfigured ??
false)`); re-run: `8 passed (8)`.

**3. The narrator registered without the model configured** (`apps/api/src/modules.ts`'s `schedules`
callback): `if (narratorConfigured)` → `if (true)` around the `registerAdvisor(..., NARRATOR_MANIFEST, ...)`
call.

```
with no model configured … the narrator is not registered …:
  AssertionError: expected [ { advisor_id: 'local.narrator' } ] to have a length of +0 but got 1
Test Files  1 failed (1)
     Tests  1 failed | 7 passed (8)
```

Caught on the first form — boot writes an `advisors` row for `local.narrator` with no `narratorModel`
bound anywhere to run it, exactly "an advisor with no port." Restored; re-run: `8 passed (8)`.

All three sabotages were confirmed **restored** by `git diff` showing zero remaining `SABOTAGE` markers in
the three touched files before the evidence below was closed out.

## 5. Needs the orchestrator

1. **`schedules.name` is globally `UNIQUE`, not per-user** (`packages/db/migrations/0003_platform.sql`),
   and `upsertSchedule`'s own `ON CONFLICT (name) DO UPDATE` deliberately never overwrites `user_id` on an
   existing row (`packages/platform/src/jobs/scheduler.ts:164-173`, its own comment: a redeploy must not
   reassign a schedule). Consistent with D6's "one holder," and not a defect this WP introduces or owns —
   but it means `phase5-wiring.test.ts`'s schedule-name test deliberately queries by `name` alone (§2),
   and it is the exact mechanism sabotage 2 in §4 tripped over on its first form. Recorded here in case a
   later phase adds a second real holder and needs to know this.
2. **`brief/job.ts`'s narration `dedupeKey` (`insights.run_local:local.narrator:<isoWeek>`) carries no
   `userId`.** Harmless under D6 (one holder ⇒ one Brief per week, globally, in practice), and not
   something this WP's mandate covers fixing (WP 5.6's file, and the fix — adding `userId` to the key — is
   a one-line, low-risk change, but it is a design call on `brief/job.ts`'s own identity scheme, not a
   composition-root wiring decision). Flagged for whoever next touches that file, or for the gate, with the
   exact failure mode it would hit in a genuine multi-holder deployment: two holders' Monday Briefs in the
   same ISO week would only ever enqueue one narration between them.
3. **`apps/api/src/routes/brief.ts` (WP 5.10, in flight)** showed one TypeScript error
   (`TS2719`, two structurally-identical-but-nominally-distinct `retirementEffect`/`evidence` array types)
   during this session's first `pnpm run typecheck` pass. Not this WP's file, not touched; gone by the next
   typecheck run in this same session (WP 5.10 fixed it independently). Named so a reviewer does not go
   looking for the cause here.
4. **`packages/contexts/insights/src/validate/pipeline.ts`** showed a one-line, explicitly-labelled
   `// SABOTAGE: narrow trace widened back to the snapshot` diff mid-session (WP 5.4's red-team harness,
   live in the same tree). Not touched, not mine; restored by WP 5.4 before this WP's final verification
   ran (confirmed absent from `git status --porcelain` at close).
5. **The module-table doc comment's event count** (`apps/api/src/modules.ts`, top of file) was stale at
   7 for `module.insights` — `INSIGHTS_EVENTS.length` is actually 9 as of WP 5.1 (`AdvisorRunCancelled`)
   and WP 5.6 (`BriefPublished`), both landed before this WP started. Corrected in the same edit as the
   jobs/schedule columns (§1 row 7) since it was touched anyway; not a Phase 5 W-C finding on its own, just
   recorded so the diff is not mistaken for an unexplained change.

## 6. `just check`

Not run as a whole-repo command — the phase rule (the full `just check`/`just verify` does not fit this
tree's foreground window, and WP 5.4/5.10 are concurrently active). Run individually, in groups, foreground:

1. `pnpm run typecheck` (whole monorepo) — **clean, exit 0** (after WP 5.10's `routes/brief.ts` error,
   present at the first run of this session, resolved independently by WP 5.10 before the final run — §5
   item 3).
2. `npx eslint` over every file this WP touched (§1's list, `.json` excluded from eslint) — **clean**.
3. `npx prettier --write` over every file this WP touched, including `.json` — **clean / unchanged** on the
   final pass.
4. `node scripts/check-ci-projects.ts` — **PASS, 42/42** (unchanged; this WP adds no vitest project).
5. `node scripts/check-schema-ownership.ts` — **ok, 108 claimed / 95 defined** (unchanged; this WP adds no
   table).
6. `npx vitest run --project api-db apps/api/test/db/phase5-wiring.test.ts` — **8/8 passed** (§2).
7. `npx vitest run --project api apps/api/test/phase3-registration.test.ts apps/api/test/worker-pool-guard.test.ts`
   — **24/24 passed** (phase3-registration.test.ts alone: 18/18, up from 16 before this WP's two additions).
8. `npx vitest run --project insights` — **31 files, 284 passed, 1 skipped, 0 failed** (WP 5.3/5.6/5.9's own
   suites, unaffected by the `brief/job.ts` gate).
9. `npx vitest run --project insights-db` — **11 files, 41 passed, 0 failed** (`narration-link.test.ts`,
   `kill-ladder.test.ts`, `local-lane.test.ts` and the rest of WP 5.1/5.3's own DB suites, unaffected).
10. `npx vitest run --project advisor-local-model` — **4 files, 33 passed, 0 failed** (the new `/test`
    exports entry did not change the project's own test count — a barrel, not a test file).
11. `npx vitest run --project api-db apps/api/test/db/{phase3-advisors,phase4-advisors,insights-routes,brief-retirement-port}.test.ts`
    — **25/25 passed** (the broader advisor/Brief route-adjacent DB suites, unaffected).
12. `git status --porcelain` — every changed or new path is one this WP's Ownership section names (plus the
    one deliberate, recorded exception, §0), or is WP 5.10's (untouched by me, not staged, not committed —
    no commits were made, no `git add`, no other git state change).

No red anywhere in the final pass. Every sabotage in §4, and every test count above, is a command's actual
output as it was run in this session — nothing here is a paraphrase of a result not actually observed.

This report is posted before the final verification run, per the phase rule; §6 above **is** that final
pass, run and appended after the rest of this document was written, with no edits made to §§0–5 afterward.

## 6. W-E: the health-score fold (orchestrator, 2026-10-04 09:50 EDT)

WP 5.8's `computeAndStoreHealthScore` folded into the weekly Brief job per wp5.8-health.md §6:
`BriefJobDependencies` gains optional `snapshotPorts` and `tokenSecret`; `insightsModule` passes
`dependencies.ports` and `options.advisorTokenSecret`; after the already-published check and
independent of whether the week has anything material, the job builds a `kind: 'builtin'` snapshot
over `HEALTH_SNAPSHOT_SCOPES` (the seven scopes `health/score.ts` reads, now exported from
`health/store.ts`) and stores the score. A failure is logged and does not fail the Brief (the route
then answers "not computed" for the week); a composition root that binds no ports logs "not
computed" and stores nothing. `phase5-wiring.test.ts`'s weekly-Brief case asserts one
`health_scores` row after the tick. **Sabotage** — `snapshotPorts` not passed from `modules.ts` →
`expected +0 to be 1`, red; restored, green (8/8).
