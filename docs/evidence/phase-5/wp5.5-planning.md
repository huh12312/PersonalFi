# WP 5.5 — Planning: the retirement-date solver and the engine's Phase 4 carries

Written incrementally (the phase's rule: a session-limit kill loses everything unwritten). Sections
marked _(in progress)_ are not final.

## 0. Baseline, before any edit (2026-09-30 00:16, load 0.86 1.82 2.17)

- Tree: `aa76871` (main), no staged entries (`git status --short` empty).
- `assumptionsVersion()` of the checked-in file:
  `sha256:d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f` — the same hash
  WP 4.2's evidence §4 recorded, so no stored override in any database was saved against anything
  else. This is the version the frozen predecessor must reproduce byte-for-byte.
- `ENGINE_VERSION = 'personalfi.deterministic/1'`.
- `vitest run --project planning test/reference.test.ts test/golden-drift.test.ts` — 10/10 green:
  - `'every committed reference case matches within 1%'`: **worst relative difference 7.825e-6**
    (`PROBE worst 0.000007825032278258148`); the control's dirty run 139.8 (red as designed).
  - golden drift: **lognormal 56.43333 %**, **bootstrap 57.43333 %** (drift 0 against the pins);
    the control's dirty run 100 % (drift 43.57 pp).
- `test/golden-vector.test.ts` (WP 4.11's client/server parity pair): green.

## 1. Sabotage log (recorded as each one is run)

Times are the host clock, approximate to a minute (read back from `uptime` at 00:50 — the first
draft of this table carried guessed times, corrected here). Each sabotage is an edit to production code, the named test run, the red observed, and the file
restored from a copy taken before the edit, confirmed by `sha256sum -c` (for a file new in this WP,
which `git diff` cannot show) or by `git diff` (for a tracked file).

| #   | When   | Sabotage (production code)                                                                                                                                                                    | Test                                                                                                                    | Observed                                                                                                                                                                                                                                                                    | Restored                                                                                    |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1  | ~00:35 | `retirement-date.ts#earliestAgeFor`: the re-verification removed — the bisection's answer returned as soon as it is found (`if (answer <= last) return { kind: 'earliest', age: answer, … }`) | `'the earliest retirement age is the first whole year the plan sustains, and the year before it does not'`              | **red, first try** — `retiring at 56 sustains: expected false to be true`: the retargeted search answered 56, the plan rebuilt at 56 does not sustain (the true answer is 58). Also red: `'an action too small…'` (the one-off's age, 56, fails the same independent check) | `sha256sum -c` OK; no `SABOTAGE` marker left                                                |
| S2  | ~00:41 | `deterministic.ts#preparePlan`: the one-off applied twice (`oneOffByYear[t] += flow.real + flow.real`)                                                                                        | `'a dated one-off outflow reduces wealth by exactly its amount grown from its year'`                                    | **red, first try** — `year 4: expected 0.9999999999999989 to be less than 1e-9` (the gap was exactly twice the closed form: relative error 1.0)                                                                                                                             | `sha256sum -c` OK against the pre-edit copy; `git diff` shows only this WP's intended edits |
| S3  | ~00:45 | `jobs.ts#projectionRefreshJobHandler`: the transaction split reverted — `computeProjection` moved back inside the read transaction                                                            | `'the refresh job holds no transaction while the engine runs'` (`test/db/refresh-tx.test.ts`)                           | **red, first try** — `expected [ 1 ] to deeply equal [ +0 ]`: the deterministic engine ran with one of the job's transactions open                                                                                                                                          | `sha256sum -c` OK                                                                           |
| S3b | ~00:46 | S3 again, with the test's two deterministic-half assertions commented out for this run only (restored byte-identical after) so the Monte Carlo half's witnesses are observed                  | same test                                                                                                               | **red** — `expected [ { spy: 1, postgres: 1 } ] to deeply equal [ { spy: +0, postgres: +0 } ]`: **Postgres itself** (`pg_stat_activity`, another connection) saw one backend with an open transaction while the runner awaited — the witness is not vacuous                 | `sha256sum -c` OK on `jobs.ts` and the test file                                            |
| S4  | ~00:46 | `data/assumptions-retained.ts`: the frozen predecessor deleted (`RETAINED_ASSUMPTIONS_FILES = []`)                                                                                            | `'an override stored against the previous file version still resolves and its runs read stale with that version named'` | **red, first try** — `expected [] to deeply equal [ Array(1) ]` (the retained list)                                                                                                                                                                                         | `sha256sum -c` OK                                                                           |
| S4b | ~00:47 | S4 again, with the test's four retained-list assertions commented out for this run only, to observe the consequence the rule names                                                            | same test                                                                                                               | **red** — `UnknownAssumptionsVersion: assumptions version sha256:d294715e…42ed67f is not a version this build holds (known: sha256:4997f2ff…42be)` at the `resolveOverrides` line: **the old override fails to resolve**                                                    | `sha256sum -c` OK on both files                                                             |
| S5  | ~00:48 | `projection-service.ts#outflowsApplied`: every stored outflow left unapplied (`if (true) {` in place of the `outflow_not_modelled` test)                                                      | `'a stored negative life event is applied and no longer listed as unapplied'`                                           | **red, first try** — `expected [] to deeply equal [ { …(2) } ]` (nothing applied)                                                                                                                                                                                           | `sha256sum -c` OK                                                                           |
| S6  | ~00:48 | `projection-service.ts#derivedFromDay`: the bucket split removed — a crypto account summed into its tax bucket again                                                                          | `'a crypto holding reaches the Monte Carlo as its own sleeve'`                                                          | **red, first try** — `expected undefined to deeply equal { minor: 2000000n, currency: 'USD' }` (no sleeve reached the runner)                                                                                                                                               | `sha256sum -c` OK                                                                           |
| S7  | ~00:48 | `projection-service.ts#computeProjection`: the split kept, the port field dropped (the runner is never handed `cryptoHolding`)                                                                | same                                                                                                                    | **red, first try** — same message: the holding was split out of `TAXABLE` and then lost — the plan the runner saw had crypto at zero                                                                                                                                        | `sha256sum -c` OK                                                                           |
| S8  | ~00:49 | `assumptions.ts`: `withdrawalPolicy.guardrailReferenceRate` removed from `OVERRIDABLE_PATHS`                                                                                                  | `'the guardrail reference rate is a cited, overridable assumption'`                                                     | **red, first try** — `expected [ …(17) ] to include 'withdrawalPolicy.guardrailReferenceRa…'`                                                                                                                                                                               | `sha256sum -c` OK                                                                           |
| S9  | ~00:49 | `boundary.ts#monteCarloMarketFrom` (the `CITED` accessor's replacement): the equity volatility read from `intlDevelopedEquity` (0.19) instead of `usEquity` (0.17)                            | golden drift (`test/golden-drift.test.ts`)                                                                              | **red, first try** — `current 52.43333333333333% vs golden 56.43333333333334%` (drift 4.0 pp > 0.5): the moved accessor is covered by the drift gate, not only by types                                                                                                     | `sha256sum -c` OK                                                                           |
| S10 | ~00:49 | `projection-service.ts#retiredStaleness`: a retained predecessor treated as computable (`if (registry.has(v))`)                                                                               | `'an override stored against the previous file version…'`                                                               | **red, first try** — `expected null to deeply equal { …(3) }`: a run on the predecessor would have read back fresh                                                                                                                                                          | `sha256sum -c` OK                                                                           |

Every sabotage in this table was red on its first attempt. S3b and S4b are second runs of S3 and S4
with a test assertion temporarily disabled, to observe the _named_ consequence past the first
assertion; the test files were restored byte-identical (`sha256sum -c`) before anything else ran.

## 2. The solver — `src/engine/retirement-date.ts`

**Shape.** `earliestRetirementAge(prepared, action, options?)` is the named interior entry point:
it returns the baseline's earliest age, the age with the action, `yearsEarlier` (whole years), and
the two engine figures months-of-spending is derived from. `solveRetirementImpact(plan,
assumptions, action)` is the Money-facing wrapper — the one WP 5.6's `RetirementImpactPort`
should bind (an adapter must not cross the numeric boundary itself): actions arrive as `Money`
(`{ kind: 'extra_annual', annual }` or `{ kind: 'one_off', lump }`), the answer leaves with
`engineVersion` and `assumptionsVersion` (05 §5's risk row), ages as whole years, and months of
spending as `⌊12 × Δwealth ÷ first-year spending⌋` computed in **exact bigint minor units** from
the two `Money` figures it prints beside the number (`boundary.ts#wholeMonthsFunded`), with the
derivation string declared on the result (`MONTHS_OF_SPENDING_DERIVATION`, which says in words
that it is "not a change to the retirement date").

**The search.** Bisection over whole ages `[today's age, min(80, planEndAge − 1)]` on the plan
**retargeted** (only `retireAge` moves; the action's one-off appended), with `solve.ts`'s own
`checkObjective(…, { kind: 'sustain' })` as the predicate. The monotonicity argument is written in
the file's header, extending `solve.ts`'s: a year retired later is a working year instead of a
retired one, every later year starts from at least as much, the glidepath holds as much equity or
more at every age (and the file's equity return beats its bond return), and an earnings-record
benefit can only rise; the one non-monotone lever is `solve.ts`'s own, a guardrail raise.

**The re-verification.** The retargeted plan is not the whole plan: the boundary derives an
earnings-record Social Security benefit from the retirement age (`lastFutureYear`), and
retargeting keeps the planned age's benefit. So the answer is re-run through `verifyAt` — the
Money-facing wrapper rebuilds the plan at each age through the **whole `toEnginePlan` boundary** —
and the stated claim is checked: _sustains at the age, and not the year before_. Where the two
disagree it walks a whole year at a time to the age the rebuilt plan supports. The exit test's plan
is chosen so this matters: the retargeted search alone answers **56**; the plan rebuilt at 56 does
not sustain; the verified answer is **58** (S1 above is exactly this).

**Unreachable, with its constraint:** `retirement_started` (the plan's retirement age is not after
today's — no action moves a date in the past) or `latest_age` (still unfunded retiring at the
latest age tried, with the shortfall there in `Money`; the lever is spending).

### 2.1 The walk on the seed plan

The seed plan is WP 4.13's scale seed as `perf.test.ts` builds it (the only seeded retirement plan
in the tree — `@core/seed` writes no baseline): the scale seed's last `net_worth_daily` day summed
by tax bucket — TAXABLE $761,471.19, TAX_DEFERRED $681,161.94, ROTH $419,498.90, HSA $98,401.88
(the crypto wallet's $89,711.92 held out, WP 5.5's bucket split) — born 1971-01-01, projected from
2026-01-01 (age 55), retiring at 62, to 95; four glidepaths, wage-grown contributions, Guyton-Klinger
with an $80,000 floor, Social Security $2,900 PIA at 67 with the 2034 stress, a CPI pension, part-time
income 62–66. Assumptions `sha256:4997f2ff…42be`.

**As the seed has it ($118,000 spending):** it sustains retiring _today_. One probe, one check:
`probe [55, 80] 55 → sustains`; `check 55 → sustains`; answer **55**. The five actions below then
all read "0 years earlier" and 0–2 months of spending — correct, and uninformative.

**The same seed with spending raised to $180,000**, so the planned age (62) does _not_ sustain —
every bisection step, engine dollars of total shortfall to 95:

| step    | bracket [lo, hi] | age tried | sustains | shortfall (today's $) |
| ------- | ---------------- | --------- | -------- | --------------------- |
| probe 1 | [55, 80]         | 55        | no       | 2,489,653.24          |
| probe 2 | [55, 80]         | 80        | yes      | 0                     |
| probe 3 | [55, 80]         | 67        | yes      | 0                     |
| probe 4 | [55, 67]         | 61        | no       | 685,258.32            |
| probe 5 | [61, 67]         | 64        | yes      | 0                     |
| probe 6 | [61, 64]         | 62        | no       | 69,679.24             |
| probe 7 | [62, 64]         | 63        | yes      | 0                     |
| check   | rebuilt at 63    | 63        | yes      | 0                     |
| check   | rebuilt at 62    | 62        | no       | 69,679.24             |

Answer **63**: seven probes (the two ends, then ⌈log₂ 25⌉ = 5 halvings) and two boundary checks —
nine engine runs. The plan as stated (retire at 62) is one year short.

### 2.2 Five catalogue actions (the $180,000 variant; planned retirement 62; first-year spending $180,000)

The dollar figures are illustrative sizes of what each rule reports, chosen before running and not
tuned; each is expressed the way the Brief would hand it to the port.

| rule | action, as the Brief states it                                      | as the port takes it   | earliest age (base → with) | whole years | Δ real wealth at 62 | months of spending |
| ---- | ------------------------------------------------------------------- | ---------------------- | -------------------------- | ----------- | ------------------- | ------------------ |
| U3   | a duplicate streaming service cancelled, $15.99/mo                  | `extra_annual` $191.88 | 63 → 63                    | 0           | $1,489.25           | 0                  |
| S7   | the fee hunter's $35/mo of account fees stopped                     | `extra_annual` $420    | 63 → 63                    | 0           | $3,259.76           | 0                  |
| C1   | $30,000 of idle cash moved from 0.38 % to a 4.2 % HYSA (+$1,146/yr) | `extra_annual` $1,146  | 63 → 63                    | 0           | $8,894.50           | 0                  |
| I2   | $400,000 moved from a 0.75 % to a 0.05 % expense ratio ($2,800/yr)  | `extra_annual` $2,800  | 63 → 63                    | 0           | $21,731.76          | 1                  |
| C4   | $20,000 of emergency fund above six months invested, once           | `one_off` $20,000      | 63 → 63                    | 0           | $24,177.55          | 1                  |

None moves a whole year; the months column is what each is worth, and it is small against a
$180,000 year — which is the honest answer for a household spending that much. (The exit test's
$60,000-spending plan shows the other side: a $150,000 one-off moves 60 → 57, three whole years,
67 months.) Each row is nine engine runs per side, eighteen per action, plus two for the months.

## 3. The carries

### 3.1 Dated one-off outflows (wp4.5 §10 item 10's design; wp4.6 §11 item 1)

- `ProjectionPlan.oneOffs?: { name, occursOn: DateOnly, amount: Money }[]` (signed, today's
  dollars). `toEnginePlan` converts both halves at the one crossing — `ageOn` for the date,
  `toEngineAmount` for the amount — into `EnginePlan.oneOffs: { age, real }[]`, refusing a flow
  before `asOf` or outside the plan's years (`planning.projection_ages_invalid`, never clamped).
  `preparePlan` builds the signed `oneOffByYear: Float64Array` once; `stepYear` reads one element a
  year.
- **Working year:** an inflow joins TAXABLE's contribution (mid-year, exactly like income); an
  outflow is drawn at mid-year through the withdrawal order from what each bucket holds then
  (`start·√(1+r) + contribution`, so no bucket can end the year negative), a TAX_DEFERRED draw
  grossed up by the blended rate. **Retired year:** the flow is added to the year's need _outside_
  `spending`, so the guardrails never see a house as spending. **Decided (4.5 left it open):** an
  outflow the buckets cannot fund is a shortfall and dates depletion — a plan that cannot pay for
  the house it has planned does not sustain.
- Allocation: `stepYear` still allocates nothing when not recording — the working-year
  contribution is a plain function (`workingContribution`), not a closure, and no field was added to
  `PathState` (so `montecarlo.ts`'s `resetPathState` and its field-by-field test are untouched).
- **The arithmetic** (the exit test's plan: $500,000 TAXABLE, static 60/40, r =
  0.6·(1.065/1.025 − 1) + 0.4·(1.045/1.025 − 1) = **0.03121951**): a $40,000 home purchase at age 39
  (working) and a $25,000 college bill at 70 (retired).

  | year-end age | engine gap (plan without − with) | closed form                              | rel. error |
  | ------------ | -------------------------------- | ---------------------------------------- | ---------- |
  | 38           | 0.000000                         | 0 (before either)                        | —          |
  | 39           | 40,619.591572                    | 40,000·√1.0312195                        | 9.0e-16    |
  | 40           | 41,887.715407                    | 40,000·√(1+r)·(1+r)                      | 3.1e-15    |
  | 64           | 87,601.915024                    | 40,000·√(1+r)·(1+r)^25                   | 1.1e-14    |
  | 69           | 102,157.253820                   | 40,000·√(1+r)·(1+r)^30                   | 1.0e-14    |
  | 70           | 131,127.041256                   | 40,000·√(1+r)·(1+r)^31 + 25,000·(1+r)    | 8.4e-15    |
  | 94           | 274,232.667355                   | 40,000·√(1+r)·(1+r)^55 + 25,000·(1+r)^25 | 7.9e-15    |

  The test asserts every year to 1e-9 relative (and exactly 0 before the first flow); S2 above.

- **The service:** `lifeEventsForPlan` (WP 4.6's file, not this WP's) still partitions; the
  service turns every `outflow_not_modelled` entry into a one-off and moves it to `applied` with its
  age. That reason is reached only after the currency, start and end checks, so every such event is
  exactly what `toEnginePlan` accepts. Inflows stay one-year income streams, so no stored plan
  without an outflow changes. The run's document lists the event under `lifeEvents.applied` and its
  `plan.oneOffs`; the DB test's printed document:
  `{"applied":[{"id":"…bbf57","age":"43"}],"unapplied":[{"id":"…17ee","reason":"before_as_of"}]}`
  and `oneOffs: [{"name":"life_event:…bbf57","amount":{"minor":"-6000000","currency":"USD"},"occursOn":"2029-04-01"}]`.
  Every band before 2029 is identical; from 2029 on each is lower; the 2029 year-end gap is between
  $60,000 and $63,000 (drawn at mid-year).

### 3.2 The crypto sleeve (wp4.6 §11 item 4, wp4.13 §9 item 5, wp4.w-wave-c §5 item 3)

- **Port:** `CashflowAccount.sleeve?: 'crypto' | null` — the composition root marks Ledger's
  `crypto` account type (which `planningKindOf` maps to `investment`, hence TAXABLE); absent means
  "not crypto", exactly the behaviour before this WP. `MonteCarloRequest.cryptoHolding?: Money`.
- **Bucket split** in `derivedFromDay`: a marked account's sealed-day balance goes to
  `DerivedInputs.cryptoHolding`, not its bucket. `assembleInput` carries it and records it in the
  document as `crypto: { holding, monteCarlo: 'own_sleeve', deterministic: 'valued_at_zero' }`
  (absent entirely when there is none, so a crypto-free plan digests as before).
- **Decided: the deterministic run values crypto at zero.** It has no sleeve, and folding crypto
  back into TAXABLE would give it TAXABLE's glidepath — an equity/bond blend — which is exactly the
  "folded into equity" 07 §6.4 forbids; crypto funds last in the Monte Carlo, so the zero-crypto
  deterministic path is 07 §6.4 treatment 2's conservative projection. The document says so.
- The DB test drives real `net_worth_daily` rows (brokerage $100,000, exchange $20,000) through the
  real reader; the runner is asked with `cryptoHolding` $20,000 and TAXABLE $100,000, and WP 4.5's
  own `toMonteCarloJob` turns it into `crypto.holding = 20000` with `withoutCrypto` produced — its
  own sleeve. Printed: `{"cryptoHolding":"2000000","taxable":"10000000","jobCrypto":{"holding":20000,"expectedNominal":0.065,"volatility":0.7,"degreesOfFreedom":3},…}`.
- **Needs the orchestrator:** the `domain.ts` adapter must pass the field through, and the reader
  must mark crypto accounts (§8.3, §8.4).

### 3.3 The refresh job: read → compute outside any transaction → write (wp4.6 §11 item 6)

`projection-service.ts` now exports the three phases — `prepareProjection` (every read and the
cache lookup), `computeProjection` (takes **no executor**), `storeProjection` (run, bands and
`ProjectionCompleted` as one fact) — and `runProjection` composes them over one executor for the
routes, unchanged in behaviour. `jobs.ts`'s refresh runs `prepareBaselineRefresh` in one
transaction, the engine in none, and `storeProjection` in a second. A concurrent identical run
between the two transactions is served by `insertRun`'s `ON CONFLICT` and announces nothing.
`test/db/refresh-tx.test.ts` witnesses it twice, from inside the engine: the job's own open
transactions (a spy on the real Drizzle handle) and **Postgres's** `pg_stat_activity`
(`xact_start IS NOT NULL`, another connection). Both read 0; both read 1 under S3/S3b. Printed
green run: `{"deterministicSaw":[0],"runnerSaw":[{"spy":0,"postgres":0}],"opened":4}`, and each run
landed with 55 bands and exactly one `ProjectionCompleted`.

### 3.4 `GUARDRAIL_REFERENCE_RATE` into the assumptions file, the predecessor retained frozen

- New cited node `withdrawalPolicy.guardrailReferenceRate` = `'0.045'`, source 07 §5.6
  (`initial_wr = 0.045 # user-settable`), as_of 2026-09-10 (the memo), with a note that it is a
  reference for R7's band, not a projection input. Added to `OVERRIDABLE_PATHS` (bounds 0..1).
  Accessor: `guardrailReferenceRate(assumptions, registry?)` → the cited node (with the holder's
  override applied when there is one). Exported from `@ctx/planning`.
- The file's version moved: **`sha256:d294715e…42ed67f` → `sha256:4997f2ff8bd4381f8e5a3e675ac3ea173d0e9d8a85d66b4319ee7472ea3b42be`**.
- **The predecessor, frozen:** `data/assumptions-retained.ts` holds the exact validated content of
  `aa76871`'s `data/assumptions.ts` + `data/us-2026.ts`, **generated from the loaded object** (not
  retyped) and self-contained (it imports nothing, so an edit to `us-2026.ts` cannot move it).
  `retainedAssumptions()` re-hashes it at load and **refuses to start** if it no longer reproduces
  `sha256:d294715e…` — a predecessor that drifted would resolve overrides against content they were
  never computed on. The schema's `withdrawalPolicy` is optional only so the predecessor validates;
  the current file cannot omit it (`parseAssumptions` refuses a file missing any overridable path —
  asserted in the test).
- **Semantics:** `currentRegistry()` now holds the current file and the retained one (marked
  `retained`). A stored override against the predecessor **resolves** (the assumptions screen shows
  the holder's own numbers; a re-save through the existing PUT re-diffs against the current file —
  an explicit act, never a silent rebase). **No run is computed on a retained version:**
  `prepareProjection` serves the scenario's latest run `stale`, and `readProjection` labels any run
  stored against it `assumptions_version_retired` naming the version — the existing reason, so the
  route's response schema (`apps/api/src/routes/plan.ts`) needs no change. `known` everywhere now
  means "the versions a run may be computed on" (`computableVersions`), which is why WP 4.6's
  `stale-assumptions` test still reads `known: [current]` unchanged.
- The predecessor predates the node; its runs used the composition root's literal, which the frozen
  module records **beside** the file (`supplements`), so the accessor answers `0.045` for a
  predecessor-resolved set with that provenance, and the hash is untouched.

### 3.5 `monteCarloMarketFrom(assumptions)` into `boundary.ts`; the `CITED` accessor deleted

`boundary.ts#monteCarloMarketFrom` reads volatilities, the correlation matrix, crypto's μ/σ/ν and
the crypto disclaimer through `toEngineRate`; `worker-host.ts`'s `const CITED = 'value'`,
`Cited<T>`, `citedOf` and `rateOf` are gone (`grep -n CITED src/engine/worker-host.ts` → nothing).
The crypto holding crosses through a named `toEngineCryptoHolding` instead of borrowing
`toEngineTarget`. Byte-identical: golden drift unchanged, and S9 shows the drift gate watches it.

### 3.6 REIT — decided and pinned

The engines take tax buckets with glidepaths, never asset classes, so a REIT holding is **neither
refused nor given its own μ/σ**: the net-worth snapshot sums it into its account's bucket and it is
projected at that bucket's equity/bond blend. The REIT correlation row enters only the lognormal
Cholesky (`LOGNORMAL_ORDER` puts REIT seventh; only the leading USEQ/BOND/CRYPTO block is ever
read), i.e. only its positive-definiteness check. The correlation node's note now says this (a
content change, inside the same version move as §3.4). Pinned by `test/assumptions.test.ts` →
`"REIT is never refused and never given its own draw: a holding is projected at its bucket's
blend"`: every REIT correlation moved to 0.10 (still positive definite), a 400-path lognormal run
with crypto held is **byte-identical**.

### 3.7 The stale seed-range comments

Found **already corrected**: WP 4.5's final commit (`626d420`) rewrote both — `worker-host.ts`'s
envelope comment and `prng.ts:123–129` now say "a 64-bit pattern… stored unsigned on
`projection_runs.seed` (`numeric(20, 0)`)… either representation… canonicalised to unsigned". The
wp4.6 §11 item 2 note was written mid-flight against the earlier text. `grep -rn -i "BIGINT
column\|postgres bigint\|asIntN" src/engine` finds nothing stale. No edit made (and `prng.ts` is not
this WP's file).

## 4. Reference cases and golden drift, before and after

| check                                                      | before (`aa76871`, 00:16) | after (this WP, 00:53) |
| ---------------------------------------------------------- | ------------------------- | ---------------------- |
| `'every committed reference case matches within 1%'` worst | 7.825032278258148e-6      | 7.825032278258148e-6   |
| the reference control's dirty run                          | 139.845…                  | 139.845…               |
| golden drift, lognormal (3,000 paths, seed 20260928)       | 56.43333 % (drift 0)      | 56.43333 % (drift 0)   |
| golden drift, bootstrap (synthetic series)                 | 57.43333 % (drift 0)      | 57.43333 % (drift 0)   |
| WP 4.11 golden vector, server half (bytes + SHA-256)       | green                     | green (unchanged)      |

Nothing moved, to the bit — which is the evidence for §5's version decision.

## 5. Versions

- **`assumptionsVersion` bumped** (content changed): `sha256:d294715e…42ed67f` →
  `sha256:4997f2ff8bd4381f8e5a3e675ac3ea173d0e9d8a85d66b4319ee7472ea3b42be`, with the predecessor
  retained frozen (§3.4).
- **`ENGINE_VERSION` not bumped (`personalfi.deterministic/1`), deliberately, with the reason in its
  doc comment.** The rule is "every change that moves an engine output bumps its version". WP 5.5
  added an _input_ (`oneOffs`); for every plan the engine accepted before, the output is
  byte-identical (§4: reference, drift and the golden vector unchanged to the bit), and a plan that
  now carries a one-off (or a crypto sleeve) has a different `input_digest`, so the cache key can
  never serve it a pre-WP 5.5 answer. A bump would also **break WP 4.11's golden-vector pair on a
  string while every float agrees**: `serialiseResult`'s header embeds `engineVersion`, the fixture
  is read by both suites, and the client kernel (`apps/web/src/workers/kernel/deterministic.ts`,
  not this WP's) says `/1`. If the gate rules a bump is required anyway, it is a coordinated
  three-file change for the orchestrator: this constant, the client kernel's, and the fixture
  regenerated — in one commit (§9 item 4).
- **`MONTE_CARLO_VERSION` unchanged**: the kernel is untouched; the crypto sleeve was always there
  and is now fed.

## 6. The client kernel diverges on dated one-offs (05 §2)

The client worker's ported kernel (`apps/web/src/workers/kernel/`, WP 4.11 §2's server-only list)
does **not** gain `oneOffs` — it is not this WP's file, and 05 §2 defers the shared
`@core/projection-kernel` to Phase 9. So **a slider preview of a plan with a stored dated outflow
diverges from the saved run**: the server draws the house purchase in its year; the preview does
not. The golden vector stays green only because its plan has no one-off (and no crypto); it is not
evidence the two kernels agree on such a plan. The preview should say so until Phase 9 (a WP 5.11
or 5.14 item, §9).

## 7. Performance (`planning-perf`, alone, as the rule requires)

| run | time     | load before → after | p50 wall | p95 wall     | p95 thread CPU | result                                         |
| --- | -------- | ------------------- | -------- | ------------ | -------------- | ---------------------------------------------- |
| 1   | 00:52:14 | 5.25 → 4.99         | —        | ≤ 800 (pass) | —              | green (numbers not captured: default reporter) |
| 2   | 00:52:40 | 4.86 → 5.64         | 607.4 ms | **865.5 ms** | 831.3 ms       | red                                            |
| 3   | 00:54:03 | 3.38 → 2.96         | 589.2 ms | 704.1 ms     | 694.3 ms       | green                                          |

Neither may be believed (05 §3 rule 4 and WP 4.5 §5): load 4.9–5.6 from the other two Wave B
agents' suites on a 4-core / 8-thread Ryzen 5 3501U. The p50 (599 ms CPU, 607 ms wall) sits where
WP 4.5's quiet-machine p50 did (570 / 579 ms); the tail is the box. The change to the hot loop is
one `Float64Array` read per year and the working-year contribution moved into a plain function
(no allocation; `stepYear` allocates nothing when not recording, and `PathState` gained no field).
Third run, 00:54:03, load 3.38 → 2.96 (still the other agents' suites):
**green** — p50 589.2 ms wall / 581.8 ms CPU, **p95 704.1 ms wall / 694.3 ms CPU**, p99 708.8 ms;
success 9,568 / 10,000 (the scale seed's crypto now reaches this test through `toMonteCarloJob`
exactly as before — the perf test builds its own request).

## 8. Wiring for the orchestrator (W-B batch, `apps/api/**` — not edited by this WP)

**8.1 The guardrail literal → the assumptions value** (`apps/api/src/domain.ts`). Add
`guardrailReferenceRate` to the `from '@ctx/planning'` import (line ~227); delete the
`GUARDRAIL_REFERENCE_RATE` constant and its doc comment (lines 1557–1564); in `guardrailOf` replace
the two uses:

```ts
const withdrawalRate = ratioText(drawn.minor, first.startWealth.minor, 4);
// 07 §5.6's initial_wr, cited in the assumptions file and overridable by the holder (WP 5.5).
const referenceRate = guardrailReferenceRate(resolved).value;
const reference = toMicros(referenceRate);
const lower = (reference * toMicros(GUYTON_KLINGER.lowerMultiple)) / MICRO;
const upper = (reference * toMicros(GUYTON_KLINGER.upperMultiple)) / MICRO;
const rate = toMicros(withdrawalRate);
return {
  withdrawalRate,
  referenceRate,
  lower: fromMicros(lower),
  upper: fromMicros(upper),
  position: rate > upper ? 'above' : rate < lower ? 'below' : 'within',
};
```

`resolved` is already `guardrailOf`'s parameter (the holder's resolved set), so a holder's override
reaches R7 with no further plumbing; a set resolved against the retained predecessor answers the
pre-WP 5.5 literal `0.045` from the frozen module's `supplements`. One note: an override may carry
up to 12 decimal places and `toMicros` keeps 6 — harmless for a band reference, but say so if the
band is ever shown to more places.

**8.2 The concurrency cap from config** (`MONTE_CARLO_MAX_CONCURRENT`, already parsed as
`config.planning.monteCarloMaxConcurrent`, default 8). In `domain.ts`,
`createMonteCarloRunnerFromCache` gains the option and passes it through; delete the
`MAX_CONCURRENT_MONTE_CARLO_RUNS` literal (line ~3330) and its "Not a config value yet" comment:

```ts
export function createMonteCarloRunnerFromCache(options: {
  readonly cacheDir?: string;
  readonly logger: PlatformLogger;
  /** `MONTE_CARLO_MAX_CONCURRENT` (05 §4 item 9): concurrent Monte Carlo workers per process. */
  readonly maxConcurrent: number;
}): MonteCarloRunner | null {
  try {
    const series = loadReturnSeries(options.cacheDir);
    return createMonteCarloRunner({ series, maxConcurrent: options.maxConcurrent });
```

and in `createMonteCarloRunner`, `createSemaphore(options.maxConcurrent ?? MAX_CONCURRENT_MONTE_CARLO_RUNS)`
becomes `createSemaphore(options.maxConcurrent ?? 8)` — or make `maxConcurrent` required there too
and let the tests pass it. Both call sites add one line: `apps/api/src/worker.ts:476` and
`apps/api/src/app.ts:~499`, inside the `createMonteCarloRunnerFromCache({ … })` object:

```ts
      maxConcurrent: config.planning.monteCarloMaxConcurrent,
```

(`packages/config`'s own comment says only `worker` reads it; `app.ts` also calls
`createMonteCarloRunnerFromCache` for the interactive routes, so it should read it too, or the api
process keeps an unconfigurable 8.)

**8.3 The crypto sleeve, adapter half** (`domain.ts#createMonteCarloRunner`, inside
`runMonteCarloInWorker({ … })`, beside `seed: request.seed,`):

```ts
            cryptoHolding: request.cryptoHolding ?? null,
```

Without it the port field reaches the adapter and stops there: the stored run's input says
`crypto.monteCarlo: 'own_sleeve'` while the worker simulates crypto at zero (S7 is the service-side
version of that bug; the adapter-side one is the orchestrator's line to add).

**8.4 The crypto sleeve, reader half** (`domain.ts#planningCashflowReaderFor`, ~line 3176): mark
Ledger's `crypto` accounts. `listAccounts` rows carry the Ledger `type` beside `subtype`:

```ts
const subtypeOf = new Map(rows.map((row) => [row.id, row.subtype] as const));
const typeOf = new Map(rows.map((row) => [row.id, row.type] as const));
return accounts.map((account) => ({
  ...account,
  taxBucket: defaultTaxBucketFor(account.kind, subtypeOf.get(account.accountId) ?? null),
  sleeve: typeOf.get(account.accountId) === 'crypto' ? ('crypto' as const) : null,
}));
```

(Check the row's field name against `@ctx/ledger`'s `listAccounts` — `AccountSummary.type` is what
`planningKindOf` switches on.) Until this lands, crypto stays in TAXABLE exactly as before.

**8.5 WP 5.6's `RetirementImpactPort`** (W-C) binds `solveRetirementImpact(plan, resolved,
action)` from `@ctx/planning` — the Money-facing entry point — over the plan `assembleInput`
builds for the baseline (so stored one-offs are in it), with the holder's resolved assumptions. It
returns `engineVersion` and `assumptionsVersion` for the Brief to store beside the effect.
`earliestRetirementAge(prepared, action)` is the engine-unit function the dispatch names; an
adapter in `apps/api` should not call it, because it would have to cross the numeric boundary
itself.

## 9. Needs the orchestrator (outside this WP's files)

1. **§8.1–8.4** — the W-B `domain.ts` / `worker.ts` / `app.ts` lines above, then `just verify`.
2. **`packages/contexts/planning/src/life-events.ts` header** (WP 4.6's file) now says outflows are
   "not applied, and named … `outflow_not_modelled`". The service applies them since WP 5.5
   (`projection-service.ts#outflowsApplied`); the header and the `UnappliedReason` doc should say
   that `outflow_not_modelled` is an intermediate reason the service consumes. Comment-only.
3. **The client preview's divergence** (§6): WP 5.11/5.14 should label a plan-screen preview whose
   plan carries a stored outflow ("the preview does not include dated one-offs; the saved projection
   does") until Phase 9's shared kernel.
4. **If the gate requires an `ENGINE_VERSION` bump** (§5): bump this constant, the client kernel's
   (`apps/web/src/workers/kernel/deterministic.ts:33`) and regenerate
   `packages/contexts/planning/test/fixtures/golden-vector.json` in one commit.
5. **Holders with overrides saved before this lands** keep resolving (the predecessor is retained),
   but their projections read stale until they re-save their assumptions once (the PUT re-diffs
   against the current file). DB read needed: `SELECT assumptions_version, count(*) FROM
plan_assumptions GROUP BY 1;` — any row on `sha256:d294715e…` is a holder who should be told
   (Chris, on this install).
6. **`apps/api/src/routes/plan.ts`'s `ProjectionStaleness` description** says "a run whose
   assumptions version this build no longer holds reads back `assumptions_version_retired`"; it now
   also covers a version held only as a retained predecessor. Doc-only; `just openapi` regenerates.
7. **Red on another agent's in-flight file, not this WP's:** `node scripts/check-numeric-boundaries.ts`
   → 1 violation, `packages/contexts/insights/src/policy/rule-health.ts:67` (`WRONG_AMOUNT = 0`), WP
   5.9's.

## 10. Tests

Every exit test, by the name the entry gives, in the file it names (the `planning` project collects
`src/**/*.test.ts` and `test/*.test.ts`; `planning-db` collects `test/db/**/*.test.ts` — checked in
`vitest.config.ts` before placing them). **None was red-first in time** — each was written after its
implementation — so each was proven by a sabotage red on the first attempt (§1):

| file                                 | test                                                                                                                            | proven red by                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/engine/retirement-date.test.ts` | `'the earliest retirement age is the first whole year the plan sustains, and the year before it does not'`                      | S1                                                                               |
| same                                 | `'an action too small to move a whole year reports no change and never an interpolated fraction'`                               | S1                                                                               |
| same                                 | `'months of spending is the engine's own wealth difference over planned spending, declared as a derivation'`                    | (independent recomputation from two plain projections; not separately sabotaged) |
| `src/engine/deterministic.test.ts`   | `'a dated one-off outflow reduces wealth by exactly its amount grown from its year'` (added)                                    | S2                                                                               |
| `test/reference.test.ts`             | `'every committed reference case matches within 1%'` (unchanged, re-run: 7.825e-6 before and after)                             | its own control, green                                                           |
| `test/db/projection-store.test.ts`   | `'a stored negative life event is applied and no longer listed as unapplied'` (added)                                           | S5                                                                               |
| same                                 | `'a crypto holding reaches the Monte Carlo as its own sleeve'` (added)                                                          | S6, S7                                                                           |
| `test/db/refresh-tx.test.ts` (new)   | `'the refresh job holds no transaction while the engine runs'` (30 s timeout declared)                                          | S3, S3b                                                                          |
| `test/assumptions.test.ts`           | `'the guardrail reference rate is a cited, overridable assumption'` (added)                                                     | S8                                                                               |
| same                                 | `'an override stored against the previous file version still resolves and its runs read stale with that version named'` (added) | S4, S4b, S10                                                                     |
| same                                 | `"REIT is never refused and never given its own draw: a holding is projected at its bucket's blend"` (added, the REIT pin)      | —                                                                                |

Golden drift (S9) and the reference control stay the drift/accuracy gates for the moved
`monteCarloMarketFrom`.

## 11. Files

New: `packages/contexts/planning/src/engine/retirement-date.ts`,
`src/engine/retirement-date.test.ts`, `data/assumptions-retained.ts` (the frozen predecessor),
`test/db/refresh-tx.test.ts`, this file.
Changed: `src/engine/{boundary,deterministic,deterministic.test,worker-host}.ts`,
`src/{projection-service,jobs,ports,assumptions,index}.ts`, `data/assumptions.ts`,
`test/assumptions.test.ts`, `test/db/projection-store.test.ts`. `src/engine/solve.ts` was read (its
`checkObjective` is the solver's predicate) and not edited; `src/engine/index.ts` is not this WP's,
so the solver is exported from `src/index.ts` directly. No dependency, lockfile, migration,
`vitest.config.ts`, `apps/**` or other-context edit; no git state change.

## 12. Verification before the report (00:55)

- `pnpm run typecheck`: clean (whole repo).
- `pnpm exec eslint packages/contexts/planning`: 0 problems.
- `prettier --write` over every file above (the evidence included).
- `node scripts/check-numeric-boundaries.ts`: self-test PASS; **1 violation, not this WP's** —
  `packages/contexts/insights/src/policy/rule-health.ts:67`, WP 5.9's in-flight file (§9 item 7).
  None in planning (`boundary.test.ts`'s stricter interior grep is green over the new
  `retirement-date.ts`).
- `vitest run --project planning --project planning-db` (DATABASE_URL = the dev Postgres, own
  scratch databases): **41 files, 192 tests, all green** (00:50, load 3.30).
- `planning-perf` alone: three runs, §7.

## 13. Final report (posted here before the final `just check`, per the phase rule)

Everything above is the report: files (§11), tests by name with how each was proven red (§10), the
reference and golden numbers before and after — unchanged to the bit (§4), the versions (§5:
assumptions `d294715e…` → `4997f2ff…`, predecessor retained frozen; `ENGINE_VERSION` deliberately
not bumped, with the reason), sabotages S1–S10 all red first try (§1), the wiring lines (§8) and
the rest for the orchestrator (§9). The `just check` result follows.

## 14. `just check`

Run by the orchestrator on the landed tree (WP 5.5 `29f79af`, 5.7 `50e14dc`, W-B `0de84c4`, 5.9 `b2a6e40`
and the golden-test finisher `bee9246`), 2026-09-30 ~11:40 EDT, in the background because the suite no
longer fits the 10-minute foreground window: typecheck, lint and every static check green; **331 test
files, 3173 tests passed, 10 skipped, 1 failed** — the one red `advisor-local-model/test/caps.test.ts`
(the sanitiser's cap table lagging contract 1.4.0's `fee_type` and the widened `type`), WP 5.7's
contract change, not this package's; fixed in its own commit and proven green against the committed
schema. Nothing in `planning`, `planning-db` or `planning-perf` red.
