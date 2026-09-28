<!-- SPDX-License-Identifier: MIT -->

# Phase 5 dispatch — advisory engine v2: the Weekly Brief, the local model, the kill ladder

*Written 2026-09-28 at `088fe4d` on `main`, while the Opus Phase 4 gate runs. That gate owns
`docs/evidence/phase-4/gate-security-review.md` and the compose stack; this file touches neither, and at the
time of writing every section of that document reads NOT STARTED. Companion to
[`01-execution-log.md`](01-execution-log.md), which stays the orchestrator's ledger; this file is the
work-package breakdown, wave plan and gate standard for Phase 5. Plan of record remains
[`00-master-implementation-plan.md`](00-master-implementation-plan.md).*

---

## 1. Goal, exit criteria, rung

**Goal (master plan §5).** Phase 5 — Advisory engine v2 (8–12 days). Deliverables: Weekly Advisory Brief
(≤5 actions ranked by dollar impact, each with its effect on retirement date); health score with breakdown;
anomaly and fee hunter; `local_model` advisor kind behind the Advisor contract with Ollama (no egress),
grounded narration only (every numeric claim must exist in the snapshot); prompt-injection defenses
(delimited untrusted blocks, Unicode/control sanitization, schema-validated output) with a ≥20-payload
adversarial corpus; sandbox harness, circuit breaker, four-level kill switch; advisor management UI with
scope grants; run inspector with `input_digest`; payload preview before the first send of any new query
type; dismiss-reason feedback loop into rule tuning.

**Exit criteria, verbatim from §5:**

> LLM advisor killable at all four levels with the app unaffected; red-team pass yields zero schema-valid
> insights with fabricated figures; ≥95% of generated insights pass evidence-ref validation on first
> attempt; the Brief produces ≥3 genuinely useful actions in its first month.

**Rung reached (§2.3).** **v0.7** "Advisory" — *"Weekly Brief yields ≥3 useful actions in its first month;
every recommendation renders a full evidence panel."* The two halves are different kinds of claim, and
this file treats them differently rather than pretending they are the same. *"Every recommendation renders
a full evidence panel"* is testable and sabotage-testable — WP 2.6's validator already refuses an insight
whose evidence does not resolve, and the Brief must inherit that refusal rather than re-implement it.
*"≥3 useful actions in its first month"* is an **observation over four weekly Briefs on real data**; no
seed can stand in for "Chris judged it useful". Phase 5 builds the instrument (the Brief is persisted per
ISO week, every item's accept/dismiss-with-reason is recorded, and one query counts them) and closes the
three engineering exit criteria on evidence; the fourth is carried to Chris as a dated observation (§6
Q8), exactly as Phase 4 carried its real-data criteria. The rung is declared **reached, provisionally**,
until that month is read.

Of the three engineering criteria, the one that decays quietly is the second. *"Zero schema-valid insights
with fabricated figures"* sounds like the validator's numerals step, and WP 2.7 already proved that step
is not enough: with the impact ceiling disabled, a poisoned $1,412,000 passed all seven validation steps
**because it was faithfully traceable to a snapshot value** (`docs/evidence/phase-2/wp2.7-advisor-catalog.md`,
"And the validator did not catch it"; the Phase 2 gate confirmed it independently, `gate-security-review.md`
§2.7). The built-ins are protected from that by `clampImpact`, which lives in the *rule*. A language model
has no such rule inside it, and a model that writes "you could save $1,899 a year" where 1899 is some
other row's minor units passes a snapshot-wide numeral trace — and so, under the renderings `numerals.ts`
permits (`×100`, `÷100`, absolute value), does almost any small integer it invents. WP 5.3 exists to close
exactly that, and WP 5.4 exists to prove it closed by someone who did not write it.

**What Phase 5 does not do.** A hosted LLM of any kind (D22 permits one only for market research carrying
no personal data; nothing in Phase 5 needs it, so no hosted-API client enters the tree); natural-language
questions about his finances (09 ADV-12, a "C" off by default); the month-in-review narrative (09 ADV-11);
Vibe-Trading (Phase 6, D23). Four cut lines drawn now rather than discovered later:

1. **Narration covers the Brief's items, not every insight.** The local model narrates at most five
   findings a week — the ones the Brief chose — rather than every nightly proposal. That bounds model time
   on a laptop-class CPU (the host WP 4.13 timed on is a Ryzen 5 3501U, execution log 2026-09-27 02:05),
   keeps the model off the nightly critical path, and makes the ≥95% criterion a measurement over findings
   a human will actually read.
2. **07 §8.2's point-in-time backtest and §8.5's `NOT_TRUE`-rate release gate are not built as written,
   because the bitemporal store they need was not built** (04 §1 cut line 3, §6 Q7). What Phase 5 builds
   instead is honest about being weaker: (a) **forward validation** — from the day WP 5.9 lands, every
   proposal is its own point-in-time record, because its `input_digest`, derivations and evidence were
   stored when it was said, and a finding is validated only against data learned *after* it (07 §8.2's
   "persisted ≥2 more periods" test for U2 and S2, re-expressed as "re-proposed at its horizon"); (b) the
   `NOT_TRUE` gate applied to **live dismissal reasons** — a rule whose `NOT_TRUE` rate exceeds 0.2 over at
   least five firings quarantines itself (07 §8.3's own threshold); (c) a **seed-bound backtest** in WP
   5.14 over the deterministic seed, which is leak-free *only* because a generated seed has no late
   arrivals or restatements — `valid_time` and `knowledge_time` coincide there by construction, and
   nowhere else. None of the three is a backtest over Chris's history; §6 Q4 prices that decision.
3. **"Effect on retirement date" is computed at the engine's resolution, which is whole years.**
   `boundary.ts:513` asserts a whole retirement age, and no solver for the earliest sustainable age exists
   (`src/engine/solve.ts` solves contributions, not dates). WP 5.5 adds that solver at whole-year
   resolution and, beside it, a months-of-retirement-spending figure derived from two engine runs. Most
   single actions will not move a whole year, and the Brief says so rather than interpolating a month the
   engine never computed. §6 Q6 asks whether a partial-transition-year engine change is worth it.
4. **The health score is cut-order item 2** (§2.3: *"Sankey → health score → …"*). It is built in Wave C,
   and it is the first package dropped if the phase runs long.

---

## 2. Phase 4 carry-overs Phase 5 must absorb

| Item | Source | Disposition |
|---|---|---|
| **The Phase 4 gate verdict and its conditions** — not written at the time of this file | Phase 4 gate, in flight at `088fe4d` | **Phase 5 does not dispatch until the verdict exists, and WP 5.13 not until its conditions are written.** The 03 and 04 precedent is exact: 04 §2 held WP 4.12 on an unwritten verdict and it cost nothing, because the alternative is a package implementing a ruling that then says something else. If the verdict carries a HIGH, 5.13 is promoted into Wave A (§4). |
| **The eleven named gate inputs** — Q3 fetch-on-first-run series, Q6 secretbox, Q4 gap rules, invariant 3's reading, invariant 1 for bootstrap, the alias-aware boundary check, 4.9's tie-break and 4.5% constant, 4.12a's lost sabotage records, 4.11's ported kernel, the five real-data criteria, the four residuals | execution log 2026-09-28 14:25 | **Inputs to that gate, not outputs of this phase.** The ones Phase 5 must act on whatever the gate rules are split out below with their own owners; the rest (invariant 3, invariant 1, 4.12a's sabotages) are the gate's to rule on and reach Phase 5 only through its conditions. |
| **S6 loses a dashboard slot to R2/R7 on a key tie-break** — `rank()` has no P0-safety term and breaks ties on `key` ascending | wp4.9 §12 item 1; `policy/alert-budget.ts:113–120`, `:157–161` | **WP 5.7**, because 5.7 is the package that releases the spending wave (`catalogue.ts:205–210` ships S2–S10 `false` today) and so makes the defect live. The package that turns a latent bug on fixes it in the same commit. WP 5.6's Brief routes no-dollar urgent findings to an attention strip of their own and cannot inherit the bug. |
| **`GUARDRAIL_REFERENCE_RATE = '0.045'`** is a literal in the composition root, not a cited assumption | wp4.9 §12 item 2; `apps/api/src/domain.ts:1564` | **WP 5.5** moves it into WP 4.2's assumptions file with a source and an `as_of`; the W-B wiring batch replaces the literal with the file's value. Moving it **changes the content hash**, and wp4.2 §10 records that only the current file version resolves — so every stored override would refuse with `UnknownAssumptionsVersion`. 5.5 therefore also retains the previous version as a frozen snapshot so stored deltas resolve and old runs read *stale with the version named*. A hash change with no retained predecessor is how a plan silently loses the user's overrides. |
| **Goal names reach advisor copy; `redactDigits` is declared on every scope row and implemented nowhere** | wp4.9 §12 item 5; `contract/scopes.ts:86`, `:140` (grep finds no other use in `src/`) | **WP 5.3.** Phase 5 is the first phase in which free text the holder wrote is read by a model. 5.3 implements the flag for the kinds that can read free text or deletes it with a written reason — a minimisation rule that exists only as a declaration is the Phase 1 gate's "control written as a comment" finding one layer down. |
| **`#planProjection` runs the deterministic engine three times per snapshot, untimed on the scale seed** | wp4.9 §12 item 6 | **WP 5.14** measures it on WP 4.13's scale seed, together with the Brief's added cost (up to two deterministic runs per Brief item, ≤5 items a week). |
| **The `goal` token domain must travel with the `@core/secretbox` swap** | wp4.9 §11 | **§6 Q5.** Moves with the swap or not at all. |
| **`newestBaselineRunId`'s `user_id` is not independently load-bearing** (S1-b) | wp4.9 §12 item 4 | **The Phase 4 gate's**, under its §5 item 8. Recorded so a reader does not open a package for it. |
| **The Monte Carlo concurrency cap is a literal** (`MAX_CONCURRENT_MONTE_CARLO_RUNS = 8`), never load-tested at the cap | wp4.5 §4.5, wp4.w-wave-c §5 item 1; `apps/api/src/domain.ts:3309` | **Config batch** (`MONTE_CARLO_MAX_CONCURRENT`, §4 item 9) and the W-B wiring; **WP 5.14** sabotage-tests the refusal at the cap, which WP 4.5 proved per worker and nobody proved per process. |
| **The bootstrap engine is ~0.5 pt/yr optimistic on real history**; perf headroom ~20% alone, none under contention | wp4.5 §10 open items | **Deferred to the Phase 9 engine pass, with the reason.** Re-centring bumps `MONTE_CARLO_VERSION`, moves every stored success probability and the golden-drift pin, and depends on 04 §6 Q3's data decision; a pre-warmed worker pool changes WP 4.5's terminate-on-deadline model. Consequence stated plainly: R2 fires on a probability that reads slightly high until then, and `plan.projection` carries the method so the Brief can name it. |
| **BTC block bootstrap not built** (Student-t only) | wp4.5 §10 | **Deferred.** 07 §6.4 names Student-t(ν=3) as an acceptable alternative; nothing in Phase 5 reads the difference. |
| **`worker-host.ts` reads a cited node through `const CITED = 'value'`**, a declared evasion of WP 4.4's interior grep; proper home `monteCarloMarketFrom(assumptions)` in `boundary.ts` | wp4.5 §10 item 6 | **WP 5.5**, which owns `boundary.ts` this phase. |
| **Negative life events are stored, named `outflow_not_modelled`, and not applied** | wp4.6 §11 item 1; design in wp4.5 §10 item 10 | **WP 5.5**, on 4.5's design: a signed `oneOffByYear` built once in `toEnginePlan` through the one boundary crossing and read in `stepYear`. The Brief's retirement effect is computed by the same engine, and a Brief that ignores a stored house purchase would advise against a plan the holder does not have. 5.5 must also say, in evidence, that the client worker's ported kernel does **not** gain the input (wp4.11 §2's server-only list) — so a preview of a plan with a dated outflow diverges from the saved run, and the golden vector stays green only because its plan has none. |
| **Crypto holdings are not passed to the Monte Carlo** | wp4.6 §11 item 4, wp4.13 §9 item 5, wp4.w-wave-c §5 item 3 | **WP 5.5** — a port field and the bucket split in `derivedFromDay` that 4.6 names. |
| **The projection refresh job holds its transaction across the ~1 s engine run** | wp4.6 §11 item 6 | **WP 5.5.** Acceptable at one holder in Phase 4; Phase 5 adds a weekly job that runs the engine per Brief item, and a second transaction held across compute is how the pool-vs-lease deadlock of Phase 3's wiring batch comes back. |
| **Stale seed-range comments** in 4.5's envelope and `prng.ts` | wp4.6 §11 item 2 | **WP 5.5**, comment-only. |
| **The ported client kernel, and a shared `@core/projection-kernel`** | wp4.11 §7 item 1, execution log 2026-09-28 09:20 | **Deferred to Phase 9 with the reason.** The golden-vector pair is the control and it holds; hoisting now would move 4.4's and 4.11's files mid-phase for no Phase 5 exit criterion, while 5.5 is editing the kernel's server half. |
| **Bootstrap-engine previews on the client**; **`GoalSliders`' starting balance has no server field** | wp4.11 §7 items 2–3 | **Deferred.** The first waits on 04 §6 Q3's licence decision; the second is a plan-screen seam no Phase 5 package reads. |
| **A Base UI slider below the fold silently drops every Playwright drag** | wp4.11 §7 item 5 | **WP 5.14** writes the shared `e2e/support/drag.ts` helper (scroll first, then measure); the orchestrator applies it as a shared file because `e2e/support/` is shared. |
| **A user-set tax bucket and account role** (a Ledger migration) | wp4.3 §9 item 1 | **Carried, owner Chris** — it is the fifth real-data criterion (§6 Q8). |
| **Investment-side cash arrivals are not read as contributions** | wp4.3 §9 item 3 | **Carried, owner Chris** — needs a real payroll-funded 401(k) to test against. |
| **A bigint median exists twice** (`@ctx/recurring`'s `stats.ts`, `@ctx/planning`'s `windows.ts`) | wp4.3 §9 item 5 | **WP 5.7** adds `packages/kernel/src/stats.ts` (exact median, MAD) because the anomaly baseline is a third caller; **WP 5.14** moves the two existing copies onto it. A third copy is the thing this row exists to prevent. |
| **`linked_since` on a connection; "the oldest budget" as the household's** | wp4.3 §9 items 4, 6 | **Deferred.** |
| **SSA bend points and the $150,000 Roth catch-up threshold unverified** (ssa.gov 403s from the sandbox) | wp4.2 §10 | **Owner Chris, or the Phase 4 gate** from a machine with outbound access. |
| **REIT has a correlation row and no μ/σ**; unclear whether the engine refuses or maps a REIT holding | wp4.2 §10, wp4.14 §8 | **WP 5.5** reads `toEnginePlan` and `montecarlo.ts`, decides, and pins the behaviour with a test. |
| **Macro constants go stale quarterly with no reminder** | wp4.2 §10 | **Deferred to Phase 9.** |
| **WP 4.1's open items** — self-reported revealed volatility, MFJ-schedule tests, a zero-funding goal reading 0%, no over-earmark cap, an unvalidated instrument | wp4.1 "Open items" | **Deferred or recorded.** None blocks a Phase 5 exit. |
| **WP 4.7's open items** — `domain.ts` wiring, the 0023 attribution, the events pin, the test-local decorator | wp4.7 §9 items 1–3, 6 | **Closed** by the Wave B wiring batch (`d11b836`, execution log 2026-09-27 00:20). Earmark granularity, I1's missing-class skip and `AllocationTargetsChanged` having no consumer are **deferred**. |
| **`cash_earmarks` has no route; the plan screen has no goal CRUD** | wp4.8 (log 2026-09-27 10:15), wp4.10 §9 items 4–5 | **Deferred to Phase 9, with the reason.** R6 and the Brief read goals when present, and goals are creatable through `POST /goals`; neither is a Phase 5 exit. Noted because it caps how much of the retirement wave Chris will see on real data. |
| **`AssumptionsPanel.test.tsx`'s second test cannot see a closed `<details>`** | wp4.10 §9 item 3 | **WP 5.14.** |
| **WP 4.12c's carried items** — C-13's full custody proof and composition wiring, C-8/C-9 route-level sabotages, G3-15's two remaining labels, C-16 O-3's two remaining specs, C-15's CSP unverified against a full build, C-13's untested re-link path | wp4.12c §8 | **The Phase 4 gate rules on each**; whatever it carries lands in **WP 5.13**. **Observed while writing this file:** four `docs/evidence/phase-3/screenshots/wp3.12-*.png` files show as modified in the working tree while the gate runs. Either the gate set `PLAYWRIGHT_EVIDENCE_DIR` deliberately or C-16 O-3 regressed; the gate's own evidence says which, and it is an input to 5.13 either way. |
| **`GET /holdings` and `/investments/allocation` have only a six-account perf number** | wp4.13 §9 item 6 | **Deferred to the Phase 9 performance pass** (08 §7.1). |
| **Bengen and Guyton-Klinger published golden fixtures not built; invariant 3 reads 1.4–1.9% per seed; the perf budget red under contention; 41 vitest projects where the plan said 40** | wp4.14 §8 | **Phase 4 gate inputs.** The 41 is `planning-perf`, added for a stated reason (execution log 2026-09-26 23:45); anything the gate carries lands in 5.14. |
| **The `@core/secretbox` merchant-pseudonym swap** — decided in Phase 3, pinned as `configHash`, carried by 04 §6 Q6 and not applied (`packages/contexts/insights/package.json` has no `@core/secretbox` dependency at `088fe4d`) | wp3.13 §3 row 9, 04 §6 Q6, wp4.9 §9 | **§6 Q5 — the fifth phase.** There is now a second reason to decide: WP 5.1 retains advisor payloads for the run inspector, and a retained snapshot is exactly the thing that should be sealed. |
| **The `.trivyignore` snoozes for upstream `caddy:2-alpine`'s Go CVEs expire 2026-10-10** | execution log 2026-09-26 11:30 | **Falls inside Phase 5.** The orchestrator re-scans upstream on 2026-10-10; if it still carries them, the `xcaddy` source build moves from Phase 9 into this phase's shared-file batch, because a red proxy scan blocks every landing. |
| **The execution log's Phase 4 lessons** — `LEFTHOOK=0` snapshots bypass prettier (twice: `853a84a`, `088fe4d`; and `.json` never, `9ad9565`); the 5 s vitest default under parallel load (the tree scan, WP 4.2's two-process hash); an agent's `git stash` (2026-09-27 08:30); the return series is fetched, not vendored, so CI has no cache (2026-09-28 07:40) | execution log 2026-09-27 01:10 → 2026-09-28 14:15 | **§3's preamble, as rules every brief carries.** On the last: nothing Phase 5 adds needs the series — the Brief's retirement effect is deterministic — and any test that does must skip *by name* where the cache is absent, the 07:40 precedent. |
| **The recurring-insights e2e flake** (known since Phase 2, passed on retry 2026-09-28 07:40) | execution log | **WP 5.14.** Phase 5 adds two insights-adjacent specs beside it. |
| **`ConsumerContext` should carry a database handle; multi-user taxonomy seeding** | 04 §2, deferred three times | **Deferred a fourth time, same reasons.** Every Phase 5 table is `user_id`-scoped from its first migration. |
| **Real-data exit criteria, now seven** — the five of 04 §6 Q8, plus the Brief's first month and the ≥95% on the pinned model on this host's hardware | 02 §2 → 04 §6 Q8, §1 above | **Owner Chris, §6 Q8.** |
| **Found while writing this file:** kill switch 1 has no config key — `advisorsEnabled: true` and `moduleEnabled: true` are literals in both places a run is assembled (`apps/api/src/modules.ts:810–811`, `apps/api/src/routes/insights.ts:217–218`), and `insightRoutes` is registered unconditionally (`apps/api/src/app.ts:542`) | code at `088fe4d` | **WP 5.1, and it is the first thing 5.1 reproduces red.** `POST /advisors/run` today runs every advisor with `module.insights` off: the level-1 switch stops the schedule and the consumer and does not stop the button. Phase 5's first exit criterion is "killable at all four levels", and one of the four is already bypassable. |
| **Found while writing this file:** `runAdvisor` never passes `knownFindingTypes` to `validateResponse` (`packages/contexts/insights/src/service.ts:295`) | code at `088fe4d` | **WP 5.3.** A `narrates_only` advisor today would have every insight refused at step 4 (`narrator_introduced_finding`) — fail-closed, but it means the narration path has never run once. |
| **Found while writing this file:** the breaker trips on five consecutive failures or a ≥50% rejection rate over ≥4 proposals (`policy/kill-switches.ts:53–57`); 08 §4.4 says three consecutive failures or five schema violations in 24 h | code at `088fe4d`, 08 §4.4 | **WP 5.1:** per-kind thresholds, 08's numbers for `local_model`, the current numbers unchanged for `builtin`. |
| **Found while writing this file:** the feed ranks with `applyAlertBudget` (`read.ts:307`), not `applyCatalogueBudget`, so 07 §3.2's learned `(1 − 0.5·dismiss_rate)` penalty is implemented (`advisors/ranking.ts:112`) and never applied; the dismissal reason is free text (`routes/insights.ts:337`) and the web dialog offers three presets that are not 07 §8.3's taxonomy (`apps/web/src/features/insights/DismissReasonDialog.tsx:12`) | code at `088fe4d` | **WP 5.9** (backend) and **WP 5.11** (the dialog). |
| **Found while writing this file:** the `local-llm` placeholder shares the `sidecar` network with Phase 6's placeholder (`compose.yml:676`, `:690`) | code at `088fe4d` | **WP 5.2** gives Ollama its own `internal: true` network. Whether a Phase 6 sidecar may ever reach the local model is Phase 6's decision, and it should be one somebody makes, not a default two placeholders inherited. |

---

## 3. Work packages

Same collision rules as Phases 1–4: disjoint path ownership, no dependency or lockfile edits by agents,
no commits (the orchestrator commits per package by explicit path after `just verify`), a separate
scratch database per agent, foreground waits only, **one agent on the compose stack at a time** — and in
Phase 5 that includes any live run against Ollama — agents write evidence and post their report before the
final verify, and the orchestrator finishes cheap kills. Phase 4 adds four rules, each learned at a cost
recorded in the execution log, and every brief carries them verbatim:

1. **No git state changes, and that means `stash`.** Named explicitly (2026-09-27 08:30).
2. **Every test that scans the tree, spawns a process, waits on a worker or talks to a model server —
   fake or real — declares its own timeout (30–60 s).** The 5 s default read as a failure three times in
   Phase 4 (2026-09-27 18:20). An Ollama request is the slowest thing this repo has ever awaited.
3. **`prettier --write` every `.json`/`.yml` an agent touches**, and the orchestrator runs
   `pnpm run lint:format` before the first `just check` after any `LEFTHOOK=0` snapshot.
4. **No performance number is believed while a model is loaded on the host.** A 7B model at 4-bit holds
   ~5 GB and saturates the cores it is given; `planning-perf` went red at load 6.85 in Phase 4 with nothing
   heavier than another agent's suite beside it.

Two structural reminders the Phase 4 quality pass paid for: the `insights`, `api` and `planning` vitest
projects collect `test/*.test.ts` **one level deep** (`vitest.config.ts`, the `include` of each), so a spec
under `test/brief/` is never run (wp4.14 §0 proved it empirically); and every new table is registered in
the export bundle or as a reasoned export deferral **in the same commit as its migration** — the
manifest-completeness test names an unregistered table the moment it exists (`322683e`).

| WP | Package | Model | Agent type | Depends on |
|---|---|---|---|---|
| 5.1 | Advisor run control: the four-level kill ladder made real, per-run cancel, the write barrier, the local-model lane, per-kind breaker, payload retention and the preview gate; migration 0028 | Opus | backend-architect | — |
| 5.2 | Local-endpoint egress policy, the Ollama adapter (`@advisor/local-model`), prompt construction and sanitisation, the `local-llm` compose profile and the sandbox harness | Opus | security-engineer | — |
| 5.3 | The narrator: the `local_model` advisor, grounded narration only, the findings envelope (contract 1.5.0), the narrow trace context, narrations linked not ranked, the ≥95% evaluation; migration 0031 | Opus | backend-architect | 5.1, 5.2, 5.7 |
| 5.4 | Red-team corpus (≥20 input payloads, ≥15 adversarial outputs) and harness, CI and live — independent of 5.2/5.3 | Opus | security-engineer | 5.3 |
| 5.5 | Planning: the earliest-retirement solver, and the engine's Phase 4 carries (one-off outflows, crypto sleeve, refresh transaction, guardrail rate as an assumption) | Opus | backend-architect | — |
| 5.6 | The Weekly Advisory Brief: assembly, dollar-first ranking, the retirement effect through a Planning port, persistence and the weekly schedule; migration 0032 | Sonnet | backend-architect | 5.5, 5.9 |
| 5.7 | Anomaly and fee hunter: `transactions.anomalies` and `fees.summary` (contract 1.4.0 + migration 0029), S1, S5, the fee hunter, the spending-wave release, the S6 tie-break | Sonnet | backend-architect | 5.1 |
| 5.8 | Health score with breakdown; migration 0033 | Sonnet | backend-architect | 5.7 |
| 5.9 | Dismiss-reason feedback loop, outcome verification, forward validation, rule health; migration 0030 | Sonnet | backend-architect | 5.1 |
| 5.10 | REST surface: the Brief, the health score, the run inspector, cancel, payload preview and approval, the kind switch, rule health | Sonnet | backend-architect | 5.1, 5.6, 5.8, 5.9 |
| 5.11 | UI: the Brief screen and dashboard card, the health score, the dismiss-reason taxonomy, the AI-assisted badge | Sonnet | frontend-architect | 5.10 contracts |
| 5.12 | UI: advisor management — scope grants over WP 4.8's consent route, kill states, run inspector, payload preview, cancel | Sonnet | frontend-architect | 5.10 contracts |
| 5.13 | Phase 4 carry-over package: the Phase 4 gate's conditions | Sonnet | backend-architect | Phase 4 gate verdict |
| 5.14 | Quality pass: exit-criteria audit, the kernel-stats migration, the seed-bound backtest, the cap-level sabotage, the live evaluations re-run | Sonnet | quality-engineer | all |
| Phase 5 gate | Independent security + architecture gate: sabotage every new control, walk the production stack with the `local-llm` profile to the Brief, kill a live run at each level, verdict to `docs/evidence/phase-5/gate-security-review.md` | Opus | security-engineer | all |

### WP 5.1 — Advisor run control (the serial gate)

**Scope.** Everything that decides *whether* an advisor runs, *keeps* running, and may *write*, made true
for an advisor that takes minutes rather than milliseconds. The ladder, with its default per level:

| Level | Mechanism | Scope | Default | Who flips it | Survives restart |
|---|---|---|---|---|---|
| 1 Module | `ADVISORS_ENABLED` (new config key) **and** `module.insights` (flag) | every advisor | on | operator (env) / user (flag) | yes |
| 2 Kind | `advisors.kind.local_model` (new flag) **and** `LOCAL_MODEL_ENDPOINT` unset ⇒ no local advisor registered | every `local_model` advisor | **off** | user, step-up / operator | yes |
| 3 Advisor | `advisors.enabled` (default `false`) **and** the breaker's `quarantined_at` | one advisor | off | user, step-up / the app | yes — rows |
| 4 Run | `POST /advisors/runs/{runId}/cancel` → `advisor_runs.cancel_requested_at`; the deadline | one run | — | user, step-up / the clock | n/a |

Below all four sits the physical one 08 §4.4 lists: `docker compose stop ollama`. It is not a level —
nothing records it — but it is how the gate proves "with the app unaffected", and WP 5.2 makes it fail
fast rather than hang.

Six changes make the table true. (1) **Kill switch 1 gets a config key** and both hardcoded `true`s go
(§2's last rows): an on-demand run with `module.insights` off is *refused, named*, and runs nothing.
(2) `decideRun` gains the kind input and a payload-approval input, and checks in blast-radius order —
global, module, kind, advisor, quarantine, approval — so the recorded refusal is the broadest that
applied (the existing rule, `policy/kill-switches.ts:76–84`). (3) **A run watcher**: while the untrusted
call is in flight, the run re-reads its own `cancel_requested_at` and every switch input at most once a
second and aborts its `AbortController` on any "no". Today the switches are read once, in transaction 1
(`service.ts:181–235`); a switch flipped mid-run changes the *next* run. (4) **The write barrier**:
transaction 2 re-reads every switch under a row lock on the `advisors` row before it writes, so a run
killed between the model's reply and the insert lands nothing, and closes `cancelled` with the level
named. (5) **The local-model lane**: a `local_model` advisor runs only as job kind `insights.run_local`
(concurrency 1), never through `insights.run` (concurrency 1 today, `jobs.ts:122`, which would queue every
builtin behind a three-minute model call) and never inline in the API — `POST /advisors/run` enqueues it.
The runner's global cap is four (`packages/platform/src/jobs/runner.ts:127`), so the lane holds at most one
slot of four, and the run holds **no database connection** across the model call (the existing
two-transaction shape; the watcher's reads are short). (6) **Per-kind breaker thresholds** — 08 §4.4's
three consecutive failures or five validator rejections in a rolling 24 h for `local_model`; the current
five/50% for `builtin` unchanged.

Two more belong here because they gate a run. **The payload preview gate** (03 §8.3: *"show Chris the exact
payload before the first send of any new query type"*): a *query shape* is `sha256` over the canonical
`{advisor_id, advisor_version, kind, sorted effective scopes, prompt_template_hash}`; a `local_model` or
`external` run refuses `payload_not_approved` until an `advisor_payload_approvals` row exists for the
current shape, and `previewRequest(advisorId)` builds the exact request — and, through a
`PromptRenderer` port 5.1 declares and WP 5.2 implements, the exact prompt bytes — **without invoking
anything**. For a local model the data never leaves the host, so the preview is consent and transparency
rather than egress control; it is built now because Phase 6's `external` advisor inherits the same gate.
**Payload retention for the inspector**: `advisor_run_payloads` keeps the canonical request for
`local_model`/`external` runs, 30 days, and the inspector re-digests it against `advisor_runs.input_digest`
— which is what makes "why did it say that?" answerable without trusting the stored bytes. Sealed with
`@core/secretbox` if §6 Q5 is answered yes; plain `jsonb` with the retention bound if not, and the evidence
says which.

Last, **`advisors.enabled_source`** (`default | user | feedback`): `registerAdvisor`'s conflict branch today
never touches `enabled` (`store.ts:154–171`), which is right for a user's choice and wrong for a default
that has never been touched — it means a wave released in a later phase never reaches an existing install.
With the column, a default follows the catalogue until a human (or WP 5.9's feedback loop) overrides it.
WP 5.7 is the first consumer. Owns the RUNBOOK section "Advisor kill switches" — the table above, each
level's command or screen, and what each looks like in `advisor_runs`.
**Owns.** `packages/contexts/insights/src/{service.ts,jobs.ts,preview.ts}`,
`packages/contexts/insights/src/policy/{kill-switches.ts,run-watch.ts}`, the `advisors` and `advisor_runs`
sections of `packages/contexts/insights/src/store.ts`, `packages/contexts/insights/schema/advisors.ts`,
`packages/db/migrations/0028_advisor_run_control.sql`, `dependenciesOf` and the run route in
`apps/api/src/routes/insights.ts`, the RUNBOOK "Advisor kill switches" section.
**Events.** Emits `insights.AdvisorRunCancelled`. **Migrations.** 0028.
**Exit tests.** `packages/contexts/insights/test/db/kill-ladder.test.ts` → `'each of the four levels, flipped while a run is in flight, ends the run within two seconds and writes no insight'` (one case per level, against a fake advisor that blocks until aborted), `'a run killed between the reply and the write lands nothing: the write barrier re-reads every switch'`, `'the refusal and the cancellation name the broadest level that applied'`; `test/kill-switches.test.ts` → `'decideRun runs only when every switch says yes'` (a `fast-check` property over every input combination); `apps/api/test/db/insights-routes.test.ts` → `'POST /advisors/run with module.insights off refuses and runs nothing'` (reproduced red first against `088fe4d`); `test/db/local-lane.test.ts` → `'a local-model run in flight does not delay a builtin run'`, `'a local_model advisor is never executed by insights.run or inline by the API'`, `'the lane holds no database connection while the model is called'`; `test/db/breaker-kinds.test.ts` → `'three consecutive local-model failures quarantine it; a builtin needs five'`; `test/db/payload-preview.test.ts` → `'a local-model run refuses until the current query shape has been previewed and approved'`, `'a changed scope set or prompt template is a new query shape and needs a new approval'`, `'the retained payload re-digests to the run's input_digest'`; `test/db/enabled-source.test.ts` → `'a changed catalogue default reaches rows nobody touched and never a row a human set'`.
**Evidence.** `docs/evidence/phase-5/wp5.1-run-control.md`: the ladder table with time-to-stop measured
per level; the hardcoded-`true` finding red, then green; the watcher's poll interval with its reason; the
lane's concurrency proof with both job timelines; a sabotage per level (watcher removed, barrier removed,
lane collapsed back into `insights.run`) observed red.

### WP 5.2 — The local endpoint, the Ollama adapter, the sandbox

**Scope.** Three things, each with its own boundary. **(1) A second egress policy type, not a switch on
the first.** `packages/platform/src/egress/policy.ts` refuses every non-public address and says in its
header that there is no switch for that, *"not even for tests"* (`policy.ts:74–82`). Ollama lives on a
private compose address, so it needs the inverse: `createLocalEndpointPolicy` in a new
`egress/local-endpoint.ts` — exactly one host and port; `http` permitted only because the connection never
leaves the host; **every** resolved address must classify `loopback` or `private` (link-local, and with it
the metadata range, is refused although it is not public); **any** public address refuses the whole
destination; the host must be a single-label compose service name unless `LOCAL_MODEL_ALLOW_REMOTE` is
set, and then only over `https` (§6 Q2); no redirects, a streaming byte cap, a deadline, and the
connection made to the address that was checked — the existing transport's rebinding defence, reused.
Classification reuses `classifyAddress` from `policy.ts`: 03 §5.2's lesson, that the second
implementation of an allow-list is where the hole is, applies to its inverse too. Inside compose,
"loopback" in the literal sense is unreachable across containers, so the enforced property is **"never a
public address, and on an internal network"** — the brief's "refuse any non-loopback host" read as what
it protects rather than as a string.

**(2) The adapter, `@advisor/local-model`** (`packages/advisors/local-model/`, the `@connector/*` shape:
a package per external system, denied `@ctx/*` by the boundary rule so the insights layer keeps its
promise of *"no LLM client"*, `scripts/eslint-boundaries.js:470–474`). `renderPrompt(request)` is pure: a
system region carrying the grounding rules, and an `<untrusted_data>` block holding the canonical JSON of
the findings and the granted snapshot — never interpolated into the instruction region (03 §8.2). Before
anything enters the block: NFKC; C0/C1 controls stripped except `\n`/`\t`; zero-width (U+200B–U+200F,
U+2060–U+2064, U+FEFF) and bidi controls (U+202A–U+202E, U+2066–U+2069) stripped; anything that could close
or reopen the fence removed; the contract's own length caps enforced again; high-signal injection patterns
(`ignore previous`, `system:`, `[INST]`, base64 runs over 64 characters) **flagged into the run's
diagnostics and still removed** — 03 §8.2: *"Log and flag rather than silently mangle."* The request to
Ollama is `POST /api/chat` with `stream`, a `format` JSON Schema for the narration shape (Ollama's
structured output — a convenience, never trusted: WP 2.6's validator runs regardless), `temperature: 0`,
a fixed `seed`, and bounded `num_ctx`/`num_predict`. The reply is read under the byte cap as it arrives and
wrapped into an `AdvisorResponse` whose envelope — `request_id`, `advisor_id`, `contract_version` — the
adapter writes from the request, so a model cannot forge it. **The model is pinned by digest** like an
image: before a run, the served model's digest (`GET /api/tags`) must equal `LOCAL_MODEL_DIGEST` or the
run refuses `model_digest_mismatch` without sending a prompt; a tag that moved is a different model, and
the ≥95% measured on one says nothing about another. **Logging** carries shape, byte size, digest and
durations — never a prompt, a reply or a snapshot byte (03 §8.3).

**(3) The profile and the sandbox.** `local-llm-placeholder` (`compose.yml:683–695`) becomes `ollama`:
upstream `ollama/ollama` pinned by digest (MIT; a third-party image, the D13/D23 posture), profile
`local-llm`, on a new `llm` network (`internal: true`) and nothing else; `worker` joins `llm`; `api` does
not (it runs no local model — WP 5.1's lane). Non-root, `read_only` with a single `ollama_models` volume
and a `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit`/`cpus`/`pids_limit` sized from a
measurement on this host, no secret mounted, no published port, a healthcheck, and no debug logging
(prompt content appears in Ollama's own log only at debug level; the gate greps for a canary rather than
trusting that). Models are pulled **only** by a one-shot `ollama-pull` under a separate `local-llm-pull`
profile on its own non-internal network that reaches neither `backend` nor `llm`'s peers — the one moment
the model runtime touches the internet, operator-initiated, digest recorded. `scripts/compose-hardening-check.sh`
learns the `ollama` rules and its hostile fixture learns to break each. Owns the RUNBOOK section "Local
model (profile `local-llm`)": pull, pin, configure, start, stop, and what each kill looks like from here.
**Owns.** `packages/advisors/local-model/**`, `packages/platform/src/egress/local-endpoint.ts` and its test,
the `local-llm` block, the `llm` network and `worker`'s `networks` line in `compose.yml`,
`scripts/compose-hardening-check.sh` and `scripts/fixtures/compose-hostile.yml` (the `ollama` cases only),
the RUNBOOK "Local model" section.
**Events.** None. **Migrations.** None.
**Exit tests.** `packages/platform/src/egress/local-endpoint.test.ts` → `'a name resolving to any public address is refused'`, `'a dotted hostname is refused unless remote is explicitly allowed, and then only over https'`, `'link-local and the metadata range are refused although they are not public'`, `'a redirect is never followed'`, `'the connection goes to the address that was checked, not a second resolution'`; `packages/advisors/local-model/test/prompt.test.ts` → `'every untrusted string reaches the prompt only inside the delimited block'`, `'a payload that tries to close the fence cannot'`, `'zero-width, bidi and control characters are removed and the removal is flagged, not silent'`, `'the rendered prompt is byte-identical for an identical request'` (the preview gate hashes it); `test/ollama-client.test.ts` (a real local HTTP server, explicit timeouts) → `'a reply over the byte cap is aborted while it arrives'`, `'an aborted signal closes the socket to the server mid-generation'`, `'a served model whose digest differs from the pinned one is refused before any prompt is sent'`, `'no prompt, reply or snapshot byte reaches the logger'` (a canary in the snapshot, the logger captured); `test/structure.test.ts` → `'the adapter imports no node builtin and calls no global fetch'`; `scripts/compose-hardening-check.sh --self-test` → the hostile fixture's `ollama` on `backend`, publishing a port, running as root or mounting a secret is refused.
**Evidence.** `docs/evidence/phase-5/wp5.2-local-model.md`: the policy table beside `policy.ts`'s; from
inside the container, `getent hosts db` failing, an outbound fetch failing, `env` and `/run/secrets` empty,
`docker inspect` per 03 P0-7; the pinned model and image digests; RSS and tokens/s on this host; one
rendered prompt from the seed with the delimited block marked; a trivy scan of the pinned image (CI gains
it only if it is clean enough to gate on; otherwise the gate rules); why no Ollama SDK (§4 item 10).

### WP 5.3 — The narrator: grounded narration only

**Scope.** The first `local_model` advisor, `local.narrator`: `kind: 'local_model'`,
`narrates_only: true`, `produces_impact: false`, `deterministic: false`, `confidence_basis: 'model'`, no
`proposed_actions` of its own, empty `egress_allowlist` — each of which WP 2.6's capability step already
enforces (`validate/pipeline.ts:270–306`). What is new is what it is given and what it may say.

**What it is given — the findings envelope, contract 1.5.0.** The narrator cannot narrate a finding it
never sees, and today the request carries scopes only. `AdvisorRequest.findings` (optional, present only
for `narrates_only` advisors): per finding its key, type, severity, title, summary, evidence rows (label,
value, `source_ref`), derived values and impact display strings, resolvable through a new `finding:`
ref namespace in `validate/evidence.ts`. It is an envelope field and not a scope, so it needs a contract
minor and regenerated published schemas but **no** `snapshot_grants` migration —
`apps/api/test/phase3-registration.test.ts` tracks scopes, and the parity test says so either way.
**The laundering rule**: a finding enters a narrator's request only if the scopes its source run emitted
are a subset of the narrator's own effective grant — otherwise a narrator granted `cash.summary` could
read `holdings.detail` through a finding built from it.

**What it may say — the narrow trace context.** For a `narrates_only` advisor, step 7's candidates are
**the narrated finding's own rendered figures** — its evidence values, derived values and impact strings,
matched verbatim as rendered — and not every number in the snapshot under six renderings. This is the
§1 finding made into a control: the traceable-but-wrong figure passes a snapshot-wide trace and fails this
one. A narration must also carry the finding's own `type` **and** `key` (1:1 — `service.ts` supplies
`knownFindingTypes`, which it has never done, §2), cite a subset of the finding's own evidence refs, and
sit at or below its finding's severity. If the red team (WP 5.4) gets a misattributed figure through even
this, the escalation is recorded rather than improvised: slot references the app fills, so the model never
writes a digit at all.

**Where it lands — linked, never ranked.** Migration 0031 adds `insights.narrates_insight_id` (a
user-scoped composite FK within `insights`). A narration never takes a feed, dashboard or Brief slot of its
own; the builtin's card and the Brief item carry it as alternative wording under an **"AI-assisted
wording"** badge (07 §7.5 rule 3) with the template text one click away, and **every figure displayed is
the builtin's**. A rejected narration costs nothing: the builtin's text stands (07 §7.5 rule 1, *"fall
back to the deterministic template"*). **No retry-until-valid loop** — re-asking until the validator
agrees would launder the very rate the third exit criterion measures. `advisor_runs.llm_model` and
`llm_prompt_hash` (07 §7.3) are filled from the pinned digest and the rendered prompt's hash.
`redactDigits`: implemented for the kinds that read free text, or the flag deleted with its reason (§2).

**The ≥95% measurement.** `scripts/advisor-eval.ts` runs the narrator over a fixed set of findings drawn
from the correctness seed and WP 4.13's scale seed — at least 20 distinct findings, at least 100
narrations — and reports first-attempt acceptance **per step**, steps 1–5 (the criterion's
"evidence-ref validation") and 1–7 beside it, because a narrator that cites correctly and invents numbers
40% of the time passes the letter of the criterion and is useless. CI runs it against a recorded-reply
fake; the exit number is measured once against the pinned model on this host and recorded with the model
digest, `temperature`, `seed` and the date.
**Owns.** `packages/contexts/insights/src/advisors/local/**`,
`packages/contexts/insights/src/validate/{pipeline.ts,numerals.ts,evidence.ts}`,
`packages/contexts/insights/src/contract/{request.ts,version.ts,json-schema.ts}`,
`packages/contracts/advisor/v1/*.schema.json` (regenerated), the findings-assembly and
`knownFindingTypes` lines of `packages/contexts/insights/src/service.ts`, `packages/contexts/insights/src/read.ts`
(narrations excluded from the feed), `packages/db/migrations/0031_insight_narrations.sql`,
`scripts/advisor-eval.ts`.
**Events.** None new; narrations do not emit `InsightProposed` (a narration is not a finding).
**Migrations.** 0031.
**Exit tests.** `packages/contexts/insights/test/narrator.test.ts` → `'a narration may use only the figures of the finding it narrates: a real snapshot value from elsewhere is rejected'` (the §1 finding, reproduced red against the snapshot-wide trace first), `'a narration of a finding the builtins did not make is rejected'`, `'a narrator cannot claim deterministic, carry impact, propose an action or rise above its finding's severity'`, `'a finding whose source scopes the narrator was not granted never enters its request'`; `test/db/narration-link.test.ts` → `'a narration never takes a feed, dashboard or Brief slot of its own'`, `'a rejected narration leaves the builtin's text in place and the run records the step'`; `test/contract-parity.test.ts` → `'the published schemas match the source at 1.5.0'`; `test/eval-harness.test.ts` → `'the harness counts first-attempt acceptance per step, and a scripted one-in-ten fabricator reads 90%'` (the harness's own control).
**Evidence.** `docs/evidence/phase-5/wp5.3-narrator.md`: the trace context before and after, with the
number of snapshot candidates a narrator could match under each; the laundering rule's table; five
narrations beside their templates; the live evaluation with model digest, date and per-step counts — the
third exit criterion's number.

### WP 5.4 — Red-team corpus and harness

**Scope.** 03 §6.1 gives the red-team corpus to the security engineer, and the master plan's §6.4 draws
it as a parallel lane (*"LLM advisor ∥ Brief UI ∥ red-team corpus"*). It is a separate package, written by
someone who wrote neither 5.2 nor 5.3, because a corpus written by the author of the defence tests what
the author thought of. **Input corpus, ≥20 payloads, each naming its vector:** merchant descriptors and
memo fields (which D22's tokenisation should keep out of the prompt entirely — `snapshot/tokens.ts:31–35`
tokenises merchants for every kind — so the assertion is *absence*, not escaping), crypto token symbols
(provider- and chain-controlled, ≤16 characters, `contract/snapshot.ts:305`), category slugs, goal names
(the holder's own text, ≤96, `contract/snapshot.ts:630`), fence-closing sequences, zero-width and bidi
smuggling, `[INST]`/`system:` role injection, base64-wrapped instructions, and instructions to invent a
figure, raise a severity, add an action or cite a link. **Output corpus, ≥15 adversarial replies** a
maximally obedient model would produce: a traceable-but-wrong figure, an off-finding ref, a finding the
builtins never made, `deterministic` claimed, impact claimed, an `execute`-shaped action, a markdown link
outside any allow-list, a forged `request_id`, an oversized body, extra properties, and a reply that is not
JSON. Each entry names the step that must refuse it. **The CI harness** builds requests through the real
`SnapshotBuilder` over a seed with the payloads injected at their sources, renders through the real
`renderPrompt`, and drives a scripted adversarial model through the real narrator and the real
`validateResponse`. **The live pass** (`scripts/redteam-live.ts`) runs the input corpus against the
pinned model on the stack and records, per payload, whether the model's reply showed instruction-following
at all — and, independently, whether anything schema-valid with a fabricated figure survived, which is the
exit criterion. Defects found are reported to the orchestrator as findings, not fixed here.
**Owns.** `apps/api/test/redteam.test.ts`, `apps/api/test/fixtures/redteam/**`, `scripts/redteam-live.ts`.
**Events.** None. **Migrations.** None.
**Exit tests.** `apps/api/test/redteam.test.ts` → `'the corpus has at least twenty input payloads and fifteen adversarial replies, and each names its vector and its expected step'`, `'no corpus payload reaches the prompt outside the delimited block'`, `'no merchant descriptor or memo from the corpus reaches the prompt at all'`, `'every adversarial reply is refused at the step the corpus predicts'` (the gate diffs predicted against observed), `'zero schema-valid insights carry a figure that is not the narrated finding's own'` — the second exit criterion, in CI.
**Evidence.** `docs/evidence/phase-5/wp5.4-redteam.md`: the corpus table (payload, vector, expected
step, observed step); the live pass against the pinned model with instruction-following observed per
payload; each input defence sabotaged once (fence stripping off, NFKC off, the narrow trace widened back
to the snapshot) and the harness observed red.

### WP 5.5 — Planning: the retirement-date solver and the engine's carries

**Scope.** **The solver.** `engine/retirement-date.ts`: `earliestRetirementAge(prepared, extra)` — the
first whole-year retirement age at which the `sustain` objective holds, by the monotone search `solve.ts`'s
header already argues is valid, re-verified by running its answer through the engine the way the
contribution solver does. It returns the baseline age, the age with the action (an extra annual
contribution, or a one-off this year), the delta in whole years, and — because most single actions move no
whole year — **months of retirement spending funded**: the engine's own real-wealth difference at the
planned retirement age divided by the plan's first-year retirement spending, declared as a derivation.
Never an interpolated month; `unreachable` with its binding constraint when the plan sustains at no age in
range. **The carries** (§2): dated one-off outflows through the one boundary crossing; the crypto sleeve
through the `MonteCarloRunner` port and the bucket split; the refresh job's transaction split into read,
compute outside any transaction, write; `GUARDRAIL_REFERENCE_RATE` into the assumptions file **with the
previous file version retained frozen**, so stored overrides resolve and old runs read stale with their
version named; `monteCarloMarketFrom(assumptions)` into `boundary.ts` and the `CITED` accessor deleted;
REIT's behaviour decided and pinned; the stale seed-range comments. Every change that moves an engine
output bumps its version and re-runs WP 4.14's reference cases and golden drift, which must stay inside
1% and 0.5 pp or the evidence says why they moved.
**Owns.** `packages/contexts/planning/src/engine/{retirement-date.ts,boundary.ts,deterministic.ts,worker-host.ts}`
(the named changes only), `packages/contexts/planning/src/{projection-service.ts,jobs.ts,ports.ts,assumptions.ts}`
(the named changes only), `packages/contexts/planning/data/assumptions.ts` and the frozen predecessor beside it.
**Events.** None new. **Migrations.** None.
**Exit tests.** `packages/contexts/planning/src/engine/retirement-date.test.ts` → `'the earliest retirement age is the first whole year the plan sustains, and the year before it does not'`, `'an action too small to move a whole year reports no change and never an interpolated fraction'`, `'months of spending is the engine's own wealth difference over planned spending, declared as a derivation'`; `src/engine/deterministic.test.ts` → `'a dated one-off outflow reduces wealth by exactly its amount grown from its year'`; `test/reference.test.ts` → `'every committed reference case matches within 1%'` (unchanged, re-run); `test/db/projection-store.test.ts` → `'a stored negative life event is applied and no longer listed as unapplied'`, `'a crypto holding reaches the Monte Carlo as its own sleeve'`; `test/db/refresh-tx.test.ts` → `'the refresh job holds no transaction while the engine runs'`; `test/assumptions.test.ts` → `'the guardrail reference rate is a cited, overridable assumption'`, `'an override stored against the previous file version still resolves and its runs read stale with that version named'`.
**Evidence.** `docs/evidence/phase-5/wp5.5-planning.md`: the solver walked on the seed plan with every
bisection step; a table of five catalogue actions with their whole-year and months-of-spending effects;
the one-off on 4.5's design with its arithmetic; reference and golden-drift numbers before and after; the
client-kernel divergence stated (§2).

### WP 5.6 — The Weekly Advisory Brief

**Scope.** 09 ADV-1, S1 and E11's edge cases, over the rows WP 2.6's validator already accepted.
**Assembly**: pending, unsuppressed, unexpired builtin insights with a proposed action and a resolvable
evidence panel — narrations excluded (5.3), below-floor excluded. **Ranking by dollar impact**, not by
severity: 07 §3.2's `effective impact × confidence × actionability × urgency × (1 − 0.5·dismiss_rate)`
with WP 2.7's factor functions reused and `rank()`'s severity-dominant term (`alert-budget.ts:113–120`)
left out — that term is right for a dashboard that must lead with what hurts, and wrong for a list whose
promise is "ranked by dollar impact". Ties break on severity, then key. **≤5 actions**, no rule family
holding more than two (E11: *"Ranking must not be dominated by one noisy category"*). **Urgent findings
with no dollar figure** — an overdraft ahead, a duplicate charge, a missed payment — go to an attention
strip above the five, never displace a ranked action, and are never dropped by a tie-break. A finding
carried from last week is marked **carried**, not new (E11). A week with nothing material **says so**
and invents nothing (ADV-1, principle 3). Under 30 days of history, the Brief limits itself to what is
computable and names what it cannot yet assess (E11 cold-start).

**The retirement effect** comes through `RetirementImpactPort`, declared by Insights in
`brief/ports.ts` and bound in `apps/api/src/domain.ts` over WP 5.5's solver — 08 §1.6's arrows point
down, and Insights reads Planning only through a port bound at the composition root, as
`createInsightsPlanningPort` already does. An item's annualised impact becomes an extra annual
contribution to the baseline plan from now to retirement, a one-time impact a one-off this year, under a
stated assumption printed on the item (*"if the saving is invested in your plan"*); the answer carries the
engine and assumptions versions that produced it, and an item with no dollar figure, or a holder with no
baseline, carries `not_computable` with its reason and **no figure**. The effect is secondary and never
the rank key (07 §3.2: *"never compound speculative returns into the headline number"*). **Persistence**:
`advisory_briefs` and `advisory_brief_items`, one Brief per ISO week, immutable once published — a Brief is
a record of what was said, and "why did it say $720?" (07 §7.3) applies to the Brief as much as to an
insight. Schedule `insights.weekly_brief` (**the name matches `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`** — the
Phase 2 worker crash-loop), Sunday 06:00 local, after the 04:15 advisor pass and the 04:30 projection
refresh; job kind `insights.brief`; the narration of its items is enqueued on `insights.run_local` after
publication, so **the Brief never waits on the model**.
**Owns.** `packages/contexts/insights/src/brief/**`, `packages/contexts/insights/schema/briefs.ts`,
`packages/db/migrations/0032_advisory_briefs.sql`, a new `createInsightsRetirementImpactPort` appended to
the insights port block of `apps/api/src/domain.ts`, `apps/api/test/db/brief-retirement-port.test.ts`.
**Events.** Emits `insights.BriefPublished`. **Migrations.** 0032.
**Exit tests.** `packages/contexts/insights/test/brief.test.ts` → `'the Brief holds at most five actions ranked by dollar impact times confidence, not by severity'`, `'no rule family takes more than two of the five'`, `'an urgent finding with no dollar figure goes to the attention strip and is never dropped by a key tie-break'`, `'a week with nothing material says so and invents no filler'`, `'a finding carried from last week is marked carried, not new'`, `'no Brief headline is a compounded speculative return'`; `test/brief-retirement.test.ts` → `'a retirement effect is only ever the port's answer: an item without one says not computable and shows no figure'`; `test/db/brief.test.ts` → `'the Brief is idempotent per ISO week and immutable once published'`, `'every retirement effect on a published Brief names the engine and assumptions versions that computed it'`; `apps/api/test/db/brief-retirement-port.test.ts` → `'the bound port reproduces a direct engine run for the same plan exactly'`.
**Evidence.** `docs/evidence/phase-5/wp5.6-brief.md`: one Brief built on the seed with every candidate,
its score's factors and why it did or did not make the five; the retirement effect for each item beside a
direct engine run; the nothing-material and cold-start Briefs; the idempotence proof across two runs of the
same week.

### WP 5.7 — Anomaly and fee hunter

**Scope.** 09 ADV-5 and ADV-8. **Two new scopes, advisor contract 1.4.0, and migration 0029 in the same
commit** — `apps/api/test/phase3-registration.test.ts` fails the build on a scope the database would refuse
to store a grant for, and nothing fails the build on a scope added without the contract bump, so the brief
says both (04 §3 WP 4.9, unchanged). **`transactions.anomalies`** (sensitivity 8, `externalAllowed: false`):
only the flagged rows — reference, date, category slug, merchant pseudonym, **exact** amount, the baseline
median, the MAD-scaled deviation and its multiple, `first_seen_merchant`, `duplicate_of`, fee type — and
never an unflagged row. The pre-triggered aggregate is `holdings.aggregate`'s `idle_cash` precedent: the
threshold is applied in-process so the per-row distribution never crosses. **`fees.summary`** (sensitivity
5): fees by type and by account reference over twelve months with counts, the avoidable subset
(overdraft, NSF, ATM, foreign-transaction, late, maintenance — interest charges are the D family's), and
the fund expense-ratio drag summed from `holdings.detail` rather than recomputed. Both arms are computed in
`SnapshotBuilder` from `LedgerPort.listTransactions` — rules live in the builder (`snapshot/ports.ts:125–133`
says why) — with `accountId` added to `InsightsTransaction` and its one select in `createInsightsLedgerPort`.
Baselines use a new `packages/kernel/src/stats.ts` (exact bigint median and MAD; §2's duplication row).
**Rules**: S1 and S5 leave `CATALOGUE_GAPS` (`catalogue.ts:393–406` names exactly the fields these scopes
supply); `builtin.spending.fee_hunter` totals fees by type, names the worst offender, and states the
avoidable annual cost. Thresholds: >3 robust deviations and above a **$25 materiality floor** (09 Q17 and
ADV-5; 07 S1 says $100, and the Brief's own $50 floor still applies to ranking). A pending charge that
posts raises one anomaly, not two (09 NOT-5; the surrogate id survives posting, D10). **The release**: a new
`'anomalies'` wave; S1, S5, the fee hunter and the whole spending wave (S2, S3, S6, S7, S9, S10) default
on, reaching existing installs through WP 5.1's `enabled_source` — the Phase 3 ruling that 07 §7.4's
stagger is operator pacing applies unchanged (`catalogue.ts:111–138`). And **the S6 tie-break** (§2):
`rank()` gains a P0-safety term so a no-dollar urgent finding never loses a dashboard slot to key order.
**Owns.** `packages/contexts/insights/src/contract/{scopes.ts,snapshot.ts,version.ts,json-schema.ts}`,
`packages/contexts/insights/src/snapshot/{builder.ts,ports.ts}` (the two arms and the `accountId` field),
`packages/contexts/insights/src/advisors/builtin/anomaly/**`, `packages/contexts/insights/src/advisors/catalogue.ts`,
`packages/contexts/insights/src/policy/alert-budget.ts` (the tie-break only), `packages/kernel/src/stats.ts`,
`packages/contracts/advisor/v1/*.schema.json`, `packages/db/migrations/0029_snapshot_grant_scopes_v1_4.sql`,
the one select in `createInsightsLedgerPort` in `apps/api/src/domain.ts`.
**Events.** Emits `insights.InsightProposed` via WP 2.6. **Migrations.** 0029.
**Exit tests.** `packages/contexts/insights/test/anomaly.test.ts` → `'a charge more than three robust deviations above its twelve-month norm and above the $25 floor raises S1 with the baseline shown'`, `'a $24 outlier and a 2.9-deviation charge raise nothing'`, `'a pending charge that posts raises one anomaly, not two'`, `'an unflagged transaction never appears in the anomalies block'`; `test/fee-hunter.test.ts` → `'fees are totalled by type and by account over twelve months, the worst offender named, and interest excluded from avoidable'`, `'expense-ratio drag comes from holdings.detail and is never recomputed'`; `test/scope-minimization.test.ts` → `'transactions.anomalies is never emitted to an external advisor and carries no unflagged row'`; `test/contract-parity.test.ts` → `'the published schemas match the source at 1.4.0'`; `apps/api/test/phase3-registration.test.ts` → `'every advisor scope can actually be granted'` (stays green with 0029); `test/alert-budget.test.ts` → `'an urgent finding with no impact is never dropped from the dashboard by key order'` (reproduces wp4.9 §12 item 1 red first); `packages/kernel/src/stats.test.ts` → `'the median and MAD are exact over bigint and never pass through a float'`.
**Evidence.** `docs/evidence/phase-5/wp5.7-anomaly-fees.md`: each new rule firing on the seed with its
baseline; the fee hunter's table; both scope blocks rendered with every identifier stripped; the 1.4.0 diff
shown additive; the 0029 CHECK beside 0024's; the S6 tie-break red then green.

### WP 5.8 — Health score with breakdown

**Scope.** 09 ADV-7 and the benchmark row that says a bare score violates P2 (09 §4, benchmark row 20). Six named
components, each with its value, band, weight, component score and **direction of travel against the
previous stored week**: emergency-fund months (`cash.summary`), savings rate (`plan.projection`'s observed
rate, or `cashflow.monthly`), debt-to-income (`liabilities.terms` minimums over income), subscription load
(`recurring.list` annualised over take-home), diversification (`holdings.aggregate`'s top-position share),
fee drag (`fees.summary`). A component with no data is **excluded and named**, never scored as zero; the
weights renormalise over the computable ones; the overall number never appears without its breakdown.
Band thresholds live in a cited data file beside the code, each with a source string (the WP 4.2 rule,
applied one context over). Pure over an `AdvisorSnapshot`, so it is deterministic and reads only
builtin-sourced blocks — 09 TRD-6 keeps any future sidecar's signals out by construction. Computed with the
Brief each week and stored in `health_scores`. Cut-order item 2 (§1).
**Owns.** `packages/contexts/insights/src/health/**`, `packages/contexts/insights/schema/health.ts`,
`packages/db/migrations/0033_health_scores.sql`.
**Events.** None. **Migrations.** 0033.
**Exit tests.** `packages/contexts/insights/test/health.test.ts` → `'the score decomposes into six named components, each with value, weight and direction'`, `'a component with no data is excluded and named, never scored as zero'`, `'the weights sum to one over the computable components'`, `'the same snapshot always yields the same score'`; `test/db/health.test.ts` → `'direction of travel compares against the previous stored week, and the first week says so'`.
**Evidence.** `docs/evidence/phase-5/wp5.8-health.md`: the score on the seed with every component's
arithmetic; the thresholds table with sources; the excluded-component case.

### WP 5.9 — The dismiss-reason feedback loop

**Scope.** 07 §8.3, and the only rule tuning this repo can do without a bitemporal store (§1 cut line 2).
**The taxonomy**: `reason_code` on `insight_feedback` — `NOT_TRUE`, `ALREADY_KNOW`, `NOT_ACTIONABLE`,
`DONT_CARE`, `WRONG_AMOUNT`, `INTENTIONAL`, `LATER` — beside the existing free-text `reason`, which becomes
the note (expand, never contract: the three preset strings the web dialog has been storing map to codes by
exact match, and anything else keeps its text with a null code). **Each reason's effect, as 07 assigns
it**: `NOT_TRUE` counts toward the rule's rate and, above 0.2 over at least five firings, quarantines the
advisor with a new reason `not_true_rate` — *"disable the rule; it's broken, not noisy"*; `ALREADY_KNOW`
skips to the 90-day rung; `NOT_ACTIONABLE` feeds the dismiss penalty; `DONT_CARE` switches the rule off
for this holder (`enabled_source = 'feedback'`, undoable); `WRONG_AMOUNT` flags the insight's derivations
and digest for review on rule health; `INTENTIONAL` suppresses that entity permanently; `LATER` is a
snooze. **The feed finally ranks with the learned penalty** (`read.ts:307` → the catalogue budget, §2).
**Outcome verification** (09 ADV-4): an accepted finding still re-proposed after its horizon (60 days
default) raises exactly one follow-up and records `INCOMPLETE`; one not re-proposed records `ACTED`.
**Forward validation**, the §1 substitute for a backtest: at its horizon a finding is judged only against
proposals made *after* it — never a row learned before — and the per-rule precision it accumulates is on
rule health from the day this lands. **Rule health**: per advisor, firings, accepted, dismissed by reason,
`NOT_TRUE` rate, verified outcomes.
**Owns.** `packages/contexts/insights/src/policy/{feedback.ts,cooldown.ts,outcomes.ts,rule-health.ts}`, the
feedback section of `packages/contexts/insights/src/store.ts`, `packages/contexts/insights/src/read.ts`
(the feed's ranking), `packages/contexts/insights/schema/insights.ts`, the `QUARANTINE_REASONS` line of
`packages/contexts/insights/schema/advisors.ts`, `packages/db/migrations/0030_insight_feedback_reasons.sql`,
the review body in `apps/api/src/routes/insights.ts`.
**Events.** None new; quarantine reuses `AdvisorRunFailed`'s path. **Migrations.** 0030.
**Exit tests.** `packages/contexts/insights/test/feedback.test.ts` → `'each of the seven reasons has exactly the effect 07 §8.3 assigns it'`, `'a rule with a NOT_TRUE rate above 0.2 over five or more firings is quarantined with that reason'`, `'DONT_CARE switches the rule off for this holder and a human can switch it back'`, `'a dismissal with no reason code is still a dismissal and advances the ladder'`; `test/db/outcomes.test.ts` → `'an accepted finding still proposed after its horizon raises exactly one follow-up'`, `'forward validation reads only proposals made after the insight, never before'`; `test/ranking.test.ts` → `'the feed ranks with the learned dismiss penalty, and a rule with no history ranks on its merits'`; `test/db/feedback-migration.test.ts` → `'the three stored preset reasons map to codes and every other stored reason survives as a note'`.
**Evidence.** `docs/evidence/phase-5/wp5.9-feedback.md`: the reason table with each effect demonstrated;
the migration of existing reasons with row counts; rule health on the seed after a scripted month of
feedback; what forward validation can and cannot say, stated before anyone reads a number off it.

### WP 5.10 — REST surface

**Scope.** Phase 2's lesson applied for the fourth time: the routes package is dispatched with the wave
its backends land in, and it names every scoping predicate. Under the existing `/insights` and
`/advisors` prefixes, so `docker/Caddyfile`'s `handle_path /api/*` namespace needs no edit:
`GET /insights/brief/current`, `GET /insights/brief/{isoWeek}`, `GET /insights/health-score`,
`GET /advisors/{id}/runs`, `GET /advisors/runs/{runId}` (the inspector: `inputDigest`, granted and emitted
scopes, per-step rejections, duration, model and prompt hash, cancellation level, the retained payload
when present with **`digestVerified` recomputed server-side**), `POST /advisors/runs/{runId}/cancel`
(step-up), `GET /advisors/{id}/payload-preview` (session; sends nothing), `POST /advisors/{id}/payload-approvals`
(step-up; carries the shape hash the preview returned and refuses if the shape has changed since — the
approval is for what was shown), `PUT /advisors/kinds/{kind}/enabled` (step-up), `GET /advisors/rule-health`.
A Brief item's money is `{ "minor": "…", "currency": "USD" }` and its months-of-spending a decimal string,
never a JSON number. Cross-user sabotages follow §5 item 8.
**Owns.** `apps/api/src/routes/{brief.ts,advisor-runs.ts}`, additions to `apps/api/src/routes/deps.ts` and
`apps/api/src/app.ts`.
**Events.** None emitted. **Migrations.** None; **0034** is reserved and used only if reported necessary.
**Exit tests.** `apps/api/test/db/brief-routes.test.ts` → `'every route refuses another user's data with each scoping predicate dropped individually and together'`, `'a Brief item's retirement effect is served exactly as stored and never recomputed on read'`; `apps/api/test/db/advisor-runs-routes.test.ts` → `'the inspector reports digestVerified false when a retained payload was altered'`, `'cancelling a run needs a fresh session and reaches only the caller's run'`, `'an approval for a shape that changed since its preview is refused'`, `'the preview route sends nothing to the model'` (a counting fake endpoint).
**Evidence.** `docs/evidence/phase-5/wp5.10-routes.md`: the route table with step-up and every scoping
predicate per row; the multi-predicate sabotage matrix; the OpenAPI diff; **the `just check` output
appended**.

### WP 5.11 — UI: the Brief and the health score

**Scope.** `_app.brief.tsx`, a new route and a Sidebar entry, and a Brief card on the dashboard beside
`TopInsightsWidget`. At most five cards: headline, one dollar figure, the retirement effect —
*"retire N years earlier"*, or *"no change at yearly resolution · funds about N months of retirement
spending"*, or *"not computable: <reason>"* — one primary action, and the **"Why am I seeing this?"**
panel reusing `features/insights/EvidencePanel.tsx`; an item with a narration shows the AI-assisted badge
with the template text one click away. The attention strip; the nothing-material and cold-start states;
07 §7.2's disclaimer verbatim. The health score: the overall figure only beside its six rows, each with
value, weight and direction **in words as well as a glyph** (never colour alone, WCAG 2.2 AA), excluded
components named. `DismissReasonDialog.tsx`'s three presets become 07 §8.3's seven, sent as `reasonCode`.
Self-hosted only; no CSP directive may widen.
**Owns.** `apps/web/src/routes/_app.brief.tsx`, `apps/web/src/features/{brief,health}/**`,
`apps/web/src/features/insights/{DismissReasonDialog.tsx,InsightCard.tsx}`, `apps/web/e2e/brief.spec.ts`,
the one nav line in `apps/web/src/app/shell/Sidebar.tsx`. May not touch `e2e/support/mock-api.ts` or
`app-walkthrough.spec.ts`.
**Exit tests.** `features/brief/*.test.tsx`, `features/health/*.test.tsx` unit; `e2e/brief.spec.ts` → `'the Brief shows at most five actions, each with a dollar figure and a retirement effect or a stated reason it has none'`, `'a narrated item shows the AI-assisted badge and the template text is one click away'`, `'a week with nothing material says so plainly'`, `'every health component shows value, weight and direction in words'`, `'dismissing asks for one of seven reasons and the code reaches the API'`; axe clean on both themes.
**Evidence.** `docs/evidence/phase-5/wp5.11-brief-ui.md`: screenshots in both themes; the axe run; every
number on screen traced to the API field it came from — no client-side money math beyond formatting.

### WP 5.12 — UI: advisor management

**Scope.** `AdvisorsSettings` moves from the Insights screen (`features/insights/InsightsScreen.tsx:94`)
to `/settings/advisors`, 05 §4.1's settings tree, and grows: each advisor with its kind and all four
levels' state, explained in words; the kind switch; **scope grants over WP 4.8's consent route**, each
scope showing what it yields and what it drops, in sensitivity order, before the step-up (the route already
returns both, `apps/api/src/routes/advisor-grants.ts:138–150`); **the run inspector** — runs per advisor,
then one run's `input_digest`, the verified mark, emitted scopes, per-step rejections, model and prompt
hash, cancellation level; **the payload preview** before the first send, showing the exact bytes with the
untrusted block marked, and the step-up approval; **cancel** on an in-flight run.
**Owns.** `apps/web/src/routes/_app.settings.advisors.tsx`, `apps/web/src/features/advisors/**`,
`apps/web/src/features/insights/{AdvisorsSettings.tsx,InsightsScreen.tsx}` (the move only),
`apps/web/e2e/advisors.spec.ts`.
**Exit tests.** `features/advisors/*.test.tsx` unit; `e2e/advisors.spec.ts` → `'granting a scope shows what it yields and what it drops before the step-up'`, `'the payload preview shows the exact bytes the model would receive, and approval comes before the first run'`, `'the run inspector shows the input digest and marks a verified payload'`, `'an in-flight local-model run can be cancelled from the inspector'`; axe clean.
**Evidence.** `docs/evidence/phase-5/wp5.12-advisor-ui.md`: screenshots of each view in both themes; the
axe run; the preview's bytes compared with the retained payload of the run that followed.

### WP 5.13 — Phase 4 carry-overs and gate conditions

**Scope.** §2's rows assigned to the gate, and nothing else: the Phase 4 gate's conditions implemented or
recorded as ruled-and-unchanged, in the gate's priority order, **verify-first** for every row — 03 §2's
`pending_review` row and 04 §2's port row were both stale when written down. If a condition touches a file
another Phase 5 package owns in the same wave, the orchestrator moves the condition or the package, never
both into one file.
**Owns.** Named per condition when the verdict exists. **Events.** None expected. **Migrations.** None
expected; **0034** reserved.
**Exit tests.** Named per condition, each reproduced red first — the 3.7a method.
**Evidence.** `docs/evidence/phase-5/wp5.13-carry-overs.md`: every condition closed, deferred with a
reason, or ruled; each sabotage recorded **in the evidence as it happens** — WP 4.12a lost its sabotage
records to a kill (execution log 2026-09-26 16:20), and a closed condition with no surviving proof is a
condition the next gate re-opens.

### WP 5.14 — Quality pass

**Scope.** Audit every §1 exit criterion: proven, needs Chris, or carried. Re-run the live evaluation
(5.3) and the live red-team pass (5.4) at the landing commit and compare with the recorded numbers.
Move `@ctx/recurring`'s and `@ctx/planning`'s bigint medians onto `@core/kernel`'s `stats.ts`. The
seed-bound backtest (§1 cut line 2): U2, S2 and C3 evaluated as-of weekly over the deterministic seed,
precision per rule, with the reason it is sound on the seed and nowhere else written above the table.
Sabotage the Monte Carlo concurrency cap at the cap. Measure `#planProjection` and the Brief's engine
cost on the scale seed. Extend `scripts/check-numeric-boundaries.ts` over the Brief's and the health
score's new code. The shared `e2e/support/drag.ts` helper; the `AssumptionsPanel` blind spot; the
recurring-insights flake, diagnosed or budgeted. Anything the Phase 4 gate carried into the audit.
**Owns.** `scripts/check-numeric-boundaries.ts`, `docs/TESTING.md`, the kernel-stats call sites in
`packages/contexts/{recurring,planning}/src/`, `packages/contexts/insights/test/backtest-seed.test.ts`,
`apps/web/src/features/plan/AssumptionsPanel.test.tsx`, and `.github/workflows/ci.yml` jointly with the
orchestrator.
**Exit tests.** `packages/contexts/insights/test/backtest-seed.test.ts` → `'the seed-bound backtest reads no row generated after its as-of date'`, `'a deliberately future-leaking reader is caught'` (the control); `scripts/check-numeric-boundaries.test.ts` → `'a float reaching a Brief amount outside a named boundary fails the check'`; `apps/api/test/db/phase4-wiring.test.ts` → `'the ninth concurrent Monte Carlo request waits and none is refused or lost'`.
**Evidence.** `docs/evidence/phase-5/wp5.14-quality.md`: the exit-criteria audit table; both live re-runs
beside the recorded numbers; the backtest table; each new check sabotaged once and observed red; every
`wp5.*` open item mined into one list.

---

## 4. Waves

Dependency line from master plan §6.4: *"Phase 5: LLM advisor ∥ Brief UI ∥ red-team corpus."* Ceiling is
**three concurrent agents, at most two Opus.** Phase 4's record is the reason the ceiling is a ceiling and
not a target: **six session-limit kills in three days**, three of which took every agent then in flight
(execution log 2026-09-26 16:20, 22:30; 2026-09-27 02:40, 13:40; 2026-09-28 ~18:00 the previous evening,
13:50), plus a weekly-limit kill that cost the Phase 3 gate ~32 hours (2026-09-26 09:05). A session limit
takes every agent at once, and the window drains faster the more agents share it, so a third agent is not
free: it shortens the time to the next kill for the two already running. **Where the wave's two packages
are both large Opus security surfaces, two is the right number**, and the plan says so where it applies.

| Wave | Agents | Packages |
|---|---|---|
| A | **2** (2 Opus) | 5.1 run control · 5.2 local endpoint + adapter + sandbox |
| B | 3 (1 Opus) | 5.5 planning solver + carries · 5.7 anomaly + fee hunter · 5.9 feedback loop |
| C | 3 (1 Opus) | 5.3 narrator · 5.6 Weekly Brief · 5.8 health score |
| D | 3 (1 Opus) | W-C wiring · 5.4 red team · 5.10 REST |
| E | 3 (0 Opus) | 5.11 Brief UI · 5.12 advisor UI · 5.13 carry-overs |
| F | 1 | 5.14 quality pass |
| G | 1 Opus | the Phase 5 gate |

**Why Wave A is two.** 5.1 and 5.2 are the phase's two security surfaces, both Opus, both the size that
ran ~300k tokens in Phase 4, and every later package stands on one of them. The ceiling allows a Sonnet
third and there is no good one: 5.7 needs 5.1's `enabled_source`, 5.9 edits the store 5.1 is editing, and
5.13's file list does not exist yet. **One exception, stated in advance:** if the Phase 4 verdict carries
a HIGH, 5.13 joins Wave A as its third — the 4.12a precedent — and the wave is run knowing a kill costs
three. **Why Wave C holds three, and when it drops to two.** 5.3 is the riskiest package in the phase and
the one whose kill hurts most; 5.6 and 5.8 are Sonnet packages of modest size in disjoint directories. If a
Wave B agent was killed, C runs as **two** (5.3, 5.6) and 5.8 — the cut-order item — moves to E, which then
runs 5.13 in F beside the quality pass. **Why 5.7 is in Wave B and 5.3 in Wave C.** The narrator's findings
include the anomaly and fee rules, and the two contract minors must land in order: 5.7 takes **1.4.0**
with migration 0029, 5.3 takes **1.5.0** with none. If a kill reverses the landing order the numbers swap,
and the rule that does not move is that *the minor adding a scope ships with its migration*. **Why 5.5 is
in Wave B.** 5.6's retirement effect is 5.5's solver; a Brief that computes its own retirement delta
because the solver was late is the §5 risk this phase is most likely to commit by accident. **Why 5.4
follows 5.3.** A corpus run against a narrator whose trace context has not landed tests the snapshot-wide
trace the corpus is meant to break, and a red harness cannot be committed.

**Wiring batches.** W-A (after Wave A) and W-B (after Wave B) are small and orchestrator-applied: the
config keys, the kind flag, the `insights.run_local` registration and the `PromptRenderer` binding; then
the Monte Carlo cap from config and the guardrail literal replaced by the assumptions value. **W-C** is a
Sonnet agent in Wave D because it is the phase's composition: the narrator registered in `insightsModule`
only when `LOCAL_MODEL_ENDPOINT` and `LOCAL_MODEL_DIGEST` are both set; `worker.ts` building the adapter
from config; the `insights.brief` job, the `insights.weekly_brief` schedule, the health score and the
outcome check folded into the weekly job, and the Brief's narration enqueue; `RetirementImpactPort` bound;
and `apps/api/test/db/phase5-wiring.test.ts` driving all of it through the real pump and job runner, with a
fake Ollama server killed at each level. It owns `apps/api/src/{modules.ts,worker.ts}` and that one test.

**UI packages code against contracts, never against a guess** — Phase 2's `notification-settings`
failure is what a guessed path costs. **5.11 and 5.12 own disjoint `features/` directories and e2e specs,
and neither may touch `e2e/support/mock-api.ts` or `app-walkthrough.spec.ts`;** the orchestrator applies
shared mock edits and the Playwright `testMatch` at the wave boundary.

Migration numbers are assigned before dispatch, in landing order, and are not negotiable in-flight. `ls
packages/db/migrations` at `088fe4d` shows **0027 as the highest; 0023 is burned** (the 0026 renumbering,
execution log 2026-09-26 17:40), **so 0028 is genuinely free.** The runner applies any unapplied file in
number order and tolerates gaps (`packages/db/src/migrate.ts:137–184`), so a dev database that received a
later number first still converges — but a fresh install applies in number order, which is exactly how
0023 died. The rule: **no Phase 5 migration references an object a higher-numbered one creates, and two
packages in one wave never create objects the other references.** Each table below references only
0012-era `insights`/`advisors` objects or its own.

| Migration | Tables / changes | WP |
|---|---|---|
| **0028** `advisor_run_control` | `advisor_run_payloads`, `advisor_payload_approvals`; `advisor_runs` gains `cancel_requested_at`, `cancel_reason`, `llm_model`, `llm_prompt_hash` and status `cancelled`; `advisors.enabled_source`; the refusal CHECK widened | 5.1 |
| **0029** `snapshot_grant_scopes_v1_4` | `snapshot_grants_scope_check` widened for `transactions.anomalies` and `fees.summary` — **same commit as contract 1.4.0** | 5.7 |
| **0030** `insight_feedback_reasons` | `insight_feedback.reason_code` with its CHECK and the preset mapping; `insight_outcomes`; the quarantine-reason CHECK widened | 5.9 |
| **0031** `insight_narrations` | `insights.narrates_insight_id` with a user-scoped composite FK | 5.3 |
| **0032** `advisory_briefs` | `advisory_briefs`, `advisory_brief_items` | 5.6 |
| **0033** `health_scores` | `health_scores` | 5.8 |
| **0034** | reserved for 5.10 / 5.13, used only if reported necessary | — |

Two waves may not both claim a number. **0029 is the only migration tied to a contract bump**, and
`apps/api/test/phase3-registration.test.ts` fails the build if it and 1.4.0 are split across commits.

### Shared files an orchestrator applies between waves

No agent edits these. The orchestrator applies them once per wave boundary, then runs `just verify`.

1. **`vitest.config.ts`** — **one new project**, `advisor-local-model` (root
   `packages/advisors/local-model`, `include: ['src/**/*.test.ts', 'test/*.test.ts']`, no Postgres), in
   Wave A's batch. `node scripts/check-ci-projects.ts` reads **41 projects (26 in `test`, 16 in
   `migration-test`, `testkit` in both)** at `088fe4d`; it should read **42** at the gate. If any other
   package asks for a project, its test is almost certainly in the wrong directory.
2. **`scripts/eslint-boundaries.js`** — a new `advisor-local-model` layer for `packages/advisors/local-model/`
   allowing `@core/kernel`, `@core/platform` and `@core/contracts` plus `UNIVERSAL`, with
   `allowNodeBuiltins: false` — the adapter reaches the network only through the platform transport and
   touches neither the filesystem nor a process. The **`insights` layer gains nothing**, and specifically
   **must not gain `@advisor/local-model`**: the composition root binds the adapter to the `Advisor`
   interface, and the layer's comment (*"no LLM client"*) stays true. `eslint.config.js` gains
   `no-restricted-globals: ['fetch', 'WebSocket']` for the adapter package, because a global needs no import
   and a layer rule cannot see it; WP 5.2's structural test is the second line. `pnpm-workspace.yaml`
   gains `packages/advisors/*`.
3. **`apps/api/src/platform.ts`** — flag `advisors.kind.local_model`, `defaultEnabled: false`, with an
   owner and a removal criterion (*never — this is kill level 2*). `module.insights`' description gains
   the local model, the Brief and the health score; it stays `true`, and 5.14 re-proves flag-off registers
   nothing.
4. **`apps/api/src/modules.ts`** — W-C's (§4): job kinds `insights.run_local` (concurrency 1) and
   `insights.brief`; the schedule `insights.weekly_brief`, **its name matching
   `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`**, Sunday 06:00 local; the narrator registration, feature-detected.
   `assertPoolCoversLeases` is re-checked against `DATABASE_POOL_MAX` with the new kinds — Phase 3's
   pool-vs-lease deadlock produced no error and no restart. **`apps/api/src/domain.ts`** — W-B's guardrail
   and cap lines; W-C's `RetirementImpactPort` binding.
5. **`packages/db/test/migrate.test.ts`** — the alphabetical table list (**92 names at `088fe4d`** → 98:
   `advisor_payload_approvals`, `advisor_run_payloads`, `advisory_brief_items`, `advisory_briefs`,
   `health_scores`, `insight_outcomes`) and an attribution block per migration, 0028–0033.
6. **`.github/workflows/ci.yml`** — `advisor-local-model` added to the `test` job's `--project` list the
   day the project exists, **and** a Phase 5 paragraph in the header's prose map, which
   `scripts/check-ci-projects.ts` does not read.
7. **`apps/web/playwright.config.ts`** — the `chromium` `testMatch` (line 91) gains `brief` and
   `advisors`. WP 3.11, 3.12 and 4.11 each needed this and none could make it.
8. **`packages/contracts/`** — regenerate with `just openapi` after Wave D, then
   `apps/web/src/api/generated/`. The published advisor schemas regenerate **in the same commit** as
   each contract minor (1.4.0 with 0029; 1.5.0 alone). `scripts/check-proxy-routes.ts` should stay green
   without a `docker/Caddyfile` edit (every new route sits under `/api/insights` or `/api/advisors`); if
   it does not, that is a finding. **No CSP directive may widen** — D26 is the one ratified exception and
   Phase 5 adds nothing the browser loads.
9. **Config and secrets batch** (Wave A's): `ADVISORS_ENABLED` (boolean, default `true` — kill level 1
   finally has a key); `LOCAL_MODEL_ENDPOINT` (a single-label compose host and port; empty ⇒ no local
   advisor is registered, the Plaid feature-detection shape); `LOCAL_MODEL_NAME`; `LOCAL_MODEL_DIGEST`
   (**required when the endpoint is set** — boot refuses otherwise); `LOCAL_MODEL_TIMEOUT_MS` (default
   180 000, never above `PLATFORM_LIMITS.timeoutMs`, `contract/manifest.ts:43`); `LOCAL_MODEL_ALLOW_REMOTE`
   (default `false`, §6 Q2); and, from §2, `MONTE_CARLO_MAX_CONCURRENT` (default 8). `.env.example` and
   RUNBOOK step 3 gain the same lines; `worker` receives them and `api` receives only `ADVISORS_ENABLED`.
   **Secrets: none.** A local model needs no key, and a phase whose secrets batch is empty should be
   noticed and confirmed rather than assumed — Phase 5 adds an HTTP client and no credential for it,
   which is the point.
10. **Dependency batch** — **nothing for the adapter.** The Ollama client is `@core/platform`'s transport
    under WP 5.2's local-endpoint policy, against a documented HTTP API — not the `ollama` npm package,
    for five reasons: the surface is one endpoint and one metadata call, ~40 lines; the SDK resolves its
    host from `OLLAMA_HOST`, and `process.env` is banned outside `@core/config` (`docs/CONVENTIONS.md`,
    "The dependency rule"); it would own the socket, so the address pinning that defeats DNS rebinding,
    the byte cap enforced *while the reply arrives* (08 §4.4 step 1) and the refusal to follow a redirect
    would all be its behaviour rather than ours; it would inherit proxy environment variables, which could
    route a prompt off the host; and D14's dependency budget. **The `@core/secretbox` dependency on
    `@ctx/insights`**, if §6 Q5 is answered yes. **The `ollama/ollama` image**, pinned by digest in
    `compose.yml` — an image, not a package, outside the npm licence gate, and recorded in `THIRD_PARTY.md`
    by hand. Under the seven-day `minimumReleaseAge`, then a `THIRD_PARTY.md` restamp. **Rejected before
    an agent proposes it:** `ollama`, `openai` and every OpenAI-compatible client — a hosted-API client in
    the tree is a hosted-API code path one configuration line from use, which D22 does not permit for
    personal data; `langchain`, `@langchain/*`, `llamaindex`, `ai` — frameworks whose abstraction is
    exactly the tool-calling agency this contract exists not to have; prompt-injection "guard" libraries —
    03 §8.2: *"Structural defense beats filtering"*, and a heuristic filter in the dependency tree invites
    treating it as the control; `ajv` — 08 §4.4 names it, but this repo's normative schemas are generated
    from zod and a second validator is a second opinion that can disagree; `tiktoken` and tokenizers — the
    caps are bytes and `num_predict`; Unicode confusables and normalisation packages —
    `String.prototype.normalize('NFKC')` and an explicit code-point list are the whole of what is needed,
    and the list is reviewable. Agents never run `pnpm install`.
11. **The `.trivyignore` caddy snoozes (2026-10-10).** The orchestrator's, on that date (§2): re-scan
    upstream; if unfixed, the `xcaddy` build lands in the next shared-file batch rather than in Phase 9.

---

## 5. Gate standard for Phase 5

Carried verbatim in force from the Phase 0–4 gates. Phase 3's gate ran 45 sabotages with 41 red on the
first try, and the four greens were findings (execution log 2026-09-26 12:30) — which is what a sabotage
log is for, and why the count is never a reason to run fewer.

1. **Independent reviewer.** An Opus `security-engineer` who wrote none of the code re-runs the
   load-bearing proofs. A gate may not validate its own fixes — Phase 1 needed D-2 for exactly that
   reason. For Phase 5 that includes the live evaluation (5.3) and the live red-team pass (5.4): the gate
   re-runs both against the pinned model rather than reading their numbers.
2. **Sabotage every new control and observe it go red** before accepting its PASS. Record which sabotages
   were red on the first try. A control that has never been observed failing is not evidence — and WP
   4.12a is the most recent example of what it costs when the record is lost rather than never made.
3. **Walk the production stack in a real browser**, through Caddy, on an image rebuilt from the landing
   commit, with the `local-llm` profile up and the pinned model pulled through `local-llm-pull`, and **the
   walk must reach the code Phase 5 added**: the narrator's scopes are granted with a step-up; its payload
   is previewed and approved; the weekly Brief is triggered on a shortened schedule and renders at most
   five actions, each with a dollar figure and a retirement effect or a stated reason; a narration arrives
   with its badge; an evidence panel opens; the run inspector shows a verified digest; a finding is
   dismissed with a reason and the effect is visible; the health score shows six components; and then
   **a live narration is killed at each of the four levels in turn**, each run ending named, nothing
   written after the kill, and the Brief, feed and dashboard rendering unchanged — and once more with
   `docker compose stop ollama`, where the app shows the advisor unavailable and nothing else changes.
   **A login that stops at the shell proves nothing.**
4. **Every "never" claim has a test that fails when the thing is made to happen.** Phase 5's list: a
   narration never carries a figure its finding does not; the model never sees a merchant descriptor or a
   memo; the model container never resolves `db` and never reaches the internet; a local-model run never
   writes after a kill at any level; a Brief never shows a retirement effect the engine did not compute;
   the model never receives a query shape nobody previewed; the adapter never logs a prompt, a reply or a
   snapshot byte; `transactions.anomalies` never reaches an `external` advisor; a narration never takes a
   ranked slot; a local-model run never occupies the builtin lane.
5. **Every new vitest project is in `ci.yml` the day it is created.** Phase 5 creates one;
   `scripts/check-ci-projects.ts` should read **42/42** at the gate, and the gate confirms the check still
   fails when a project is dropped.
6. **The walk starts from a genuinely cold install** — `docker compose down -v`, `up`, bootstrap, no
   restart anywhere in between — and **it must observe the scheduled work fire**, not merely be
   registered: one `insights.weekly_brief` tick (shortened) producing an `advisory_briefs` row and an
   `insights.BriefPublished` event with no user action, and one `insights.run_local` job completing
   against a cold model, whose first-request load time is measured against the deadline rather than
   assumed inside it. Phase 3's pool-vs-lease deadlock produced no error, no restart and no `worker
   ready` line; `assertPoolCoversLeases` is re-checked against `DATABASE_POOL_MAX` with the two new job
   kinds.
7. **`just verify`, not `just check`**, run at the landing commit — and CI on the real GitHub runner must
   also be green, because Phases 2, 3 and 4 each found defects `just verify` structurally could not see
   (Phase 4's: a return series absent on the runner, a contrast pin flipped by a fix). **And the Phase 4
   gate's conditions are inputs, not outputs:** a condition that has now skipped two gates is a process
   finding in the verdict, not only a condition.
8. **A cross-user sabotage drops every scoping predicate, individually and together.** WP 3.9's S1
   finding stands: a single-predicate sabotage on a two-predicate route proves the predicate you did not
   test. Applied to every Phase 5 route — the Brief, the inspector, cancel, the preview and the approval —
   and re-applied to the consent route.

### Phase-5-specific risks

| Risk | Control | Proven by |
|---|---|---|
| **Prompt injection through transaction memos and merchant names into the local model.** 03 R-03 ranks it third of thirteen; a payee can name itself anything, and a $0.01 refund is enough to plant it. | Structure first: merchants are tokenised for every advisor kind (`snapshot/tokens.ts:31–35`) and descriptors and memos cross no scope at all, so the vector the risk names is closed by *absence*. What does cross — crypto symbols, category slugs, goal names — reaches the prompt only inside the delimited block, after NFKC, control/zero-width/bidi stripping and fence removal, with each removal flagged. The model holds no tool, no handle and no network; a successful injection yields a bad narration, which the narrow trace refuses and a human reviews. | WP 5.2 `prompt.test.ts`; WP 5.4 `'no merchant descriptor or memo from the corpus reaches the prompt at all'` and `'no corpus payload reaches the prompt outside the delimited block'`, CI and live; the gate greps a rendered prompt for every corpus payload. |
| **A fabricated figure passes the validator** — the Phase 2 ceiling finding in its LLM form: a number that is *somewhere* in the snapshot, under a permitted rendering, attached to the wrong claim. | For `narrates_only` advisors, step 7's candidates are the narrated finding's own rendered figures, matched verbatim; a narration must carry its finding's type and key, cite a subset of its refs, carry no impact and no action, and never outrank its finding. Every figure displayed is the builtin's; the narration is wording. No retry-until-valid. Escalation if the red team breaks it: slot references, so the model writes no digit. | WP 5.3 `'a narration may use only the figures of the finding it narrates…'`, reproduced red against the snapshot-wide trace first; WP 5.4 `'zero schema-valid insights carry a figure that is not the narrated finding's own'`; the gate widens the trace back and watches both go red. |
| **A kill level that does not actually stop an in-flight run.** Today every switch is read once, before the call (`service.ts:181–235`), and level 1 does not stop `POST /advisors/run` at all (§2). | The run watcher re-reads every switch and its own cancel flag at most once a second and aborts; the write barrier re-reads them under a row lock before any insert; every refusal and cancellation names the broadest level; the adapter's abort closes the socket, so the model stops generating rather than finishing into a void. | WP 5.1 `kill-ladder.test.ts` — one case per level, in flight, plus the write barrier; `insights-routes.test.ts`'s module-off case red first; the gate kills a live narration at each level through the UI and the config and reads `advisor_runs`. |
| **The sidecar reaches the database or egress.** | Ollama sits on `llm` (`internal: true`) and nothing else; `db` is not on `llm`; no secret, no published port, non-root, read-only; the pull runs from a separate one-shot profile on its own network. On our side, the local-endpoint policy refuses any public address, and the adapter imports no builtin and no global `fetch`. | WP 5.2's hardening self-test and structural test; the container transcript in wp5.2's evidence; the gate re-runs `getent hosts db` and an outbound fetch from inside the container, and sabotages the network line in a scratch compose file. |
| **The Brief's "effect on retirement date" is a number the engine did not compute.** A Brief that interpolates, compounds or recomputes on read produces a confident date no engine run stands behind. | The effect is only ever `RetirementImpactPort`'s answer, carrying the engine and assumptions versions that produced it; whole years or `not_computable`, with months-of-spending declared as a derivation over two engine runs; stored once per Brief and served as stored. | WP 5.6 `'a retirement effect is only ever the port's answer…'` and `'…names the engine and assumptions versions…'`; `brief-retirement-port.test.ts` against a direct engine run; WP 5.10 `'…served exactly as stored…'`; the gate computes one item's effect by hand from two engine runs. |
| **A local model run blocks the worker's job loop.** A three-minute model call in `insights.run` (concurrency 1, `jobs.ts:122`) queues every builtin behind it. | Its own job kind, concurrency 1, one slot of the runner's four; no database connection held across the call; the deadline ours; the model container CPU-capped so the worker and `db` keep their cores. | WP 5.1 `local-lane.test.ts`; W-C's `phase5-wiring.test.ts`; the gate runs a nightly builtin pass while a narration is in flight and compares its duration with one run alone. |
| **PII leaves the process, even to loopback logs.** A prompt in a debug line lands in container logs, rotated onto the host disk, outside the backup's encryption. | The adapter logs shape, byte size, digest and durations only; the transport logs no bodies; Ollama runs without debug logging; retained payloads are bounded, and sealed if §6 Q5 says so. | WP 5.2 `'no prompt, reply or snapshot byte reaches the logger'` (a canary); the gate plants a canary in a goal name and greps the `worker`, `api` **and `ollama`** container logs for it after a live run. |
| **The model changes under a tag.** A re-pulled `name:tag` is a different model, and every number measured on the old one silently stops applying. | `LOCAL_MODEL_DIGEST` is required and checked before every run; a mismatch refuses before a prompt is sent; the evaluation records the digest it measured. | WP 5.2 `'a served model whose digest differs from the pinned one is refused…'`; the gate re-tags a second model under the pinned name and watches the run refuse. |
| **An approval for one payload shape is used for another** (preview, then a scope granted, then a run). | The shape hash covers advisor, version, kind, effective scopes and the prompt template's hash; approval carries the hash the preview returned and refuses if it has changed. | WP 5.1 `'a changed scope set or prompt template is a new query shape…'`; WP 5.10 `'an approval for a shape that changed since its preview is refused'`. |

---

## 6. Open questions for Chris

Work proceeds on the stated default; an answer is a cheap change.

1. **Which local model, on what hardware.** Default: **a 7–8B instruction-tuned model under Apache-2.0
   at 4-bit quantisation, CPU-only on this host, pinned by digest** — a Qwen-family instruct model is the
   reference candidate because it follows a JSON schema well at that size and its licence carries no
   acceptable-use policy to audit. That is ~5 GB of RAM and a few tokens a second on the Ryzen 5 3501U WP
   4.13 timed on, which is adequate precisely because cut line 1 limits narration to five findings a
   week. If the host has less than 16 GB, the fallback is a 3–4B model and a lower first-attempt rate; the
   ≥95% criterion is measured on whatever you choose, so choosing is part of meeting it. The model's
   weights are data you pull, not something the repo redistributes, but their licence still binds you.
2. **Ollama on this host, or on a LAN box.** Default: **this host, in the `local-llm` compose profile,
   on an internal network, no published port.** A LAN box means a prompt carrying your finances crosses
   the LAN in plaintext unless something terminates TLS in front of Ollama, and 03 T6 — another device on
   the LAN — is exactly the reader that allows. `LOCAL_MODEL_ALLOW_REMOTE=true` exists for that case and
   then requires `https`. If this host cannot spare the memory, a LAN box with TLS in front is the right
   trade; a LAN box without it is not.
3. **Whether the Brief is delivered by notification.** Default: **in-app only in Phase 5**; WP 5.6 emits
   `insights.BriefPublished`, so delivery is one renderer case in `@ctx/notifications`' `render.ts` away.
   09 NOT-1 is a "Must" and asks that a delivered Brief match the in-app one exactly, while NOT-6 asks
   that notifications can omit amounts for shoulder-surfing safety; the two pull against each other. If
   you want it, the proposal is headlines and a deep link through your existing ntfy or SMTP channel,
   amounts off by default — a small Wave E package.
4. **Bitemporal storage — the cost 04 §6 Q7 said would come due.** Default: **still not built, and
   Phase 5 ships the honest substitutes** (forward validation, the live `NOT_TRUE` gate, a seed-bound
   backtest — §1 cut line 2). What that buys is precision on your rules *from now on*; what it cannot buy is
   07 §8.2's calibration over the history you already have, and every month of history accumulated
   without a knowledge time is a month no backtest can ever use. The retrofit is less than it sounds for
   the one table that matters most — provider transactions already carry `first_seen_at`
   (`packages/contexts/ledger/schema/transactions.ts:80`) — and more than it sounds everywhere else: the
   categorisation overlay and balances were not audited for history for this file. Recommendation: decide
   before v1.0, and if yes, a dedicated phase rather than a package.
5. **The `@core/secretbox` pseudonym swap — the fifth time.** Default: **apply it in Wave A's
   dependency batch and re-pseudonymise now** — the `MERCHANT_`, `LIAB_` and `GOAL_` domains together
   (wp4.9 §11). The cost has risen every phase with the evidence rows that quote a token; Phase 5 adds
   narrations that quote them in prose and a Brief that persists them weekly. There is also now a second
   use: WP 5.1's retained payloads should be sealed, and without the dependency they are plain `jsonb` for
   thirty days. **If the answer is no, the recommendation is to record it as a permanent decision** —
   `configHash` as the pseudonym construction, by design — rather than carry it a sixth time, because a
   question carried five phases has stopped being a question.
6. **How fine the Brief's retirement effect should be.** Default: **whole years from the engine, plus
   "funds about N months of retirement spending"**, never an interpolated month (§1 cut line 3). Most
   single actions will show no whole-year change, which is true and slightly deflating. Monthly resolution
   means teaching the engine a partial transition year, which touches the recursion WP 4.14's reference
   cases pin; it is a Planning package of its own, not a Phase 5 afterthought.
7. **Releasing the spending wave on your install.** Default: **yes** — S2, S3, S6, S7, S9 and S10 were
   built in Phase 2 and have shipped off since (`catalogue.ts:205–210`); with S1, S5 and the fee hunter
   they become the anomaly wave, and WP 5.1's `enabled_source` switches them on only where you never
   touched the switch. The Brief's alert budget and its two-per-family cap absorb them, and ADV-5 is a
   "Must". If you would rather stagger, it is one toggle per rule and no deploy.
8. **Real-data exit criteria, now seven** — two institutions on schedule, a month with zero internal
   transfers, the recurring gold set, a real brokerage reconciling to its statement, a projection over real
   balances by real tax treatment, **the Brief's first month**, and **the ≥95% on the pinned model on this
   host**. Default: **Phase 5 closes on seed, fixture, recorded-reply and one live-model evaluation**, and
   the Brief's month starts on the first Sunday after your first production link. The sixth is the one
   nothing but time can supply: "genuinely useful" is your judgement, recorded as an accept or a
   dismissal with a reason, and the instrument that counts it is built in this phase so that the month,
   when it runs, measures something.
