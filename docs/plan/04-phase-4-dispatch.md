<!-- SPDX-License-Identifier: MIT -->

# Phase 4 dispatch — goals, assumptions, projection, Monte Carlo

*Written 2026-09-24 at `e03fdb8` on `main`, while Phase 3's last package lands and its Opus gate is
about to run. Companion to [`01-execution-log.md`](01-execution-log.md), which stays the orchestrator's
ledger; this file is the work-package breakdown, wave plan and gate standard for Phase 4. Plan of record
remains [`00-master-implementation-plan.md`](00-master-implementation-plan.md).*

---

## 1. Goal, exit criteria, rungs

**Goal (master plan §5).** Phase 4 — Goals and retirement projection (8–12 days). Deliverables:
Planning context (goals, contribution plans, risk profile with the consistency-penalty questionnaire,
scenarios, assumptions from 07 Appendix A in one config file); deterministic projection from **revealed
behavior** (rolling 12-month actual savings and spending); Monte Carlo in a `worker_thread` (parametric
lognormal by default, bootstrapped Shiller as an option, crypto as its own asset class) with stored
seed; glidepath, Social Security and pension inputs, tax-bucket awareness; projection UI (fan chart with
labeled percentiles and an explicit "median" label, clickable dotted gap line that solves for required
monthly savings, draggable life events, scenario compare); client-side Web Worker for slider
interactivity; `GoalOffTrack` events into Insights; R1–R7 rules.

**Exit criteria, verbatim from §5:**

> 10k paths ≤ 800 ms p95; identical seed ⇒ identical bytes; deterministic output within 1% of an
> independent reference calculator on the shipped fixtures; assumptions visible, editable, cited.

**Rung reached (§2.3).** **v0.6** "Planning" — *"Deterministic projection within 1% of a reference
calculator; Monte Carlo reproducible with a fixed seed."* Both clauses are testable and both are
sabotage-testable, which is why neither may be closed by a screenshot. The second is the one that decays
quietly: a `Math.random()` anywhere in the draw path, a `Date.now()` in a glidepath, an object key order
that varies across processes (WP 3.10a §7.3 item 2 already caught the OpenAPI emitter doing exactly
that), and "identical seed ⇒ identical bytes" is false in a way no unit test written afterwards will
find.

**What Phase 4 does not do.** The Weekly Brief and the `local_model` advisor (Phase 5, D22),
Vibe-Trading (Phase 6, D23), tax *filing* or formal tax optimisation (09 E10 GOAL-13, out of scope for
v1). Inside the projection itself, three explicit cut lines drawn now rather than discovered later:

1. **Tax-aware withdrawal ordering ships as 07 §5.7's phase 1** — *"a single blended effective tax rate
   on tax-deferred withdrawals. Ship this; it's 80% of the value."* Bracket-filling, 0% LTCG harvesting,
   IRMAA and the Social Security tax torpedo are **not** built. The tax **buckets** are real (07 §5.2
   runs the recursion per `TAXABLE`/`TAX_DEFERRED`/`ROTH`/`HSA`); the ordering rule over them is blended.
2. **Historical cycles (07 §5.1's third engine) is the cut item.** 07 §5.1 asks for all three engines;
   if the phase runs long, deterministic + Monte Carlo ship and the ~95-cycle replay is carried. It is
   the only one of the three with no exit criterion attached to it.
3. **Bitemporal storage (07 §8.2) is not built.** Point-in-time rule backtesting needs `valid_time` +
   `knowledge_time` on every row and the memo says to build it on day one; Phases 0–3 did not, and Phase
   4 is not where a bitemporal retrofit of the ledger belongs. Recorded in §6 Q7 so it is a decision and
   not an omission.

---

## 2. Phase 3 carry-overs Phase 4 must absorb

| Item | Source | Disposition |
|---|---|---|
| **The Phase 3 gate verdict and its conditions** — not written at the time of this file | Phase 3 gate, pending | **Phase 4 does not dispatch until the verdict exists, and WP 4.12 not until its conditions are written.** The Phase 2 precedent is exact: 03 §2 held WP 3.13 on two unwritten rulings and it cost nothing, because the alternative is a WP that implements a ruling that then says something else. |
| **Phase 2 gate C-2 (re-walk the Plaid Sandbox leg) and C-3 (observe each nightly schedule fire on a real clock)** were assigned to *the Phase 3 gate*, first step | phase-2 gate §5 | **Inputs, not outputs.** If the Phase 3 gate discharges them, Phase 4 records them closed and opens nothing. If it does not, they carry to the **Phase 4 gate** with the same wording — a condition that has now skipped two gates is a finding about the gate process, and §5 item 7 says so. |
| **The 3.10a ruling: I1, I3 and I5 are enabled and structurally silent** because `allocation_targets`, an idle-cash dwell source and an employer-stock tag have no source table | execution log 2026-09-24 12:20, wp3.10a §7.2 | **WP 4.7 is that ruling's other half, and it is the reason WP 4.7 exists.** 3.10a pinned the silence with `'the investing rules with no field behind them are silent, and it is these three'`, which asserts I1/I3/I5 propose zero *and* that I4/I2 propose more than zero on the same run. **That test must be re-derived, never deleted** — the day a source lands it goes red naming the rule that should now fire, which is exactly the signal WP 4.7 is graded on. |
| **`allocation_targets` does not exist**, so `GET /investments/drift` takes targets in the query string and suppresses rather than inventing | wp3.9-routes §8 item 1, wp3.11 §10 item 4 | **WP 4.7**, migration 0023. §8 Q9's rule survives the change: an unset target still suppresses; what changes is that a *set* target persists instead of living in a URL. WP 3.11's "set a target" empty state becomes a real editor against the same `targetsSet` field it already honours. |
| **`idleDays` is an input to WP 3.3's analytics and nothing supplies it**; **employer-stock concentration needs a tag no table carries** | wp3.3 §11 items 3–4 | **WP 4.7.** Dwell is derivable today from `holdings_snapshots` (daily, `@ctx/investments`, migration 0014) — nobody has derived it. The employer tag is the holder's own; 07 I5 is explicit that an employer is **never inferred**, so it is a user-set row and not a heuristic. |
| **Five advisor rules are `CATALOGUE_GAPS` naming a field — I7, I8, I9, I10, X4 — and I10 is P0** | wp3.10 §9.3 | **WP 4.9 decides, and may close none of them.** I8/I9/I10 need a `contributions.ytd`-shaped scope (year-to-date deferrals, a plan's match formula, an HDHP flag); that is a *scope* decision, which is what makes it Phase 4's rather than an agent's. §6 Q4 asks Chris whether the plan terms are his to enter. What WP 4.9 may not do is write them over data that is not there. |
| **`goals.list` and `risk.profile` are already published scopes at advisor contract 1.0.0**, with Zod schemas, already inside 0019's widened `snapshot_grants_scope_check`, and flagged `sourcedInPhase2: false` | `packages/contexts/insights/src/contract/scopes.ts:236,248`; `src/contract/snapshot.ts:595,609`; `packages/db/migrations/0019_snapshot_grant_scopes_v1_1.sql` | **Good news, stated so nobody re-does it.** Phase 4 needs **no contract bump and no widening migration** for those two: it flips two `sourcedInPhase2` flags, adds two `SnapshotBuilder` arms and two readers — 3.10a's shape exactly. A **new** scope (§3 WP 4.9 argues for one) is the case that needs both. |
| **`grantScopes` has no production caller — there is no consent route at all** | wp2.6 §6, wp3.10a §7.1 | **WP 4.8**, and it must land in Phase 4 rather than Phase 5. Phase 4 is the first phase that adds a scope whose block a user could reasonably refuse (a projection is a forecast about *him*), and 0019 exists because a scope reached the database before consent did. A consent route with no scopes is cheap; fifteen scopes with no consent route is a control that has never been exercised. |
| **`@core/secretbox` is still not a dependency of `@ctx/insights`** — the merchant-pseudonym construction is pinned as `configHash` and the swap was carried to "the orchestrator's dependency batch", which has not been observed applied | wp3.13 §3 row 9; `packages/contexts/insights/package.json` (confirmed by grep at `e03fdb8`) | **Orchestrator's dependency batch, Wave A, or it is deferred deliberately with a date.** 03 §2 said the cost is monotonically increasing in stored evidence rows and Phase 3 wrote seventeen rules' worth. Phase 4 writes seven more. This is the last phase where the answer is still cheap; §6 Q6. |
| **The perf dataset is a correctness seed, not a scale seed** | wp3.14 §8 item 6 | **WP 4.13.** Quoting 32.7 ms p95 as headroom against a six-account seed is the same error as quoting a green `just check` as a green CI, and Phase 2 already taught that one. A 200-position, five-year dataset is the precondition for the 800 ms budget meaning anything. |
| **`ProviderInvestmentTransactionFact.security` is still one identifier where the resolver needs the set** — not reachable today only because `resolveRunFacts` runs holdings first | wp3.7a "Carried" | **WP 4.12.** One field, the same change 3.7a made for `ProviderHoldingFact`, in `packages/connectors/port/src/facts.ts` plus the four adapters. It is latent, not hypothetical: a run producing investment transactions and no holdings for the same security splits it. |
| **WP 3.9's S1 finding: dropping `holdings.user_id` alone left the sabotage green** because the securities join also scopes | wp3.9 §8, execution log 2026-09-24 04:50 | **A gate-standard change, carried into §5 item 8, and a WP 4.8 obligation.** Every cross-user sabotage on a joined route must drop **every** scoping predicate, one at a time and then together. A single-predicate sabotage on a two-predicate route proves the other predicate, not the one you meant. |
| **No 3.13 control has a surviving sabotage record** (C-1/G2-1 root fix, the deleted lazy repairs, C-5 budget dirty-on-create, the `pending_review` filter, the `age`-encrypted export) | wp3.13 §4 | **The Phase 3 gate's, explicitly.** If the Phase 3 gate's Standard B does not cover all five, they carry to the Phase 4 gate as named sabotages. Phase 4 opens no WP for them: they are all proven controls whose *proof* is missing, and a build agent re-proving someone else's control is how a gate gets validated by the code it validates. |
| **`SnapshotJobDependencies.portsFor` should take the job's `userId`**; today the composition root binds one holder and `planningModule` refuses a job for any other **by name** | wp3.w §10 item 7, `apps/api/src/modules.ts:516–548` | **WP 4.6**, and it stops being a nicety: Phase 4 puts a *second* Planning job on the schedule. A second job inheriting a single-holder binding is a multi-user bug that D6 says must be additive, not structural. |
| **`ConsumerContext` should carry a database handle**; `assertDrizzleTransaction` is the interim guard | wp3.w §10 item 1 | **Deferred, `@core/platform`, no WP.** It is a platform change that would touch every consumer in five contexts at once, and Phase 4's two new consumers can live with the interim guard exactly as Phase 3's did. Phase 9's polish pass or a dedicated platform batch. |
| **`net_worth_daily` and `wallet_addresses` are deferred from the export bundle, not excluded** | wp3.w §10 item 9 | **WP 4.12.** Phase 4 adds eleven more Planning-owned tables to the same bundle, and `goals`, `plan_assumptions` and `plan_scenarios` are precisely the *user-authored* data 08 §7.3 calls "the truly irreplaceable data". An export that round-trips a ledger but loses the plan fails D24's own premise. |
| **`accounts` carries one of the four booleans (07 §4.1), not four**; `onBudget` is derivable only from `@ctx/budgeting`'s exclusion list | wp3.8 §7, §12 items 2–3 | **WP 4.3 inherits the same problem one layer up** and solves it the same way — a port declared by Planning, bound in `apps/api/src/domain.ts`. It does **not** add columns to `@ctx/ledger`'s table: that is Ledger's migration and Phase 4 already opens eleven tables. `defaultFlagsFor` stays the interim derivation. |
| **`correctDay` had no caller** (3.8) — `POST /net-worth/corrections` now exists (3.9); **the Playwright `chromium` `testMatch` excluded the three Phase 3 specs** (3.11/3.14) — it now names `investments|networth|market-data` (`apps/web/playwright.config.ts:78`); **`apps/api/test/db/holdings-reconcile.test.ts` exists untracked at `e03fdb8`** | wp3.8 §12 item 4, wp3.14 §8 items 2 and 5 | **Closed or nearly closed — re-confirm at Phase 4 start, open no WP.** The third is an orchestrator commit, not a work package. Listed so a reader of this file does not go looking. |
| **`contract-parity.test.ts` was red at WP 3.10** (published schemas vs the files on disk) and was regenerated later in the phase | wp3.10 §9.1, execution log 2026-09-23 23:30 | **Verify first, then WP 4.9.** If it is green, 4.9 inherits a working parity check and must keep it green through a 1.2.0 bump. If it is red, 4.9 fixes it *before* bumping anything — a parity test that is already red cannot tell you a minor bump was wrong. |
| **The 3.4 sabotage gap** — widening `allowedSchemes` stays green because `checkUrl` pins https at the platform layer; **`cache.ts` deliberately not built**; **no macro storage table exists** although `FredSource.macro` can fetch `CPIAUCSL`/`DGS10`/`DGS3MO` | wp3.4 §10, execution log 2026-09-23 02:20 | **First two: the Phase 3 gate's, recorded.** The third is **WP 4.2's**: the assumptions file's citation surface wants a current CPI and a current 10-year yield with a date beside them, and re-fetching FRED on every render is the wrong answer. 4.2 decides between a small `macro_observations` table and a dated constant in the assumptions file, and writes down which. |
| **No live smoke exists for Coinbase, WalletRpc or Plaid investments**; **`AVERAGE_COST` on an ETF is not rejected**; **the seed table is 48 rows, not ~600**; **rungs 3–4 of the classification waterfall are ports with fakes** | wp3.5 §10 item 9, wp3.6 §11, wp3.7 §11 item 6, wp3.2 §12 item 5, wp3.1 §7 | **Deferred, no WP, one reason each.** The three live smokes wait on Chris's credentials and are the Phase 3 gate's walk. The other three are `@ctx/investments` work in a phase that opens no investments engine — WP 4.7 touches that package's *schema* and nothing else, and widening it mid-phase while 4.7 is adding two tables is how two agents collide. |
| **`Sidebar.tsx`'s active nav link measures 4.28:1 in dark mode** (`--accent-text` on `--accent-wash`); **`--status-warning`/`--status-serious` contrast unconfirmed** | wp3.11 §10 item 3, phase-1 wp1.6 §7 | **First to WP 4.10** — it is the one Phase 4 package that must touch the shell nav anyway (to add `/plan`), and shipping a new nav entry into a known-failing token pair is not a trade. **Second deferred to Phase 9**, unchanged. WP 4.10/4.11 still run axe on every new screen. |
| **Multi-user taxonomy seeding** (`ensureTaxonomy` takes a list, `app.ts` supplies one answer) | Phase 1 closeout §4, deferred in 02 §2 and 03 §2 | **Deferred a third time, same reason.** Blocked on Identity growing a user enumeration (D6: additive, not built). Every table Phase 4 adds is `user_id`-scoped from its first migration, so nothing here makes it harder. |
| **Real-data exit criteria, now five** — two institutions on schedule, a month with zero internal transfers, the recurring gold set, a real brokerage's holdings reconciling to its statement, and **a projection run against real balances classified by real tax treatment** (09 GOAL-4) | 02 §2, 03 §6 Q8, 09 E10 | **Carried, owner Chris — fourth phase.** Phase 4 closes on seed and fixture evidence. The fifth item is new and is the one that cannot be faked by a seed: tax-bucket classification is a property of real accounts. §6 Q8. |

---

## 3. Work packages

Same collision rules as Phases 1–3: disjoint path ownership, no dependency or lockfile edits by agents,
no commits (the orchestrator commits per package after `just verify`), a separate scratch database per
agent, foreground waits only, one agent on the compose stack at a time, **agents write evidence and post
their report before the final verify**, and the orchestrator finishes cheap kills. Phase 3 adds one
more, learned three times in one day: **a work package's evidence document is part of the package, and
an agent that runs out of session with green tests and no evidence has not shipped.** Every brief says
so, and the orchestrator's first recovery action on a kill is to read the tests, not to relaunch blind.

| WP | Package | Model | Agent type | Depends on |
|---|---|---|---|---|
| 4.1 | Goals, contribution plans, risk-profile questionnaire with the consistency penalty, cash earmarks; migration 0020 | Opus | backend-architect | — |
| 4.2 | Assumptions: one versioned config file from 07 Appendix A + §5.5, per-user overrides, the citation surface; migration 0021 | Opus | backend-architect | — |
| 4.3 | Revealed behavior: rolling-12-month savings, contributions and essential spend through Ledger/Budgeting ports | Opus | backend-architect | 4.1 shapes |
| 4.4 | Deterministic projection engine, pure: real dollars, per-bucket recursion, glidepath, SS, pension, guardrails, solve-for-required-savings | Opus | backend-architect | 4.2 shapes |
| 4.5 | Monte Carlo in a `worker_thread`: block bootstrap + parametric, xoshiro256++, stored seed, resource limits, common random numbers | Opus | performance-engineer | 4.4 |
| 4.6 | Projection service and store: scenarios, runs, percentiles, life events, cache by hash, `ProjectionCompleted` + `GoalOffTrack`; migration 0022 | Opus | backend-architect | 4.4, 4.5 shapes |
| 4.7 | The Phase 3 gap-field sources: `allocation_targets`, employer-stock tag, idle-cash dwell + earmark composition; migration 0023 | Sonnet | backend-architect | 4.1 (earmarks) |
| 4.8 | REST surface: goals, contributions, risk profile, assumptions, scenarios, projections, required savings, life events, **and the scope-consent route** | Sonnet | backend-architect | 4.1, 4.2, 4.6 |
| 4.9 | Advisor catalog v3: R1–R7, the `goals.list` / `risk.profile` arms, and the one new scope (contract 1.2.0 + migration 0024) | Opus | backend-architect | 4.6, 4.8 |
| 4.10 | UI: `_app.plan.tsx` — fan chart, dotted gap line, life events, scenario compare, assumptions panel | Sonnet | frontend-architect | 4.8 contracts |
| 4.11 | UI: the client projection Web Worker, slider interactivity, and server/client golden-vector parity | Sonnet | frontend-architect | 4.5 spec, 4.10 shell |
| 4.12 | Phase 3 carry-over package: the Phase 3 gate's conditions, the port's last single identifier, export-bundle coverage, the route-level FX test | Sonnet | backend-architect | Phase 3 gate verdict |
| 4.13 | Scale seed: 200 positions × 5 years, and the perf harness the 800 ms budget is measured on | Sonnet | performance-engineer | 4.5 |
| 4.14 | Quality pass: reference-calculator fixtures, engine invariants, the numeric-boundary extension, exit-criteria audit | Sonnet | quality-engineer | all |
| Phase 4 gate | Independent security + architecture gate: sabotage every new control, walk the production stack in a real browser to `/plan`, observe a scheduled projection run, verdict to `docs/evidence/phase-4/gate-security-review.md` | Opus | security-engineer | all |

### WP 4.1 — Goals, contribution plans, risk profile (the serial gate)

**Scope.** `goals` (`kind retirement|emergency_fund|purchase|sabbatical|custom`, `name`, `target Money`,
`target_date DATE`, `priority`, `funded_from_account_ids`, `status`), `goal_contributions` (a plan, not a
ledger: `cadence`, `amount Money`, `escalation_pct`, `starts_on`, `ends_on`, `source enum(DERIVED, USER)`
with the derivation's `as_of` when `DERIVED`), `risk_profile` (`tolerance`, `horizon_years`,
`tax_bracket_band` — **a band, never a figure**, 08 §4.2 — `liquidity_need`, `answers JSONB`,
`consistency_penalty`, `answered_at`), `cash_earmarks` (a named reservation of cash against a goal, which
is what "not earmarked" in 07 I3 means). The **consistency-penalty questionnaire** (02 §3, the Wealthfront
Path row: *"risk questionnaire with a consistency penalty"*): the instrument asks the same risk
disposition in at least two framings — a stated-preference question and a revealed-behaviour question —
and when the two disagree the score moves toward the **more conservative** answer by a penalty that is
recorded, shown and explainable. A questionnaire that averages an inconsistency is a questionnaire that
launders it. `tolerance` is derived, never typed in, and the derivation is one pure function with the
answers stored beside it so the score can be re-derived from the record. **`target` and `amount` are
`Money`; `escalation_pct` is a decimal string; no `number` crosses either.** A goal whose target date is
in the past, or whose funding accounts do not exist, is a typed domain refusal (`domain` family,
409/422 per CONVENTIONS), never a silently clamped value.
**Owns.** `packages/contexts/planning/src/{goals,contributions,risk-profile,earmarks}.ts`, additions to
`packages/contexts/planning/schema/index.ts` and `OWNERSHIP.md`, `packages/db/migrations/0020_planning_goals.sql`.
**Events.** Emits `planning.GoalCreated`, `planning.RiskProfileAnswered`. **Migrations.** 0020.
**Exit tests.** `test/risk-profile.test.ts` → `'two framings of the same question disagree and the score moves conservative, not to the mean'`, `'the consistency penalty is stored and the score is re-derivable from the stored answers alone'`, `'tax_bracket_band is a band and the exact income never reaches the row'`; `test/goals.test.ts` → `'a goal target is Money and a contribution escalation never becomes a float'` (a `fast-check` property), `'a target date in the past refuses with a domain error rather than clamping'`; `test/db/goals.test.ts` → `'every new table carries user_id and refuses another user's row'`.
**Evidence.** `docs/evidence/phase-4/wp4.1-goals.md`: the questionnaire's items with the two framings
side by side and the penalty arithmetic shown on three worked answer sets, including one consistent and
one maximally inconsistent; the band boundaries with the income that produced each; every column's type
with a grep proving no `number` reached a `Money` or a rate; why `cash_earmarks` lives here and not in
Investments.

### WP 4.2 — Assumptions: one file, versioned, cited

**Scope.** 07 §5.5 asks for `config/assumptions.yaml`, *"versioned, user-overridable, **with the source
string displayed in the UI next to each number**"*, and Appendix A asks for `config/tax/us_2026.yaml`
*"keyed by year, never inlined in code"*. This repo has no YAML loader and D14 says not to add one for
this; the file is therefore **a checked-in TypeScript module under `packages/contexts/planning/data/`**
— the `packages/contexts/investments/data/asset-classes.json` precedent (WP 3.1) — exporting a frozen,
schema-validated structure with **a `source` string and an `as_of` date on every single number**, and a
content hash computed at load. Contents: Appendix A's 2026 US parameters in full (401(k)/IRA/HSA limits
and catch-ups, bracket thresholds, LTCG breakpoints, NIIT, the $3,000 capital-loss offset, SS COLA
2.8% / wage base $184,500 / bend points $1,286 and $7,749 / FRA 67 / 8%-per-year delayed credit, RMD ages
73 and 75 with the April-1 two-RMD trap, the digital-asset table) and §5.5's capital-market assumptions
(US equity 6.5%/17%, intl 7.0%/19%, EM 7.5%/24%, US agg 4.5%/6%, TIPS 2.0% real/6%, cash 3.5%/1.0%,
**crypto 6.5%/70% with its mandatory disclaimer**, inflation 2.5%/1.5%, wage growth = inflation + 0.5%)
and the eight-asset correlation matrix. `plan_assumptions` stores **only the user's deltas** against a
named file version, never a copy — an override that silently pins a stale default is worse than no
override. Every projection run records `assumptions_version` (the content hash), which is what makes 07
§7.3's *"why did it say $720?"* answerable six months later. **Rates and ratios are decimal strings;
money limits are `Money`.** The `macro_observations` question from WP 3.4's open items is decided here.
**Owns.** `packages/contexts/planning/data/assumptions.ts`, `packages/contexts/planning/data/us-2026.ts`,
`packages/contexts/planning/src/assumptions.ts`, `packages/db/migrations/0021_plan_assumptions.sql`.
**Events.** Emits `planning.AssumptionsOverridden`. **Migrations.** 0021.
**Exit tests.** `test/assumptions.test.ts` → `'every number in the assumptions file carries a non-empty source and an as_of date'` (walks the whole structure; a new number with no citation fails the build — this is the §5 exit criterion "cited"), `'the content hash changes when any value changes and not when a comment does'`, `'an override stores a delta and never a copy of the default'`, `'a 2027 lookup fails loudly rather than silently reusing 2026'`; `test/db/assumptions.test.ts` → `'a stored override resolves against its named file version, and an unknown version refuses'`.
**Evidence.** `docs/evidence/phase-4/wp4.2-assumptions.md`: the full parameter table with the Appendix A
line and the primary source beside each; the hash computed twice in two processes and shown equal
(D3-adjacent determinism, and the 3.10a §7.3 non-determinism is why it is checked); the override
round-trip; the macro decision written down with its reason.

### WP 4.3 — Revealed behavior (rolling 12 months)

**Scope.** 09 GOAL-4, normative: *"contribution rates are derived from observed transfers over the
trailing 12 months (and are overridable), and retirement spending is anchored to his observed
non-savings spending (with one-offs excluded)."* A pure derivation over four injected ports — **Planning
declares them and imports no new context.** 08 §1.6 draws `plan → ledger` and `plan → invest`, and draws
**no** `plan → budg` arrow, so the essential-spend read (07 §5.6's `floor_spending = essential_spend`
over D19's NEED-class categories) arrives as a `SpendingReader` port bound in `apps/api/src/domain.ts` —
the WP 3.8 pattern, `packages/contexts/planning/src/ports.ts`'s own header explains why a port is the
consumer's description of its need. Derivations: gross income, savings rate, per-bucket contributions
(from transfers into `TAX_DEFERRED`/`ROTH`/`TAXABLE`/`HSA` accounts, excluding internal transfers, which
Phase 1's pairing already labels), essential vs discretionary spend, and **one-off exclusion**: a single
transfer more than `k` standard deviations above the trailing distribution, or exceeding a stated
multiple of the median, is excluded and **named in the output** — 09 E10's edge case is explicit that a
$40k house-deposit move is not a monthly contribution rate. Every derived number is returned with its
`source: 'DERIVED'`, its window, and the count of observations behind it; a window with fewer than a
stated minimum of months returns `insufficient_history` rather than a confident annualisation.
`onBudget` reuses `defaultFlagsFor` (wp3.8 §7) rather than inventing a second derivation.
**Owns.** `packages/contexts/planning/src/{revealed,windows}.ts`, additions to
`packages/contexts/planning/src/ports.ts`.
**Events.** None (pure). **Migrations.** None.
**Exit tests.** `test/revealed.test.ts` → `'a $40,000 one-off transfer is excluded and named, and does not move the monthly contribution rate'`, `'an internal transfer never counts as a contribution'`, `'four months of history returns insufficient_history and not an annualised number'`, `'essential spend comes from NEED-class categories and never from a total minus a guess'`; `test/ports.test.ts` → `'the SpendingReader binding is assignable from @ctx/budgeting's reader with no adapter'` (the compile-time check 3.8 established).
**Evidence.** `docs/evidence/phase-4/wp4.3-revealed.md`: the twelve-month window walked on the seed with
every excluded transaction listed and its exclusion reason; the savings rate computed by hand beside the
query result; the `insufficient_history` path shown; the port table with the context each binding reads
and the arrow direction it respects.

### WP 4.4 — Deterministic projection engine (pure)

**Scope.** No database, no I/O. 07 §5.2 verbatim: **work in real (today's) dollars internally**,
`r_real = (1+r_nominal)/(1+i) − 1`, `g_real = (1+wage_growth)/(1+i) − 1`; accumulation with the mid-year
contribution convention `B_{t+1} = B_t(1+r_real) + C_t(1+r_real)^0.5`; decumulation
`W_t = spend_t − SS_t − pension_t − other_t`, `B_{t+1} = (B_t − W_t − tax_t)(1+r_real)`; the recursion
run **per tax bucket**, each with its own allocation and therefore its own `r`. Glidepath as a pluggable
function evaluated per period (07 §5.9: default `clamp(110 − age, 30, 90)/100`, plus target-date table,
rising-equity bond tent, and static). Social Security per 07 §5.8's seven steps — AWI indexing, AIME over
the highest 35 years / 420, the 2026 bend points from WP 4.2's file, FRA 67, −5/9 of 1% per month for the
first 36 early months and −5/12 beyond, +8%/yr to 70, COLA — with the **"75% benefit after 2034" stress
toggle** 07 §5.8 calls an honest lever. Pensions as a typed income stream with its own COLA flag.
Guyton-Klinger guardrails per §5.6 with the **spending floor** and the **20% cumulative-real-cut cap**
that Kitces' critique requires, and the output reports *both* success and "worst-case spending cut in the
5th-percentile path". **Solve-for-required-savings** (09 GOAL-7, the dotted gap line): a deterministic
bisection returning the additional monthly contribution that closes the gap by the target date, returning
a typed `unreachable` with the binding constraint named when no contribution closes it — never a number
that implies it does. **The numeric boundary is declared here and nowhere else:** inputs arrive as
`Money` / `DateOnly` / decimal-string rates, are converted once at a single named function, the engine's
interior is `number`, and results re-enter as `Money` rounded once at the boundary (04 §5.6, CONVENTIONS
"Floats are correct for Monte Carlo… They may never flow back into a `*_minor` column without an
explicit, rounded conversion").
**Owns.** `packages/contexts/planning/src/engine/{deterministic,glidepath,social-security,pension,guardrails,solve,boundary}.ts`.
**Events.** None (pure). **Migrations.** None.
**Exit tests.** `test/engine/boundary.test.ts` → `'Money survives a round trip through the engine boundary for every amount up to 1e15 minor units'` (a `fast-check` property, both directions), `'the engine interior is reachable only through toEngineAmount and fromEngineAmount'`; `test/engine/deterministic.test.ts` → `'the projection matches the committed reference-calculator fixture within 1%'` (the §5 exit criterion), `'zero returns and zero contributions leave the balance constant'`, `'real and nominal never mix: a nominal display toggle changes no stored value'`; `test/engine/social-security.test.ts` → `'the published 2026 bend points reproduce a known AIME to PIA case to the dollar'`, `'claiming at 62 and at 70 straddle FRA by exactly the published adjustment'`; `test/engine/guardrails.test.ts` → `'the 1973 and 2000 Guyton-Klinger cohort paths reproduce their published shape'`, `'cumulative real cuts never exceed 20% and never breach the spending floor'`; `test/engine/solve.test.ts` → `'a gap no contribution can close returns unreachable and names the binding constraint'`.
**Evidence.** `docs/evidence/phase-4/wp4.4-deterministic.md`: one worked 30-year path in a table with the
arithmetic per year; the reference comparison with the percentage difference per checkpoint and the
worst case stated; the SS calculation walked step by step against SSA's published example; the guardrail
path shown for a bad first decade with the cut cap binding; the boundary functions quoted with every
call site enumerated.

### WP 4.5 — Monte Carlo in a `worker_thread`

**Scope.** 07 §5.3–5.4 and 08 §7.2. **Stationary block bootstrap by default** (`p_stay = 1 − 1/12`,
E[block] = 12 months) over real monthly returns, with **parametric multivariate lognormal (Cholesky)
available for sensitivity**; crypto is its **own asset class**, Student-t(ν=3) or a BTC block bootstrap,
**never folded into equity and never lognormal** (07 §6.4). 10,000 paths default. **Seeded
xoshiro256++, written here, not imported** — `packages/seed/src/prng.ts`'s header already names this
engine as the thing "identical seed, identical bytes" is graded on, and a PRNG from npm is a
supply-chain dependency on the definition of correctness. **Common random numbers** across every what-if
comparison, so a 1% savings change shows its effect and not the noise (07 §5.4 detail 1); **do not stop
at failure** — keep simulating on SS and pension alone to report shortfall magnitude (detail 2);
**sequence-of-returns risk reported explicitly** as success conditional on the first-five-year return
decile (detail 3). `Float64Array` buffers, no allocation in the inner loop, percentiles by partial sort
over retained checkpoints only (08 §7.2's ≤100 ms line). Runs in a **`worker_thread` with declared
`resourceLimits`** (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `stackSizeMb`), an empty `env`,
no inherited `execArgv`, a hard deadline after which the worker is **terminated** rather than awaited,
and a refusal — before spawning — of any path count or horizon outside a stated envelope. The worker
receives a plain structured-cloneable input and returns bands, never 10,000 paths. **A probability-
targeted solver** (09 GOAL-7's default 80%) bisects over the MC with common random numbers, so the
answer is stable across re-runs by construction.
**Owns.** `packages/contexts/planning/src/engine/{montecarlo,prng,bootstrap,worker-host}.ts`,
`packages/contexts/planning/src/engine/monte-carlo.worker.ts`,
`packages/contexts/planning/data/returns/**` (the vendored historical series and its checksum).
**Events.** None of its own. **Migrations.** None.
**Exit tests.** `test/engine/reproducible.test.ts` → `'an identical seed produces byte-identical output across two processes'` (the §5 exit criterion; serialise the result and compare buffers, not objects — an in-process re-run does not prove it), `'a different seed produces different output'` (the control that stops the first test passing against a constant); `test/engine/invariants.test.ts` → `'zero volatility makes the Monte Carlo median equal the deterministic path'` (07 §8.4 invariant 1), `'success rate is monotone in savings rate, monotone in retirement age, and monotone decreasing in spending'` (a `fast-check` property, invariant 2), `'the p5 estimate is stable within 1% across ten seeds at n=10,000'` (invariant 3); `test/engine/crypto.test.ts` → `'crypto is drawn from its own distribution and a 70% sigma never enters the equity draw'`, `'the dual projection reports the plan with crypto at zero'` (07 §6.4 treatment 2); `test/engine/worker-limits.test.ts` → `'a request for 10,000,000 paths is refused before a worker is spawned'`, `'a worker that exceeds its deadline is terminated and the caller receives a typed timeout, not a hang'`, `'the worker inherits no environment and no execArgv'`; `test/engine/perf.test.ts` → `'10,000 paths over 40 years complete within 800 ms p95 on one core'` (the §5 exit criterion; measured on WP 4.13's scale plan, every sample printed, warm-ups excluded).
**Evidence.** `docs/evidence/phase-4/wp4.5-montecarlo.md`: the byte-identity proof with both digests
shown and the two process ids; the invariant table with each property's shrunk counterexample search
stated; the timing distribution with p50/p95/p99 and the core it ran on; the `resourceLimits` block
quoted with each limit's reason; the vendored return series with its provenance, licence and checksum;
the sequence-risk table by first-five-year decile.

### WP 4.6 — Projection service, scenarios, life events, store

**Scope.** `plan_scenarios` (a named fork of a baseline with its lever deltas — 07 §5.10's
`{retire_age, savings_rate, annual_spending, expected_return_shift, ss_claim_age, part_time_income,
one_time_windfall, glidepath}` — never a copy of the whole plan), `plan_life_events` (a dated, typed,
signed `Money` event: inheritance, home purchase, college, sabbatical), `projection_runs` (`seed`,
`engine_version`, `assumptions_version`, `input_digest`, `paths`, `duration_ms`, `success_probability`),
`projection_percentiles` (p5/p10/p25/p50/p75/p90/p95 per period). **Cache by
`hash(assumptions + engine_version + seed + input)`** and re-serve an identical request from
`projection_runs` (04 §5.6). **The server is authoritative for saved scenarios** (D20). Emits
`planning.ProjectionCompleted` and **`planning.GoalOffTrack`** when a goal's funded ratio falls below its
required-by-date pace (07 R6). A nightly `planning.projection_refresh` schedule — **the name must match
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`**, the Phase 2 worker crash-loop — recomputes the baseline and nothing
else; a scenario is recomputed when it is opened. **Fixes `SnapshotJobDependencies.portsFor` to take the
job's `userId`** (wp3.w §10 item 7), which is `@ctx/planning`'s change and this WP's, and which Phase 4
forces by adding a second Planning job. A run whose `assumptions_version` no longer resolves is shown as
**stale with its version named**, never silently recomputed against today's defaults — that is the same
rule `net_worth_daily`'s seal enforces one table over.
**Owns.** `packages/contexts/planning/src/{projection-service,scenarios,life-events,projection-store}.ts`,
`packages/contexts/planning/src/jobs.ts` (additions), `packages/db/migrations/0022_plan_projections.sql`.
**Events.** Emits `planning.ProjectionCompleted`, `planning.GoalOffTrack`. Schedule
`planning.projection_refresh` at **04:30 local**, after `planning.net_worth_snapshot`'s 04:00 and the
02:00 seal. **Migrations.** 0022.
**Exit tests.** `test/db/projection-store.test.ts` → `'an identical request is served from projection_runs and does not re-run the engine'`, `'a run records its seed, engine version and assumptions version, and a missing one refuses the insert'`; `test/db/scenarios.test.ts` → `'a scenario stores lever deltas and never a copy of the baseline'`, `'a scenario compare reports the delta in success probability and in retirement date, computed under common random numbers'`; `test/goal-off-track.test.ts` → `'a goal below its required pace emits GoalOffTrack exactly once per evaluation, not once per consumer delivery'` (the 3.2 re-delivery defect, not repeated); `test/db/stale-assumptions.test.ts` → `'a run against a retired assumptions version reads back as stale and is never silently recomputed'`; `test/ports.test.ts` → `'portsFor takes a userId and a job for a second holder is served, not refused by name'`.
**Evidence.** `docs/evidence/phase-4/wp4.6-projection-service.md`: the cache key's inputs enumerated with
one changed at a time and the hit/miss observed for each; a scenario compare table with the two runs'
seeds shown equal; the `GoalOffTrack` idempotence proof with event counts before and after a redelivery;
the schedule registration lines for the orchestrator, names pinned.

### WP 4.7 — The Phase 3 gap-field sources (I1, I3, I5)

**Scope.** The other half of the 3.10a ruling. **`allocation_targets`** (`user_id`, `asset_class`,
`target_weight` as a decimal string, `band_pct` defaulting to 07 I1's absolute 5 points, `set_at`) —
**owned by `@ctx/investments`, not Planning**, because 08 §1.6's arrows point down and
`@ctx/investments` may not read `@ctx/planning`; drift is an investments analytic, `GET
/investments/drift` is an investments route, and WP 3.3's `drift()` already takes targets as an argument.
`risk_profile` (Planning, WP 4.1) *suggests* a target set; the stored set is Investments'. **`security_tags`**
(`user_id`, `security_id`, `tag employer_stock|watchlist|…`) — the holder's own tag, set explicitly, and
07 I5 forbids inferring an employer, so no heuristic may write this row. **Idle cash** needs no new table:
dwell is derivable from `holdings_snapshots` (daily since migration 0014) and the earmark is WP 4.1's
`cash_earmarks` — and because Investments may not read Planning, the two are **composed in
`createInsightsInvestmentsPort` at the composition root**, which is allowed to read both because Insights
reads broadly through one assembler (08 §1.3 #9). This WP writes the investments side and **specifies**
the `apps/api/src/domain.ts` composition for the orchestrator's wiring batch; it does not edit that file.
It also re-derives 3.10a's silence test rather than deleting it.
**Owns.** `packages/contexts/investments/src/{targets,tags,dwell}.ts`, additions to
`packages/contexts/investments/schema/index.ts` and `OWNERSHIP.md`,
`packages/db/migrations/0023_allocation_targets.sql`, and the assertion changes in
`packages/contexts/insights/test/phase3-advisors.test.ts` **only**.
**Events.** Emits `investments.AllocationTargetsChanged`. **Migrations.** 0023.
**Exit tests.** `test/targets.test.ts` → `'targets that do not sum to 1.0 are refused, and the refusal names the shortfall'`, `'an unset target set still suppresses drift rather than implying 60/40'` (07 §8 Q9, sabotage-tested); `test/tags.test.ts` → `'no code path infers an employer stock tag from a name, a ticker or a payroll descriptor'` (a grep-backed structural test, the 3.5 `no-trade-surface` pattern); `test/dwell.test.ts` → `'idleDays is measured from holdings_snapshots and an earmarked balance is never idle'`; `packages/contexts/insights/test/phase3-advisors.test.ts` → the re-derived `'the investing rules with no field behind them are silent, and it is these three'` becomes `'I1, I3 and I5 now fire on the seed, and the rules with no field behind them are exactly the ones still named'` — **the assertion that I4 and I2 fire on the same run must survive**, or the test proves nothing.
**Evidence.** `docs/evidence/phase-4/wp4.7-gap-fields.md`: the 3.10a table reproduced with each row's
`Hardcoded` column replaced by its source; the ownership argument for `allocation_targets` written out
with the arrow it would have violated; each of I1/I3/I5 shown firing on the seed with its evidence refs;
the employer-tag structural test's grep output.

### WP 4.8 — REST surface, and the consent route

**Scope.** Phase 2's lesson applied for the third time: the routes package is dispatched *with* the
wave. `GET/POST/PATCH/DELETE /goals`, `/goals/{id}/contributions`, `GET/PUT /risk-profile` (the
questionnaire and its derived score, the score **read-only**), `GET /assumptions` (the file, every number
with its `source` and `as_of`) and `PUT /assumptions/overrides`, `GET/POST /plan/scenarios`,
`POST /plan/scenarios/{id}/projections`, `GET /plan/projections/{id}`,
`POST /plan/required-savings`, `GET/POST/DELETE /plan/life-events`, `GET /plan/compare?a=&b=`. Plus **the
scope-consent route** — `GET /advisors/{id}/scopes` and `PUT /advisors/{id}/grants` — which is the first
production caller `grantScopes` has ever had (wp2.6 §6, wp3.10a §7.1) and which is **step-up gated**
(D21: step-up for credential access; a standing grant of `holdings.detail` is that class of act). A
projection response carries `seed`, `paths`, `engineVersion`, `assumptionsVersion` and `durationMs` as
fields, never inferred by the client, and **`successProbability` is a decimal string, not a float, on the
wire**; every `Money` is `{ "minor": "…", "currency": "USD" }` per CONVENTIONS. Cross-user sabotages
follow §5 item 8: **every scoping predicate dropped, one at a time and then together.**
**Owns.** `apps/api/src/routes/{goals,plan,assumptions,advisor-grants}.ts`, additions to
`apps/api/src/routes/deps.ts` and `apps/api/src/app.ts`.
**Events.** None emitted; reads through published readers only. **Migrations.** None; **0025** is reserved
and used only if reported necessary.
**Exit tests.** `apps/api/test/db/plan-routes.test.ts` → `'every route refuses another user's data with each scoping predicate dropped individually and together'` (the WP 3.9 S1 finding, closed), `'a projection response never expresses a success probability as a JSON number'` (type-level plus a wire assertion), `'required-savings returns unreachable with its binding constraint rather than a number that implies a solution'`; `apps/api/test/db/assumptions-routes.test.ts` → `'every number in the assumptions response carries a source and an as_of'`; `apps/api/test/db/advisor-grants.test.ts` → `'granting a scope requires a fresh session'`, `'a scope absent from the published catalogue is refused by the route before the database refuses it'` (0019's lesson, moved one layer earlier).
**Evidence.** `docs/evidence/phase-4/wp4.8-routes.md`: the route table with step-up and every scoping
predicate per row; the multi-predicate sabotage matrix; the generated OpenAPI diff; **the `just check`
output appended** — the WP 2.r omission, still not repeated.

### WP 4.9 — Advisor catalog v3: R1–R7

**Scope.** Through WP 2.6's contract, `kind: builtin`, `confidence_basis: deterministic`. **R1–R7** per
master plan §5 and 07 §3.3: R1 savings rate below plan target, R2 Monte Carlo success below 80%, R3 the
Roth-conversion window before RMD age, R4 claiming-age comparison at 55+, R5 the 402(g) true-up trap,
R6 a goal below its required-by-date pace, R7 a withdrawal rate outside the guardrail band. `RuleWave`
gains **`'retirement'`** — 07 §7.4's week-4 wave, which `packages/contexts/insights/src/advisors/catalogue.ts:54`
already says *"waits for Phase 4's planning context"* — and the alert budget is applied **after** the
wave is released, not before. `goals.list` and `risk.profile` flip `sourcedInPhase2 → true` and gain
`SnapshotBuilder` arms and readers, **with no contract bump and no widening migration**: both are
already published at 1.0.0 and already inside 0019's `snapshot_grants_scope_check`.

**A new scope is needed and it is not free.** R2 and R7 need a success probability, a percentile band and
a guardrail position, and **no scope in the catalogue yields any of them** — `goals.list` yields name,
target, horizon and progress; `risk.profile` yields tolerance and a bracket band. WP 4.9 therefore adds
**`plan.projection`** (success probability, the p5/p50/p95 terminal band rounded, the withdrawal-rate
guardrail position, `assumptions_version`; **no balances, no account linkage, no dates finer than a
year**) and that means, in this exact order: advisor contract **1.2.0** (strictly additive minor, the
1.1.0 precedent), regenerated published schemas, `contract-parity.test.ts` green, **and migration 0024
widening `snapshot_grants_scope_check`** — because `apps/api/test/phase3-registration.test.ts` now parses
that CHECK out of the migration files and **fails the build if a contract minor ships without one**
(migration 0019's whole reason for existing). An agent that adds a scope and forgets the migration will
be told by the test; an agent that adds a scope and forgets the *contract bump* will not, so the brief
says both.

`lintInsightCopy` covers every new template unchanged, and 07 §7.2's banned list bites hardest here:
`\bwill (grow|earn|return)\b` and `\bguaranteed returns?\b` are exactly the phrases a projection wants
to use. The preferred form is quoted in 07 §7.2 — *"In 10,000 simulations using historical return
sequences, this plan lasted through age 95 in 86% of them"* — and **no rule may compound a speculative
return into a headline dollar figure** (§3.2). R2 reports probability points, not dollars. Every
advisory surface carries §7.2's disclaimer.
**Owns.** `packages/contexts/insights/src/advisors/builtin/retirement/**`, additions only to
`packages/contexts/insights/src/{contract/scopes.ts,contract/snapshot.ts,contract/version.ts,snapshot/builder.ts,snapshot/ports.ts,advisors/catalogue.ts}`,
`packages/db/migrations/0024_snapshot_grant_scopes_v1_2.sql`.
**Events.** Emits `insights.InsightProposed` via WP 2.6. **Migrations.** 0024.
**Exit tests.** `test/catalog-v3.test.ts` → `'every R rule produces at least one resolvable evidence ref on the seed'`, `'every R rule returns zero insights when its inputs are absent'`; `test/scope-minimization.test.ts` → `'plan.projection emits no balance, no account id and no date finer than a year'`; `test/contract-parity.test.ts` → `'the published schemas match the source at 1.2.0'`; `apps/api/test/phase3-registration.test.ts` → `'every advisor scope can actually be granted'` (3.10a's pinned list shrinks to empty and the recorded-gap branch is deleted); `test/copy-lint.test.ts` → `'"this plan will grow to $2.1M" fails the linter'`; `test/no-compounding.test.ts` → `'no R rule's headline impact is a compounded speculative return'`.
**Evidence.** `docs/evidence/phase-4/wp4.9-advisor-catalog-v3.md`: one table of R1–R7 with trigger,
formula, severity and the seed row that fires it; the `plan.projection` snapshot rendered with every
identifier stripped; the contract diff at 1.2.0 shown additive; the 0024 CHECK beside 0019's; the alert
budget applied after the retirement wave; the copy linter before and after a deliberate violation.

### WP 4.10 — UI: the plan screen

**Scope.** `_app.plan.tsx` replacing the placeholder at `apps/web/src/routes/_app.plan.tsx:11`
(`headline="No goals yet"`). **Monte Carlo fan chart** per 05 §3.4: five layered percentile bands
(p5–p95, p10–p90, p25–p75) from the **sequential blue ramp** — one hue, light outside to dark inside, a
sequential encoding of confidence and **not a rainbow** — plus a 2 px `--accent` median line **labelled
"median" in words**, which §5 names as an exit item because "the middle line" is read as "what will
happen". A dashed `--money-neutral` goal line with its crossing point direct-labelled; the tooltip reads
*"By 2054 there's a 75% chance you have at least $X."* **The clickable dotted gap line**: the gap between
the projected path and the goal is drawn dotted, and clicking it calls `POST /plan/required-savings` and
renders the answer — or renders `unreachable` with its binding constraint, never a number implying a
solution. **Draggable life events** on the timeline, each a typed dated amount, keyboard-operable (a drag
that only works with a pointer fails WCAG 2.2 AA, 05 §8.1). **Scenario compare** side by side with the
delta in success probability and in retirement date. **Assumptions panel**: every number with its
`source` and `as_of` visible without a click — the §5 exit criterion is *"visible, editable, cited"*, and
a disclosure that hides the citation behind a chevron satisfies two of three. Self-hosted visx only, **no
CSP directive may widen** (D26 is the single ratified exception). Fixes `Sidebar.tsx`'s 4.28:1 active-nav
token pair (wp3.11 §10 item 3) while adding the `/plan` entry.
**Owns.** `apps/web/src/routes/_app.plan.tsx`, `apps/web/src/features/plan/**`,
`apps/web/e2e/plan.spec.ts`, and the one token pair in `apps/web/src/app/shell/Sidebar.tsx`. May not
touch `e2e/support/mock-api.ts` or `app-walkthrough.spec.ts`.
**Exit tests.** `features/plan/*.test.tsx` unit; `e2e/plan.spec.ts` → `'the median band is labelled "median" in words and not only by position'`, `'clicking the dotted gap line renders a required monthly saving, and an unreachable gap names its constraint instead'`, `'a life event can be moved with the keyboard alone'`, `'every assumption shows its source and its as-of date without a click'`, `'two scenarios render side by side with the success-probability delta'`; axe clean on both themes.
**Evidence.** `docs/evidence/phase-4/wp4.10-plan-ui.md`: screenshots under both themes; the axe run; the
band palette validated with `scripts/validate_palette.js` (05 §3.5) and the output pasted; every number
on screen traced to the API field it came from (no client-side money math beyond formatting); the
Sidebar contrast re-measured.

### WP 4.11 — UI: the client projection worker

**Scope.** 05 §5.7 and D20. `src/workers/projection.worker.ts` over **Comlink**, spun up on route entry
(not first drag) with a `requestIdleCallback` warm-up; inputs include **the seed**; output is percentile
bands only as a transferable `Float32Array`, **never paths across the boundary**. While dragging: 250
paths for instant feedback; on pointer-up, 5,000 paths and a cross-fade, with a "refining…" state.
Sliders are Base UI `Slider` with an editable number input beside each. Fallback to the server endpoint
with a 300 ms debounce and a visible state when `Worker` is unavailable. **The server remains
authoritative for saved scenarios** — and the control that makes that safe is 05 §5.7's own suggestion,
made mandatory here: **a golden-vector fixture asserted identical by both the client worker and the
server engine for one seed**, committed once and read by both suites. If the two ever diverge, the
preview and the saved plan disagree and the feature is worse than not having it. No new CSP directive; the
worker is same-origin and bundled, not a blob URL (`worker-src` would have to widen, and D26 is the one
exception).
**Owns.** `apps/web/src/workers/**`, `apps/web/src/features/plan/sliders/**`,
`apps/web/e2e/plan-sliders.spec.ts`, `packages/contexts/planning/test/fixtures/golden-vector.json`
(read-only from the web side).
**Exit tests.** `apps/web/src/workers/projection.worker.test.ts` → `'the client worker reproduces the committed golden vector for its seed'`; `packages/contexts/planning/test/engine/golden-vector.test.ts` → `'the server engine reproduces the same committed golden vector'` (one fixture, two suites — this is the pair, and either alone proves nothing); `e2e/plan-sliders.spec.ts` → `'dragging a slider reshapes the bands without a network request'`, `'releasing the slider refines to full fidelity and the headline stops saying refining'`, `'with Worker unavailable the server fallback renders and says so'`; axe clean.
**Evidence.** `docs/evidence/phase-4/wp4.11-client-worker.md`: the golden vector with both digests shown
equal; a network trace during a drag showing zero requests; the frame timing during a drag; the CSP
before and after, byte-identical.

### WP 4.12 — Phase 3 carry-overs and gate conditions

**Scope.** §2's assigned rows, and nothing else. The Phase 3 gate's conditions implemented or recorded
as ruled-and-unchanged. `ProviderInvestmentTransactionFact.security` widened to carry the whole
`ProviderSecurityFact`, the 3.7a change applied to the transaction path across all four adapters.
`net_worth_daily`, `wallet_addresses` and the eleven new Planning tables added to the export bundle with
their revision ladders intact, and the import side proven. The route-level `fx_rate_missing` test at
`apps/api/test/db/net-worth-routes.test.ts` (wp3.14 §8 item 4). Phase 2's C-2/C-3 if the Phase 3 gate
did not discharge them. **Verify before building** every row marked "verify first" in §2 — 03 §2's
`pending_review` row is the precedent for a carry-over that was already stale when it was written down.
**Owns.** `packages/connectors/port/src/facts.ts` and the transaction path in the four adapters,
`apps/api/src/routes/export.ts`, `packages/contexts/*/src/export.ts` registry entries,
`apps/api/test/db/net-worth-routes.test.ts`.
**Events.** None new. **Migrations.** None expected; **0025** reserved.
**Exit tests.** `packages/connectors/port/test/facts.test.ts` → `'an investment transaction carrying only a FIGI and a holding carrying only a ticker resolve to one securities row'` (reproduced red first, the 3.7a method); `apps/api/test/db/export-import.test.ts` → `'a full export round-trips the plan — goals, assumptions, scenarios and runs — into a clean instance'`, `'net_worth_daily round-trips with its correction provenance intact'`; `apps/api/test/db/net-worth-routes.test.ts` → `'a missing FX rate surfaces in the route response and never as 1.0'`.
**Evidence.** `docs/evidence/phase-4/wp4.12-carry-overs.md`: §2's table with every row closed,
deferred-with-reason, or ruled; the port change reproduced red then green with the row counts; the export
manifest before and after with the new tables named.

### WP 4.13 — The scale seed and the perf harness

**Scope.** wp3.14 §8 item 6, closed. Extend `@core/seed` with a **scale** dataset: 200 positions across
at least four tax buckets, **five years of daily** `holdings_snapshots`, `prices` and `net_worth_daily`
(≈1,825 rows per series — 08 §7.1's net-worth chart budget is written against exactly that), a
multi-currency account with a real FX series, and a plan with goals, contributions and life events. It is
**a second dataset, not a replacement**: `generatePhase3Investments` is the correctness seed the exit
criteria reason about and stays byte-identical. The perf harness measures the §5 budget in **two
places**, because they answer different questions: the engine alone in
`packages/contexts/planning/test/engine/perf.test.ts` (one core, `worker_threads`, no HTTP, the 08 §7.2
number) and the whole path in `apps/api/test/db/projection-perf.test.ts` over real `fetch()` against
`ApiHarness.listen()` — the `phase2-reports-http-perf.test.ts` pattern WP 3.14 already reused. Both
assert their own row counts before timing anything: a perf number over an empty table is a lie, and
`docs/TESTING.md` already says so.
**Owns.** `packages/seed/src/phase4-scale.ts`, `packages/contexts/planning/test/engine/perf.test.ts`,
`apps/api/test/db/projection-perf.test.ts`, additions to `docs/TESTING.md`.
**Exit tests.** `packages/seed/test/phase4-scale.test.ts` → `'the scale seed generates 200 positions and five years of daily snapshots, byte-identically for a fixed seed'`; `packages/contexts/planning/test/engine/perf.test.ts` → `'10,000 paths over 40 years complete within 800 ms p95 on one core'`; `apps/api/test/db/projection-perf.test.ts` → `'POST /plan/scenarios/{id}/projections p95 is within budget over real HTTP'`, `'GET /net-worth/series over 1,825 points is within 150 ms p95'` (08 §7.1, now measurable for the first time).
**Evidence.** `docs/evidence/phase-4/wp4.13-scale-seed.md`: the dataset's shape with row counts per
table; every timing sample printed with p50/p95/p99 and the hardware named; the correctness seed's
digest shown unchanged; the Phase 3 numbers restated against the scale dataset with the difference
explained rather than buried.

### WP 4.14 — Quality pass

**Scope.** **Commit the reference-calculator fixtures** so *"within 1% of an independent reference"* is a
test and not a ceremony (§5 names the reference and the commit form). Extend
`scripts/check-numeric-boundaries.ts` for the engine: the MC kernel's `number` interior is legal
**only** behind WP 4.4's named boundary, so the ALLOW_LIST gains one entry per crossing function with
its reason — and the check must **fail** on a `number`-typed `amount`/`value`/`balance` anywhere else
under `packages/contexts/planning/src/`, including inside `engine/`. 07 §8.4's invariants as a shared
property-test module both engines run. The 07 §8.5 release gate's projection clause — *"MC golden-value
tests drift > 0.5pp"* — wired as a CI assertion. A cross-tool agreement record (07 §8.4 item 5): the same
inputs put through cFIREsim or FI Calc, with the tool, the date, the inputs and the resulting success
rate written into evidence; **not committed as a fixture** because it is a third-party web tool, and
recorded as a number with a date so a future divergence is visible. Audit every §5 exit criterion and say
which are proven, which need Chris's real accounts, and which are carried.
**Owns.** `packages/contexts/planning/test/reference/**`, `scripts/check-numeric-boundaries.ts`,
`docs/TESTING.md`, and `.github/workflows/ci.yml` jointly with the orchestrator.
**Exit tests.** `packages/contexts/planning/test/reference/reference.test.ts` → `'every committed reference case matches within 1%'` (the §5 exit criterion), `'a deliberately wrong engine constant pushes a case outside 1% and the test goes red'` (the control that proves the tolerance is doing work); `scripts/check-numeric-boundaries.test.ts` → `'a float assigned to a value inside the engine but outside the named boundary fails the check'`; `packages/contexts/planning/test/engine/golden-drift.test.ts` → `'a golden Monte Carlo value drifting more than 0.5 percentage points fails'`.
**Evidence.** `docs/evidence/phase-4/wp4.14-quality.md`: the exit-criteria audit table; each reference
fixture with its provenance and its formulas beside it; each new check sabotaged once and observed red;
the cross-tool comparison with its date; the boundary ALLOW_LIST additions each with a reason.

---

## 4. Waves

Dependency line from master plan §6.4: *engine ∥ projection UI (against a stub engine) ∥ domain reviewer
builds reference fixtures.* Ceiling is **three concurrent agents, at most two Opus** — the Phase 0/1
rate-limit lesson, re-confirmed by Phase 2's three session-limit kills and Phase 3's **three more in a
single day** (2026-09-22 01:10, 2026-09-23 18:45, 2026-09-24 11:45, each taking every agent then in
flight). Opus is spent only where there is **design latitude or a security surface**: the questionnaire's
construction, the assumptions contract, the engines, the store's determinism, and the advisor scope. The
routes, the UI, the seed and the carry-overs are Sonnet, and Phase 3 showed that is the right cut.

| Wave | Agents | Packages |
|---|---|---|
| A | 3 (2 Opus) | 4.1 goals + risk profile · 4.2 assumptions · 4.12 carry-overs |
| B | 3 (2 Opus) | 4.3 revealed behavior · 4.4 deterministic engine · 4.7 gap-field sources |
| C | 3 (2 Opus) | 4.5 Monte Carlo worker · 4.6 projection service + store · 4.13 scale seed |
| D | 3 (1 Opus) | 4.8 REST + consent · 4.9 advisor catalog v3 · 4.10 plan UI |
| E | 2 (0 Opus) | 4.11 client worker · 4.14 quality pass |
| F | 1 Opus | the Phase 4 gate |

**Why 4.2 is in Wave A and not with the engine.** Every number the engines use comes from that file, and
the §5 exit criterion "assumptions visible, editable, cited" is a *property of the file's shape*, not of
the engine. If the citation surface arrives after the engine, the engine will have inlined three
constants and the file will document them rather than supply them — which is exactly what Appendix A's
*"never inlined in code"* is a rule against. **Why 4.7 is in Wave B and not Wave A.** It needs
`cash_earmarks` from 4.1 and nothing else, and it is the one Wave B package a Sonnet can carry.
**Why 4.13 is in Wave C rather than with the quality pass.** The 800 ms budget is 4.5's exit test, and an
exit test that cannot run until the quality pass is not an exit test.

**UI packages code against contracts, never against a guess** — Phase 2's `notification-settings`
failure, a spec waiting on `/channels/{id}/test` when the real route was `/verify`, is what a guessed
path costs, and it cost a full CI cycle and an agent. **4.10 and 4.11 own disjoint `features/`
directories and e2e specs, and neither may touch `e2e/support/mock-api.ts` or `app-walkthrough.spec.ts`;**
the orchestrator applies shared mock edits and the Playwright `testMatch` at the wave boundary.

Migration numbers are assigned before dispatch and are not negotiable in-flight. `ls
packages/db/migrations` at `e03fdb8` shows **0019 as the highest, so 0020 is genuinely free** — and
note that 0018 was reserved for WP 3.9 and taken by WP 3.7 instead, which is why numbers are assigned per
work package here and confirmed at dispatch rather than reserved for a pair:

| Migration | Tables | WP |
|---|---|---|
| **0020** `planning_goals` | `goals`, `goal_contributions`, `risk_profile`, `cash_earmarks` | 4.1 |
| **0021** `plan_assumptions` | `plan_assumptions` | 4.2 |
| **0022** `plan_projections` | `plan_scenarios`, `plan_life_events`, `projection_runs`, `projection_percentiles` | 4.6 |
| ~~**0023**~~ → **0026** `allocation_targets` | `allocation_targets`, `security_tags` | 4.7 — **renumbered 2026-09-26**: `security_tags`' composite FK targets the `UNIQUE (user_id, id)` on `securities` that WP 4.12a's 0025 creates, and 0023 runs before 0025; 0025 was already immutable, so 0023 is burned and 4.7 took 0026 (execution log 17:40 EDT) |
| **0024** `snapshot_grant_scopes_v1_2` | the `snapshot_grants_scope_check` widening for `plan.projection` | 4.9 |
| **0025** | reserved for 4.8 / 4.12, used only if reported necessary | — |

Two waves may not both claim a number. **0024 is conditional on 4.9 adding a scope and must ship in the
same commit as the contract bump** — `apps/api/test/phase3-registration.test.ts` fails the build
otherwise, which is migration 0019's entire lesson mechanised.

### Shared files an orchestrator applies between waves

No agent edits these. The orchestrator applies them once per wave boundary, then runs `just verify`.

1. **`vitest.config.ts`** — **no new project.** `planning` (line 310) and `planning-db` (line 321) have
   existed since WP 3.8's shared-file batch, and `node scripts/check-ci-projects.ts` reports **40
   projects (25 in `test`, 16 in `migration-test`, `testkit` deliberately in both)** at `e03fdb8`. It
   should still say 40 at the end of Phase 4. If an agent asks for a project, the answer is almost
   certainly that its test is in the wrong package. The one legitimate edit is widening `planning`'s
   `include` if the engine tests land outside `src/`, which is the edit WP 3.14 had to make for `seed`.
2. **`scripts/eslint-boundaries.js`** — the `planning` layer already exists (line 568) and already allows
   `@ctx/ledger` and `@ctx/investments` (08 §1.6's downward arrows), including the fix WP 3.8 had to make
   so the allow-list was reachable at all (line 737's comment). Phase 4 needs **no new layer and no new
   context allowance** — and specifically **must not add `@ctx/budgeting` to planning's allow list**:
   08 §1.6 draws no `plan → budg` arrow, and WP 4.3's essential-spend read is a port bound at the
   composition root, not an import. `node:worker_threads` is not in `no-restricted-imports`' paths or
   `CRYPTO_PRIMITIVES` (checked at `e03fdb8`), so the worker needs no carve-out.
3. **`apps/api/src/platform.ts`** — `module.planning`'s description and `removeWhen` widen from "the
   net-worth snapshotter" to Planning proper, which `wp3.8-net-worth.md` §9 asks for by name. It stays
   `defaultEnabled: true`; the new consumers and the new schedule arrive behind the same flag, and WP
   4.14 proves flag-off registers nothing (the 2.13 pattern, re-proved in 3.14).
4. **`apps/api/src/modules.ts`** — the `planning.projection_refresh` schedule (**the name must match
   `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`** — the Phase 2 worker crash-loop), the new consumers and job kinds,
   and the `portsFor(userId)` signature change from WP 4.6 threaded through `planningModule` (which today
   *refuses a job for another holder by name*, `modules.ts:548`). **`apps/api/src/domain.ts`** — the
   `SpendingReader`/`ContributionsReader` bindings WP 4.3 specifies, and the composed `idleCash` and
   `targets` arms in `createInsightsInvestmentsPort` that WP 4.7 specifies. **A new consumer starts at
   `seq = 0`** and catches up over the full event history on first boot (08 §3.4); Phase 3's history is
   now long enough that this is a real number on the cold walk, and the walk must budget for it.
5. **`packages/db/test/migrate.test.ts`** — the exact alphabetical table list (**81 names at `e03fdb8`** →
   92) and the per-migration attribution comment block above it.
6. **`.github/workflows/ci.yml`** — the two hand-maintained `--project` lists need no change (no new
   project), but the **prose project→job map in the header does**, and `scripts/check-ci-projects.ts`
   does not check prose. Add the Phase 4 paragraph the way Phase 1 and Phase 3 added theirs.
7. **`apps/web/playwright.config.ts`** — the `chromium` `testMatch` regex (line 78) gains `plan` and
   `plan-sliders`. This is the edit WP 3.11 and WP 3.12 both needed and neither could make, and their
   specs were invisible to CI until an orchestrator made it. One token, one wave boundary, both UI WPs.
8. **`packages/contracts/`** — regenerate with `just openapi` after Wave D, then regenerate
   `apps/web/src/api/generated/`. If WP 4.9 bumps the advisor contract, regenerate the published advisor
   schemas in the **same** commit as migration 0024. `scripts/check-proxy-routes.ts` should stay green
   without a `docker/Caddyfile` edit; if it does not, that is a finding, not a routine edit. **No CSP
   directive may widen** — D26 is the one ratified exception and Phase 4 adds nothing: the projection
   worker is same-origin and bundled, not a blob URL.
9. **Config and secrets batch** — **nothing new.** Phase 4 adds no provider, no egress host and no
   credential. That is worth stating rather than leaving as an absence: Phase 3 added two allow-lists and
   seven secrets, and a phase whose secrets batch is empty should be noticed and confirmed, not assumed.
10. **Dependency batch** — **`comlink`** (MIT, ~4 kB, no transitive deps), the one library 05 §5.7 names
    by name, for WP 4.11. Optionally **`@visx/threshold`** (MIT, 4.0.0 to match the ten `@visx/*`
    packages already pinned in `apps/web/package.json`) if the fan's bands are cleaner with it than with
    `@visx/shape`'s `Area`; WP 4.10 reports which before the batch is applied. **The `@core/secretbox`
    dependency on `@ctx/insights`** from §2, if Chris rules that way (§6 Q6). Under the seven-day
    `minimumReleaseAge`, then a `THIRD_PARTY.md` restamp. **Rejected before an agent proposes it:**
    `decimal.js`/`big.js`/`bignumber.js` (rejected in Phase 3 and rejected again — `@core/kernel`'s
    `Money` and `Quantity` *are* the types); `seedrandom`/`d3-random`/`random-js` — xoshiro256++ is
    ~30 lines and the seed reproducibility exit criterion must not depend on a third party's idea of
    determinism, which is the same argument `packages/seed/src/prng.ts`'s header already makes;
    `simple-statistics`/`jstat` — a percentile over a `Float64Array` is a partial sort;
    `ml-matrix` — a Cholesky over an 8×8 correlation matrix is twenty lines and a dependency here is a
    dependency in the hot loop. Agents never run `pnpm install`.
11. **Data files.** WP 4.5 vendors historical return series (07 §5.5 names Shiller's `ie_data.xls`,
    Damodaran's `histretSP.xls`, FRED `CPIAUCSL`, SSA's AWI and life tables, and says *"cache all of
    these locally in the repo's `data/` directory with a fetch script and a checksum — a self-hosted app
    must work offline"*). There is **no `data/` directory in this repo today**; the precedent is
    `packages/contexts/investments/data/asset-classes.json`, so these land under
    `packages/contexts/planning/data/returns/` as derived CSV/JSON with a fetch script, a checksum and a
    provenance note. **This is a licence question, not just a file question** (D15): each source's terms
    must be checked and recorded before the batch is applied, and the licence gate runs over the runtime
    tree. §6 Q3.

---

## 5. Gate standard for Phase 4

Carried verbatim in force from the Phase 0, 1, 2 and 3 gates. Phase 2's gate ran 26 sabotages, all red on
the first valid attempt — what a mature control set looks like, and **not** a reason to run fewer.

1. **Independent reviewer.** An Opus `security-engineer` who wrote none of the code re-runs the
   load-bearing proofs. A gate may not validate its own fixes — Phase 1 needed D-2 for exactly that
   reason.
2. **Sabotage every new control and observe it go red** before accepting its PASS. Record which
   sabotages were red on the first try. A control that has never been observed failing is not evidence —
   and WP 3.13 is the standing example of what it costs to skip this: five shipped controls with no
   surviving proof, recoverable only by a later gate.
3. **Walk the production stack in a real browser**, through Caddy, on an image rebuilt from the landing
   commit, and **the walk must reach the code Phase 4 added**: a goal is created; the questionnaire is
   answered inconsistently and the score moves conservative on screen; the fan chart draws with a
   labelled median; the dotted gap line is clicked and returns a required monthly saving; a life event is
   moved with the keyboard; two scenarios compare; every assumption shows its source and date; a
   projection is saved and the re-opened result is byte-identical. **A login that stops at the shell
   proves nothing.**
4. **Every "never" claim has a test that fails when the thing is made to happen.** Phase 4's list: a
   projection never becomes non-reproducible for a fixed seed; a `number` never reaches a `Money` outside
   the named boundary; an assumption never changes without its version changing; a projection never reads
   a live balance in place of a sealed `net_worth_daily` row; a success probability never crosses the
   wire as a JSON number; an employer-stock tag is never inferred; a scope is never grantable before the
   contract publishes it; the Monte Carlo worker never inherits an environment.
5. **Every new vitest project is in `ci.yml` the day it is created.** Phase 4 should create none;
   `scripts/check-ci-projects.ts` should read **40/40** at the gate as it does at `e03fdb8`, and the gate
   confirms the check still fails when a project is dropped.
6. **The walk starts from a genuinely cold install** — `docker compose down -v`, `up`, bootstrap, no
   restart anywhere in between — **and it must observe a scheduled projection run actually fire**, not
   merely be registered: the gate waits out (or shortens) one `planning.projection_refresh` tick and
   shows `projection_runs` and `domain_events` rows appearing with no user action. Phase 2's worker
   crash-loop existed only on the cold path; Phase 3's wiring batch found a **pool-vs-lease deadlock that
   produced no error, no restart and no `worker ready` line** and was invisible to every unit test. The
   new consumers add leases; `assertPoolCoversLeases` must be re-checked against `DATABASE_POOL_MAX` at
   the gate, not assumed.
7. **`just verify`, not `just check`**, run at the landing commit — and CI on the real GitHub runner must
   also be green, because Phase 2 found four defects `just verify` structurally could not see and Phase 3
   found four more. **And the Phase 3 gate's conditions are inputs, not outputs:** if any condition has
   now skipped two gates (Phase 2's C-2 and C-3 are the candidates), the Phase 4 gate says so in its
   verdict as a process finding, not only as a condition.
8. **A cross-user sabotage drops every scoping predicate, individually and together.** WP 3.9's S1
   finding — dropping `holdings.user_id` alone left the route green because the securities join also
   scoped — means a single-predicate sabotage proves the predicate you did not test. New standard,
   effective this gate, applied to every Phase 4 route and re-applied to Phase 3's.

### Phase-4-specific risks

| Risk | Control | Proven by |
|---|---|---|
| **A float reaches money in the projection path.** D3 is irreversible. Phase 4 is the first phase where `number` is *legal somewhere*, which is precisely what makes it dangerous: "floats are correct for Monte Carlo" (CONVENTIONS) is one sentence away from "floats are correct". | `@core/kernel`'s `Money` and `Quantity` only outside the engine. `number` is legal **only** inside the Monte Carlo/deterministic kernel, reached through **one named pair of functions** in `packages/contexts/planning/src/engine/boundary.ts`, with results rounded once on the way out. `scripts/check-numeric-boundaries.ts` is extended to `packages/contexts/planning/src/**` with one ALLOW_LIST entry per crossing function and a written reason each. | WP 4.4 `boundary.test.ts` → the round-trip `fast-check` property in both directions; WP 4.14 extends the check and sabotages it (a float assigned to a `value` inside `engine/` but outside the boundary must fail); the gate greps the whole Phase 4 diff for `number` at a magnitude name and for new `toFixed(` calls, as it did for Phase 3. |
| **The Monte Carlo is not reproducible.** The §5 exit criterion and the v0.6 rung. The failure is silent and social: the user re-runs, sees 84% instead of 87%, and stops believing the number (04 §5.6). | xoshiro256++ written in-repo, seeded from a stored `bigint`; `Math.random()` and `Date.now()` already lint-banned outside `Clock`; **common random numbers** across every what-if; results compared as **serialised bytes across two processes**, never as objects in one. | WP 4.5 `reproducible.test.ts` → `'an identical seed produces byte-identical output across two processes'`, paired with `'a different seed produces different output'`; WP 4.11's golden vector asserted by both the client worker and the server engine; gate re-runs a saved scenario after a container restart and diffs the stored percentiles byte for byte. |
| **An assumption changes silently.** A projection is only auditable if "why did it say $720?" has an answer six months later (07 §7.3), and a default that drifts under a stored run is indistinguishable from a bug. | Assumptions live in one versioned file with a content hash; `plan_assumptions` stores **deltas against a named version**, never copies; every `projection_run` records `assumptions_version` and `input_digest`; a run whose version no longer resolves reads back **stale with the version named**, never silently recomputed. | WP 4.2 `'the content hash changes when any value changes and not when a comment does'`; WP 4.6 `'a run against a retired assumptions version reads back as stale'`; gate edits one assumption, re-opens a saved run, and observes the stale label rather than a new number. |
| **A projection reads live balances instead of sealed `net_worth_daily`.** Phase 3 built the seal so a past date cannot move; a projection that starts from today's live row would make yesterday's saved plan irreproducible through no fault of the engine — the seal defeated one layer up. | The projection's starting balances come from the **sealed** row for its `as_of` date, through Planning's own reader; the open day is usable only for a run explicitly marked `as_of = today`, and that run records it. `lint:schema-ownership` already refuses SQL in `packages/contexts/planning/` naming `accounts`, `holdings`, `prices` or `fx_rates`. | WP 4.6 `'a projection dated to a sealed day reproduces byte-identically after a re-sync changes today'`; gate re-syncs a connection, re-runs a saved dated projection, diffs. |
| **"Within 1% of an independent reference" is asserted rather than measured.** A reference nobody can re-run is a claim. | **Three references, two of them committed.** (a) A **LibreOffice Calc** model of 07 §5.2's accumulation and decumulation recursions driven by `FV`/`PMT`/`NPER`, exported as `reference/accumulation.csv` **plus a sibling `reference/accumulation.formulas.txt` holding the literal formula text per column** — the exact pattern WP 3.3's allocation spreadsheet fixture and `wp3.14-quality.md` §4 established, which the repo already knows how to keep honest. (b) **Published golden values** from 07 §8.4 item 1: Bengen's 4%-rule historical failure count over the Shiller series, and Guyton & Klinger's published 1973 and 2000 cohort paths, committed as `reference/published/*.json` with the citation in the file. (c) **A cross-tool check against cFIREsim or FI Calc** (07 §8.4 item 5) — *not* committed, because it is a third-party web tool; recorded in evidence as tool, date, inputs and success rate, so a later divergence is visible. | WP 4.14 `reference.test.ts` → `'every committed reference case matches within 1%'` **and** `'a deliberately wrong engine constant pushes a case outside 1% and the test goes red'` — a tolerance that never fails is not a tolerance; gate re-runs both and reads the formulas file. |
| **The Monte Carlo worker is an unbounded resource.** A `worker_thread` is in-process: an OOM there takes the API or the worker container with it, and the container is capped at 512/640 MB (08 §7.4). This is the first phase to spawn one. | Declared `resourceLimits` (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `stackSizeMb`), empty `env`, no inherited `execArgv`, a hard deadline that **terminates** rather than awaits, and a pre-spawn refusal of any path count or horizon outside a stated envelope. 100k-path power-user mode is a queued job with a notification, never on the interactive path (08 §7.2). | WP 4.5 `worker-limits.test.ts` → the three named tests; gate posts a 10,000,000-path request and a deliberately non-terminating plan and observes a typed refusal and a termination, with the container's memory watched. |
| **The 800 ms budget is measured on a toy.** `wp3.14-quality.md` §8 item 6 already flagged that the Phase 3 perf seed is a correctness seed; quoting headroom off it is how a budget becomes decoration. | The budget is measured **on WP 4.13's scale dataset** (200 positions, five years of daily rows), in two places — the engine alone at `packages/contexts/planning/test/engine/perf.test.ts` (one core, `worker_threads`, no HTTP, 08 §7.2's number) and the whole path at `apps/api/test/db/projection-perf.test.ts` over real `fetch()` against `ApiHarness.listen()`. Both assert their row counts before timing. Every sample printed, warm-ups excluded, hardware named. | WP 4.5 and WP 4.13 exit tests; gate re-runs both on the landing commit and compares to the recorded distribution rather than to the single p95 figure. |
| **A new advisor scope reaches the database before the contract publishes it.** 0019 exists because exactly this happened, and the failure was a runtime `23514` in front of whoever wired consent. | The contract minor, the regenerated published schemas and the widening migration ship in **one commit**; `apps/api/test/phase3-registration.test.ts` parses the latest CHECK across migrations and fails the build otherwise; WP 4.8's consent route refuses an unpublished scope **before** the database does. | WP 4.9's parity and registration tests; WP 4.8 `'a scope absent from the published catalogue is refused by the route before the database refuses it'`; gate adds a sixteenth scope to the enum with no migration and watches the build go red. |

---

## 6. Open questions for Chris

Work proceeds on the stated default; an answer is a cheap change.

1. **Retirement inputs** (§8 Q8). Default: **derive from data — target age 65, target spend from observed
   non-savings spending, Social Security at full retirement age (67)** — with every one of those three
   overridable in the assumptions panel and labelled `derived from your data` rather than `default`
   (09 GOAL-2 requires that distinction on screen). The consequence worth stating: a derived spend from
   twelve months that contained a one-off is a wrong plan, so WP 4.3 excludes one-offs and **names each
   exclusion on screen**. If you would rather state a number, that is one field.
2. **Monte Carlo default engine.** Default: **stationary block bootstrap** (07 §5.3's recommendation),
   with parametric lognormal available for sensitivity and historical cycles carried as the cut item.
   The master plan's §5 deliverable line says *"parametric lognormal by default, bootstrapped Shiller as
   an option"* and 07 §5.3 says the reverse. **This dispatch follows 07**, because the memo gives the
   reason — lognormal understates sequence risk, which is the dominant risk in early retirement — and the
   plan line gives none. Say the word and the default flips; it is a config value, not a rewrite.
3. **The historical return data files** (07 §5.5). Default: **vendor Shiller `ie_data.xls` and
   Damodaran `histretSP.xls` as derived CSV under `packages/contexts/planning/data/returns/`, with a
   fetch script, a checksum and a provenance note, and check each source's terms before the batch lands.**
   Both are published for research use and both are in universal use by FIRE calculators, but D15's
   licence gate runs over the runtime tree and "everyone does it" is not a licence. If either source's
   terms do not permit redistribution, the fallback is a fetch-on-first-run with a cached checksum — which
   costs the offline guarantee, and that is a trade you should make, not an agent.
4. **Plan terms for I8/I9/I10 and R5** — the 401(k) match formula, whether the employer offers a true-up,
   HDHP enrolment, year-to-date deferrals. Default: **not built; the four rules stay `CATALOGUE_GAPS`
   naming their missing field.** They need a `contributions.ytd`-shaped scope fed by data only you have.
   **I10 is a P0 in the plan's own list and would stay unwritten**, which is worth seeing plainly. If you
   will enter plan terms as assumptions, WP 4.9 can close three of the four in a day.
5. **Success-probability target.** Default: **80%** (09 GOAL-7's stated default) for the required-savings
   solver and **R2 fires below 80%** (07 R2). 07 §5.6 is worth reading alongside this: a 95% success rate
   achieved by cutting spending in half is not success, which is why the output reports the worst-case
   spending cut in the 5th-percentile path beside the probability, and why R2's headline is probability
   points and never dollars.
6. **The `@core/secretbox` merchant-pseudonym swap** — decided in Phase 3, pinned as `configHash`, and
   carried to a dependency batch that has not been applied. Default: **apply it in Wave A's batch and
   re-pseudonymise now**, while the stored evidence rows are Phase 2's and Phase 3's rather than Phase
   5's as well. The cost is monotonically increasing and this is the third phase it has been carried.
7. **Bitemporal storage** (07 §8.2: *"build this into the schema on day one; retrofitting it is
   miserable"*). Default: **not built, and recorded as a decision rather than an omission.** It is what
   point-in-time rule backtesting needs, it was not built in Phases 0–3, and retrofitting `valid_time` +
   `knowledge_time` across the ledger is a phase of its own. The consequence: 07 §8.2's backtest harness
   and §8.5's `NOT_TRUE`-rate release gate cannot be built, and rule tuning stays qualitative. Phase 5
   is where that bill comes due.
8. **Real-data exit criteria, now five** — two institutions on schedule, a month with zero internal
   transfers, the recurring gold set, a real brokerage's holdings reconciling to its statement, and **a
   projection run against real balances classified by real tax treatment**. Default: **Phase 4 closes on
   seed, scale-seed and fixture evidence**, all five carried to the first production link, where they
   become one verification session rather than a phase. The fifth is the only one a seed genuinely
   cannot stand in for: which of your accounts is `TAX_DEFERRED` and which is `ROTH` is a fact about your
   accounts, and it moves the answer more than any assumption in the file.
