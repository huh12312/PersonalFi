# WP 3.14 — quality pass: seed ground truth, the numeric-boundary check, perf budgets, and the exit-criteria audit

_Written 2026-09-24 at `1319b1b` + this WP's working tree. Dispatch:
[`docs/plan/03-phase-3-dispatch.md`](../../plan/03-phase-3-dispatch.md) §3 "WP 3.14".
This is the **core half** of the quality pass; the carry-over half (web, recurring,
compose) is a concurrent agent's and is not covered here._

Four artefacts, in the order the dispatch names them:

1. `packages/seed/src/phase3-investments.ts` — securities, holdings, lots **with
   ground truth**, investment transactions, a price series, an FX series with one
   deliberate gap, a non-USD account, a manual asset and a liability; graded by
   `packages/seed/test/investments-ground-truth.test.ts`.
2. `scripts/check-numeric-boundaries.ts` (+ `.test.ts`, + `scripts/fixtures/numeric-*.ts`)
   — 08 §6.5's lint rule, mechanised, wired into `just lint` and CI's `lint` job.
3. `apps/api/test/db/investments-perf.test.ts` — holdings, allocation and the
   net-worth series, p95 over real HTTP, on the seed.
4. The §1 exit-criteria audit and the §5 "never"-list map, below.

---

## 1. The §5 exit-criteria audit

The criteria, verbatim from the dispatch §1:

> net worth reconciles to a hand computation across every account type including a
> manual asset and a liability; a past date's net worth is immutable across a re-run;
> ETH on Coinbase and in a wallet resolves to one security; a missing FX rate surfaces
> rather than defaulting; allocation matches a spreadsheet check.

Every test name below was confirmed present in the tree by `grep -F`, not quoted from
another evidence file.

| #   | Criterion                                                                                                         | Verdict                                                                           | Proof, or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Net worth reconciles to a hand computation across every account type **including a manual asset and a liability** | **Proven**                                                                        | `packages/contexts/planning/test/reconcile.test.ts` → `'net worth reconciles to a hand computation across every account type including a manual asset and a liability'` (the criterion, verbatim), and its persisted half `packages/contexts/planning/test/db/reconcile.test.ts` → `'the persisted row reconciles to the same hand computation, read back through SQL'`. **This WP adds a second, independent hand computation**: the seed now carries a manual asset ($450,000.00), a liability ($18,250.00) and a CAD account, with `netWorth.expectedTotal = $465,925.56` declared as a literal and its arithmetic written out — asserted by `packages/seed/test/investments-ground-truth.test.ts` → `'the declared net worth is the sum of its declared parts'`.                                                                                                                                                                        |
| b   | A past date's net worth is immutable across a re-run                                                              | **Proven at the domain layer; the cold-stack half is carried to the gate**        | `packages/contexts/planning/test/db/seal.test.ts` → `'a past date is byte-identical after a second snapshot run'`, `'SABOTAGE: lets the writer update a sealed row, and the database refuses by name'`, `'refuses to recompute a sealed day through the ordinary write path'`; route half `apps/api/test/db/net-worth-routes.test.ts` → `'a correction supersedes the sealed day and never rewrites it'`. **Carried:** dispatch §5 asks the gate to "re-run the snapshotter twice over the seed and diff the sealed range byte for byte" on the cold stack; no evidence file claims that has been done. The browser half (`apps/web/e2e/networth.spec.ts` → `'a past date on the chart is unchanged after a re-sync'`) exists but is **invisible to CI** — see §8 item 2.                                                                                                                                                                   |
| c   | ETH on Coinbase and in a wallet resolves to one security                                                          | **Proven against fixtures; the live Coinbase leg needs Chris's account**          | `packages/contexts/investments/src/resolver.test.ts` → `'ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId'`; DB half `packages/contexts/investments/test/db/securities.test.ts` → `'ETH from Coinbase, a wallet contract address and Plaid ETHEREUM resolve to one security_id'`; connector half `packages/connectors/walletrpc/test/one-security.test.ts` → `'both sightings canonicalise onto the same NATIVE_ASSETS row — one chain, one identity'`; end-to-end `apps/api/test/db/phase3-wiring.test.ts` → `'a security seen as a ticker and later as a FIGI is one securities row'` (added by WP 3.7a to close the splitting defect WP 3.7 §11.1 found). The seed now carries ETH with all three identifier kinds (`ticker`, `chain_contract`, `cusip`) so a loader has the subject to hand. **Needs real accounts:** wp3.5 §10 — "the live smoke has never run", no CDP key on this machine. |
| d   | A missing FX rate surfaces rather than defaulting                                                                 | **Proven at the domain layer; the HTTP surfacing has no named test — a real gap** | `packages/contexts/planning/test/fx-missing.test.ts` → `'a missing rate raises FxRateUnavailable and never returns 1.0'` and, crucially for a control that must discriminate, `'accepts a genuine observation that happens to be exactly 1.0'`. **Observed live during this WP**: with the seeded CAD account and no `fx_rates` rows, `computeNetWorth` threw `FxRateUnavailable: no FX rate for CAD/USD on or before 2026-09-24 … This is deliberately an error rather than a 1.0` while `investments-perf.test.ts` was being built — the control firing over the seed, unplanned (§5, S0). **Gap:** `apps/api/src/routes/net-worth.ts:344–350` translates it to `planning.fx_rate_missing`, and no test in `apps/api/test/**` is named for that translation. Recommended to the gate as a one-test fix at the route seam; not written here because `apps/api/src/routes/net-worth.ts` and its suite are not this WP's files.              |
| e   | Allocation matches a spreadsheet check                                                                            | **Proven**                                                                        | `packages/contexts/investments/src/analytics/allocation.test.ts` → `'allocation matches the committed spreadsheet fixture to the cent'`, over `test/fixtures/allocation-{portfolio,expected}.csv`. **This WP re-runs it from the seed's own vocabulary**: `packages/seed/test/investments-ground-truth.test.ts` → `'allocation matches the committed spreadsheet fixture, rebuilt from seed shapes'` maps every fixture row through `SeedSecurity` + `SeedPhase3Holding` first, so a seed that lost `expenseRatio`, `isCashEquivalent` or one-security-in-two-accounts would fail. Browser half `apps/web/e2e/investments.spec.ts` → `'the allocation donut totals match the committed spreadsheet fixture'` exists but is invisible to CI (§8 item 2).                                                                                                                                                                                     |

### The v0.5 rung (§2.3)

> "Holdings reconcile to balances; allocation matches a spreadsheet check; crypto
> on-ramps classified as transfers."

| Clause                                  | Verdict                                                  | Proof, or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdings reconcile to balances          | **Not proven — the one clause of the rung with no test** | `holdings.institution_value_minor` is written (`packages/contexts/investments/src/lots-store.ts:337`) and is the column a reconciliation would compare against Σ(quantity × price), but no test in the tree asserts the two agree: `grep -rn "reconcile" --include=*.test.ts packages apps/api/test \| grep -i "holding\|balance"` returns nothing. Recommended as a small addition to `@ctx/investments` (compare the computed market value to `institutionValue` per holding and report a tolerance breach) — not written here because `packages/contexts/investments/**` is not this WP's to edit. |
| Allocation matches a spreadsheet check  | **Proven**                                               | criterion (e) above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Crypto on-ramps classified as transfers | **Proven against recorded fixtures**                     | `packages/connectors/coinbase/test/onramp.test.ts` → `'a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending'`, `'a fiat deposit is a transfer, never income'`. Live leg needs Chris's Coinbase account (wp3.5 §10).                                                                                                                                                                                                                                                                                                                                                   |

### Real-data items (dispatch §6 Q8) — all four need Chris's accounts

Two institutions on schedule; a month with zero internal transfers; the recurring gold
set against Chris's confirmed list; **a real brokerage's holdings reconciling to its own
statement**. All four are carried to the first production link, on the dispatch's own
stated terms. Nothing in this WP changes their status; the fourth is the real-account
form of the v0.5 clause above.

---

## 2. The §5 "never" list, mapped to the test that fails when the thing is made to happen

| "Never"                                                       | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A quantity never becomes a float                              | `packages/contexts/investments/src/quantity.test.ts` → `'no \`number\` appears in a quantity that reached the engine'`, `'quantityWeight is an exact integer of 1e-18 units, with no float in the path'`; DB leg `packages/contexts/investments/test/db/quantity.test.ts`→`'0.00000001 BTC survives a database round trip'`; port leg `packages/connectors/port/src/conformance.holdings.test.ts`→`'fails an adapter that floats a quantity'`; price column `packages/contexts/integrations/test/db/custody.test.ts`→`'a NUMERIC(20,10) close round-trips as an exact decimal string, never a float'`. **This WP adds the repo-wide, static half**: `scripts/check-numeric-boundaries.ts`, which is the first control that covers code nobody wrote a test for — §7. |
| A sealed net-worth day never changes on a re-run              | `packages/contexts/planning/test/db/seal.test.ts` → `'a past date is byte-identical after a second snapshot run'` + its own `SABOTAGE:` test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A missing FX rate never defaults to 1.0                       | `packages/contexts/planning/test/fx-missing.test.ts` → `'a missing rate raises FxRateUnavailable and never returns 1.0'`; the seed now carries a declared gap so the condition is reachable from a fixture (`'the FX series has exactly one gap, on the date the generator declares'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| An unmapped security never silently becomes two securities    | `packages/contexts/investments/src/resolver.test.ts` → `'two identifiers for one security never create two rows'` (fast-check, 200 runs), `'an unresolvable identifier fails loudly and emits SecurityResolutionFailed rather than minting a row'`, and the converse `'WETH and ETH are two securities, because a user can hold both at once'`; identity rule `src/identifiers.test.ts` → `'a provider identifier never becomes the identity'`.                                                                                                                                                                                                                                                                                                                      |
| A price source never resolves a private or link-local address | `packages/contexts/integrations/test/egress-allowlist.test.ts` → `'a price-source URL pointing at db:5432 is refused'`, `'169.254.169.254 is refused'`, `'a private answer is refused even when the name is allow-listed'`, `'a DNS answer that changes between check and connect is refused'`; no-fork guard `test/shared-allowlist.test.ts` → `'no private-range literal appears anywhere in this package'`. **Carried:** dispatch §5 item 6 asks the gate to re-run these _from inside the worker container_, and wp3.4 §10 records that Sabotage B (the cleartext control) could not be shown red from inside the package.                                                                                                                                       |
| A `can_view` CDP key never reaches a trading endpoint         | `packages/connectors/coinbase/test/no-trade-surface.test.ts` → `'the package contains no code path that POSTs to /orders'`, `'drives every public method and sees only GETs on the five allowed paths'`, `'will not let a product id smuggle a different path past the allow-list'`; startup assertion `test/permissions.test.ts` → `'a key claiming can_trade is refused at startup'`, `'a key with can_trade is refused before any data call'`. Fixture-only; the live key has never been exercised.                                                                                                                                                                                                                                                               |
| An on-ramp deposit never lands in a spending total            | `packages/connectors/coinbase/test/onramp.test.ts` → `'a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**All seven have a named, existing test.** The two weaknesses worth the gate's attention
are both about _strength_, not existence: the Coinbase pair is proven only against
recorded fixtures, and the egress pair has not been re-run from inside the worker
container.

---

## 3. The seed's ground truth, enumerated

`generatePhase3Investments(seed)` — additive, never folded into `generateDemoData`
(whose output is pinned by `@ctx/categorization`'s golden set and `@ctx/recurring`'s
corpora; a new `rng` draw there would re-roll two phases' numbers).

**6 accounts:** Taxable Brokerage (USD), Rollover IRA (USD, retirement), Crypto Exchange
(USD), **CAD Brokerage (CAD)**, **Primary Residence (manual asset)**, **Auto Loan
(liability)**.

**7 securities:** VTI, BND, VXUS (ETFs, expense ratios as decimal strings), AAPL (equity,
`expenseRatio: null` — "there is no such thing", never `'0'`), **ETH** (crypto, `chain:
'ethereum'`, three identifier kinds: `ticker`, `chain_contract`, `cusip`), XIC (CAD-
denominated ETF), CASH (`isCashEquivalent`).

**14 investment transactions → 10 lots.** Every expectation below is a hand-computed
literal in the generator, with its arithmetic beside it, and is compared against what
`@ctx/investments`' engine produces from the _transactions_:

| Lot | Opened                | Quantity             | Declared basis | Declared remaining | What it forces                                                                                                    |
| --- | --------------------- | -------------------- | -------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| l1  | 2024-11-15 VTI        | 10                   | $2,200.00      | 0 / $0.00          | consumed whole by the 2026-02-20 sale; **462 days → LONG_TERM**                                                   |
| l2  | 2025-03-10 VTI        | 5                    | $1,200.00      | 3 / $720.00        | 2 of 5 taken, `allocate($1,200, [2,3])[0] = $480.00`; **347 days → SHORT_TERM**                                   |
| l3  | 2025-06-02 AAPL       | 20                   | $4,000.00      | 0 / $0.00          | sold at a **$1,000.00 loss** (105 days)                                                                           |
| l4  | 2025-10-01 AAPL       | 20                   | $3,200.00      | 20 / $3,200.00     | **wash sale**: basis after adjustment **$4,200.00**, holding period tacked back to 2025-06-02                     |
| l5  | 2025-01-06 BND (IRA)  | 100                  | $7,200.00      | 60 / $4,320.00     | 40 taken, `allocate($7,200, [40,60])[0] = $2,880.00`; **$80.00 loss**                                             |
| l6  | 2025-06-05 BND (IRA)  | 40                   | $2,720.00      | 40 / $2,720.00     | **day 31 — NOT a wash sale**, basis unadjusted, holding period not tacked                                         |
| l7  | 2025-02-14 ETH        | 1.500000000000000000 | $3,900.00      | 0.75 / $1,950.00   | 18-dp quantity, exactly half consumed; **451 days → LONG_TERM**                                                   |
| l8  | 2025-08-20 ETH        | 0.250000000000000000 | $750.00        | 0.25 / $750.00     | FIFO never reaches it                                                                                             |
| l9  | 2025-04-18 VXUS (IRA) | 5                    | **null**       | 5 / **null**       | transferred in: `basisSource ESTIMATED`, unrealised gain **`unavailable`**, market value still reported ($321.00) |
| l10 | 2024-10-31 XIC (CAD)  | 200                  | CAD 7,000.00   | 200 / CAD 7,000.00 | a basis held in CAD, never converted at par                                                                       |

**4 disposals, with the ST/LT split declared per term:**

| Sale                 | Proceeds  | Short-term        | Long-term         |
| -------------------- | --------- | ----------------- | ----------------- |
| 2026-02-20, 12 VTI   | $3,600.00 | **+$120.00** (l2) | **+$800.00** (l1) |
| 2025-09-15, 20 AAPL  | $3,000.00 | **−$1,000.00**    | —                 |
| 2025-05-05, 40 BND   | $2,800.00 | **−$80.00**       | —                 |
| 2026-05-11, 0.75 ETH | $3,000.00 | —                 | **+$1,050.00**    |

**Wash sales:** one declared (`t5` → lot `l4`, **offset +16 days**, disallowed loss
$1,000.00, tacked holding period 2025-06-02, `basisAdjustmentIsPermanentlyLost: false`)
and one declared **absence** (`t8` → lot `l6`, **offset +31 days**) — the far boundary of
the 61-day window, asserted as a non-flag, because a check that only asserts the positive
case cannot tell 30 from 31.

**Prices:** a month-end series per security, an integer basis-point walk in `bigint`
cents whose **last point is a pinned literal** (VTI `305.12`, BND `71.50`, VXUS `64.20`,
AAPL `245.00`, ETH `3150.00`, XIC `35.40`, CASH `1.00`) — so "quantity × the last close =
the declared market value" is an assertion about the engine's half-even rounding rather
than about where a random walk landed.

**FX:** a CAD/USD month-end series with **exactly one declared gap, 2026-03-31**
(`dataset.fxGap`), with the months either side present so "missing" cannot be confused
with "not started yet", and no rate ever exactly `1.0000`.

**Net worth, hand-computed:** $28,936.36 investments + $5,239.20 (CAD 7,080.00 at 0.7400)

- $450,000.00 residence − $18,250.00 auto loan = **$465,925.56**.

**Determinism:** `JSON.stringify` byte-identical for the same seed; different for another;
and the _facts_ (every declared basis) do not move with the seed at all — only the ids do,
because a declared basis that depended on a random draw could not be checked by hand.

---

## 4. The spreadsheet fixture: provenance

The fixture is **WP 3.3's**, not this WP's, and its provenance is worth restating because
the v0.5 rung depends on it:

- `packages/contexts/investments/test/fixtures/allocation-portfolio.csv` — 11 positions,
  with the spreadsheet formulas written at the top of the file as `#` comments
  (`expected_market_value = ROUND(quantity * price, 2)`, `weight(key) = SUMIF(…) / total`),
  so the formulas are part of the committed artefact rather than prose that drifts.
- `packages/contexts/investments/test/fixtures/allocation-expected.csv` — every expected
  slice value and weight, for both `last_known` and `as_of_now`.
- **There was no committed spreadsheet before WP 3.3**; one was authored, and its
  expectations were computed with **an independent decimal implementation (Python
  `decimal`, `ROUND_HALF_EVEN`), not with the TypeScript engine they pin** — transcript in
  `wp3.3-analytics.md` §4. A fixture generated by the code under test asserts only that
  the code is self-consistent.
- The portfolio carries the failure modes deliberately: a fractional crypto quantity, a
  cash position that must sit in the denominator, an `UNCLASSIFIED` holding, one `STALE`
  price (which is why the two totals differ by $2,050.00), one security held in two
  accounts, and two holdings with no expense ratio.

This WP adds a second consumer: the same two CSVs are re-read in
`packages/seed/test/investments-ground-truth.test.ts`, mapped through the **seed's own**
`SeedSecurity`/`SeedPhase3Holding` shapes, and only then handed to `allocationBy` — so the
seed's vocabulary is proven rich enough to carry the spreadsheet check, which is what a
demo database and a perf fixture both depend on.

---

## 5. Sabotage: every new check observed red, once, on the first valid attempt

| #   | Check                                                      | Sabotage                                                                                      | Result                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The seed's declared ground truth                           | `expectedRemainingBasis` on lot `l2` changed `72000` → `72001`                                | **RED, first attempt.** `AssertionError: …5 × $240.00 = $1,200.00; t3 takes 2 of 5, so $480.00 of basis goes and $720.00 stays.: expected { minor: 72000n, currency: 'USD' } to deeply equal { minor: 72001n, currency: 'USD' }` — 1 failed / 37 passed. Restored; green. |
| S2  | `check-numeric-boundaries.ts`                              | `export const lastTradedPrice = 268.4;` appended to `packages/seed/src/phase3-investments.ts` | **RED, first attempt.** `FAIL — 1 violation(s) in 686 file(s) … packages/seed/src/phase3-investments.ts:1205 [number-at-a-magnitude-boundary] \`lastTradedPrice\` is initialised with a numeric literal, so it infers \`number\`.`Restored;`PASS — 0 violations`.         |
| S3  | The perf budgets                                           | a 250 ms `setTimeout` inserted into `timeGet`                                                 | **RED, first attempt.** `GET /holdings: expected 322.07… to be less than 200`; `GET /net-worth/series: expected 299.48… to be less than 200` — 2 failed / 1 passed. Restored; green.                                                                                      |
| S4  | `check-ci-projects.ts`, over the **new** `scripts` project | `--project scripts` removed from `ci.yml`'s `test` job                                        | **RED, first attempt.** `'scripts' is declared in vitest.config.ts but appears in neither ci.yml job's --project list ('test' or 'migration-test') — it has never run in CI.` Restored; `PASS — all 40 projects covered`.                                                 |

**S0 — an unplanned red, recorded because it is the strongest evidence in this document.**
While `investments-perf.test.ts` was being written, before any `fx_rates` rows were
inserted, the seeded **CAD** account made `computeNetWorth` throw:

```
FxRateUnavailable: no FX rate for CAD/USD on or before 2026-09-24
(consulted CAD/USD, USD/CAD (inverted)). This is deliberately an error rather than a 1.0:
D4 stores every foreign amount with the rate that produced it, and a par conversion would
be plausible, invisible and wrong.
```

That is the §5 "never" (_a missing FX rate never defaults to 1.0_) firing on the real
net-worth path, over the seed, without anyone arranging it. The test now inserts the
seed's FX series (gap and all) so the perf numbers can be taken.

In addition, the numeric check's **negative** fixture is a control of its own:
`scripts/fixtures/numeric-good.ts` must stay clean, so a future "fix" that made the rule
flag every `number` fails the self-test rather than silently turning the check into noise.

---

## 6. Perf numbers

`apps/api/test/db/investments-perf.test.ts`, real HTTP (`listen()` + `fetch()`, body
drained), 3 warm-ups discarded, 15 samples, on the Phase 3 seed
(7 securities, 7 holdings, ~150 price rows, 180 `net_worth_daily` days written by
`computeNetWorth` → `upsertOpenDay`). Postgres 18 at `127.0.0.1:5433`, dev host.

| Route                              | p50     | **p95**     | Budget | Margin |
| ---------------------------------- | ------- | ----------- | ------ | ------ |
| `GET /holdings`                    | 20.3 ms | **32.7 ms** | 200 ms | 6.1×   |
| `GET /investments/allocation`      | 31.1 ms | **32.7 ms** | 200 ms | 6.1×   |
| `GET /net-worth/series` (180 days) | 7.7 ms  | **13.3 ms** | 200 ms | 15×    |

Samples, printed by the run rather than summarised:

```
perf /holdings:                  p50=20.3ms p95=32.7ms samples=[16,16,17,18,19,20,20,20,21,23,25,25,31,31,33]
perf /investments/allocation:    p50=31.1ms p95=32.7ms samples=[23,29,30,31,31,31,31,31,31,31,31,31,32,32,33]
perf /net-worth/series (180d):   p50=7.7ms  p95=13.3ms samples=[7,7,7,7,7,7,7,8,8,8,9,10,10,10,13]
```

**Where the budgets come from, and the honest caveats.** 200 ms is the dispatch's own
figure for holdings and allocation (§3, in the exit test's name). For the net-worth
series, 08 §7.1 budgets **150 ms for 1,825 points** straight from `net_worth_daily`; this
measures **180** points against the looser 200 ms, and the gap is stated rather than
hidden — a 5-year window has not been measured. The dataset is the _correctness_ seed
(single-digit holdings), not a scale seed: these numbers say the routes are not
pathological, not that they hold at 200 positions. The suite asserts its own row counts
before timing anything, because a perf number over an empty table is a lie.

---

## 7. The numeric-boundary check

### Design

08 §6.5 states the rule — _"a lint rule bans `number` in any identifier matching
`/amount|balance|price|value|cost/`"_ — and the dispatch adds `quantity`. The check parses
`packages/**/*.ts` and `apps/api/src/**/*.ts` with the **TypeScript parser, syntax only**
(no `Program`, no type checker, no `tsconfig`): ~1 s over 686 files, no build required,
and it cannot be defeated by a `tsconfig` change. The cost is that an _inferred_ `number`
is invisible unless the initialiser is literally a number — which is why a numeric-literal
initialiser is a rule of its own.

Two rules:

- **`number-at-a-magnitude-boundary`** — property signatures and declarations, parameters,
  variables, type aliases, object-literal properties, and same-named function/method
  return types, typed `number` (including `number | null`, `number[]`,
  `readonly number[]`, `Record<K, number>`), or with no annotation and a numeric-literal
  initialiser.
- **`tofixed-on-a-magnitude`** — `<magnitude>.toFixed(…)`. The §5 risk table asks the gate
  to "grep the whole Phase 3 diff … for new `toFixed(` calls"; a grep a human runs once is
  not a control.

### Real-tree result

```
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 686 file(s) scanned, 0 violations, 70 exempt identifier(s)
```

The first run found **80 findings across 686 files**. They resolved into three groups:

**(i) Real violations, in a package this WP owns — fixed.**

| File                               | Finding                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/seed/src/investments.ts` | `startPrice: number` on the security spec, five float literals (`220`, `55`, `180`, `42_000`, `2_300`), and `price.toFixed(2)` producing every demo price | rewritten as an integer basis-point walk over `bigint` cents (`startCloseMinor`, `volatilityBps`), formatted from the integer. One `rng()` draw per step, as before, so the generator's position in the PRNG stream is unchanged and nothing downstream of `generateInvestments` shifts. |
| `packages/seed/src/prng.ts`        | `randomDecimal` ended in `value.toFixed(decimals)` — the float→money-string seam for **every seeded transaction amount**                                  | now formats from the rounded integer (`formatScaledInteger`). **The draw and the bytes are unchanged** (`Math.round(x·10^d)` is exactly the numerator `toFixed(d)` printed), which is why the `seed`, `categorization` and `recurring` golden sets are unaffected.                       |

**(ii) Structural exemptions** — name shapes that are dimensionless by construction, each
with a stated reason, printed by `--explain`: cardinalities (`…Count`, `…Rows`,
`…Written`, `…Changes`, `…Buckets`, `…Unvalued`, `…Calls`), positions/widths, Argon2id
work factors (`timeCost`/`memoryCost`), dimensionless statistics (`amountCv`, `amountMape`,
`priceChangePrecision`, …), durations, signs, **confidence scores** and
**`toNumberApproximate`-style presentation helpers** (the two the dispatch names as legal
outright), and `value`/`values` **as a parameter only** — the same name on a _property_
stays a violation, which is the shape 08 §6.5 actually bans.

**(iii) A file+identifier allow-list, 17 entries, each with a written reason.** Every one
was read at its declaration, not pattern-matched. The full list is in the script; the ones
a reviewer should look at hardest:

| File:identifier                                                                               | Why it is not a magnitude                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/connectors/plaid/src/amount.ts:value`, `:plaidAmount`                               | Plaid's wire format **is** a JSON number; this file is the single place it becomes `Money`, and refusing NaN/Infinity/overflow there is its whole purpose.                                 |
| `packages/connectors/plaid/src/map.ts:value`                                                  | the same seam for quantities (`decimalStringOf`).                                                                                                                                          |
| `packages/contexts/insights/src/validate/decimal.ts:value`                                    | `fromNumber()` is the advisor engine's float → `Decimal` conversion seam; its own header says the `toFixed` is deliberate. This is the **only** `toFixed` on a magnitude left in the tree. |
| `packages/contexts/integrations/src/{rate-limit,http}.ts:cost`, `apps/api/src/domain.ts:cost` | provider **credits** spent per call, not currency.                                                                                                                                         |
| `apps/api/src/routes/investments.ts:unvaluedTransfers`                                        | a count of flows left out of a window for want of an FX rate — the money is deliberately absent.                                                                                           |
| `packages/contexts/investments/src/identifiers.ts:charValue`                                  | a character code in the CUSIP/ISIN check digit.                                                                                                                                            |
| `packages/connectors/csv/test/config.test.ts:amount`                                          | a zero-based CSV **column index**.                                                                                                                                                         |

There is no `eslint-disable`-shaped escape hatch: adding a violation means editing the
script and writing the reason down in front of a reviewer.

**Nothing was left unfixed in a package this WP does not own.** Every finding outside
`packages/seed/**` was, on reading, a genuinely dimensionless quantity — so the seam the
dispatch anticipated ("list them precisely and stop") did not arise as a _code_ change.
The full audited list is above and in the script's `ALLOW_LIST`, and a reviewer who
disagrees with any entry can delete it and watch the check go red.

### Wiring

- `just lint` → `node scripts/check-numeric-boundaries.ts` (so `just check` and
  `just verify` run it).
- `ci.yml` `lint` job → a `no float at a money or quantity boundary` step, beside the
  other three static checks.
- `ci.yml` `test` job → `--project scripts`, the vitest half
  (`scripts/check-numeric-boundaries.test.ts`, exit test
  `'a float assigned to a price fails the check'`).

---

## 8. Open, owed, and the shared files this WP touched

1. **Two shared-file edits, flagged for the orchestrator rather than assumed.**
   `vitest.config.ts` is the orchestrator's file by dispatch §4, and this WP made two
   additive edits to it because the two exit tests the dispatch names could not otherwise
   run at all:
   - the `seed` project's `include` gained `'test/**/*.test.ts'` (it was `src/`-only, and
     the dispatch places the ground-truth test in `packages/seed/test/`);
   - a new `scripts` project (`root: './'`, `include: ['scripts/**/*.test.ts']`) for
     `scripts/check-numeric-boundaries.test.ts`, which the dispatch names by path and
     which no existing project covered.

   Both are additive and reversible; `node scripts/check-ci-projects.ts` passes with the
   matching `ci.yml` edit, and sabotage S4 shows the pairing is enforced. If the
   orchestrator would rather the files moved than the config changed, the ground-truth
   suite runs unchanged from `packages/seed/src/`.

2. **`apps/web/playwright.config.ts`'s `chromium` `testMatch` still excludes
   `investments`, `networth` and `market-data`** (wp3.11 §10 item 1). Four browser-level
   proofs of exit criteria (b) and (e) are invisible to CI until that one-token edit
   lands. Not this WP's file; re-raised here because it is now an _exit criterion_
   coverage gap, not only a UI one.
3. **`@core/seed` reaches `@ctx/investments` by relative import in one test file.**
   `packages/seed/test/investments-ground-truth.test.ts` carries one
   `/* eslint-disable personalfi/layer-imports -- … */` block around its five engine
   imports, with the reason on the directive and at length in the file header. The clean fix is the orchestrator's: a `@ctx/investments` devDependency on
   `@core/seed`'s `package.json` plus an `allow` entry in `scripts/eslint-boundaries.js`'s
   `seed` layer (agents touch neither the lockfile nor that file). Nothing under
   `packages/seed/src/` imports a context — the shipped generator still depends on
   `@core/kernel` alone.
4. **The route-level `fx_rate_missing` surfacing has no test** (§1 criterion d). One test
   at `apps/api/test/db/net-worth-routes.test.ts` would close it; that file is not this
   WP's.
5. **"Holdings reconcile to balances" — the v0.5 clause with no test.** `institution_value_minor`
   is stored and never compared to Σ(quantity × price). A ~30-line addition to
   `@ctx/investments`; not this WP's package.
6. **The perf dataset is a correctness seed, not a scale seed** (§6). A 200-position,
   5-year run is worth having before anyone quotes these numbers as headroom.
7. **What this WP did _not_ do:** the 3.14 carry half (`apps/web/**`,
   `apps/api/src/routes/recurring.ts`, `packages/contexts/recurring/**`, `compose*.yml`)
   is a concurrent agent's; the Phase 2 gate's AT_RISK and impact-ceiling rulings are WP
   3.13's and are inputs to the Phase 3 gate, not outputs of it (§5 item 7).

---

## 9. Verification

Every command run in the foreground, at this WP's working tree.

| Command                                                                                     | Result                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL=… pnpm exec vitest run --project seed --project investments --project api-db` | **63 files passed, 1 skipped; 453 tests passed, 4 skipped** — 380.7 s                                        |
| `pnpm exec vitest run --project scripts`                                                    | 1 file, **8 tests pass**                                                                                     |
| `node scripts/check-numeric-boundaries.ts`                                                  | self-test PASS (8 bad declarations caught), tree **PASS** — 0 violations in 686 files, 70 exempt identifiers |
| `pnpm exec tsc -b --noEmit`                                                                 | **clean**                                                                                                    |
| `pnpm exec eslint packages/seed scripts apps/api/test/db/investments-perf.test.ts`          | **clean**                                                                                                    |
| `pnpm exec prettier --check` (every file this WP touched)                                   | **clean**                                                                                                    |
| `node scripts/check-ci-projects.ts`                                                         | self-test PASS, **PASS** — all 40 projects covered (25 `test`, 16 `migration-test`)                          |

**One pre-existing lint error outside this WP, reported rather than touched.**
`pnpm exec eslint apps/api/test` (the whole directory) is red on
`apps/api/test/db/notifications-delivery.test.ts:78` — `'node:crypto' import is restricted
… Cryptography lives in @core/secretbox`. The file is untouched by this WP and is not in
its diff; it is the same shape as the carve-out wp3.5 §10 asks the orchestrator for.

**Nothing is staged.** `git diff --cached --name-only` is empty (memory: staged-rename-leak).
This WP's tree touches exactly: `packages/seed/{src/{index,investments,prng,phase3-investments}.ts,test/investments-ground-truth.test.ts}`,
`scripts/check-numeric-boundaries.{ts,test.ts}`, `scripts/fixtures/numeric-{bad,good}.ts`,
`apps/api/test/db/investments-perf.test.ts`, `docs/TESTING.md`,
`docs/evidence/phase-3/wp3.14-quality.md`, `justfile` (the `lint` recipe),
`.github/workflows/ci.yml` (additive), `vitest.config.ts` (the two edits in §8 item 1).
