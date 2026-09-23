# WP 3.10 — Advisor catalog v2

**Package:** `@ctx/insights`. **Contract:** WP 2.6's, shape unchanged — no new
action kind, no new confidence basis, `requires_review` still a literal.
**Landing base:** `main` @ `2507f54`.

Seventeen new deterministic rules — investing **I1–I6**, debt **D1–D6**, crypto
**X1–X3, X5, X6** — plus the two Phase 2 rules that have been withholding for a
market rate since WP 2.7 (**C1**, **C2**), which now read one. Five snapshot
scopes carry the inputs; two of the five are new.

**One check is red and it is a seam, not a defect.** `contract-parity.test.ts`
fails because the published artefacts under `packages/contracts/advisor/v1/`
were reverted on the orchestrator's instruction after being regenerated. §9 has
the exact remediation and the exact semantic diff. Everything else is green:
**193 of 195 tests pass**, both failures in that one file.

---

## 1. Where the files actually are

The dispatch names `packages/contexts/insights/src/snapshot/scopes.ts`. In the
tree as WP 2.6 built it the scope catalogue is at
**`packages/contexts/insights/src/contract/scopes.ts`**, beside the snapshot
schema it is one half of (`contract/snapshot.ts` — _"Every block below
corresponds to exactly one row of `scopes.ts`"_). `src/snapshot/` holds the
_builder_ and its ports, which this work package does not own and did not
touch. Nothing was moved; this note exists so a reviewer looking for the
dispatch's path finds the file rather than a gap.

The rules are exactly where the dispatch put them:

```
packages/contexts/insights/src/advisors/builtin/
├── shared.ts                 refs, three derivation builders, two constants
├── investing/{allocation,costs,concentration,lots,index}.ts
├── debt/{payoff,rates,payments,labels,index}.ts
└── crypto/{exposure,positions,index}.ts
```

---

## 2. The rule table

`priority` is **07 §3.3's own**; `severity` is what the rule emits. Where they
disagree, see the note under the table — the disagreement is the dispatch's
narrowing, not a downgrade this work package invented.

Every row's "fixture row that fires it" points into
`packages/contexts/insights/test/fixtures/portfolio.ts`, and every summary is
pinned verbatim in `test/advisor-golden.test.ts`.

### Investing

| ID     | Trigger                                                                                                   | Formula / figure                                               | 07 pri | Severity          | Fixture row that fires it                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | `\|actual − target\| > 5pp` for an asset class, **and** `unclassified_pct ≤ 10%`, **and** a target exists | `($0 − $1) × 100` → percentage points. **No dollar figure**    | P1     | warning / notable | `by_asset_class` US_EQUITY 45% vs 52%, US_BOND 18% vs 28%, CRYPTO 20% vs 5%. INTL (−4pp) and CASH (+4pp) are inside the band and silent |
| **I2** | `expense_ratio > 0.50%` **or** `> 0.20%` over a comparable                                                | `$0 × $1 − $0 × $2` = value × (er − peer)                      | P0     | warning           | `OLDFUND` — 0.89% against a 0.04% peer on $35,000 → **$297.50/yr**                                                                      |
| **I3** | brokerage cash over its account's `max($1,000, 2%)` threshold, unearmarked, > a fortnight                 | none claimed — 07's `× expected_return` is a forecast          | P1     | warning           | `idle_cash` $12,000 over a $1,000 floor, longest 47 days                                                                                |
| **I4** | one security `> 20%` of investable assets                                                                 | none claimed (risk). Paired cost = the taxable unrealised gain | **P0** | **urgent**        | `VTI` 26% = $130,000 of $500,000; paired cost $32,000 of gains                                                                          |
| **I5** | employer-tagged stock `> 10%` of investable assets                                                        | none claimed (risk)                                            | **P0** | **urgent**        | `ACME` 12% = $60,000, `employer_stock: true`                                                                                            |
| **I6** | taxable, non-crypto lot below cost by `> max($500, 2% of position)`                                       | none claimed — needs a marginal rate                           | P0     | notable           | `ACME` lot 0: $10,500 below cost against a $1,200 threshold                                                                             |

### Debt

| ID     | Trigger                                                                            | Formula / figure                               | 07 pri | Severity | Fixture row that fires it                                                                                    |
| ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| **D1** | ≥ 2 liabilities with a rate and a balance                                          | none claimed — needs a repayment schedule      | P0     | notable  | the 23.99% card ($4,820) against the smallest balance ($3,100 at 18.99%)                                     |
| **D2** | card APR > 12%, or installment APR > published + 1.5pp, against a **fresh** series | `$0 × $1 − $0 × $2` = balance × (apr − market) | P1     | warning  | card 23.99% vs `TERMCBCCALLNS` 21.24% → **$132.55/yr**; student loan 6.89% vs `DGS10` 4.18% → **$579.94/yr** |
| **D3** | `minimum_only_months ≥ 3` with a balance                                           | none claimed — same schedule wall as D1        | P0     | warning  | the card's `minimum_only_months: 5`                                                                          |
| **D4** | promotional rate ends within 90 days with a balance left                           | `$0 × $1` = balance × standing apr             | P0     | warning  | promo ends `2026-11-20`, $3,100 left at 18.99% → **$588.69/yr**                                              |
| **D5** | cushion > 6 months **and** a liability with a rate                                 | none claimed — the market half is a forecast   | P2     | notable  | cushion 6.9 months against all three liabilities                                                             |
| **D6** | due date in the past, last payment earlier than it, balance > 0                    | none claimed — the lender's fee is unknown     | P0     | warning  | card due `2026-09-10`, last paid `2026-08-08`                                                                |

### Crypto

| ID     | Trigger                                       | Formula / figure                                                 | 07 pri | Severity   | Fixture row that fires it                                                        |
| ------ | --------------------------------------------- | ---------------------------------------------------------------- | ------ | ---------- | -------------------------------------------------------------------------------- |
| **X1** | crypto `> 10%` of **net worth**               | `$0 × 0.5` — a stated stress. **Not a projection**, none claimed | **P0** | **urgent** | CRYPTO $100,000 against net worth $530,700 → "if it fell by half, about $50,000" |
| **X2** | more than half of crypto value on an exchange | none claimed — counterparty risk has no number                   | P1     | notable    | custody $60,000 exchange / $40,000 self                                          |
| **X3** | stablecoin balance `> $5,000`                 | `$0 × $1` = balance × published short-term rate                  | P1     | notable    | `USDC` $20,000 at `DTB3` 5.12% → **$1,024.00/yr**                                |
| **X5** | crypto lot below cost by `> $500`             | none claimed — needs a marginal rate                             | P1     | notable    | `BTC` lot 0: $12,000 below cost                                                  |
| **X6** | crypto position with `basis_known: false`     | none claimed — a record, not a saving                            | P1     | notable    | `USDC`, `cost_basis: null`                                                       |

### The priority disagreement, stated rather than buried

03-phase-3-dispatch.md §3 says _"I4, I5, I10 and X1 are P0."_ 07 §3.3 marks
**eleven** of this wave's rules P0 and says, in the same section, that eighteen
P0s are _"a wall of red on day one"_ — §7.4 exists because of it.

This catalogue ships the dispatch's list, minus the one that cannot be written:

- **Urgent (P0 on the wire): I4, I5, X1.** Asserted by name in
  `catalog-v2.test.ts` → `'I4, I5 and X1 are the P0s, and every P0 emits at
urgent'`, which also asserts that _nothing else_ in the wave claims the
  ceiling.
- **I10 is a gap**, so the dispatch's fourth P0 does not exist. See §9.
- **D1, D3, D4, D6, I2 and I6 are P0 in 07 and ship at `warning` or `notable`.**
  Recorded as data: `BuiltinCatalogueEntry.priority` carries 07's value for
  every rule in the catalogue, so this is a field a reviewer can query rather
  than a research document they have to re-read.
- **D6 is the one worth a ruling.** A missed debt payment is 07's P0-_safety_
  class, the same class C3 and C7 already emit at `urgent` for. The dispatch's
  P0 list did not include it, so it ships at `warning` and the question is
  recorded here rather than decided by an agent.

---

## 3. The new scopes, rendered

Five scopes. `networth.summary`, `holdings.aggregate` and `holdings.detail`
existed as rows and schemas from WP 2.6 and were **extended**;
`liabilities.terms` and `market.rates` are **new rows**.

Every block below is the fixture verbatim, and every block below is parsed by
`AdvisorSnapshotSchema` before a test sees it. **There is no identifier to
strip** — there is nothing in any of them to strip, which is the point: the
schema _has nowhere to put_ an account id, an institution, a provider id or a
mask, so their absence is structural rather than the result of a filter
somebody remembered to run.

### `holdings.aggregate` — weights, and nothing per account

```jsonc
{
  "as_of": "2026-09-19",
  "currency": "USD",
  "investable_total": { "minor": "50000000", "currency": "USD" },
  "unclassified_pct": 0.02,
  "by_asset_class": [
    {
      "asset_class": "US_EQUITY",
      "weight": 0.45,
      "value": { "minor": "22500000", "currency": "USD" },
    },
    { "asset_class": "CRYPTO", "weight": 0.2, "value": { "minor": "10000000", "currency": "USD" } },
    {
      "asset_class": "US_BOND",
      "weight": 0.18,
      "value": { "minor": "9000000", "currency": "USD" },
    },
    { "asset_class": "CASH", "weight": 0.09, "value": { "minor": "4500000", "currency": "USD" } },
    {
      "asset_class": "INTL_DEV_EQUITY",
      "weight": 0.06,
      "value": { "minor": "3000000", "currency": "USD" },
    },
    {
      "asset_class": "UNCLASSIFIED",
      "weight": 0.02,
      "value": { "minor": "1000000", "currency": "USD" },
    },
  ],
  "top_positions": [
    {
      "symbol": "VTI",
      "weight": 0.26,
      "value": { "minor": "13000000", "currency": "USD" },
      "asset_class": "US_EQUITY",
      "employer_stock": false,
      "is_crypto": false,
    },
    {
      "symbol": "BND",
      "weight": 0.18,
      "value": { "minor": "9000000", "currency": "USD" },
      "asset_class": "US_BOND",
      "employer_stock": false,
      "is_crypto": false,
    },
    {
      "symbol": "BTC",
      "weight": 0.16,
      "value": { "minor": "8000000", "currency": "USD" },
      "asset_class": "CRYPTO",
      "employer_stock": false,
      "is_crypto": true,
    },
    {
      "symbol": "ACME",
      "weight": 0.12,
      "value": { "minor": "6000000", "currency": "USD" },
      "asset_class": "US_EQUITY",
      "employer_stock": true,
      "is_crypto": false,
    },
    {
      "symbol": "OLDFUND",
      "weight": 0.07,
      "value": { "minor": "3500000", "currency": "USD" },
      "asset_class": "US_EQUITY",
      "employer_stock": false,
      "is_crypto": false,
    },
  ],
  "target_allocation": [
    { "asset_class": "US_EQUITY", "weight": 0.52 },
    { "asset_class": "US_BOND", "weight": 0.28 },
    { "asset_class": "INTL_DEV_EQUITY", "weight": 0.1 },
    { "asset_class": "CRYPTO", "weight": 0.05 },
    { "asset_class": "CASH", "weight": 0.05 },
  ],
  "account_type_mix": { "taxable": 0.62, "tax_deferred": 0.38 },
  "idle_cash": {
    "total": { "minor": "1200000", "currency": "USD" },
    "floor": { "minor": "100000", "currency": "USD" },
    "min_days": 21,
    "longest_idle_days": 47,
  },
  "crypto_custody": {
    "exchange_value": { "minor": "6000000", "currency": "USD" },
    "self_custody_value": { "minor": "4000000", "currency": "USD" },
    "unknown_value": { "minor": "0", "currency": "USD" },
  },
}
```

**Dropped:** every quantity, every cost basis, every account id, every
institution. `idle_cash` is an **aggregate** precisely so 07's per-account
`max($1,000, 2% of account)` threshold can be applied without a per-account row
crossing the boundary — the threshold needs a per-account denominator, and this
scope carries none by design, so the only place it _can_ be applied is upstream.

**`unclassified_pct` is required and non-nullable.** 07 §4.3 demands it beside
every allocation and drift number, and it is I1's suppression input. A rule that
could not see the coverage would state a drift over it anyway.

### `holdings.detail` — one position, showing the shape

```jsonc
{
  "as_of": "2026-09-19",
  "currency": "USD",
  "positions": [
    {
      "symbol": "ACME",
      "asset_class": "US_EQUITY",
      "account_type": "taxable",
      "quantity": "1200.000000000000000000",
      "cost_basis": { "minor": "6850000", "currency": "USD" },
      "market_value": { "minor": "6000000", "currency": "USD" },
      "unrealized": { "minor": "-850000", "currency": "USD" },
      "oldest_lot_days": 520,
      "basis_known": true,
      "is_crypto": false,
      "is_stablecoin": false,
      "employer_stock": true,
      "expense_ratio": null,
      "peer_expense_ratio": null,
      "annual_fee_cost": null,
      "high_fee": false,
      "lots": [
        {
          "opened_days": 520,
          "quantity": "700.000000000000000000",
          "cost_basis": { "minor": "4550000", "currency": "USD" },
          "market_value": { "minor": "3500000", "currency": "USD" },
          "unrealized": { "minor": "-1050000", "currency": "USD" },
          "long_term": true,
        },
        {
          "opened_days": 95,
          "quantity": "500.000000000000000000",
          "cost_basis": { "minor": "2300000", "currency": "USD" },
          "market_value": { "minor": "2500000", "currency": "USD" },
          "unrealized": { "minor": "200000", "currency": "USD" },
          "long_term": false,
        },
      ],
    },
    // … VTI, OLDFUND, BND, VXUS, BTC, USDC
  ],
}
```

**Dropped:** account ids and institution names, still. Two minimisation choices
are worth naming because they are not obvious:

- **The tax treatment crosses as a class, not as the account.** `taxable |
tax_deferred | tax_free | unknown` is the whole of what I6 and I12 reason
  about, and it identifies nothing.
- **A lot crosses as an age, never as an open date.** An open date is the
  timestamp of a decision the user made; `opened_days` answers every question
  the catalogue asks and fingerprints nothing.

`cost_basis` and `unrealized` are **nullable together**. `USDC` in the fixture
carries `"cost_basis": null` and `"unrealized": null` — that is X6's whole
subject, and a missing basis crossing as zero would make the unrealised gain
wrong by the entire position.

**A quantity is a decimal string.** D3 is irreversible: portfolio math
multiplies quantity by price and then sums, so a float's error compounds where
nobody looks. Asserted in `scope-minimization.test.ts` → `'a quantity crosses as
a decimal string and never as a JSON number'`.

### `networth.summary` — every figure a whole hundred

```jsonc
{
  "as_of": "2026-09-19",
  "assets": { "minor": "56000000", "currency": "USD" },
  "liabilities": { "minor": "2930000", "currency": "USD" },
  "net_worth": { "minor": "53070000", "currency": "USD" },
  "trend": [
    { "month": "2026-07", "net_worth": { "minor": "51000000", "currency": "USD" } },
    { "month": "2026-08", "net_worth": { "minor": "52000000", "currency": "USD" } },
    { "month": "2026-09", "net_worth": { "minor": "53070000", "currency": "USD" } },
  ],
}
```

$2,932,000 of real liabilities ($4,820 + $3,100 + $21,400) round to $2,930,000.
The rounding is shown rather than hidden: it is 08 §4.2's rule and it is what
stops the block fingerprinting a specific balance.

### `liabilities.terms` — **new**. The block that unblocked the D family

```jsonc
{
  "as_of": "2026-09-19",
  "currency": "USD",
  "liabilities": [
    {
      "liability_ref": "LIAB_a1b2c3d4e5f6",
      "kind": "credit_card",
      "apr": 0.2399,
      "promo_apr": null,
      "promo_apr_end_date": null,
      "credit_limit": { "minor": "1500000", "currency": "USD" },
      "statement_balance": { "minor": "482000", "currency": "USD" },
      "current_balance": { "minor": "482000", "currency": "USD" },
      "minimum_payment": { "minor": "14500", "currency": "USD" },
      "payment_due_date": "2026-09-10",
      "last_payment_date": "2026-08-08",
      "last_payment_amount": { "minor": "14500", "currency": "USD" },
      "minimum_only_months": 5,
    },
    // … LIAB_b2c3d4e5f6a1 (promo ending), LIAB_c3d4e5f6a1b2 (student loan)
  ],
}
```

**Dropped:** account ids, provider ids, institution and lender names, card
masks. `liability_ref` is an opaque token in the shape the tokeniser already
mints for `cash_summary.accounts[].account_ref` — stable inside one snapshot,
meaningless outside it, and resolving it is the app's job. Asserted in
`scope-minimization.test.ts` → `'liabilities.terms identifies a liability by a
token and never by an account'`.

**Every term except the kind and the balance is nullable**, because a liability
arriving from an aggregator routinely has no APR, no limit and no statement — and
a rule that cannot see a term must withhold rather than assume one. D2 and D4
both gate on a non-null APR for exactly that reason.

### `market.rates` — **new**. The thing C1 and C2 were withholding for

```jsonc
{
  "as_of": "2026-09-19",
  "attribution": "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
  "attribution_url": "https://fred.stlouisfed.org/docs/api/terms_of_use.html",
  "rates": [
    {
      "series_id": "SAVINGSRATE",
      "kind": "savings_apy",
      "observation_date": "2026-09-15",
      "rate": 0.0425,
      "units": "percent_per_annum",
      "stale": false,
    },
    {
      "series_id": "DTB3",
      "kind": "short_term_risk_free",
      "observation_date": "2026-09-18",
      "rate": 0.0512,
      "units": "percent_per_annum",
      "stale": false,
    },
    {
      "series_id": "TERMCBCCALLNS",
      "kind": "credit_card_apr",
      "observation_date": "2026-09-01",
      "rate": 0.2124,
      "units": "percent_per_annum",
      "stale": false,
    },
    {
      "series_id": "DGS10",
      "kind": "ten_year_treasury",
      "observation_date": "2026-09-18",
      "rate": 0.0418,
      "units": "percent_per_annum",
      "stale": false,
    },
    {
      "series_id": "MORTGAGE30US",
      "kind": "mortgage_30y",
      "observation_date": "2025-02-11",
      "rate": 0.0642,
      "units": "percent_per_annum",
      "stale": true,
    },
  ],
}
```

**Carries nothing of the user's** — it is the least sensitive row in the
catalogue by a distance. What it deliberately refuses to carry is an _undated_
or _unattributed_ rate: a rate with no observation date behind it is an
assumption wearing a measurement's clothes, which is the exact failure WP 2.7
refused to commit when it wrote _"a hardcoded 4% would be a numeral nothing
could account for."_

Three properties make the figure defensible:

1. **`observation_date`** — the answer to "as of when?", and what makes `stale`
   computable rather than a judgement.
2. **`rate` is a ratio; `units` records what it was converted from.** FRED
   publishes `DGS3MO` in percent (`4.25` means 4.25%), and the builder divides.
   This is the one reinterpretation the snapshot performs on a provider value,
   and it is there rather than in a rule because the alternative is every
   consumer dividing by 100 and one of them forgetting.
3. **`attribution` rides with the data.** 01 §4.3 makes the exact sentence a
   licence condition (WP 3.4 §4), and a rule that prints a rate is a surface
   that owes it. `scope-minimization.test.ts` → `'the FRED attribution rides
with every figure taken from FRED'` asserts the string appears verbatim in
   the caveats of every insight that shows a rate.

**A stale row is refused, not labelled.** `MORTGAGE30US` is in the fixture
marked stale specifically so that behaviour stays tested: `'no rule cites a
stale rate'` walks every insight's evidence and asserts none of them references
`market_rates.rates[4]`. The reasoning: a stale _price_ on a holding still tells
you roughly what you own; a stale _rate_ used as a benchmark makes the spread
wrong by however much rates moved, and the spread is the whole insight.

---

## 4. The alert budget applied after the investing wave

The scenario 07 §7.4 exists for, run rather than described: every WP 3.10 rule
released at once on the seed. **22 proposals.**

```
dashboard (5)
  X1  urgent   —          crypto.net_worth_share
  I4  urgent   —          investing.concentration.VTI
  I5  urgent   —          investing.employer_stock.ACME
  D4  warning  $588.69    debt.promo_ending.LIAB_b2c3d4e5f6a1
  D2  warning  $579.94    debt.rate_above_market.LIAB_c3d4e5f6a1b2

list, positions 6–20
  I2  warning  $297.50    investing.expense_ratio.OLDFUND
  D2  warning  $132.55    debt.rate_above_market.LIAB_a1b2c3d4e5f6
  D3  warning  —          debt.minimum_only.LIAB_a1b2c3d4e5f6
  D6  warning  —          debt.missed_payment.LIAB_a1b2c3d4e5f6
  I1  warning  —          investing.drift.CRYPTO
  I1  warning  —          investing.drift.US_BOND
  I3  warning  —          investing.idle_cash
  X3  notable  $1,024.00  crypto.idle_stablecoins.USDC
  X2  notable  —          crypto.exchange_custody
  X5  notable  —          crypto.loss_lot.BTC.0
  X6  notable  —          crypto.missing_basis.USDC
  D1  notable  —          debt.payoff_order
  D5  notable  —          debt.principal_against_market.LIAB_a1b2c3d4e5f6
  D5  notable  —          debt.principal_against_market.LIAB_b2c3d4e5f6a1
  D5  notable  —          debt.principal_against_market.LIAB_c3d4e5f6a1b2

overflow (2, withheld from the list, not deleted)
  I1  notable  —          investing.drift.US_EQUITY
  I6  notable  —          investing.loss_lot.ACME.0

below the $50 floor: none
```

Three things this run demonstrates that a description could not:

- **The three P0s lead, and none of them claims a dollar figure.** `rank()`'s
  severity term is additive and dominant precisely so an urgent finding with no
  figure outranks a large but merely notable saving. If the $50 floor were
  applied literally to everything, **X1 would have been suppressed** — crypto at
  a fifth of net worth, filtered out for claiming nothing. That is what the
  floor's exemption for a null impact is for, and
  `alert-budget-wave.test.ts` → `'never floors out a risk finding that claims no
impact'` is its test.
- **X3 at $1,024 sits below D2 at $132.55.** Severity beats size, deliberately.
  A stablecoin earning nothing is worth more money and less urgency than a card
  rate above the market.
- **The whole catalogue at once still fits.** Phase 2's fourteen plus WP 3.10's
  seventeen = **33 proposals**: 5 on the dashboard, 20 in the list, 12 in
  overflow, 1 below the floor. Nothing is lost — every proposal still lands in
  `insights` as `pending_review` with its evidence, and the budget is applied at
  read time, so raising the ceiling needs no re-run and lowering it loses
  nothing.

---

## 5. The copy linter, before and after a deliberate violation

`lintInsightCopy` is used **unchanged**. No rule was added to it and none was
relaxed.

**Before** — every template in the wave, with the numeral rule live (a trace
context built from the snapshot plus each insight's own declared derivations):

```
✓ every template WP 3.10 added passes the linter on the seed
✓ every manifest purpose and display name is sayable too
✓ no new insight puts a raw identifier in a sentence
```

**After** — I2's title replaced with `'You should switch to the best fund
instead'`, a sentence that trips two of 07 §7.2's patterns at once:

```
× every template WP 3.10 added passes the linter on the seed

AssertionError: I2 investing.expense_ratio.OLDFUND:
  [{"rule":"banned_phrase","field":"title","detail":"you should"},
   {"rule":"banned_phrase","field":"title","detail":"best stock/fund/investment"}]
  expected [ …(2) ] to deeply equal []

Test Files  1 failed (1)
     Tests  1 failed | 3 passed (4)
```

Reverted; `4 passed (4)`.

The standalone case the dispatch names is `copy-lint.test.ts` → `'"the best
fund" fails the linter'`, which also walks the neighbouring forms — `sell`,
`we recommend`, `risk-free`, `guaranteed returns`, `will grow`, `should invest
in`, `can't lose` — each as a sentence an investing rule could plausibly have
written.

### The banned list shaped the copy, in three places worth naming

- **"Selling"** survives `\bsell\b` (the boundary fails before `-ing`) and it is
  07's own preferred form: _"Selling in a taxable account would realize $Y of
  gains."_ I2 and I4 both use it, and both pair it with the gain.
- **X5's dated wash-sale flag is not printed.** 07 §4.4 wants
  `wash_sale_applies_to_digital_assets: false # as of 2026-09` as a dated config
  flag. The flag is `CRYPTO_WASH_SALE_WATCH` in `builtin/shared.ts`; the _date_
  is deliberately kept out of the copy, because `2026-09` is not a snapshot
  value and the numeral tracer cannot tell a statutory date from an invented
  one. The copy says "as this app last checked" and the constant is where a
  reviewer reads the date.
- **No rule prints a statutory constant.** I6's `$3,000` ordinary-income cap,
  I9's IRA limit — each would fail step 7 for exactly the reason a hardcoded 4%
  would. They are described in words or not at all.

### Every recommendation is paired with its cost

07 §7.2's rule, and the reason I4 and I5 declare `holdings.detail` as well as
`holdings.aggregate` — the aggregate says the position is 26% of the portfolio,
and the detail block is the only place the gain a trim would realise can be
read:

> VTI is 26% of investable assets — $130,000.00 of $500,000.00. A bad year for
> this one holding moves that share of the portfolio on its own, whatever the
> rest of it does. **Reducing it inside a taxable account would realise about
> $32,000.00 of gains**, and the tax on that depends on your bracket and on how
> long each lot has been held.

When the cost cannot be stated, the rule says so rather than recommending
anyway. I5 on `ACME`, which is taxable but at a loss:

> …**What reducing the position would cost is not stated here: this app cannot
> see taxable lots carrying a gain for it.**

### Nothing compounds a speculative return into a headline

Four rules refuse a figure 07 §3.3 asks for, each for a stated reason:

| Rule | 07's formula                        | Why no figure                                                     |
| ---- | ----------------------------------- | ----------------------------------------------------------------- |
| I3   | `x × (expected_return − sweep_apy)` | `expected_return` is a forecast                                   |
| D5   | `\|apr − r_after_tax\| × amt`       | `r_after_tax` is a forecast                                       |
| X1   | `val × hist_max_dd`                 | no drawdown series exists; a hardcoded `dd` is the hardcoded 4%   |
| I1   | `Δσ`                                | no volatility series exists; the output is a weight gap in points |

X1's resolution is the dispatch's own phrase — **drawdown framing, never a
projection**. `$0 × 0.5` is a _stated conditional over the position that exists
today_, `0.5` is already on `DERIVATION_LITERALS`, the validator re-computes it,
and the copy calls it a stress:

> Crypto is worth $100,000.00 against a net worth of $530,700.00, and 20% of the
> portfolio. **If it fell by half from where it is today, about $50,000.00 would
> go with it. That is a stress applied to the position you hold now, not a
> forecast of anything.**

---

## 6. Sabotage

Four controls, each broken deliberately, observed red, and restored. All four
were red on the first valid attempt.

### 6.1 I1's self-suppression — `0.1` → `0.9`

```
packages/contexts/insights/src/advisors/builtin/shared.ts:190
- export const UNCLASSIFIED_SUPPRESSION_THRESHOLD = 0.1;
+ export const UNCLASSIFIED_SUPPRESSION_THRESHOLD = 0.9;
```

```
× I1 withholds when unclassified exceeds 10 percent
× the ceiling is a tenth, and the comparison is strictly greater

AssertionError: I1 must withhold above the ceiling:
  expected [ { …(16) }, { …(16) }, { …(16) } ] to deeply equal []
AssertionError: expected 0.9 to be 0.1

Test Files  1 failed (1)
     Tests  2 failed | 3 passed (5)
```

The three objects in that failure are the drift insights I1 should have
withheld. Restored: `5 passed (5)`.

The test is a **pair**, not a single assertion — same portfolio, same targets,
same weights, one number moved past the ceiling, three insights down to zero —
and it asserts that the two snapshots differ in exactly that one field, so
nothing else can be the explanation. A third test pins what is being withheld
(`US_EQUITY`, `US_BOND`, `CRYPTO`), because if I1 had nothing to say on the
clean case the pair would pass vacuously.

### 6.2 The copy linter — a banned phrase in a real template

See §5. Two violations, both named. Restored.

### 6.3 `networth.summary`'s $100 rounding — one figure off by 17¢

```
- net_worth: usd(53_070_000),
+ net_worth: usd(53_070_017),
```

```
× networth.summary is rounded to $100
AssertionError: net_worth is not a whole hundred: 53070017: expected 17n to be 0n

Test Files  1 failed (1)
     Tests  1 failed | 7 passed (8)
```

Restored: `8 passed (8)`.

### 6.4 A cost basis leaked into `holdings.aggregate`

```
  { symbol: 'VTI', weight: 0.26, value: usd(13_000_000), asset_class: 'US_EQUITY',
+   cost_basis: usd(9_800_000),
    employer_stock: false, is_crypto: false },
```

```
× holdings.aggregate emits no quantity, no cost basis and no account id
× networth.summary is rounded to $100
× holdings.detail carries a lot age and never a lot date
× liabilities.terms identifies a liability by a token and never by an account
× a quantity crosses as a decimal string and never as a JSON number
× the FRED attribution rides with every figure taken from FRED
× no rule cites a stale rate

Test Files  1 failed (1)
     Tests  7 failed | 1 passed (8)
```

**The whole file went red, and that is the stronger result.** The leak never
reached the assertion: `AdvisorSnapshotSchema` is `strictObject`, so
`portfolioBlocks()` threw at fixture construction and every test in the file
failed with it. The minimisation rule for this scope is not enforced by the
test — it is enforced by the contract, and the test is the second line. Adding
`cost_basis` to `holdings.aggregate` is not something a careless mapper can do;
it is a visible, reviewable diff in the published schema. Restored:
`8 passed (8)`.

### 6.5 The one control that cannot be sabotaged, and why that is the point

`'no rule proposes an action outside the four non-acting kinds'` cannot be made
red by editing a rule. `ProposedActionKind` is a four-member union and
`ProposedActionSchema` a `z.enum` over it, so `kind: 'execute'` is a TypeScript
error before it is a test failure — `'execute'`, `'transfer'` and `'trade'` are
absent _from the type_, not absent by policy. The structural proof lives in
`pending-review.test.ts` (WP 2.6) and this file asserts the catalogue half: every
action all seventeen rules emit is `suggest_only`, and every one carries a
`null` url, which matters because a built-in's `egress_allowlist` is empty and an
`open_url` could therefore only point somewhere nobody vetted.

---

## 7. What the orchestrator must apply

### 7.1 The `SnapshotBuilder` additions (scope → source reader → fields)

All four new blocks carry **`sourcedInPhase2: false`**. `#blockFor` has no case
for them and returns `null`, so a granted-but-unsourced scope emits **no key** —
exactly like an ungranted one. That is the correct state today: a `true` there
would promise a block nothing can fill, and an advisor cannot tell "empty" from
"none" and would happily reason about zero.

`packages/contexts/insights/src/snapshot/builder.ts` and `ports.ts` are not this
work package's to change. Here is exactly what to add.

**Step 1 — new ports** in `snapshot/ports.ts`. Each returns `null` when the
module is off or has no data; the builder already treats `null` as "no key".

| Port method                                 | Reads from                                                    | Returns                 |
| ------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| `investments.holdings({ userId, asOf })`    | `@ctx/investments` analytics                                  | the four reports below  |
| `investments.liabilities({ userId, asOf })` | `@ctx/ledger` liability accounts + Plaid liabilities (WP 3.7) | terms per liability     |
| `marketData.rates({ userId, asOf })`        | `@ctx/integrations` `PriceSource.macro()`                     | the tracked FRED series |

**Step 2 — `#blockFor` cases.** Four new `case` arms, then flip the four
`sourcedInPhase2` flags in `contract/scopes.ts` to `true` in the same commit.
Flipping a flag without its arm produces a silent no-key; adding an arm without
the flag produces dead code.

#### `holdings.aggregate` → `#holdingsAggregate`

Source: WP 3.3's pure analytics, called once over one `ValuationSet`.

| Snapshot field        | Analytics source                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `investable_total`    | `ConcentrationReport.investableTotal`                                                                                                                           |
| `unclassified_pct`    | `AllocationReport.unclassifiedPct` (**required** — never omit)                                                                                                  |
| `by_asset_class[]`    | `allocationByAssetClass(...).slices` → `{key → asset_class, weight, value}`; **drop `holdingIds`**                                                              |
| `top_positions[]`     | `ConcentrationReport.positions`, top 32 by weight → `{symbol, weight, value, asset_class, employer_stock, is_crypto}`; **drop `securityId` and `holdingCount`** |
| `target_allocation[]` | the user's `AllocationTarget[]`. **Emit `[]` when unset** — never a default (§8 Q9)                                                                             |
| `account_type_mix`    | value by account tax treatment ÷ total                                                                                                                          |
| `idle_cash`           | `IdleCashReport`: `idleTotal → total`, `floor`, `minDays → min_days`, `max(rows[].idleDays) → longest_idle_days`. **Aggregate only — no per-account row**       |
| `crypto_custody`      | value of CRYPTO holdings split by custody tag. **No wallet, venue or address**                                                                                  |

Two rules the builder must hold: a `securityId` never crosses (`symbol` only),
and an asset class present in the _targets_ but absent from the portfolio should
be emitted as a **zero-weight `by_asset_class` row** rather than omitted —
otherwise I1 skips a real drift of the whole target weight, because it cannot
cite a ref that does not resolve. This is the one known behavioural gap in I1 and
it is commented at the `continue` in `investing/allocation.ts`.

#### `holdings.detail` → `#holdingsDetail`

| Snapshot field                                                       | Source                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `quantity`, `cost_basis`, `market_value`, `unrealized`               | the lot engine (WP 3.2). `cost_basis`/`unrealized` **`null` together** when basis is unknown — never zero |
| `oldest_lot_days`, `lots[].opened_days`                              | `asOf − lot.open_date`, in days. **Never emit the date**                                                  |
| `account_type`                                                       | the account's tax treatment as a class. **Never the account**                                             |
| `basis_known`                                                        | `cost_basis !== null`                                                                                     |
| `expense_ratio`, `peer_expense_ratio`, `annual_fee_cost`, `high_fee` | `FeeRow.expenseRatio`, the seed table's comparable, `FeeRow.annualCost`, `FeeRow.high`                    |
| `is_crypto`, `is_stablecoin`, `employer_stock`                       | asset class `CRYPTO`; the stablecoin list; **the user's own tag only — never infer an employer**          |
| `lots[].long_term`                                                   | `holding_period_start_date` ≥ 365 days                                                                    |

#### `liabilities.terms` → `#liabilitiesTerms`

`liability_ref` via the **existing tokeniser** (`snapshot/tokens.ts`) — the same
call that mints `account_ref`, so the two share one construction and one
re-pseudonymisation cost. Fields map straight from the liability read model;
`minimum_only_months` is counted by the reader that holds the payment history and
is `null` when there is not enough of it. **No account id, no lender name, no
mask.**

#### `market.rates` → `#marketRates`

Reads `@ctx/integrations`. Three duties the builder owns and no rule can:

1. **Convert to a ratio.** FRED publishes these series in percent. Divide by 100
   and record what you divided in `units`. **Refuse any series whose units are
   not percent-per-annum** rather than converting a basis-point or index series
   into a plausible-looking rate — that is the one reinterpretation in the whole
   snapshot and it must fail closed.
2. **Compute `stale`** against the same freshness ladder WP 3.4 §5.1 uses for
   prices. It is computed, never stored.
3. **Carry `ATTRIBUTIONS.fred.text` verbatim**, ® included, into `attribution`,
   and `linkUrl` into `attribution_url`. A paraphrase of a licence condition is a
   new licence condition.

`kind` is the join key. A rule selects by `kind`, never by `series_id`, so the
mapping from deployment-configured series to `MarketRateKind` lives here.

**Step 3 — delete the test fixtures' merge branch.** Once the arms land,
`test/advisors/seed.ts` should stop merging `portfolioBlocks(scopes)` and let
`SnapshotBuilder` produce the blocks. The schema parse in
`test/fixtures/portfolio.ts` is worth keeping as a belt.

### 7.2 The contract regeneration this work package did not do

See §9. One command, in a package this work package does not own.

### 7.3 Enablement

All seventeen ship **registered and off** (`defaultEnabled: false`), for two
reasons: 07 §7.4 releases debt in week two and investing in week three, and the
scopes they read have no reader behind them yet — an enabled rule would return
nothing rather than something. Turning one on is a single `advisors.enabled`
update after §7.1 lands; no deploy.

---

## 8. Check results

Run at the landing commit, foreground.

| Check                                                                                                      | Result                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project insights --project insights-db`                                            | **193 passed, 2 failed** — both in `contract-parity.test.ts`; 20 of 21 files green |
| `pnpm exec tsc -b --noEmit`                                                                                | **clean**, no output                                                               |
| `pnpm exec eslint packages/contexts/insights`                                                              | **clean**, exit 0                                                                  |
| `pnpm exec prettier --check packages/contexts/insights docs/evidence/phase-3/wp3.10-advisor-catalog-v2.md` | see below                                                                          |

`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`
for the vitest run.

### Test inventory — six new files, the plan's exact names

| File                              | The dispatch's required test                                                                                                                      | Other tests                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `test/catalog-v2.test.ts`         | `'every new rule produces at least one resolvable evidence ref on the seed'`, `'every new rule returns zero insights when its inputs are absent'` | 6 more: pipeline parity, scope honesty, the P0 set, the gap list, wave/enablement, deterministic basis                       |
| `test/i1-suppression.test.ts`     | `'I1 withholds when unclassified exceeds 10 percent'`                                                                                             | 4 more: the strict-`>` boundary, what is withheld, points-not-dollars, the unset-target case                                 |
| `test/scope-minimization.test.ts` | `'holdings.aggregate emits no quantity, no cost basis and no account id'`, `'networth.summary is rounded to $100'`                                | 6 more: lot ages, liability tokens, decimal quantities, scope-row honesty, FRED attribution, stale rates                     |
| `test/copy-lint.test.ts`          | `'"the best fund" fails the linter'`                                                                                                              | 3 more: the full wave passes, manifests pass, no raw identifier in prose                                                     |
| `test/no-execute-action.test.ts`  | `'no rule proposes an action outside the four non-acting kinds'`                                                                                  | 2 more: every action is `suggest_only` with a null url, no undeclared impact                                                 |
| `test/alert-budget-wave.test.ts`  | (the budget applied after the wave)                                                                                                               | 6: dashboard/list/overflow, P0s lead, the null-impact exemption, the $50 floor, stable ordering, the whole catalogue at once |

Plus `test/fixtures/portfolio.ts` (the five blocks, schema-parsed) and 17 new
entries in `test/advisor-golden.test.ts` — every new rule's exact sentence
pinned, and asserted silent on the control case.

### Existing tests changed, and why

- `test/advisor-golden.test.ts` — C1's and C2's summaries now carry the market
  rate. Both changes are the WP's point; the keys, severities and impact figures
  are byte-identical.
- `test/catalog.test.ts` — the disabled-rule count moved from 6 to 23.
- `test/advisors/seed.ts` — `seedSnapshot('drift')` merges the portfolio blocks;
  `control` and `tight` deliberately get none, which is what keeps the golden
  suite's control half meaningful for these families.

No test was weakened or deleted.

---

## 9. Open items and deviations

### 9.1 `contract-parity.test.ts` is red. This is a seam, and it is owed.

**What happened.** The two new scopes were added to `ADVISOR_SCOPES`, and the
new snapshot blocks to `AdvisorSnapshotSchema`. `contract/json-schema.ts` emits
the published artefacts _from those zod definitions_, and
`contract-parity.test.ts` asserts byte parity with the files on disk. The
artefacts were regenerated, then **reverted on the orchestrator's instruction**
that `@core/contracts` is not this work package's to change. The zod definitions
and the on-disk files therefore disagree, and the test says so.

**Why it could not be avoided.** The orchestrator's suggestion — _"express the
new scopes within the existing contract's scope mechanism (scope names are data,
not schema)"_ — is half right. `SCOPE_CATALOGUE` is data. But `ADVISOR_SCOPES`
is also the source of `AdvisorScopeSchema` (`contract/request.ts:31`:
`z.enum(ADVISOR_SCOPES)`), which is published in `request.schema.json`; and
`AdvisorSnapshotSchema` is a `strictObject`, so a `liabilities_terms` key has
nowhere to live without a schema block. Without both, no rule in this work
package can typecheck, let alone read data. The alternatives were to deliver
nothing, or to deliver the rules and hand the artefact regeneration to the
package's owner. This is the second.

**The exact minimal change, and the exact command.**

```bash
# from the repo root, Node 26
node --experimental-strip-types - <<'EOF'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { advisorSchemaDocuments, serialiseSchema }
  from './packages/contexts/insights/src/contract/json-schema.ts';
for (const doc of advisorSchemaDocuments()) {
  writeFileSync(join('packages/contracts/advisor/v1', doc.file),
                serialiseSchema(doc.document) + '\n');
}
EOF
pnpm exec prettier --write packages/contracts/advisor/v1/
```

The semantic diff this produces, verified before the revert:

| File                   | Change                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response.schema.json` | **none**                                                                                                                                                                                             |
| `manifest.schema.json` | `requires_scopes` enum gains `"liabilities.terms"`, `"market.rates"`                                                                                                                                 |
| `request.schema.json`  | the same two enum members; `granted_scopes.maxItems` 13 → 15; two new **optional** snapshot blocks (`liabilities_terms`, `market_rates`); added fields on `holdings_aggregate` and `holdings_detail` |

**Strictly additive.** No field removed, no field made required, no constraint
tightened, nothing changed in the response. A sidecar pinned to contract major
`1` keeps working: it receives no block it did not ask for, because a scope it
was never granted produces no key.

**The version bump is also owed and was also not made.**
`ADVISOR_CONTRACT_VERSION` in `packages/contracts/src/index.ts` and
`ADVISOR_ARTEFACT_VERSION` in `contract/json-schema.ts` both read `'1.0.0'`.
Additive enum members and additive optional blocks are a semver **minor**:
`1.1.0` in both, major still `1`. `contract-parity.test.ts` asserts the two
agree, so they must move together. That decision belongs to the package's owner,
not to this agent.

### 9.2 The "raw SQL into `securities`" report is a false positive

A concurrent WP 3.8 agent reported
`insights/.../crypto/positions.ts` reaching into the `securities` table. It does
not. The file's only imports are:

```
../../../contract/response.ts   (type only)
../../../contract/snapshot.ts   (type only)
../../manifest.ts · ../../support.ts · ../shared.ts
```

Its only data source is `context.snapshot.holdings_detail`. A grep for
`sql|securities|pg|query(|db.|pool|client.` across the whole of
`src/advisors/builtin/` returns **three hits, all of them the English word
"securities" in prose caveats** — the wash-sale sentence ("treated as property
rather than as securities"). There is no SQL, no database handle and no table
reference anywhere in the tree this work package added. `@ctx/insights` owns no
investments table and reaches none.

### 9.3 Five rules in the brief are gaps, each naming a field

Recorded in `CATALOGUE_GAPS` and asserted by `catalog-v2.test.ts` → the missing
set is exactly `['I7','I8','I9','I10','X4']` and no sixth.

| Rule                    | Field it needs                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I7** wash sale        | disposals (a sale, its date, the loss), across _every_ account including IRAs — 07 §4.4's "trap most software misses". A rule seeing some accounts produces confident false negatives |
| **I8** 401(k) match     | year-to-date payroll deferrals and the plan's match formula                                                                                                                           |
| **I9** IRA headroom     | contributions to date, and a MAGI test                                                                                                                                                |
| **I10** HSA headroom    | an HDHP enrolment flag and contributions to date                                                                                                                                      |
| **X4** staking receipts | an inflow _event_. Every scope in this brief describes a position, not a movement                                                                                                     |

**I10 is marked P0 in the dispatch and does not exist.** The four scopes this
work package was given carry no contribution and no plan term, and none of the
five scopes in the dispatch's own list would. It is recorded as a gap rather
than written over data that is not there. Closing it needs a sixth scope —
something like `contributions.ytd` — which is a scope decision, not an agent's.

### 9.4 U8, C5 and C6 are now unblocked and not written

`liabilities.terms` supplies exactly the three fields WP 2.7 named for all
three. They are cash and subscription rules, this brief was the I, D and X
families, and releasing them is a different wave's decision. Their
`CATALOGUE_GAPS` reasons were **rewritten** from "the data does not exist" to
"unblocked, not yet written" — the old claim is no longer true, and a stale gap
reason is worse than none.

### 9.5 Smaller things, recorded

- **I1 skips a target class the portfolio does not hold.** That is a real drift
  of the whole target weight, and `by_asset_class` has no row to cite for it.
  Citing an unresolvable ref would fail the pipeline, so the case is skipped and
  §7.1 asks the builder to emit a zero-weight row. Commented at the `continue`.
- **C1 names the published rate but claims no dollar figure for the gap.** Its
  excess is itself a derivation (cash less a three-month average), and nesting
  that into a spread gives a six-input expression whose evaluation order must
  match the parser's exactly. C2 shows that saving per account, where the
  balance _is_ a ref. Deliberate, and reversible with one careful derivation.
- **D6 ships at `warning`.** See §2's priority note. It is 07's P0-safety class
  and the dispatch's P0 list did not include it; recorded for a ruling.
- **S1 and S5 are untouched.** WP 2.7 ruled them out for an exact amount and a
  merchant-first-seen date, neither of which is investments data. Not
  relitigated.
