# Phase 2 dispatch — budgeting, recurring, insights v1, notifications

*Written 2026-09-16 at `bb91e57`, while the Phase 1 D-2 re-walk runs. Companion to
[`01-execution-log.md`](01-execution-log.md), which stays the orchestrator's ledger; this file is the
work-package breakdown, wave plan and gate standard for Phase 2. Plan of record remains
[`00-master-implementation-plan.md`](00-master-implementation-plan.md).*

---

## 1. Goal, exit criteria, rungs

**Goal (master plan §5).** Phase 2 — Budgeting, recurring, insights v1, notifications (10–15 days).
Deliverables: Envelope-lite budgeting (periods incl. non-calendar, targets, rollover, "to be budgeted", sinking funds, pace indicator, actuals read model, threshold events); recurring (candidate detection via a ported `find-schedules`, confirm/merge/reject, cadence and amount tolerance, price-change and dormancy, duplicate-service, upcoming calendar, forward cash-flow, safe-to-spend); insights v1 — ~20 `builtin` rules (07 §3: subscriptions U1–U8, cash C1–C7, spending S-subset) through the **full** Advisor contract, with an evidence-bearing feed, dollar impact and accept/snooze/dismiss; notifications (ntfy + SMTP, thresholds, quiet hours, digest coalescing); reports (spending/income, Sankey, drill-through) and full export/import.

**Exit criteria, verbatim from §5:**

> a month closes and rolls over correctly across a timezone and DST boundary; recurring detection meets
> recall ≥0.85 / precision ≥0.95 against Chris's confirmed list; every built-in advisor produces resolvable
> evidence refs; a 2,000-transaction backfill yields one coalesced notification; export round-trips into a
> clean instance.

**Rungs reached (§2.3).** **v0.4** "Recurring and forward-looking" (subscriptions at recall ≥0.85 /
precision ≥0.95; 30-day cash projection directionally correct) and **v0.8** "Budget and report" (budgets
exclude transfers and net refunds; full export round-trips into a clean instance). Phase 2 also takes the
built-in half of **v0.7** "Advisory" — the evidence panel; the Weekly Brief and the `local_model` advisor
are Phase 5.

**"Against Chris's confirmed list"** has no real institution behind it yet. The synthetic + adversarial
corpora are the CI gate; the real-data run is recorded as carried, like Phase 1's two carried items.

---

## 2. Phase 1 carry-overs Phase 2 must absorb

| Item | Source | Disposition |
|---|---|---|
| **`POST /categories`** (picker is read-only; 05 §5.2 wants a "create new category" escape hatch) | closeout-architecture §4 | **WP 2.5** |
| **`categoryId` filter on `GET /transactions`** | closeout-architecture §4, wp1.6 §7 | **Stale as written — verify first.** `GET /transactions` already takes `categoryIds` (plural, `apps/api/src/routes/transactions.ts:181`, in `openapi.json`). What is missing is the *UI control*. **WP 2.11**, and WP 2.5 deletes the stale claim from the closeout doc. |
| **No REST surface for rules** (create/list/enable/disable; the wiring test inserts rules by raw SQL) | wp1.4 §9 | **WP 2.5** |
| **Rule-from-transaction** (`createRuleFromTransaction` exists in `@ctx/categorization`; no route, no UI) | wp1.6 §7 | route **WP 2.5**, UI **WP 2.11** |
| **Split editor** (`POST`/`DELETE /transactions/{id}/splits` exist; no UI) | wp1.6 §7 | **WP 2.11** |
| **Review inbox** | wp1.6 §7 | **WP 2.11** (fed by WP 2.6's `pending_review` queue and the uncategorized feed) |
| **Transfer-pair creation** (`POST /transfers/pair` exists; no UI affordance) | wp1.6 §7 | **WP 2.11** |
| **Manual balance / manual transaction entry has no route** (`ManualAccountForm` reads "No balance yet") | wp1.6 §7 | **WP 2.5** |
| **`PROCESS_LOCAL_PROVIDERS` residue** — after D-5 it gates only inline-vs-queued sync in `routes/connections.ts:198,519`; the file header at `:25–31` still states the pre-D-5 rationale and is wrong | gate §8.9 N-7, D-5 | **WP 2.5** (comment correction only; the set stays, `regate-worker-boot.test.ts:151` pins it) |
| **R-5 merchant growth bound** — no bound on distinct merchants or on `transactions_provider` revisions; never promoted to a condition | gate §5.1 R-5 | **WP 2.12** (a growth-bound test on the 50k seed; D25's `pruneNoiseMerchants` is the repair, not the bound) |
| **N-2 active `compose.override.yml` breaks `just verify`** | gate §8.9 N-2 | **Closed** by D-7 (`05c09b5`, layered override rendering). Listed because the orchestrator's own working copy still has one — re-confirm at Phase 2 start, do not re-open a WP. |
| **D2-1 MEDIUM — a fresh install never seeds the taxonomy.** `ensureTaxonomy` runs only at api `onReady`, and the RUNBOOK bootstraps the account holder *after* `up`, so `GET /categories` is `[]` until someone restarts api. Every Phase 2 screen that needs a category inherits this. | D-2 re-walk | **WP 2.5**, and it is the first thing the gate's browser walk must hit: seed on user creation (and keep the `onReady` pass idempotent for existing installs), then assert it from a genuinely cold `just up` + bootstrap with **no** restart. |
| **D2-2 LOW — `POST /imports/csv` reports `staged: 0` on the first upload** although the rows do land | D-2 re-walk | **WP 2.5** (a counting/ordering bug in the staging response, not a data-loss bug — D-5's durable staging is proven). Exit test asserts the reported count equals the row count on a first, cold upload. |
| **D2-3 LOW — an unexchanged Link Success leaves an orphan Sandbox Item** | D-2 re-walk | **Deferred, no WP.** The waste is at Plaid, not here, and the fix (an exchange-or-abandon reconciliation sweep) costs more than it saves at one user. Revisit if the ten-Item ratchet ever fires on orphans. |
| **Multi-user taxonomy seeding** (`ensureTaxonomy` takes a list; `app.ts` supplies `findPrimary()`'s single answer because identity has no enumeration) | closeout-architecture §4 | **Deferred.** Blocked on Identity growing a user enumeration, which D6 says is additive and not built. No Phase 2 WP needs a second user. Revisit when multi-user UI is scheduled. |
| **Playwright live-backend walkthrough** (`apps/web/vite.config.ts` has no dev proxy) | wp1.6 §7 | **Deferred as written.** The gate's browser walk through the *production* compose stack supersedes it and is stronger; adding a dev-server proxy would create a second, weaker path. WP 2.12 keeps Playwright on the built SPA. |
| **`pg.Pool` idle restarts of the worker** | — | **Not reproduced in the Phase 1 record.** The worker's restart loop was N-4 (512M memory cap vs a 1 GiB Argon2id KEK), closed at the re-gate, and the healthcheck that hid it was N-6/D-3, closed at `05c09b5`. **Deferred** unless WP 2.12's soak observes a restart with memory headroom; if it does, that is a gate finding, not a WP. |
| **C-1c** — image-closure step never verified in a real GitHub Actions run | gate §8.11 | **Deferred, owner Chris.** Needs a remote. Blocks nothing in Phase 2; re-stated in §6. |
| **D-1 / D26** — ratify the Plaid CSP/COEP trades | gate §8.11 | **Deferred, owner Chris.** §6 Q1. WP 2.9–2.11 must not widen CSP further. |
| **D-2** — independent re-walk of steps 7–11 | gate §8.11 | **In flight** at `1090d56`. Phase 2 does not dispatch until it returns. |
| **Two real institutions on schedule; zero internal transfers on a month of real data** | wp1.7 §7 items 2–3, gate §8.11 "not conditions, carried forward" | **Carried, owner Chris.** Phase 2 adds the transfer-exclusion assertion to the *budget* totals on seed data (WP 2.1); the real-data run stays carried. |
| **`--status-warning` / `--status-serious` contrast unconfirmed** | wp1.6 §7 | **Deferred to Phase 9** (master plan assigns the WCAG 2.2 AA pass there). WP 2.9–2.11 must still run axe on every new screen. |
| **`scripts/check-openapi-drift.ts` always reports drift on `client.gen.ts`** | wp1.6 §7 | **WP 2.12** (it is a quality-tooling bug and Phase 2 regenerates the client four times) |
| Categorization deferrals: merchant-memory golden set, real provider categories, MCC tier, rule actions beyond `set_category`, retraining cadence | wp1.4 §8 | **Split.** Rule actions beyond `set_category` (`link_to_recurring`, `notify`) become reachable in Phase 2 and land in **WP 2.5**; classifier retraining cadence gets a schedule in **WP 2.5**. Merchant-memory golden set, real provider categories and the MCC tier all need real Plaid data — **deferred** with the real-institution items. |

---

## 3. Work packages

Same collision rules as Phase 1: disjoint path ownership, no dependency or lockfile edits by agents, no
commits (the orchestrator commits per package after `just verify`), a separate scratch database name per
agent, foreground waits only, and only one agent may hold the compose stack at a time.

| WP | Package | Model | Agent type | Depends on |
|---|---|---|---|---|
| 2.1 | Budgeting context: envelope math, periods, rollover, Ready-to-Assign, sinking funds, actuals consumer, threshold events; migration 0009 | Opus | backend-architect | — |
| 2.2 | Recurring detection engine, pure: grouping on D25 `merchantId`, cadence inference, amount model, confidence, next-due, price changepoint, dormancy, duplicate-service; synthetic + adversarial corpora | Opus | backend-architect | — |
| 2.3 | Recurring persistence and lifecycle: streams/occurrences/candidates, confirm/merge/reject, upcoming calendar, forward cash-flow + safe-to-spend readers; migration 0010 | Opus | backend-architect | 2.2 |
| 2.4 | Notifications context: `NotificationChannel` port, ntfy + SMTP adapters, egress allow-list, sealed channel configs, rules, quiet hours, dedupe outbox, digest coalescing, delivery job; migration 0011 | Opus | security-engineer | — |
| 2.5 | Carry-over REST surface: rules CRUD + preview, `POST /categories`, manual balance/transaction entry, rule-from-transaction route, `link_to_recurring`/`notify` rule actions, retrain schedule, D2-1 taxonomy seeding, D2-2 staged count, `PROCESS_LOCAL_PROVIDERS` comment fix | Sonnet | backend-architect | — |
| 2.6 | Insights platform: Advisor contract v1 JSON Schemas, `SnapshotBuilder` + scope catalogue, advisor registry, validation pipeline, `pending_review` persistence, dedupe/cooldown, kill switches 1–3; migration 0012 | Opus | backend-architect | 2.1, 2.3 |
| 2.7 | Built-in advisor catalog v1: U1–U8, C1–C7, S-subset, $-impact formulas, ranking, alert budget, advice-copy lint | Opus | backend-architect | 2.6 |
| 2.8 | Reports and export/import: spending/income by category and month, Sankey, drill-through, full export bundle + import into a clean instance | Sonnet | backend-architect | 2.1 |
| 2.9 | UI: budget screen (`_app.budget.tsx`) + reports | Sonnet | frontend-architect | 2.1, 2.8 contracts |
| 2.10 | UI: recurring (`_app.recurring.tsx`) + insight feed (`_app.insights.tsx`) with evidence panels | Sonnet | frontend-architect | 2.3, 2.6 contracts |
| 2.11 | UI: review inbox, split editor, rule-from-transaction, category combobox + category filter control, transfer-pair creation, notification settings | Sonnet | frontend-architect | 2.5, 2.4 contracts |
| 2.12 | Quality pass: seed generator extensions, golden/P-R harness in CI, perf budgets, growth-bound test, `check-openapi-drift` fix, `check-ci-projects` check, exit-criteria audit | Sonnet | quality-engineer | all |
| Phase 2 gate | Independent security + architecture gate: sabotage every new control, walk the production stack in a real browser to the new screens, verdict to `docs/evidence/phase-2/gate-security-review.md` | Opus | security-engineer | all |

### WP 2.1 — Budgeting context

**Scope.** `budgets`, `budget_periods` (CALENDAR_MONTH / SEMIMONTHLY / BIWEEKLY / WEEKLY / CUSTOM, half-open `[start, end)` in the user's zone), `budget_lines` (assigned, rollover policy, goal type, priority, class), `rollovers`, `budget_line_actuals`, `budget_alerts_state`. Envelope math per 07 §1.2–1.8 as pure functions over `Money`; policies `ROLLOVER` / `RESET` / `ROLLOVER_ALLOW_NEGATIVE`; Ready-to-Assign from the balance-sheet identity, never by summing income; credit-card payment lines auto-created 1:1 with on-budget credit accounts; `needed_this_period` for the six goal types; auto-assign on roll (Envelope-lite, never blocking); late-arriving transactions re-run the cascade forward via a dirty flag. Actuals are maintained by a consumer reading the ledger through a `LedgerPort` (never an import) and **exclude transfers and net refunds**.
**Owns.** `packages/contexts/budgeting/**`, `packages/db/migrations/0009_budgeting.sql`.
**Events.** Consumes `ledger.TransactionsUpserted`, `ledger.TransactionSupersededByPosted`, `ledger.TransferPaired`, `ledger.BalanceRecorded`, `categorization.AssignmentsChanged`. Emits `budgeting.BudgetPeriodOpened`, `BudgetPeriodRolled`, `BudgetLineAssigned`, `BudgetThresholdCrossed`, `ReadyToAssignChanged`.
**Exit tests.** `src/envelope.test.ts` → `'available = carryover + assigned + activity for every policy'`; `test/rta-identity.test.ts` → `'Σ available + RTA + future assignments equals Σ on-budget balances'` (the 07 §1.2 invariant, asserted after every mutation) and `'conservation: Σ rolloverOut(n) = Σ rolloverIn(n+1)'` as a `fast-check` property; `test/period-roll-dst.test.ts` → `'a month closes and rolls over across a DST boundary in the user zone'` **and** `'…across a non-calendar biweekly grid that does not tile months'`; `test/actuals-consumer.test.ts` → `'a paired transfer contributes zero activity'`, `'a netted refund reduces activity by exactly the refund'`, `'a late transaction dirties only the periods from its own forward'`; `test/credit-overspend.test.ts` → `'credit overspend funds CCP only up to available'`.
**Evidence.** `docs/evidence/phase-2/wp2.1-budgeting.md`: the normative math transcribed with the memo line it came from; the RTA identity asserted on the 50k seed across 13 consecutive periods including one DST crossing; a worked cash-vs-credit overspend table; the dirty-cascade cost measured on the seed; every `bigint` boundary named (no `number` reaches a `*_minor` column).

### WP 2.2 — Recurring detection engine (pure)

**Scope.** No database, no I/O. Stage 1 grouping by `(merchantId, sign)` — **`merchantId` only, per D25; the engine never sees a raw descriptor and never writes `merchants`**. Stage 2 amount-bucket split and cadence clustering; cadence inference over the eight cadences of 07 §2.3 with `add_months` end-of-month clamping and asymmetric weekend tolerance, preferring the longest cadence among near-ties; amount model FIXED/VARIABLE/IRREGULAR; stream typing incl. `FREQUENT_MERCHANT`, which is never a subscription; confidence per 07 §2.4 with the `EARLY_DETECTION` cap at n=2; next-due with a MAD uncertainty band; price change as a two-sided changepoint (04 §5.1 stage 3); dormancy ladder; cross-account `CARD_MIGRATION` merge proposed *before* any cancellation; duplicate-service taxonomy.
**Owns.** `packages/contexts/recurring/src/**` (engine files only), `packages/contexts/recurring/test/corpora/**`.
**Events.** None (pure). Its output shapes are what WP 2.3 persists. **Migrations.** None.
**Exit tests.** `src/cadence.test.ts` → `'Jan 31 monthly clamps to Feb 28 and does not drift'`, `'three monthly hits do not score as sparse weekly'`; `src/confidence.test.ts` → `'n=2 is capped at 0.70 and typed EARLY_DETECTION'`; `src/price-change.test.ts` → `'a one-off proration is not a price increase'`; `test/golden-streams.test.ts` → `'precision ≥ 0.95 and recall ≥ 0.85 on the synthetic corpus'` and `'the adversarial corpus yields zero SUBSCRIPTION streams'` (rent-via-Venmo, biweekly coffee, mortgage autopay, quarterly estimated tax); `test/no-merchant-writes.test.ts` → `'the engine exports no function that takes a descriptor'`.
**Evidence.** `docs/evidence/phase-2/wp2.2-recurring-engine.md`: the P/R curve with the chosen operating point and why precision is weighted above recall; the corpus generator's injected realities enumerated (weekend shift, skipped period + retry, mid-stream hike, descriptor change, card migration, proration, annual→monthly, refund, duplicate charge, 30% pure noise); the eight metrics of 07 §2.12 in one table; a sabotage showing the gate goes red when the cadence tie-break is inverted.

### WP 2.3 — Recurring persistence, lifecycle and forecast

**Scope.** `recurring_series`, `recurring_occurrences`, `recurring_candidates`, `subscription_metadata`, `price_change_events`. Candidate pipeline with human confirmation — `user_confirmed` pins a series and detection never overrides it; confirm / merge / reject with a permanent `merchantKey → NOT_RECURRING` override on reject; `sources[]` for audit (local detector now, Plaid streams later). Upcoming calendar, 30-day forward cash-flow with an uncertainty band, and safe-to-spend read models. The consumer re-runs detection for touched merchants only, idempotently.
**Owns.** `packages/contexts/recurring/src/{store,service,consumer,read,events}.ts`, `packages/db/migrations/0010_recurring.sql`.
**Events.** Consumes `ledger.TransactionsUpserted`, `ledger.TransactionSupersededByPosted`, `categorization.AssignmentsChanged`. Emits `recurring.CandidateProposed`, `SeriesConfirmed`, `SeriesLapsed`, `PriceChangeDetected`, `DuplicateServiceDetected`.
**Exit tests.** `test/lifecycle.test.ts` → `'a confirmed series survives a re-run that would have rejected it'`, `'a rejected merchant never returns as a candidate'`; `test/no-merchant-creation.test.ts` → `'a full detection pass leaves merchants row count and ids unchanged'` (the D25 guard, sabotage-tested); `test/forecast.test.ts` → `'the 30-day projection band contains the seed's known future charges'`; `test/idempotence.test.ts` → `'replaying the consumer twice produces identical rows'`.
**Evidence.** `docs/evidence/phase-2/wp2.3-recurring.md`: the candidate→confirmed state machine drawn; the merchants-unchanged proof with before/after counts and ids; forecast accuracy against the seed generator's ground truth; what a user rejection permanently changes.

### WP 2.4 — Notifications context

**Scope.** `NotificationChannel` port (08 §4.5) with `ntfy` and `smtp` adapters and a `verify()` behind a "send test" action. `notification_channels` (config sealed with `SecretBox`, never plaintext), `notification_rules` (event type → channel, conditions, quiet hours in the user's zone), `notification_outbox` (`dedupeKey` UNIQUE ⇒ at-most-once), `delivery_attempts` (backoff, dead-letter visible in the UI). Digest coalescing by `groupKey` inside a window is enforced by the outbox, not by each rule. **Egress is the security surface:** destination host allow-list, scheme allow-list, literal-IP and private/link-local/loopback refusal, no redirect following, no user-supplied headers.
**Owns.** `packages/contexts/notifications/**`, `packages/db/migrations/0011_notifications.sql`.
**Events.** Consumes `budgeting.BudgetThresholdCrossed`, `recurring.PriceChangeDetected`, `insights.InsightProposed`, `connections.ConnectionStatusChanged`, `connections.SyncRunCompleted`. Emits `notifications.NotificationQueued`, `NotificationDelivered`, `NotificationFailed`.
**Exit tests.** `test/coalescing.test.ts` → `'a 2,000-transaction backfill yields exactly one notification'` (the §5 exit criterion, asserted on the outbox and not on the adapter); `test/dedupe.test.ts` → `'the same dedupeKey inserted twice delivers once'`; `test/egress-allowlist.test.ts` → `'a channel URL pointing at db:5432 is refused'`, `'169.254.169.254 is refused'`, `'a 302 to an internal host is not followed'`; `test/quiet-hours.test.ts` → `'a quiet-hours notification is held, not dropped, across a DST boundary'`; `test/custody.test.ts` → `'the raw channel config column contains no plaintext SMTP password'` (read the bytes back through `psql`, the WP 1.3b pattern).
**Evidence.** `docs/evidence/phase-2/wp2.4-notifications.md`: the allow-list refusal matrix with each sabotage observed going red; the raw-column custody read; the coalescing window proven at the boundary (one event before it, one after); dead-letter recovery walked.

### WP 2.5 — Carry-over REST surface

**Scope.** `GET/POST/PATCH/DELETE /rules` with `POST /rules/preview` over the existing `applyRule({preview})` and `POST /transactions/{id}/rule` over `createRuleFromTransaction`; `POST /categories` (+ `PATCH` rename, `DELETE` → archive) respecting the two-level `CHECK`; `POST /accounts/{id}/balance` and `POST /accounts/{id}/transactions` for manual entry; enable `link_to_recurring` and `notify` in `IMPLEMENTED_ACTIONS` now that both targets exist; a `categorization.retrain` schedule for `retrainClassifier`. **D2-1:** seed the taxonomy when a user is created, not only at api `onReady` — the `onReady` pass stays as an idempotent repair for existing installs. **D2-2:** make `POST /imports/csv` report the rows it actually staged. Correct the stale `apps/api/src/routes/connections.ts:25–31` header. **Do not add a `categoryId` query parameter — `categoryIds` already exists**; delete the stale claim from `closeout-architecture.md` §4 instead.
**Owns.** `apps/api/src/routes/{rules,categories}.ts`, the manual-entry handlers in `apps/api/src/routes/accounts.ts`, the staged-count path in `apps/api/src/routes/imports.ts`, `packages/contexts/categorization/src/{categories,service,rules}.ts`, the taxonomy call site in `apps/api/src/app.ts`, `apps/api/src/routes/connections.ts` (comment only).
**Events.** Emits `categorization.RuleApplied` (existing). No new event types. **Migrations.** None expected; `0013` is reserved if `categories` needs a `created_by` discriminator.
**Exit tests.** `apps/api/test/db/rules-routes.test.ts` → `'preview count equals the later apply count'`, `'a rule may not be created for another user's category'`; `categories-write.test.ts` → `'a third level is refused'`, `'archiving a category in use leaves its assignments resolvable'`; `taxonomy-bootstrap.test.ts` → `'a user created after boot has a taxonomy without an api restart'` (D2-1, sabotage: remove the new call site); `imports-staged-count.test.ts` → `'a first cold upload reports staged equal to the row count'` (D2-2); `manual-entry.test.ts` → `'a manual balance appears in GET /accounts and in net worth'`; `apps/api/test/regate-worker-boot.test.ts` stays green (it pins `PROCESS_LOCAL_PROVIDERS`'s remaining use).
**Evidence.** `docs/evidence/phase-2/wp2.5-rules-api.md`: the corrected carry-over list with the `categoryIds` finding stated plainly; a genuinely cold `just up` + bootstrap showing `GET /categories` non-empty with no restart; step-up and user-scope assertions per route in one table; each new action's blast radius (what `notify` can and cannot reach).

### WP 2.6 — Insights platform: the Advisor contract

**Scope.** Replace the 16-line placeholder `packages/contracts/advisor/advisor.schema.json` with the *normative* `v1/{request,response}.schema.json` (TS types generated from them, `ADVISOR_CONTRACT_VERSION` in `packages/contracts/src/index.ts` bumped `0.1.0` → `1.0.0`); `SnapshotBuilder` with the 08 §4.2 scope catalogue and its minimization rules as the single implementation point; `advisors`, `advisor_runs`, `insights`, `insight_evidence`, `insight_actions`, `insight_feedback`, `insight_dismissals`, `snapshot_grants`; `input_digest` on every run and insight; the seven-step validation pipeline; **`status = 'pending_review'` always, with no field an advisor can set to change it**; `proposed_actions[].kind` restricted to the four non-acting members; every `source_ref` must resolve into the snapshot we sent; upsert by `(advisor_id, key, period)`; dismissal cooldowns 30/90/permanent; alert budget (5 dashboard / 20 list / $50 floor); kill switches 1–3 (`ADVISORS_ENABLED`, per-advisor column, circuit breaker). Level 4 (compose profile) is Phase 5/6.
**Owns.** `packages/contexts/insights/**`, `packages/contracts/advisor/**`, the version constant in `packages/contracts/src/index.ts`, `packages/db/migrations/0012_insights.sql`, `apps/api/src/routes/insights.ts`.
**Events.** Consumes a schedule trigger plus `budgeting.*`, `recurring.*`, `ledger.TransactionsUpserted`. Emits `insights.AdvisorRunStarted`, `AdvisorRunCompleted`, `AdvisorRunFailed`, `InsightProposed`, `InsightAccepted`, `InsightDismissed`.
**Exit tests.** `test/evidence-resolution.test.ts` → `'an insight citing a path we did not send is rejected'`, `'an insight with empty evidence is rejected'`; `test/no-fabricated-numbers.test.ts` → `'every numeral in a rendered body appears in inputs_snapshot'`; `test/pending-review.test.ts` → `'no advisor return value produces status other than pending_review'` (sabotage: try to set it); `test/snapshot-scopes.test.ts` → `'an ungranted scope yields no key in the snapshot'`, `'transactions.raw is never emitted for an external advisor'`; `test/dedupe-cooldown.test.ts` → `'a nightly re-run updates the row rather than inserting'`, `'a third dismissal suppresses permanently'`.
**Evidence.** `docs/evidence/phase-2/wp2.6-advisor-contract.md`: the scope table with what each one drops; one real snapshot rendered with every identifier stripped; the validation pipeline with a rejected payload per step; the kill switches exercised and the app shown fully usable with advisors off.

### WP 2.7 — Built-in advisor catalog v1

**Scope.** ~20 rules through WP 2.6's contract, `kind: builtin`, `confidence_basis: deterministic`: subscriptions U1–U8, cash C1–C7, and the S-subset that needs no investments data (S1, S2, S3, S5, S6, S7, S9, S10). `$`-impact formulas per 07 §3.2 — annualize, post-tax where it matters, never compound speculative returns into the headline, and a sanity ceiling that clamps and logs outliers. Ranking by `annualized_impact × confidence × actionability × urgency × (1 − 0.5·dismiss_rate)`. `lint_advice_copy` over every template, in CI, with the 07 §7.2 banned-phrase list. Every rule degrades gracefully when no budget exists.
**Owns.** `packages/contexts/insights/src/advisors/builtin/**`, `scripts/lint-advice-copy.ts`.
**Events.** Emits `insights.InsightProposed` via WP 2.6. No new types. **Migrations.** None.
**Exit tests.** `test/catalog.test.ts` → `'every rule produces at least one resolvable evidence ref on the seed'` (the §5 exit criterion), `'every rule returns zero insights when its inputs are absent'`; `test/impact-ceiling.test.ts` → `'an impact above the ceiling is clamped and logged'`; `scripts/lint-advice-copy.test.ts` → `'"you should" fails the linter'` (sabotage-tested); `test/ranking.test.ts` → `'a one-time saving ranks at half a recurring one of equal size'`.
**Evidence.** `docs/evidence/phase-2/wp2.7-advisor-catalog.md`: one table of all rules with trigger, formula, and the seed row that fires it; the alert budget applied to the seed (how many fired, how many shown); the copy linter's output before and after a deliberate violation.

### WP 2.8 — Reports and export/import

**Scope.** Spending and income by category and by month aggregated on `budget_date` independently of the period grid; Sankey source→category flows; drill-through to the filtered transactions list (reusing `categoryIds`). Transfers excluded and refunds netted in every total. Full export: a versioned bundle of every user-scoped table with a manifest and a schema version, and an import that reconstructs it in a clean instance. Export routes keep the existing step-up guard and `csvText` formula-injection escaping.
**Owns.** `apps/api/src/routes/{reports,export}.ts`, `apps/api/src/export/**`.
**Events.** None emitted; reads through published readers only. **Migrations.** None; `0014` reserved if a materialized view is needed to hit the latency budget.
**Exit tests.** `apps/api/test/db/export-roundtrip.test.ts` → `'export round-trips into a clean instance'` (the §5 exit criterion: export from the 50k seed database, import into a freshly migrated one, assert row counts and content hashes per table), `'every user-scoped table appears in the manifest'` (computed from `information_schema`, not a hand list — the Phase 1 CI-parity failure shape); `reports.test.ts` → `'spending totals contain zero internal transfers'`, `'a refund nets against its original'`, `'report p95 < 200 ms on the 50k seed'`.
**Evidence.** `docs/evidence/phase-2/wp2.8-reports-export.md`: the manifest completeness proof; a table of report totals reconciled against numbers computed from the seed generator alone (the WP 1.7a pattern); the round-trip diff; formula-injection re-asserted on the new export.

### WP 2.9 — UI: budget and reports

**Scope.** `_app.budget.tsx` replacing the 15-line `PlaceholderRoute`: period picker (incl. non-calendar), category rows with assigned / activity / available, the pace indicator, Ready-to-Assign as an opportunity when positive and the one hard alert when negative, cash-red vs credit-yellow overspend, "assign $X more to stay on track", sinking-fund progress, auto-assign action. Reports screen with visx charts, the Sankey and drill-through into `/transactions`. No CSP widening.
**Owns.** `apps/web/src/routes/_app.budget.tsx`, `apps/web/src/routes/_app.reports.tsx`, `apps/web/src/features/budget/**`, `apps/web/src/features/reports/**`.
**Exit tests.** `features/budget/*.test.tsx` unit; `e2e/budget.spec.ts` → `'assigning money moves Ready-to-Assign by exactly that amount'`, `'a credit overspend renders yellow and a cash overspend red'`; `e2e/reports.spec.ts` → `'clicking a Sankey band lands on the filtered list'`; axe clean on both screens.
**Evidence.** `docs/evidence/phase-2/wp2.9-budget-ui.md`: screenshots of both screens under both themes; the axe run; every number on screen traced to the API field it came from (no client-side money math beyond formatting).

### WP 2.10 — UI: recurring and insights

**Scope.** `_app.recurring.tsx`: candidate queue with one-tap confirm/reject, confirmed streams with cadence, next due and band, price-change history, dormancy prompts phrased as questions ("we haven't seen a charge since…", never "you cancelled"), duplicate-service comparison, upcoming calendar, safe-to-spend. `_app.insights.tsx`: ranked feed, provenance badge (`advisor_id`, version, confidence, `confidence_basis`), a "Why am I seeing this?" panel listing the exact evidence rows and linking through to them, dollar impact, accept / snooze / dismiss with a dismiss reason, and the standing educational disclaimer.
**Owns.** `apps/web/src/routes/{_app.recurring,_app.insights}.tsx`, `apps/web/src/features/{recurring,insights}/**`.
**Exit tests.** `e2e/recurring.spec.ts` → `'rejecting a candidate removes it and it does not return after a re-detect'`; `e2e/insights.spec.ts` → `'every insight in the feed opens an evidence panel whose links resolve to real transactions'` (the §5 exit criterion, from the browser), `'no insight renders an action that performs a transfer'`; axe clean on both.
**Evidence.** `docs/evidence/phase-2/wp2.10-recurring-insights-ui.md`: screenshots; the evidence panel walked for one insight of each severity; the copy on screen checked against the 07 §7.2 banned list.

### WP 2.11 — UI: review inbox and transaction affordances

**Scope.** Review inbox combining the uncategorized feed and WP 2.6's `pending_review` queue, keyboard-first, target "clears in under 2 minutes" (rung v0.3). Split editor using `Money.allocate` semantics with a must-balance invariant shown live. Rule-from-transaction dialog with a live preview count. Category combobox on the existing `GET /categories` with a create-new escape hatch (WP 2.5's `POST`), and a category filter control in the filter bar bound to the existing `categoryIds` parameter. Transfer-pair creation from the detail sheet over the existing `POST /transfers/pair`. Notification settings: channels, test send, rules, quiet hours.
**Owns.** `apps/web/src/routes/_app.inbox.tsx`, `apps/web/src/features/transactions/**` (additions), `apps/web/src/features/notifications/**`, `apps/web/src/routes/_app.settings.tsx`.
**Exit tests.** `e2e/inbox.spec.ts` → `'twenty items clear with keyboard only'`; `e2e/splits.spec.ts` → `'a split that does not sum to the parent cannot be saved'`; `e2e/rule-from-transaction.spec.ts` → `'the preview count matches the count after apply'`; `e2e/category-filter.spec.ts` → `'the category filter survives a reload via the URL'`; `e2e/notification-settings.spec.ts` → `'a test send reports a real delivery result'`; axe clean on every new screen.
**Evidence.** `docs/evidence/phase-2/wp2.11-inbox-ui.md`: a timed inbox clear; screenshots; the URL-state round-trip; confirmation that no new CSP directive was needed.

### WP 2.12 — Quality pass

**Scope.** Extend `@core/seed` with recurring streams (with ground truth), budget periods and assignments, and a 2,000-transaction backfill fixture. Wire the recurring P/R harness into CI with a regression gate (precision may not drop below the recorded baseline). Perf budgets for budget, reports and insight generation on the 50k seed. **R-5 growth bound**: assert distinct-merchant and `transactions_provider` revision growth stays sub-linear across three seeded syncs. Fix `scripts/check-openapi-drift.ts`'s false positive on `client.gen.ts`. Add `scripts/check-ci-projects.ts` (§5). Audit every §5 exit criterion and say which are proven, which need Chris's real accounts, and which are carried.
**Owns.** `packages/seed/src/**`, `.github/workflows/ci.yml`, `scripts/check-openapi-drift.ts`, `scripts/check-ci-projects.ts`, `docs/TESTING.md`.
**Exit tests.** `scripts/check-ci-projects.test.ts` → `'a project missing from ci.yml fails the check'` (self-test against fixtures first, then the real files); `packages/seed/test/ground-truth.test.ts` → `'the generator's declared streams match what the detector finds at the gate thresholds'`; `apps/api/test/db/growth-bound.test.ts` → `'three syncs of the same corpus add no merchants and no provider revisions'`.
**Evidence.** `docs/evidence/phase-2/wp2.12-quality.md`: the exit-criteria audit table; the P/R baseline recorded with its commit; the CI project map before and after; each new check sabotaged once and observed red.

---

## 4. Waves

Dependency line from master plan §6.4: *budgeting ∥ recurring ∥ notifications; insights v1 waits on
recurring; reports UI waits on budgeting read model.* Ceiling is four concurrent agents (Phase 0's
nine-agent rate-limit lesson).

| Wave | Agents | Packages |
|---|---|---|
| A | 3 (2 Opus) | 2.1 budgeting · 2.2 recurring engine · 2.5 REST carry-overs |
| A′ | 2 Opus, on 2.2 landing | 2.3 recurring persistence · 2.4 notifications |
| B | 3 | 2.6 insights platform · 2.8 reports/export · 2.11 inbox + transaction UI |
| C | 3 | 2.7 advisor catalog · 2.9 budget + reports UI · 2.10 recurring + insights UI |
| D | 1, then 1 | 2.12 quality pass, then the Phase 2 gate |

**Why A splits.** Drafted, Wave A put three Opus agents in flight at once (2.1, 2.2, 2.4) — exactly the
concurrency that exhausted six sessions in Phases 0 and 1. The ceiling that has held is **two Opus plus
cheaper work**, so 2.4 moves to A′ alongside 2.3, which 2.2 unblocks anyway. Total agent-days are
unchanged; the wall clock is not. 2.5 is first because D2-1 blocks the gate's browser walk and every
screen that needs a category, and because it is the one Wave A package a Sonnet can carry.

Migration numbers are assigned before dispatch and are not negotiable in-flight: **0009** budgeting (2.1),
**0010** recurring (2.3), **0011** notifications (2.4), **0012** insights (2.6); **0013**/**0014** reserved
for 2.5 and 2.8 and used only if the WP reports it needs one. Two waves may not both claim a number — the
runner checksums the file and refuses to start if it changes after merge.

### Shared files an orchestrator applies between waves

No agent edits these. The orchestrator applies them once per wave boundary, then runs `just verify`.

1. **`vitest.config.ts`** — add `budgeting`, `budgeting-db`, `recurring`, `recurring-db`, `notifications`,
   `notifications-db`, `insights`, `insights-db` (23 projects today → 31). `*-db` entries carry
   `fileParallelism: false` and `testTimeout: 30_000`.
2. **`scripts/eslint-boundaries.js`** — named layers for `packages/contexts/{budgeting,recurring,insights,notifications}/`
   inserted **before** the `context` catch-all at line 346. The generic `allow` list already covers
   `@core/{kernel,config,db,contracts,platform,secretbox}` + `drizzle-orm` + `zod`; the named layers exist to
   allow `@core/testkit` and `@core/seed` in tests, and `nodemailer` in notifications only.
3. **`apps/api/src/platform.ts`** — four `MODULE_FLAGS` entries (`module.budgeting`, `module.recurring`,
   `module.insights`, `module.notifications`), each `defaultEnabled: false` when its WP merges and flipped
   `true` at the wave boundary after its consumer is registered and green.
4. **`apps/api/src/modules.ts`** — `appModules` registrations: events, consumers, jobs and schedules per
   context. **`apps/api/src/domain.ts`** — the `LedgerPort`-style adapters each new context reads through.
5. **`packages/db/test/migrate.test.ts`** — the exact alphabetical table list (42 names today → 65: +6
   budgeting, +5 recurring, +4 notifications, +8 insights) and the per-migration attribution comment block
   above it.
6. **`.github/workflows/ci.yml`** — **two** hand-maintained `--project` lists (unit job and migration job)
   plus the prose project→job map in the header. Every new project goes into all three on the day it is
   created; WP 2.12's `check-ci-projects` makes that mechanical.
7. **`packages/contracts/openapi/openapi.json`** — regenerate with `just openapi` after each wave that adds
   routes (CI's `openapi-current` job diffs it), then regenerate `apps/web/src/api/client.gen.ts`.
   `scripts/check-proxy-routes.ts` should stay green without a `docker/Caddyfile` edit — C-1a made `/api/*`
   a whole namespace — and if it does not, that is a finding, not a routine edit.
8. **Dependency batch** — `nodemailer` (MIT) for WP 2.4 under the seven-day `minimumReleaseAge`, plus the
   `@ctx/*` workspace entries in `apps/api/package.json`, then one `pnpm install` and a `THIRD_PARTY.md`
   restamp. Agents never run `pnpm install`.

---

## 5. Gate standard for Phase 2

Carried verbatim in force from the Phase 0 and Phase 1 gates. Every one of those gates found controls that
had green evidence written by the agent that built them; the recurring mechanism was a control computed on
the half somebody was looking at and hardcoded on the half they were not.

1. **Independent reviewer.** An Opus `security-engineer` who wrote none of the code re-runs the load-bearing
   proofs. A gate may not validate its own fixes — Phase 1 needed D-2 for exactly that reason.
2. **Sabotage every new control and observe it go red** before accepting its PASS. Record which sabotages
   were red on the first try. A control that has never been observed failing is not evidence.
3. **Walk the production stack in a real browser**, through Caddy, on an image rebuilt from the landing
   commit, and **the walk must reach the code Phase 2 added**: budget assign → Ready-to-Assign moves;
   recurring candidate → confirm → appears in the upcoming calendar; an insight's evidence panel → click
   through to the transaction; a test notification actually delivered; an export downloaded and imported into
   a clean instance. A login that stops at the shell proves nothing.
4. **Every "never" claim has a test that fails when the thing is made to happen.** Phase 2's list: an advisor
   never sets its own status; an advisor's evidence never cites data we did not send; recurring never creates
   a merchant; a notification channel never resolves an internal address; budget math never touches a float.
5. **Every new vitest project is in `ci.yml` the day it is created.** Proposed mechanical check, owned by
   WP 2.12: `scripts/check-ci-projects.ts` parses the project names out of `vitest.config.ts` and the two
   `--project` lists in `.github/workflows/ci.yml`, fails if any project appears in neither CI list or if a CI
   list names a project that does not exist, ships with a `--self-test` against fixtures, and runs in
   `just check` beside `check-proxy-routes`. This failure mode has now occurred twice (4 of 13 in Phase 0,
   13 of 23 in Phase 1) and is the single highest-yield check available.
6. **The walk starts from a genuinely cold install** — `docker compose down -v`, `up`, bootstrap, and no
   restart anywhere in between. D2-1 existed only on that path: `ensureTaxonomy` ran at api `onReady`, the
   account holder was created afterwards, and every reviewer who had restarted api once could not see it.
   Phase 0's P0-4 (RP ID never configured for the real host) and Phase 1's F-1/F-4 were the same shape —
   defects that live in the state no developer is ever in. A warm stack is not the install Chris will have.
7. **`just verify`, not `just check`**, is what predicts CI, and it is run at the landing commit.

### Phase-2-specific risks

| Risk | Control | Proven by |
|---|---|---|
| **An advisor invents a number.** Built-ins are deterministic today, but the contract is the one Phase 5's LLM will use — the defences must exist before the first non-deterministic advisor, not after. | Every `source_ref` must resolve into the snapshot we sent; `evidence` non-empty at the type level; a numeral extractor asserts every figure in a rendered body appears in `inputs_snapshot`; a sanity ceiling clamps and logs outliers; `confidence_basis: deterministic` is reserved and asserted. | WP 2.6 `evidence-resolution.test.ts`, `no-fabricated-numbers.test.ts`; gate sabotage: hand a built-in a snapshot missing the key it cites and watch the run fail closed. |
| **Notification channels are egress** — the first outbound path in the app that a *user-supplied string* controls. An SSRF here reaches `db:5432` and the container metadata endpoint. | Destination host allow-list, scheme allow-list, literal-IP refusal, private/link-local/loopback refusal, no redirect following, no user headers, timeouts; configs sealed with `SecretBox`. | WP 2.4 `egress-allowlist.test.ts` with each refusal sabotaged; gate re-runs it against the booted stack from inside the worker container. |
| **Budget math in bigint minor units.** Floats are correct for confidence scores and Monte Carlo and must never reach a `*_minor` column; a rollover that loses a cent per period is invisible for months. | `Money` arithmetic only; `Money.allocate` largest-remainder for splits and auto-assign; the conservation property `Σ rolloverOut(n) = Σ rolloverIn(n+1)`; the RTA balance-sheet identity asserted after every mutation. | WP 2.1 `rta-identity.test.ts` incl. a `fast-check` property; gate greps the budgeting diff for `number` at any `*_minor` boundary. |
| **Recurring detection must not create merchants.** D25 made a `merchants` row mean "a payee was involved". A detector that mints rows from descriptors would undo it silently and put bank operations into budget groupings. | The engine takes `merchantId` and never a descriptor; `@ctx/recurring` has no write path to `merchants` (ownership check enforces it); a full pass asserts row count **and ids** unchanged. | WP 2.2 `no-merchant-writes.test.ts`, WP 2.3 `no-merchant-creation.test.ts`; gate sabotage: add a merchant-insert to the consumer and confirm both go red. |
| **A false subscription destroys trust faster than a missed one.** | Precision weighted above recall; operating point at the highest recall where precision ≥ 0.95; candidate state with human confirmation; `user_confirmed` pins permanently; rejections are durable. | WP 2.2 golden + adversarial corpora with a CI regression gate. |

---

## 6. Open questions for Chris

Work proceeds on the stated default; an answer is a cheap change.

1. **Ratify D26** (Plaid Link CSP/COEP exception — gate condition D-1). Default: **ratify as written in the
   master plan §1**; the alternative is shipping without Plaid Link, which the Phase 1 walk already proved
   works only with the exception. Nothing in Phase 2 widens it further.
2. **Budget mode and period.** Default: **`ENVELOPE_LITE`, rollover on, auto-assign from targets,
   `CALENDAR_MONTH`**; biweekly and semimonthly are built and selectable, and `TARGETS_ONLY` / `OFF` are
   presentation switches over the same ledger.
3. **Notification channels** (deferred in master plan §8). Default: **ntfy self-hosted topic and SMTP both
   built, both disabled until configured**, weekly digest, quiet hours 22:00–07:00 in the user's zone,
   immediate delivery only for the P0-safety class (overdraft, duplicate charge, missed debt payment).
4. **Alert budget.** Default: **5 on the dashboard, 20 in the list, $50 minimum annual impact**, cooldown
   30 days after one dismissal, 90 after two, permanent after three, and rules released in waves (cash +
   subscriptions first) so the first run is not a wall of red.
5. **Recurring gold set.** No real history exists. Default: **the synthetic + adversarial corpora are the CI
   gate; the real 24-month hand-labeled set is gitignored and run locally** once accounts are linked. The
   §5 exit criterion "against Chris's confirmed list" is recorded as carried until then.
6. **Export format.** Default: **a versioned JSONL bundle plus a manifest**, `age`-encryptable with the same
   key material as backups, and the import is the thing under test — not the format.
7. **`C-1c` — a git remote.** The image-closure CI step has still never run in GitHub Actions because there
   is no remote. Default: **Chris creates a private remote before the Phase 2 gate** (after `git filter-repo`,
   per the Phase 0 hand actions); otherwise the gate records C-1c carried for a third phase.
8. **Real-institution exit criteria.** Two institutions syncing on schedule and a month of real data with
   zero internal transfers are Phase 1 items that only Chris can close. Default: **Phase 2 closes on seed and
   Sandbox evidence** and both stay carried to the first production link, where they become a one-session
   verification rather than a phase.
