# WP 4.14 — quality pass: the reference fixtures, the numeric-boundary alias hole, the shared invariants module, golden-value drift, and the Phase 4 exit-criteria audit

_Written 2026-09-28 at `b78c76d` (a `wip` snapshot commit, unpushed, left by a session killed by an
account limit mid-write on the shared invariants module) plus this session's working tree. Dispatch:
[`docs/plan/04-phase-4-dispatch.md`](../../plan/04-phase-4-dispatch.md) §3 "WP 4.14", §1, §5. This is a
**finishing** pass: the killed session had already landed the reference fixtures
(`test/reference/independent-cases.{csv,md,py}`), `test/reference.test.ts` (at the relocated path — see
below), the numeric-boundary check's alias-aware extension, and a first draft of
`test/reference/invariants.ts` that was written but never wired to a consumer. This document finishes
the wiring, adds `golden-drift.test.ts` (not started), sabotages every new/extended check once, records
the cross-tool comparison, and audits every §5 exit criterion. Two other finishing agents (WP 4.11:
`apps/web/src/workers/**`, `features/plan/sliders/**`; WP 4.12c: backend + `investments`/`investments`
features) are concurrently editing the same tree — every file this document names outside this WP's
ownership was read, never edited._

---

## 0. What shipped, and where it actually lives

| Artefact                          | Path                                                                      | Status                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference fixtures (cases D, E)   | `packages/contexts/planning/test/reference/independent-cases.{csv,md,py}` | Landed by the killed session; verified here                                                                                                                                                                                                                   |
| The exit test                     | `packages/contexts/planning/test/reference.test.ts`                       | Landed (at the relocated path, see below); extended here with invariant tests                                                                                                                                                                                 |
| Numeric-boundary alias resolution | `scripts/check-numeric-boundaries.ts`                                     | Landed by the killed session; verified and sabotaged here                                                                                                                                                                                                     |
| The exit test                     | `scripts/check-numeric-boundaries.test.ts`                                | Extended here with the dispatch's named test                                                                                                                                                                                                                  |
| Shared invariants module          | `packages/contexts/planning/test/reference/invariants.ts`                 | Landed but **unwired** by the killed session (its own docstring's claim that `test/reference.test.ts` consumed it was false — no import existed); wired here, and its `'bootstrap'`-engine gap (no `series` threading, so any `'bootstrap'` call threw) fixed |
| Golden-value drift                | `packages/contexts/planning/test/golden-drift.test.ts`                    | Not started; written here                                                                                                                                                                                                                                     |
| `docs/TESTING.md`                 | —                                                                         | Extended here: the alias-hole closure, the reference fixtures + invariants module, golden-value drift                                                                                                                                                         |
| `.github/workflows/ci.yml`        | —                                                                         | **Not touched.** See §6.                                                                                                                                                                                                                                      |
| This document                     | `docs/evidence/phase-4/wp4.14-quality.md`                                 | New                                                                                                                                                                                                                                                           |

**Why `test/reference.test.ts` lives at `test/reference.test.ts`, not `test/reference/reference.test.ts`.**
The dispatch's literal exit-test path (§3, §1) is
`packages/contexts/planning/test/reference/reference.test.ts`. The `planning` vitest project's `include`
is `src/**/*.test.ts` and `test/*.test.ts` (`vitest.config.ts` line 311) — a single `*`, not `**` — so a
spec nested one level under `test/reference/` is never collected. **Confirmed empirically, not trusted
from the killed session's own header comment**: `reference.test.ts` was temporarily moved to
`test/reference/reference.test.ts`, `vitest list --project planning` was re-run, the file restored, and
the restore diffed byte-identical against a copy taken before the move:

```
$ mv test/reference.test.ts test/reference/reference.test.ts
$ pnpm exec vitest list --project planning 2>&1 | grep -c "reference/reference.test.ts"
0
$ mv test/reference/reference.test.ts test/reference.test.ts
$ diff <pre-move copy> test/reference.test.ts   # byte-identical
$ pnpm exec vitest list --project planning 2>&1 | grep -c "reference.test.ts"
6   # 6 distinct test names vitest list prints; the 7th ('run')-visible test
    # is the it.each in "invariant 2 … both engines", which `list` collapses
    # to one line ("… — %s") but `run` actually executes twice — §7's later
    # `vitest run` count (7/7) is the one that matches test *execution*.
```

The killed session had already made this call and left a header comment explaining it; this document
independently re-confirms it rather than trusting the comment. The fixtures themselves
(`independent-cases.{csv,md,py}`) are data, not specs, and stay under `test/reference/`, matching the
dispatch's own path and this repo's `test/engine/fixtures/` precedent. `golden-drift.test.ts` follows the
same reasoning and stays at `test/golden-drift.test.ts` (the dispatch's literal path names
`test/engine/golden-drift.test.ts`, which _is_ collected by the glob — but the file lives beside
`reference.test.ts` instead, both for consistency and because `test/engine/` is WP 4.4/4.5's directory,
not this WP's).

---

## 1. The §1 exit-criteria audit

Verbatim from the dispatch §1:

> 10k paths ≤ 800 ms p95; identical seed ⇒ identical bytes; deterministic output within 1% of an
> independent reference calculator on the shipped fixtures; assumptions visible, editable, cited.

| #   | Criterion                                                             | Verdict                                                                               | Proof, or what is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | 10k paths ≤ 800 ms p95                                                | **Proven on the scale seed, alone; contention and the production HTTP path are open** | WP 4.5 `engine/perf.test.ts` + WP 4.13 `apps/api/test/db/projection-perf.test.ts`, both against the 200-position/5-year scale seed (WP 4.13's own exit criterion). WP 4.5's own evidence records the budget reading **red under contention** (p95 1,142 ms at load, vs. 800 ms) with "headroom ≈20% alone, none under contention" — not this WP's control to re-run, but the gate's own rule 7 (`just verify`, not `just check`) exists partly for this reason. WP 4.13's evidence flags the HTTP-path half still calls `runProjection` directly rather than over real `fetch()`, because `POST /plan/scenarios/{id}/projections` was WP 4.8's route and had not landed when WP 4.13 wrote the test — carried explicitly to whichever WP rebinds it without renaming the test.                                                                                                                                                                                                                                                                          |
| b   | Identical seed ⇒ identical bytes                                      | **Proven**                                                                            | WP 4.5 `reproducible.test.ts` → `'an identical seed produces byte-identical output across two processes'`, paired with a different-seed test. Adjacent but distinct: WP 4.5's invariant 3 (statistical p5 stability across _different_ seeds, not byte-identity of the _same_ seed) reads red at n=10,000 in that WP's own evidence (1.4–1.9% vs. a 1% target, 1.509% reconfirmed in WP 4.6's evidence) — a real, still-open finding, but about MC convergence, not about this criterion. Recorded here so the gate does not conflate the two.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| c   | Deterministic output within 1% of an independent reference calculator | **Proven, this WP**                                                                   | `test/reference.test.ts` → `'every committed reference case matches within 1%'` (§2 below) and `'a deliberately wrong engine constant pushes a case outside 1% and the test goes red'`. This closes an item WP 4.4's own evidence left explicitly open: "the LibreOffice Calc reference run and the Bengen/cFIREsim golden-value comparisons were not done… assigned to WP 4.14 or the gate." The LibreOffice half is still not done — **no LibreOffice on this build host**, re-checked for this WP with the same result WP 4.4 recorded — but the dispatch's own §5 risk-table language treats "a LibreOffice Calc model… **plus**… published golden values… **plus**… a cross-tool check" as three legs, not one gate; this WP supplies an independent Python `decimal` model (cases D, E) instead of the Calc leg, keeps WP 4.4's committed Calc-formula-equivalent cases (A, B, C), and adds the cross-tool leg (§5 below). Bengen/Guyton-Klinger published-golden fixtures (07 §8.4 item 1(b)) are **not built** — recorded as an open item (§8). |
| d   | Assumptions visible, editable, cited                                  | **Proven at WP 4.2/4.8; not this WP's control**                                       | WP 4.2 `'every number… carries a non-empty source and an as_of date'`, content-hash-on-edit sabotage (S1/S1b, both red first attempt per its evidence); WP 4.8's `PUT /assumptions/overrides` for "editable." Two caveats recorded in WP 4.2's own evidence and re-surfaced here because this WP's exit-criteria audit is exactly where they belong: SSA bend points and the $150,000 Roth catch-up threshold are **not re-verified against a primary source** (403 from the sandbox reaching ssa.gov), and REIT has a correlation row but no stated μ/σ default — unclear whether WP 4.4/4.5 refuse or map it explicitly. Both need Chris or a machine with outbound access to a government site; carried.                                                                                                                                                                                                                                                                                                                                             |

### The v0.6 rung (§2.3)

> "Deterministic projection within 1% of a reference calculator; Monte Carlo reproducible with a fixed
> seed."

Both clauses map onto (c) and (b) above and are **proven** by the same tests. Neither is closed by a
screenshot, per the dispatch's own instruction.

---

## 2. The reference fixtures: provenance

Two committed, independent references feed `test/reference.test.ts`, neither sharing code with the
TypeScript engine or with each other:

- **WP 4.4's `test/engine/fixtures/reference-projection.{csv,md,py}`** — cases A, B, C.
- **This WP's `test/reference/independent-cases.{csv,md,py}`** — cases D (a CPI-indexed pension
  offsetting spending) and E (the solver's `nominal` target basis), each exercising a code path A/B/C do
  not (`pension.ts`'s `cola: 'cpi'` branch; `boundary.ts#toEngineTarget`'s nominal-to-real deflation).

Both tool, run and inputs are recorded in `independent-cases.md`, reproduced here since it is the
provenance record the dispatch asks for:

- **Tool:** `independent-cases.py`, Python 3.14.7, the `decimal` module at 50 significant digits, rounded
  half-even to the cent only when printed. Implements the OpenDocument OpenFormula `FV`/`PMT` definitions
  (ODF 1.2 Part 2 §6.12.20, §6.12.36) — the same standard WP 4.4's fixture cites.
- **Run:** `python3 independent-cases.py > independent-cases.csv`, 2026-09-27.
- **Why not LibreOffice itself:** not installed on this build host — checked again for this WP (`which
soffice`, `which libreoffice`: neither present), same result WP 4.4's evidence recorded. The formulas
  in `independent-cases.md`'s "Named cells" table reproduce the CSV if pasted into a Calc sheet.
- **Inputs:** the same 07 §5.5 defaults as WP 4.4's fixture (`capitalMarket.usEquity.expectedReturn`
  0.065, `usAggregateBonds.expectedReturn` 0.045, `inflation.mean` 0.025), copied by hand — a change to
  the assumptions file's defaults turns this reference red until re-derived, which is the point.

`test/reference.test.ts`'s third test, `'both references ship with their formulas and were not produced
by the engine'`, asserts the formula columns are present in both `.md` files and that neither Python
script imports the TypeScript engine or the other script — independence as a test, not a comment.

**Bengen/Guyton-Klinger published golden values (07 §8.4 item 1(b)) are not built.** This is a real gap
against the dispatch's §5 risk-table wording ("published golden values… committed as
`reference/published/*.json`"), carried explicitly (§8).

---

## 3. The shared invariants module (`test/reference/invariants.ts`)

07 §8.4's engine invariants are already implemented, **inline**, by WP 4.5's
`src/engine/invariants.test.ts` — outside this WP's ownership (dispatch §3 lists
`packages/contexts/planning/test/reference/**`, not `src/engine/`), so it is not edited. The killed
session's `invariants.ts` factors each invariant's _computation_ (no `expect` inside) into reusable
functions — `zeroVolatilityGap`, `successCountFor`, `monotoneLeverCheck`, `p5RelativeStandardError` —
every one calling the same production entry points WP 4.5 built (`runMonteCarlo`, `toMonteCarloJob`,
`projectDeterministic`).

**What was actually broken when the session was killed, found by trying to use the module rather than
just reading it:**

1. **Its own docstring's central claim was false.** It said `test/reference.test.ts` was "that second
   consumer" running invariant 1 against cases D and E. No import of `invariants.ts` existed anywhere in
   `reference.test.ts` at `b78c76d`. Wired here: two new `describe` blocks.
2. **No function accepted a return series.** Every function took an `EngineKind` parameter, implying a
   caller could ask for `'bootstrap'`, but none threaded a `series` through to `MonteCarloRequest` —
   `montecarlo.ts` throws `'the bootstrap engine needs a return series'` when `job.series === null` and
   `job.engine === 'bootstrap'`. Every function now takes an optional `series: ReturnSeries | null =
null` parameter.
3. **`AssumptionsLike` was imported from the wrong module** (`../../src/assumptions.ts`, which has no
   such export; it lives in `../../src/engine/boundary.ts`) — a `tsc -b` failure, not merely unwired.
4. **Invariant 1 does not hold for `'bootstrap'`, and the module's own header did not say so.** Confirmed
   empirically before writing the fix, not assumed: running `zeroVolatilityGap` for case D under
   `'bootstrap'` (fix 2 above applied, series supplied) produced `successMatches: false` and a
   multi-hundred-thousand-dollar `maxAbsMinorDifference`. Cause: `montecarlo.ts`'s bootstrap draw sizes
   its shock from the return series' own variance (`equityShockSd = sqrt(12 * series.equityVariance)`),
   never from `capitalMarket.*.volatility` — so `withZeroVolatility`'s override is a no-op for
   `'bootstrap'`, and the invariant cannot hold there by construction. WP 4.5's own
   `src/engine/invariants.test.ts` already only asserts this invariant for `'lognormal'`; the module's
   header now says so explicitly instead of implying "both engines" applies uniformly to every invariant.

**What `test/reference.test.ts` now actually runs**, both added by this WP:

- `describe("07 §8.4 invariant 1, against WP 4.14's own cases D and E …")` — `zeroVolatilityGap` for
  cases D and E, `'lognormal'` only (per the finding above), asserting `successMatches` and a
  sub-$2-across-the-horizon `maxAbsMinorDifference` (a Money-rounding tolerance, not the bitwise equality
  WP 4.5's own suite achieves by comparing engine floats directly rather than a summary's rounded band).
- `describe("07 §8.4 invariant 2, against WP 4.14's own case D … both engines")` — `monotoneLeverCheck`
  over **both** `'lognormal'` and `'bootstrap'` (the latter against
  `test/engine/fixtures/synthetic-series.ts`, never the fetched Shiller cache, so it reproduces on a
  fresh clone and in CI): a $4,000/yr larger contribution never lowers the common-random-numbers success
  count. This is where "both engines run" is genuinely exercised — invariant 1 structurally cannot be.

`golden-drift.test.ts` (§4) is a further consumer, reusing `successCountFor`.

All 7 tests in `test/reference.test.ts` pass (§7).

---

## 4. Golden-value drift (`test/golden-drift.test.ts`)

07 §8.5's release gate: `MC golden-value tests drift > 0.5pp`. New file, not started by the killed
session. **A regression control, not a correctness control** — `reference.test.ts` above owns "is the
number right"; this file only compares the engine's current output to its own committed past output.
Also a **different** control from WP 4.11's `test/fixtures/golden-vector.json` (client worker vs. server
engine parity, at one instant) — not merged with it.

One fixed plan (a balanced $250,000 `TAX_DEFERRED` saver, $12,000/yr wage-growing contributions, 60/40
static glidepath, $68,000/yr real spending, Social Security $2,500/mo from age 67), one seed, one golden
success-probability percentage per `EngineKind` — `'lognormal'` parametric and `'bootstrap'` against the
synthetic series. The plan was deliberately chosen to sit away from both 0% and 100% under both engines
(verified empirically, not assumed), because a plan pinned at either rail cannot show a drift in the
direction that rail forbids.

**How the golden constants were derived**, so a future reader can re-derive them rather than trust them:
run the file once against placeholder constants, read the `PROBE … current …` line each `it.each` case
prints to stderr, paste each printed value back in as `goldenPct`. Recorded values (this WP,
2026-09-28): `'lognormal'` 56.433333333333336%, `'bootstrap'` 57.43333333333334%, both at 3,000 paths,
seed `20260928n`. A future _intentional_ engine change moves these two numbers in the same commit as the
change, with a note on why — 07 §7.3's "why did it say $720" standard, applied to the engine's own
baseline.

All 3 tests pass (§7).

---

## 5. Cross-tool agreement (07 §8.4 item 5)

**Tool:** FI Calc (ficalc.app), a historical-cycle retirement withdrawal simulator, accessed live
2026-09-28 via a headless browser session (network to `ficalc.app` and `cfiresim.com` both confirmed
reachable from this build host first; cFIREsim's own UI is considerably more multi-step, so FI Calc was
used).

FI Calc simulates **only the retirement withdrawal phase** — it takes a starting portfolio value as a
given, not an accumulation projection — so two comparisons were made, both against the same underlying
plan (the golden-drift plan, §4):

**Comparison A — the whole plan, engine-native "success probability."** The engine's own success
probability (§4's golden `'lognormal'` value, 56.43%) covers 30 years of _stochastic_ accumulation (age
35→65) **and** 30 years of stochastic retirement withdrawal — the eventual retirement nest egg is itself
random. FI Calc has no accumulation-phase concept, so it was fed the plan's **deterministic** projected
balance at retirement ($1,256,876.14, read from `projectDeterministic` at the age-64/65 year boundary) as
its fixed starting portfolio, 30-year duration, 60% stocks/40% bonds, $68,000/yr real spend, $30,000/yr
Social-Security-tagged income starting 2 years into retirement, inflation-adjusted. **Result: 100% (125
of 125 historical 30-year cycles), against the engine's 56.43%.**

This divergence is large and **expected, not evidence of a defect**: FI Calc's 100% is conditioned on
reaching the deterministic $1.257M nest egg with certainty, while the engine's 56.43% also carries the
risk that a bad accumulation-phase sequence never gets there. Comparing them directly would be
comparing different measurements, which is exactly the trap 07 §8.4 item 5 warns against ("large
divergence means an assumption is mis-specified") if taken at face value here — the assumption is not
mis-specified; the two tools are answering different questions.

**Comparison B — retirement-only, apples to apples.** A second engine run, a plan that is _already_
retired on `asOf` (birth date set so age is exactly 65 on the plan's `asOf`, `retirementAge: 65`, no
further contributions), with the **same** $1,256,876.14 starting balance, 60/40 allocation, $68,000/yr
spend and Social Security terms as FI Calc's inputs — isolating the retirement withdrawal phase the way
FI Calc measures it. `successCountFor(…, 'lognormal', 5000 paths)`: **76.06%**, against FI Calc's 100%.

This narrower comparison is a genuine, if still notable, divergence (100% vs. 76.06%, ~24 points) with a
plausible, named cause rather than a shrug: FI Calc draws its 125 simulations from **overlapping**
30-year windows of one ~150-year historical record (Shiller's), which are strongly autocorrelated and
include the mid-to-late-20th-century's historically strong US equity returns in most windows; the
engine's `'lognormal'` mode draws **i.i.d.** shocks from the assumptions file's parametric mean/volatility
(07 §5.5's defaults), which places more probability mass on genuinely bad 30-year sequences than the
historical record's finite, overlapping sample does. This is the same phenomenon WP 4.5's own evidence
names from the other direction ("bootstrap re-centring ~0.5 pt/yr optimistic on real history" — i.e., even
the _historical-bootstrap_ engine mode was found more optimistic than a naive read of history, before
recentring correction; `'lognormal'` was not recentred against history at all, so a gap in the same
direction is consistent, not surprising).

**Recorded per the dispatch's own terms — tool, date, inputs, resulting rate — so a later divergence is
visible:**

|                     | FI Calc input                                                                                           | Value              |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| Duration            | 30 years                                                                                                |                    |
| Initial portfolio   | $1,256,876.14                                                                                           |                    |
| Allocation          | 60% Stocks (S&P 500), 40% Bonds (10yr UST)                                                              |                    |
| Withdrawal strategy | Constant Dollar                                                                                         |                    |
| Annual spend        | $68,000/yr, inflation-adjusted                                                                          |                    |
| Income              | "Social Security," $30,000/yr, inflation-adjusted, starts 2 years into retirement, repeats indefinitely |                    |
| **Result**          | **Success rate**                                                                                        | **100% (125/125)** |

Screenshot: `docs/evidence/phase-4/screenshots/wp4.14-ficalc-crosstool.png`.

Not committed as a fixture (a third-party web tool, per the dispatch's own instruction); this table and
the two engine numbers it is compared against (56.43% whole-plan, 76.06% retirement-only) are the
committed record.

---

## 6. The numeric-boundary check: the alias hole, closed

**Design, unchanged from WP 3.14 except where noted.** `check-numeric-boundaries.ts` parses
`packages/**/*.ts` and `apps/api/src/**/*.ts` with the TypeScript parser, syntax only. Phase 4 is the
first phase where `number` is legal _somewhere_ — the Monte Carlo/deterministic kernel's interior,
reached through exactly one named pair of functions in `boundary.ts` (dispatch §5 risk 1) — which is
exactly the shape the old, purely-syntactic check could not see: `type EngineDollars = number` used as a
return type is invisible to a check that only recognises `ts.SyntaxKind.NumberKeyword` directly.

**What the killed session had already built, verified rather than re-derived:** `collectTypeAliases`
walks every local `type X = <TypeNode>` alias in a source file up front; `mentionsNumber` now resolves an
identifier through that map (cycle-safe via a `seen` set, however many hops) wherever it checks for a
`number`-shaped type. `git diff HEAD~1 -- scripts/check-numeric-boundaries.ts` shows the shape of the
change; this WP's contribution was verifying it (real-tree run, `--self-test`, the fixture suite) and
adding the exit test the dispatch names, which did not yet exist.

**Two `ALLOW_LIST` entries, each with a reason, both landed by the killed session and verified here:**

1. `packages/contexts/planning/src/engine/boundary.ts#toEngineAmount` — the named boundary-crossing
   function itself (dispatch §5 risk 1): converts `Money` → `EngineDollars` (the interior `number` alias)
   at the single legal seam, rounded once on the way back out through `fromEngineAmount`.
   `fromEngineAmount` takes `EngineDollars` as a parameter rather than returning it and does not match the
   magnitude name pattern, so it needs no entry of its own — the crossing stays exactly one named pair.
2. `packages/connectors/csv/src/csv.ts#amount` — `CsvColumnMapping.amount` names _which column_ (by
   header text or 0-based index — `ColumnRef = string | number`) holds a row's signed amount; it is the
   column reference, never the amount. A pre-existing crossing the old syntactic check could not see
   either, surfaced only because the check now resolves the `ColumnRef` alias — found as a side effect of
   fixing the boundary hole, not gone looking for.

**Real-tree result:**

```
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 780 file(s) scanned, 0 violations, 74 exempt identifier(s)
```

**The exit test, added by this WP** (`check-numeric-boundaries.test.ts`, the dispatch's own name):
`'a float assigned to a value inside the engine but outside the named boundary fails the check'` —
`checkSource` against a synthetic `packages/contexts/planning/src/engine/fake-crossing.ts` with the same
`type EngineDollars = number` / `value: EngineDollars` shape as the real boundary, **not** on the
`ALLOW_LIST`, and confirms it still fails. Proves the alias resolution is not a blanket exemption for the
file's _shape_ — only for the one named file+identifier the list actually allows.

---

## 7. Sabotage: every new/extended check observed red, once, on the first valid attempt, then restored byte-identical

Per the memory lesson "a control that has never been observed failing is not evidence" and the gate
standard §5 rule 2. Every sabotage below was a **temporary, in-place edit to a file inside this WP's own
ownership**, run, observed, then reverted; `git diff` was read after each revert to confirm no residue.
No sabotage touched a file outside this WP's ownership (the "wrong engine constant" is injected through
the runtime assumptions-override path the production code exposes, `diffOverrides`/`applyOverrides` —
`packages/contexts/planning/data/assumptions.ts`, WP 4.2's file, was never edited).

| #   | Check                                                                                 | Sabotage                                                                                                                                                                                                   | Result                                                                                                                                                                                   | Restored                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `test/reference.test.ts` → `'every committed reference case matches within 1%'`       | The module-level `assumptions` temporarily built from `applyOverrides(loadAssumptions(), diffOverrides(…, { 'capitalMarket.usEquity.expectedReturn': '0.30' }), …)` instead of a clean `loadAssumptions()` | **RED, first attempt.** `AssertionError: A age 44: engine 115359972 vs reference 25606444: expected 3.505114884362702 to be less than 0.01`                                              | Reverted to `const assumptions = loadAssumptions();`; re-run: 7/7 green                                                                                                                                                                   |
| S2  | `scripts/check-numeric-boundaries.ts`, real tree                                      | The `boundary.ts#toEngineAmount` `ALLOW_LIST` entry commented out                                                                                                                                          | **RED, first attempt.** `FAIL — 1 violation(s) in 780 file(s) … packages/contexts/planning/src/engine/boundary.ts:131 [number-at-a-magnitude-boundary] toEngineAmount() returns number.` | Restored; re-run: `PASS — 0 violations` (and, while restoring, an unrelated stale path in the entry's own `why` text — `test/reference/reference.test.ts` — was corrected to `test/reference.test.ts`, the file's actual, relocated path) |
| S3  | `test/golden-drift.test.ts` → `'lognormal: the success probability has not drifted…'` | The committed `'lognormal'` `goldenPct` temporarily changed `56.433…` → `58.5` (a 2.07pp shift)                                                                                                            | **RED, first attempt.** `AssertionError: current 56.43333333333334% vs golden 58.5%: expected 2.066666666666663 to be less than or equal to 0.5`                                         | Reverted to `56.433_333_333_333_34`; re-run: 3/3 green                                                                                                                                                                                    |

The control tests **embedded in the suites themselves** (`reference.test.ts`'s `'a deliberately wrong
engine constant pushes a case outside 1% and the test goes red'`, `golden-drift.test.ts`'s `'a golden
Monte Carlo value drifting more than 0.5 percentage points fails — the control'`, and
`check-numeric-boundaries.test.ts`'s new exit test) run this same sabotage-and-observe cycle **every time
the suite runs**, through the assumptions-override path or a synthetic in-memory source string rather
than a tree edit — S1–S3 above additionally exercised the _named, real_ exit tests directly, once, to
prove the sabotage the embedded controls perform is not vacuous.

---

## 8. Open items, and what is asked of the orchestrator

Mined from every `docs/evidence/phase-4/wp4.*.md`'s "For the orchestrator" / "Open items" / "Carried"
sections (dispatch §3's instruction: "the audit mines them"), filtered to what bears on this WP's
territory or the exit-criteria audit above. Status as last recorded in each WP's own evidence — this WP
did not re-verify any of them unless stated.

**Blocking or partially blocking an exit criterion:**

- WP 4.4 — Bengen 4%-rule / Guyton-Klinger published golden-value fixtures (07 §8.4 item 1(b)) not built.
  This WP supplied the cross-tool leg (§5) and the independent-Python-model leg (§2) but **not** this one.
  Carried to the gate or a follow-up WP.
- WP 4.5 — invariant 3 (MC p5 stability across seeds, `'stable within 1%'`) reads **1.4–1.9%** at
  n=10,000 in WP 4.5's own evidence, reconfirmed (1.509%) in WP 4.6's. Not this WP's control (§8.4
  invariant 3 is not one this WP's shared module implements — the killed session's `invariants.ts` only
  factored invariants 1 and 2), but it sits directly beside exit criterion (b) above and should not be
  mistaken for it by a reader skimming green checkmarks.
- WP 4.5 — perf budget (exit criterion a) reads red under contention; the HTTP-path half of WP 4.13's
  perf test still calls the engine directly rather than over `POST /plan/scenarios/{id}/projections`
  because that route had not landed at write time. Whoever lands it inherits rebinding the test **without
  renaming it** (the dispatch's exit-test name is load-bearing for the gate's grep).
- WP 4.2 — SSA bend points and the $150,000 Roth catch-up threshold not re-verified against a primary
  source (sandbox has no route to ssa.gov). Needs Chris or a machine with outbound access.
- WP 4.2 — REIT has a correlation-matrix row but no stated expected-return/volatility default; unclear
  whether the engine refuses a REIT-classified holding or silently maps it to something else. Needs a
  direct check against `src/engine/boundary.ts#toEnginePlan` and `montecarlo.ts`'s asset handling, out of
  this WP's ownership.

**Not blocking an exit criterion, but load-bearing for the gate's own standard (§5 rules 3, 6, 8):**

- WP 4.7 — `apps/api/src/domain.ts` wiring for I1/I3/I5 (allocation targets, idle cash, employer stock)
  was, as of WP 4.7's own evidence, **specified but not applied** — "the load-bearing open item;
  everything else in this WP is inert without it." (Observed during this session: `apps/api/src/domain.ts`
  shows as modified in `git status` under a concurrent agent's edits — plausibly this landing in progress;
  not verified by this WP, out of ownership.)
- WP 4.9 — `createInsightsPlanningPort` binding specified but, per WP 4.9's own evidence, not applied as
  of its writing — until landed, production snapshots carry no goals/risk-profile/plan-projection data
  for R1–R7.
- WP 4.w (wave C wiring) — the Monte Carlo `worker.ts` binding, its config key, and its compose volume
  were, per that WP's evidence, specified but not built; `MAX_CONCURRENT_MONTE_CARLO_RUNS = 8` is a bare
  literal in `domain.ts`, not config-tunable, and has not been load-tested — directly relevant to the §5
  risk-table row "the Monte Carlo worker is an unbounded resource," whose control (declared
  `resourceLimits`, a per-worker refusal) is proven per-worker but not proven at the concurrency-cap
  level.
- WP 4.12a — sabotage records for two gate conditions (C-2, C-14) were lost to the same class of
  session-limit kill this WP itself recovered from; that WP's evidence flags its own re-sabotage as owed
  to a later gate pass.
- Several WPs (4.1, 4.3, 4.7, 4.9) carry real-account-dependent items (revealed-behavior cross-checks,
  employer-stock inference, a real brokerage statement) explicitly requiring Chris's own linked accounts,
  on the same terms Phase 3's dispatch §6 Q8 already established — unchanged by this WP.

**This WP's own carried items:**

- The shared invariants module (`test/reference/invariants.ts`) factors invariants 1 and 2 only;
  invariant 3 (p5 stability across seeds) is not factored out, because WP 4.5's own reading of it is
  already red (above) and duplicating a red control into a second file was judged not to add evidence.
- A future landing that refactors `src/engine/invariants.test.ts` (WP 4.5, out of this WP's ownership) to
  import from `test/reference/invariants.ts` rather than keep its own inline copies would remove the
  remaining duplication between the two files; not done here, since it would be an out-of-ownership edit
  to already-committed code.
- `scripts/check-ci-projects.ts` reads **41/41** at this WP's landing commit, not the **40/40** the
  dispatch's §5 rule 5 states for Phase 4 ("Phase 4 should create none"). No project was added by this
  WP; the count moved from concurrent WPs' work (WP 4.11/4.12c) landing in the same tree during this
  session. Recorded as a process finding for the gate, per rule 7's own instruction to report a repeatedly
  skipped condition as a finding rather than silently absorb it — this is the first time this specific
  count has moved, not a repeat, so it is reported once here rather than escalated.

---

## 9. For the orchestrator

- **`ci.yml`: no changes made, and none were needed.** This WP created no new vitest project;
  `test/reference.test.ts` and `test/golden-drift.test.ts` both live under the existing `planning`
  project's `test/*.test.ts` glob, and the `check-numeric-boundaries.test.ts` addition lives under the
  existing `scripts` project — both already enumerated in `ci.yml`'s `test` job
  (`--project planning --project ... --project scripts`, confirmed present, `ci.yml` around line 210).
- **`ALLOW_LIST` entries, with reasons:** §6 above, both already landed by the killed session and
  verified/sabotaged by this one; no new entries added by this WP.
- **Cross-tool record:** §5 above — FI Calc, 2026-09-28, both the whole-plan and retirement-only
  comparisons, with the divergence's likely cause named rather than left as a bare number.
- **Open items:** §8 above, mined from every Phase 4 evidence file's own "For the orchestrator"/"Open
  items" section, filtered to this WP's audit scope.
- **Screenshot:** `docs/evidence/phase-4/screenshots/wp4.14-ficalc-crosstool.png`.

---

## 10. Verification

```
$ pnpm exec tsc -b --noEmit
(clean)

$ pnpm exec eslint scripts packages/contexts/planning/test/reference.test.ts \
    packages/contexts/planning/test/golden-drift.test.ts packages/contexts/planning/test/reference
(clean)

$ pnpm exec prettier --write <this WP's files, including docs/TESTING.md>
(applied; re-verified green after)

$ node scripts/check-numeric-boundaries.ts | tail -3
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 780 file(s) scanned, 0 violations, 74 exempt identifier(s)

$ pnpm exec vitest run --project scripts --project planning 2>&1 | tail -20
 Test Files  28 passed (28)
      Tests  146 passed (146)

$ node scripts/check-ci-projects.ts | tail -2
check-ci-projects: self-test PASS (5 fixtures + 3 parser checks, correct state clean, every broken shape caught)
check-ci-projects: PASS — all 41 vitest.config.ts project(s) are covered by ci.yml (26 in 'test', 16 in 'migration-test')

$ git diff --cached --name-only
(empty)
```

All run at this WP's landing commit, on the working tree as left (sabotages in §7 reverted and
re-verified green before this section was written).

**Post-report final re-run (immediately before handoff), unchanged from the above:** `tsc -b --noEmit`
clean; `eslint` clean; `check-numeric-boundaries.ts` — 780 files, 0 violations, self-test PASS;
`vitest run --project scripts --project planning` — 28 files / 146 tests passed; `check-ci-projects.ts`
— 41/41 covered, self-test PASS; `git diff --cached --name-only` — empty. No drift between the report
and this final pass.
