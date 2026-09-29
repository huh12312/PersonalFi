# WP 5.1 — Advisor run control (the serial gate)

_Agent: backend-architect (Opus). Branch `main`, base `691ba33` (WP 5.13a's wip snapshot, not this
package's). Written incrementally; sabotages are recorded as they are observed._

Scope: 05-phase-5-dispatch.md §3 WP 5.1; Phase 4 gate conditions **C-7** (G4-9) and the run-path /
grants half of **C-12** (G4-17, G4-22). The screen half of C-12 (G4-18) is WP 5.12's.

## 0. Log

| Time (local)     | Step                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-29 17:49 | Start. Load average 3.27 / 1.95 / 0.92 (WP 5.2 and WP 5.13a in flight in the same tree).                                                                          |
| 17:50            | **C-7 reproduced red** against the unmodified tree (`691ba33` + only the new test): §2.                                                                           |
| 17:58            | **`enabled_source` defect reproduced red** against the unmodified store: §7.                                                                                      |
| 18:00            | Migration 0028 written; `migrate.test.ts` (list + attribution), export registry and `OWNERSHIP.md` in the same change; `db` project 10/10.                        |
| 18:05            | C-7 green (route suite 11/11).                                                                                                                                    |
| 18:07            | `insights-db` 18/18 with `enabled_source`; `insights` 231/231 unchanged.                                                                                          |
| 18:09–18:26      | Kill ladder, lane, breaker, preview suites written; ten sabotages, all red on the first try (§5).                                                                 |
| 18:20            | G4-17 red twice (rank, then grants) and green (§8).                                                                                                               |
| 18:21            | Neighbouring `api-db` suites (export-import, phase2/3/4 wiring, phase3/4 advisors, advisor-grants, cold install, pending-review) 48/48 at load 7.76; `api` 96/96. |

## 1. Migration 0028 and what it touches

`packages/db/migrations/0028_advisor_run_control.sql` — exactly 05 §4's row; references only
0012-era objects (`advisors`, `advisor_runs`, `users`) or its own:

- `advisors.enabled_source TEXT NOT NULL DEFAULT 'default'` + `advisors_enabled_source_check`
  (`default | user | feedback`); existing rows backfilled `default` (§7 says why that is honest).
- `advisor_runs` gains `cancel_requested_at`, `cancel_reason`, `llm_model`, `llm_prompt_hash`;
  `advisor_runs_status_check` re-declared with `cancelled`; `advisor_runs_refusal_check` widened with
  `kind_disabled` and `payload_not_approved`; new `advisor_runs_cancel_reason_check`,
  `advisor_runs_cancelled_has_reason` (`cancelled` ⇔ a reason), `advisor_runs_user_cancel_was_requested`
  (`run_cancelled` ⇒ `cancel_requested_at`), the `llm_*` shape checks, and `UNIQUE (user_id, id)` for the
  composite FK below. (0012's two inline CHECKs are Postgres-named `advisor_runs_status_check` /
  `advisor_runs_refusal_check`; the migration applied on a fresh database, so the drops named real
  constraints.)
- `advisor_payload_approvals` — one row per approved query shape; composite FK `(user_id, advisor_id)` →
  `advisors`; `local_model` rows must carry a template hash; revocation stamps `revoked_at`.
- `advisor_run_payloads` — the request a `local_model`/`external` run sent; composite FK
  `(user_id, run_id)` → `advisor_runs (user_id, id)`; `CHECK (expires_at <= retained_at + 30 days)`; no
  digest column on purpose (the inspector must re-digest against `advisor_runs.input_digest`).

Same change: `packages/db/test/migrate.test.ts` — `'advisor_payload_approvals'` and
`'advisor_run_payloads'` added to the alphabetical list (between `'accounts'` and `'advisor_runs'`) and a
`// 0028_advisor_run_control:` attribution block after 0027's; `apps/api/src/reports/export/registry.ts` —
both tables in `EXEMPT_TABLES` with reasons (an approval is consent re-given, not restored; a retained
payload exported would outlive its own 30-day bound); `packages/contexts/insights/OWNERSHIP.md` — both
claimed (`lint:schema-ownership`: ok, 105 claimed / 92 defined). `db` project 10/10, `export-import`
green (the manifest-completeness test sees both).

## 2. The hardcoded-`true` finding (C-7, G4-9): red, then green

`apps/api/test/db/insights-routes.test.ts` → `'POST /advisors/run with module.insights off refuses and
runs nothing'`. The file is **not new** — it has held WP 2.r's route suite since `95d1c64`; the WP 5.1
case is a second `describe` block in it, with its own harness carrying an `advisor_token_secret` (the
first block's harness has none, and its 503 case depends on that).

The test stores `module.insights = false` for the holder, then calls `POST /advisors/run` twice (all
advisors, then the cash advisor alone) with a fresh session.

**Red, 17:50, against the tree as found** (`routes/insights.ts:217–218` hard-coding
`advisorsEnabled: true, moduleEnabled: true`):

```
× POST /advisors/run with module.insights off refuses and runs nothing 441ms
AssertionError: expected '32' to be '0' // Object.is equality
 ❯ test/db/insights-routes.test.ts:379:30
    379|       expect(ran.rows[0]?.n).toBe('0');
Tests  1 failed | 9 passed (10)
```

32 `advisor_runs` rows got past the switches with the module off: 31 from the run-everything call (the
gate's own count) and 1 from the single-advisor call.

## 7. `advisors.enabled_source` — and a live defect it closes (red first)

**Finding (not in the dispatch; the dispatch's reading of `store.ts:154–171` is wrong).** 05 §3 says
`registerAdvisor`'s conflict branch "never touches `enabled`". The code at `691ba33` does:
`...(input.enabled === undefined ? {} : { enabled: input.enabled })` (`store.ts:169`), and
`apps/api/src/modules.ts:376–380`'s `registerBuiltinAdvisors` passes `enabled: entry.defaultEnabled` on
**every api boot** (`app.ts`'s `onReady` → `bootstrap-seed.ts:132`). So today a restart **undoes the
user's own kill switch 3/level 3 choice**: an advisor the holder switched off comes back on, and a
spending rule the holder switched on goes back off. The WP 3.x test `'re-registering a newer version does
not re-enable or un-quarantine'` passes no `enabled`, which is why nothing caught it.

`packages/contexts/insights/test/db/enabled-source.test.ts` → `'a changed catalogue default reaches rows
nobody touched and never a row a human set'`, **red first, 17:58, against the tree as found**:

```
× a changed catalogue default reaches rows nobody touched and never a row a human set 2056ms
AssertionError: expected true to be false // Object.is equality
 ❯ test/db/enabled-source.test.ts:81:55     (builtin.wave.human_off — re-enabled by the catalogue)
Tests  1 failed (1)
```

## 8. C-12, the grants / run-path half (G4-17, G4-22)

### G4-17 — `GET /advisors` reported requests as grants, and never a last run

`apps/api/test/db/insights-routes.test.ts` → `'GET /advisors reports the stored grants and the last run,
not the manifest request (C-12, G4-17)'`. The remedy the gate names lives in
`packages/contexts/insights/src/read.ts` (`advisorHealth`), which is **outside this WP's listed files**;
it is a two-part, ~15-line edit made because C-12's grants half is assigned here and there is no other
place to make it true (a route-side override would have left `advisorHealth` lying to its next caller).
Neither concurrent WP touches `read.ts`.

Red twice, one half at a time (18:20):

```
× … (C-12, G4-17) 196ms
AssertionError: expected null to be 'completed'          ❯ insights-routes.test.ts:431  (rank: 1n !== 1)
```

then, with only `Number(run.rank) !== 1` applied:

```
× … (C-12, G4-17) 149ms
AssertionError: expected [ 'goals.list' ] to deeply equal []   ❯ insights-routes.test.ts:435  (requires_scopes read as granted)
```

Green with both: grants now come from one query over live `snapshot_grants` rows, and a revocation is
visible on the next read (asserted).

### G4-22 — a `requiresPerRunConsent` scope is never emitted without a per-run consent

Run path (this WP): `effectiveRunScopes` (`preview.ts`) drops a `requiresPerRunConsent` scope
(`transactions.raw`, `institutions.names`) from a run's scopes unless `RunAdvisorInput.perRunConsent`
names it for **that run**. Nothing supplies a per-run consent yet (WP 5.10's route will), so today such a
scope is never emitted, whatever `snapshot_grants` says. Test: `payload-preview.test.ts` →
`'a standing grant of a per-run-consent scope is never emitted without a consent for that run (G4-22)'`.

The route half — `PUT /advisors/{id}/grants` refusing a standing grant of such a scope unless
`perRunConsent: true` — is in `apps/api/src/routes/advisor-grants.ts`, **not this WP's file**: see "Needs
the orchestrator".

**Green, 18:05** (load 3.90), after `routes/insights.ts` read level 1 through `createRunSwitches`
(`config.env.ADVISORS_ENABLED` + an uncached `module.insights` read) and refused before starting
anything: `Tests 11 passed (11)` for the whole file. The route now answers **409
`insights.module_disabled`** (or `insights.advisors_disabled`), writes no `advisor_runs` row at all, and
runs nothing — "a disabled module contributes nothing" is now true of the button as well as of
registration. Both literal `true`s are gone from the route; the worker's two (`modules.ts:810–811`) are
replaced by the orchestrator's W-A line (see "Wiring for the orchestrator") — until then the worker keeps
its old behaviour through the deprecated `settings` booleans, which `staticRunSwitches` reads fail-closed
(an absent value is `false`, and no kind but `builtin` is ever on).

**Green, 18:07**, after migration 0028's `enabled_source` and the conflict branch
`enabled = CASE WHEN "advisors"."enabled_source" = 'default' THEN excluded."enabled" ELSE
"advisors"."enabled" END`, with `setAdvisorEnabled` stamping `user` (or `feedback`, WP 5.9's): the whole
`insights-db` project, `Tests 18 passed (18)`. Backfill: every existing row `default` — honest rather than
a guess, because until now every boot re-applied the catalogue default to every built-in row, so what a row
holds today _is_ the default as of the last boot. WP 5.7 is the first consumer (a later wave reaching an
existing install).

## 3. The ladder, with time-to-stop measured per level

`packages/contexts/insights/test/db/kill-ladder.test.ts`, 18:09, load average 3.84 / 3.51 / 2.48 (WP 5.2
and WP 5.13a in flight; **the timings are indicative, not a performance claim** — 05 §3 rule 4). The
advisor is a `local_model` fake that blocks until aborted; each level is flipped ~10 ms after the model
call starts, i.e. just after the watcher's timer began, so each figure is close to the **worst case** (one
full poll interval, then the probe, then the abort):

| Level     | Mechanism                                               | Scope                       | Default | Who flips it                 | Survives restart | How it was flipped in the test                      | Time to stop (flip → run returned) | `advisor_runs` afterwards                                               |
| --------- | ------------------------------------------------------- | --------------------------- | ------- | ---------------------------- | ---------------- | --------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| 1 Module  | `ADVISORS_ENABLED` **and** `module.insights`            | every advisor               | on      | operator (env) / user (flag) | yes              | `FlagService.set(module.insights, false)`           | **1052 ms**                        | `status=cancelled`, `cancel_reason=module_disabled`                     |
| 2 Kind    | `advisors.kind.local_model` **and** `config.localModel` | every `local_model` advisor | **off** | user, step-up / operator     | yes              | `FlagService.set(advisors.kind.local_model, false)` | **1016 ms**                        | `cancelled`, `kind_disabled`                                            |
| 3 Advisor | `advisors.enabled` **and** `quarantined_at`             | one advisor                 | off     | user, step-up / the app      | yes — rows       | `setAdvisorEnabled(false)`                          | **1012 ms**                        | `cancelled`, `advisor_disabled` (`advisor_quarantined` for the breaker) |
| 4 Run     | `advisor_runs.cancel_requested_at`; the deadline        | one run                     | —       | user, step-up / the clock    | n/a              | `requestRunCancel(runId)`                           | **1012 ms**                        | `cancelled`, `run_cancelled`, `cancel_requested_at` set                 |

Every case: `status = cancelled`, `cancel_reason` the level's name, **0 insights**, the advisor's signal
observed aborted, `input_digest` kept (it was allowed to start, so what it saw is recorded), one
`insights.AdvisorRunCancelled` with `stage: in_flight` and the level number. `ADVISORS_ENABLED` is config:
changing it is a restart, which ends every in-flight run by ending the process; its refusal
(`advisors_disabled`) is covered by the broadest-level test. The deadline half of level 4 closes the run
**`failed` / `advisor_timeout`** — the breaker counts it (the advisor did not answer), unlike a kill.

`'a run killed between the reply and the write lands nothing: the write barrier re-reads every switch'` —
the advisor flips the switch itself in the instant before it answers (after the watcher's last look, the
first tick being a second away), for each of the four levels plus a quarantine and a revoked approval:
six cases, each `cancelled` with its reason, **0 insights**, `stage: write_barrier`; then a control run
with no kill lands its insight (1). `'the refusal and the cancellation name the broadest level that
applied'` walks all six refusals from the top (every switch off, turned back on one at a time) with the
advisor never called, then cancels in flight with level 4 + level 3 + level 1 all applied: recorded
`module_disabled`, level 1.

## 4. The watcher's poll interval, and why

`RUN_WATCH_POLL_MS = 1000` (`policy/run-watch.ts`). The requirement is "ends within two seconds"; the
worst case is one interval + one probe + the abort's propagation, so the interval must sit well under two
seconds, and the measured worst case above is ~1.05 s. The probe is three indexed single-row reads
(`advisors`, `advisor_runs`, `advisor_payload_approvals`) plus two flag reads — single-digit milliseconds
here — once a second, for at most one run at a time (the local lane's concurrency is 1): shorter buys
nothing worth the traffic, longer breaks the two-second claim. The poll is wall time (`setTimeout`), not
the injected `Clock`, which is fixed in tests and never advances. A probe that throws is retried on the
next tick, not treated as "stop": the barrier is what makes a kill _true_; the watcher makes it _prompt_.
Flags are read **uncached** (`createFlagService({ ttlMs: 0 })`) — the platform default of 30 s would make
levels 1 and 2 take up to 30 s.

## 5. Sabotage log (recorded as observed)

| #   | Control                                                                                 | Sabotage                                                                                                                                                                                                                          | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Red first try |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| S1  | the run watcher stops an in-flight run within 2 s (all four levels)                     | `service.ts`: `watchRun({...})` replaced by a no-op watch (18:11)                                                                                                                                                                 | `× level 1 — module.insights off` … `× level 4 — POST …/cancel` — each `stopped in ~20 000 ms` (the fake's 20 s deadline), `AssertionError: expected 'failed' to be 'cancelled'`; `× the refusal and the cancellation name the broadest level that applied` likewise. The barrier case **stayed green** — correctly: it does not depend on the watcher. `Tests 5 failed \| 1 passed (6)`. Restored from a byte copy.                                                                                                                               | yes           |
| S2  | the write barrier re-reads every switch under the row lock before any insert            | `service.ts` transaction 2: `if (stop !== null)` → `if (stop !== null && false)` (18:12)                                                                                                                                          | `× a run killed between the reply and the write lands nothing: the write barrier re-reads every switch` — `AssertionError: module_disabled: expected 'completed' to be 'cancelled'` (`kill-ladder.test.ts:225`): the first kill case's insight **landed**. The four in-flight cases stayed green — the watcher caught those. `Tests 1 failed \| 5 passed (6)`. Restored from a byte copy.                                                                                                                                                          | yes           |
| S3  | a local-model run never occupies the builtin lane                                       | `jobs.ts`: the lane collapsed back into `insights.run` — `jobKindFor` → always `insights.run`, `insights.run`'s re-queue branch `&& false`, and `insights.run` executing whatever it is handed in that advisor's own lane (18:15) | `× a local-model run in flight does not delay a builtin run` — `Error: timed out after 10000 ms waiting for the builtin beside the local model` (`local-lane.test.ts:198`): the builtin queued behind the blocked model call in `insights.run`'s single slot. `× a local_model advisor is never executed by insights.run or inline by the API` — `Error: advisor local.narrator.test run failed` (`:229`): `insights.run` executed the local advisor, which ran to its 20 s deadline. `Tests 2 failed \| 1 passed (3)`. Restored from a byte copy. | yes           |
| S4  | per-kind breaker: 08 §4.4's numbers for `local_model`                                   | `kill-switches.ts`: `BREAKER_THRESHOLDS.local_model` given the builtin's numbers (5 / 50% / floor 4 / no 24 h rule) (18:19)                                                                                                       | `× three consecutive local-model failures quarantine it; a builtin needs five` — `expected false to be true` (`breaker-kinds.test.ts:97`, the third failure did not quarantine); `× five validator rejections in a rolling 24 h quarantine a local model; older ones do not count` — `expected false to be true` (`:155`). `Tests 2 failed (2)`. Restored from a byte copy.                                                                                                                                                                        | yes           |
| S5  | the payload preview gate refuses an unapproved shape                                    | `kill-switches.ts` `decideRun`: the `payloadApproved` line deleted (18:22)                                                                                                                                                        | `× a local-model run refuses until the current query shape has been previewed and approved` — `expected 'completed' to be 'refused'` (`payload-preview.test.ts:104`); `× a changed scope set or prompt template is a new query shape…` — `expected null to be 'payload_not_approved'` (`:156`); `× … per-run-consent … (G4-22)` — `:265`. `Tests 3 failed \| 1 passed (4)`. Restored.                                                                                                                                                              | yes           |
| S6  | a `requiresPerRunConsent` scope is never emitted without a consent for that run (G4-22) | `preview.ts` `effectiveRunScopes`: the consent condition short-circuited to `true` (18:22)                                                                                                                                        | `× a standing grant of a per-run-consent scope is never emitted without a consent for that run (G4-22)` — `expected [ 'cash.summary', 'transactions.raw' ] to deeply equal [ 'cash.summary' ]` (`:251`): the standing grant reached the model. `Tests 1 failed \| 3 passed (4)`. Restored.                                                                                                                                                                                                                                                         | yes           |
| S7  | the inspector re-digests rather than trusting stored bytes                              | `preview.ts` `inspectRunPayload`: `verified: true` (18:23)                                                                                                                                                                        | `× the retained payload re-digests to the run's input_digest` — `expected true to be false` (`:215`): the tampered payload read as verified. `Tests 1 failed \| 3 passed (4)`. Restored.                                                                                                                                                                                                                                                                                                                                                           | yes           |
| S8  | an edited prompt template is a new query shape                                          | `preview.ts` `queryShape`: `prompt_template_hash: null` (18:23)                                                                                                                                                                   | `× a changed scope set or prompt template is a new query shape and needs a new approval` — `expected null to be 'payload_not_approved'` (`:168`): a v2 template ran on the v1 approval. `Tests 1 failed \| 3 passed (4)`. Restored.                                                                                                                                                                                                                                                                                                                | yes           |
| S9  | `decideRun` runs only when every switch says yes, refusing with the broadest            | `kill-switches.ts` `decideRun`: the `kindEnabled` line deleted (18:26)                                                                                                                                                            | `× decideRun runs only when every switch says yes` — `Property failed after 1 tests`, counterexample `{advisorsEnabled:true, moduleEnabled:true, kindEnabled:false, advisorEnabled:false, quarantinedAt:null, payloadApproved:false}` → `expected 'advisor_disabled' to be 'kind_disabled'`. `Tests 1 failed \| 8 passed (9)`. Restored.                                                                                                                                                                                                           | yes           |
| S10 | the lane holds no database connection across the model call                             | `service.ts`: the model call wrapped in `database.transaction(…)` (one `SELECT 1`, then `invoke`) (18:27)                                                                                                                         | `× the lane holds no database connection while the model is called` — `expected [ 4831.124097 ] to deeply equal []` (`local-lane.test.ts:322`): a client checked out before the call began was still held 2.6 s into it. `Tests 1 failed \| 2 skipped (3)`. Restored from a byte copy.                                                                                                                                                                                                                                                             | yes           |

## 6. The lane's concurrency proof, with both job timelines

`packages/contexts/insights/test/db/local-lane.test.ts`, 18:13, load 3.34 (indicative only). `@core/platform`'s
**real** `createJobRunner` — global cap 4, per-kind caps, the claim loop at a 25 ms poll — with
`createRunJob` and `createRunLocalJob` from `jobs.ts`; the local run is queued by `requestAdvisorRuns`,
the API's own entry point, so the lane is chosen by production code.

```
builtin alone completed (104 ms)                +128 ms   ← insights.run, nothing else in flight
local queued (insights.run_local)               +141 ms
local model call started, now blocking          +217 ms   ← insights.run_local holds its one slot
builtin queued (insights.run)                   +221 ms
builtin completed (75 ms)                       +296 ms   ← while the model call is still blocked
local released and completed                    +368 ms
```

The builtin beside a blocked model call took 75 ms against 104 ms alone; the local run was still
`started` when it finished (asserted). With the lane collapsed (S3) the same builtin never completed
inside 10 s.

`'a local_model advisor is never executed by insights.run or inline by the API'`: `insights.run` handed a
local advisor re-queues it as `insights.run_local` and runs nothing (0 calls, no `advisor_runs` row);
`requestAdvisorRuns([builtin, local])` runs the builtin inline and answers the local `queued`; the nightly
fan-out enqueues each in its own lane; `runAdvisor` without `lane: 'local'` throws `LaneViolation`
before opening a run, and the local lane refuses a builtin the same way. At the HTTP level:
`insights-routes.test.ts` → `'POST /advisors/run queues a local_model advisor and never runs it inline'`.

`'the lane holds no database connection while the model is called'`: `pg.Pool` `acquire`/`release`
events over a 2.6 s window of a blocked model call, driven through the `insights.run_local` handler:
**10 short checkouts (two watcher ticks), longest 3.3 ms, 0 held**; nothing checked out before the call
was still checked out; `pg_stat_activity` shows no session of the database `idle in transaction`.

## 9. The builtin-breaker discrepancy with 08 §4.4 (recorded, not resolved)

08 §4.4: "3 consecutive failures or 5 schema violations in 24h ⇒ auto-disable". WP 5.1 applies that to
`local_model` (and to `external`, which has no advisor until Phase 6): **3** consecutive failures, or **5**
validator rejections — refused insights (steps 4–7) plus whole responses refused at steps 1–3 — in a
rolling 24 h (`BREAKER_THRESHOLDS`, `rejectionsSince`). The **builtin** breaker keeps its Phase 2
numbers, unchanged as the dispatch instructs: **5** consecutive failures, or **one** run ≥ 50 % refused
with ≥ 4 proposals. So a built-in trips at 5 where 08 says 3, and has a per-run rate rule where 08 has a
24 h count. Reason for keeping it: a deterministic rule that fails is a bug with a stack trace and a
fix, not a model having a bad night, and re-tuning a shipped breaker was out of scope. Both sets of
numbers are pinned by `test/kill-switches.test.ts` (`'keeps the builtin numbers and applies 08 §4.4 to a
local model'`) and exercised end to end by `breaker-kinds.test.ts`. Two smaller facts: the 24 h trip
records `quarantine_reason = 'rejection_rate'` (0012's CHECK has no third reason and widening it is WP
5.9's 0030); a cancelled run is not a failure and does not advance the streak, while the deadline is
(`advisor_timeout`, counted).

## 10. §6 Q5 — the pseudonym / secretbox question: the default applied

Q5 is unanswered at dispatch. **Applied default: the retained payload is plain `jsonb`, bounded to 30
days**, with no `@core/secretbox` dependency added to `@ctx/insights` and no lockfile change.
`advisor_run_payloads.payload JSONB` carries the canonical request; the bound is a table CHECK
(`expires_at <= retained_at + 30 days`, observed refusing 31 days with `23514`), reads ignore expired rows,
and the local lane deletes expired rows before every run (`pruneRunPayloads`). If Q5 is answered yes, a
later migration turns the column into a sealed envelope; nothing else in the run path changes, because the
inspector verifies by re-digesting against `advisor_runs.input_digest` rather than trusting the stored
bytes. Only `local_model`/`external` runs retain anything; a builtin retains nothing (asserted).

## 11. Exit tests (every name in the WP 5.1 entry, verbatim, where it runs)

The insights projects collect one level deep (`vitest.config.ts`: `insights` = `src/**/*.test.ts`,
`test/*.test.ts`; `insights-db` = `test/db/**/*.test.ts`; `api-db` = `test/db/*.test.ts`); every file
below sits where its project collects it, and every one was observed running (counts above).

| File (project)                                                             | Test                                                                                                                                                                                                                                   | Red first                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/contexts/insights/test/db/kill-ladder.test.ts` (insights-db)     | `'each of the four levels, flipped while a run is in flight, ends the run within two seconds and writes no insight'` — a `describe` of that name with one case per level (`level 1 — module.insights off` … `level 4 — POST …/cancel`) | sabotage S1                               |
| ″                                                                          | `'a run killed between the reply and the write lands nothing: the write barrier re-reads every switch'`                                                                                                                                | sabotage S2                               |
| ″                                                                          | `'the refusal and the cancellation name the broadest level that applied'`                                                                                                                                                              | S1                                        |
| `packages/contexts/insights/test/kill-switches.test.ts` (insights)         | `'decideRun runs only when every switch says yes'` — `fast-check` property (500 runs) **and** the exhaustive 64-combination walk                                                                                                       | sabotage S9                               |
| `apps/api/test/db/insights-routes.test.ts` (api-db)                        | `'POST /advisors/run with module.insights off refuses and runs nothing'`                                                                                                                                                               | **yes — against the tree as found (§2)**  |
| `packages/contexts/insights/test/db/local-lane.test.ts` (insights-db)      | `'a local-model run in flight does not delay a builtin run'`                                                                                                                                                                           | sabotage S3                               |
| ″                                                                          | `'a local_model advisor is never executed by insights.run or inline by the API'`                                                                                                                                                       | S3                                        |
| ″                                                                          | `'the lane holds no database connection while the model is called'`                                                                                                                                                                    | sabotage S10                              |
| `packages/contexts/insights/test/db/breaker-kinds.test.ts` (insights-db)   | `'three consecutive local-model failures quarantine it; a builtin needs five'`                                                                                                                                                         | sabotage S4                               |
| `packages/contexts/insights/test/db/payload-preview.test.ts` (insights-db) | `'a local-model run refuses until the current query shape has been previewed and approved'`                                                                                                                                            | sabotage S5                               |
| ″                                                                          | `'a changed scope set or prompt template is a new query shape and needs a new approval'`                                                                                                                                               | S5, S8                                    |
| ″                                                                          | `'the retained payload re-digests to the run's input_digest'`                                                                                                                                                                          | sabotage S7                               |
| `packages/contexts/insights/test/db/enabled-source.test.ts` (insights-db)  | `'a changed catalogue default reaches rows nobody touched and never a row a human set'`                                                                                                                                                | **yes — against the store as found (§7)** |

Beyond the entry's list: `insights-routes.test.ts` → `'GET /advisors reports the stored grants and the
last run, not the manifest request (C-12, G4-17)'` (**red first, twice**, §8) and `'POST /advisors/run
queues a local_model advisor and never runs it inline'`; `payload-preview.test.ts` → `'a standing grant
of a per-run-consent scope is never emitted without a consent for that run (G4-22)'` (sabotage S6);
`breaker-kinds.test.ts` → `'five validator rejections in a rolling 24 h quarantine a local model; older
ones do not count'` (S4); `kill-switches.test.ts` → the in-flight property, the ladder-level map, the
switch reader, the fail-closed static switches, the per-kind thresholds, the watcher's spacing and
error tolerance, and the query shape's inputs. One existing test changed because it asserted the old
input shape: `test/alert-budget.test.ts`'s `'the kill switches'` block gains `kindEnabled` and
`payloadApproved`.

## 12. Files

**Created**

- `packages/db/migrations/0028_advisor_run_control.sql`
- `packages/contexts/insights/src/policy/run-watch.ts` — the watcher (`RUN_WATCH_POLL_MS = 1000`, `RunCancelled`)
- `packages/contexts/insights/src/preview.ts` — query shape, `effectiveRunScopes` (G4-22), `buildAdvisorRequest` (the one request constructor for run and preview), `previewRequest`, `approvePayload`, `revokePayloadApprovals`, `hasLiveApproval`, `inspectRunPayload`
- `packages/contexts/insights/src/ports.ts` — `PromptRenderer`, `RenderedPrompt` (declared; WP 5.2 implements)
- `packages/contexts/insights/test/kill-switches.test.ts`
- `packages/contexts/insights/test/db/{kill-ladder,local-lane,breaker-kinds,payload-preview,enabled-source}.test.ts`, `test/db/run-control-harness.ts` (shared, not collected)
- `docs/evidence/phase-5/wp5.1-run-control.md`

**Changed (owned)**

- `packages/contexts/insights/src/service.ts` — three-point gate (`readGate` → `decideRun`/`decideContinue`), the watched `invoke`, the write barrier under `lockAdvisor`, `closeCancelled` + `AdvisorRunCancelled`, payload retention and `llm_model`/`llm_prompt_hash` before the call, the lane check (`laneOf`, `LaneViolation`), per-kind breaker; `InsightsDependencies` gains `switches`, `promptRenderer`, `runWatchPollMs`; `InsightsSettings.advisorsEnabled`/`moduleEnabled` now optional and `@deprecated` (read fail-closed only when no `switches` port is bound)
- `packages/contexts/insights/src/jobs.ts` — `insights.run_local` (`RUN_LOCAL_JOB_KIND`, `createRunLocalJob`, concurrency 1, prunes expired payloads), `insights.run` re-queues a non-builtin, the fan-out picks each advisor's lane (`jobKindFor`), `requestAdvisorRuns` (the API's entry point: built-ins inline, the rest `queued`); `insightsJobs()` deliberately unchanged
- `packages/contexts/insights/src/policy/kill-switches.ts` — `decideRun` with kind and approval inputs, `decideContinue`, `LADDER_LEVEL`, `RunSwitches` + `createRunSwitches` + `staticRunSwitches`, `BREAKER_THRESHOLDS` per kind
- `packages/contexts/insights/src/store.ts` — advisors section: `lockAdvisor`, `registerAdvisor`'s `enabled_source` conflict branch, `setAdvisorEnabled(…, source = 'user')`; advisor_runs section: `findRun`, `recordRunModel`, `requestRunCancel`, `rejectionsSince`, `finishRun`'s `cancelReason`, and the `advisor_run_payloads` functions (`retainRunPayload`, `findRunPayload`, `pruneRunPayloads`, `RUN_PAYLOAD_RETENTION_DAYS`)
- `packages/contexts/insights/schema/advisors.ts` — `enabledSource`, the four `advisor_runs` columns, `advisorPayloadApprovals`, `advisorRunPayloads`, `ENABLED_SOURCES`, `CANCEL_REASONS`, widened `RUN_STATUSES`/`RUN_REFUSALS`
- `packages/db/test/migrate.test.ts`, `apps/api/src/reports/export/registry.ts` (the two tables only)
- `apps/api/src/routes/insights.ts` — `runSwitchesOf` (uncached flags), `assertLevelOneOn` (409), `dependenciesOf` without literals, `POST /advisors/run` through `requestAdvisorRuns`; response gains `cancelled`/`queued`, nullable `runId`, `cancelReason`, `jobId`, and a 409
- `apps/api/test/db/insights-routes.test.ts` — a second `describe` (it is not a new file; §2)
- `packages/contexts/insights/test/alert-budget.test.ts` — the old-input assertion only
- `RUNBOOK.md` — new section "Advisor kill switches" only (inserted before "Panic button")

**Changed outside the listed files — each necessary, each small, none touched by WP 5.2 or 5.13a**

- `packages/contexts/insights/src/read.ts` — `advisorHealth`: grants from live `snapshot_grants`, `Number(run.rank)` (C-12/G4-17; the remedy's own location).
- `packages/contexts/insights/src/events.ts` — `AdvisorRunCancelled` defined and added to `INSIGHTS_EVENTS` (the WP's "Emits").
- `packages/contexts/insights/src/index.ts`, `packages/contexts/insights/schema/index.ts` — barrel exports for the above.
- `packages/contexts/insights/OWNERSHIP.md` — claims the two new tables (`lint:schema-ownership` fails otherwise).

## 13. Wiring for the orchestrator (W-A; this WP edits none of these files)

**`apps/api/src/modules.ts` — `insightsModule`.** `ModuleWiringOptions` has no config today, so it gains
three fields, supplied by `worker.ts` (and by `app.ts`'s `appModules` call, for symmetry):

```ts
// ModuleWiringOptions
/** `config.env.ADVISORS_ENABLED` — kill level 1, operator half. */
readonly advisorsEnabled: boolean;
/** `config.localModel !== undefined` — kill level 2, operator half. */
readonly localModelConfigured: boolean;
/** WP 5.2's adapter, bound to `@ctx/insights`' `PromptRenderer` port (W-C). */
readonly promptRenderer?: PromptRenderer;
```

```ts
import { PLATFORM_FLAGS, createFlagService, platformExecutor } from '@core/platform';
import { createRunLocalJob, createRunSwitches, type AdvisorKind, type PromptRenderer } from '@ctx/insights';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from './platform.ts';

// in insightsModule, before `const dependencies`:
const switches = createRunSwitches({
  advisorsEnabled: options.advisorsEnabled,
  // Uncached: the run watcher polls this once a second. The shared FlagService's
  // 30 s cache would make a flipped module.insights take up to 30 s to stop a run.
  flags: createFlagService({
    db: platformExecutor(database),
    defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
    ttlMs: 0,
  }),
  configuredKinds: new Set<AdvisorKind>(
    options.localModelConfigured ? ['builtin', 'local_model'] : ['builtin'],
  ),
});

// in `dependencies`: add
switches,
...(options.promptRenderer === undefined ? {} : { promptRenderer: options.promptRenderer }),
// and in `settings`: DELETE the two literals (modules.ts:810–811)
//   advisorsEnabled: true,
//   moduleEnabled: true,

// the registration:
jobs: [
  ...insightsJobs({ database, dependencies, clock }),
  createRunLocalJob({ database, dependencies, clock }), // insights.run_local, concurrency 1
],
```

and the module table's `module.insights` row gains `insights.run_local` beside `insights.run`,
`insights.run_all`.

**`apps/api/src/worker.ts`** — pass `advisorsEnabled: config.env.ADVISORS_ENABLED`,
`localModelConfigured: config.localModel !== undefined`, and (W-C) `promptRenderer` from WP 5.2's
adapter built over `config.localModel`. **`assertPoolCoversLeases`**: no formula change — `insights.run_local`
is a job kind, not a consumer, and `local-lane.test.ts` proves it holds no connection across the model
call (its watcher borrows one for ~3 ms a second); re-check against `DATABASE_POOL_MAX` as 05 §4 item 4
asks. **`app.ts`** — nothing required: the api process never executes a local model
(`requestAdvisorRuns` queues it) and its route builds its own switches.

**`PromptRenderer` binding point.** Declared in `packages/contexts/insights/src/ports.ts`
(`templateHash`, `model` = `name@sha256:<digest>`, pure `render(request) → { text, hash }`), exported from
`@ctx/insights`. WP 5.2's adapter implements it; the composition root binds it into
`InsightsDependencies.promptRenderer` for the worker (above). `render` must be deterministic — the preview
promises "exactly what it will see", and the inspector re-renders retained requests.

**`dependenciesOf` change** (`apps/api/src/routes/insights.ts`, this WP's): signature now
`dependenciesOf(deps, timeZone, switches)`; the literals are gone; `switches` come from `runSwitchesOf(deps)`
(built once per plugin registration, uncached flags). No `promptRenderer` in the api — deliberate.

## 14. Needs the orchestrator (outside this WP's files)

1. **The §13 wiring** — until it lands, the worker still passes `advisorsEnabled: true, moduleEnabled:
true` literals (`modules.ts:810–811`), which `staticRunSwitches` honours (fail-closed when absent):
   the worker's level-1 operator half (`ADVISORS_ENABLED`) is not read, and no `local_model` advisor can
   run there (level 2 is off without a `switches` port) — both safe directions. `module.insights` off
   still stops the worker at registration (MF1).
2. **`just openapi`** (05 §4 item 8) — `POST /advisors/run`'s response changed: statuses `cancelled` and
   `queued`, `runId` nullable, `cancelReason` and `jobId` added, a 409 problem. CI's `openapi-current` job
   is red until `packages/contracts/openapi/openapi.json` and `apps/web/src/api/generated/` are
   regenerated. `AdvisorsSettings.tsx` reads only `status`/`refusal`/`inserted`/`rejected`, so the
   regenerated client compiles unchanged (a `queued` result displays as "queued").
3. **G4-22's route half** — `apps/api/src/routes/advisor-grants.ts`: refuse a standing grant of a
   `requiresPerRunConsent` scope (`transactions.raw`, `institutions.names`) unless the body says
   `perRunConsent: true` (a 422 naming the scope). The run path already never emits one without a
   per-run consent (§8, S6), so this is the consent surface's honesty, not the data path's safety.
4. **Files touched outside the list** (§12's last block): `read.ts`, `events.ts`, `src/index.ts`,
   `schema/index.ts`, `OWNERSHIP.md` — commit them with this package.
5. **The brief's "new file"**: `apps/api/test/db/insights-routes.test.ts` already existed (WP 2.r); the WP
   5.1 cases are a second `describe` in it.
6. **The dispatch's reading of `registerAdvisor`** (05 §3: "never touches `enabled`") was wrong about the
   code; §7 records the live defect it hid and its fix. Worth a line in the execution log.
7. **RUNBOOK "Advisor kill switches"** gives SQL for levels 1–4 because no flag route and no cancel route
   exist yet; WP 5.10/5.12 should replace those lines with the screen and `POST
/advisors/runs/{runId}/cancel` (which should call `requestRunCancel`, so the cancel takes the
   advisor's row lock).

No DB read is needed for this evidence: every claim above was observed through a test against a scratch
database.

## 15. Report (posted before the final `just check`)

C-7 closed (red → green at the route; the worker's literals go in the W-A line, §13). C-12's grants half
closed: G4-17 red twice → green, G4-22's run path proved by S6; the grant route's half is §14 item 3. The
ladder holds at all four levels in flight (~1.0 s to stop each, near the worst case) and at the write
barrier (six kill cases). The local lane has its own job kind, concurrency 1, and holds no connection
across the call. The breaker is per kind (the builtin discrepancy is §9). The preview gate, the approvals
and 30-day payload retention (plain `jsonb`, the Q5 default) are verified by re-digest. `enabled_source`
closes a live defect the dispatch misread (§7). Migration 0028 ships with its `migrate.test.ts` lines,
export deferrals and ownership claim. Ten sabotages, **all red on the first try**. Two reds reproduced
against the tree as found (C-7, `enabled_source`), plus G4-17 twice.

## 16. `just check` (after the report)

18:27, load 3.00. `typecheck` **PASS**. `lint` **stopped at `prettier --check`** on
`docs/evidence/phase-5/wp5.13-carry-overs.md`: WP 5.13a's in-flight evidence file, not this WP's. The
remaining steps were run by hand so the check was still observed end to end:

- `lint:eslint`: 1 error, **not this WP's**: `packages/contexts/planning/test/returns-fetch-checksum.test.ts:23`
  `'mkdirSync' is defined but never used` (WP 5.13a's in-flight file). Every file of this WP is clean.
- `lint:schema-ownership` PASS (105 claimed / 92 defined); `check-proxy-routes` PASS;
  `check-ci-projects` PASS (42/42).
- `test`: `just test` exceeds the tool's 10-minute foreground cap, and the tool moved it to the
  background, which this WP's rules forbid, so it was stopped and run as foreground project groups.
  - Every unit project: 194 files, **2240 passed**, 6 skipped.
  - `db`, `platform-db`, `secretbox-db`, `identity-db`, `categorization-db`, `recurring-db`,
    `budgeting-db`: 28 files, **290 passed**.
  - `ledger-db`, `investments-db`, `integrations-db`, `notifications-db`, `insights-db`,
    `connections-db`: 34 files, **218 passed**.
  - `api-db` in two halves: 27 files / **145 passed**; 25 files (+1 skipped) / **165 passed**, 4 skipped.
  - `planning-db`: first run **2 red** in `test/db/goals.test.ts` (WP 4.1's goal tests; no insights
    code involved) at load ~5.7, beside WP 5.13a's new `carry-c3-cross-user.test.ts` in the same project;
    `goals.test.ts` alone 3/3, then the whole project re-run **42/42**. Recorded as a flake under load.
    Not this WP's; worth watching.

Nothing red is attributable to WP 5.1.
