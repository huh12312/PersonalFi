# WP 4.2 — Assumptions: one file, versioned, cited

_07 §5.5, §6.4 and Appendix A as one checked-in, cited, hash-versioned file; per-user overrides stored
as deltas against a named version; the citation surface; the `macro_observations` decision. Migration
**0021**. Dispatch: `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.2", §5. Decisions D3, D6, D14, D15;
08 §6.5. Built on `main` at `6391428` (HEAD moved to `e1a4e7d` during the work; no file of mine
overlaps that commit). Phase 4 Wave A, concurrent with WP 4.1 and WP 4.12._

---

## 1. What shipped

| File                                                     | What it is                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contexts/planning/data/us-2026.ts`             | Appendix A, tax year 2026: 60 cited nodes. **Data only**: its one import is `import type`, so a copy of it loads from anywhere. That is what lets the hash test show that a comment is not a value.                                                                                                                     |
| `packages/contexts/planning/data/assumptions.ts`         | 07 §5.5 capital-market assumptions, the crypto disclaimer, the 8×8 correlation matrix, the SS stress lever, Appendix A market reference points, the dated macro constants, and `taxYears: { '2026': US_2026 }`. 32 cited nodes.                                                                                         |
| `packages/contexts/planning/src/assumptions.ts`          | The zod schema (strict at every level), load → freeze → hash, `assumptionsVersion()`, `taxYear()`, `diffOverrides` / `applyOverrides` / `resolveOverrides`, the four typed refusals, the `planning.AssumptionsOverridden` event, and the `plan_assumptions` store (`saveOverrides`, `loadOverrides`, `resolveForUser`). |
| `packages/contexts/planning/schema/assumptions.ts`       | The Drizzle `plan_assumptions` table. It is a new file, so WP 4.1's `schema/index.ts` edits and this one cannot collide.                                                                                                                                                                                                |
| `packages/db/migrations/0021_plan_assumptions.sql`       | `plan_assumptions`, `plan_assumption_deltas_are_well_formed(jsonb)`, three CHECKs, one UNIQUE index.                                                                                                                                                                                                                    |
| `packages/contexts/planning/OWNERSHIP.md`                | One appended line, `## Claimed by WP 4.2 — …`, plus the blank line Prettier requires before a heading. `plan_assumptions` was already claimed under `## Tables`. A second bullet would be a double claim, which `check-schema-ownership.ts` rejects even inside one package.                                            |
| `packages/contexts/planning/test/assumptions.test.ts`    | The four named exit tests, plus four supporting tests.                                                                                                                                                                                                                                                                  |
| `packages/contexts/planning/test/db/assumptions.test.ts` | The named DB exit test, plus the database-refusal test. Own scratch DB `personalfi_wp42_assumptions`.                                                                                                                                                                                                                   |

**Design, in four rules** (each is mechanised, and §7 sabotages each one):

1. **Every number lives in a cited node.** A cited node is `{ kind, value, source, asOf, note?, attribution? }`, and it is the only place a number may appear. Eleven kinds exist: `money`, `moneyRange`, `rate`, `rateRange`, `integer`, `fraction`, `index`, `fact`, `brackets`, `ageSchedule` and `correlation`. A published table (one bracket schedule, the correlation matrix) is **one** cited node, because it is one table in one primary source. Every number inside it carries that node's citation. Three independent layers enforce this: `satisfies AssumptionsFileInput` at `tsc`, the strict zod schema at load, and the raw-structure walk in the first named test.
2. **Rates and ratios are decimal strings; money limits are `Money`** (as `{ minor: bigint, currency: 'USD' }` literals, turned into kernel `Money` at load). Ages, calendar years and degrees of freedom are integer strings. The SSA early-claim reductions are exact fractions (`5/900`, `5/1200`), because 5/9 of 1% has no finite decimal form. No `number` holds any of them, so `check-numeric-boundaries` passes with 0 violations and no new ALLOW_LIST entry.
3. **The version is the content.** `assumptionsVersion()` = `sha256:` + SHA-256 over `@core/platform`'s `canonicalJson` of the validated file, with bigints written as decimal strings. The hash reuses `configHash`: SHA-256 as a content fingerprint, not cryptography, so it needs no `@core/secretbox` dependency, which `@ctx/planning` does not have. The hash covers values **and** sources, dates and notes, because those are what the UI prints. Comments never reach the object.
4. **Overrides are sparse deltas against a named version.** Only 17 capital-market paths can be overridden. The tax year is law: changing it means a new file version, not a preference. The correlation matrix cannot be edited cell by cell, because one edited cell can make it non-positive-definite. `diffOverrides` drops every override that equals the default it would replace.

---

## 2. The parameter table — all 92 cited nodes

The **Verified** column records what was checked against the primary source during this session:

- **fetched**: the primary document was fetched and the figure read from it. Rev. Proc. 2025-32 PDF, sha256 `e9ada115fb43a4af…`, text extracted with `pdftotext -layout`. Rev. Proc. 2025-19 PDF, sha256 `ff2ba4bac62ef694…`. The IRS IR-2025-111 newsroom page. FRED CSVs.
- **ssa.gov**: confirmed from ssa.gov search results. Direct fetches of ssa.gov returned **403**.
- **App. A**: transcribed from 07 Appendix A. The primary source is cited but was not re-fetched.
- **statute**: cited to the U.S.C., the CFR or SECURE 2.0 by section. Not fetched.
- **memo**: a PersonalFi default chosen in 07 §5.5/§6.4. The memo is its source of record, and `source` names the evidence the memo chose against.

All `asOf` for law is `2026-01-01`, the date the figure takes effect for tax year 2026. The publication appears in `source`.

### 2.1 Capital-market assumptions (07 §5.5 table, §6.4)

| #   | Path (under `capitalMarket.`)        | Value                                                                         | as_of      | 07 line                                    | Primary source                                                                         | Verified                                                                                    |
| --- | ------------------------------------ | ----------------------------------------------------------------------------- | ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `usEquity.expectedReturn`            | 0.065 nominal                                                                 | 2025-12-31 | §5.5 "US equity 6.5%"                      | Vanguard VCMM 10-yr US equity 3.9–5.9% (as of 2025-12-31) blended with ≈10% historical | memo                                                                                        |
| 2   | `usEquity.volatility`                | 0.17                                                                          | 2025-12-31 | §5.5 "σ 17%"                               | long-run US equity σ                                                                   | memo                                                                                        |
| 3   | `intlDevelopedEquity.expectedReturn` | 0.07 nominal                                                                  | 2025-12-31 | §5.5 "Intl developed 7.0%"                 | VCMM (non-US above US in recent runs)                                                  | memo                                                                                        |
| 4   | `intlDevelopedEquity.volatility`     | 0.19                                                                          | 2025-12-31 | §5.5 "σ 19%"                               | —                                                                                      | memo                                                                                        |
| 5   | `emergingEquity.expectedReturn`      | 0.075 nominal                                                                 | 2026-09-10 | §5.5 "Emerging 7.5%"                       | historical premium                                                                     | memo                                                                                        |
| 6   | `emergingEquity.volatility`          | 0.24                                                                          | 2026-09-10 | §5.5 "σ 24%"                               | —                                                                                      | memo                                                                                        |
| 7   | `usAggregateBonds.expectedReturn`    | 0.045 nominal                                                                 | 2025-12-31 | §5.5 "US agg 4.5%"                         | VCMM US agg ≈4–5%                                                                      | memo                                                                                        |
| 8   | `usAggregateBonds.volatility`        | 0.06                                                                          | 2025-12-31 | §5.5 "σ 6%"                                | —                                                                                      | memo                                                                                        |
| 9   | `tips.expectedReturn`                | 0.02 **inflation_adjusted**                                                   | 2026-09-10 | §5.5 "TIPS 2.0% real"                      | current TIPS yields                                                                    | memo                                                                                        |
| 10  | `tips.volatility`                    | 0.06                                                                          | 2026-09-10 | §5.5 "σ 6%"                                | —                                                                                      | memo                                                                                        |
| 11  | `cash.expectedReturn`                | 0.035 nominal                                                                 | 2026-09-10 | §5.5 "Cash 3.5%"                           | 3-mo T-bill ≈3.93% on 2026-09-10 (TradingEconomics)                                    | memo                                                                                        |
| 12  | `cash.volatility`                    | 0.01                                                                          | 2026-09-10 | §5.5 "σ 1.0%"                              | —                                                                                      | memo                                                                                        |
| 13  | `crypto.expectedReturn`              | 0.065 nominal                                                                 | 2026-09-10 | §5.5 / §6.4 "μ = 6.5% (equal to equity)"   | no defensible estimate; set equal to equity                                            | memo                                                                                        |
| 14  | `crypto.volatility`                  | 0.70                                                                          | 2026-09-10 | §5.5 / §6.4 "σ = 70%"                      | BTC-weighted                                                                           | memo                                                                                        |
| 15  | `crypto.distribution`                | fact: own class, Student-t or BTC block bootstrap, never lognormal            | 2026-09-10 | §6.4                                       | —                                                                                      | memo                                                                                        |
| 16  | `crypto.degreesOfFreedom`            | 3                                                                             | 2026-09-10 | §6.4 "Student-t(ν=3)"                      | —                                                                                      | memo                                                                                        |
| 17  | `crypto.disclaimer`                  | fact (the mandatory text, quoted in §2.7)                                     | 2026-09-10 | §6.4 treatments 1 and 2                    | —                                                                                      | memo                                                                                        |
| 18  | `inflation.mean`                     | 0.025 nominal                                                                 | 2026-09-10 | §5.5 "Inflation 2.5%"                      | long-run target                                                                        | memo                                                                                        |
| 19  | `inflation.volatility`               | 0.015                                                                         | 2026-09-10 | §5.5 "σ 1.5%"                              | —                                                                                      | memo                                                                                        |
| 20  | `wageGrowth.spreadOverInflation`     | 0.005                                                                         | 2026-09-10 | §5.5 "inflation + 0.5%"                    | —                                                                                      | memo                                                                                        |
| 21  | `equityRiskPremiumCrossCheck`        | 0.0423                                                                        | 2026-01-01 | §5.5 "ERP 4.23% (Jan 2026)"                | Damodaran implied ERP, NYU Stern `histimpl.html`                                       | memo (cross-check only)                                                                     |
| 22  | `correlation` (top level)            | 8×8 USEQ INTL EM BOND TIPS REIT CASH CRYPTO, the §5.5 upper triangle mirrored | 2026-09-10 | §5.5 matrix; §6.4 ρ(crypto, equity) = 0.40 | —                                                                                      | memo; symmetric, unit diagonal and positive definite (tested, minimum Cholesky pivot 0.524) |

### 2.2 Stress lever, market reference points, macro

| #   | Path                                         | Value          | as_of      | 07 line                        | Primary source                                        | Verified                  |
| --- | -------------------------------------------- | -------------- | ---------- | ------------------------------ | ----------------------------------------------------- | ------------------------- |
| 23  | `socialSecurityStress.fromCalendarYear`      | 2034           | 2026-09-10 | §5.8 "75% benefit after 2034"  | a lever, not a forecast                               | memo                      |
| 24  | `socialSecurityStress.payableRatio`          | 0.75           | 2026-09-10 | §5.8                           | —                                                     | memo                      |
| 25  | `marketReference.treasuryBill3Month`         | 0.0393         | 2026-09-10 | App. A "3-month T-bill ~3.93%" | TradingEconomics                                      | App. A                    |
| 26  | `marketReference.topHighYieldSavingsApy`     | 0.042–0.045    | 2026-09-10 | App. A "Top HYSA ~4.2–4.5%"    | Bankrate / Fortune 2026-09-10                         | App. A                    |
| 27  | `marketReference.nationalAverageSavingsRate` | 0.0038         | 2026-09-10 | App. A "0.38%"                 | Bankrate                                              | App. A                    |
| 28  | `marketReference.fdicInsuranceLimit`         | $250,000       | 2026-09-10 | App. A "FDIC $250,000"         | 12 U.S.C. 1821(a)(1)(E); 12 CFR 330.1(o)              | statute                   |
| 29  | `macro.cpiUrbanIndex`                        | 334.131        | 2026-08-01 | §5.5 FRED `CPIAUCSL`           | BLS CPI-U SA, via FRED                                | **fetched** (FRED CSV)    |
| 30  | `macro.cpiUrban12MonthChange`                | 0.0335         | 2026-08-01 | —                              | 334.131 ÷ 323.291 − 1 = 0.033530, rounded to 4 places | **fetched** (both points) |
| 31  | `macro.treasury10YearYield`                  | 0.0518 nominal | 2026-09-24 | §5.5 FRED `DGS10`              | Fed H.15, via FRED                                    | **fetched**               |
| 32  | `macro.treasury3MonthYield`                  | 0.0424 nominal | 2026-09-24 | §5.5 FRED `DGS3MO`             | Fed H.15, via FRED                                    | **fetched**               |

Rows 29, 31 and 32 carry the FRED attribution sentence in their `attribution` field, verbatim from WP 3.4 §4. That makes it a licence condition that travels with the figure, which WP 4.10 must render.

### 2.3 Retirement contributions (App. A "Retirement contributions", Notice 2025-67)

Paths are under `taxYears.2026.retirement.`

| #   | Path                                               | Value             | App. A line                                | Primary source                               | Verified                                        |
| --- | -------------------------------------------------- | ----------------- | ------------------------------------------ | -------------------------------------------- | ----------------------------------------------- |
| 33  | `electiveDeferral`                                 | $24,500           | 401(k)/403(b)/457(b)/TSP elective deferral | Notice 2025-67 / IR-2025-111                 | **fetched**                                     |
| 34  | `catchUpAge50`                                     | $8,000            | Catch-up, age 50+                          | same                                         | **fetched**                                     |
| 35  | `catchUpAge60To63`                                 | $11,250           | Catch-up, ages 60–63                       | same                                         | **fetched**                                     |
| 36  | `iraContribution`                                  | $7,500            | IRA contribution limit                     | same                                         | **fetched**                                     |
| 37  | `iraCatchUpAge50`                                  | $1,100            | IRA catch-up, 50+                          | same                                         | **fetched**                                     |
| 38  | `rothIraPhaseOut.singleOrHoh`                      | $153,000–$168,000 | Roth IRA phase-out, single/HoH             | same                                         | **fetched**                                     |
| 39  | `rothIraPhaseOut.mfj`                              | $242,000–$252,000 | Roth IRA phase-out, MFJ                    | same                                         | **fetched**                                     |
| 40  | `rothIraPhaseOut.mfs`                              | $0–$10,000        | Roth IRA phase-out, MFS                    | same                                         | **fetched**                                     |
| 41  | `traditionalIraDeductionPhaseOut.singleCovered`    | $81,000–$91,000   | Trad. IRA deduction, single (covered)      | same                                         | **fetched**                                     |
| 42  | `traditionalIraDeductionPhaseOut.mfjCovered`       | $129,000–$149,000 | Trad. IRA deduction, MFJ (covered)         | same                                         | **fetched**                                     |
| 43  | `traditionalIraDeductionPhaseOut.spouseNotCovered` | $242,000–$252,000 | Trad. IRA, non-covered spouse              | same                                         | **fetched**                                     |
| 44  | `saversCreditAgiLimit.mfj`                         | $80,500           | Saver's Credit AGI limit, MFJ              | same                                         | **fetched**                                     |
| 45  | `saversCreditAgiLimit.hoh`                         | $60,375           | …HoH                                       | same                                         | **fetched**                                     |
| 46  | `saversCreditAgiLimit.single`                      | $40,250           | …single                                    | same                                         | **fetched**                                     |
| 47  | `simpleDeferral.standard`                          | $17,000           | SIMPLE deferral (standard)                 | same                                         | **fetched**                                     |
| 48  | `simpleDeferral.applicablePlans`                   | $18,100           | SIMPLE deferral (applicable plans)         | same                                         | **fetched**                                     |
| 49  | `mandatoryRothCatchUpWageThreshold`                | $150,000          | Mandatory Roth catch-up threshold          | Notice 2025-67; IRC §414(v)(7)(A) as indexed | App. A (not in the fetched IR-2025-111 summary) |

### 2.4 Income tax (App. A "Income tax", Rev. Proc. 2025-32)

Paths are under `taxYears.2026.incomeTax.` A bracket row reads "over $X → rate".

| #   | Path                                      | Value                                                                                     | App. A line                                  | Primary source                  | Verified                              |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- | ------------------------------------- |
| 50  | `standardDeduction.single`                | $16,100                                                                                   | Std deduction single & MFS                   | Rev. Proc. 2025-32 §3.14(1)     | **fetched**                           |
| 51  | `standardDeduction.mfj`                   | $32,200                                                                                   | Std deduction MFJ                            | same                            | **fetched**                           |
| 52  | `standardDeduction.mfs`                   | $16,100                                                                                   | Std deduction single & MFS                   | same                            | **fetched**                           |
| 53  | `standardDeduction.hoh`                   | $24,150                                                                                   | Std deduction HoH                            | same                            | **fetched**                           |
| 54  | `brackets.single`                         | $0→10%; $12,400→12%; $50,400→22%; $105,700→24%; $201,775→32%; $256,225→35%; $640,600→37%  | Brackets (single)                            | §3.01 Table 3                   | **fetched**, matches App. A           |
| 55  | `brackets.mfj`                            | $0→10%; $24,800→12%; $100,800→22%; $211,400→24%; $403,550→32%; $512,450→35%; $768,700→37% | "approximately double the single thresholds" | §3.01 Table 1                   | **fetched** (App. A gives no figures) |
| 56  | `brackets.mfs`                            | as single up to 35%; $384,350→37%                                                         | — (not in App. A)                            | §3.01 Table 4                   | **fetched**                           |
| 57  | `brackets.hoh`                            | $0→10%; $17,700→12%; $67,450→22%; $105,700→24%; $201,750→32%; $256,200→35%; $640,600→37%  | — (not in App. A)                            | §3.01 Table 2                   | **fetched**                           |
| 58  | `longTermCapitalGains.single`             | $0→0%; **$49,450**→15%; **$545,500**→20%                                                  | LTCG single "≤$48,350 / ≤$533,400"           | §3.03 "All Other Individuals"   | **fetched — App. A is wrong, see §3** |
| 59  | `longTermCapitalGains.mfj`                | $0→0%; **$98,900**→15%; **$613,700**→20%                                                  | LTCG MFJ "≤$96,700 / ≤$600,050"              | §3.03 "Married … Joint Returns" | **fetched — App. A is wrong, see §3** |
| 60  | `longTermCapitalGains.mfs`                | $0→0%; $49,450→15%; $306,850→20%                                                          | —                                            | §3.03                           | **fetched**                           |
| 61  | `longTermCapitalGains.hoh`                | $0→0%; $66,200→15%; $579,600→20%                                                          | —                                            | §3.03                           | **fetched**                           |
| 62  | `netInvestmentIncomeTax.rate`             | 0.038                                                                                     | NIIT (3.8%)                                  | IRC §1411(a)(1)                 | statute                               |
| 63  | `netInvestmentIncomeTax.threshold.single` | $200,000                                                                                  | NIIT $200,000 single                         | IRC §1411(b)(3), not indexed    | statute                               |
| 64  | `netInvestmentIncomeTax.threshold.mfj`    | $250,000                                                                                  | NIIT $250,000 MFJ                            | IRC §1411(b)(1)                 | statute                               |
| 65  | `netInvestmentIncomeTax.threshold.mfs`    | $125,000                                                                                  | —                                            | IRC §1411(b)(2)                 | statute                               |
| 66  | `netInvestmentIncomeTax.threshold.hoh`    | $200,000                                                                                  | —                                            | IRC §1411(b)(3)                 | statute                               |
| 67  | `capitalLossOrdinaryOffset.standard`      | $3,000                                                                                    | "$3,000/yr, remainder carries forward"       | IRC §1211(b)(1); §1212(b)       | statute                               |
| 68  | `capitalLossOrdinaryOffset.mfs`           | $1,500                                                                                    | —                                            | IRC §1211(b)(1)                 | statute                               |

### 2.5 HSA, Social Security, RMDs

Paths are under `taxYears.2026.`

| #   | Path                                                   | Value                                                     | App. A line                        | Primary source                                   | Verified                     |
| --- | ------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------- | ------------------------------------------------ | ---------------------------- |
| 69  | `hsa.selfOnly`                                         | $4,400                                                    | HSA self-only                      | Rev. Proc. 2025-19 §2.01(1)                      | **fetched**                  |
| 70  | `hsa.family`                                           | $8,750                                                    | HSA family                         | same                                             | **fetched**                  |
| 71  | `hsa.catchUpAge55`                                     | $1,000                                                    | Catch-up 55+                       | IRC §223(b)(3)(B), not indexed                   | statute                      |
| 72  | `socialSecurity.cola`                                  | 0.028                                                     | COLA 2.8%                          | SSA press release 2025-10-24                     | **ssa.gov**                  |
| 73  | `socialSecurity.taxableWageBase`                       | $184,500                                                  | Taxable wage base                  | SSA OACT `cbb.html`                              | **ssa.gov**                  |
| 74  | `socialSecurity.bendPoints.first`                      | $1,286                                                    | PIA bend points                    | SSA OACT `bendpoints.html`                       | App. A (ssa.gov 403; see §9) |
| 75  | `socialSecurity.bendPoints.second`                     | $7,749                                                    | PIA bend points                    | same                                             | App. A (ssa.gov 403; see §9) |
| 76  | `socialSecurity.piaFactors.belowFirst`                 | 0.90                                                      | "(90% / 32% / 15%)"                | SSA §215(a)(1)(A)(i)                             | statute                      |
| 77  | `socialSecurity.piaFactors.betweenBendPoints`          | 0.32                                                      | same                               | §215(a)(1)(A)(ii)                                | statute                      |
| 78  | `socialSecurity.piaFactors.aboveSecond`                | 0.15                                                      | same                               | §215(a)(1)(A)(iii)                               | statute                      |
| 79  | `socialSecurity.fullRetirementAge`                     | born 1960+ → 67                                           | FRA, born 1960+                    | SSA §216(l)(1)                                   | statute                      |
| 80  | `socialSecurity.earlyReductionPerMonth.first36Months`  | 5/900                                                     | (07 §5.8 step 5)                   | 20 CFR 404.410(a)                                | statute                      |
| 81  | `socialSecurity.earlyReductionPerMonth.beyond36Months` | 5/1200                                                    | (07 §5.8 step 5)                   | 20 CFR 404.410(a)                                | statute                      |
| 82  | `socialSecurity.delayedRetirementCreditPerYear`        | 0.08                                                      | "8%/yr to age 70"                  | 20 CFR 404.313(a)                                | statute                      |
| 83  | `socialSecurity.delayedRetirementCreditEndsAtAge`      | 70                                                        | "…to age 70"                       | 20 CFR 404.313(a)                                | statute                      |
| 84  | `rmd.startAge`                                         | 1951–1959 → 73; 1960+ → 75                                | RMD age rows                       | SECURE 2.0 §107; IRC §401(a)(9)(C)(v)            | statute                      |
| 85  | `rmd.firstDistributionDeadline`                        | fact: April 1 of the following year; two RMDs if deferred | First RMD deadline                 | IRC §401(a)(9)(C)(i); Treas. Reg. §1.401(a)(9)-2 | statute                      |
| 86  | `rmd.missedDistributionExcise`                         | 0.25                                                      | "25%…"                             | SECURE 2.0 §302; IRC §4974(a)                    | statute                      |
| 87  | `rmd.missedDistributionExciseIfCorrected`              | 0.10                                                      | "…reduced to 10%"                  | IRC §4974(e)                                     | statute                      |
| 88  | `rmd.designatedRothAccounts`                           | fact, effective 2024-01-01                                | Roth 401(k)/403(b) RMDs eliminated | SECURE 2.0 §325; IRC §402A(d)(5)                 | statute                      |

### 2.6 Digital assets (App. A "Digital assets", status as of 2026-09)

| #   | Path (under `taxYears.2026.digitalAssets.`) | Value                      | Primary source                             | Verified |
| --- | ------------------------------------------- | -------------------------- | ------------------------------------------ | -------- |
| 89  | `costBasisTracking`                         | fact, effective 2025-01-01 | Rev. Proc. 2024-28                         | App. A   |
| 90  | `form1099Da`                                | fact, effective 2026-01-01 | Treas. Reg. §1.6045-1 (T.D. 10000)         | App. A   |
| 91  | `washSale`                                  | fact                       | IRC §1091; 2026 proposal (CNBC 2026-07-28) | App. A   |
| 92  | `stakingRewards`                            | fact                       | Rev. Rul. 2023-14                          | App. A   |

### 2.7 The crypto disclaimer, verbatim (`capitalMarket.crypto.disclaimer.value`)

> Crypto has fewer than 15 years of usable price history, all of it within one monetary regime. There is
> no defensible estimate of its expected return: this plan borrows the US-equity figure and pairs it with
> crypto's own, far larger volatility, which is a placeholder and not a forecast. Every plan is also
> shown with crypto valued at zero; if a plan only works with crypto, that is the finding.

The disclaimer deliberately repeats neither 6.5% nor 70%, so it cannot contradict the number beside it
after a user override. It uses none of 07 §7.2's banned phrases.

---

## 3. What the primary sources said that Appendix A did not

1. **Appendix A's LTCG breakpoints are the 2025 figures.** It lists $48,350 / $533,400 (single) and $96,700 / $600,050 (MFJ). Those come from Rev. Proc. 2024-40 (tax year 2025). Rev. Proc. 2025-32 §3.03, read from the fetched PDF:

   ```
   Married Individuals Filing Joint Returns and Surviving Spouse   $98,900   $613,700
   Married Individuals Filing Separate Returns                     $49,450   $306,850
   Heads of Household                                              $66,200   $579,600
   All Other Individuals                                           $49,450   $545,500
   ```

   **The file carries the Rev. Proc. figures.** Rows 58–59 have a `note` naming the discrepancy, so the UI shows it. **07 Appendix A needs correcting.** That file is not mine to edit, so this is an orchestrator item. It is exactly the error Appendix A's "never inlined in code" rule is meant to make fixable in one place.

2. **"MFJ thresholds approximately double the single thresholds"** is not a number. The file carries Table 1's published figures (row 55). Six thresholds are exactly double the single ones. **The 37% threshold is not**: it is $768,700, where doubling gives $1,281,200. A "double the single table" shortcut would put an MFJ couple with $800,000 of taxable income in the 35% bracket instead of the 37% one.

3. **HoH and MFS tables** (rows 56, 57, 60, 61, 65, 66, 68) are not in Appendix A at all. They are included so that a lookup by `FilingStatus` is total over the four statuses: an MFS user must get the MFS table, not a missing key.

4. **The 3-month bill has moved against the memo's "trending down."** Appendix A and the cash-return basis say ≈3.93% on 2026-09-10, trending down. FRED `DGS3MO` reads **4.24% on 2026-09-24**, and `DGS10` reads **5.18%**. The cash default (0.035) is a long-run assumption and is not changed by one observation. **It is recorded here for Chris**, because 07 §5.5 justifies it partly by the direction of travel.

---

## 4. The content hash — two processes, equal

```
$ for i in 1 2; do node --input-type=module -e "import { assumptionsVersion, loadAssumptions, canonicalAssumptionsJson } from './packages/contexts/planning/src/assumptions.ts'; console.log(JSON.stringify({ pid: process.pid, node: process.version, version: assumptionsVersion(), canonicalBytes: Buffer.byteLength(canonicalAssumptionsJson(loadAssumptions())) }))"; done
{"pid":4019316,"node":"v26.9.0","version":"sha256:d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f","canonicalBytes":28741}
{"pid":4019324,"node":"v26.9.0","version":"sha256:d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f","canonicalBytes":28741}
```

**Independently re-derived.** I wrote the canonical JSON to a file and hashed it with coreutils. The version is exactly `sha256(canonicalJson(file))` and nothing else:

```
$ node … process.stdout.write(canonicalAssumptionsJson(loadAssumptions())) > /tmp/wp42-canonical.json
$ sha256sum /tmp/wp42-canonical.json
d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f  /tmp/wp42-canonical.json
```

**Incidental proof that layout is not content.** The first smoke load ran before
`prettier --write` reformatted both data files: lines re-wrapped, arrays exploded, comments reflowed. It
printed the same `sha256:d294715e…`. Prettier changed the source text and not one value.

The same property is tested three ways, so it does not rest on this transcript:

- `'the content hash is identical across two separate node processes'` spawns two `node` children (different pids asserted) and compares both versions to the in-process one.
- `'the content hash changes when any value changes and not when a comment does'` mutates **every one of the 92 cited nodes** in turn, each in a fresh `structuredClone`. It asserts each mutation moves the version, and that all 93 versions (the baseline plus 92) are distinct. A changed `source` also moves the version. It then copies both data modules to a `mkdtemp` directory with the SPDX line followed by an inserted comment, the header doc-comment replaced wholesale and a trailing block comment appended. It `import()`s the copy and asserts the **same** version. Finally, the same copy mechanism with `24_500n → 24_501n` in the source text asserts a **different** version, which shows the probe can see a value edit.

---

## 5. The override round trip

`test/db/assumptions.test.ts` → `'a stored override resolves against its named file version, and an
unknown version refuses'`, against a real Postgres (scratch DB `personalfi_wp42_assumptions`):

| Step               | Input / action                                                                                                   | Observed                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| save               | `desired = { usEquity.expectedReturn: '0.0550', intlDevelopedEquity.expectedReturn: '0.07' }` in one transaction | returned `deltas = { usEquity.expectedReturn: '0.055' }`. The restated default was dropped and `0.0550` was canonicalised to `0.055`.                                                                                                      |
| the column         | `SELECT assumptions_version, deltas, jsonb_typeof(…), count(keys)`                                               | `sha256:d294715e…`, `{"capitalMarket.usEquity.expectedReturn": "0.055"}`, `string`, `1`                                                                                                                                                    |
| the event          | `domain_events` for the user                                                                                     | exactly one `planning.AssumptionsOverridden`, `aggregate_id` = the row id, payload `{ assumptionsVersion, overriddenPaths: ['capitalMarket.usEquity.expectedReturn'], overrideCount: 1 }`. Paths only, no values.                          |
| resolve            | `resolveForUser(db, { userId, timeZone: 'America/New_York' })`                                                   | `usEquity.expectedReturn` = `0.055`, `asOf 2026-09-26`, `source "Your override (the default is 0.065: PersonalFi default, 07 §5.5 — …)"`. `intlDevelopedEquity` stays on its default `0.07`. `overrides = [[usEquity…, '0.055', '0.065']]` |
| another holder     | `loadOverrides(otherUser)` / `resolveForUser(otherUser)`                                                         | `null` / defaults, `overrides = []`                                                                                                                                                                                                        |
| replace            | save `{}`, then save the override again                                                                          | one row per user (count `1`). An empty delta is stored as `{}`.                                                                                                                                                                            |
| retire the version | `UPDATE … SET assumptions_version = 'sha256:000…0'`                                                              | `resolveForUser` throws `UnknownAssumptionsVersion` with `requested = sha256:000…0` and `known = [sha256:d294715e…]`. It is **not** silently re-applied to today's file, and today's defaults are not quietly substituted.                 |

The database refuses what the code should never write (`'the database refuses a copy of the defaults,
a JSON number and a version that is not a content hash'`). Each refusal is a `23514` naming its
constraint:

| Insert                                                                               | Refused by                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| a nested copy `{capitalMarket:{usEquity:{expectedReturn:{kind,value,source,asOf}}}}` | `plan_assumptions_deltas_are_a_delta`             |
| `{ "capitalMarket.usEquity.expectedReturn": 0.055 }` (a JSON number)                 | `plan_assumptions_deltas_are_a_delta`             |
| `["capitalMarket.usEquity.expectedReturn", "0.055"]` (not an object)                 | `plan_assumptions_deltas_are_a_delta`             |
| version `'2026.1'`                                                                   | `plan_assumptions_version_is_a_content_hash`      |
| the well-formed `{ path: "0.055" }`                                                  | accepted, which is the control for the four above |

**Why a delta and not a copy, shown rather than asserted.** The unit test
`'an override stores a delta and never a copy of the default'` builds a next file version by moving
`intlDevelopedEquity.expectedReturn` from 0.07 to 0.072. It applies the user's stored delta (usEquity only)
to that version. The user **follows** the moved default (0.072) and keeps their own override (0.055). A
stored copy would have kept 0.07 forever and looked like a choice. A 200-run `fast-check` property then
confirms two things: the delta holds exactly the paths that differ, and applying it reproduces every
desired value while leaving every other path on its default.

---

## 6. The `macro_observations` decision (WP 3.4 §10 open item)

**Decided: a dated constant in the assumptions file. No `macro_observations` table in Phase 4.**
`macro.cpiUrbanIndex`, `macro.cpiUrban12MonthChange`, `macro.treasury10YearYield` and
`macro.treasury3MonthYield` each carry the observation date as `asOf`, the primary publisher (BLS, Fed
H.15) and the FRED series they were retrieved through as `source`, and FRED's attribution sentence.

Reasons, in order of weight:

1. **The version must be a function of the file alone.** `assumptions_version` is what makes 07 §7.3's "why did it say $720?" answerable. If the cited CPI came from a table, one version hash would mean different numbers on two installs, or on one install on two days. Either the hash would have to cover database state, and then it stops being a file version, or the run would record a version that does not reproduce what it saw. A dated constant avoids both: refreshing it is an edit, the edit moves the version, and the old version stays answerable.
2. **Nothing needs the series.** The surface wants one current figure with a date beside it. Appendix A says the market reference points "refresh quarterly". A quarterly file edit is that cadence exactly, with review attached. No Phase 4 engine input depends on these figures: the engine uses the long-run §5.5 assumptions, and the macro block is citation and cross-check.
3. **A table is not free.** It needs an owner (`@ctx/integrations`, which holds `FredSource`), a schedule, a job, the FRED egress path live on a timer, and attribution rendering at every display site. §4 item 9 of the dispatch says Phase 4 adds **no** egress host and **no** config or secret. A table would be the first exception, and for a citation.
4. **Offline.** 07 §5.5: "a self-hosted app must work offline". A constant needs no first fetch.

**When the answer changes.** A macro table becomes right when a rule needs a figure fresher than a quarter, or a series rather than a point. C1/C2's "the market rate" threshold (WP 3.10's) is the likely first case, and 07's R3 Roth-conversion window may be another. At that point, add `macro_observations`, owned by `@ctx/integrations` and fed by the FRED adapter WP 3.4 already built. The assumptions file keeps its dated constant as the _planning_ default, because a projection must stay reproducible against a version, not against a live row.

**What was fetched, and how.** On 2026-09-26: `curl https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10|CPIAUCSL|DGS3MO`. This is FRED's public CSV endpoint, not the API, and needed no key. `DGS10 2026-09-24 5.18`, `DGS3MO 2026-09-24 4.24`, `CPIAUCSL 2026-08-01 334.131`, `2025-08-01 323.291`. No credential was used and nothing in the app fetches.

---

## 7. Sabotage log — each control observed red, then restored byte-identical

Every sabotage was an exact single-occurrence replacement (`/tmp/wp42-sabotage.mjs`, which refuses to act
unless the pattern occurs exactly once), followed by the test run and a restore from a pre-sabotage copy.
After all of them:

```
$ sha256sum <the four files> | diff - <the four backups>   →   all four byte-identical to pre-sabotage
```

| #   | Control                         | Mutation                                                                                                                                                            | Test run                                             | Red?                               | Failure, quoted                                                                                                                                 |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | every number cited              | delete `source:` from `marketReference.fdicInsuranceLimit` in `data/assumptions.ts`                                                                                 | `planning test/assumptions.test.ts` + `tsc`          | **red, first try, three layers**   | walk: `+ "$.marketReference.fdicInsuranceLimit: no source"`; zod: `ZodError` at load (all 8 tests); tsc: `TS2741: Property 'source' is missing` |
| S1b | a new number must be cited      | add `experimentalRate: '0.05'` inside `marketReference`                                                                                                             | `-t "every number"` + `tsc`                          | **red, first try**                 | walk: `+ "$.marketReference.experimentalRate: an uncited number \"0.05\""`; tsc: `TS2353: Object literal may only specify known properties`     |
| S2a | hash moves with every value     | `versionOf` hashes `{ label: file.label }` only                                                                                                                     | `-t "content hash changes"`                          | **red** on the first valid attempt | `changing $.capitalMarket.usEquity.expectedReturn must change the version: expected 'sha256:b9abb3a8…' not to be 'sha256:b9abb3a8…'`            |
| S2b | a comment never moves the hash  | the data module reads its own line 2 (the header comment) into `label` via `readFileSync(new URL(import.meta.url))`                                                 | `-t "content hash changes"`                          | **red, first try**                 | `expected 'sha256:5628ebb6…' to be 'sha256:69faa043…'`. The rewritten-comment copy hashed differently.                                          |
| S3  | delta, never a copy             | remove `if (compareDecimal(raw, default) === 0) continue;` from `diffOverrides`                                                                                     | unit `-t "delta and never a copy"` and `planning-db` | **red, first try, both suites**    | unit: `expected { …(4) } to deeply equal { …(1) }`; db: `expected { …(2) } to deeply equal { …(1) }`                                            |
| S3b | the column cannot hold a copy   | `plan_assumption_deltas_are_well_formed` → `SELECT true OR NOT EXISTS (…)` in 0021 (scratch DB migrated fresh)                                                      | `planning-db`                                        | **red, first try**                 | `Error: expected the insert to be refused`                                                                                                      |
| S4  | 2027 fails loudly               | `taxYear` falls back to the latest year when the key is missing                                                                                                     | `-t "2027"`                                          | **red, first try**                 | `expected undefined to be an instance of AssumptionsYearUnavailable`                                                                            |
| S5  | unknown version refuses         | `registry.get(version) ?? loadAssumptions()` in `resolveOverrides`                                                                                                  | `planning-db`                                        | **red, first try**                 | `expected undefined to be an instance of UnknownAssumptionsVersion`                                                                             |
| S6  | an override is the holder's own | `loadOverrides`' `WHERE user_id = $1` → `WHERE $1::uuid IS NOT NULL` (the read's only scoping predicate, so §5 item 8's "each, then together" is one sabotage here) | `planning-db`                                        | **red, first try**                 | `expected { …(4) } to be null`. Another holder read the row.                                                                                    |

**One invalid attempt, recorded rather than hidden:** the first S2a attempt used `grep`/`sed` with a
pattern Prettier had reflowed. It matched nothing, changed nothing, and the test was not run against it.
The retry used the exact-match helper.

---

## 8. Tests and checks

| Test                                                                                                     | Project                | Result                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------ |
| `'every number in the assumptions file carries a non-empty source and an as_of date'`                    | planning               | ✓                                          |
| `'the content hash changes when any value changes and not when a comment does'`                          | planning               | ✓                                          |
| `'an override stores a delta and never a copy of the default'`                                           | planning               | ✓ (includes a 200-run fast-check property) |
| `'a 2027 lookup fails loudly rather than silently reusing 2026'`                                         | planning               | ✓                                          |
| `'a stored override resolves against its named file version, and an unknown version refuses'`            | planning-db            | ✓                                          |
| supporting: two-process hash, deep freeze, correlation positive-definite, override refusals, DB refusals | planning / planning-db | ✓                                          |

```
$ pnpm exec tsc -b --noEmit            # nothing in my files; 6 errors elsewhere, all in WP 4.12's in-flight
                                       # facts.ts change (plaid map.test.ts, port conformance.ts,
                                       # connections staging.ts, investments holdings.ts)
$ pnpm exec eslint packages/contexts/planning packages/db     # clean
$ node scripts/check-numeric-boundaries.ts | tail -3
check-numeric-boundaries: self-test PASS (8 bad declarations caught, the good fixture clean)
check-numeric-boundaries: PASS — 704 file(s) scanned, 0 violations, 70 exempt identifier(s)
$ pnpm run lint:schema-ownership
schema-ownership: ok — 100 table(s) claimed across 14 package(s), 84 defined.
$ DATABASE_URL=… pnpm exec vitest run --project planning --project planning-db --project db
Test Files  1 failed | 15 passed (16)      Tests  1 failed | 85 passed (86)
```

The one red is `test/ports.test.ts > 'namespaces its event to this context and registers it'`. It pins
`PLANNING_EVENTS` to `['planning.NetWorthSnapshotTaken']`, and WP 4.1's `GoalCreated` /
`RiskProfileAnswered` are already in the working tree's `events.ts`. It is not WP 4.2's, but the fix
must include `planning.AssumptionsOverridden` too (§9 item 4). The `db` project is **green**:
`packages/db/test/migrate.test.ts` in the working tree already lists `plan_assumptions` and carries a
0021 attribution block.

---

## 9. For the orchestrator

1. **`packages/db/test/migrate.test.ts`**: the table name is **`plan_assumptions`**. It is already present in the working tree's alphabetical list, with a `0021_plan_assumptions` attribution block. Confirm it at commit; nothing further is needed.
2. **`packages/contexts/planning/schema/index.ts`**: append:
   ```ts
   export * from './assumptions.ts';
   ```
3. **`packages/contexts/planning/src/index.ts`**: add this block after the `events` block:
   ```ts
   // --- assumptions: one file, versioned, cited (WP 4.2) ----------------------
   export {
     AssumptionOverrideRefused,
     AssumptionsOverridden,
     AssumptionsYearUnavailable,
     CITED_KINDS,
     FILING_STATUSES,
     OVERRIDABLE_PATHS,
     UnknownAssumptionsVersion,
     applyOverrides,
     assumptionsOverriddenPayloadSchema,
     assumptionsVersion,
     canonicalDecimal,
     compareDecimal,
     currentRegistry,
     diffOverrides,
     isAssumptionsRefusal,
     loadAssumptions,
     loadOverrides,
     parseAssumptions,
     resolveForUser,
     resolveOverrides,
     saveOverrides,
     taxYear,
     type AppliedOverride,
     type AssumptionDeltas,
     type Assumptions,
     type AssumptionsFile,
     type AssumptionsOverriddenPayload,
     type AssumptionsRegistry,
     type AssumptionsVersion,
     type CitedRate,
     type FilingStatus,
     type OverridablePath,
     type ResolvedAssumptions,
     type StoredOverrides,
     type UsTaxYear,
   } from './assumptions.ts';
   ```
   Every runtime name above was confirmed to resolve (`node … import * as m …; missing: []`).
4. **`packages/contexts/planning/src/events.ts`**: the event is fully defined (`defineEvent`) in `src/assumptions.ts`. `saveOverrides` must append it **in the same transaction as the row**, so the definition could not wait for this file. Re-export it, rather than defining it a second time, and register it:
   ```ts
   export { AssumptionsOverridden } from './assumptions.ts';
   // …and in the list:
   export const PLANNING_EVENTS: readonly EventDefinition[] = Object.freeze([
     NetWorthSnapshotTaken,
     /* WP 4.1's two */
     AssumptionsOverridden,
   ]);
   ```
   (`events.ts` will need `import { AssumptionsOverridden } from './assumptions.ts';` for the list.) There is no cycle: `assumptions.ts` imports `store.ts`, never `events.ts`. The event type string is `planning.AssumptionsOverridden`, which matches `domain_events.event_type`'s CHECK. **`test/ports.test.ts:151`'s pinned list must gain `'planning.AssumptionsOverridden'`** in the same edit that fixes it for WP 4.1.
5. **Composition root (wiring batch)**: call `loadAssumptions()` once at API and worker boot, so a malformed file refuses to start the process. It is lazy by design, so a bad file fails the test that names the rule rather than every importer.
6. **WP 4.12 export bundle**: `plan_assumptions` is user-authored data (08 §7.3). Its `assumptions_version` must round-trip verbatim, never recomputed on import.
7. **WP 4.8 route mapping**: `UnknownAssumptionsVersion` → 409 `domain` `planning.assumptions_version_unknown`; `AssumptionsYearUnavailable` → 422 `domain`; `AssumptionOverrideRefused` → 422 `user` with its own `code`. Use `isAssumptionsRefusal`, not `instanceof`. `GET /assumptions` should serve `resolveForUser(...).file`: every node carries `source`, `asOf` and, where present, `note` and `attribution`.
8. **`docs/research/07-advisory-domain.md` Appendix A**: correct the LTCG row per §3 item 1. I have not edited it.
9. **OWNERSHIP.md hazard**: my line is a `## ` heading, as briefed. `check-schema-ownership.ts` reads bullets only under `## Tables`, so **a table bullet appended after my heading is silently not a claim**. WP 4.1 added `cash_earmarks` inside `## Tables` and is unaffected. Later WPs must add their claims there too.

---

## 10. Open items

- **SSA bend points ($1,286 / $7,749) were not re-verified against ssa.gov.** Every direct ssa.gov fetch returned 403 from this sandbox. COLA and the wage base were confirmed from ssa.gov search results; the bend points come from Appendix A. WP 4.4's `'the published 2026 bend points reproduce a known AIME to PIA case to the dollar'` will be the check, and the gate should open `oact/cola/bendpoints.html` in a browser.
- **The $150,000 mandatory Roth catch-up threshold** is Appendix A's. The fetched IR-2025-111 summary did not print it.
- **REIT has a correlation row but no μ/σ** in 07 §5.5. The file says so in the correlation node's `note`. WP 4.4 and 4.5 must refuse, or map explicitly, a REIT allocation; Chris or the memo supplies the numbers.
- **FRA is encoded for the 1960+ cohort only**, and RMD start ages for 1951+ only. An earlier birth year has no row. Per the rule, the lookup must refuse rather than guess; WP 4.4 owns that lookup.
- **Only one file version is resolvable** (`currentRegistry()`). When the file next changes, stored deltas against the old hash refuse with `UnknownAssumptionsVersion`, and WP 4.6 shows runs against it as stale, which is the intent. A _rebase_ path is WP 4.8's to specify: re-diff the old delta against the new file, show the user what moved, and save under the new version. That path is not built here. Retaining old versions as frozen `data/assumptions-<hash>.ts` snapshots is the other option, and Chris's call.
- **The raw `ASSUMPTIONS_FILE` export is not itself frozen.** Only the loaded copy is. Nothing outside `src/assumptions.ts` and this WP's test imports `data/`, and `src/index.ts` does not export it.
- **Macro constants go stale by design.** They need a quarterly refresh, which will move the version. No reminder mechanism exists; noted for WP 4.14's exit-criteria audit.

---

## 11. Final full re-run

Run after the evidence above was written, at HEAD `e1a4e7d` with WP 4.1 and WP 4.12 still in flight in
the same tree:

```
$ DATABASE_URL=… pnpm exec vitest run --project planning --project planning-db --project db
 Test Files  17 passed (17)
      Tests  89 passed (89)
$ … --reporter=verbose test/assumptions.test.ts test/db/assumptions.test.ts
 10 passed (10) — the five named exit tests plus the five supporting ones, all ✓
$ pnpm exec eslint packages/contexts/planning packages/db        # clean
$ node scripts/check-numeric-boundaries.ts | tail -2
check-numeric-boundaries: PASS — 706 file(s) scanned, 0 violations, 70 exempt identifier(s)
$ pnpm run lint:schema-ownership
schema-ownership: ok — 100 table(s) claimed across 14 package(s), 84 defined.
$ pnpm exec tsc -b --noEmit
3 errors, in packages/connectors/plaid/test/map.test.ts and packages/contexts/connections/src/staging.ts
(WP 4.12's in-flight facts.ts change); none in any WP 4.2 file
$ git diff --cached --name-only | wc -l
0
```

`ports.test.ts` (red in §8) is now green: WP 4.1 updated the pinned `PLANNING_EVENTS` list for its own
two events. §9 item 4 still applies. When `AssumptionsOverridden` is registered, that list gains a
third entry.
