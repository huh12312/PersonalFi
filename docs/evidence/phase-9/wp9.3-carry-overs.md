<!-- SPDX-License-Identifier: MIT -->

# WP 9.3 — Phase 5 gate carry-overs

_Written incrementally, from the first condition. Agent: `backend-architect`, Sonnet, on `main` at
`c90b78e`._

---

## 1. Per-condition table

| Condition | Red reproduction | Fix | Green run | Files touched |
|---|---|---|---|---|
| **C5-3** (High, G5-5) | New test `anomaly-nightly-consent.test.ts` written against the fix; sabotaged (see §2) to confirm it is red without the fix: `expected [] to deeply equal ['transactions.anomalies']` | `effectiveRunScopes` (`preview.ts`) no longer applies `requiresPerRunConsent` to a `builtin` advisor; reason written in both `preview.ts` and `contract/scopes.ts` (see §3) | `pnpm exec vitest run --project insights-db packages/contexts/insights/test/db/anomaly-nightly-consent.test.ts` → 1 passed | `packages/contexts/insights/src/preview.ts`, `packages/contexts/insights/src/contract/scopes.ts`, `packages/contexts/insights/test/db/anomaly-nightly-consent.test.ts` |
| **C5-5** (Medium, G5-16) | New test `run-inspector-digest.test.ts`; sabotaged (see §2) to confirm the §3.6 tamper is red without the fix: `expected true to be false` (`digestVerified` survived a tampered `findings` envelope, exactly the gate's live observation) | `advisor_runs.input_digest` (and the per-insight `inputDigest`) is now `canonicalRunDigest({snapshot, findings, granted_scopes})` — one new function in `preview.ts`, computed once per run in `service.ts` right after the final request is built, and re-derived the same way by `inspectRunPayload`. A pre-existing **parallel-construction** test fixture in `apps/api/test/db/advisor-runs-routes.test.ts` (computed its own `inputDigest(snapshot)` rather than calling the production function — P5-1's lesson, again) went red as a side effect and was fixed to call `canonicalRunDigest` instead (see §3) | `pnpm exec vitest run --project insights-db packages/contexts/insights/test/db/run-inspector-digest.test.ts` → 2 passed; `pnpm exec vitest run --project insights-db` → 47 passed; `pnpm exec vitest run --project insights` → 300 passed, 1 skipped; `pnpm exec vitest run --project api-db apps/api/test/db/advisor-runs-routes.test.ts apps/api/test/db/advisor-grants.test.ts apps/api/test/db/brief-retirement-port.test.ts apps/api/test/db/brief-routes.test.ts apps/api/test/db/insights-routes.test.ts apps/api/test/db/phase5-wiring.test.ts apps/api/test/db/phase3-cold-install.test.ts` → 62 passed | `packages/contexts/insights/src/preview.ts`, `packages/contexts/insights/src/service.ts`, `packages/contexts/insights/src/index.ts`, `packages/contexts/insights/test/db/run-inspector-digest.test.ts`, `apps/api/test/db/advisor-runs-routes.test.ts` |

_(table continues as each condition closes)_

---

## 2. Sabotage log

| # | Condition | File | Sabotage | Test | Observed | Restored |
|---|---|---|---|---|---|---|
| 1 | C5-3 | `packages/contexts/insights/src/preview.ts` | `manifest.kind === 'builtin'` replaced with `/* SABOTAGE C5-3: WP9.3 evidence, restored immediately */ false` in `effectiveRunScopes`'s filter | `vitest run --project insights-db packages/contexts/insights/test/db/anomaly-nightly-consent.test.ts` | RED: `AssertionError: expected [] to deeply equal [ 'transactions.anomalies' ]` (`anomalyRun.grantedScopes`) | Yes, byte-identical to the pre-sabotage diff (confirmed via `git diff --stat` showing only the intended fix remained) |
| 2 | C5-5 | `packages/contexts/insights/src/preview.ts` | `canonicalRunDigest`'s body replaced with the pre-fix formula, `return inputDigest(input.snapshot);` (comment `SABOTAGE C5-5: WP9.3 evidence, restored immediately`) | `vitest run --project insights-db packages/contexts/insights/test/db/run-inspector-digest.test.ts` | RED: `AssertionError: expected true to be false` on `'tampering only the findings envelope is caught: digestVerified turns false'` — `digestVerified` stayed `true` after the `findings` tamper, exactly the gate's §3.6 observation | Yes, confirmed by `git diff --stat` showing only the intended multi-line fix remained, then re-ran both digest tests green |

---

## 3. Decisions, with reasons

### C5-3 — drop `requiresPerRunConsent` for `builtin` advisors, rather than build a per-run-consent path for scheduled/on-demand runs

The gate named two fixes. I chose **the first**: `transactions.anomalies` keeps
`requiresPerRunConsent: true` (for the `local_model`/`external` case the flag exists for — G4-22's
consent screen, kept intact, see below), but `effectiveRunScopes` (`preview.ts`) no longer applies that
gate when the advisor's `kind` is `'builtin'`.

**Why, not the other option (give scheduled/on-demand runs a real per-run-consent path).**

1. **A per-run consent is about data crossing a process boundary** — to a model or an external API —
   and asking the holder to re-affirm that *this run* may send it. `builtin.spending.category_anomaly`
   and `builtin.spending.new_merchant_high_charge` (S1, S5) never send anything anywhere: they read
   `transactions.anomalies` in-process and write `insights` rows back into the same database the
   standing grant already authorised. There is nothing for a per-run consent to be *about* for these
   two rules, so building a consent path for them would be machinery with no referent — exactly the
   kind of control a reviewer later has to re-derive the point of.
2. **The existing per-row minimisation is already the control for this scope's sensitivity.**
   `transactions.anomalies` carries `externalAllowed: false` and exact, unbucketed amounts precisely
   because an individual flagged row is a fingerprint (the file's own comment, `scopes.ts`). That
   control does not change: this fix touches only *when* the standing grant is honoured for a
   `builtin` reader, never what crosses to `local_model`/`external`.
3. **G4-22 must stay intact for `local_model`/`external`**, and it does: `effectiveRunScopes`'s new
   clause is `manifest.kind === 'builtin'`, so a `local_model` advisor requesting
   `transactions.anomalies` (the narrator's laundering bound includes it — `NARRATOR_SCOPES`,
   `advisors/local/manifest.ts:49`) is unaffected; `payload-preview.test.ts`'s G4-22 test (which uses
   `transactions.raw` against a `local_model` manifest) still passes unmodified (§1.2 below).
4. **The second option (a real per-run-consent path for scheduled/on-demand runs) would need a UI,
   route and/or scheduler change** — the Brief and the nightly fan-out would have to originate a
   consent neither currently models (a schedule has no screen in front of it to ask), which is a much
   larger, riskier change for a rule that never leaves the process. The grant row already carries a
   `perRunConsent` boolean column (`snapshot_grants.per_run_consent`) that the gate's own walk set to
   `true` and that `listGrants` never reads — building a "real" per-run-consent path on top of a column
   that already exists but is wired to nothing would be the second place to forget the first one. I did
   not wire that column in either, for the same minimalism reason: the `builtin` kind does not need a
   per-run consent at all, so there is no "real path" left to build for S1/S5.

**What this did *not* touch.** `transactions.raw` and `institutions.names` also carry
`requiresPerRunConsent: true`. Two existing `builtin` rules — `builtin.spending.uncategorised` (S3) and
`builtin.spending.duplicate_charge` (S6) — declare `transactions.raw` in their `requires_scopes`
(`rules-spending.ts:239,314`) and are therefore **also** affected by this fix: before it, both were
silently gated the same way S1/S5 were (`effectiveRunScopes` dropped `transactions.raw` from every
`builtin` run, same root cause), and after it, a standing grant of `transactions.raw` is enough for them
too. This is a correct and in-scope consequence of the general rule ("never gates a `builtin` advisor"),
not scope creep: C5-3's exit condition is specifically about S1/S5, and I did not add a new exit test
for S3/S6, but `advisor-golden.test.ts`'s S3 and S6 rows (which evaluate the rule directly on a snapshot,
not through `effectiveRunScopes`) still pass unchanged, and `anomaly-nightly-consent.test.ts` proves the
run-path fix generally through S1/S5. Recorded here so a later reader does not find S3/S6 running on a
real install and wonder why no condition said so.

### C5-5 — one digest function, called from both the write path and the inspector, over `{snapshot, findings, granted_scopes}`

**Where the bug lived.** `BuiltSnapshot.inputDigest` (`snapshot/builder.ts`) is `inputDigest(snapshot)` —
computed before `findings` exists for a narrator. `advisors/local/request.ts` (WP 9.5's, Wave B — not
touched) builds a narrator's request with `snapshot: {}` always, and attaches `findings` and the real
`granted_scopes` *after* calling `buildAdvisorRequest`, so `built.inputDigest` never saw them. That
`built.inputDigest` is what `service.ts` wrote to `advisor_runs.input_digest` and what `inspectRunPayload`
re-derived (`inputDigest(payload.snapshot)`) — both blind to `findings` in exactly the same way, so the
inspector's "Verified" mark was never testing anything a narrator run actually carried.

**The fix, and why it needed no file outside this package's ownership.** `canonicalRunDigest` (`preview.ts`,
new) takes `{snapshot, findings, granted_scopes}` — the three fields the condition names — and is the one
place this digest is computed. `service.ts`, right after the final `request` for this run is known (after
`buildNarrationRequest` has already attached `findings`, for a narrator), **recomputes** the run's digest
from that `request` rather than trusting `prepared.built.inputDigest`, and stores the corrected value on
`advisor_runs`, on every insight proposed this run, and on the cancelled/failed/nothing-to-narrate close
paths. `inspectRunPayload` calls the same function over the retained bytes. Nothing in
`src/advisors/local/**`, `src/validate/**` or `src/contract/{request.ts,version.ts,json-schema.ts}` was
touched — the contract's own wire field `AdvisorRequest.input_digest` (what a `local_model` adapter is sent
and what `contract/request.ts`'s header documents as "sha256 over the canonical JSON of `snapshot`") is
**unchanged**; only the separate `advisor_runs.input_digest` **database column** (and the identically-named
`insights.input_digest` column, which always shared the same value) now means something richer: what the
run inspector verified against, and what an insight "stood on".

**Why `granted_scopes` and `findings`, and not the whole `AdvisorRequest`.** `request_id`, `generated_at`
and `limits.deadline` are fresh every run even when nothing about what was read changed; digesting the
whole request would make `insights.input_digest` churn for no reason on every re-run of a `builtin` rule,
which is exactly the kind of false "it changed" a reviewer stops trusting. `{snapshot, findings,
granted_scopes}` is the exact list the condition names, and it is stable across repeated runs with
identical data.

**A parallel-construction regression the fix surfaced, and its own fix (P5-1's lesson, again).**
`apps/api/test/db/advisor-runs-routes.test.ts`'s run-inspector fixture computed its own
`inputDigest(snapshot)` — bypassing the production digest function entirely, the exact pattern the Phase 5
gate's P5-1 names — and stored a retained payload with no `granted_scopes`. Once `inspectRunPayload`
started covering `granted_scopes`, that fixture's hand-rolled digest stopped matching the real one and the
test went red (`expected false to be true`). This is not a defect in the fix: it is a second live
demonstration that a test which re-derives the thing it means to assert about proves nothing about the
real code path. Fixed by calling `canonicalRunDigest` (re-exported through `@ctx/insights`'s barrel,
`src/index.ts`) and carrying `granted_scopes` in the stored payload, so the fixture and the production code
can no longer silently diverge.

---

## 4. Wiring for the orchestrator

None yet.

---

## 5. Open items / handed to other packages

None yet.

---

## 6. Final check output

_Appended after the final report, before the orchestrator's typecheck/lint pass._
