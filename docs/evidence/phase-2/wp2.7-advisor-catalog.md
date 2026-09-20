<!-- SPDX-License-Identifier: MIT -->

# WP 2.7 — Built-in advisor catalog v1

Scope: `packages/contexts/insights/src/advisors/**`, the catalogue's export block
in `packages/contexts/insights/src/index.ts`, and five suites under
`packages/contexts/insights/test/`. No contract file, no validator file, no
migration, no route, no dependency.

Fourteen deterministic rules over docs/research/07 §3.3, delivered through the
WP 2.6 Advisor contract with nothing bypassed: every insight below went through
the same seven-step `validateResponse` a Phase 6 sidecar will, and was accepted
on the first pass. Nine further rules in WP 2.7's declared scope are recorded as
**unavailable**, each naming the field that does not exist rather than the effort
that was not made.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, tree at `83600d6` plus
this work package. Node v26.8.1, pnpm, vitest 5, Postgres on `127.0.0.1:5433`.
Every figure below was produced by running the code in this tree.

---

## 1. The rule table

`wave` is 02-phase-2-dispatch.md §6 Q4's release order (cash and subscriptions
first). `ceiling` is `capabilities.max_severity` on each manifest — the severity
the pipeline would clamp to; no rule in the catalogue ever reaches it from below,
which `catalog.test.ts` asserts.

| 07 id | `advisor_id`                              | scopes read                          | trigger                                                                    | `$` formula (as a declared derivation)                                               | ceiling | wave    |
| ----- | ----------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- | ------- |
| U2    | `builtin.subscriptions.price_increase`    | `recurring.list`                     | a confirmed `INCREASE` inside 180 days                                     | none — `price_changes[].annual_impact` is a snapshot field                           | warning | 1 (on)  |
| U3    | `builtin.subscriptions.duplicate_service` | `recurring.list`, `transactions.raw` | ≥2 active `SUBSCRIPTION` streams whose charges land in one `category_slug` | `$0*$1 + $2*$3 …` over every stream but the cheapest                                 | notable | 1 (on)  |
| U7    | `builtin.subscriptions.share_of_income`   | `recurring.list`, `cashflow.monthly` | monthly subscription cost > 1/10 of last complete month's income           | `($0*$1 + …) / 12` — no impact claimed                                               | notable | 1 (on)  |
| C1    | `builtin.cash.idle_above_cushion`         | `cash.summary`, `cashflow.monthly`   | cover > 6 months **and** excess > $5,000                                   | `($0) / 1 - ($1 + $2 + $3) / 3` — no impact claimed                                  | notable | 1 (on)  |
| C2    | `builtin.cash.yield_spread`               | `cash.summary`                       | balance ≥ $2,500, rate ≥ 0.5pp below the best rate already held            | `$0 * $1 - $0 * $2`                                                                  | warning | 1 (on)  |
| C3    | `builtin.cash.projected_shortfall`        | `cash.summary`, `recurring.list`     | Σ charges due ≤14 days > cash held                                         | `$0 + $1 + …` — no impact claimed                                                    | urgent  | 1 (on)  |
| C4    | `builtin.cash.emergency_fund_short`       | `cash.summary`, `cashflow.monthly`   | cover < 3 months                                                           | none — `emergency_fund_months` is a snapshot field                                   | warning | 1 (on)  |
| C7    | `builtin.cash.large_bill_due`             | `cash.summary`, `recurring.list`     | one charge due ≤10 days, > 40% of cash held                                | none — no impact claimed                                                             | warning | 1 (on)  |
| S2    | `builtin.spending.category_creep`         | `cashflow.monthly`                   | 3-month average > 12-month × 1.25 and delta > $50/mo                       | `((…)/3 - (…)/12) * 12`, plus both averages                                          | notable | 2 (off) |
| S3    | `builtin.spending.uncategorised`          | `transactions.raw`                   | ≥10 rows with `category_slug: null`                                        | none — **no figure is printed at all**, see §2                                       | notable | 2 (off) |
| S6    | `builtin.spending.duplicate_charge`       | `transactions.raw`                   | two outflows, one merchant, one band ≥ `50-200`, ≤3 days apart             | none — amounts cross as bands                                                        | urgent  | 2 (off) |
| S7    | `builtin.spending.fees`                   | `transactions.summary`               | a year of fee categories ≥ $50                                             | `$0 + $1 + $2` over the fee slugs                                                    | warning | 2 (off) |
| S9    | `builtin.spending.negative_month`         | `cashflow.monthly`                   | latest complete month's `net` < 0                                          | `(($0+$1+$2)/3) * 12` when three months run negative; otherwise `one_time` = \|net\| | warning | 2 (off) |
| S10   | `builtin.spending.annual_bills_ahead`     | `recurring.list`, `cashflow.monthly` | Σ bills at ≤2 periods/year due ≤90 days > 1.5 × monthly spend              | `$0 + $1 + …` — no impact claimed                                                    | notable | 2 (off) |

**Wave one ships eight rules enabled; wave two ships six registered and off.**
Registration is the manifest review (kind, scopes, egress) and happens for all
fourteen; enablement is `advisors.enabled`, WP 2.6's kill switch 2, which
defaults `FALSE` and is written once from `BuiltinCatalogueEntry.defaultEnabled`.
Turning a wave-two rule on is a single column update and needs no deploy.
`registerAdvisor`'s conflict branch deliberately does not touch `enabled`, so a
restart never re-enables a rule the user switched off.

S6 is 07's P0-safety class and is nevertheless in wave two, because 02 §6 Q4 says
cash and subscriptions go first and a wave is a wave. It is the first candidate
for promotion and costs one row to promote.

### The nine that cannot be written from Phase 2 data

`CATALOGUE_GAPS` in `src/advisors/catalogue.ts`, and `catalog.test.ts` asserts
every id in WP 2.7's scope is in exactly one of the two lists — so the catalogue
cannot quietly shrink, and "we forgot U5" is distinguishable from "U5 is not
expressible" a year from now.

| 07 id | What it needs that no Phase 2 scope carries                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1    | A user declaration of "unused". `status` and `user_confirmed` do not mean it, and 07 §2.10 is explicit that usage cannot be inferred from bank data.                |
| U4    | A vendor plan price table. D22 tokenises every merchant, so there is no name to look a plan up by.                                                                  |
| U5    | Trial-watch state (07 §2.7): a trial start, a trial end, or a first charge marked as one.                                                                           |
| U6    | A user "cancelling" flag on a stream. Inferring it from dormancy would be inventing an intention.                                                                   |
| U8    | A card APR and revolving balance. `cash.summary` is depository accounts only.                                                                                       |
| C5    | A credit limit and a statement date.                                                                                                                                |
| C6    | An APR and a revolving balance, as U8. The cash half exists; half of this rule is worse than none.                                                                  |
| S1    | An exact transaction amount and a per-category distribution. `transactions.raw` carries a **band** (03 §8.3), so neither σ nor `${amt}` can be computed or printed. |
| S5    | An exact amount and a merchant-first-seen date.                                                                                                                     |

Three of the nine — U8, C5 and C6 — want the same missing thing, and so does
every rule in 07's D (debt) family: **a credit account's APR, credit limit and
statement balance**. That is one snapshot block, not three rules' worth of work,
and it is the highest-value addition to the scope catalogue a later phase could
make.

### The market rate this catalogue does not have

07's C1 and C2 both compare against a market yield: _"a {mkt}% account would earn
~${g}/yr more"_. PersonalFi is self-hosted with no price feed, so there is no
market rate in any snapshot, and a hardcoded `4%` would be a numeral nothing
could account for — the validator would reject it at step 7, correctly, because
an assumption presented as a measurement is the exact failure the
anti-fabrication rule exists to stop.

So **C2 compares the user's accounts with each other**. It is weaker advice — it
cannot say a better account exists in the world, only that one already in their
name pays more — and every figure in it is theirs. When a rates source lands (a
user-entered assumption would do), the fix is a snapshot field and one more ref,
not a constant in a rule file.

---

## 2. Seed results, rule by rule

Three cases, each built by the real `SnapshotBuilder` over the in-memory ports
(`test/advisors/seed.ts`), `today = 2026-09-19`, `kind: 'builtin'`, all thirteen
scopes granted. A hand-written snapshot literal would have been a fixture whose
shape agrees with the rules because the same person wrote both; going through the
builder means the rounding, the bucketing, the tokenisation and the
`null`-block rules are the production ones.

| case      | what it is                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drift`   | $26,235 of cash against $3,500/mo of spending, three subscriptions, one price rise, a creeping dining line, one month in the red, twelve unfiled transactions, a year of fees |
| `tight`   | one current account holding $1,884.20 with $2,250 of charges due inside a fortnight                                                                                           |
| `control` | the same person, with none of the problems                                                                                                                                    |

Two positive cases rather than one because parts of the catalogue are mutually
exclusive by construction: C1 fires above six months of cover and C4 below three,
and no single balance does both.

### `drift`

```
U2  [notable] subscription.price_increase.MERCHANT_6fbb93c8e9d3.2026-06-01
    A subscription went from $15.99 to $18.99 on 2026-06-01 — about $36.00 more a year.
    impact: annualized 3600

U3  [notable] subscription.duplicate_service.entertainment.streaming
    You have two entertainment.streaming subscriptions running at once. Keeping only
    the cheapest would free about $227.88 a year.
    impact: annualized 22788

U7  [notable] subscription.share_of_income
    Your subscriptions come to about $632.98 a month. Income in 2026-08 was $5,400.00.
    impact: none claimed

C1  [notable] cash.idle_above_cushion
    About $21,701.67 more than three months of recent spending is held in cash,
    earning 0.81% across those accounts.
    impact: none claimed

C2  [warning] cash.yield_spread.acct-checking
    One account holds $21,235.00 at 0%, while another of your own earns 4.25%.
    At the higher rate that balance would have earned about $902.49 over a year.
    impact: annualized 90249

S2  [notable] spending.category_creep.dining.restaurants
    dining.restaurants has run about $450.00 a month lately, against $262.50 a month
    across the trailing year — about $2,250.00 a year at the new pace.
    impact: annualized 225000

S3  [notable] spending.uncategorised
    Some recent transactions have not been categorised, so budgets and these insights
    are incomplete until they are. The evidence panel lists them.
    impact: none claimed

S6  [urgent]  spending.duplicate_charge.txn-market-first.txn-market-second
    Two outgoing charges at the same merchant landed on 2026-09-04 and 2026-09-06,
    both in the 50-200 band.
    impact: none claimed

S7  [warning] spending.fees
    Bank, card and ATM charges came to about $184.00 across the last year of transactions.
    impact: annualized 18400

S9  [warning] spending.negative_month.2026-08
    In 2026-08, spending ran about $700.00 ahead of income.
    impact: one_time 70000

S10 [notable] spending.annual_bills_ahead
    About $7,650.00 of yearly and half-yearly bills fall due in the next three months,
    which is large next to a normal month of spending.
    impact: none claimed
```

### `tight`

```
C3  [urgent]  cash.projected_shortfall
    Recurring charges of about $2,250.00 fall due in the next two weeks, and your cash
    accounts hold $1,884.20 today.

C4  [warning] cash.emergency_fund_short
    Cash on hand covers about 0.6 months of recent spending. A cushion of three to six
    months is the usual guidance.

C7  [warning] cash.large_bill_due.series-rent
    A recurring charge of about $1,450.00 is due on 2026-09-24, and your cash accounts
    hold $1,884.20.

C7  [warning] cash.large_bill_due.series-power
    A recurring charge of about $800.00 is due on 2026-09-28, and your cash accounts
    hold $1,884.20.
```

### `control`

```
(nothing)
```

`advisor-golden.test.ts` pins each of those sentences **verbatim**, per rule,
together with the severity, both impact figures, and the assertion that the same
rule returns `[]` on the control. The control half is the half that catches
things: a threshold inverted, an `&&` that should be an `||`, a window that is
always true — every one of those bugs produces a rule that also fires on the
healthy case.

### Every figure traced

`catalog.test.ts` runs every insight from every case through the real
`validateResponse` with the real manifest and limits, and asserts
`rejected === []`, `accepted.length === insights.length`,
`status === 'pending_review'` and `severityClamped === false`. The worked
example, from `drift`, is C2:

| numeral on screen                   | how the validator accounted for it                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$21,235.00`                        | `cash_summary.accounts[0].balance.minor` = `2123500`, under the `÷100` rendering                                                                            |
| `0%`                                | `cash_summary.accounts[0].apy` = `0`, under `×100`                                                                                                          |
| `4.25%`                             | `cash_summary.accounts[1].apy` = `0.0425`, under `×100`                                                                                                     |
| `$902.49`                           | derivation `spread_over_a_year` = `$0 * $1 - $0 * $2` over three refs, which **we** re-evaluated to `90248.750000`, under `÷100` at two decimals, half-even |
| `impact.annualized.minor` = `90249` | the same computed value at zero decimals                                                                                                                    |

Note what the derivation could not be. `$0 * 0.04` is unexpressible: `0.04` is
not in `DERIVATION_LITERALS`, and `derivations.ts` documents why — only units
(months in a year, days in a cooldown) are free, so a rule cannot launder an
assumption through a multiplication. The rate on both sides of C2's expression is
a snapshot field.

### Where the anti-fabrication rule bit a real rule

07's S3 template is *"{n} transactions (${amt}) aren't categorized"*. Neither
figure is available: `transactions.raw` has one row per transaction and no count
field, and its amounts are bands. `n` could be *computed* — it is
`rows.filter(…).length` — and **that is exactly why it may not be printed**. A
number derived from the shape of the data rather than from a value in it has
nothing for the validator to trace, and the only way to make it traceable would
be a laundering expression like `$0 * 0 + 1 + 1 + …`, which `derivations.ts`
names as the hole it deliberately closes.

So S3 says "some recent transactions", puts each one in `evidence[]`, and lets
the UI count what it renders. The rule still _fires_ on a count, because a
trigger is not a rendered figure. The same discipline explains every spelled-out
number in the catalogue's copy — "three months", "two weeks", "the last year".
A word is not a numeral.

---

## 3. Ranking, worked

07 §3.2:

```
rank_score = annualized_impact × confidence × actionability
           × urgency_multiplier × (1 − 0.5 × dismiss_rate)
```

WP 2.6 shipped the knowable half in `policy/alert-budget.ts`'s `rank()` — impact
and confidence, with severity additive and dominant — and left the other three
to this package. `src/advisors/ranking.ts` supplies them and **composes with**
`rank()` rather than replacing it:

```
rankBuiltin(row) = rank(row) × actionability × urgency × (1 − 0.5 · dismissRate)
```

Composition rather than replacement matters for one reason: `rank()` is what an
advisor with _no_ catalogue entry is ranked by — a Phase 6 sidecar declares no
actionability tier and has no dismissal history on day one — so the two have to
agree about everything the catalogue does not know. With every extra factor at
its neutral value the two functions return the same number, and
`ranking.test.ts` asserts exactly that.

**The three factors are read off the insight, not off a table beside each rule.**
`actionability` comes from `proposed_actions[].kind` (a rule or goal _draft_ is
one-click at 1.0, a suggestion or link is do-it-yourself at 0.7, no action is
informational at 0.4) and `urgency` from `horizon` (`immediate` → 2.0). A hand
table drifts — somebody adds an action and forgets the tier — and read off the
insight the two can only disagree if the insight is wrong. `dismiss_rate` is the
one outside input, from `insight_feedback`, defaulting to `0`.

### The whole seed, ranked

Both positive cases together, fifteen insights, ordered by `rankBuiltin`:

| rule      | key                                                            | severity | horizon      | actions           | effective impact (minor) | confidence | rank    |
| --------- | -------------------------------------------------------------- | -------- | ------------ | ----------------- | ------------------------ | ---------- | ------- |
| S6/drift  | `spending.duplicate_charge.txn-market-first.txn-market-second` | urgent   | immediate    | suggest_only      | none                     | 0.6        | 42.0000 |
| C3/tight  | `cash.projected_shortfall`                                     | urgent   | immediate    | suggest_only      | none                     | 0.9        | 42.0000 |
| C7/tight  | `cash.large_bill_due.series-rent`                              | warning  | immediate    | suggest_only      | none                     | 0.95       | 28.0000 |
| C7/tight  | `cash.large_bill_due.series-power`                             | warning  | immediate    | suggest_only      | none                     | 0.9        | 28.0000 |
| C2/drift  | `cash.yield_spread.acct-checking`                              | warning  | this_year    | suggest_only      | 90249                    | 1          | 17.4688 |
| S9/drift  | `spending.negative_month.2026-08`                              | warning  | this_period  | suggest_only      | 35000                    | 1          | 17.1809 |
| S7/drift  | `spending.fees`                                                | warning  | this_year    | suggest_only      | 18400                    | 1          | 16.9854 |
| C4/tight  | `cash.emergency_fund_short`                                    | warning  | this_year    | suggest_only      | none                     | 1          | 14.0000 |
| S2/drift  | `spending.category_creep.dining.restaurants`                   | notable  | this_year    | suggest_only      | 225000                   | 1          | 10.7465 |
| S3/drift  | `spending.uncategorised`                                       | notable  | this_period  | create_rule_draft | none                     | 1          | 10.0000 |
| U3/drift  | `subscription.duplicate_service.entertainment.streaming`       | notable  | this_year    | suggest_only      | 22788                    | 0.9        | 9.7454  |
| U2/drift  | `subscription.price_increase.MERCHANT_…`                       | notable  | this_year    | suggest_only      | 3600                     | 0.94       | 9.3401  |
| U7/drift  | `subscription.share_of_income`                                 | notable  | this_year    | suggest_only      | none                     | 0.9        | 7.0000  |
| C1/drift  | `cash.idle_above_cushion`                                      | notable  | this_year    | suggest_only      | none                     | 1          | 7.0000  |
| S10/drift | `spending.annual_bills_ahead`                                  | notable  | next_quarter | suggest_only      | none                     | 0.85       | 7.0000  |

Four things in that table are the design working rather than the arithmetic:

1. **The two urgent items lead, and neither carries a dollar figure.** 07's C3 and
   S6 impacts are `overdraft_fee × count` and "the duplicated amount"; this app
   knows neither the fee nor the exact amount, so both claim **no** impact — which
   is precisely the case the floor's exemption exists for. An insight that claims
   nothing is judged on what it is.
2. **S9's effective impact is 35,000 from a `one_time` of 70,000.** The halving
   (07 §3.2: "a recurring dollar is worth more than a one-time dollar") happens
   once, inside `effectiveImpactMinor`, and is visible here on real output.
3. **S2's $2,250/yr outranks U3's $227.88 but not C2's $902.49**, because severity
   is additive and dominant: a `warning` starts ten points above a `notable` and
   no amount of money crosses that. The app leads with what will hurt.
4. **The two 42.0000 ties are broken on `key`**, ascending, so the feed does not
   reshuffle between two reads of the same data.

---

## 4. The alert budget, applied to the seed

Defaults from 02 §6 Q4: **5 on the dashboard, 20 in the list, $50 minimum annual
impact**; cooldown 30 / 90 / permanent after one, two and three dismissals (WP
2.6's, unchanged). The constants and the floor itself are imported from
`policy/alert-budget.ts` rather than re-stated, so the catalogue cannot drift
into a second definition of `$50`.

```
15 insights proposed across both seed cases

dashboard  (5): C3/tight, S6/drift, C7/tight, C7/tight, C2/drift
list      (14): C3, S6, C7, C7, C2, S9, S7, C4, S2, S3, U3, C1, S10, U7
overflow   (0):
belowFloor (1): U2/drift — $36.00 a year, under the $50 floor
```

Three properties, each visible above:

- **The dashboard is the top of the list, not a separate selection.** A user who
  expands "and 9 more" sees the same five first.
- **The floor bit a real rule.** U2's price rise is $36.00 a year, which is true,
  uninteresting, and would crowd out a $902.49 finding. It is **withheld, not
  deleted** — the row is still `pending_review` in `insights` with its evidence,
  and raising the floor shows it again without a re-run.
- **Nothing overflowed** on fifteen insights, which is the point of releasing in
  waves: with all fourteen rules enabled and a real 50k-transaction history this
  would overflow, and 02 §6 Q4's worry ("the first run is not a wall of red") is
  handled by the waves _and_ the budget rather than by either alone.

`ranking.test.ts` proves the cap itself on a 25-row ladder: `dashboard` is 5,
`list` is 20, `overflow` is the 5 lowest-impact rows by key, every row appears in
exactly one slice, and a below-floor row is in `belowFloor` rather than missing.

---

## 5. Sabotage record

Four controls, each broken once, each observed **red on the first try**, each
restored from a copy taken immediately before the edit. `git diff --quiet` on
`src/advisors/` was clean afterwards and all 139 tests pass (§7).

| #   | Control                   | How it was broken                                                   | Test run by name                                                           | Result  |
| --- | ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| S1  | copy lint, numeral rule   | the `untraceableNumerals` loop in `copy-lint.ts` fed an empty array | `'copy lint rejects an untraced numeral'`                                  | **red** |
| S2  | copy lint, banned phrases | the `BANNED_PHRASES` loop fed an empty array                        | `'"you should" fails the linter'`                                          | **red** |
| S3  | the impact ceiling        | `clampImpact`'s `magnitude > CEILING_MINOR` branch made unreachable | `'an impact above the ceiling is clamped and logged'`                      | **red** |
| S4  | the alert budget cap      | `applyCatalogueBudget` returned the whole ordering for both slices  | `'the alert budget caps dashboard/list counts and drops by lowest impact'` | **red** |

### S1 — an untraced numeral passes the linter

```
$ pnpm exec vitest run --project insights -t 'copy lint rejects an untraced numeral'

 FAIL  |insights| test/lint-advice-copy.test.ts > the advice-copy linter > copy lint rejects an untraced numeral
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ test/lint-advice-copy.test.ts:52:24
     50|       context,
     51|     );
     52|     expect(violations).toHaveLength(1);
       |                        ^

 Test Files  1 failed | 11 skipped (12)
      Tests  1 failed | 121 skipped (122)
```

`$999.99` against a snapshot holding `1899` produced no violation at all.

### S2 — "you should" passes the linter

```
$ pnpm exec vitest run --project insights -t '"you should" fails the linter'

 FAIL  |insights| test/lint-advice-copy.test.ts > the advice-copy linter > "you should" fails the linter
AssertionError: expected [] to include 'banned_phrase'
 ❯ test/lint-advice-copy.test.ts:27:59
     25|   it('"you should" fails the linter', () => {
     26|     const violations = lintAdviceCopy('You should move this to a savin…
     27|     expect(violations.map((violation) => violation.rule)).toContain('b…
       |                                                           ^

 Test Files  1 failed | 11 skipped (12)
      Tests  1 failed | 121 skipped (122)
```

### S3 — a $1.412M "saving" reaches the insight

```
$ pnpm exec vitest run --project insights -t 'an impact above the ceiling is clamped and logged'

 FAIL  |insights| test/impact-ceiling.test.ts > the impact ceiling > an impact above the ceiling is clamped and logged
AssertionError: expected { minor: '141200000', currency: 'USD' } to be null

- Expected:
null

+ Received:
{
  "currency": "USD",
  "minor": "141200000",
}

 ❯ test/impact-ceiling.test.ts:62:39
     60|
     61|     // Clamped: the headline figure is gone, and no substitute took it…
     62|     expect(insight.impact.annualized).toBeNull();
       |                                       ^
```

**And the validator did not catch it.** With the ceiling disabled, the full
`impact-ceiling.test.ts` run was:

```
 × an impact above the ceiling is clamped and logged
 × the boundary is the ceiling itself, not one short of it
 × a negative outlier is withheld on its magnitude
 Tests  3 failed | 3 passed (6)
```

One of the three that still passed is `'an insight whose impact was withheld
still passes the pipeline'` — the poisoned $1,412,000 figure went through all
seven steps and was **accepted**, because it is faithfully traceable to a
snapshot value. That is not a validator defect: the validator's question is "did
this number come from the data we sent?", and the answer was yes. The ceiling
answers a different question — "is this number plausible?" — and a data bug
upstream can only be caught by the second. It is the only control in this package
the validator does not back up, and the reason it exists.

### Why the ceiling withholds rather than rewrites

Rendering `$100,000` for a computed `$1,412,000` would put a number on the screen
that is in neither the snapshot nor any declared arithmetic. The validator would
reject it at step 7 — correctly — and a "clamped" figure is anyway a number the
app invented to avoid admitting a data bug. So the headline is dropped, a caveat
says so in words, the real figure goes to `diagnostics.warnings` (stored on
`advisor_runs`, never rendered, and outside the numeral trace by design), and the
_finding_ survives: a price rise is real even when its annualisation has been
poisoned by one bad row, and dropping the insight would hide the evidence that
leads to the bug.

```
warnings[0] = "impact ceiling: recurring_list.streams[0].price_changes[0].annual_impact
               computed 141200000.00 minor units, over the 100000 major-unit ceiling;
               figure withheld"
```

### S4 — the budget stops capping

```
$ pnpm exec vitest run --project insights -t 'the alert budget caps dashboard/list counts and drops by lowest impact'

 FAIL  |insights| test/ranking.test.ts > the alert budget > the alert budget caps dashboard/list counts and drops by lowest impact
AssertionError: expected [ { key: 'k00', …(7) }, …(24) ] to have a length of 5 but got 25

- Expected
+ Received

- 5
+ 25

 ❯ test/ranking.test.ts:141:28
    139|     const feed = applyCatalogueBudget(rows, (item) => item, USD);
    140|
    141|     expect(feed.dashboard).toHaveLength(ALERT_BUDGET.dashboard);
       |                            ^
```

Restored — each file from a copy taken immediately before its edit, then the
whole of both projects re-run:

```
$ git status --porcelain packages/contexts/insights/
 M packages/contexts/insights/package.json        (the orchestrator's fast-check line)
 M packages/contexts/insights/src/index.ts        (this package's export block)
?? packages/contexts/insights/src/advisors/
?? packages/contexts/insights/test/advisor-golden.test.ts
?? packages/contexts/insights/test/advisors/
?? packages/contexts/insights/test/catalog.test.ts
?? packages/contexts/insights/test/impact-ceiling.test.ts
?? packages/contexts/insights/test/lint-advice-copy.test.ts
?? packages/contexts/insights/test/ranking.test.ts

$ DATABASE_URL=… pnpm exec vitest run --project insights --project insights-db
 Test Files  14 passed (14)
      Tests  139 passed (139)
```

---

## 6. The advice-copy linter

`src/advisors/copy-lint.ts`. 07 §7.2 asks for `lint_advice_copy()` "in CI over
every message template"; it is a module in `@ctx/insights` rather than a script
under `scripts/`, and the tests are `test/lint-advice-copy.test.ts` rather than
`scripts/lint-advice-copy.test.ts` as 02 §3 names them. **The test names are
unchanged**; the location moved for a mechanical reason that 02 §5.5 is itself
about: the `insights` vitest project collects test files under `src/` and
directly under `test/`, and a suite under `scripts/` would be in no project at
all — the failure mode that hit 4 of 13 suites in Phase 0 and 13 of 23 in Phase

1. Living in the same suite as the rules also means the copy and the snapshot it
   is checked against can never be different data.

Four rules:

| rule                      | what it refuses                                                                           | where                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `banned_phrase`           | 07 §7.2's list, transcribed verbatim, including its `buy-and-hold` exception              | every field                                                                                                 |
| `imperative_advice`       | a sentence opening with an instruction (`Cancel`, `Move`, `Switch`, `Pay`, `Transfer`, …) | title, summary, basis, caveats — **not** action labels, which are buttons and are supposed to be imperative |
| `merchant_token_in_prose` | `MERCHANT_<hash>` in a sentence — a database identifier shown to a human                  | every field except `evidence[].value`, where quoting what a ref resolved to is required                     |
| `untraced_numeral`        | the validator's step 7, hoisted to where a rule author sees it                            | every field                                                                                                 |

The fourth is redundant with the pipeline **by design**: the pipeline's rejection
costs one insight at 04:15 and surfaces as a number on a diagnostics screen; this
one fails a test with the offending sentence in the message.

`'every insight the catalogue produces on the seed passes the linter'` runs all
four rules over every insight from all three cases, with the candidate set built
the way the pipeline builds it — the snapshot plus the values _we_ recomputed
from that insight's own declared arithmetic, never another insight's, so two
insights cannot launder a number between them.

**What the linter deliberately does not check**: 07 §7.2's "always pair a
recommendation with its cost". That is a real rule and it is not a pattern —
"cost" is a judgement about whether a sentence is complete. It is enforced
structurally instead: a rule that claims an impact must declare the derivation
behind it, and `catalog.test.ts` asserts a rule never claims an impact its
manifest did not.

---

## 7. Tests

```
$ DATABASE_URL=… pnpm exec vitest run --project insights --project insights-db
 Test Files  14 passed (14)
      Tests  139 passed (139)
```

WP 2.6 left 94 across these two projects; this package added 45 in five files.

| File                            | Tests | What it pins                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/catalog.test.ts`          | 9     | `'every rule produces at least one resolvable evidence ref on the seed'` (the §5 exit criterion), `'every rule returns zero insights when its inputs are absent'`, `'every built-in insight passes the WP 2.6 pipeline unchanged'`, `'every rule reads only the scopes its manifest declares'`, scope coverage vs `CATALOGUE_GAPS`, registration, severity ceilings, impact claims, the wave split |
| `test/advisor-golden.test.ts`   | 16    | one golden per rule — fires on its seed case with its exact sentence, severity and impact figures, and returns `[]` on the control — plus the `fast-check` determinism property                                                                                                                                                                                                                    |
| `test/impact-ceiling.test.ts`   | 6     | `'an impact above the ceiling is clamped and logged'`, the boundary, negatives, and that a withheld impact still passes the pipeline                                                                                                                                                                                                                                                               |
| `test/ranking.test.ts`          | 8     | `'a one-time saving ranks at half a recurring one of equal size'`, `'the alert budget caps dashboard/list counts and drops by lowest impact'`, composition with `rank()`, the actionability and urgency tiers, floor exemption, stable ordering                                                                                                                                                    |
| `test/lint-advice-copy.test.ts` | 6     | `'"you should" fails the linter'`, `'copy lint rejects an untraced numeral'`, all ten banned phrases, imperative vs button, merchant tokens, and the whole catalogue's copy                                                                                                                                                                                                                        |

### Determinism

`'produces identical output twice, on the seed and on arbitrary input'` is a
`fast-check` property over arbitrary JSON dictionaries and arbitrary `today`
strings, run against all fourteen rules. It asserts two things at once:

- **Determinism.** A rule that sorted on an object key, reached for `Date.now()`,
  or let a `Map`'s insertion order break a tie would pass every golden test and
  still produce two different feeds from one night's data — and the upsert key
  `(advisor_id, key, period)` would churn rows rather than update them.
- **Totality.** A malformed snapshot must be an empty result, never a thrown
  worker. Rules are on the same totality path as the validator: `daysBetween`
  validates the shape of a date rather than trusting it, and every derivation
  builder returns `null` rather than throwing when a ref will not resolve.

`today` is passed **in** rather than read (08 §4.1: an advisor does not read a
clock), which is what makes the property meaningful.

### Pipeline, lint and format

```
$ pnpm exec tsc -p tsconfig.json --noEmit     # clean for packages/contexts/insights
$ pnpm exec eslint packages/contexts/insights --max-warnings 0
  (no output)
$ pnpm exec prettier --check "packages/contexts/insights/**/*.ts"
  All matched files use Prettier code style!
$ node scripts/check-schema-ownership.ts
  schema-ownership: ok — 95 table(s) claimed across 14 package(s), 65 defined.
$ node scripts/check-proxy-routes.ts
  check-proxy-routes: PASS — …
```

**`just check` is red, on files this work package does not own.** Recorded
verbatim in §9.

---

## 8. What WP 2.10's insight feed renders

One insight, in full, as the catalogue produces it — `C2` on the `drift` case.
Everything a screen needs is in it, and nothing a screen needs is computed by the
client:

```jsonc
{
  "key": "cash.yield_spread.acct-checking",
  "period": "2026-09",
  "type": "cash.yield_spread",
  "severity": "warning",
  "title": "One account earns less than another you already hold",
  "summary_md": "One account holds $21,235.00 at 0%, while another of your own earns 4.25%. At the higher rate that balance would have earned about $902.49 over a year.",
  "confidence": 1,
  "confidence_basis": "deterministic", // the provenance badge
  "horizon": "this_year",
  "requires_review": true, // and the row lands as pending_review
  "impact": {
    "annualized": { "minor": "90249", "currency": "USD" },
    "one_time": null,
    "basis": "The balance at the higher of two rates you already hold, less the lower.",
    "derivation_id": "spread_over_a_year", // "how was this computed?"
  },
  "evidence": [
    // the "Why am I seeing this?" panel
    {
      "kind": "metric",
      "label": "The balance",
      "value": "$21,235.00",
      "source_ref": "snapshot:cash_summary.accounts[0].balance",
    },
    {
      "kind": "metric",
      "label": "What it earns",
      "value": null,
      "source_ref": "snapshot:cash_summary.accounts[0].apy",
    },
    {
      "kind": "metric",
      "label": "The better rate you hold",
      "value": null,
      "source_ref": "snapshot:cash_summary.accounts[1].apy",
    },
  ],
  "derivations": [
    {
      "id": "spread_over_a_year",
      "expression": "$0 * $1 - $0 * $2",
      "inputs": [
        "snapshot:cash_summary.accounts[0].balance.minor",
        "snapshot:cash_summary.accounts[1].apy",
        "snapshot:cash_summary.accounts[0].apy",
      ],
      "value": "90248.750000",
      "note": "This balance at the better of two rates already held, less the rate it earns.",
    },
  ],
  "proposed_actions": [
    {
      "kind": "suggest_only",
      "label": "Compare your cash accounts",
      "rationale_md": "Both accounts are yours; the difference is only where the balance sits.",
      "url": null,
    },
  ],
  "caveats": ["Rates come from what is recorded against each account, not from a market feed."],
  "expires_at": null,
}
```

Seven notes for the UI:

1. **Every `source_ref` is a path into the snapshot, and the pipeline stores what
   it resolved to** (`ResolvedEvidenceRow.resolvedDisplay`). The panel can show
   what we sent a month later without keeping the payload. An `account_ref` is
   the account's own uuid for a `builtin` advisor, so "click through to the
   account" is a route parameter, not a lookup.
2. **`value: null` is normal and not a gap.** An evidence row citing a _ratio_
   leaves `value` null because `evidenceValueAgrees` compares a claim against the
   resolved primitive, and `4.25%` does not contain `0.0425`. The panel renders
   `resolvedDisplay`.
3. **A merchant is never named.** Every subscription insight says "a
   subscription" and puts the identity in a ref; resolving `MERCHANT_…` to a name
   for display is the UI's job, against data the advisor never saw (D22). The
   linter refuses a token in prose so the app cannot accidentally do it the other
   way.
4. **`impact.annualized` is rendered by the UI on its own**, outside any prose —
   which is why the numeral check traces it explicitly rather than relying on it
   appearing in `basis`.
5. **A rule with no impact is not a rule with a zero impact.** Eight of the
   fourteen claim nothing (U7, C1, C3, C4, C7, S3, S6, S10), and their manifests say
   `produces_impact: false` so the pipeline would reject a figure from them. The
   feed should render no money line at all rather than `$0`.
6. **Actions are all `suggest_only` except S3's `create_rule_draft`.** No action
   in this catalogue performs anything, no action carries a URL, and the contract
   has no acting member for one to use.
7. **The standing disclaimer is the UI's** (07 §7.2's educational-information
   paragraph). Nothing in the catalogue renders it, and every insight assumes it
   is on screen.

### Registration line for the composition root

Not this work package's file to edit. `apps/api/src/modules.ts` currently has:

```ts
const insightsRegistry = createAdvisorRegistry([]); // WP 2.7 supplies the catalogue
```

which becomes:

```ts
import { BUILTIN_CATALOGUE, createBuiltinRegistry } from '@ctx/insights';

const insightsRegistry = createBuiltinRegistry();
```

and, wherever the `advisors` rows are first written for a user:

```ts
for (const entry of BUILTIN_CATALOGUE) {
  await registerAdvisor(executor, context, {
    manifest: entry.advisor.manifest,
    enabled: entry.defaultEnabled, // wave one on, wave two off
  });
}
```

`registerAdvisor` without `enabled` leaves the switch alone, so a boot-time
re-registration never re-enables a rule the user turned off; passing
`entry.defaultEnabled` is correct on first write and harmless afterwards only
because the conflict branch ignores it. Grants matter too: the catalogue reads
five scopes in total (`cash.summary`, `cashflow.monthly`, `recurring.list`,
`transactions.raw` and `transactions.summary`) and an ungranted scope means the
rules that need it emit nothing, silently and correctly.

---

## 9. `just check`, verbatim

```
$ DATABASE_URL=… just check
pnpm run typecheck
$ tsc -p tsconfig.json
apps/api/src/worker.ts(162,24): error TS2345: Argument of type '{ database: Database; orchestrator: SyncOrchestrator; timezone: string; }' is not assignable to parameter of type 'ModuleWiringOptions'.
  Type '{ database: Database; orchestrator: SyncOrchestrator; timezone: string; }' is missing the following properties from type 'ModuleWiringOptions': notificationChannels, secretBox
apps/api/test/db/categorization-wiring.test.ts(133,32): error TS2345: Argument of type '{ database: Database; orchestrator: SyncOrchestrator; timezone: string; clock: Clock; }' is not assignable to parameter of type 'ModuleWiringOptions'.
  Type '{ database: Database; orchestrator: SyncOrchestrator; timezone: string; clock: Clock; }' is missing the following properties from type 'ModuleWiringOptions': notificationChannels, secretBox
apps/api/test/db/phase1-seed-e2e.test.ts(312,32): error TS2345: Argument of type '{ database: Database; orchestrator: SyncOrchestrator; timezone: string; clock: Clock; }' is not assignable to parameter of type 'ModuleWiringOptions'.
  Type '{ database: Database; orchestrator: SyncOrchestrator; timezone: string; clock: Clock; }' is missing the following properties from type 'ModuleWiringOptions': notificationChannels, secretBox
[ELIFECYCLE] Command failed with exit code 2.
error: recipe `typecheck` failed on line 116 with exit code 2
```

Three errors, all in `apps/api`, none in `packages/contexts/insights`. They come
from `apps/api/src/modules.ts`'s `ModuleWiringOptions` gaining
`notificationChannels` and `secretBox` while `worker.ts` and two suites have not
caught up — the wave-boundary wiring the orchestrator owns (02 §4 items 3–4),
in flight in this working tree. The count moved from three to two between two
runs eleven minutes apart, which is what an in-flight edit looks like.

`just check` stops at `typecheck`, so the remaining steps were run individually:

```
$ just lint
  eslint: 8 errors + 1 warning, all in apps/web —
    AddManualTransactionDialog.tsx, RecordBalanceDialog.tsx,
    CreateCategoryDialog.tsx, InboxScreen.tsx, TransactionsList.tsx,
    TransferPairDialog.tsx        (WP 2.11's files)
  schema-ownership: ok — 95 table(s) claimed across 14 package(s), 65 defined.
  prettier: 21 files unformatted — apps/api/src/{domain,modules,platform,worker}.ts,
    apps/web/src/features/**, packages/config/src/{load,load.test,schema}.ts
    (all other agents' in-flight files; every file this package owns is clean)

$ just check-proxy-routes
check-proxy-routes: PASS — docker/Caddyfile routes exactly '/api/*' to the api, …

$ DATABASE_URL=… just test
 FAIL  |api| test/gate-image-closure.test.ts > api image closure (personalfi/api:dev)
        > contains every workspace project apps/api needs at runtime
AssertionError: pruned out of the image but required at runtime:
  packages/contexts/budgeting, packages/contexts/insights,
  packages/contexts/notifications, packages/contexts/recurring:
  expected [ 'packages/contexts/budgeting', …(3) ] to deeply equal []

 Test Files  1 failed | 145 passed | 1 skipped (147)
      Tests  1 failed | 1878 passed | 2 skipped (1881)
```

The one test failure is the Docker image-prune list not yet naming the four new
Phase 2 contexts, which became required the moment `apps/api/package.json` gained
their workspace entries. It is a shared-file wave-boundary item (02 §4 item 8's
neighbour), not a WP 2.7 defect: `@ctx/insights` itself is green in full.

**Nothing red is in a file this work package owns**, and every suite it owns
passes:

```
$ DATABASE_URL=… pnpm exec vitest run --project insights --project insights-db
 Test Files  14 passed (14)
      Tests  139 passed (139)
```

---

## 10. Carried

1. **`scripts/lint-advice-copy.ts` was not created.** 02 §3 lists it in WP 2.7's
   _Owns_; the linter is `src/advisors/copy-lint.ts` and its suite is
   `test/lint-advice-copy.test.ts`, with the plan's test names unchanged. §6 has
   the argument. If a standalone script is still wanted, it is a thin wrapper
   over `lintInsightCopy` plus an entry in `vitest.config.ts` and both CI
   `--project` lists — a shared-file change this package may not make.
2. **The `advisors` rows are not written anywhere yet**, because
   `apps/api/src/modules.ts` is not this package's file. §8 has the exact two
   edits. Until they land, `createAdvisorRegistry([])` still proposes nothing and
   the catalogue is code nothing calls.
3. **U7 counts at most eight subscriptions.** `Derivation.inputs` is capped at
   sixteen by the contract and each stream costs two (amount and periods). Beyond
   eight the rule reports the eight largest and says so in the copy, which
   under-reports the total and can only make the finding more conservative. The
   honest fix is a snapshot field carrying the subscription total, not a larger
   `inputs` cap.
4. **S2 will fire on a one-off.** A single large month inside the three-month
   window moves the average past 1.25×, which is 07 §3.3 S2 working as specified;
   the copy carries the caveat. Tightening it wants a "≥3 months running" test
   that the 12-month `by_category` window can support and this implementation does
   not yet apply.
5. **S6 compares bands, not amounts.** Two genuinely different charges at one
   merchant in one band on consecutive days are indistinguishable from a
   duplicate. The rule starts at the `50-200` band rather than 07's `> $10`
   precisely because `10-50` is where two coffees live, and its confidence is
   0.6 with the caveat on screen. This is the catalogue's most likely false
   positive.
6. **`dismiss_rate` is always zero** until `insight_feedback` has rows and WP
   2.10's feed passes it. The factor is implemented and unit-tested; it has never
   changed an ordering on real data.
7. **No rule has run against the 50k seed or a real institution.** Every figure
   here is from `test/advisors/seed.ts`. WP 2.12's perf budget and the Phase 2
   gate's browser walk are where the catalogue meets a real history.
