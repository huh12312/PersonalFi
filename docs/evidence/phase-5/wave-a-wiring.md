# Phase 5 — the W-A wiring batch (orchestrator-applied)

_05 §4 "Wiring batches": W-A, after Wave A. Applied by the orchestrator on 2026-09-30 01:30 EDT
against Wave A's landed packages (W-A0 `15941f6`, WP 5.2 `75a5dc6`, WP 5.13a `3432941`, WP 5.1
`de74437`, G4-22's route half `61ed5dc`, WP 5.13b `c4b608d`). Sources: WP 5.1's evidence §13 and
WP 5.2's §9._

## 1. What was wired

| #   | File                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                          | Source                                          |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | `apps/api/src/modules.ts`                                          | `ModuleWiringOptions` gains `advisorsEnabled: boolean`, `localModelConfigured: boolean`, `promptRenderer?: PromptRenderer`                                                                                                                                                                                                                                                                                      | wp5.1 §13                                       |
| 2   | `apps/api/src/modules.ts` `insightsModule`                         | `createRunSwitches` over `createFlagService({ db: platformExecutor(database), defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS], ttlMs: 0 })` — **uncached**, because the run watcher reads it once a second and the write barrier once more; the shared service's 30 s backstop would break "stops within two seconds"                                                                     | wp5.1 §13, `kill-switches.ts` `RunSwitches` doc |
| 3   | `apps/api/src/modules.ts` `insightsModule`                         | the two literals `advisorsEnabled: true, moduleEnabled: true` **deleted** from `settings` (Phase 4 gate G4-9 / C-7); `switches` and, when present, `promptRenderer` bound into `InsightsDependencies`                                                                                                                                                                                                           | wp5.1 §13                                       |
| 4   | `apps/api/src/modules.ts` `insightsModule`                         | `jobs: [...insightsJobs(...), createRunLocalJob(...)]` — `insights.run_local`, concurrency 1; the module table row updated                                                                                                                                                                                                                                                                                      | wp5.1 §13                                       |
| 5   | `apps/api/src/worker.ts`                                           | `createLocalModelAdapter(config.localModel, { logger, clock: systemClock })` built once per process when `config.localModel !== undefined`; a throw fails boot (a configured-but-broken model must not be a silently absent one); `advisorsEnabled: config.env.ADVISORS_ENABLED`, `localModelConfigured: config.localModel !== undefined`, `promptRenderer: localModel.promptRenderer` passed into `appModules` | wp5.1 §13, wp5.2 §9                             |
| 6   | `apps/api/package.json`, `pnpm-lock.yaml`, `THIRD_PARTY.md`        | `@advisor/local-model` as a workspace dependency of the api (commit `9ad99e5`); the api image rebuilt so `gate-image-closure.test.ts` sees the package in the pruned closure                                                                                                                                                                                                                                    | wp5.2 §10 item 7                                |
| 7   | seven test call sites of `appModules(...)` / `ModuleWiringOptions` | pass `advisorsEnabled: true, localModelConfigured: false` (the defaults the real worker reads from config)                                                                                                                                                                                                                                                                                                      | —                                               |
| 8   | `apps/api/test/phase3-registration.test.ts`                        | new: `'module.insights registers the insights.run_local lane (concurrency 1) beside insights.run and insights.run_all'`, and that without the advisor token secret the module still registers nothing                                                                                                                                                                                                           | —                                               |

`app.ts` needed nothing: the api process never executes a local model (`POST /advisors/run` queues
it) and its route builds its own switches (`runSwitchesOf(deps)`, WP 5.1). `assertPoolCoversLeases`
needed no formula change: `insights.run_local` is a job kind, not a consumer, and WP 5.1's
`local-lane.test.ts` proves the lane holds no connection across the model call.

## 2. What is deliberately not wired yet (W-C, Wave D)

The narrator itself (WP 5.3's `local_model` advisor registered in `insightsModule` only when
`LOCAL_MODEL_ENDPOINT` and `LOCAL_MODEL_DIGEST` are both set), the `insights.brief` job, the
`insights.weekly_brief` schedule, the health score, the outcome check, `RetirementImpactPort`, and
`apps/api/test/db/phase5-wiring.test.ts` driving all of it through the real pump with a fake Ollama
killed at each level. Until W-C, a configured model is bound and ready and no advisor uses it.

## 3. Verification

- `pnpm run typecheck`: clean (after the seven call sites).
- `apps/api/test/gate-image-closure.test.ts`: red first (`pruned out of the image but required at
runtime: packages/advisors/local-model`) against the image built before the dependency; green
  after `docker compose build api` — the Dockerfile computes the kept projects from
  `pnpm list --filter '@app/api...'`, so nothing in it changed.
- `api-db`: `phase2-wiring`, `phase3-wiring`, `phase4-wiring`, `categorization-wiring`,
  `phase1-seed-e2e`, `onramp-spending-e2e`, `insights-routes` — 37 tests green after the edits.
- `just verify` on 2026-09-30 01:55 EDT: typecheck, lint, every vitest project and migration test,
  gitleaks over the whole history, the licence gate and the compose hardening self-test **all green**;
  the run then stopped at `check-secret-ownership`, which is **host state, not code**: this host's
  `secrets/age_recipient` is `10002:10002 0400` where the check wants `{10001, 10002} 0440` — the
  Phase 4 gate's C-16 hand item (`sudo just harden-secrets`), open since WP 4.12b. The two steps
  after it were run by hand: `just trivyignore-check` clean; the trivy filesystem scan found **one
  HIGH** unrelated to this batch — `nodemailer` 10.0.2, GHSA-v53p-9fqp-m79j (quadratic backtracking in
  the address parser), fixed in 10.0.6 — handled in its own commit (see the execution log).

## 4. Sabotage

- The `ttlMs: 0` removed → the wiring still typechecks and every test above stays green, because
  nothing at the composition root measures time-to-stop; the control that catches it is WP 5.1's
  `kill-ladder.test.ts` against a `RunSwitches` built the same way, and W-C's `phase5-wiring.test.ts`
  (a fake Ollama killed at each level through the real runner) is the test that will catch it here.
  Recorded as the gap it is: **the composition root's cache setting is proved only by inspection until
  W-C lands.**
