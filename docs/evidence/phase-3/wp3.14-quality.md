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

| #   | Criterion                                                                                                         | Verdict                                                                    | Proof, or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Net worth reconciles to a hand computation across every account type **including a manual asset and a liability** | **Proven**                                                                 | `packages/contexts/planning/test/reconcile.test.ts` → `'net worth reconciles to a hand computation across every account type including a manual asset and a liability'` (the criterion, verbatim), and its persisted half `packages/contexts/planning/test/db/reconcile.test.ts` → `'the persisted row reconciles to the same hand computation, read back through SQL'`. **This WP adds a second, independent hand computation**: the seed now carries a manual asset ($450,000.00), a liability ($18,250.00) and a CAD account, with `netWorth.expectedTotal = $465,925.56` declared as a literal and its arithmetic written out — asserted by `packages/seed/test/investments-ground-truth.test.ts` → `'the declared net worth is the sum of its declared parts'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| b   | A past date's net worth is immutable across a re-run                                                              | **Proven at the domain layer; the cold-stack half is carried to the gate** | `packages/contexts/planning/test/db/seal.test.ts` → `'a past date is byte-identical after a second snapshot run'`, `'SABOTAGE: lets the writer update a sealed row, and the database refuses by name'`, `'refuses to recompute a sealed day through the ordinary write path'`; route half `apps/api/test/db/net-worth-routes.test.ts` → `'a correction supersedes the sealed day and never rewrites it'`. **Carried:** dispatch §5 asks the gate to "re-run the snapshotter twice over the seed and diff the sealed range byte for byte" on the cold stack; no evidence file claims that has been done. The browser half (`apps/web/e2e/networth.spec.ts` → `'a past date on the chart is unchanged after a re-sync'`) exists but is **invisible to CI** — see §8 item 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| c   | ETH on Coinbase and in a wallet resolves to one security                                                          | **Proven against fixtures; the live Coinbase leg needs Chris's account**   | `packages/contexts/investments/src/resolver.test.ts` → `'ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId'`; DB half `packages/contexts/investments/test/db/securities.test.ts` → `'ETH from Coinbase, a wallet contract address and Plaid ETHEREUM resolve to one security_id'`; connector half `packages/connectors/walletrpc/test/one-security.test.ts` → `'both sightings canonicalise onto the same NATIVE_ASSETS row — one chain, one identity'`; end-to-end `apps/api/test/db/phase3-wiring.test.ts` → `'a security seen as a ticker and later as a FIGI is one securities row'` (added by WP 3.7a to close the splitting defect WP 3.7 §11.1 found). The seed now carries ETH with all three identifier kinds (`ticker`, `chain_contract`, `cusip`) so a loader has the subject to hand. **Needs real accounts:** wp3.5 §10 — "the live smoke has never run", no CDP key on this machine.                                                                                                                                                                                                                                                                                                                         |
| d   | A missing FX rate surfaces rather than defaulting                                                                 | **Proven**                                                                 | `packages/contexts/planning/test/fx-missing.test.ts` → `'a missing rate raises FxRateUnavailable and never returns 1.0'` and, crucially for a control that must discriminate, `'accepts a genuine observation that happens to be exactly 1.0'`. **Observed live during this WP**: with the seeded CAD account and no `fx_rates` rows, `computeNetWorth` threw `FxRateUnavailable: no FX rate for CAD/USD on or before 2026-09-24 … This is deliberately an error rather than a 1.0` while `investments-perf.test.ts` was being built — the control firing over the seed, unplanned (§5, S0). **Closed (§10 below):** `apps/api/test/db/net-worth-routes.test.ts` → `'POST /net-worth/corrections surfaces planning.fx_rate_missing rather than defaulting to 1.0'` proves the HTTP translation at `apps/api/src/routes/net-worth.ts:344–350` (409, `planning.fx_rate_missing`, the pair named in `detail`), and a second test on the same fixture, `'GET /net-worth (the ledger "now" read) reports the CAD balance on its own line, never folded into USD at 1.0'`, proves the complementary half of the criterion on the un-FX'd ledger read (`accounts.ts`'s `GET /net-worth`), where a CAD total sits on its own currency line rather than a converted USD one. |
| e   | Allocation matches a spreadsheet check                                                                            | **Proven**                                                                 | `packages/contexts/investments/src/analytics/allocation.test.ts` → `'allocation matches the committed spreadsheet fixture to the cent'`, over `test/fixtures/allocation-{portfolio,expected}.csv`. **This WP re-runs it from the seed's own vocabulary**: `packages/seed/test/investments-ground-truth.test.ts` → `'allocation matches the committed spreadsheet fixture, rebuilt from seed shapes'` maps every fixture row through `SeedSecurity` + `SeedPhase3Holding` first, so a seed that lost `expenseRatio`, `isCashEquivalent` or one-security-in-two-accounts would fail. Browser half `apps/web/e2e/investments.spec.ts` → `'the allocation donut totals match the committed spreadsheet fixture'` exists but is invisible to CI (§8 item 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### The v0.5 rung (§2.3)

> "Holdings reconcile to balances; allocation matches a spreadsheet check; crypto
> on-ramps classified as transfers."

| Clause                                  | Verdict                                                   | Proof, or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdings reconcile to balances          | **Proven** (was: the one clause of the rung with no test) | `apps/api/test/db/holdings-reconcile.test.ts` → `'holdings reconcile to balances on the seed'` and `'a holding whose price is missing is reported as unreconciled, never silently reconciled'`. Written at the **route** seam rather than inside `@ctx/investments`: both sides are read back over real HTTP — Σ of `GET /accounts/{id}/holdings`'s `positions[].marketValue` against `GET /accounts`'s `balance.current` — so the claim covers the ladder, the valuation, the rounding and the serialisers, not just a context function. Three of the four seeded investment accounts agree **to the cent**; the fourth's difference is named and asserted (§13 below, with the per-account table and the sabotage). The `institution_value_minor` route the earlier verdict recommended is unavailable by construction: the column is written but **exposed on no route**, which §13 records as a gap. |
| Allocation matches a spreadsheet check  | **Proven**                                                | criterion (e) above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Crypto on-ramps classified as transfers | **Proven against recorded fixtures**                      | `packages/connectors/coinbase/test/onramp.test.ts` → `'a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending'`, `'a fiat deposit is a transfer, never income'`. Live leg needs Chris's Coinbase account (wp3.5 §10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
4. ~~**The route-level `fx_rate_missing` surfacing has no test** (§1 criterion d).~~ **Closed,
   §10.** `apps/api/test/db/net-worth-routes.test.ts` now carries the test.
5. ~~**"Holdings reconcile to balances" — the v0.5 clause with no test.**~~ **Closed, twice,
   independently.** §13 closes it at the route seam (`apps/api/test/db/holdings-reconcile.test.ts`,
   a concurrent agent's). §10 below closes it a second way, at the pure-function seam this
   item originally pointed at: `@ctx/investments`'s own `reconcile.ts` compares
   `institution_value_minor` to Σ(quantity × price) directly, with unit fixtures and a
   Postgres round trip, independent of any route. Both stand; neither supersedes the other
   — a route-level proof and a context-level proof fail for different reasons.
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

---

## 10. Close-out 2026-09-24 — §8 items 4 and 5, both closed

_A separate finishing pass over §1's own audit, dispatched by the orchestrator specifically
for the two clauses §1 named as gaps: criterion (d)'s HTTP surfacing, and the v0.5 rung's
"holdings reconcile to balances". Ownership for this pass:
`packages/contexts/investments/src/reconcile.ts` (new), one export line in that package's
`index.ts`, `packages/contexts/investments/test/holdings-reconcile.test.ts` (new),
`packages/contexts/investments/test/db/holdings-reconcile.test.ts` (new),
`apps/api/test/db/net-worth-routes.test.ts`, and this file — nothing else touched._

**A note on §13, found already in the tree at the start of this pass.** A concurrent agent
independently closed the same v0.5-rung clause at a different altitude —
`apps/api/test/db/holdings-reconcile.test.ts`, a route-level HTTP proof
(`GET /accounts/{id}/holdings` Σ against `GET /accounts`'s balance) — before this pass
started writing. Rather than rewrite or duplicate §13's own table row and prose (already
correct, already sabotage-tested, and not this pass's file to edit), this section adds a
second, independent proof at the seam §8 item 5 originally pointed at: a pure function
inside `@ctx/investments` itself, comparing `institution_value_minor` to
Σ(quantity × price) directly, with no HTTP, no route serialiser and no seed dependency in
the path. The two proofs fail for different reasons — a route proof catches a serialiser or
ladder-wiring regression the pure function cannot see; the pure function catches an
arithmetic or tolerance regression a route test would only see indirectly, through whatever
fixture happens to be seeded. Both are now in the tree, neither superseding the other.

### 10.1 Holdings reconcile to balances (§1 v0.5 rung, §8 item 5) — the pure-function proof

`packages/contexts/investments/src/reconcile.ts` — `reconcileHolding`/`reconcileHoldings` —
compares a `Holding`'s stored `institutionValue` against a computed
`marketValueOf(quantity, price, scale)` (reusing `basis.ts`'s existing arithmetic; no new
rounding is introduced) and reports one of three states: `reconciled`, `tolerance_breach`
(with both values and the signed `differenceMinor`), or `no_price` — never a silent pass.

**The tolerance rule: one minor unit per holding.** `marketValueOf` rounds
`quantity × price` half-even into minor units exactly once; the institution's own value is
an independent rounding of the same real number, at the same scale. Two honest roundings of
one true value can differ by at most one unit in the last place — that is what "rounding"
means — so one minor unit is the largest gap that can be explained by rounding alone.
Anything larger is `tolerance_breach`: a stale price, a wrong quantity, an unapplied
corporate action, or a genuine data error, and the signed difference is diagnostic (an exact
multiple of the price points at a quantity bug; a difference proportional to the whole
position points at a stale price). This is stated in full, with the reasoning, in the file's
own header comment.

Tests:

- `packages/contexts/investments/test/holdings-reconcile.test.ts` (project `investments`,
  hand-built fixtures — `@core/seed` is not importable from this package's tests; see the
  file header and `docs/TESTING.md`'s note on the `context` layer's allow-list):
  - `'holdings reconcile to balances'` — the criterion, verbatim as the test name asked for
    — four holdings in one `reconcileHoldings` call: an exact match (`reconciled`,
    `differenceMinor: 0n`), a one-minor-unit disagreement at the tolerance boundary
    (`reconciled`, `differenceMinor: -1n`), a 150-minor-unit disagreement
    (`tolerance_breach`), and a holding with no price at all (`no_price`).
  - `'a difference of exactly one minor unit is reconciled; two is a tolerance_breach'` —
    isolates the boundary: one minor unit off is `reconciled`, two is `tolerance_breach`.
  - `'an 18-decimal crypto quantity reconciles exactly, with no float in the path'` — a
    `NUMERIC(38,18)`-shaped quantity string through the same arithmetic.
  - `'never coerces a currency mismatch between the holding and the price'` — throws, the
    same convention `Money.add` states in `docs/CONVENTIONS.md`.
- `packages/contexts/investments/test/db/holdings-reconcile.test.ts` (project
  `investments-db`) — the two real write paths agree with the pure function: a holding
  written by `drizzleLotStore.upsertHolding` (the sync/import path) and a price written by
  `recordUserPriceOverride` (the rung-1 write path), both read back through the real store
  (`drizzlePriceStore` + `createPriceReader` for the price; a plain `SELECT` for the holding,
  since `LotStore` exposes no holdings reader) and handed to `reconcileHolding` unchanged.
  Three tests: an exact reconciliation, a `no_price` holding (no price row written at all),
  and a $48.80 `tolerance_breach`.

**Sabotage**, both on `reconcile.ts`, each applied, run, and reverted (byte-identical restore
confirmed by re-diffing against a pre-sabotage copy):

1. `DEFAULT_RECONCILE_TOLERANCE_MINOR` widened from `1n` to `1_000_000_000_000n` (an
   effectively infinite tolerance). **RED, first attempt** — 2 of 4 tests in
   `holdings-reconcile.test.ts` failed: the `tolerance_breach` fixture in the composite test
   silently reclassified as `reconciled` (`expected "tolerance_breach" ... Received
"reconciled"`), and the boundary test's `tolerance_breach` case likewise. Restored; 4/4
   green.
2. The price term dropped from the computed value
   (`marketValueOf(holding.quantity, { ...price, amount: Quantity.zero }, scale)`).
   **RED, first attempt** — 3 of 4 tests failed: every fixture whose institution value was
   non-zero was reclassified `tolerance_breach` (`computedValue.minor` forced to `0`), e.g.
   `expected computedValue.minor 472500n, Received 0n` on the 18-decimal ETH fixture.
   Restored; 4/4 green.

### 10.2 A missing FX rate surfaces rather than defaulting (§1 criterion d, §8 item 4)

`packages/contexts/planning/test/fx-missing.test.ts` already proved the domain layer
(`computeNetWorth` throws `FxRateUnavailable`, never a 1.0). The gap §1 named was the HTTP
seam: `apps/api/src/routes/net-worth.ts` around line 344 catches it with the exported
`isFxRateUnavailable` predicate and translates it to a 409 named `planning.fx_rate_missing`
— untested until now.

Added to `apps/api/test/db/net-worth-routes.test.ts`, a new, isolated `describe` block (its
own `ApiHarness`, not sharing the file's existing `beforeAll` — reusing it would put a CAD
account with no FX rate into every other test's shared setup and fail them at `beforeAll`
instead of proving anything):

1. seed a USD account, compute and write one open (unsealed) day, so `asOfDate` has an
   existing revision for `correctDay` to supersede (`SealedRowImmutable`/404 otherwise — the
   same rule the file's own `'refuses a correction to a day that has no revision to
supersede'` test exercises);
2. link a **second**, CAD account with a balance dated on `asOfDate`, and deliberately write
   **no** `fx_rates` row for CAD/USD at all — reproducing on purpose the unplanned §5 S0
   finding ("`computeNetWorth` threw ... while `investments-perf.test.ts` was being built");
3. two tests:
   - `'POST /net-worth/corrections surfaces planning.fx_rate_missing rather than defaulting
to 1.0'` — asserts `409`, `code: 'planning.fx_rate_missing'`, and that `detail` names
     both currencies and contains `'rather than a 1.0'` (the same wording
     `fx-missing.test.ts` asserts on the domain error's own message).
   - `'GET /net-worth (the ledger "now" read) reports the CAD balance on its own line, never
folded into USD at 1.0'` — the complementary half of the criterion, on the route that
     never attempts FX conversion at all (`accounts.ts`'s `GET /net-worth`, per its own file
     header: "adding dollars to euros here would be a wrong number rendered confidently"):
     asserts the CAD total is `708000` minor on its own currency line, and the USD total is
     exactly `500000` — the USD account's own balance, not `500000 + 708000` at par.

**Sabotage**, on `apps/api/src/routes/net-worth.ts`, applied, run, and reverted
(byte-identical restore confirmed by `diff` against a pre-sabotage copy):

The `isFxRateUnavailable(error)` branch gated with `if (false && isFxRateUnavailable(error))`
— the route falls through to the generic `throw error`, i.e. it swallows the dedicated
translation and lets the error become an unhandled 500. **RED, first attempt**:

```
FAIL … > POST /net-worth/corrections surfaces planning.fx_rate_missing rather than defaulting to 1.0
AssertionError: expected 500 to be 409
```

The other 9 tests in the file, including the new `GET /net-worth` test, stayed green — the
sabotage only touched the one branch it targeted. Restored; 10/10 green.

### 10.3 A defect found, not fixed (out of ownership)

`apps/api/src/routes/accounts.ts`'s `GET /net-worth` (`netWorthNow`, `@ctx/ledger`) never
attempts FX conversion **at all**, regardless of whether a rate exists — it is not that a
missing rate is refused there, it is that no rate is ever consulted on that surface. That is
the correct behaviour for the criterion this pass tested (a CAD total on its own line, never
folded in at par) and is asserted as such, but it means `GET /net-worth` cannot itself
distinguish "no FX rate exists yet" from "FX rate exists but we don't convert here" — both
render identically as an un-converted per-currency line. Not a defect in what was tested, but
worth the gate knowing: the "surfaces rather than defaulting" guarantee lives entirely on the
`@ctx/planning` seam (`computeNetWorth` / `POST /net-worth/corrections`), not on the ledger
"now" read, which was never going to convert in the first place. Neither `accounts.ts` nor
`@ctx/ledger` is this pass's file to change.

### 10.4 Verification

Every command in the foreground, at this tree, with
`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev` (an
already-running dev Postgres found listening on `127.0.0.1:5433`; no compose stack started or
touched by this pass, per `docs/TESTING.md`).

| Command                                                                              | Result                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `pnpm exec tsc -b --noEmit`                                                          | **clean**                                                                 |
| `pnpm exec eslint` (every file this pass touched)                                    | **clean**                                                                 |
| `pnpm exec prettier --write` (every file this pass touched)                          | **clean** (whitespace-only diffs)                                         |
| `node scripts/check-numeric-boundaries.ts`                                           | self-test PASS, tree **PASS** — 689 files, 0 violations                   |
| `pnpm exec vitest run --project investments`                                         | **23 files, 204 tests passed**                                            |
| `pnpm exec vitest run --project investments-db`                                      | **6 files, 40 tests passed**                                              |
| `pnpm exec vitest run --project api-db test/db/net-worth-routes.test.ts`             | **1 file, 10 tests passed**                                               |
| Sabotage 1 (infinite tolerance), `investments` / `holdings-reconcile.test.ts`        | **RED, first attempt** — 2/4 failed; restored, 4/4 green                  |
| Sabotage 2 (price term dropped), `investments` / `holdings-reconcile.test.ts`        | **RED, first attempt** — 3/4 failed; restored, 4/4 green                  |
| Sabotage 3 (route swallows `fx_rate_missing`), `api-db` / `net-worth-routes.test.ts` | **RED, first attempt** — 1/10 failed (500 not 409); restored, 10/10 green |

`git diff --cached --name-only` empty throughout (memory: staged-rename-leak). This pass's
tree touches exactly: `packages/contexts/investments/src/{reconcile.ts (new),index.ts}`,
`packages/contexts/investments/test/{holdings-reconcile.test.ts (new),db/holdings-reconcile.test.ts (new)}`,
`apps/api/test/db/net-worth-routes.test.ts`, and this file.

_A full `--project investments --project investments-db --project api-db` re-run follows this
write-up; see the line appended immediately below when it completes. One known, pre-existing,
unrelated failure to expect in the `api-db` project: `test/db/phase3-wiring.test.ts`'s
`module.planning: a real ledger.BalanceRecorded reaches the net-worth consumer...` test failed
independently of this pass's changes (confirmed: it fails when `net-worth-routes.test.ts` is
excluded from the run too), most likely a collision with the concurrent agent's in-flight
edits to `packages/connectors/**` / `packages/contexts/connections/**` /
`apps/api/test/db/investments-routes.test.ts` — none of which this pass touched or owns._

_Orchestrator's re-run at commit time (2026-09-24 23:07 EDT, the agent's own background re-run
was killed as a session orphan): `--project investments --project investments-db` → **29 files,
244 tests passed**; `--project api-db test/db/holdings-reconcile.test.ts test/db/net-worth-routes.test.ts`
→ **2 files, 13 tests passed**. `just verify` at e03fdb8 was green through check and the web
build, then stopped at Playwright with three 30 s timeouts under a load average of ~12 (two
agents' suites running concurrently); all three pass in isolation (walkthrough 2/2 with
`--repeat-each 2`). The steps after Playwright (gitleaks, license, hardening, trivy) did not
run locally. CI on the real runner at 5e0f51a: 12/13 green — gitleaks, hardening, trivy and
Playwright all passed there; the license gate was red only on the `THIRD_PARTY.md` lockfile
stamp (the `@ctx/investments` devDependency added to `@core/seed` changed the lockfile),
restamped in the following commit._

---

## 13. Holdings reconcile to balances — now tested

_Added after the §1 audit, which found this clause of the v0.5 rung (§2.3) had no test in
the tree. It is the only row of that table this section changes; §8 item 5, which carried
it as owed, is superseded by what follows._

`apps/api/test/db/holdings-reconcile.test.ts` (project `api-db`), three tests:

1. `'the seeded portfolio is in the database and every seeded investment account is covered'`
2. `'holdings reconcile to balances on the seed'`
3. `'a holding whose price is missing is reported as unreconciled, never silently reconciled'`

### 13.1 What is compared, and why the two sides are independent

Σ of `GET /accounts/{id}/holdings` → `positions[].marketValue`, against
`GET /accounts` → `balance.current`, for every seeded investment account. Both over the
real application (`buildApp`, real guards, real Zod serialisers) on a scratch Postgres.

The two sides do not share a derivation, which is the whole point of the exercise:

- **The balance** is the institution's figure. It is recorded over HTTP through
  `POST /accounts/{id}/balance` — the same writer a sync uses — from
  `phase3-investments.ts`'s **hand-computed `expectedMarketValue` literals**, the ones
  `packages/seed/test/investments-ground-truth.test.ts` grades against `marketValueOf`.
- **The Σ** comes back out of the database through `readHoldings` → WP 3.4's price ladder
  → `valueHoldings`' single half-even rounding at the minor-unit boundary → the route's
  own response schema.

A generator that lied, a ladder that picked the wrong rung, a rounding that moved or a
route that dropped a position separates them. Test 1 additionally asserts that each
declared balance **is** Σ of the seed's own declared values, so the expectation table
cannot drift away from the generator; that assertion is one of the two that the sabotage
in §13.4 turns red.

### 13.2 The per-account table

Printed by the test itself on every run (`process.stdout.write`), reproduced verbatim:

```
holdings reconcile to balances (seed 314):
| Account | Balance | Σ holdings | Difference | Verdict / reason |
| --- | --- | --- | --- | --- |
| Taxable Brokerage | USD 18,315.36 | USD 18,315.36 | USD 0.00 | reconciled / exact |
| Rollover IRA | USD 7,471.00 | USD 7,471.00 | USD 0.00 | reconciled / exact |
| Crypto Exchange | USD 3,150.00 | USD 3,150.00 | USD 0.00 | reconciled / exact |
| CAD Brokerage | CAD 7,080.00 | USD 0.00 | incomparable | unreconciled / foreign_currency_not_converted (XIC) |
```

| Account           | Balance        | Σ holdings   | Difference       | Reason, asserted by name                                                                                                                                                                                                   |
| ----------------- | -------------- | ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taxable Brokerage | `$18,315.36`   | `$18,315.36` | **`$0.00`**      | `exact`. 3 VTI × $305.12 = $915.36, 20 AAPL × $245.00 = $4,900.00, **plus the $12,500.00 cash sweep** — see §13.3.                                                                                                         |
| Rollover IRA      | `$7,471.00`    | `$7,471.00`  | **`$0.00`**      | `exact`. 100 BND × $71.50 = $7,150.00 + 5 VXUS × $64.20 = $321.00. VXUS was transferred in with no basis: what it _cost_ is `unavailable` (04 §5.5), what it is _worth_ is not, and it reconciles like any other position. |
| Crypto Exchange   | `$3,150.00`    | `$3,150.00`  | **`$0.00`**      | `exact`. 1.000000000000000000 ETH × $3,150.00 — an 18-decimal quantity rounded once, at the boundary.                                                                                                                      |
| CAD Brokerage     | `CAD 7,080.00` | `USD 0.00`   | **incomparable** | `foreign_currency_not_converted`. The report is USD, there is no USD quote for XIC, and the position is **excluded and named** rather than counted at par. See §13.5.                                                      |

The manual asset (`$450,000.00`) and the liability (`$18,250.00`) hold no positions and
are criterion (a)'s subject, not this one's. Test 1 asserts that the two accounts the
suite does _not_ reconcile are exactly those two, by `kind` — so the table cannot quietly
cover fewer accounts than the seed carries.

### 13.3 The cash sweep, asserted as a counterfactual

wp3.7 §5's second row says a sweep is face value, not a quote. A reconciliation that
valued only the **investable** positions would report a `$12,500.00` hole in an account
that is in fact correct, so the clause is asserted both ways:

- the `CASH` position is present, priced `$12,500.00`, and **not stale**; and
- `total − Σ(non-cash positions) === 1_250_000` minor units, exactly.

Worth recording how the sweep gets priced at all, because it is not the obvious path: the
`cash` ladder is `['user_override', 'last_known']`, so the only rung that can answer for
`CASH` is `last_known`, which takes the most recent observation **strictly before** the
day asked for. The fixture therefore writes three recent days at `closeOnAsOf` with a
fresh `observed_at`, not one. A series that stopped at the seed's last month-end would be
_entirely_ STALE at read time (07 §6.1 reads `observed_at`, not `price_date`) and every
position in every account would be excluded — this file would then pass by reporting four
unreconciled accounts, which is the way it could most plausibly have proved nothing.

### 13.4 Sabotage: one cent on one balance

The taxable account's recorded balance was changed from `1831536` to `1831537` minor
units — a single cent — and the suite re-run. Two tests red, on the first attempt:

```
 ❯ |api-db| test/db/holdings-reconcile.test.ts (3 tests | 2 failed) 3187ms
     × the seeded portfolio is in the database and every seeded investment account is covered
     × holdings reconcile to balances on the seed

 FAIL  … > the seeded portfolio is in the database and every seeded investment account is covered
AssertionError: Taxable Brokerage: Σ of the seed's declared values: expected '1831536' to be '1831537'

 FAIL  … > holdings reconcile to balances on the seed
AssertionError: Taxable Brokerage: 3 VTI × $305.12 = $915.36, 20 AAPL × $245.00 = $4,900.00,
and the $12,500.00 cash sweep — $18,315.36 to the cent. …: expected 'unreconciled' to be 'reconciled'

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

Restored; green again (§13.7). Note the second failure's shape: the corrupted account did
not merely miss its expected difference, it changed **verdict** — a cent with nothing to
explain it is `unexplained`, and `unexplained` never reconciles.

### 13.5 The unreconciled mechanism, and "never silently reconciled"

The verdict is computed by a `reconcile()` helper over a closed list of reasons —
`exact`, `unpriced_position_excluded`, `stale_position_excluded`,
`foreign_currency_not_converted`, `balance_missing`, `unexplained` — with one rule written
into the function rather than into an assertion, so that it holds for every account on
every run:

> **An excluded position can never produce a `reconciled` verdict**, including when the
> arithmetic happens to land on zero.

That is what test 3 is named for. It deletes **every** `prices` row for the seeded BND
security (every date, every source: leaving one behind would let the `last_known` rung
answer and the position would stay priced), then asserts, against the Rollover IRA:

| Claim                              | Assertion                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| The account is flagged             | `verdict === 'unreconciled'`, `reason === 'unpriced_position_excluded'`                    |
| The flag **names the security**    | `namedSecurities === ['BND']`; `excluded === [{ symbol: 'BND', reason: 'price_unknown' }]` |
| The position is not erased         | it is still in `positions[]`, with `marketValue: null` and `price: null`                   |
| `null`, never a zero               | a zero would be a valuation this system never made                                         |
| It was **not** silently reconciled | balance still `$7,471.00`, valued Σ now `$321.00`, difference `$7,150.00 ≠ 0`              |
| The hole is accounted for          | the difference **equals** the missing position's own market value                          |

The IRA is asserted `reconciled / exact` immediately **before** the deletion, so the red
verdict is a control and not a coincidence. The rows are re-inserted verbatim in a
`finally`, and the account is asserted `reconciled / exact` again afterwards — which both
proves the restore and keeps the suite from poisoning anything downstream of it.

The CAD account exercises the same machinery from the other side, for D4: `total` is
asserted **not** to be `708000` (CAD 7,080.00 counted as USD 7,080.00 is exactly the §5
"never"), and asserted to be `0` with `XIC` excluded and named.

### 13.6 Route field gaps — recorded, not edited around

No route was touched. Both gaps are computed around inside the test:

1. **No route reports a reconciliation.** Neither response carries a difference, a verdict
   or a tolerance, so the difference is computed in the test from the two payloads.
   Relatedly, and this is the one the §1 audit row had pointed at:
   `holdings.institution_value_minor` is written
   (`packages/contexts/investments/src/lots-store.ts:337`) but is **exposed on no route at
   all** — it is absent from `/accounts/{id}/holdings`'s `positions[]` and from
   `/holdings`'s aggregated rows. So the _per-position_ half of wp3.7 §5's table cannot be
   reconciled over HTTP by anyone, test or user. The account-level balance is used
   instead, which is what the criterion ("holdings reconcile to _balances_") actually says.
2. **`excluded[].reason` under-describes the CAD case.** The seeded CAD position comes back
   as `price_unknown`, not `currency_mismatch`, because `createPriceReader` filters
   observations by quote currency (`prices.ts` → `observationsOnOrBefore(userId,
securityId, quoteCurrency, date)`) before `valueHoldings`' `currency_mismatch` branch
   ever sees a row. The position **is** priced — in CAD, on every date in the series — it
   is simply not priced in USD, and "we have no price" is a materially different thing to
   show a user than "we have a price we cannot convert". The behaviour that exists is
   pinned by the test; the label is thinner than the cause, and closing that is a route or
   context change neither this section nor this file owns.

### 13.7 Verification

Every command in the foreground, at this tree.

| Command                                                                                            | Result                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `DATABASE_URL=… pnpm exec vitest run --project api-db apps/api/test/db/holdings-reconcile.test.ts` | **1 file, 3 tests passed** — 10.3 s      |
| the same, with one balance corrupted by `$0.01`                                                    | **2 of 3 failed** (§13.4), then restored |
| `pnpm exec tsc -b --noEmit`                                                                        | **clean**                                |
| `pnpm exec eslint apps/api/test/db/holdings-reconcile.test.ts`                                     | **clean**                                |
| `pnpm exec prettier --check apps/api/test/db/holdings-reconcile.test.ts`                           | **clean**                                |

This section's tree touches exactly `apps/api/test/db/holdings-reconcile.test.ts` (new) and
this file (the §2.3 audit row and §13). No route, no context, no config, nothing staged.
