<!-- SPDX-License-Identifier: MIT -->

# WP 3.10a — the four snapshot readers, and what turning the rules on actually showed

WP 3.10 shipped seventeen rules **registered and off** and named the reason: four
of the scopes they read — `holdings.aggregate`, `holdings.detail`,
`liabilities.terms`, `market.rates` — had no reader, so `SnapshotBuilder#blockFor`
returned `null` and every one of them would have produced nothing. WP 3.9 wrote
that claim down as a test (`'every advisor scope has a reader'`) and stopped at
the seam, because `snapshot/**` is context source and WP 3.9's brief forbade it.

This work package closes the seam: the two ports, the four `#blockFor` arms, the
four `sourcedInPhase2` flips, the five wiring call sites, and the enablement.

It also found two things that neither prior work package could have found from
where it stood, both recorded in §7 rather than smoothed over:

1. **Two of the four scopes cannot be granted at all.** `snapshot_grants`' CHECK
   constraint still enumerates Phase 2's thirteen scopes. `liabilities.terms` and
   `market.rates` are rejected with a `23514`. A migration is owed.
2. **Three investing rules are enabled and structurally silent** — not for a
   scope reason, for a _field_ reason. `holdings.aggregate` has a reader; three
   of its fields have no source.

---

## 1. What landed

| Piece                                                                                  | File                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `InvestmentsPort.holdings` / `.liabilities`, `MarketDataPort.rates`, + in-memory fakes | `packages/contexts/insights/src/snapshot/ports.ts`     |
| `#holdingsAggregate`, `#holdingsDetail`, `#liabilitiesTerms`, `#marketRates`           | `packages/contexts/insights/src/snapshot/builder.ts`   |
| the four `sourcedInPhase2: false → true` flips                                         | `packages/contexts/insights/src/contract/scopes.ts`    |
| `liability` token domain                                                               | `packages/contexts/insights/src/snapshot/tokens.ts`    |
| seventeen rules flipped `defaultEnabled: true`                                         | `packages/contexts/insights/src/advisors/catalogue.ts` |
| `createInsightsInvestmentsPort`, `createInsightsMarketDataPort`                        | `apps/api/src/domain.ts`                               |

The arm and its flag landed **in one change**, which is the rule `scopes.ts`'
header states and the reason it is worth restating: an arm without a flag is dead
code, and a flag without an arm is a silent no-key — a snapshot that omits a
block an advisor was granted, with nothing anywhere saying so.

### The port → reader map

| Scope                | Arm                  | Port method                       | Reads                                                                          |
| -------------------- | -------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `holdings.aggregate` | `#holdingsAggregate` | `investments.holdings`            | `readHoldings` + `priceHoldings` + WP 3.3 `allocationOf`/`concentrationOf`     |
| `holdings.detail`    | `#holdingsDetail`    | `investments.holdings` (memoised) | the same valuation, plus `drizzleLotStore.listLotsForSecurity` and `feeDragOf` |
| `liabilities.terms`  | `#liabilitiesTerms`  | `investments.liabilities`         | `listAccounts` (classification `liability`) + WP 3.7's `liabilityTermsFor`     |
| `market.rates`       | `#marketRates`       | `marketData.rates`                | `@ctx/integrations` `FredSource.macro()` over `TRACKED_MACRO_SERIES`           |

`holdings.aggregate` and `holdings.detail` are two grants over **one** valuation.
The builder memoises the `holdings` call for the life of one `build()`, because
valuing a portfolio twice in one snapshot could answer twice differently if a
price refresh landed in between, and an advisor handed two disagreeing views of
one portfolio has no way to notice. Pinned by `'values the portfolio once for
both blocks'`, which counts the calls.

### The five wiring call sites

Every site passes the **real** ports. None passes a fake.

| Site                                               | `investments`                              | `marketData`                                                  |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `apps/api/src/modules.ts` (worker, nightly)        | `createInsightsInvestmentsPort(db, clock)` | `createInsightsMarketDataPort({ source: fredSourceOf(...) })` |
| `apps/api/src/routes/insights.ts` (on-demand)      | `createInsightsInvestmentsPort(db, clock)` | `createInsightsMarketDataPort({ source: undefined })`         |
| `apps/api/test/db/phase2-wiring.test.ts`           | real                                       | real, `source: undefined`                                     |
| `apps/api/test/db/insights-routes.test.ts`         | real                                       | real, `source: undefined`                                     |
| `apps/api/test/db/insights-pending-review.test.ts` | real                                       | real, `source: undefined`                                     |

**`source: undefined` is not a fake — it is feature detection, and it produces a
real asymmetry worth naming.** There is one FRED source in the deployment and it
exists only when a key file does; `app.ts` builds no `MarketDataRuntime` at all,
because the API process runs no jobs and must not declare the 03:45 schedule row.
So an **on-demand** advisor run in the API process emits no `market_rates` block
while the **nightly** run in the worker does. C1, C2, D2 and X3 fall back to "the
best rate you already hold" in the first case — the Phase 2 behaviour, unchanged.
The alternative would have been a hardcoded rate, and WP 2.7 is explicit that "a
hardcoded 4% would be a numeral nothing could account for".

---

## 2. A rendered snapshot per scope, from the real ports

Produced by `apps/api/test/db/phase3-advisors.test.ts` → `'the real ports render
every new scope, and no identifier crosses'`, over a real Postgres database: the
accounts linked over HTTP through `POST /connections`, the `securities` /
`holdings` / `prices` rows seeded with SQL (the only writer at this commit is WP
3.7's Plaid sync), and the **real** `createFredSource` over a fake transport.

Every identifier is stripped. The test asserts this three ways: against the three
ids it knows the value of (`securities.id`, both `accounts.id`, the `users.id`),
against the field names `security_id` and `account_id`, and against **any uuid in
any position** — which is what catches a fourth nobody thought to name.

### `holdings.aggregate`

```json
{
  "as_of": "2026-09-24",
  "currency": "USD",
  "investable_total": { "minor": "2500000", "currency": "USD" },
  "unclassified_pct": 0,
  "by_asset_class": [
    { "asset_class": "US_EQUITY", "weight": 1, "value": { "minor": "2500000", "currency": "USD" } }
  ],
  "top_positions": [
    {
      "symbol": "VTI",
      "weight": 1,
      "value": { "minor": "2500000", "currency": "USD" },
      "asset_class": "US_EQUITY",
      "employer_stock": false,
      "is_crypto": false
    }
  ],
  "target_allocation": [],
  "account_type_mix": { "unknown": 1 }
}
```

No `securityId`, no `holdingCount`, no quantity, no basis — an aggregate is
weights and values, and a share count would make it a position report.
`idle_cash` and `crypto_custody` are **absent as keys**, not `null` and not zero:
the holder owns no crypto and there is no dwell history to measure idleness
against. `target_allocation: []` is §8 Q9's rule — an unset target never becomes
an implied 60/40 — and here it is empty for a second reason, which §7.2 covers.

### `holdings.detail`

```json
{
  "as_of": "2026-09-24",
  "currency": "USD",
  "positions": [
    {
      "symbol": "VTI",
      "asset_class": "US_EQUITY",
      "account_type": "unknown",
      "quantity": "100.000000000000000000",
      "cost_basis": { "minor": "1500000", "currency": "USD" },
      "market_value": { "minor": "2500000", "currency": "USD" },
      "unrealized": { "minor": "1000000", "currency": "USD" },
      "oldest_lot_days": 0,
      "basis_known": true,
      "is_crypto": false,
      "is_stablecoin": false,
      "employer_stock": false,
      "expense_ratio": 0.0095,
      "peer_expense_ratio": null,
      "annual_fee_cost": { "minor": "23750", "currency": "USD" },
      "high_fee": true,
      "lots": []
    }
  ]
}
```

The account crosses as `account_type`, a tax-treatment class, and never as an
account. The quantity is a **decimal string** at the kernel's scale, never a JSON
number. `lots: []` because this fixture seeds no `tax_lots` rows; where lots do
exist they carry `opened_days`, never a date — asserted by scanning the whole
serialised `positions` array for an ISO date and finding none.

`peer_expense_ratio` is `null` because no comparable-fund table exists in any
Phase 3 source, so I2 fires on the absolute `high_fee` trigger (0.95% > 0.5%) and
never on the relative one. That is why this position shows `high_fee: true` with
no peer to compare against.

### `liabilities.terms`

```json
{
  "as_of": "2026-09-24",
  "currency": "USD",
  "liabilities": [
    {
      "liability_ref": "LIAB_6ceb37b93bf3",
      "kind": "credit_card",
      "apr": null,
      "promo_apr": null,
      "promo_apr_end_date": null,
      "credit_limit": null,
      "statement_balance": null,
      "current_balance": { "minor": "482000", "currency": "USD" },
      "minimum_payment": null,
      "payment_due_date": null,
      "last_payment_date": null,
      "last_payment_amount": null,
      "minimum_only_months": null
    }
  ]
}
```

`LIAB_6ceb37b93bf3` is minted by the **existing** tokeniser in the `liability`
domain — the same call that mints `account_ref`, so the two share one
construction and one re-pseudonymisation cost. The account id is the only
identifier the port type carries and it exists solely so the builder can mint
this; the test asserts it appears nowhere in the block, including inside the ref.

**Every term is `null`, and that is the honest answer**, not a gap in the test.
This account has no `connection_sync_facts` liability fact behind it, and the
adapter's rule is _read what WP 3.7 lands, never a fake_: an account with no
terms row is still a liability — it owes money — and it crosses with the terms
`null`, which is the state D2 and D4 gate on. A fabricated APR would be the one
number in this block nobody could trace. The balance is stated as a **positive**
amount owed, because every rule reading it multiplies by a rate and a negative
would flip the sign of the cost.

### `market.rates`

```json
{
  "as_of": "2026-09-24",
  "attribution": "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
  "attribution_url": "https://fred.stlouisfed.org/docs/api/terms_of_use.html",
  "rates": [
    {
      "series_id": "DGS3MO",
      "kind": "short_term_risk_free",
      "observation_date": "2026-09-24",
      "rate": 0.0512,
      "units": "percent_per_annum",
      "stale": false
    },
    {
      "series_id": "DGS10",
      "kind": "ten_year_treasury",
      "observation_date": "2026-09-24",
      "rate": 0.0431,
      "units": "percent_per_annum",
      "stale": false
    },
    {
      "series_id": "SNDR",
      "kind": "savings_apy",
      "observation_date": "2026-09-24",
      "rate": 0.0375,
      "units": "percent_per_annum",
      "stale": false
    },
    {
      "series_id": "TERMCBCCALLNS",
      "kind": "credit_card_apr",
      "observation_date": "2026-09-24",
      "rate": 0.2147,
      "units": "percent_per_annum",
      "stale": false
    },
    {
      "series_id": "MORTGAGE30US",
      "kind": "mortgage_30y",
      "observation_date": "2026-09-24",
      "rate": 0.0634,
      "units": "percent_per_annum",
      "stale": false
    }
  ]
}
```

The three duties §7.1 gives the builder, each with its test:

1. **Percent → ratio, recording what was converted.** `"5.12"` → `0.0512`
   exactly, by shifting the decimal point in the string rather than dividing:
   `5.12 / 100` is two roundings and prints `0.051200000000000002`-shaped figures
   a reviewer cannot tell from a bug. `units` records what we converted _from_,
   so the conversion is auditable rather than inferable from the size of the
   number. A series whose units are **not** percent-per-annum is **refused** — an
   index is dropped, never divided by 100 into a plausible-looking 3.184 "rate" —
   and a block whose every row was refused emits **no key at all**, because an
   advisor reads `rates: []` as "the market pays nothing", which is a claim.
2. **`stale` is computed, never read**, against WP 3.4 §5.1's ladder — which is
   about when _we were told_ (`observedOn`), not when the market last printed, so
   a business-day series is not stale on a Monday.
3. **The attribution is carried verbatim, ® included**, and asserted against
   `ATTRIBUTIONS.fred.text` itself rather than a literal the test wrote down —
   otherwise the assertion would be circular. A block with no attribution emits
   no key: a rate a surface cannot lawfully print is worse than no rate.

The five series publish five **different** figures on purpose. A mis-joined
`series_id → MarketRateKind` mapping then shows up as the wrong rate rather than
as nothing at all, which is what makes the `kind` join — the key a rule selects
by, never `series_id` — actually tested.

---

## 3. The rules now enabled, and the budget

All seventeen WP 3.10 rules ship **on**. Every scope they declare —
`holdings.aggregate`, `holdings.detail`, `liabilities.terms`, `market.rates`,
plus `networth.summary`, `cash.summary` and `cashflow.monthly` from Phase 2 — now
has a reader, so the load-bearing half of `WAVE_THREE_REASON` is gone.

| Wave      | Rules              | Ships   | Why                                                                                                                       |
| --------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| debt      | D1 D2 D3 D4 D5 D6  | on      | `liabilities.terms` has a reader                                                                                          |
| investing | I1 I2 I3 I4 I5 I6  | on      | `holdings.aggregate` / `holdings.detail` have readers                                                                     |
| crypto    | X1 X2 X3 X5 X6     | on      | as above; X3 also reads `market.rates`                                                                                    |
| spending  | S2 S3 S6 S7 S9 S10 | **off** | 07 §7.4 wave two. **Not a reader reason** — `transactions.raw` and `transactions.summary` have been sourced since Phase 2 |

The 07 §7.4 week-two/week-three stagger was the _weaker_ of WP 3.10's two
reasons, and it is an operator's pacing decision rather than a property of the
code: a deployment that wants the original schedule switches rules off through
`advisors.enabled` (kill switch 2), which needs no deploy and which a restart
never undoes — `registerAdvisor`'s conflict branch deliberately does not touch
`enabled`. Defaulting to off _for a schedule_ would have left the only checkable
claim in that file — "off because nothing can fill it" — false while still being
asserted, which is the failure mode this whole line of tests exists to catch.
After this change, **"off" in `catalogue.ts` means exactly one thing**: somebody
chose to stagger it.

### The alert budget

Unchanged, and it did not need changing: the budget is applied at **read time**
by `insightFeed`, not at proposal time, so enabling rules changes what is
proposed and never what the ceiling is. Raising the ceiling needs no re-run and
lowering it loses nothing — every proposal still lands in `insights` as
`pending_review` with its evidence.

`wp3.10-advisor-catalog-v2.md` §4 ran the whole catalogue through it: **33
proposals → 5 dashboard, 20 list, 12 overflow, 1 below the floor**, nothing
deleted. `alert-budget-wave.test.ts` pins that shape — that
`overflow + list + belowFloor === rows.length`, that the dashboard is the list's
own first five, that the P0s lead because severity is additive and dominant, and
that the $50 floor exempts a null impact (X1 — crypto at a fifth of net worth —
would otherwise be suppressed for claiming no dollars). Enabling the seventeen is
what makes that run the **default** rather than a scenario.

---

## 4. Minimisation, proven at two levels

`packages/contexts/insights/test/snapshot-arms.test.ts` (18 tests) drives each
arm through the real `SnapshotBuilder` over the real port types.
`apps/api/test/db/phase3-advisors.test.ts` (4 tests) drives the real adapters
over a real database. Neither alone is the proof:

- the context cannot prove the **adapters** produce these types from real rows —
  a port implementation is only correct relative to a database;
- the database suite cannot exhaust the **shapes** — a real fixture has one
  portfolio, where the unit fixture carries a targeted-but-unheld asset class, a
  symbol-less position, an unknown basis and a refused rate series at once.

Where a field must not cross, the assertion is made against the **serialised**
block rather than key by key. A key-by-key assertion only catches the leak
somebody thought of; serialising catches it wherever it lands — nested inside
`lots[]`, or added later by an edit to a type the test does not import.

| Property                                                                | Test                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| no `securityId` / account id / quantity / basis in `holdings.aggregate` | `'emits no securityId, no account id, no quantity and no cost basis'`               |
| a targeted-but-unheld class is a **zero-weight** row                    | `'emits a targeted asset class the holder owns none of as a zero-weight row'`       |
| a symbol-less position never crosses                                    | `'drops a position with no symbol, because an advisor cannot cite one'`             |
| `idle_cash`/`crypto_custody` absent as keys, not zeroed                 | `'omits idle_cash and crypto_custody as keys when the reader has neither'`          |
| a lot is an **age**, never a date                                       | `'carries a lot as an age and never as a date'`                                     |
| `cost_basis` and `unrealized` `null` **together**, never zero           | `'nulls cost_basis and unrealized together, never zero'`                            |
| a quantity is a decimal string, never a JSON number                     | `'carries a quantity as a decimal string and never as a JSON number'`               |
| an account crosses only as a tax treatment                              | `'names an account only by its tax treatment'`                                      |
| one valuation, two blocks                                               | `'values the portfolio once for both blocks'`                                       |
| a liability is a token; the account id stops at the builder             | `'identifies a liability by a token and never by an account id'`                    |
| the ref is stable per user and differs across users                     | `'mints the same ref twice for the same liability, and a different one per user'`   |
| percent → ratio, with `units`                                           | `'converts percent to a ratio and records what it converted from'`                  |
| a non-percent series is **refused**                                     | `'refuses a series whose units are not percent-per-annum'`                          |
| all-refused ⇒ no key                                                    | `'emits no key at all when every series is refused'`                                |
| `stale` computed against WP 3.4 §5.1's ladder                           | `'computes stale against the freshness ladder rather than reading it'`              |
| FRED attribution verbatim; none ⇒ no key                                | `'carries the attribution verbatim, and emits nothing without one'`                 |
| the attribution is the **constant**, not a literal                      | `'market.rates carries the FRED licence sentence verbatim, from the constant'` (db) |
| nothing identifying crosses, incl. any uuid                             | `'the real ports render every new scope, and no identifier crosses'` (db)           |

### One assertion that was wrong, and what it taught

The first draft of `'carries a lot as an age and never as a date'` scanned the
whole serialised block for `/\d{4}-\d{2}-\d{2}/` and went **red on `as_of`**.
`as_of` is a date and is supposed to be one — it is the snapshot's own instant,
the thing every age is measured _against_, and it identifies nothing. The
assertion was wrong, not the builder. It now scans `positions` and the comment
says why, so the next person does not "fix" the builder to satisfy it.

---

## 5. Sabotage

`builder.ts`' `#holdingsAggregate`, one line added to the `top_positions` map:

```ts
symbol: position.symbol as string,
security_id: position.securityId,   // ← the sabotage
weight: ratio(position.weight),
```

Both levels went red, and each named the identifier that escaped rather than
reporting a shape mismatch.

`pnpm exec vitest run --project insights .../snapshot-arms.test.ts`:

```
× emits no securityId, no account id, no quantity and no cost basis
AssertionError: sec-vti-0001 crossed into holdings.aggregate:
  expected '{"as_of":"2026-09-19","currency":"USD…' not to contain 'sec-vti-0001'
 Tests  1 failed | 17 passed (18)
```

`pnpm exec vitest run --project api-db .../phase3-advisors.test.ts`:

```
× the real ports render every new scope, and no identifier crosses
AssertionError: 01a0d34a-253b-765e-917f-05cb3ff98c0f crossed into the snapshot:
  expected '{"market_rates":{"as_of":"2026-09-24"…' not to contain '01a0d34a-…'
 Tests  1 failed | 3 passed (4)
```

The second is the one worth reading twice: it names the **real `securities.id`
uuid from the database**, which is the value that would actually have leaked to
an advisor. Line restored; both suites green again.

---

## 6. The tests that changed, and why

| File                                                         | Change                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/test/phase3-registration.test.ts`                  | `OWED_READERS` → `LANDED_IN_WP_3_10A`, asserted **sourced** by name. The unsourced set is now exactly the four whose source context does not exist. `DEGRADES_WITHOUT_ITS_READER` → `[]`. **Plus a new test**, §7.1 below.           |
| `packages/contexts/insights/test/catalog.test.ts`            | The line moved: it used to sit between wave one and everything else, and now sits between **spending** and everything else. 8 enabled / 23 off → **25 / 6**.                                                                         |
| `packages/contexts/insights/test/catalog-v2.test.ts`         | `'ships every new rule registered and off'` → `'ships every new rule enabled, its reader having landed'`. The manifest properties beside it are unchanged and still checked: enabling a rule must not quietly change what it may do. |
| `packages/contexts/insights/test/scope-minimization.test.ts` | `'…the portfolio four are unsourced'` → `'…all five now have a reader'` (landed by the prior agent).                                                                                                                                 |
| `packages/contexts/insights/test/snapshot-arms.test.ts`      | **New**, 18 tests.                                                                                                                                                                                                                   |
| `apps/api/test/db/phase3-advisors.test.ts`                   | **New**, 4 tests.                                                                                                                                                                                                                    |

`DEGRADES_WITHOUT_ITS_READER` emptying is worth one sentence, because an empty
expectation looks like a deleted test. It held C1 and C2, whose only unsourced
scope was `market.rates`; that scope now has a reader, so neither qualifies. **It
was emptied by a reader, not by an edit to the list.** Their fallback is
untouched and still live — `market_rates` is absent from every on-demand run in
the API process (§1) — and the empty expectation remains a tripwire: a rule that
ships enabled against `goals.list`, `risk.profile`, `market.watchlist` or
`institutions.names` fails there until somebody reads its fallback.

---

## 7. Findings — two things that are owed

### 7.1 `snapshot_grants` will not store a grant for two of the fifteen scopes

**This is the one that matters.** `packages/db/migrations/0012_insights.sql`
constrains `snapshot_grants.scope` with a `CHECK (scope IN (...))` listing Phase
2's thirteen scopes. WP 3.10 added `liabilities.terms` and `market.rates` to
`SCOPE_CATALOGUE` **without a migration**. `grantScopes` therefore fails:

```
error: new row for relation "snapshot_grants" violates check constraint
       "snapshot_grants_scope_check"
Failing row contains (…, builtin.cash.idle_above_cushion, market.rates, f, …)
```

Found the only way it could be — by writing a grant against a real database in
`phase3-advisors.test.ts`. It is not a silent degradation: it is a `23514` in the
face of whoever wires consent. Until it is fixed, **no user can ever be granted
either scope**, which means the whole debt family (all six read
`liabilities.terms`) would be silent the moment consent exists.

It is **owed a migration in `packages/db`**, which WP 3.10a does not own and did
not write. It is pinned instead, so it cannot be rediscovered:
`'every advisor scope can actually be granted, or is a recorded migration gap'`
parses the CHECK list **out of the migration file** and asserts the ungrantable
set is exactly `['liabilities.terms', 'market.rates']` — landing the migration
turns it red and deletes the list; adding a sixteenth scope without one turns it
red naming the scope. It also asserts the reverse direction: a value the database
accepts that the catalogue has never heard of would be a grant nothing can honour.

Note this is one entry in a larger unfinished seam rather than a regression:
`grantScopes` has **no production caller at all** today (there is no consent
route — `wp2.6-insights.md` §6), so nothing is granted for any scope yet. The
migration should land with the consent work, not after it.

### 7.2 Three investing rules are enabled and structurally silent

`holdings.aggregate` has a reader, but three of its fields have no source, and
`createInsightsInvestmentsPort` hardcodes them with the reason at each line:

| Field              | Hardcoded | Because                                                                                                    | Rule silenced                              |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `targets`          | `[]`      | there is no `allocation_targets` table (`wp3.9-routes.md` §8 finding 1), and §8 Q9 forbids a default 60/40 | **I1** drift                               |
| `idleCash`         | `null`    | no dwell history exists to measure idleness against                                                        | **I3** idle cash                           |
| `employerStock`    | `false`   | the holder's own tag, and there is no column for one; 07 I5 is explicit that an employer is never inferred | **I5** employer stock                      |
| `peerExpenseRatio` | `null`    | no comparable-fund table in any Phase 3 source                                                             | — (I2 still fires on the absolute trigger) |

So I1, I3 and I5 ship enabled, correct, and unable to fire. This is a _field_
reason, which no `sourcedInPhase2` flag can express — the scope genuinely has a
reader.

Rather than leave that as a surprise, it is measured:
`'the investing rules with no field behind them are silent, and it is these
three'` runs all six investing rules over the real portfolio, asserts each
**completed** (silence from a rule that decided it had nothing to say, never from
one that was refused or errored), asserts those three proposed zero, and — the
part that keeps it honest — asserts I4 and I2 proposed **more than zero** on the
same run. Without that control the test would pass against a port that returned
`null` for everything, which is the exact failure it exists to catch. The day one
of these three gains a source, the test goes red and names the rule that should
now be firing.

**A judgement call, stated:** the brief's rule was "enable those whose every
scope is sourced; keep off those needing a still-unsourced scope". By that rule
all seventeen qualify, and that is what shipped. An argument exists for holding
I1/I3/I5 off instead — but their `disabledReason` would then have to say
something no flag in the system models, and the reason would decay the moment
somebody read `sourcedInPhase2` and saw `true`. Enabled-and-measured was judged
better than off-with-a-reason-nothing-checks. **This is the decision most worth a
second opinion in this work package.**

### 7.3 Smaller things

1. **`seed.ts` still merges `portfolioBlocks`.** §7.1 step 3 asks for the merge
   to be deleted now the arms exist. Three of the four blocks could move today;
   `liabilities.terms` cannot, because `advisor-golden.test.ts` pins insight keys
   containing the fixture's `LIAB_a1b2c3d4e5f6` literals and a builder-minted ref
   is an HMAC of an account id the fixture does not have. Moving it means
   re-pinning every D-family golden in the same change — owed, named at the merge
   site, and deliberately not folded into this diff. `snapshot-arms.test.ts` and
   `phase3-advisors.test.ts` are what replaced the merge as the _proof_.
2. **`just openapi` produces a diff, and it is not a contract change.** The
   emitted `openapi.json` is **deeply equal** to the committed one
   (`json.load(a) == json.load(b)` → `True`; identical schema set, identical
   `paths`); only the key **order** inside `components.schemas` differs, which
   makes the emitter's schema-registration order non-deterministic across
   processes. WP 3.10a touches no route and no contract schema, so the file was
   reverted rather than committed. The non-determinism itself is a pre-existing
   nuisance worth a separate fix.
3. `packages/contexts/insights/src/snapshot/ports.ts` and `apps/api/src/domain.ts`
   arrived from the prior agent unformatted; both were run through Prettier.

---

## 8. Check results

Run foreground, from the repo root, `DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`.

| Check                                                                         | Result                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm exec vitest run --project insights --project insights-db --project api` | **288 passed**, 33 files, 0 failed                          |
| `pnpm exec vitest run --project api-db`                                       | see below                                                   |
| `pnpm exec tsc -b --noEmit`                                                   | **clean**, no output                                        |
| `pnpm exec eslint packages/contexts/insights apps/api`                        | **clean**, exit 0                                           |
| `pnpm run lint:schema-ownership`                                              | `ok — 99 table(s) claimed across 14 package(s), 79 defined` |
| `pnpm exec prettier --check` (every file touched)                             | `All matched files use Prettier code style!`                |
| `just openapi`                                                                | diff is key-order only; see §7.3 item 2                     |

The baseline before this work package, for comparison: **2 failed | 267 passed**
— both failures in `phase3-registration.test.ts`, exactly the two the readers
landing made false.

### `pnpm exec vitest run --project insights --project insights-db --project api`

```
 Test Files  33 passed (33)
      Tests  288 passed (288)
```

### `pnpm exec vitest run --project api-db`

```
 Test Files  35 passed | 1 skipped (36)
      Tests  211 passed | 2 skipped (213)
   Duration  295.74s
```

The skips are pre-existing and not this work package's: one file and two tests
that gate on a capability this environment does not provide. Nothing in the
Phase 3 wiring, insights routes or advisor suites is among them —
`phase3-advisors.test.ts` contributes 4 passing tests to the count above.

---

## 9. Files touched

**Source**

- `packages/contexts/insights/src/advisors/catalogue.ts` — seventeen enablement flips, `WAVE_THREE_REASON` rewritten to an honest claim
- `packages/contexts/insights/src/snapshot/builder.ts` — formatting only (the four arms arrived with the prior agent)
- `packages/contexts/insights/src/snapshot/ports.ts` — formatting only
- `apps/api/src/domain.ts` — formatting only

**Tests**

- `packages/contexts/insights/test/snapshot-arms.test.ts` — **new**, 18 tests
- `apps/api/test/db/phase3-advisors.test.ts` — **new**, 4 tests
- `apps/api/test/phase3-registration.test.ts` — the two reds re-derived, plus the grantability test
- `packages/contexts/insights/test/catalog.test.ts`, `catalog-v2.test.ts` — enablement expectations

**Docs**

- `docs/evidence/phase-3/wp3.10a-snapshot-readers.md` — this file

Not touched: `apps/web/**` (concurrent UI agents), `packages/db/migrations/**`
(§7.1 is owed there), `packages/contracts/**` (no schema change; the
`openapi.json` churn was reverted — §7.3).
