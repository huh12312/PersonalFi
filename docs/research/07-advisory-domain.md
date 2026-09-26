# 07 — Advisory Domain Memo (Financial Planning / Advisory)

**Author:** Financial planning / advisory domain panelist
**Date:** 2026-09-10
**Audience:** Engineers implementing PersonalFi (self-hosted, MIT, single user)
**Status:** Design input — implementable spec. All formulas are normative unless marked "illustrative".

> **Compliance note up front:** PersonalFi is a *personal tool built by its user for himself*. It is not a
> registered investment adviser, and nothing it produces is personalized investment advice for compensation.
> Every recommendation surface must use educational, non-directive language ("consider", "you may want to
> look at") and must never say "buy X", "sell X", or "you should". See §7.

---

## 0. Scope and reading order

| § | Topic | Primary deliverable |
|---|---|---|
| 1 | Budgeting methodologies | One ledger model that expresses all five methods; default = **Envelope-lite** |
| 2 | Recurring / subscription detection | Normalization + cadence algorithm, pseudocode, eval plan, build-vs-Plaid |
| 3 | Insight catalog | 52 rules with trigger, data, message, $-impact formula, priority |
| 4 | Net worth & portfolio analytics | TWR/MWR, classification waterfall, lot accounting |
| 5 | Retirement & goal projection | Deterministic + Monte Carlo pseudocode, default assumptions with sources |
| 6 | Crypto | Valuation, per-wallet basis, MC treatment, staking |
| 7 | Guardrails & compliance | Language rules, audit trail schema, LLM grounding |
| 8 | Evaluation | Backtest harness, P/R targets, feedback loop |
| A | 2026 US parameter table | Hard numbers with citations, all in one config file |

**Money representation rule (applies everywhere):** all amounts are integer **minor units** (cents / satoshis /
wei-scaled) with an explicit ISO-4217 or asset code. Never float. Percentages are `Decimal`. Rounding is
banker's rounding at presentation only.

---

## 1. Budgeting methodologies

### 1.1 The five methods and what they actually are

| Method | What it really is | Ledger implication |
|---|---|---|
| Zero-based / envelope (YNAB) | Every dollar of *money you actually have* is assigned to a category; unspent money rolls forward | Needs `assigned`, `activity`, `available`, `carryover`, `ready_to_assign` |
| Category budgets with monthly targets (Rocket Money / Monarch) | Per-category monthly *target*, no rollover, compares actual vs target | Same table, `rollover_policy = RESET` |
| 50/30/20 | A *target generator + report*, not a ledger | Category attribute `class ∈ {NEED, WANT, SAVINGS}`, targets derived from income |
| Pay-period budgeting | Budget period ≠ calendar month | Generalize month → `budget_period` row |
| Sinking funds | A category with a *target amount by date* | Category goal type `TARGET_BY_DATE` |

**Key insight for the data model: these are not five systems. They are one envelope ledger plus three
orthogonal switches** — (a) period definition, (b) per-category rollover policy, (c) goal/target type.
Build the envelope ledger correctly and the other four fall out.

YNAB's four rules are: give every dollar a job, embrace your true expenses, roll with the punches, age your
money. ([YNAB][ynab-wiki])

### 1.2 Core envelope math (normative)

For budget period `p` and category `c`:

```
assigned(c, p)   = Σ budget_entry.amount WHERE category=c AND period=p        # user or auto-assign
activity(c, p)   = Σ txn.amount          WHERE category=c AND budget_date ∈ p # outflows negative
carryover(c, p)  = rollover_fn(available(c, p-1), c.rollover_policy)
available(c, p)  = carryover(c, p) + assigned(c, p) + activity(c, p)
```

`rollover_fn`:

```
ROLLOVER  (default for envelope):  prev >= 0 ? prev : 0     # negative handled by §1.3
RESET     (target-only mode):      0
ROLLOVER_ALLOW_NEGATIVE (advanced): prev                     # debt-like categories only
```

**Ready to Assign (RTA)** — the "to be budgeted" number. Do not compute it by summing income; that drifts.
Compute it from the balance-sheet identity:

```
RTA(p) = Σ_a balance(a)                       # a ∈ on-budget accounts; credit balances are negative
       − Σ_c available(c, p)                  # includes credit-card payment categories
       − Σ_{p' > p} Σ_c assigned(c, p')       # money pre-assigned to future periods
```

**Invariant to assert in tests (this is the single most valuable test in the budgeting module):**

```
Σ_c available(c, p) + RTA(p) + future_assignments == Σ_a balance(a)   for all p
```

If that identity breaks, a rollover or credit-card rule is wrong. Assert it after every mutation in dev.

### 1.3 Overspending: cash vs credit

This is where most clones get it wrong. The distinction is **which asset actually moved**.

**Cash overspending** (`available(c,p) < 0` and the spend hit a depository account):
- In-period: category shows red; real cash has already left the building.
- At period roll: `carryover = 0` and the deficit is **subtracted from next period's RTA**.
  ```
  cash_overspend(p) = Σ_c min(0, available(c,p))  restricted to cash-funded portion
  RTA(p+1) -= |cash_overspend(p)|
  ```

**Credit overspending** (spend hit a credit-card account, and the category didn't have the money):
- In-period: category shows *yellow*, not red. No cash left the account — you borrowed.
- The shortfall means the **Credit Card Payment category is under-funded**, i.e. you can't pay the statement
  in full without robbing another envelope.
- At period roll, it is also subtracted from next period's RTA (you now owe real money).
  YNAB distinguishes these two colors for exactly this reason. ([YNAB support][ynab-cc-overspend])

**Credit card payment category mechanics** (normative — implement as a ledger trigger):

```
on_categorized_spend(txn) where txn.account.type == CREDIT and txn.category == c:
    fundable = min(|txn.amount|, max(0, available(c, p)))
    available(c, p)            -= |txn.amount|          # always
    available(CCP[card], p)    += fundable              # only the funded part moves
    credit_overspend(c, p)     += |txn.amount| - fundable

on_card_payment(transfer checking -> card, amount X):
    available(CCP[card], p) -= X
    # balances move naturally via the transfer; no category activity

on_refund(txn to credit account, positive):
    available(c, p)         += txn.amount
    available(CCP[card], p) -= min(txn.amount, available(CCP[card], p))

on_interest_or_fee(card):
    treat as a normal categorized spend to "Interest & Fees" on that card  # keeps CCP math honest
```

`CCP[card]` is auto-created 1:1 with each on-budget credit account and is not user-deletable.

### 1.4 Period boundaries and pending transactions

Two dates, never one:

| Field | Meaning | Used for |
|---|---|---|
| `authorized_date` | when the user swiped | **`budget_date` default** |
| `posted_date` | when the bank settled | reconciliation, cleared balance |
| `budget_date` | user-overridable | all budget period assignment |

Rules:
1. A transaction belongs to the period containing `budget_date` (defaults to `authorized_date`,
   falls back to `posted_date` if the feed omits it).
2. `status ∈ {PENDING, POSTED, RECONCILED}`. **Pending transactions DO count in `activity`** — otherwise
   the envelope lies to you for 2–3 days, which is exactly when you'd overspend.
3. Account shows two balances: `cleared_balance` (POSTED+RECONCILED only) and `working_balance` (all).
   RTA uses `working_balance`.
4. Pending→posted merge must be idempotent. Key on the provider's pending linkage
   (e.g. Plaid `pending_transaction_id`); if absent, fuzzy-match on
   `(account, |amount| within 10% or exact, merchant_key, |date delta| ≤ 5d)` and mark the merge
   `auto_merged=true` so it can be undone.
5. A pending charge that never posts (dropped auth) must expire after 14 days → soft-delete with an
   undo affordance. Do not silently vanish money from a budget.
6. **Late-arriving transactions** for a closed period: re-run the period cascade from the affected period
   forward. Store `available` as a *computed, cached* value with a dirty-flag cascade, never as source of truth.

### 1.5 Age of Money and cash runway

YNAB's rule 4 is "age your money". Implement it precisely as a FIFO dollar ledger:

```
inflow_queue = deque of (date, remaining_amount) for every income inflow to on-budget accounts, ascending
for each cash outflow o (ascending date):
    need = |o.amount|
    while need > 0:
        head = inflow_queue[0]
        take = min(need, head.remaining)
        record_spent_dollar(age_days = o.date - head.date, amount = take)
        head.remaining -= take; need -= take
        if head.remaining == 0: inflow_queue.popleft()

AgeOfMoney = amount_weighted_median(age_days over spent dollars in the trailing 30 days)
```

Use the **weighted median**, not the mean — one big annual bill otherwise swings it 40 days.

**Recommended headline metric instead: Cash Runway.** It is more legible and less fragile:

```
CashRunway_days = liquid_buffer / avg_daily_outflow_90d
liquid_buffer   = Σ balances of (checking, savings, money market, cash) − Σ credit statement balances due ≤ 30d
```

Show Cash Runway on the dashboard; keep Age of Money as a secondary stat for envelope purists.

### 1.6 50/30/20 as a derived layer

```
take_home = trailing-3-month median of net income inflows (post-tax, post-401k)
target(NEED)    = 0.50 * take_home
target(WANT)    = 0.30 * take_home
target(SAVINGS) = 0.20 * take_home      # includes debt principal above minimums
actual(class)   = Σ |activity(c,p)| for c.class == class   (+ transfers to savings/investment for SAVINGS)
```

Present as a three-bar report with variance, plus a one-click "generate targets from 50/30/20" that
writes `category.target` rows. **Never** make it a separate ledger.

Important nuance to encode: 50/30/20 is defined on *take-home* pay, so pre-tax 401(k) deferrals are outside
the denominator. Offer a toggle `savings_rate_basis ∈ {TAKE_HOME, GROSS}` because the retirement engine (§5)
wants gross.

### 1.7 Pay-period budgeting

```
budget_period(id, kind, start_date, end_date, anchor_txn_id?)
kind ∈ {CALENDAR_MONTH, SEMIMONTHLY, BIWEEKLY, WEEKLY, CUSTOM}
```

Biweekly anchored to an actual payday means 26 periods/yr and two "3-paycheck months" — the engine must
handle periods that don't tile months. All budget math in §1.2 is already indexed by `period_id`, not month,
so this is free. Reports that need monthly comparability (category creep, §3) must aggregate by
`budget_date` month independently of the period grid.

### 1.8 Sinking funds and goals

```
goal_type ∈ {NONE, MONTHLY_TARGET, TARGET_BY_DATE, MINIMUM_BALANCE, PCT_OF_INCOME, REFILL_UP_TO}

needed_this_period(TARGET_BY_DATE) =
    max(0, (target_amount - available(c, p) - scheduled_inflows) / periods_remaining_inclusive)

underfunded(c, p) = max(0, needed_this_period(c,p) - assigned(c,p))
```

Surface `Σ_c underfunded` as "to stay on track this month, assign $X more". That single number is the
whole value proposition of envelope budgeting.

### 1.9 **Recommended default UX model: "Envelope-lite"**

**Default = zero-based envelope math (§1.2–1.3) with rollover ON, but auto-assigned from targets and
non-nagging.**

Rationale:
- The envelope ledger is a *superset*. You can render a target-only UI on top of it; you cannot render an
  envelope UI on top of a target-only ledger. Choose the expressive substrate.
- Pure YNAB has a real cost: manual monthly assignment. For a single technical user with connected accounts,
  that friction is the #1 abandonment cause.
- So: keep the math, automate the assignment.

Concretely, on period roll:

```
1. carryover all categories per policy
2. auto_assign: iterate categories by user-set priority, assign needed_this_period(c,p) from RTA
   until RTA == 0 or all funded
3. if RTA > 0: leave it positive and show "you have $X unassigned" as an *opportunity*, not an error
4. if RTA < 0: this is the one hard alert — "you've assigned $X more than you have"
5. never block the user; never require reaching zero
```

Provide a settings switch `budget_mode ∈ {ENVELOPE, ENVELOPE_LITE, TARGETS_ONLY, OFF}` that changes
*presentation and auto-assign aggressiveness only* — the underlying ledger is identical in all four.
`TARGETS_ONLY` = set all categories `rollover_policy = RESET` + hide RTA. `OFF` = hide the budget tab, keep
categorization (many people want tracking + insights without budgeting; §3 rules must all degrade gracefully
when no budget exists).

### 1.10 Unified data model (sketch)

```sql
account(id, name, type, subtype, currency, institution_id, on_budget BOOL, in_net_worth BOOL,
        closed_at, provider, provider_account_id)
budget_period(id, kind, start_date, end_date)
category_group(id, name, sort)
category(id, group_id, name, class ENUM(NEED,WANT,SAVINGS), rollover_policy, goal_type,
         goal_amount, goal_target_date, priority INT, hidden, credit_card_account_id NULL)
budget_entry(period_id, category_id, assigned_minor, source ENUM(USER,AUTO,ROLLOVER_FIX), UNIQUE(period_id,category_id))
transaction(id, account_id, amount_minor, currency, authorized_date, posted_date, budget_date,
            status, payee_id, merchant_key, category_id, transfer_peer_id, recurring_stream_id,
            provider_txn_id, pending_provider_id, notes, cleared)
category_period_cache(period_id, category_id, carryover, assigned, activity, available, dirty)
```

`category_period_cache` is derived. Recompute on dirty cascade; never trust it in a migration.

---

## 2. Recurring / subscription detection

### 2.1 Merchant name normalization

Raw descriptors are hostile. Pipeline (order matters, each step is independently unit-testable):

```
def normalize(raw: str) -> MerchantKey:
    s = unicodedata.normalize('NFKD', raw).encode('ascii','ignore').decode()
    s = s.upper()
    s = re.sub(r'\s+', ' ', s).strip()

    # 1. bank-added wrappers
    s = re.sub(r'^(PURCHASE|POS|DEBIT|CREDIT|CHECKCARD|VISA|MASTERCARD|RECURRING)\s+'
               r'(AUTHORIZED\s+ON\s+\d{2}/\d{2}\s+)?', '', s)
    s = re.sub(r'^(ACH\s+(DEBIT|CREDIT)|ELECTRONIC\s+(WITHDRAWAL|DEPOSIT))\s*[-:]?\s*', '', s)

    # 2. payment-facilitator prefixes  (the big one)
    #    SQ *  TST*  SP  PY *  IN *  WPY*  EB *  DD *  LS  CKE*  PP*  PAYPAL *  GOOGLE *  APLPAY
    s = re.sub(r'^(SQ|TST|SP|PY|IN|WPY|EB|DD|LS|CKE|PP|PAYPAL|GOOGLE|APLPAY|MSFT|AMZN|AMAZON)\s*[\*#]\s*', '', s)
    s = re.sub(r'^(AMZN MKTP(\s+[A-Z]{2})?|AMAZON\.COM|AMAZON MKTPL?A?C?E?)\s*[\*#]?\s*', 'AMAZON ', s)

    # 3. trailing order/store/txn ids
    s = re.sub(r'\b[A-Z0-9]{6,}\b(?=\s*$)', '', s)        # AMZN order ids like 2K4LM9XY3
    s = re.sub(r'#\s*\d{2,}', '', s)                      # store numbers  #01234
    s = re.sub(r'\b\d{4,}\b', '', s)                      # bare long digit runs
    s = re.sub(r'\b\d{3}-\d{3}-\d{4}\b', '', s)           # phone numbers
    s = re.sub(r'\b(WWW\.|HTTPS?://)\S+', '', s)
    s = re.sub(r'\.(COM|NET|ORG|CO|IO|APP)\b', '', s)

    # 4. trailing geography  "... SEATTLE WA" / "... 800-555-1212 CA"
    s = re.sub(r'\s+[A-Z][A-Z\s]{2,20}\s+(' + US_STATES + r')\s*$', '', s)
    s = re.sub(r'\s+(' + US_STATES + r')\s*$', '', s)

    # 5. residual punctuation
    s = re.sub(r'[^A-Z0-9& ]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()

    # 6. alias resolution (seeded table + learned)
    return ALIAS.get(s) or ALIAS.fuzzy(s, threshold=0.90) or slug(s)
```

**Provider shortcut:** when the aggregator supplies a clean merchant (Plaid `merchant_name` /
`counterparties[0].name`), prefer it and use `normalize()` only as the fallback and as a
cross-check. Plaid's enrichment is genuinely better than regex on long-tail merchants.

**Alias table** ships seeded (~800 common subscription merchants) as MIT data in the repo, and learns:
whenever the user renames a payee, write `raw_pattern → merchant_key` with `source=USER`, which always wins.

**Test fixtures** (put these in the unit test verbatim):

| Raw | Expected key |
|---|---|
| `SQ *BLUE BOTTLE COFFEE OAKLAND CA` | `BLUE BOTTLE COFFEE` |
| `TST* TARTINE BAKERY - SAN FRANC` | `TARTINE BAKERY` |
| `AMZN Mktp US*2K4LM9XY3` | `AMAZON` |
| `PURCHASE AUTHORIZED ON 09/03 NETFLIX.COM 866-579-7172 CA` | `NETFLIX` |
| `PAYPAL *SPOTIFYUSA 4029357733` | `SPOTIFY USA` → alias → `SPOTIFY` |
| `COMCAST CALIFORNIA #8155 800-COMCAST` | `COMCAST` |

### 2.2 Grouping

Two-stage, because merchant identity alone over-groups (Amazon) and under-groups (card reissue).

```
Stage 1 (coarse): group by (merchant_key, sign(amount))
Stage 2 (fine):   within each coarse group, cluster into streams by (cadence, amount-band)
```

Stage 2 clustering (a single merchant can host several streams — e.g. Apple: iCloud $2.99/mo +
Apple TV+ $12.99/mo + one-off app purchases):

```
1. Bucket by amount: sort amounts; split where gap > max($2, 25% of lower value).
2. For each amount bucket with n >= 2 dates, run cadence inference (§2.3).
3. Merge buckets whose inferred cadence matches AND whose amount medians differ by < 3%
   (handles a price change mid-stream, which otherwise splits a stream in two).
4. Leftover singletons -> ONE_OFF.
```

**Cross-account stream continuity** (card reissued / moved to a new bank): if stream A on account X goes
dormant and stream B on account Y starts within 2 periods, same `merchant_key`, amount within 5% →
propose merge with `link_reason=CARD_MIGRATION`, `confidence *= 0.9`. Do this *before* declaring a
cancellation, or you'll fire a false "you cancelled Netflix" insight every time a card is replaced.

### 2.3 Cadence inference

Do **not** use naive `round(mean_gap / 30)`. Calendar arithmetic matters.

```
CADENCES = [
  (WEEKLY,       step=+7d,          tol_days=2,  min_n=3),
  (BIWEEKLY,     step=+14d,         tol_days=3,  min_n=3),
  (SEMIMONTHLY,  step=dom-pair,     tol_days=3,  min_n=3),   # e.g. 1st & 15th
  (MONTHLY,      step=+1 month,     tol_days=4,  min_n=2),
  (BIMONTHLY,    step=+2 months,    tol_days=5,  min_n=3),
  (QUARTERLY,    step=+3 months,    tol_days=7,  min_n=2),
  (SEMIANNUAL,   step=+6 months,    tol_days=10, min_n=2),
  (ANNUAL,       step=+12 months,   tol_days=15, min_n=2),
]
```

Month steps use `add_months()` with **end-of-month clamping** (Jan 31 → Feb 28) and **business-day shift**
(many billers post on the next business day, so an expected Saturday hit lands Monday; expand tolerance
asymmetrically +2 days when the expected date is Sat/Sun).

```
def score_cadence(dates, cadence):
    best = -inf
    for anchor in dates[:min(3, len(dates))]:          # try first few as anchors; robust to a late start
        predicted = generate_schedule(anchor, cadence, until=dates[-1] + cadence.step)
        matched, residuals = greedy_match(dates, predicted, cadence.tol_days)
        expected_n = len(predicted)
        coverage   = len(matched) / max(1, expected_n)          # penalizes skipped periods
        extras     = (len(dates) - len(matched)) / len(dates)   # penalizes unexplained hits
        tightness  = 1 - mean(abs(r) for r in residuals) / cadence.tol_days
        s = 0.5*coverage + 0.3*tightness - 0.4*extras
        best = max(best, s)
    return best

def infer_cadence(dates):
    if len(dates) < 2: return (UNKNOWN, 0.0)
    scored = [(c, score_cadence(dates, c)) for c in CADENCES if len(dates) >= c.min_n]
    cad, s = max(scored, key=lambda t: t[1])
    # prefer the LONGEST cadence among near-ties: 3 monthly hits also "fit" as sparse weekly
    ties = [c for c, sc in scored if sc >= s - 0.05]
    return (max(ties, key=lambda c: c.step_days), s)
```

Amount model per stream:

```
cv = stdev(amounts) / mean(amounts)
if cv <= 0.03 or max-min <= $0.50:   amount_type = FIXED
elif cv <= 0.35:                     amount_type = VARIABLE        # utilities, phone w/ overages
else:                                amount_type = IRREGULAR       # not a subscription
```

Stream typing (this distinction drives the whole insight catalog):

| Type | Cadence score | Amount type | Example |
|---|---|---|---|
| `SUBSCRIPTION` | ≥ 0.75 | FIXED | Netflix $17.99/mo |
| `RECURRING_BILL` | ≥ 0.70 | VARIABLE | PG&E, water, phone |
| `RECURRING_INCOME` | ≥ 0.70 | any, inflow | paycheck, dividends |
| `FREQUENT_MERCHANT` | < 0.70 | any | coffee shop 3×/week — **never** call this a subscription |
| `ONE_OFF` | n/a | n/a | everything else |

### 2.4 Confidence score

Start with a hand-weighted score, then replace with a logistic model calibrated on the labeled set (§2.9).

```
x1 = cadence_score                                 # 0..1 from §2.3
x2 = amount_stability = clamp(1 - cv/0.35, 0, 1)
x3 = maturity = min(1, (n_occurrences - 1) / 4)    # 5 hits => 1.0
x4 = merchant_prior                                # 1.0 known subscription merchant, 0.5 unknown, 0.1 known-retail
x5 = recency = clamp(1 - days_since_last / (2*period_days), 0, 1)
x6 = coverage_completeness                         # matched/expected periods

confidence = sigmoid(-2.2 + 2.0*x1 + 1.4*x2 + 1.1*x3 + 0.9*x4 + 0.8*x5 + 0.7*x6)
```

Thresholds: `>= 0.80` auto-confirm and show; `0.55–0.80` show as "is this a subscription?" with one-tap
confirm/reject; `< 0.55` keep internally, never surface. Rejections write a permanent
`merchant_key → NOT_RECURRING` override.

**Early detection (n = 2):** mirror Plaid's concept — mark `status = EARLY_DETECTION`, cap
`confidence` at 0.70, and never use it to drive a $-impact insight. Plaid defines a *matured* stream as
having at least 3 occurrences and exposes `early_detection` in the status field for younger ones.
([Plaid][plaid-blog])

### 2.5 Next-due prediction

```
next_date_raw = add_cadence(last_date, cadence)
next_date     = shift_to_business_day(next_date_raw)   if merchant posts on business days
uncertainty   = ceil(1.5 * MAD(residuals)) clamped to [1, cadence.tol_days]

expected_amount:
  FIXED     -> last_amount
  VARIABLE  -> seasonal_median:
               base = median(last 3 amounts)
               if >= 13 months history:
                   base *= amount(same month last year) / median(amounts last year)   # utility seasonality
```

Feed `(next_date, expected_amount, uncertainty)` into the cash-flow forecast used by overdraft-risk (C3)
and upcoming-bill (C7) insights. Forecast uncertainty must propagate — show a band, not a point.

### 2.6 Price-increase detection

```
baseline = median(previous min(3, n-1) amounts)
delta    = latest - baseline
if stream.amount_type == FIXED and delta > max($1.00, 0.03 * baseline):
    emit PRICE_INCREASE(
        stream, old=baseline, new=latest,
        annual_impact = delta * periods_per_year(cadence)
    )
    stream.price_history.append((effective_date=latest.date, amount=latest))
```

Guard: require the *next* occurrence to confirm before raising it to P1, unless `delta/baseline > 0.15`
(a one-time proration or a tax change can look like a hike). Also detect the reverse (`PRICE_DECREASE`) and
sales-tax-only deltas (delta < 12% and the merchant is in a taxed-services list → suppress).

### 2.7 Free-trial → paid detection

Signals, any of which opens a `TRIAL_WATCH`:

```
a) first charge in {$0.00, $0.01, $1.00}  (card-verification auth) from a subscription-class merchant
b) first charge < 40% of the merchant's known standard price (seeded price table)
c) user-tagged "started trial"
d) a $0/$1 auth followed by no charge for 7/14/30 days (the classic trial lengths)

predicted_first_full_charge = auth_date + argmin_{L ∈ {7,14,30,90}} |plan_hint - L|
emit TRIAL_CONVERTING when now >= predicted_charge - 3 days
annual_impact = standard_price * periods_per_year
```

This rule has outsized value-per-byte: it is the only insight that can save money *before* it is spent.

### 2.8 Dormancy / cancellation detection

```
grace(stream) = max(5 days, 0.25 * cadence.period_days)

if now > next_due + uncertainty + grace:
    if cross_account_candidate_exists(): status = MIGRATED         # §2.2 step
    else:                                status = AT_RISK
if missed_periods >= 2:                  status = LIKELY_CANCELED
if missed_periods >= 3 or now > last + 400d (annual): status = CANCELED  # archive, stop forecasting
```

Never emit "you cancelled X" — emit "we haven't seen a charge from X since <date>; still active?" Dormancy
is *information*, and it matters for two real cases: (1) the annual renewal you forgot about is coming back
in 11 months and belongs in a sinking fund; (2) a bill that silently failed (expired card) and is about to
become a late fee.

### 2.9 Duplicate-service detection

```
SERVICE_TAXONOMY: merchant_key -> node in a tree
  media/music        : SPOTIFY, APPLE MUSIC, YOUTUBE MUSIC, TIDAL, AMAZON MUSIC, PANDORA
  media/video        : NETFLIX, HULU, MAX, DISNEY PLUS, PARAMOUNT PLUS, PEACOCK, APPLE TV
  cloud/storage      : DROPBOX, GOOGLE ONE, ICLOUD, ONEDRIVE, BACKBLAZE
  security/vpn       : NORDVPN, EXPRESSVPN, MULLVAD, PROTON
  productivity/ai    : OPENAI, ANTHROPIC, GITHUB COPILOT, PERPLEXITY
  fitness            : PELOTON, CLASSPASS, <gym chains>
  news               : NYT, WSJ, WAPO, ECONOMIST

if count(active streams in node) >= 2:
    emit DUPLICATE_SERVICE(node, streams, annual_impact = sum of all but the cheapest)
```

Two refinements that prevent annoying false positives: (a) bundles — if one stream's price matches a known
bundle SKU (Disney+/Hulu/ESPN), suppress; (b) household — if the user marks a stream "for someone else",
suppress permanently. Also detect **same-service duplicates** (two Spotify charges = a forgotten second
account), which is a strictly-better finding than cross-service.

### 2.10 "Unused subscription" — be honest

We have **no usage telemetry**. Do not claim to detect unused subscriptions from transactions alone.
What we can legitimately do:

1. **Corroborating-signal heuristics**, each weak, combined: gym membership with zero other fitness-adjacent
   spend and no location signal; a streaming service alongside 5 others; a service whose price rose while
   the account has had no other interaction.
2. **Ask.** Once a quarter, a 20-second card: "You're paying $X/yr across N subscriptions. Tap the ones you
   haven't used in 30 days." That is the single highest-yield UX in the whole app and it costs no ML.
3. Label the rule output `source = USER_DECLARED` vs `HEURISTIC`, and only USER_DECLARED gets a
   confident message.

### 2.11 Build vs Plaid: **hybrid — own the detector, use Plaid as a feature + second opinion**

Plaid's Recurring Transactions is an optional add-on to Transactions (US/CA/UK) that groups transactions by
description, amount, and cadence into inflow/outflow streams with frequency, average amount, predicted next
date, category, merchant, and a status field including `early_detection`; it wants ≥180 days of history and
treats ≥3 occurrences as *matured*. ([Plaid][plaid-blog], [Plaid docs][plaid-txn-docs])

**Recommendation: build our own as the canonical engine; ingest Plaid streams as an ensemble input.**

| Reason | Detail |
|---|---|
| Coverage | Plaid can't see manual accounts, CSV imports, crypto exchanges, or a self-hosted user's cash. Our detector must run over *all* sources anyway — so it exists regardless. |
| Cost & lock-in | Recurring Transactions is a paid add-on billed per Item. For a one-user MIT app, a hard dependency is wrong. |
| Missing features | Plaid does not give us price-increase history, duplicate-service detection, free-trial conversion, or sinking-fund linkage. Those are the insights with actual dollar value. |
| Portability | Users may run on SimpleFIN, GoCardless, or pure CSV. The detector must be provider-agnostic. |
| But Plaid is genuinely good at | merchant normalization and long-tail merchant identity. Use `merchant_name` / `counterparties` as a *free, high-quality feature* into our grouping. |

Ensemble policy:

```
ours.confidence >= 0.80 AND plaid agrees      -> AUTO_CONFIRM (confidence 0.95)
ours >= 0.80, plaid silent                    -> SHOW, confidence unchanged
ours < 0.55, plaid has a matured stream       -> SHOW AS SUGGESTION (this is the recall win)
both disagree on cadence                      -> prefer the longer cadence, flag for the eval set
```

Architecture: `RecurringProvider` interface with `LocalDetector` (always on) and `PlaidStreams`
(optional adapter). Merge into one `recurring_stream` table with a `sources[]` array for audit.

### 2.12 Evaluation metrics and labeled test set

**Stream matching rule** (for computing P/R): predicted stream `P` matches gold stream `G` iff
`merchant_key` matches (after alias resolution) **and** `Jaccard(txn_ids(P), txn_ids(G)) ≥ 0.5`.

| Metric | Definition | Target |
|---|---|---|
| Stream precision | matched / predicted | **≥ 0.95** — a false subscription destroys trust instantly |
| Stream recall | matched / gold | ≥ 0.85 |
| Cadence accuracy | exact cadence match among matched streams | ≥ 0.92 |
| Next-due MAE | mean abs error in days | ≤ 2.0 (monthly), ≤ 5.0 (annual) |
| Amount MAPE | FIXED streams | ≤ 1% |
| Price-change P/R | vs hand-labeled hikes | P ≥ 0.90, R ≥ 0.85 |
| Cancellation lead time | days from true last charge to `LIKELY_CANCELED` | ≤ 1.5 periods |
| Trial-conversion recall | caught before first full charge | ≥ 0.80 |

Precision is weighted far above recall. Set the operating point on the P-R curve at the highest recall
where precision ≥ 0.95.

**Labeled test set, three tiers:**

1. **Real (gold, ~24 months of Chris's own history).** Export to `tests/fixtures/gold_streams.jsonl`:
   `{stream_id, merchant_key, cadence, amount_type, txn_ids[], status, price_changes[], label_source}`.
   Hand-label once in a small local CLI; ~2 hours of work, permanent value. Redact/hash where the fixture
   is committed (it's a public MIT repo — commit a *synthetic-ized* version with amounts jittered ±7% and
   merchant names from a public list, keep the real one gitignored).
2. **Synthetic generator** (`tests/synth/streams.py`), 5,000 streams with injected reality:
   weekend/holiday shifts, one skipped period (failed payment + retry 3 days later), mid-stream price hikes,
   merchant descriptor changes, card migrations, proration on plan change, annual→monthly switches,
   refunds, duplicate charges, and 30% pure-noise merchants that must NOT be detected.
3. **Adversarial set:** the things that look recurring but aren't — biweekly paycheck-adjacent coffee habits,
   rent split via Venmo (same amount, monthly, but a transfer), mortgage/auto-pay (recurring but should be
   typed `LOAN_PAYMENT`, not `SUBSCRIPTION`), and quarterly estimated tax payments.

Run the harness in CI with a regression gate: precision may not drop below the previous release.

---

## 3. Insight / recommendation catalog

### 3.1 Rule contract

Every rule implements:

```python
@dataclass
class Insight:
    rule_id: str                 # "C1_IDLE_CASH"
    rule_version: int
    severity: Literal["P0","P1","P2","P3"]
    title: str
    body: str                    # rendered template, no invented numbers
    annual_impact_minor: int     # $ per year, see §3.2; 0 if non-monetary
    one_time_impact_minor: int
    confidence: float            # 0..1
    evidence: list[EntityRef]    # txn/holding/account ids that triggered it — REQUIRED, non-empty
    inputs_snapshot: dict        # every number used, for audit and for "why am I seeing this?"
    suggested_actions: list[Action]
    computed_at: datetime
    expires_at: datetime
```

`evidence` being non-empty is enforced at the type level. **An insight that cannot show its work is a bug.**

### 3.2 Ranking and "$ impact"

```
rank_score = annualized_impact_usd
           * confidence
           * actionability            # 1.0 one-click, 0.7 do-it-yourself, 0.4 informational
           * urgency_multiplier       # 2.0 if a deadline < 14d, 1.0 otherwise
           * (1 - 0.5 * dismiss_rate(rule_id))   # learned suppression, §8.3
```

Conventions so the numbers are comparable:
- **Annualize everything.** A one-time $600 saving is shown as `$600 one-time`, but ranks at
  `one_time * 0.5` against recurring items (a recurring dollar is worth more than a one-time dollar).
- **Post-tax where it matters.** Interest saved on debt is post-tax. Extra 401(k) contribution shows both
  "tax saved this year" and "projected value at retirement" — rank on tax saved (certain), display the other.
- **Never compound speculative returns into the headline number.** "Move $20k to a HYSA" is worth the APY
  *spread*, not the APY.
- Cap any single insight's displayed impact at a sanity ceiling and log outliers — a data bug that claims
  "$1.4M savings available" is the fastest way to lose all credibility.

### 3.3 The catalog (52 rules)

Symbols: `EF` = emergency fund target, `NW` = net worth, `MTR` = marginal tax rate, `T` = user threshold.

#### Spending

| ID | Trigger | Data needed | Message template | Action | Impact ($/yr) | Pri |
|---|---|---|---|---|---|---|
| S1 | Single txn > μ + 3σ of category's trailing-12mo txn distribution, and > $100 | txns, category stats | "Your {cat} charge at {merchant} on {date} was ${amt} — about {n}× your typical {cat} charge." | Recategorize / split / confirm | `amt − median` (informational) | P2 |
| S2 | Category creep: trailing-3mo avg > trailing-12mo avg × 1.25, ≥3 months running, delta > $50/mo | monthly category aggregates | "{cat} has run ${new}/mo for 3 months vs ${old}/mo before — up ${d}/mo." | Adjust budget target | `d × 12` | P2 |
| S3 | > 10 txns or > $500 uncategorized older than 7 days | txns | "{n} transactions (${amt}) aren't categorized — your budget and insights are incomplete." | Bulk categorize | 0 (enabler) | P1 |
| S4 | MTD spend pace projects > 110% of `assigned(c,p)` with >7 days left | budget, txns | "At this pace {cat} will finish ${over} over its ${target} budget." | Move money / adjust | `over` | P1 |
| S5 | New merchant (never seen) charge > $250 | txns, merchant history | "First-time charge: ${amt} at {merchant}." | Confirm / dispute | fraud-avoidance | P1 |
| S6 | Same `(account, merchant_key, amount)` within 72h, amount > $10 | txns | "Possible duplicate charge: ${amt} at {merchant} on {d1} and {d2}." | Review / dispute | `amt` one-time | **P0** |
| S7 | Any txn matching fee taxonomy (overdraft, NSF, ATM, foreign-txn, late, maintenance) | txns, MCC/category | "You paid ${amt} in {fee_type} fees in the last 12 months." | Switch account / set autopay | `sum(fees_12mo)` | P1 |
| S8 | Dining+delivery > 15% of take-home for 2 consecutive months | txns, income | "Dining and delivery were {pct}% of take-home (${amt}) last month." | Set a target | `(amt − target) × 12` | P3 |
| S9 | Calendar month outflows > inflows (excl. transfers & investments) | txns | "You spent ${d} more than you earned in {month}." | Review largest categories | `d × 12` if recurring | P1 |
| S10 | Sum of annual/semiannual bills due in next 90d > 1.5× monthly discretionary | recurring streams | "${amt} of annual bills land in {months}: {list}." | Create sinking fund | avoids debt/fees | P1 |

#### Subscriptions

| ID | Trigger | Data needed | Message template | Action | Impact ($/yr) | Pri |
|---|---|---|---|---|---|---|
| U1 | Stream flagged unused (USER_DECLARED preferred) | streams, user survey | "You marked {svc} as unused — it costs ${amt}/{period} (${annual}/yr)." | Cancel guide + link | `amount × periods_per_year` | **P0** |
| U2 | §2.6 price increase confirmed | stream price history | "{svc} went from ${old} to ${new} on {date} — ${d_annual}/yr more." | Review / downgrade / cancel | `Δ × periods_per_year` | P1 |
| U3 | §2.9 ≥2 active streams in a taxonomy node | streams, taxonomy | "You have {n} {node} services: {list}. Keeping just {cheapest} saves ${s}/yr." | Compare / cancel | `Σ(all) − min` | P1 |
| U4 | Merchant has a known annual plan cheaper than 12× monthly | streams, price table | "{svc} annual is ${a}/yr vs ${m}×12 = ${t} — saves ${s}/yr." | Switch plan | `12×monthly − annual` | P1 |
| U5 | §2.7 trial converting within 3 days | trial watch | "Your {svc} trial converts {date} at ${amt}." | Cancel or keep (snooze) | `amt × periods_per_year` | **P0** |
| U6 | User marked "cancelling" but a charge appears > 7d later | streams, user flags | "You marked {svc} cancelled but were charged ${amt} on {date}." | Dispute / re-cancel | `amt × ppy` | **P0** |
| U7 | Σ subscription annual > 10% of take-home | streams, income | "Subscriptions total ${annual}/yr — {pct}% of take-home." | Review all | informational | P2 |
| U8 | Subscription charged to a card carrying a revolving balance | streams, card APR & balance | "{n} subscriptions (${amt}/mo) go on {card}, which carries {apr}% APR." | Move to debit/paid card | `amt × 12 × apr` | P1 |

#### Cash management

| ID | Trigger | Data needed | Message template | Action | Impact ($/yr) | Pri |
|---|---|---|---|---|---|---|
| C1 | `liquid_cash − EF_target − known_90d_obligations > $5,000` for 30 consecutive days | balances, EF setting, forecast | "About ${x} above your ${ef} emergency fund has sat in {acct} at {apy}%. A {mkt}% account or T-bills would earn ~${g}/yr more." | Compare options (educational, no product rec) | `x × (mkt_apy − current_apy)` | **P0** |
| C2 | Savings account APY < market top decile − 1.5pp, balance > $2,500 | balances, APY (user-entered or est.) | "{acct} earns {apy}% on ${bal}; ~{mkt}% is available." | Educational comparison | `bal × spread` | P1 |
| C3 | Forecast min projected balance < $0 within 14 days | balances, recurring streams, scheduled txns | "{acct} is projected to hit ${min} on {date} before your next deposit." | Move money / delay bill | `overdraft_fee × expected_count` | **P0** |
| C4 | `liquid_cash < EF_target` | balances, 12mo essential spend | "Your emergency fund covers {m} months; target is {t}." | Set sinking fund | risk-reduction | P1 |
| C5 | Per-card or aggregate utilization > 30% (and a softer nudge > 10%) on statement date | balances, limits | "{card} reported {u}% utilization. Under 30% — ideally under 10% — generally scores better." | Pay before statement date | score impact (non-$) | P1 |
| C6 | Carrying a revolving balance while `liquid_cash > EF_target` | balances, APR | "You're paying {apr}% on ${bal} while holding ${x} above your emergency fund. Paying ${p} saves ${s}/yr, guaranteed." | Payoff plan | `min(bal, excess) × apr` | **P0** |
| C7 | Forecasted bill > 40% of current balance due in ≤10 days | streams, balances | "${amt} to {merchant} is due {date}; {acct} holds ${bal}." | Transfer | avoids C3 | P1 |
| C8 | Brokerage sweep/cash > $1,000 earning < money-market yield − 1pp | holdings | "${x} is sitting in {broker}'s cash sweep at {apy}%." | Review sweep options | `x × spread` | P1 |
| C9 | Deposits at one institution > FDIC $250k (or brokerage cash > SIPC $250k) | balances, institution | "${x} at {inst} exceeds the ${limit} insurance limit by ${over}." | Split institutions | risk (non-$) | P1 |

#### Debt

| ID | Trigger | Data needed | Message template | Action | Impact ($) | Pri |
|---|---|---|---|---|---|---|
| D1 | ≥2 debts with balances | balances, APRs, minimums | "Avalanche pays off in {m_a} months for ${i_a} interest; snowball takes {m_s} for ${i_s}. Avalanche saves ${d}." | Generate plan | `i_snowball − i_avalanche` | **P0** |
| D2 | Any APR > 12% (cards) or > current market + 1.5pp (installment/mortgage) | APRs, balances, market rates | "{acct} is at {apr}%. Current typical rates are around {mkt}%." | Educational: refi/transfer math incl. fees | `bal × (apr − mkt) − fees` | P1 |
| D3 | Minimum-only payments detected for 3+ months | txn history, APR, balance | "Paying the minimum on {card}, this balance takes {years} years and ${int} interest." | Set higher autopay | `interest_min − interest_at_target` | **P0** |
| D4 | 0% promo APR expiring within 90 days with balance remaining | user-entered promo terms | "{card}'s 0% promo ends {date} with ${bal} left; the rate becomes {apr}%." | Payoff-by-date plan | `bal × apr` | **P0** |
| D5 | Extra cash available AND (mortgage/student APR vs expected portfolio return) | APRs, assumptions | "Extra principal on {loan} is a guaranteed {apr}% after-tax; expected portfolio return is {r}% with risk." | Show both paths | `|apr − r_after_tax| × amt` | P2 |
| D6 | A recurring bill missed its window or no autopay pattern detected on a debt account | streams | "No payment seen for {acct} since {date}; due {due}." | Set autopay | `late_fee + score impact` | **P0** |

#### Investing

| ID | Trigger | Data needed | Message template | Action | Impact ($/yr) | Pri |
|---|---|---|---|---|---|---|
| I1 | `|actual_weight − target_weight| > 5pp` for any asset class | holdings, classification, target | "{class} is {a}% vs your {t}% target ({d}pp drift)." | Rebalance plan (prefer new $ / tax-advantaged accts) | risk-adjusted, show `Δσ` not $ | P1 |
| I2 | Any position's expense ratio > 0.50% (or > 0.20% over a comparable index fund) | holdings, ER data | "{fund} charges {er}% — ${cost}/yr on ${val}. Comparable index funds charge ~{alt}%." | Show alternatives (educational) | `val × (er − alt)` | **P0** |
| I3 | Brokerage cash > max($1,000, 2% of account) for > 14 days and not earmarked | holdings | "${x} has been uninvested in {acct} for {d} days." | Invest per target / move to MMF | `x × (expected_return − sweep_apy)` | P1 |
| I4 | Any single security > 20% of investable assets | holdings | "{ticker} is {p}% of your portfolio (${val})." | Diversification education + tax cost of trimming | `val × p × idiosyncratic_vol` (risk) | **P0** |
| I5 | Employer stock (incl. ESPP/RSU) > 10% of investable assets | holdings, employer tag | "{ticker} is {p}% of your portfolio and also your paycheck — both depend on one company." | Show NUA / 10b5-1 / diversification education | risk | **P0** |
| I6 | Taxable lot with unrealized loss > max($500, 2% of position) | lots, prices | "{ticker} lot from {date} is down ${loss}; harvesting could offset ${offset} of gains." | TLH candidate list + replacement-fund caution | `min(loss, gains + 3000) × MTR` | **P0** |
| I7 | A purchase of the same/substantially identical security within 30 days before/after a loss sale | txns, lots, all accounts incl. IRAs | "Buying {ticker} on {date} may wash the ${loss} loss from {sale_date} (61-day window)." | Explain; suggest waiting | `loss × MTR` at risk | **P0** |
| I8 | YTD 401(k) deferral pace < employer match threshold | payroll/contribution txns, plan terms | "At this pace you'll defer ${a}; the full match needs ${b} — leaving ${m} of employer money." | Adjust deferral % | `unmatched_employer_$` | **P0** |
| I9 | IRA contribution < limit with days left in contribution window and MAGI permits | contributions, income | "You've put ${a} of the ${lim} 2026 IRA limit in; the deadline is Apr 15, 2027." | Contribute | `unused × MTR` (trad) or future tax-free growth (Roth) | P1 |
| I10 | HDHP enrolled, HSA contribution < limit | HSA account, plan flag | "${x} of 2026 HSA space is unused — the only triple-tax-advantaged account." | Contribute | `x × (MTR + FICA if payroll)` | **P0** |
| I11 | MAGI above Roth phase-out AND no traditional IRA pre-tax balance | income, IRA balances | "Direct Roth contributions phase out at your income; a backdoor contribution is a common approach (pro-rata rule applies)." | Educational | `limit × future_tax_saved` | P2 |
| I12 | Bonds/REITs/high-dividend held in taxable while tax-advantaged space holds equities | holdings by account type | "Your bond funds sit in taxable while your IRA holds equities — asset location is reversed." | Swap locations | `bond_val × yield × MTR` | P1 |
| I13 | Two holdings with > 80% estimated holdings overlap | classification/look-through | "{a} and {b} overlap ~{p}% — you may be paying two fees for one exposure." | Consolidate | `dup_val × Δer` | P2 |
| I14 | Taxable fund with high distribution yield / capital-gain distributions | holdings, distributions | "{fund} distributed ${d} last year in taxable — ~${tax} of tax drag." | ETF alternatives (educational) | `d × MTR` | P2 |
| I15 | After-tax 401(k) / mega-backdoor space available and plan allows | plan terms (user-entered) | "Your plan allows after-tax contributions with in-plan conversion; ${x} of space remains." | Educational | future tax-free growth | P3 |
| I16 | Rebalance needed AND new contributions ≥ 50% of the required trade | holdings, cash flows | "You can correct {d}pp of drift with your next ${c} of contributions — no taxable sale needed." | Direct contributions | `avoided_gain × MTR` | P1 |
| I17 | Taxable account cost-basis method ≠ specific-ID | account settings | "{broker} defaults to {method}; specific-ID gives you control over which lots you sell." | Change setting | option value ≈ `unreal_gain_spread × MTR` | P2 |
| I18 | A lot with a gain crosses from short- to long-term within 30 days | lots | "{ticker}'s lot from {date} becomes long-term on {ltdate} — a ${d} difference in tax on today's gain." | Wait | `gain × (STCG_rate − LTCG_rate)` | P1 |

#### Retirement & goals

| ID | Trigger | Data needed | Message template | Action | Impact | Pri |
|---|---|---|---|---|---|---|
| R1 | Savings rate < target for the plan | income, contributions, plan | "You're saving {a}% of gross; {t}% keeps this plan on track." | What-if slider | `Δ% × income` | **P0** |
| R2 | Monte Carlo success < 80% | projection engine | "This plan succeeds in {p}% of {n} simulations. Retiring {k} years later or saving {d}% more raises it to {p2}%." | What-if | Δ success pp | **P0** |
| R3 | Age within 10 years of RMD age, with large tax-deferred balance | balances, DOB | "RMDs start at {age} ({year}). Your projected first RMD is ~${amt}; the years before then are the widest Roth-conversion window." | Model conversions | `tax_bracket_arbitrage × converted` | P1 |
| R4 | Age ≥ 55, no claiming strategy set | DOB, earnings history | "Claiming at 70 instead of 62 raises your monthly benefit from ${a} to ${b} (inflation-adjusted)." | Compare ages | `PV(70) − PV(62)` | P1 |
| R5 | YTD deferral pace will hit the 402(g) limit before December at an employer without true-up | payroll cadence, plan | "You'll hit the ${lim} limit in {month}; without a true-up you'd miss ${m} of match in the remaining months." | Spread deferrals | `missed_match` | **P0** |
| R6 | Any goal's funded ratio < required-by-date pace | goals, balances | "{goal} needs ${m}/mo to reach ${target} by {date}; you're contributing ${c}." | Adjust | `shortfall` | P1 |
| R7 | (Decumulation) withdrawal rate outside guardrails | portfolio, spend | "Your withdrawal rate is {w}% vs the {lo}–{hi}% guardrail band." | Guyton-Klinger adjustment | `Δspend` | **P0** |

#### Crypto

| ID | Trigger | Data needed | Message template | Action | Impact | Pri |
|---|---|---|---|---|---|---|
| X1 | Crypto > `T` (default 10%) of net worth | holdings, prices | "Crypto is {p}% of net worth (${val}). A {dd}% drawdown — which has happened repeatedly — would be ${loss}." | Show historical drawdown, rebalance band | `val × hist_max_dd` (risk) | **P0** |
| X2 | > 50% of crypto value custodied on exchanges | wallet/exchange tagging | "{p}% of your crypto (${val}) sits on exchanges rather than self-custody." | Self-custody education | counterparty risk | P1 |
| X3 | Stablecoins > $5,000 held idle | holdings | "${x} in {stable} isn't FDIC-insured and doesn't earn the ~{apy}% a bank/T-bill would." | Compare | `x × apy` + depeg risk | P1 |
| X4 | Staking/reward inflows detected with no income basis recorded | wallet txns | "{n} staking receipts worth ${v} at receipt need to be recorded as ordinary income with a new cost basis." | Record lots | `v × MTR` (tax correctness) | P1 |
| X5 | Crypto lot with unrealized loss > $500 | lots, prices | "{asset} lot from {date} is down ${loss}. The §1091 wash-sale rule doesn't currently apply to digital assets — legislation has been proposed." | Harvest + caveat | `loss × MTR` | P1 |
| X6 | Any wallet/exchange with holdings lacking per-wallet basis after 2025-01-01 | lots | "{wallet} has ${val} without per-wallet cost basis; Rev. Proc. 2024-28 requires wallet-level tracking." | Import/reconstruct basis | audit risk | P1 |

**P0 count: 18.** That is too many to show at once — see §7.4 on alert budgeting.

---

## 4. Net worth & portfolio analytics

### 4.1 Definitions

```
net_worth(t) = Σ assets(t) − Σ liabilities(t)     over accounts where in_net_worth = true
```

Two independent booleans per account, never conflated:
- `on_budget` — does spending here consume envelopes? (checking, cash, credit cards: yes; brokerage: no)
- `in_net_worth` — does it count toward net worth? (almost always yes)

Third flag: `is_liquid` (for EF and cash rules) and `is_investable` (for concentration denominators).
Get these four booleans right and every downstream rule's denominator is unambiguous.

| Class | Examples | Liquid | Investable | Notes |
|---|---|---|---|---|
| Cash | checking, savings, MMF, cash | ✔ | ✖ | stablecoins: liquid ✔, but flag (§6) |
| Investments | brokerage, 401k, IRA, HSA, 529 | ✖ | ✔ | 401k/IRA excluded from *accessible* liquidity |
| Crypto | exchange, self-custody | partial | ✔ | own asset class |
| Real assets | home, vehicles | ✖ | ✖ | manual valuation |
| Other | collectibles, private equity, loans to others | ✖ | ✖ | manual |
| Liabilities | cards, mortgage, auto, student, personal | — | — | |

**Home equity:** manual only. `property(value, as_of, source ∈ {USER, APPRAISAL, PURCHASE_PRICE, INDEX})`,
with an optional FHFA-HPI-based drift estimator between manual updates (public, free, and honest about being
an index estimate). Do not scrape Zestimates — ToS and accuracy both fail. Nudge for a refresh every
6 months. Home equity = `value − mortgage_balance`; show the net-worth chart with a toggle to exclude
illiquid real assets, because including a house makes the "am I on track" chart nearly meaningless.

### 4.2 Performance math

**Show both. They answer different questions.** Under GIPS, time-weighted return is the default for
composites, with money-weighted (IRR) permitted where the manager controls cash flow timing.
([CFA Institute GIPS — via industry summaries][twr-mwr])

| Question | Metric | Where in UI |
|---|---|---|
| "How much did I actually make?" | **MWR (XIRR)** | Headline on the portfolio page |
| "Did my *investments* do well, vs the index?" | **TWR** | Next to any benchmark comparison |

Never put a TWR next to a dollar gain, and never benchmark an MWR. That's the whole rule.

**True TWR** (sub-period linking at every external cash flow):

```
Split [t0, t1] at each external cash flow date into sub-periods j.
r_j = (MV_end,j − CF_j) / MV_begin,j − 1        # CF_j at start of sub-period j
TWR = Π_j (1 + r_j) − 1
Annualized: (1 + TWR)^(365 / days) − 1     # only annualize for periods >= 1 year
```

**Modified Dietz** (fallback when you lack daily valuations — CSV-imported accounts):

```
R = (EMV − BMV − Σ CF_i) / (BMV + Σ w_i·CF_i),   w_i = (D − d_i)/D
```

Use Modified Dietz only when daily prices are missing; flag the number `approximate` in the UI.

**MWR / XIRR:**

```python
def xirr(flows: list[tuple[date, Decimal]], guess=0.1) -> Decimal:
    # flows: contributions negative, withdrawals positive, terminal value positive
    t0 = flows[0][0]
    def npv(r):
        return sum(cf / (1+r) ** (Decimal((d - t0).days) / 365) for d, cf in flows)
    # Newton with bisection fallback -- Newton alone diverges on sign-flipping flows
    lo, hi = Decimal("-0.9999"), Decimal("100")
    if npv(lo) * npv(hi) > 0: return None          # no sign change: undefined, show "n/a"
    r = guess
    for _ in range(100):
        f = npv(r); fp = (npv(r + Decimal("1e-6")) - f) / Decimal("1e-6")
        if fp == 0 or not (lo < r < hi): break
        r_new = r - f/fp
        if not (lo < r_new < hi): r_new = (lo + hi) / 2
        if npv(r_new) * npv(lo) < 0: hi = r_new
        else: lo = r_new
        if abs(r_new - r) < Decimal("1e-9"): return r_new
        r = r_new
    return bisect(npv, lo, hi)
```

Edge cases to test: single cash flow (undefined → "n/a", not 0); all-negative flows; account opened this
month (annualizing a 3-week return to 400% is a classic embarrassing bug — **do not annualize < 1 year**).

### 4.3 Asset-class classification without paid data

Classification waterfall, first hit wins, and **always record `classification_source`**:

```
1. USER_OVERRIDE                     -- always wins, never re-derived
2. LOCAL_SEED_TABLE                  -- hand-curated YAML of ~600 common ETFs/mutual funds
                                        (ticker, asset_class, region, style, ER, is_bond_duration)
                                        MIT-licensed, in-repo, community-updatable
3. SEC EDGAR                         -- company_tickers.json for ticker->CIK;
                                        N-PORT (NPORT-P) XML for fund holdings look-through
4. ISSUER HOLDINGS FILES             -- iShares/Vanguard/SPDR daily CSVs (check each issuer's ToS)
5. NAME HEURISTICS                   -- /total bond|aggregate|treasury|TIPS/ -> bonds;
                                        /S&P 500|total (stock )?market/ -> US equity;
                                        /ex-US|international|emerging|developed/ -> intl
6. INDIVIDUAL EQUITIES               -- SEC SIC code -> sector map; state/country of incorporation -> region
7. UNCLASSIFIED                      -- explicit bucket; surfaced in the UI
```

Identifier mapping: **OpenFIGI** (free, rate-limited) for CUSIP/ISIN/SEDOL → ticker/FIGI. Brokerage CSVs
frequently give only a CUSIP; without this mapping the whole portfolio module stalls.

Every registered fund files complete portfolio holdings with the SEC on Form N-PORT in machine-readable
format. ([SEC N-PORT via data vendors][nport])

**ETF look-through limitations — state these in the UI, not just the code:**
- N-PORT is filed quarterly with up to a ~60-day public lag. Holdings are stale by construction. For a
  broad index fund this is irrelevant; for an active or thematic fund it isn't.
- Fund-of-funds require **recursive** resolution with cycle detection and a depth cap (3).
- Derivatives report market value, not notional — a fund with futures overlay will misclassify. Flag funds
  where `|Σ classified weights − 1| > 5%`.
- Multi-asset funds (target-date, balanced) must be decomposed, not bucketed as "equity".
- **Surface `% unclassified` next to every allocation chart and drift number.** If 18% of the portfolio is
  unclassified, a "7pp drift" claim is noise, and rule I1 must suppress itself when
  `unclassified_pct > 10%`.

Taxonomy (keep it small; expand later):

```
asset_class: US_EQUITY | INTL_DEV_EQUITY | EM_EQUITY | US_BOND | INTL_BOND | TIPS |
             REAL_ESTATE | COMMODITY | CRYPTO | CASH | OTHER | UNCLASSIFIED
region:      US | DEV_EX_US | EM | GLOBAL | UNKNOWN
sector:      GICS-like 11 sectors | UNKNOWN
style:       LARGE/MID/SMALL × VALUE/BLEND/GROWTH | UNKNOWN
duration:    SHORT | INTERMEDIATE | LONG | UNKNOWN     # bonds only
```

### 4.4 Cost basis, lots, and gains

```sql
lot(id, account_id, security_id, open_date, quantity, cost_basis_minor, quantity_remaining,
    basis_source ENUM(BROKER,IMPORTED,USER,ESTIMATED), wash_sale_adjustment_minor,
    holding_period_start_date)   -- separate from open_date: wash sales tack on the prior holding period
```

Methods: `FIFO` (default and IRS default), `LIFO`, `HIFO`, `SPECIFIC_ID` (recommended for taxable),
`AVERAGE_COST` (mutual funds only; once elected, it's sticky per security per account).

```
unrealized(security) = Σ_lots quantity_remaining × (price − cost_per_share)
realized_gain(sale)  = proceeds − Σ selected_lots basis   (split into ST if ≤ 365 days, else LT)

estimated_tax_on_realized(YTD) =
      ST_net × marginal_ordinary_rate
    + LT_net × LTCG_rate_bracket(projected_taxable_income)
    + (NII × 0.038 if MAGI > NIIT threshold)
    − capital_loss_carryforward_applied
    (ordinary-income offset capped at $3,000/yr; remainder carries forward)
```

**Wash-sale handling** (§1091): a loss is disallowed if substantially identical securities are bought within
30 days *before or after* the sale — a 61-day window including the sale date — and the disallowed loss is
added to the replacement lot's basis with the holding period tacked on. The determination of "substantially
identical" is facts-and-circumstances. ([IRS Pub. 550 summaries][washsale])

Implementation notes that matter:
- Scan **across all accounts including IRAs and the spouse's** — that's the trap most software misses.
- We can only warn, never compute authoritatively (different share classes, options, similar-but-not-
  identical index funds). Label output `POSSIBLE_WASH_SALE`, never `WASH_SALE`.
- Crypto: §1091 currently does **not** apply to digital assets, because they're property, not securities —
  though bills to change this recur. Encode this as a dated config flag
  (`wash_sale_applies_to_digital_assets: false  # as of 2026-09; see CRYPTO_WASH_SALE_WATCH`), not a
  hardcoded branch. ([Gordon Law][crypto-wash], [CNBC 2026-07][cnbc-wash])

---

## 5. Retirement & goal projection engine

### 5.1 Architecture

```
PlanInput  -> Deterministic engine  -> single path, "expected" narrative
           -> Monte Carlo engine    -> 10,000 paths, percentile bands, success probability
           -> Historical cycles     -> ~95 real sequences, sanity check + sequence-risk narrative
```

Run all three. Show the deterministic path as the *story*, the Monte Carlo as the *confidence*, and the
historical cycles as the *reality check*. When they disagree materially, that disagreement is itself the
insight.

### 5.2 Deterministic projection

Work in **real (today's) dollars** internally; convert to nominal only for display toggles. Real dollars
make "will I have enough" answerable; nominal dollars make it feel answerable while being wrong.

```
r_real = (1 + r_nominal) / (1 + i) − 1
g_real = (1 + wage_growth) / (1 + i) − 1     # default wage_growth = i + 0.005 -> g_real ≈ 0.005
```

Accumulation, annual steps, mid-year contribution convention:

```
for t in 0..(retire_age − current_age − 1):
    C_t = contribution_0 × (1 + g_real)^t                 # % of salary, salary grows with g_real
    B_{t+1} = B_t × (1 + r_real) + C_t × (1 + r_real)^0.5
```

Decumulation:

```
for t in retire..death:
    W_t   = spend_t − SS_t − pension_t − other_income_t   # all real
    tax_t = estimate_tax(withdrawal_mix(W_t), t)          # phase 2, see §5.7
    B_{t+1} = (B_t − W_t − tax_t) × (1 + r_real)
```

Multi-account: run the recursion per **tax bucket** (`TAXABLE`, `TAX_DEFERRED`, `ROTH`, `HSA`), because
withdrawal ordering and RMDs need them separate. Each bucket carries its own asset allocation and therefore
its own `r`.

### 5.3 Monte Carlo — engine choice

| Engine | Method | Pros | Cons |
|---|---|---|---|
| **A. Parametric** | Multivariate lognormal, Cholesky-correlated | fast, smooth, easy sensitivity | thin tails, no mean reversion, understates sequence risk |
| **B. Block bootstrap** ✅ **default** | Resample contiguous blocks of historical monthly real returns | preserves fat tails, autocorrelation, cross-asset correlation *for free*, and realistic bad sequences | bounded by one country's history |
| **C. Historical cycles** | Every real start month (1871→) | true sequences, what FIRECalc/cFIREsim do | ~95 non-independent samples; overlapping cycles overstate confidence |

**Default: B (stationary block bootstrap)**, with A available for sensitivity and C shown as "how this plan
would have fared in every historical retirement". The FIRE-tool landscape splits exactly this way —
FIRECalc/cFIREsim are historical-sequence tools, while Monte Carlo tools resample years.
([FIRE calculator comparisons][fire-calcs])

**Paths: 10,000.** Vanguard's VCMM likewise runs 10,000 simulations per asset class.
([Vanguard][vcmm]) Beyond ~10k, the 5th-percentile estimate stops moving meaningfully; below ~2k it's visibly
noisy on a slider.

### 5.4 Monte Carlo pseudocode

```python
def monte_carlo(plan, n_paths=10_000, seed=20260910):
    rng = np.random.default_rng(seed)          # FIXED SEED: sliders must not jitter from noise alone
    months = (plan.death_age - plan.current_age) * 12
    results = np.empty((n_paths, months + 1))
    fail_month = np.full(n_paths, -1)

    hist = load_historical_real_monthly()      # (T, K) real monthly returns per asset class
    p_stay = 1 - 1/12                          # stationary bootstrap: E[block] = 12 months

    for i in range(n_paths):
        bal = plan.starting_balances.copy()    # per tax bucket
        idx = rng.integers(0, len(hist))
        for m in range(months):
            age = plan.current_age + m/12
            w   = plan.glidepath(age)                       # asset weights, sums to 1
            # --- stationary block bootstrap draw ---
            if m > 0 and rng.random() > p_stay:
                idx = rng.integers(0, len(hist))
            else:
                idx = (idx + 1) % len(hist)
            r_m = float(hist[idx] @ w)                      # portfolio real monthly return

            # --- cash flows ---
            if age < plan.retire_age:
                flow = plan.contribution_at(age) / 12
            else:
                spend = plan.spending_rule.withdraw(bal_total(bal), age, plan)  # §5.6 guardrails
                flow  = -(spend - plan.income_at(age))
                flow -= rmd_shortfall_tax(bal, age, plan)                       # §5.7

            bal = apply(bal, r_m, flow, plan.withdrawal_order)
            results[i, m+1] = bal_total(bal)
            if bal_total(bal) <= 0 and fail_month[i] < 0:
                fail_month[i] = m
                # do NOT break: keep simulating on SS/pension alone to measure shortfall magnitude

    return MCResult(
        percentiles      = np.percentile(results, [5, 25, 50, 75, 95], axis=0),
        success_rate     = (fail_month < 0).mean(),
        median_terminal  = np.median(results[:, -1]),
        shortfall_years  = np.median([(months - f)/12 for f in fail_month if f >= 0] or [0]),
        p10_terminal     = np.percentile(results[:, -1], 10),
        seq_risk         = success_by_first5yr_return_decile(results, fail_month),
    )
```

Three details that separate a good implementation from a toy:

1. **Common random numbers.** Every what-if comparison must reuse the same `seed` and the same drawn
   return paths, so a 1% savings-rate change shows its *true* effect, not Monte Carlo noise.
   Without this, sliders feel broken.
2. **Don't stop at failure.** Report *magnitude* — median shortfall years and terminal-wealth
   distribution. A plan that fails at 92 by $10k is not the same as one that fails at 71.
   Binary success rate is the single most over-weighted number in consumer retirement software.
3. **Sequence-of-returns risk, explicitly.** Report success conditional on the first-5-years return decile.
   A plan with 85% overall success but 20% success in the worst first-5-year decile deserves a different
   conversation than one that's uniformly 85%.

### 5.5 Default assumptions (with sources)

Ship these in `config/assumptions.yaml`, versioned, user-overridable, **with the source string displayed in
the UI next to each number.**

| Parameter | Default (nominal) | σ | Basis |
|---|---|---|---|
| US equity | 6.5% | 17% | Blend: long-run historical ≈10% vs. Vanguard VCMM 10-yr US equity **3.9–5.9%** (as of 2025-12-31). Deliberately conservative. ([Vanguard][vcmm]) |
| Intl developed equity | 7.0% | 19% | VCMM non-US generally above US in recent runs |
| Emerging equity | 7.5% | 24% | historical premium + higher vol |
| US aggregate bonds | 4.5% | 6% | VCMM US agg ≈4–5%; consistent with current yields |
| TIPS | 2.0% real | 6% | current real yields |
| Cash / T-bills | 3.5% | 1.0% | 3-mo T-bill ≈3.93% on 2026-09-10, trending down ([TradingEconomics][tbill]) |
| Crypto (BTC-weighted) | 6.5% | **70%** | §6.4 — no defensible expected-return estimate; default to equity μ with crypto σ and force a disclaimer |
| Inflation | 2.5% | 1.5% | long-run target; 2026 Social Security COLA = **2.8%** ([SSA/press][ss2026]) |
| Wage growth | inflation + 0.5% | — | long-run real wage growth |
| Equity ERP cross-check | 4.23% (Jan 2026) | — | Damodaran implied ERP, US ([Damodaran][damodaran]) |

Correlation matrix default (annual, real) — a starting point; the bootstrap engine derives it empirically:

```
              USEQ  INTL   EM   BOND  TIPS  REIT  CASH  CRYPTO
USEQ          1.00  0.85  0.75  0.10  0.00  0.70 -0.05   0.40
INTL                1.00  0.85  0.10  0.05  0.65 -0.05   0.35
EM                        1.00  0.05  0.05  0.60 -0.05   0.40
BOND                            1.00  0.70  0.25  0.20   0.05
TIPS                                  1.00  0.25  0.25   0.05
REIT                                        1.00  0.00   0.30
CASH                                              1.00   0.00
CRYPTO                                                   1.00
```

**Historical return data sources (all free, all citable):**

| Source | What | Use |
|---|---|---|
| Robert Shiller, `ie_data.xls` (Yale) | Monthly S&P composite prices, dividends, earnings, CPI, long rate since 1871 | Bootstrap engine's equity + inflation series; historical cycles |
| Aswath Damodaran, `histretSP.xls` (NYU Stern) | Annual returns on S&P 500, 10-yr T-bond, 3-mo T-bill since 1928; implied ERP series | Cross-check, ERP, bond/bill series |
| FRED | CPIAUCSL, DGS10, DGS3MO, DTB3, FEDFUNDS, MORTGAGE30US, FHFA HPI | Inflation, rate assumptions, home-value drift, current-rate insights (C1/C2/D2) |
| SSA | AWI series, bend points, COLA history, actuarial life tables | Social Security engine (§5.8) |
| MSCI / Ken French data library | International & factor series | Intl equity bootstrap |

Cache all of these locally in the repo's `data/` directory with a fetch script and a checksum — a
self-hosted app must work offline.

### 5.6 Safe withdrawal and guardrails

**The 4% rule, stated honestly.** Bengen's original work identified ~4% as the *worst-case* sustainable
initial rate over 30 years in US history; he has since revised his worst case upward to ~4.7% with broader
diversification. It is not a law, it assumes a 30-year horizon, US history, a fixed 50–75% equity
allocation, no fees, and no taxes. ([Bengen update summaries][bengen])

**Default withdrawal policy: Guyton-Klinger guardrails**, not static 4%:

```
initial_wr = 0.045                       # user-settable
UPPER = initial_wr × 1.20                # capital preservation guardrail
LOWER = initial_wr × 0.80                # prosperity guardrail

each year (after year 1, and not in the final 15 years of the plan for the preservation rule):
    current_wr = withdrawal / portfolio_value
    if current_wr > UPPER:  withdrawal ×= 0.90        # cut 10%
    if current_wr < LOWER:  withdrawal ×= 1.10        # raise 10%
    # inflation rule: skip the COLA if last year's portfolio return was negative
    #   AND current_wr > initial_wr
    else:                   withdrawal ×= (1 + inflation)
    withdrawal = max(withdrawal, floor_spending)      # SEE BELOW
```

Guyton & Klinger (2006, *FPA Journal*) support starting rates in the 5–5.5% range with failure risk
comparable to a static 4%. ([White Coat Investor][gk]) **But** Kitces' critique is essential and must be
encoded: unmodified guardrails produced cumulative spending cuts of ~28% in 2008, ~36% in the dot-com bust,
and ~54% through 1965–1975 stagflation. ([Kitces via summaries][gk])

Therefore add a **spending floor**: `floor_spending = essential_spend` (derived from the user's NEED-class
budget categories — a genuinely nice integration between §1 and §5), and cap cumulative real cuts at 20%.
Report to the user both "success probability" *and* "worst-case spending cut in the 5th percentile path",
because a 95% success rate achieved by cutting spending in half isn't success.

### 5.7 Tax-aware withdrawal ordering (Phase 2)

Phase 1: single blended effective tax rate on tax-deferred withdrawals. Ship this; it's 80% of the value.

Phase 2 ordering, default **TAXABLE → TAX_DEFERRED → ROTH**, with these refinements (which is where the
actual money is):

```
1. Always take RMDs first once required (no choice).
2. Fill the standard deduction + low brackets with tax-deferred withdrawals or Roth conversions,
   even if taxable funds are available (bracket-filling beats naive ordering).
3. Realize long-term gains at 0% LTCG when taxable income allows.
4. Preserve Roth for last (and for heirs; Roth 401(k)/403(b) RMDs were eliminated effective 2024).
5. Watch cliff effects: IRMAA brackets, ACA premium credits pre-65, NIIT threshold, Social Security
   taxability (the "tax torpedo" between 50% and 85% inclusion).
```

**RMD engine:**

```
rmd_age = 73 if born 1951..1959 else 75 if born >= 1960     # SECURE 2.0
RMD_year = balance(Dec 31 prior year) / Uniform_Lifetime_Table[age]
first RMD due by April 1 of the year after reaching rmd_age; subsequent by Dec 31.
  (Deferring the first to April 1 means TWO RMDs in that calendar year -- model this; it's a real
   bracket-spike that surprises people.)
Penalty for a missed RMD: 25% excise, reduced to 10% if corrected timely.
Roth 401(k)/403(b): no RMDs (eliminated effective 2024). Roth IRA: never had them for the owner.
```
([Congressional Research Service][crs-rmd], [Schneider Downs][sd-rmd])

Ship the Uniform Lifetime Table and Single Life Table as data files (`data/irs/uniform_lifetime.csv`).

### 5.8 Social Security estimate

Inputs: DOB, earnings history (ideally imported from the SSA statement XML the user downloads; else
current salary + years worked estimate), planned claim age.

```
1. Index each year's earnings (capped at that year's taxable maximum) by the AWI ratio to the
   year the worker turns 60. Earnings at/after 60 are used nominally.
2. AIME = sum(highest 35 indexed years) / 420, rounded down to a whole dollar.
3. PIA (2026 bend points, locked in the year the worker turns 62):
       0.90 × min(AIME, 1286)
     + 0.32 × max(0, min(AIME, 7749) − 1286)
     + 0.15 × max(0, AIME − 7749)
4. FRA = 67 for anyone born 1960 or later.
5. Claim adjustment:
     early: −5/9 of 1% per month for the first 36 months before FRA,
            −5/12 of 1% per month beyond that
     late:  +8%/year (2/3 of 1% per month) to age 70
6. Apply COLA annually (2.8% for 2026).
7. Taxable wage base 2026: $184,500.
```
([2026 bend points / wage base / COLA][ss2026])

Default claim age: model 62, FRA, and 70; default the *plan* to 70 for the higher earner only if the plan's
success rate improves, and always show the breakeven age. Note prominently that SSA's own projections
assume a legislated benefit; offer a "75% benefit after 2034" stress toggle — that's an honest lever, and
users ask for it.

### 5.9 Glidepath

```
DEFAULT:  equity_pct(age) = clamp(110 − age, 30, 90) / 100      # "110 minus age"
ALT:      TARGET_DATE_TABLE (Vanguard/Schwab-like), user-selectable
ALT:      RISING_EQUITY_GLIDEPATH (Kitces/Pfau) — bond tent: dip to ~40% equity at retirement,
          rise back to ~70% over 15 years; demonstrably mitigates sequence risk
ALT:      STATIC (user-set)
```

The glidepath is a function passed into the MC engine, evaluated per-month. Keep it pluggable; the bond-tent
variant is a differentiating feature and costs ~20 lines.

### 5.10 What-if levers

```
levers = {retire_age, savings_rate, annual_spending, expected_return_shift,
          ss_claim_age, part_time_income, one_time_windfall, glidepath}
```

For each lever, compute `∂success/∂lever` by re-running with **common random numbers**, and render a tornado
chart ranked by sensitivity. The headline output the user actually wants:

> "Working 1 more year: +7pp. Saving 2% more: +4pp. Spending $500/mo less in retirement: +11pp."

That single sentence is worth more than the entire percentile fan chart. Wealthfront's Path takes the same
shape — project savings, contributions, Social Security and returns net of inflation and taxes, then let the
user move levers. ([Wealthfront][wf-path])

---

## 6. Crypto

### 6.1 Valuation

```
holding_value = quantity × price(asset, t, quote=USD)
price source priority: user override > exchange fill > CoinGecko/CoinPaprika free API > last known
Reporting convention: UTC 00:00 daily close for all historical charts (mixed timezones across exchanges
otherwise produce phantom volatility in the net-worth chart).
Stale-price rule: if last price > 24h old, mark the holding STALE and exclude from "as of now" deltas.
```

Store `price_snapshot(asset, ts, price, source)` — never recompute history from today's price.

### 6.2 Cost basis across exchanges and wallets

**Per-wallet/per-account basis is now required.** Rev. Proc. 2024-28 ended universal cost-basis tracking for
digital assets effective 2025-01-01: basis must be tracked separately per wallet or account, with a safe
harbor for reasonably allocating previously-universal unused basis to specific wallets. Within a wallet you
may use FIFO, HIFO, or specific-ID; the per-wallet rule changes how lots are *grouped*, not which method
applies. Form 1099-DA reports gross proceeds for 2025 transactions and **gross proceeds plus adjusted basis
for 2026 transactions onward**. ([Rev. Proc. 2024-28 summaries][revproc], [Withum][withum])

Data model:

```sql
crypto_lot(id, wallet_id, asset, acquired_at, quantity, quantity_remaining,
           basis_usd_minor, acquisition_type ENUM(BUY,STAKING,AIRDROP,MINING,FORK,GIFT,TRANSFER_IN),
           source_txn_hash, basis_source ENUM(EXCHANGE_1099DA,IMPORTED,USER,ESTIMATED,SAFE_HARBOR_ALLOC))
crypto_transfer(from_wallet, to_wallet, asset, quantity, fee, ts, lots_moved[])
```

Rules:
- **Self-transfers are not taxable** but must carry lots (with original `acquired_at` and basis) to the
  destination wallet. This is the single most common source of wrong crypto tax numbers. Implement transfer
  matching: outbound tx on wallet A + inbound on wallet B within 24h, same asset, quantity within the
  network fee → auto-link, user-confirmable.
- Network fees on a transfer: add to basis of the moved lots (conservative) or treat as a disposal of the
  fee asset — make it a configurable policy and document the choice.
- Crypto-to-crypto trades **are** taxable disposals. Every swap creates a realized gain on the sold asset and
  a new lot on the bought asset at FMV.
- Missing basis → `ESTIMATED` with a visible warning and a $0-basis worst case shown separately. Never
  silently assume zero.

### 6.3 Stablecoins

```
classification: CASH_LIKE for allocation charts; SEPARATE for risk.
is_liquid = true
counts_toward_emergency_fund = FALSE by default    # not FDIC-insured; depeg and platform risk
Show a persistent badge: "Stablecoins are not bank deposits and are not FDIC-insured."
```

Rule X3 compares stablecoin yield to the T-bill/HYSA alternative and names the risk difference rather than
just the yield difference.

### 6.4 Crypto in Monte Carlo

Crypto is its **own asset class with its own parameters**, never folded into equity.

```
CRYPTO: μ_nominal = 6.5%  (default equal to equity — we have no defensible edge),
        σ = 70%,
        ρ(equity) = 0.40,
        distribution = Student-t(ν=3) or historical block bootstrap on BTC monthly returns (2014+),
                       NOT lognormal — lognormal dramatically understates crypto drawdowns
```

Mandatory UI treatments:
1. A **history-is-short disclaimer**: fewer than 15 usable years, entirely within one monetary regime.
2. A **dual projection**: plan success *with* crypto at the modeled return, and *with crypto valued at $0*.
   If the plan only works with crypto, that is the finding.
3. **Drawdown framing** over return framing for insight X1: "BTC has drawn down >70% four times; that would
   be −$X of your net worth today."
4. Cap crypto's contribution to the *median* projected path so a 70%-σ lognormal doesn't manufacture
   a fantastical p95 — report the median and p5, de-emphasize p95 for crypto-heavy plans.

### 6.5 Staking and rewards

```
on staking/mining/airdrop receipt:
    income_usd = quantity × FMV at the time the taxpayer gains dominion and control
    create crypto_lot(basis_usd = income_usd, acquired_at = receipt_ts, acquisition_type = STAKING)
    record ordinary_income_event(income_usd, ts)       # feeds YTD tax estimate
```

Rev. Rul. 2023-14 treats staking rewards as ordinary income on receipt when the taxpayer has dominion and
control. Liquid-staking tokens (stETH etc.) and rebasing tokens are genuinely unsettled — flag them
`TAX_TREATMENT_UNCERTAIN` and tell the user to ask a CPA rather than picking a treatment silently.

---

## 7. Guardrails & compliance

### 7.1 What this is and isn't

PersonalFi is software the user runs for himself. It is not an investment adviser, does not receive
compensation for advice, and has no fiduciary relationship. That framing is legally comfortable, but the
*product* framing must match it, and the constraints below are also simply good advice design.

### 7.2 Language rules (enforce in code, not in review)

`lint_advice_copy()` runs in CI over every message template.

**Banned** (regex-enforced in the template linter):
`\byou should\b`, `\bbuy\b(?!\s*-?\s*and-hold)`, `\bsell\b`, `\bwe recommend\b`, `\bbest (stock|fund|investment)\b`,
`\bguaranteed returns?\b`, `\bwill (grow|earn|return)\b`, `\brisk-?free\b` (except "risk-free rate" in a
labeled technical context), `\bcan't lose\b`, `\bshould invest in\b`.

**Preferred forms:**

| Instead of | Write |
|---|---|
| "You should move $20k to a HYSA" | "About $20,000 above your emergency fund target has earned 0.4%. Accounts paying around 4% exist; that difference is roughly $720/yr." |
| "Sell VFINX, buy VTI" | "VFINX charges 0.14% vs 0.03% for comparable index funds — about $X/yr on this position. Selling in a taxable account would realize $Y of gains." |
| "Your plan will succeed" | "In 10,000 simulations using historical return sequences, this plan lasted through age 95 in 86% of them." |
| "Cancel Spotify" | "You have two music services. Keeping one would save $131/yr." |

**Always pair a recommendation with its cost.** "Consider selling X" without "which realizes $Y of gains and
$Z of tax" is the hallmark of bad automated advice.

Every advisory surface carries:

> *Educational information generated from your own data. Not investment, tax, or legal advice. Figures are
> estimates based on assumptions you can review and change. Consider consulting a qualified professional.*

### 7.3 Explainability & audit trail (non-negotiable)

```sql
insight_instance(
  id, rule_id, rule_version, computed_at, expires_at,
  severity, annual_impact_minor, confidence,
  inputs_snapshot JSONB,          -- every input value used, verbatim
  assumptions_version TEXT,       -- which config/assumptions.yaml hash
  rendered_title TEXT, rendered_body TEXT,
  llm_used BOOL, llm_model TEXT, llm_prompt_hash TEXT,
  shown_at, clicked_at, dismissed_at, dismiss_reason, snoozed_until,
  outcome ENUM(PENDING, ACTED, IGNORED, INVALIDATED), outcome_measured_at
)
insight_evidence(insight_id, entity_type ENUM(TXN,HOLDING,LOT,ACCOUNT,STREAM,GOAL), entity_id, role TEXT)
```

Every insight must render a **"Why am I seeing this?"** panel that shows: the rule in plain English, the
threshold, the actual values, and a tappable list of the exact transactions/holdings in
`insight_evidence`. If a rule can't populate evidence, it doesn't ship.

`inputs_snapshot` + `assumptions_version` mean that six months later you can answer "why did it say $720?"
exactly. This is also what makes §8's backtesting possible.

### 7.4 Alert budgeting

18 P0 rules means a wall of red on day one. Policy:

```
max_insights_shown       = 5 on the dashboard, 20 in the full list
min_annual_impact        = $50 (configurable) unless severity == P0_SAFETY (fraud, overdraft, missed payment)
cooldown(rule, entity)   = 30 days after dismissal; 90 days after 2 dismissals; permanent after 3
new_user_onboarding      = release rules in waves (week 1: cash + subscriptions; week 2: debt;
                           week 3: investing; week 4: retirement) so the first run isn't overwhelming
digest                   = weekly summary email/notification rather than real-time pings,
                           EXCEPT P0_SAFETY which is immediate
```

### 7.5 LLM usage rules

If an LLM is used to phrase insights or answer "how am I doing?" questions:

1. **Numbers never come from the model.** The model receives a structured, pre-computed context object and
   may only *phrase* it. Post-generation, run a validator that extracts every numeral from the output and
   asserts each appears in the context object (allowing formatting variants). Fail closed — fall back to the
   deterministic template.
2. **Retrieval-grounded only.** The context contains actual transactions/holdings; there's no free-floating
   "what do you think about the market" mode.
3. **Labeled.** A visible "AI-assisted wording" badge, plus `llm_used=true` in the audit row.
4. **Never actionable-autonomous.** No trades, no transfers, no cancellations executed by the model.
   Everything is a link to a human-performed action.
5. **Prompt-injection surface:** transaction *descriptions* are attacker-controlled in principle (a payee can
   name itself anything). Treat all merchant strings as untrusted data, never as instructions; delimit and
   escape them in prompts.
6. Local-model-first (Ollama etc.) given self-hosting; if a hosted model is used, make it opt-in with an
   explicit "your financial data leaves this machine" consent screen.

---

## 8. Evaluation: how we know the advice is good

### 8.1 Three levels of evaluation

| Level | Question | Method |
|---|---|---|
| **Detection** | Did we correctly identify what's there? | Precision/recall vs labeled set (§2.12) |
| **Rule correctness** | Would the insight have been right? | Point-in-time backtest (§8.2) |
| **Outcome** | Did it help? | Realized-savings tracking + feedback loop (§8.3) |

### 8.2 Point-in-time rule backtesting

```python
def backtest(rule, history, start, end, step=timedelta(days=7)):
    for asof in daterange(start, end, step):
        world = history.as_of(asof)          # STRICT: no data with knowledge_date > asof
        for insight in rule.evaluate(world):
            future = history.between(asof, asof + rule.evaluation_horizon)
            yield BacktestRow(
                asof, insight,
                predicted_impact = insight.annual_impact_minor,
                realized_impact  = rule.measure_outcome(insight, future),
                would_have_been_correct = rule.validate(insight, future),
            )
```

**The critical engineering requirement: a bitemporal store.** Every row carries `valid_time` (when it was
true in the world) and `knowledge_time` (when we learned it). Without this, `as_of()` leaks the future —
recategorizations, late-arriving transactions, and restated balances all silently make backtests look
brilliant. Build this into the schema on day one; retrofitting it is miserable.

Per-rule validation examples:

| Rule | `validate()` | `measure_outcome()` |
|---|---|---|
| C3 overdraft risk | Did the balance actually go negative in the next 14 days? | Overdraft fees actually charged |
| U2 price increase | Did the higher amount persist for ≥2 more periods? | Δ × periods since |
| S2 category creep | Did the elevated level persist 3 more months? | Realized vs baseline |
| I1 allocation drift | Was the drift real after re-classifying with today's better data? | n/a (risk rule) |
| R2 success probability | (Long horizon) — validate the *engine* instead, §8.4 | n/a |

Report per rule: **fire rate, precision, predicted-vs-realized-$ calibration** (a scatter with a 45° line;
a rule that systematically overstates impact by 3× is worse than a rule that doesn't fire).

### 8.3 Feedback loop

Dismiss taxonomy (these are the *tuning signals*, so make them specific):

```
NOT_TRUE          -> the facts are wrong          => data/detector bug; open an issue automatically
ALREADY_KNOW      -> true but known               => raise threshold / lengthen cooldown for this rule
NOT_ACTIONABLE    -> true but I can't act         => de-prioritize; possibly the rule needs a better action
DONT_CARE         -> true, don't value it         => suppress rule class for this user
WRONG_AMOUNT      -> right finding, wrong $       => calibration bug; log inputs_snapshot for review
INTENTIONAL       -> "I meant to do that"         => permanent entity-level suppression
LATER             -> snooze                       => re-fire at snoozed_until
```

Feed these into per-rule thresholds:

```
if dismiss_rate(rule) > 0.6 over >= 10 firings:  raise threshold by 25% and alert the developer
if NOT_TRUE rate > 0.2:                          disable the rule; it's broken, not noisy
if ACTED rate > 0.4:                             promote the rule's priority
```

Maintain a **rule health dashboard**: firings, shown, clicked, acted, dismissed-by-reason, predicted $,
realized $. A rule with zero acts in 12 months should be deleted. Advice catalogs rot; treat rules as code
with an explicit lifecycle.

### 8.4 Engine validation (projection/MC)

You can't backtest a 30-year projection in a year, so validate the *engine*, not the forecast:

1. **Golden-value tests:** reproduce published outputs — the 4% rule's historical failure count on Shiller
   data; Guyton-Klinger's published 1973 and 2000 cohort paths; a Modified Dietz worked example from GIPS
   literature; an XIRR case verified against Excel to 1e-6.
2. **Invariants:** zero volatility ⇒ Monte Carlo median == deterministic path (to floating tolerance);
   zero contributions + zero returns ⇒ balance constant; success rate is monotone in savings rate,
   monotone in retirement age, monotone decreasing in spending. Property-test these with Hypothesis.
3. **Convergence:** p5 estimate stable to within 1% across seeds at n=10,000.
4. **Historical replay:** run the plan engine as of 1995, 2000, 2007 with then-available assumptions; compare
   projected vs actual 2026 outcomes. Humbling, and a good calibration on how wide the bands should be.
5. **Cross-tool agreement:** same inputs into cFIREsim / FI Calc and compare success rates. Agreement within
   a few points validates; large divergence means an assumption is mis-specified.

### 8.5 Release gate

```
CI blocks merge if:
  - stream detection precision < 0.95 or recall < previous_release − 0.02
  - any rule's NOT_TRUE backtest rate > 0.10 on the gold set
  - advice copy linter fails (banned phrases)
  - any insight template can produce an empty evidence list
  - budget identity invariant (§1.2) fails any property test
  - MC golden-value tests drift > 0.5pp
```

---

## Appendix A — 2026 US parameters (single source of truth)

Put these in `config/tax/us_2026.yaml`, keyed by year, never inlined in code. Every rule reads from here.

### Retirement contributions (Notice 2025-67)

| Item | 2026 |
|---|---|
| 401(k)/403(b)/457(b)/TSP elective deferral | **$24,500** |
| Catch-up, age 50+ | $8,000 |
| Catch-up, ages 60–63 (super catch-up) | $11,250 |
| IRA contribution limit | **$7,500** |
| IRA catch-up, 50+ | $1,100 |
| Roth IRA MAGI phase-out, single/HoH | $153,000–$168,000 |
| Roth IRA MAGI phase-out, MFJ | $242,000–$252,000 |
| Roth IRA MAGI phase-out, MFS | $0–$10,000 |
| Traditional IRA deduction phase-out, single (covered) | $81,000–$91,000 |
| Traditional IRA deduction phase-out, MFJ (covered) | $129,000–$149,000 |
| Traditional IRA, non-covered spouse | $242,000–$252,000 |
| Saver's Credit AGI limit, MFJ / HoH / single | $80,500 / $60,375 / $40,250 |
| SIMPLE deferral (standard / applicable plans) | $17,000 / $18,100 |
| **Mandatory Roth catch-up** if prior-year FICA wages from that employer exceeded | **$150,000** |

([IRS IR-2025-… / Notice 2025-67][irs-401k])

### Income tax (Rev. Proc. 2025-32)

| Item | 2026 |
|---|---|
| Standard deduction — MFJ / single & MFS / HoH | **$32,200 / $16,100 / $24,150** |
| Brackets (single) | 10% ≤$12,400; 12% >$12,400; 22% >$50,400; 24% >$105,700; 32% >$201,775; 35% >$256,225; 37% >$640,600 |
| MFJ thresholds | approximately double the single thresholds |
| LTCG 0% / 15% / 20% (single) | ≤$49,450 / ≤$545,500 / above — **corrected 2026-09-26 by WP 4.2**: this row originally read ≤$48,350 / ≤$533,400, which are the 2025 figures; 2026 per Rev. Proc. 2025-32 §3.03 |
| LTCG 0% / 15% / 20% (MFJ) | ≤$98,900 / ≤$613,700 / above — **corrected 2026-09-26 by WP 4.2**: originally ≤$96,700 / ≤$600,050 (2025); 2026 per Rev. Proc. 2025-32 §3.03 |
| NIIT (3.8%) MAGI threshold | $200,000 single / $250,000 MFJ (not indexed) |
| Capital loss ordinary-income offset | $3,000/yr, remainder carries forward |

([IRS][irs-2026], [Rev. Proc. 2025-32][revproc2532])

### HSA (Rev. Proc. 2025-19)

| Item | 2026 |
|---|---|
| Self-only | **$4,400** |
| Family | **$8,750** |
| Catch-up, 55+ | $1,000 |

([Keenan / Rev. Proc. 2025-19][hsa])

### Social Security (2026)

| Item | 2026 |
|---|---|
| COLA | **2.8%** |
| Taxable wage base | **$184,500** |
| PIA bend points | **$1,286** and **$7,749** (90% / 32% / 15%) |
| Full retirement age, born 1960+ | 67 |
| Delayed retirement credit | 8%/yr to age 70 |

([2026 SS numbers][ss2026])

### RMDs (SECURE 2.0)

| Item | Value |
|---|---|
| RMD age, born 1951–1959 | 73 |
| RMD age, born 1960+ | 75 |
| First RMD deadline | April 1 of the year after reaching RMD age |
| Missed-RMD excise tax | 25%, reduced to 10% if timely corrected |
| Roth 401(k)/403(b) RMDs | eliminated effective 2024 |

([CRS IF12750][crs-rmd], [Schneider Downs][sd-rmd])

### Digital assets

| Item | Status as of 2026-09 |
|---|---|
| Cost basis tracking | Per-wallet/per-account required since 2025-01-01 (Rev. Proc. 2024-28); safe harbor for allocating legacy universal basis |
| Form 1099-DA | Gross proceeds for 2025; **gross proceeds + adjusted basis for 2026 transactions** |
| Wash sale (§1091) | Does **not** apply to digital assets; legislation proposed (Applying Existing Tax Anti-Abuse Rules to Digital Assets Act, 2026) |
| Staking rewards | Ordinary income on receipt at FMV (Rev. Rul. 2023-14) |

### Market reference points (refresh quarterly; used only for C1/C2/C8/D2 thresholds)

| Item | 2026-09-10 |
|---|---|
| 3-month T-bill | ~3.93% |
| Top HYSA rates | ~4.2–4.5% APY |
| National average savings rate | 0.38% |
| FDIC insurance limit | $250,000 per depositor, per institution, per ownership category |

([TradingEconomics][tbill], [Bankrate/Fortune/NerdWallet][hysa])

---

## Appendix B — Implementation sequencing (domain priority)

| Phase | Ship | Why this order |
|---|---|---|
| 1 | Accounts, transactions, categorization, envelope ledger (§1), net worth (§4.1) | Nothing else works without a correct ledger |
| 2 | Recurring detection (§2) + subscription insights U1–U8 + cash rules C1–C7 | Highest $/effort; needs only transactions |
| 3 | Debt rules D1–D6, spending rules S1–S10, insight framework + audit trail (§7.3) | Still transaction-only; establishes the advisory surface |
| 4 | Holdings, lots, classification (§4.3–4.4), investing rules I1–I10 | Requires the portfolio subsystem |
| 5 | Deterministic projection + goals (§5.2), R1/R6 | The "am I on track" narrative |
| 6 | Monte Carlo (§5.3–5.6), R2/R7, what-if levers | The showcase feature; needs everything above |
| 7 | Crypto depth (§6), tax-aware withdrawal (§5.7), remaining I/X rules | Complexity-heavy, narrower payoff |

---

## Sources

- [401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500 — IRS (Notice 2025-67)](https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500) [irs-401k]
- [IRS releases tax inflation adjustments for tax year 2026 — IRS](https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill) [irs-2026]
- [Rev. Proc. 2025-32 (PDF) — IRS](https://www.irs.gov/pub/irs-drop/rp-25-32.pdf) [revproc2532]
- [IRS Announces 2026 HSA and HDHP Limits (Rev. Proc. 2025-19) — Keenan](https://www.keenan.com/knowledge-center/news-and-insights/blogs/irs-announces-2026-hsa-and-hdhp-limits/) [hsa]
- [Social Security 2026: COLA, Wage Base, Earnings Test & Key Numbers — FinanceWonk](https://www.financewonk.com/references/social-security-2026-numbers) [ss2026]
- [Social Security Bend Points 2026: The PIA Formula — Benefora](https://www.benefora.org/articles/social-security-bend-points-explained) [ss2026]
- [Required Minimum Distribution Rules for Original Owners — Congressional Research Service IF12750](https://www.congress.gov/crs-product/IF12750) [crs-rmd]
- [RMD Rules for 2026: Who's Affected, Deadlines, Penalties — Schneider Downs](https://schneiderdowns.com/our-thoughts-on/rmd-rules-for-2026/) [sd-rmd]
- [Build deeper user connections with data driven insights (Recurring Transactions) — Plaid](https://plaid.com/blog/recurring-transactions/) [plaid-blog]
- [Transactions — Introduction to Transactions — Plaid Docs](https://plaid.com/docs/transactions/) [plaid-txn-docs]
- [Handling Credit Card Overspending in YNAB — YNAB Support](https://support.ynab.com/en_us/credit-card-overspending-an-overview-HkMGpSbJs) [ynab-cc-overspend]
- [YNAB — Wikipedia (four rules)](https://en.wikipedia.org/wiki/YNAB) [ynab-wiki]
- [What Is the Guyton-Klinger Guardrails Approach for Retirement? — White Coat Investor](https://www.whitecoatinvestor.com/guyton-klinger-guardrails-approach-for-retirement/) [gk]
- [William Bengen's Updated 4% Rule: Is 4.7% the New Safe Withdrawal Rate? — Morrissey Wealth Management](https://www.morrisseywealthmanagement.com/blog/william-bengens-updated-4-rule-is-47-the-new-safe-withdrawal-rate) [bengen]
- [Vanguard Capital Markets Model forecasts / VEMO return forecasts — Vanguard](https://corporate.vanguard.com/content/corporatesite/us/en/corp/vemo/vemo-return-forecasts.html) [vcmm]
- [Equity Risk Premiums: Determinants, Estimates and Implications — The 2026 Edition, Damodaran (SSRN)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6361419) [damodaran]
- [Historical Implied Equity Risk Premiums — Damodaran, NYU Stern](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histimpl.html) [damodaran]
- [Understanding Your Path to Retirement — Wealthfront](https://www.wealthfront.com/blog/understanding-path-retirement/) [wf-path]
- [How does Wealthfront come up with its retirement advice? — Wealthfront Support](https://support.wealthfront.com/hc/en-us/articles/115000627183-How-does-Wealthfront-come-up-with-its-retirement-advice) [wf-path]
- [Best FIRE Calculator Comparison 2026 (FIRECalc / cFIREsim / ProjectionLab methodology)](https://firenum.com/blog/fire-calculator-comparison) [fire-calcs]
- [Time-Weighted vs Money-Weighted Return: TWR vs MWRR (GIPS treatment) — Asora](https://www.asora.com/blog/time-weighted-vs-money-weighted-return) [twr-mwr]
- [Form N-PORT Data API — sec-api.io](https://sec-api.io/docs/n-port-data-api) [nport]
- [Mutual Funds & ETFs — Holdings, AUM, and N-PORT Filings — EDGAR Terminal](https://secedgarterminal.com/fund) [nport]
- [Wash Sale Rule 2026: How the 61-Day Window Works — Jupid](https://jupid.com/blog/wash-sale-rule-guide-2026) [washsale]
- [Crypto Wash Sale Rule in 2026: Is the Loophole Finally Closed? — Gordon Law Group](https://gordonlaw.com/learn/crypto-wash-sale-rule-in-2026-is-the-loophole-finally-closed/) [crypto-wash]
- [Congress renews push to end crypto wash sale tax loophole — CNBC, 2026-07-28](https://www.cnbc.com/2026/07/28/congress-renews-push-to-end-crypto-wash-sale-tax-loophole.html) [cnbc-wash]
- [The End of the Universal Cost Basis Method for Digital Assets — Withum](https://www.withum.com/resources/the-end-of-the-universal-cost-basis-method-for-digital-assets-and-its-impact-on-you/) [withum]
- [Revenue Procedure 2024-28 and Crypto Tax Compliance: What It Means in 2026 — Vezgo](https://vezgo.com/blog/revenue-procedure-2024-28-crypto-tax-compliance/) [revproc]
- [FICO Score Factor: Amounts Owed — myFICO](https://www.myfico.com/credit-education/blog/credit-score-factor-amounts-owed) [fico]
- [United States 3 Month Bill Yield — TradingEconomics](https://tradingeconomics.com/united-states/3-month-bill-yield) [tbill]
- [Average Savings Account Interest Rate for September 2026 — Bankrate](https://www.bankrate.com/banking/savings/average-savings-interest-rates/) [hysa]
- [Top high-yield savings rates, Sept. 10, 2026 — Fortune](https://fortune.com/article/best-savings-account-rates-9-10-2026/) [hysa]
