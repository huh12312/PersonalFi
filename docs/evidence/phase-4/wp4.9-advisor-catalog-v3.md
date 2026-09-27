# WP 4.9 — Advisor catalog v3: the retirement rules R1–R7

Spec: `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.9", with §2's rows on I7–I10/X4 and the
`@core/secretbox` swap, and §5 (gate standard, the S1 multi-predicate rule). Built on HEAD
`e98fba5` with WP 4.12b's C-10 treated as landed (advisor contract 1.2.0, `excluded_currencies`,
per-currency FX in `networth.summary`/`cash.summary` — untouched here). One concurrent agent
(WP 4.10, `apps/web` only); nothing of theirs was touched.

**What shipped, in one paragraph.** Six of seven R rules (`src/advisors/builtin/retirement/`),
`RuleWave` gaining `'retirement'`, R5 recorded as a `CATALOGUE_GAPS` entry naming its fields.
`goals.list` and `risk.profile` flipped `sourcedInPhase2 → true` with builder arms and a new
`PlanningPort`. One new scope, **`plan.projection`**, at advisor contract **1.3.0** (1.2.0 was
C-10's) with the published schemas regenerated and **migration
`0024_snapshot_grant_scopes_v1_3.sql`** widening `snapshot_grants_scope_check` in the same change
set. The composition-root port `createInsightsPlanningPort` is in `apps/api/src/domain.ts`, inside
the insights port block (see §11 for the two lines _outside_ my ownership that bind it).

---

## 1. R1–R7

Every rule is `kind: builtin`, `confidence_basis: deterministic`, `requires_review: true`, and
carries 07 §7.2's disclaimer verbatim as a caveat (`ADVISORY_DISCLAIMER`, 211 characters;
`catalog-v3.test.ts` → `'every R insight carries 07 §7.2’s disclaimer, verbatim'`).

| ID                                                | Trigger                                                                                               | Formula (every numeral traced)                                                                   | Dollar impact                                                                                                                                                                                                     | 07 pri | Severity                         | Seed row that fires it                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** savings rate below the plan's              | `plan_source == 'stated'` and `plan − observed ≥ 0.01`                                                | `($0 - $1) * 100` over `savings_rate.plan`, `.observed` → **6.5pp**                              | **none** — the gap is in points of income, and `plan.projection` carries two rates over the income, never the income (the minimisation `risk.profile` applies with its band)                                      | P0     | **warning** (see below)          | `tight`: plan `0.15` stated vs observed `0.085` → _"…assumes contributions of 15% of your income. The months this app has observed show 8.5%, which is 6.5pp below it."_                                            |
| **R2** Monte Carlo success below target           | `method == monte_carlo`, `stale == false`, `success_probability < success_target`                     | `($0 - $1) * 100` over `success_target`, `success_probability` → **8.7pp**                       | **none** — probability points, never dollars (dispatch §3)                                                                                                                                                        | P0     | **urgent**                       | `drift`: `0.713000` vs `0.80`, 10,000 paths, plan end 95 → _"In 10,000 simulations of market returns, this plan lasted through age 95 in 71.3% of them. The plan is measured against 80%, so it sits 8.7pp short."_ |
| **R3** Roth-conversion window before RMD age      | `start_age − 10 ≤ current < start_age` and `tax_deferred_share ≥ 0.5`                                 | `$0 - $1` over `rmd.start_age`, `ages.current` → **9** years                                     | **none** — `tax_bracket_arbitrage × converted` needs an unchosen amount and future brackets; 07's "projected first RMD ~$amt" would compound a return into a headline and is **left out** with a caveat saying so | P1     | notable                          | `drift`: age 66, born 1960 → start 75 in 2035 (WP 4.2's `rmd.startAge` schedule for the run year), share `0.62`                                                                                                     |
| **R4** claiming at seventy, from 55               | `55 ≤ current < 70`, plan claim age `< 70`, `factor_at_70 > claim_factor`                             | `($0 / $1 - 1) * 100` over `social_security.factor_at_70`, `.claim_factor` → **24%**             | **none** — `PV(70) − PV(62)` needs a discount rate and a lifespan; the comparison is a ratio of two statutory factors, so no PIA (income by another name) crosses                                                 | P1     | notable                          | `drift`: claims at 67, factors `1` and `1.24` → _"…each monthly payment 24% larger, for life and in today’s dollars…"_                                                                                              |
| **R5** 402(g) true-up trap                        | —                                                                                                     | —                                                                                                | —                                                                                                                                                                                                                 | P0     | —                                | **`CATALOGUE_GAPS`**: needs YTD deferrals, payroll cadence, match formula and a true-up flag (a `contributions.ytd`-shaped scope + plan terms); §6 Q4 default **not built**                                         |
| **R6** goal below required pace                   | `pace.status == off_track`, `horizon_months ≥ 1`, required > planned                                  | `($0 - $1) * 12` over `pace.required_monthly.minor`, `pace.planned_monthly.minor`                | **yes: `($1,500.00 − $500.00) × 12 = $12,000.00/yr`** (`1200000` minor), through `clampImpact`: an outlier is **withheld, never clamped** (WP 2.7's ruling, `support.ts` `clampImpact` header)                    | P1     | warning                          | `drift`: WP 4.6's own worked case — "House deposit", $20,000 in 12 months, funded 10%, $1,500/mo needed, $500/mo planned                                                                                            |
| **R7** withdrawal rate outside the guardrail band | decumulation only (block present); `rate > upper` or `rate < lower`, and the port's `position` agrees | none printed that is not a snapshot value: `withdrawal_rate`, `lower`, `upper`, `reference_rate` | **none** — `Δspend` is a spending change, not a saving; "a tenth" is G-K's step, stated in words                                                                                                                  | P0     | **urgent** above, **info** below | `drift`: `0.0612` vs `0.036`–`0.054` around `0.045` → _"This year the plan draws 6.12% of the portfolio, above the 3.6% to 5.4% guardrail band around a 4.5% starting rate."_                                       |

**The priority disagreement, stated.** 07 marks R1, R2, R5, R7 P0. R5 is a gap. **R2 and R7 emit
`urgent`** (`WP_4_9_URGENT_RULE_IDS`, asserted by name in `catalog-v3.test.ts` → `'R2 and R7 are
the urgent ones, and nothing else in the wave claims the ceiling'`). **R1 ships at `warning`**: it is
R2's usual _cause_, and a holder under-saving against a stated plan would otherwise see two urgent
findings for one problem. **R7 below its band** is the prosperity case and emits `info`.
`BuiltinCatalogueEntry.priority` carries 07's value for all six, so this is queryable data.

**Interpretations recorded rather than buried.**

- **R1's "target for the plan"** is the plan's _own_ contribution assumption (stated where the holder
  stated it), over the same WP 4.3 income as the observed rate. A plan with nothing stated agrees
  with itself by construction (`plan_source: 'derived'`) and R1 is silent however the rates compare
  (`'R1 is silent when the plan’s contributions were derived, however the rates compare'`). The
  solver-based reading ("{t}% keeps this plan on track") was rejected: the only solver a snapshot
  can afford is deterministic, whose "on track" is the median path — a second definition beside R2's
  80%.
- **R4's "no claiming strategy set"** is unobservable: WP 4.6's baseline requires a claim age
  whenever Social Security is modelled. The rule fires from 55 whenever the plan claims before
  seventy; dismissal (the WP 2.6 cooldown ladder) is how a holder who has chosen says so. It compares
  against the plan's claim age rather than 62, because that is the choice actually in front of them.
- **R6's `{date}`** becomes _"in {n} months"_ — `goals.list` carries a month count, never a date.
- **R7's band reference** is 07 §5.6's `initial_wr = 0.045 # user-settable` times WP 4.4's
  `GUYTON_KLINGER` multiples. The 0.045 lives in `domain.ts` as `GUARDRAIL_REFERENCE_RATE` — the one
  number the band needs that WP 4.2's file does not carry. Carried (§12).

**Silence when inputs are absent.** `catalog-v3.test.ts` → `'every R rule returns zero insights when
its inputs are absent'` checks both the empty snapshot and, harder, the block present with **only
that rule's own sub-block removed** (R2 without `success_probability`, R3 without `rmd`, R4 without
`social_security`, R7 without `guardrail`, R1 without `savings_rate`, R6 without `goals_list`) —
a rule that fell back to a default would pass the first half and fail the second. R2 also refuses a
deterministic run and a stale one (`'R2 refuses a deterministic run and a stale one'`).

---

## 2. The planning blocks, rendered with every identifier stripped

Built by the **real** `SnapshotBuilder` over the **real** `createInsightsPlanningPort` against a real
scratch database (`apps/api/test/db/phase4-advisors.test.ts`'s fixture), kind `external`, all three
planning scopes granted. Alice: 66, retired at 65, born 1960; an IRA of 4,000 VTI × $250 (all
tax-deferred), $90,000/yr stated spending, Social Security at 67; one goal funded $2,000 from her
checking account; a 500-path Monte Carlo baseline (the cached Shiller series was present).

```json
{
  "goals_list": {
    "goals": [
      {
        "goal_ref": "GOAL_36ed6ad39d20",
        "name": "House deposit",
        "target": { "minor": "2000000", "currency": "USD" },
        "horizon_months": 12,
        "progress": 0.1,
        "pace": {
          "status": "off_track",
          "required_monthly": { "minor": "150000", "currency": "USD" },
          "planned_monthly": { "minor": "50000", "currency": "USD" }
        }
      }
    ]
  },
  "risk_profile": {
    "tolerance": "moderate",
    "horizon_years": 29,
    "tax_bracket_band": "22-32",
    "liquidity_need": "medium"
  },
  "plan_projection": {
    "as_of_year": 2026,
    "currency": "USD",
    "method": "monte_carlo",
    "paths": 500,
    "assumptions_version": "sha256:d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f",
    "stale": false,
    "success_probability": "0.002000",
    "success_target": "0.80",
    "terminal": {
      "age": 94,
      "calendar_year": 2054,
      "p5": { "minor": "0", "currency": "USD" },
      "p50": { "minor": "0", "currency": "USD" },
      "p95": { "minor": "0", "currency": "USD" }
    },
    "ages": { "current": 66, "retirement": 65, "plan_end": 95 },
    "rmd": { "start_age": 75, "start_year": 2035, "tax_deferred_share": "1" },
    "social_security": {
      "claim_age_years": 67,
      "claim_age_months": 0,
      "claim_factor": "1",
      "factor_at_70": "1.24"
    },
    "guardrail": {
      "withdrawal_rate": "0.09",
      "reference_rate": "0.045",
      "lower": "0.036",
      "upper": "0.054",
      "position": "above"
    }
  }
}
```

What is **not** there, asserted by `'goals.list and risk.profile come from the real readers, and no
id crosses'` for both `builtin` and `external`: no UUID anywhere in the serialised snapshot (not the
goal's, the funding account's, the IRA's, the scenario's, the run's or the holder's), not the
$84,000 income behind the band, nothing of Bob's. No `savings_rate` — this fixture has no twelve
months of income history, so the sub-block is **absent, not zero**. The success probability is a
decimal string; the only money is the terminal band, rounded to $1,000 by the scope row.

The 08 §4.2 minimisation tests on the seed:
`scope-minimization.test.ts` → `'plan.projection emits no balance, no account id and no date finer
than a year'` (keys matched by substring against `balance|account|institution|provider|mask|
scenario|run_id|birth|date|income|spend`; every string value checked for a UUID and for
`\d{4}-\d{2}`; every band `% 100000 == 0`, read from the scope row), `'goals.list and risk.profile
carry no id, no account and no date — for every kind'` (a UUID goal id and funding-account id fed
through the port for `builtin`, `local_model`, `external`; one `GOAL_` pseudonym for all three),
`'a risk profile with no band is absent, never given one'`.

---

## 3. The contract at 1.3.0, shown additive

`contract-parity.test.ts` was **green before** any change (213/213 on the baseline run), so it
could tell a wrong bump from a right one. Changes:

| Artefact                          | Diff                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts` | `ADVISOR_CONTRACT_VERSION` `'1.2.0'` → `'1.3.0'`                                                                                                                    |
| `contract/json-schema.ts`         | `ADVISOR_ARTEFACT_VERSION` `'1.2.0'` → `'1.3.0'`                                                                                                                    |
| `advisor/advisor.schema.json`     | `artefactVersion` stamp only (not emitted by the generator; hand-bumped as C-10 did)                                                                                |
| `v1/manifest.schema.json`         | stamp; `"plan.projection"` **appended** to the scope enum                                                                                                           |
| `v1/response.schema.json`         | stamp only                                                                                                                                                          |
| `v1/request.schema.json`          | stamp; `granted_scopes.maxItems` 15 → 16 (a relaxation); enum member appended; **new optional** `plan_projection` block; **new optional** `goals_list.goals[].pace` |

`git diff -U0 packages/contracts/advisor/v1/request.schema.json | grep '^-'` shows exactly three
removed lines: the `"1.2.0"` stamp, `"maxItems": 15`, and `"market.rates"` (re-added as
`"market.rates",` with the new member after it). Nothing required became optional or vice versa;
no member moved position. `ADVISOR_CONTRACT_MAJOR` stays `1`. Regenerated with the exact command in
`wp3.10-advisor-catalog-v2.md` §9.1, then `prettier --write`.

`goals_list[].pace` rides the same minor. The dispatch says `goals.list` needed no bump, and for
the 1.0.0 fields that is true; but 07 R6's `${m}` and `${c}` are not derivable from a progress ratio
and a month count (m needs the funded amount, which the block deliberately does not carry). Since a
minor was shipping anyway, the pace verdict crosses additively rather than R6 being written over a
reconstruction.

`'the published schemas match the source at 1.3.0'` (the dispatch names it "at 1.2.0", written before
C-10 took that number) asserts the version on every artefact, byte parity, the three additions
present, and that `plan.projection` is the enum's **last** member.

---

## 4. The 0024 CHECK beside 0019's

```sql
-- 0019_snapshot_grant_scopes_v1_1.sql            -- 0024_snapshot_grant_scopes_v1_3.sql
ADD CONSTRAINT snapshot_grants_scope_check        ADD CONSTRAINT snapshot_grants_scope_check
  CHECK (scope IN (                                 CHECK (scope IN (
  'networth.summary', 'cash.summary',               'networth.summary', 'cash.summary',
  'cashflow.monthly', 'budgets.status',             'cashflow.monthly', 'budgets.status',
  'recurring.list', 'goals.list',                   'recurring.list', 'goals.list',
  'risk.profile', 'market.watchlist',               'risk.profile', 'market.watchlist',
  'holdings.aggregate', 'holdings.detail',          'holdings.aggregate', 'holdings.detail',
  'transactions.summary', 'transactions.raw',       'transactions.summary', 'transactions.raw',
  'institutions.names',                             'institutions.names',
  -- advisor contract 1.1.0 (WP 3.10)               -- advisor contract 1.1.0 (WP 3.10)
  'liabilities.terms', 'market.rates'));            'liabilities.terms', 'market.rates',
                                                    -- advisor contract 1.3.0 (WP 4.9)
                                                    'plan.projection'));
```

Drops the named constraint 0019 created, re-adds it, re-comments it. Out-of-order numbering (0025
and 0026 landed first) is safe: the runner applies any unrecorded version in lexical order and 0024
depends on neither. Proven over a real database: `pg_get_constraintdef` contains `plan.projection`,
and the **real consent route** (`PUT /advisors/{id}/grants`, fresh session) grants every retirement
advisor its scopes with a 200 (`'plan.projection is grantable through the consent route, because
0024 widened the CHECK'`). `apps/api/test/phase3-registration.test.ts` →
`'every advisor scope can actually be granted, or is a recorded migration gap'` is **green** with
0024 and red without it (§6, SA-5).

---

## 5. The alert budget, applied after the retirement wave

`alert-budget-wave.test.ts` → `'the alert budget is applied after the retirement wave is released,
not before'`. The whole catalogue on the `drift` seed, 38 proposals, budgeted **once** over the
union — the order `read.ts`' `insightFeed` uses in production (one `applyAlertBudget(views, …)` call,
no notion of a wave):

| Slot          | Rule                                                                  | Severity        | rank                                                  |
| ------------- | --------------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| dashboard 1–5 | X1, I4, I5, **R2**, **R7**                                            | urgent          | 30.000 each (tie broken on `key`)                     |
| list 6        | S6                                                                    | urgent          | 30.000 — **displaced** from the pre-release dashboard |
| list 7        | **R6**                                                                | warning         | 26.079 ($12,000/yr)                                   |
| list 8–20     | C2, D4, D2, S9, I2, S7, D2, D3, D6, I1, I1, I3, S2                    | warning/notable | 24.955 … 15.352                                       |
| overflow (17) | X3, U3, C1, X2, X5, X6, D1, D5×3, I1, I6, **R4**, **R3**, S10, S3, U7 | notable         | —                                                     |
| below floor   | U2 ($36/yr)                                                           | notable         | —                                                     |

Asserted: dashboard 5 before _and_ after the release; list 20; R2 and R7 on the dashboard; every row
the release pushed off the dashboard is **in the list, not deleted**; the four buckets account for
all 38; R3 and R4 (no figure) sit in overflow, not below the floor. `'the one retirement rule that
claims a figure clears the floor on its own merits'`: only R6 claims, and nothing in the wave is
floored.

**An observation for the gate, not a change.** Six `urgent` rows compete for five slots with equal
rank (none claims a figure), so the tie-break on `key` decides: `crypto.` < `investing.` <
`retirement.` < `spending.`, and **S6 (duplicate charge, 07's P0-safety class) loses its dashboard
slot to R2/R7 alphabetically**. S6 ships _off_ (`spending` wave), so a default deployment does not
see this; one that enables spending would. `rank()` is WP 2.7's to refine (a P0-safety term), not
this WP's.

---

## 6. Sabotage — every control, once, red on the first try, restored byte-identical

Harness: `/tmp/wp49-sab/run.sh` — back up, patch, run the named test, restore, re-hash. Every file's
SHA-256 after restore equals the pre-sabotage value in `/tmp/wp49-hashes.txt` (`sha256sum -c`
clean). **All red on the first valid attempt except S1-b, which is green by construction and
explained.**

| #    | Control                                           | Sabotage                                                                                       | Test driven                                                                       | Result      | First failure                                                                                                                                                                |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SA-1 | a rule reads only what it was granted             | R6 returns nothing unless `plan_projection` (never declared) is present                        | `catalog-v3` + `catalog` "reads only the scopes its manifest declares"            | **red** (2) | `drift/R6: expected { insights: [] } to deeply equal { insights: [ {…} ] }`                                                                                                  |
| SA-2 | budget applied **after** the wave                 | `releaseWave` budgets the live feed, then appends the wave to the list                         | `'the alert budget is applied after the retirement wave is released, not before'` | **red**     | `expected 25 to be 20` (list length)                                                                                                                                         |
| SA-3 | a gap rule never fires on a default               | an R5 written over assumed plan terms (flat pace, no true-up) entered into `BUILTIN_CATALOGUE` | `catalog-v3`, `catalog`, `advisor-golden`                                         | **red** (6) | `R5 … is in both lists`; `expected ['R5','R1',…] to deeply equal ['R1',…]`; no disclaimer                                                                                    |
| SA-4 | the ceiling withholds, never clamps               | R6 keeps any computed figure (`clampImpact` bypassed)                                          | `'R6 withholds an impact over the ceiling rather than clamping it'`               | **red**     | `expected { minor: '60000000' } to be null`                                                                                                                                  |
| SA-5 | a scope never reaches the DB before its migration | `0024_…v1_3.sql` moved out of `migrations/`                                                    | `phase3-registration` + `phase4-advisors` (api-db)                                | **red**     | `a scope the database will not store a grant for … expected ['plan.projection'] to deeply equal []`; DB: CHECK lacks `plan.projection`, `grantScopes` insert fails (`23514`) |
| SA-6 | no id crosses (08 §4.2)                           | `goal_ref: goal.id` in `#goalsList`                                                            | `scope-minimization`, `snapshot-arms`                                             | **red** (2) | `builtin: expected '{"goals_list"…' not to contain '01930000-…900d'`                                                                                                         |
| SA-7 | copy linter (07 §7.2)                             | R2's summary gains "this plan will grow past the target"                                       | `copy-lint` + `lint-advice-copy`                                                  | **red** (2) | `banned_phrase … will grow/earn/return`                                                                                                                                      |
| SA-8 | published schema = source                         | a field added to `PlanProjectionSchema`, schemas not regenerated                               | `contract-parity`                                                                 | **red** (2) | `request.schema.json: expected … to be …`                                                                                                                                    |
| SA-9 | absent, never an empty block                      | `#goalsList` returns `{ goals: [] }` for a `null` answer                                       | `snapshot-arms`                                                                   | **red**     | `expected { goals_list: { goals: [] } } to deeply equal {}`                                                                                                                  |
| S1-a | `newestNetWorthDay`: `user_id`                    | predicate dropped                                                                              | `phase4-advisors` (api-db)                                                        | **red** (3) | `expected +0 to be 0.1` — Bob's newer day read, Alice's goal reported unfunded; R6 impact `1400004n` ≠ `1200000n`                                                            |
| S1-b | `newestBaselineRunId`: `user_id` alone            | predicate dropped                                                                              | `phase4-advisors`                                                                 | **green**   | see below                                                                                                                                                                    |
| S1-c | `newestBaselineRunId`: `scenario_id` alone        | predicate dropped                                                                              | `phase4-advisors`                                                                 | **red** (2) | `expected 'deterministic' to be 'monte_carlo'` — Alice's newer **fork** run read                                                                                             |
| S1-d | `newestBaselineRunId`: both, together             | both dropped                                                                                   | `phase4-advisors`                                                                 | **red** (2) | `Alice has a baseline run; the block must exist` — Bob's run picked, `readProjection(Alice, BobRun)` refused, block absent                                                   |

**S1-b, the WP 3.9 S1 phenomenon, recorded.** `scenario_id` is the holder's own baseline id
(`getBaseline(userId)`), and scenario ids are globally unique, so dropping `user_id` alone cannot
reach another holder's row — the other predicate proves it. That is exactly why §5 item 8 demands the
"together" case, and S1-d is red: with both of mine gone, the third predicate —
`readProjection`'s own `findRun(user_id, id)` in WP 4.6's store — refuses Bob's run and the block
fails closed (absent). `user_id` is kept on the query as defence in depth and for the
`(user_id, …)` index; it is **not independently load-bearing**, and this row says so rather than
counting it as a proven control.

---

## 7. The copy linter, before and after a deliberate violation

- **Before:** `copy-lint.test.ts` → `'every template WP 4.9 added passes the linter on the seed'` —
  six rules across `drift` and `tight`, every string on every insight (title, summary, basis,
  caveats, evidence labels and values, action labels and rationales), **with a trace context**, so
  an untraced numeral fails too: `[]` violations.
- **The deliberate violation:** `'"this plan will grow to $2.1M" fails the linter'` →
  `banned_phrase: will grow/earn/return`; also "will earn", "will return 7%", "guaranteed returns",
  "You should retire later".
- **After a violation in real copy:** SA-7 above — R2's own template made to say "will grow", and
  two suites go red naming the rule and the phrase.

A goal's name is the holder's own text; R6 quotes it and never opens a sentence with it, so "Pay off
the car" cannot read as an imperative (`goals.ts`' comment at the call site).

---

## 8. No compounded return in any headline

`no-compounding.test.ts` → `'no R rule's headline impact is a compounded speculative return'`: over
every insight on all three seed cases, no derivation reads `plan_projection.terminal`, none has a
`(1 + r)` factor, none uses an input twice; only R6 claims money, from `($0 - $1) * 12` over its two
`pace.*_monthly.minor` refs; every other basis opens "No dollar figure" or "Probability points"; R2's
summary contains no `$`. `'no R rule prints a figure from the projected band'` (the tracer _would_
accept one — the band is in the snapshot). `'the checker catches a compounded return and a read of
the band'` keeps the predicate honest.

---

## 9. Gaps, decisions, and what is still carried

- **R5** — `CATALOGUE_GAPS`, reason names YTD deferrals, payroll cadence, match formula, true-up flag
  and cites §6 Q4. `catalog-v3` → `'every rule in the WP 4.9 brief is implemented or has a stated
reason, and R5 is a gap'`.
- **I7, I8, I9, I10, X4** — unchanged gaps. §6 Q4's default is **not built** and no plan terms were
  entered, so none was written over data that is not there; the same test pins the list. **I10 (P0)
  and R5 (P0) remain unwritten**, stated plainly as §6 Q4 asks.
- **`@core/secretbox` merchant-pseudonym swap (§6 Q6)** — **not applied, still carried.** Its default
  ("apply in Wave A's batch") was not applied by the dependency batch, and this WP may not edit
  `package.json`. Note that `goalRef` in `builder.ts` reuses the same keyed construction with domain
  `goal`, so the swap must move it too (§11).

---

## 10. Tests and checks

New or extended, by file (dispatch names in bold):

- `packages/contexts/insights/test/catalog-v3.test.ts` (new, 10): **`'every R rule produces at least
one resolvable evidence ref on the seed'`**, **`'every R rule returns zero insights when its inputs
are absent'`**, pipeline, declared-scopes-only, disclaimer, urgent set, R2 refusals, R1 derived,
  R5 gap, R6 ceiling.
- `scope-minimization.test.ts` (+4): **`'plan.projection emits no balance, no account id and no date
finer than a year'`** and the three above.
- `contract-parity.test.ts` (+1): **`'the published schemas match the source at 1.3.0'`**.
- `copy-lint.test.ts` (+2): **`'"this plan will grow to $2.1M" fails the linter'`**, templates pass.
- `no-compounding.test.ts` (new, 3): **`'no R rule's headline impact is a compounded speculative
return'`** and two more.
- `alert-budget-wave.test.ts` (+2), `snapshot-arms.test.ts` (+6 planning-arm tests),
  `advisor-golden.test.ts` (+6 golden rows; each fires on its case and is silent on a control with a
  healthy plan), `catalog.test.ts` (enabled count 25 → 31), `test/advisors/seed.ts` (planning
  fixtures for all three cases, through `inMemoryPlanningPort` and the real builder).
- `apps/api/test/db/phase4-advisors.test.ts` (new, 6, api-db): the real port over real rows, the S1
  matrix's assertions, the consent route granting `plan.projection`, a real retirement-wave run
  proposing R2 (Monte Carlo 0.2% vs 80%), R3, R4, R6, R7 with resolvable evidence.
- **`apps/api/test/phase3-registration.test.ts` → `'every advisor scope can actually be granted'`** —
  outside this WP's ownership; green as it stands (0024 present). Its rename and the other pin that
  moves are in §11.

Checks at report time (before the final re-run appended in §13):

| Check                                                                                                                                                                                  | Result                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsc -b --noEmit`                                                                                                                                                            | clean                                                                                                                                    |
| `pnpm exec eslint packages/contexts/insights apps/api/src/domain.ts apps/api/test`                                                                                                     | exit 0                                                                                                                                   |
| `pnpm exec prettier --write` over every file touched, incl. the `.json` artefacts                                                                                                      | applied (normalised two pre-existing C-10 lines in `snapshot.ts`, whitespace only)                                                       |
| `node scripts/check-numeric-boundaries.ts \| tail -3`                                                                                                                                  | self-test PASS; PASS — 776 files, 0 violations                                                                                           |
| `pnpm run lint:schema-ownership`                                                                                                                                                       | ok — 103 tables claimed across 14 packages                                                                                               |
| `vitest --project insights --project insights-db --project api`                                                                                                                        | 341 passed, **1 failed: `phase3-registration` → `'every advisor scope has a reader'`** — the `NOT_YET_MODELLED` pin that must move (§11) |
| `vitest --project api-db` over `phase4-advisors`, `phase3-advisors`, `advisor-grants`, `phase2-wiring`, `insights-routes`, `insights-pending-review`, `phase3-wiring`, `phase4-wiring` | 8 files, 50 passed                                                                                                                       |
| `vitest --project db` (migrations incl. 0024)                                                                                                                                          | 10 passed                                                                                                                                |
| `git diff --cached --name-only`                                                                                                                                                        | empty                                                                                                                                    |

---

## 11. For the orchestrator

**Binding lines outside my ownership.** `createInsightsPlanningPort` lives in the insights port
block of `apps/api/src/domain.ts` (after `createInsightsMarketDataPort`, lines ~1533–1899; imports
added at the `@ctx/insights` type import, the `@ctx/planning` import, a new
`@ctx/planning/schema` import and `desc`/`lte` from `drizzle-orm`). `SnapshotPorts.planning` is
**optional**, so nothing breaks without it — but until these two lines land, production snapshots
carry **no** `goals_list`, `risk_profile` or `plan_projection` and the retirement wave is silent:

```ts
// apps/api/src/modules.ts — insightsModule, in `ports:` (import it from './domain.ts')
planning: createInsightsPlanningPort(database, clock, { timeZone: options.timezone }),

// apps/api/src/routes/insights.ts — the on-demand run's `ports:` (same import)
planning: createInsightsPlanningPort(deps.database, deps.clock, { timeZone }),
```

**`apps/api/test/phase3-registration.test.ts` — the pins that move.**

1. `NOT_YET_MODELLED` → `['institutions.names', 'market.watchlist']` (and its comment: Planning
   landed in WP 4.9). This is the one red test in the `api` project at report time.
2. Per the dispatch: rename `'every advisor scope can actually be granted, or is a recorded migration
gap'` → `'every advisor scope can actually be granted'`, delete `UNGRANTABLE_UNTIL_MIGRATED`, and
   assert `ungrantable` `toEqual([])`. (`phase3-advisors.test.ts`' `UNGRANTABLE_SCOPES` seam can go
   with it.)

**Contract/migration decision.** New scope → contract **1.3.0** (not 1.2.0: C-10) + regenerated
advisor schemas + **migration 0024** named `0024_snapshot_grant_scopes_v1_3.sql` (the dispatch
reserved `…_v1_2`; renamed to the version it carries). Commit them together.

**Shared-file items.**

- `packages/db/test/migrate.test.ts` — attribution comment for 0024 (no table; table list unchanged).
- `just openapi` + regenerate `apps/web/src/api/generated/`: the grant route's body is
  `z.enum(ADVISOR_SCOPES)`, so `openapi.json` gains `plan.projection` and CI's `openapi-current` job
  is red until it is regenerated (dispatch §4 item 8).
- `packages/contexts/insights/src/index.ts` (not mine): export `PlanningPort`, `InsightsGoal`,
  `InsightsRiskProfile`, `InsightsPlanProjection`, `inMemoryPlanningPort`, `PlanProjectionSchema`,
  `GoalsListSchema`, `wp49Catalogue`, `WP_4_9_SCOPE`, `WP_4_9_URGENT_RULE_IDS`. `domain.ts` currently
  derives the port types from the exported `SnapshotPorts` instead.
- `snapshot/tokens.ts` (not mine): add a `goal` `TokenDomain` (`PREFIX: 'GOAL'`, in
  `ALWAYS_TOKENISED`) and replace `builder.ts`' local `goalRef` — identical output. Must travel with
  the `@core/secretbox` swap.

---

## 12. Open items and findings

1. **S6 loses a dashboard slot to R2/R7 on a key tie-break** (§5) — WP 2.7's `rank()` has no
   P0-safety term. Latent while spending ships off.
2. **`GUARDRAIL_REFERENCE_RATE = '0.045'`** belongs in WP 4.2's assumptions file as a cited,
   overridable value (07 §5.6: "user-settable"). The band is correct only for a retirement that
   started near it; the R7 caveat says so.
3. **R1 over real data needs twelve months of income** (WP 4.3). The DB fixture has none, so its
   `savings_rate` is absent and R1 is silent there; R1 is proven on the `tight` seed. The scale seed
   would exercise it.
4. **`newestBaselineRunId`'s `user_id` is not independently load-bearing** (S1-b, §6).
5. **Goal names reach advisor copy** — the holder's own text, ≤ 96 characters, quoted. `redactDigits`
   is declared on every scope row but implemented nowhere in the builder (pre-existing).
6. **Performance**: `#planProjection` runs WP 4.3's derivation once and the deterministic engine
   three times per snapshot (plan, claim at 70, first-year guardrail), writes nothing. Not measured
   on the scale seed.
7. **Dispatch test name** `'…match the source at 1.2.0'` is `'…at 1.3.0'` here (C-10 took 1.2.0).

---

## 13. Final re-run

Run 2026-09-27 14:17 EDT, after this document was written, against the tree as it stands (every
sabotaged file re-hashed identical to its pre-sabotage SHA-256).

| Check                                                                                                                                                                                                 | Result                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec tsc -b --noEmit`                                                                                                                                                                           | clean (exit 0)                                                                                                                                                                       |
| `pnpm exec eslint packages/contexts/insights apps/api/src/domain.ts apps/api/test`                                                                                                                    | exit 0                                                                                                                                                                               |
| `pnpm exec prettier --check` over every touched file (the `.sql` has no prettier parser, like every migration)                                                                                        | all formatted                                                                                                                                                                        |
| `node scripts/check-numeric-boundaries.ts \| tail -3`                                                                                                                                                 | self-test PASS; PASS — 776 files, 0 violations, 72 exempt                                                                                                                            |
| `pnpm run lint:schema-ownership`                                                                                                                                                                      | ok — 103 tables claimed across 14 packages, 90 defined                                                                                                                               |
| `vitest --project insights --project insights-db --project api`                                                                                                                                       | 39 files: **341 passed, 1 failed** — `phase3-registration` → `'every advisor scope has a reader'`, the `NOT_YET_MODELLED` pin in §11 (outside this WP's ownership; expected to move) |
| `vitest --project api-db` over `phase4-advisors`, `phase3-advisors`, `advisor-grants`, `phase2-wiring`, `insights-routes`, `insights-pending-review`, `phase3-wiring`, `phase4-wiring`, `plan-routes` | 9 files, **84 passed**                                                                                                                                                               |
| `vitest --project db` (every migration, 0024 included)                                                                                                                                                | 1 file, 10 passed                                                                                                                                                                    |
| `git diff --cached --name-only`                                                                                                                                                                       | empty                                                                                                                                                                                |
