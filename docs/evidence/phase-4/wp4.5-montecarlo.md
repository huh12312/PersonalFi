<!-- SPDX-License-Identifier: MIT -->

# WP 4.5 — Monte Carlo in a `worker_thread`

Package `@ctx/planning`, directory `src/engine/**` plus `data/returns/**`. A stationary block
bootstrap over real monthly returns by default (`p_stay = 1 − 1/12`), a parametric multivariate
lognormal (hand-written Cholesky over WP 4.2's 8 × 8 matrix) for sensitivity, crypto as its own
Student-t(ν = 3) sleeve, 10,000 paths, seeded **xoshiro256++ written in-repo**, common random numbers
across every what-if, failure that keeps simulating on Social Security and pensions, sequence risk by
first-five-retirement-year decile, and a probability-targeted solver that bisects over one shock
matrix. It runs WP 4.4's own `stepYear`, so zero volatility reproduces the deterministic path bit
for bit. Everything runs in a fresh `worker_thread` with declared `resourceLimits`, an empty `env`,
no `execArgv`, a deadline that terminates, and an envelope that refuses before spawning.

Modules: `prng.ts`, `bootstrap.ts`, `montecarlo.ts`, `monte-carlo.worker.ts`, `worker-host.ts`
(+ `index.ts` exports); `data/returns/{derive,xls,series,fetch}.ts`, `SHA256SUMS`, `PROVENANCE.md`.
Tests: five files in `src/engine/` — **21 tests**, every exit-test name verbatim. No third-party
PRNG, statistics or matrix code (dispatch §4 item 10); no dependency added.

Written 2026-09-26 on `main` at `3514892` (WP 4.6 landed) plus this WP's uncommitted work and the
in-flight wiring batch in the same tree. Host: AMD Ryzen 5 3501U (4 cores / 8 threads, laptop),
Node v26.9.0, shared with other agents' runs (load averages are printed with every timing).

**Test location.** The dispatch names `test/engine/*.test.ts`; the `planning` vitest project's
include is `src/**/*.test.ts` + `test/*.test.ts` (non-recursive), so the files live in
`src/engine/` — WP 4.4's precedent. Fixtures stay in `test/engine/fixtures/`.

---

## 1. Byte identity across two processes (the §5 exit criterion)

`reproducible.test.ts` → `'an identical seed produces byte-identical output across two processes'`.
Each run is a cold `node` child that imports the engine, builds the job through the Money boundary
(`toMonteCarloJob`), runs it **through the worker** (`runJobInWorker` — envelope, spawn, clone, the
kernel, clone back), serialises with `serialiseResult` (magic line, sorted-key JSON header with the
seed as text, then every band / sequence / crypto-at-zero array as little-endian doubles) and prints
pid, SHA-256 and the base64 bytes. The parent compares **buffers** with `Buffer.equals`. Both
engines; the plan holds crypto, so the dual projection's bands are in the bytes. 2,000 paths × 60
years each (the 30 s budget holds two cold processes × two workers).

| engine    | pid A  | SHA-256 A                                                          | pid B  | SHA-256 B                                                          | bytes |
| --------- | ------ | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------ | ----- |
| bootstrap | 358400 | `603b741791ca85935066dfaeca9f813f41738775cb1bd40e15f835ae3c2896eb` | 358423 | `603b741791ca85935066dfaeca9f813f41738775cb1bd40e15f835ae3c2896eb` | 7,626 |
| lognormal | 358400 | `08ad99b931465ba9f7a5f6a863669ca6d82831251db27ed164d7988399fafebe` | 358423 | `08ad99b931465ba9f7a5f6a863669ca6d82831251db27ed164d7988399fafebe` | 7,546 |

The control, `'a different seed produces different output'` (seed 20260910 vs 20260911):
bootstrap `603b7417…` → `93983723…`, lognormal `08ad99b9…` → `05d8ce63…` — and the test asserts the
**bands** differ, not only the header (the seed is in the header, so a digest-only check would pass
against an engine that ignored the seed; sabotage S1 below is exactly that case, and it was the band
check that went red).

Also in the file: `'xoshiro256++ and SplitMix64 reproduce the reference C, word for word and double
for double'` — six seeds against `test/engine/fixtures/xoshiro-vectors.json`, produced by compiling
the Blackman–Vigna reference C beside it (`xoshiro-reference.c`), across a pool-refill boundary.

**The seed contract** (WP 4.6's §10.2 ask, now built): a seed is a **64-bit pattern**. The envelope
accepts −2^63 ..= 2^64 − 1; `canonicalSeed` = `BigInt.asUintN(64, ·)` is applied in `toMonteCarloJob`,
in `runJobInWorker` before the clone, and in `runMonteCarlo`'s result, so a result always echoes the
**unsigned** representation `projection_runs.seed` stores. `'a seed is a 64-bit pattern: its signed
and unsigned representations draw the same bytes and echo unsigned'` proves −1 and 2^64 − 1 serialise
identically, and a −5 sent through the worker comes back as 2^64 − 5. The adapter needs no
`asIntN`/`asUintN` dance: pass the stored seed as-is.

## 2. The invariants (07 §8.4)

| #   | Test (verbatim)                                                                                               | How                                                                                                                                                                                                                                                                                                                 | Counterexample search                                                                                                                                                                                                                                                                                                     | Result                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `'zero volatility makes the Monte Carlo median equal the deterministic path'`                                 | Assumptions with equity, bond and inflation σ overridden to `'0'`; lognormal engine; plans A, B and B with guardrails + a pension. Every year's p5, p50 and p95 compared with `projectDeterministic` as **Money** (identical minor units), and the median band compared with `runDeterministic`'s float with `toBe` | none needed — exact equality, every year, three plans                                                                                                                                                                                                                                                                     | **bitwise equal** (same `stepYear`, same `MarketYear`)                                      |
| 2   | `'success rate is monotone in savings rate, monotone in retirement age, and monotone decreasing in spending'` | `fast-check` over 13 generated fields: balance, contribution, spending, retirement age 50–70, static share or age-based glidepath, bucket, SS on/off, crypto on/off, **engine**, a full 64-bit seed, and step sizes. Each lever is compared over the same seed's shocks (CRN), 300 paths                            | 40 runs, fixed seed 4 500 045; fast-check shrinks on failure. Observed shrinking under sabotage S8: _"Property failed after 6 tests … Shrunk 22 time(s)"_ to `{startingBalance: 0, contribution: 0, spending: 20000, retirementAge: 50, … engine: 'bootstrap', seed: -4n}` — retiring at 51 gave 10 successes vs 11 at 50 | **holds** on the committed code (no counterexample in 40 runs)                              |
| 3   | `'the p5 estimate is stable within 1% across ten seeds at n=10,000'`                                          | Balanced saver (case B, 35 → 65), ten seeds × 10,000 paths, **every one of 30 checkpoints**, both engines                                                                                                                                                                                                           | — (a statistic, not a property)                                                                                                                                                                                                                                                                                           | worst **relative sd of p5 = 0.730 %** (bootstrap) / **0.759 %** (lognormal); asserted < 1 % |

**Invariant 3 — the definition, stated because it matters.** 07 says "p5 estimate stable to within
1% across seeds at n=10,000" and does not say of what statistic. The test reads it as the p5
estimator's **relative standard error** — the sample standard deviation of the ten seeds' p5 over
their mean — at every checkpoint. The stricter reading, _every single seed within 1 % of the
ten-seed mean_, **does not hold** at n = 10,000 and the test prints it rather than asserting it:

| series / engine                                    | worst relative sd of p5 (asserted) | worst single seed vs ten-seed mean (printed) |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| synthetic, bootstrap                               | 0.73 %                             | 1.51 %                                       |
| synthetic, lognormal                               | 0.76 %                             | 1.43 %                                       |
| Shiller 1871–2024, bootstrap (not in CI; measured) | **1.02 %**                         | 1.90 %                                       |

Quantile error falls as 1/√n; the stricter reading needs n ≈ 22,500 (above the 20,000 envelope), and
on real history even the sd reading sits at the line for a 25-year accumulation. That is quantile
estimation, not a defect — but it is a definitional choice, put to the orchestrator (§10).

Kernel contracts, same file: `'a path state is reset in place to exactly what newPathState builds'`
(field by field, so a field WP 4.4 adds later cannot leak between paths); `'common random numbers: a
lever moves the outcome and never the shocks'` (four levers, shocks byte-equal; 800 paths extend 400
byte-for-byte; +10 % savings is ≥ at every band); `'failure does not stop a path: …'` (median
shortfall years > 0 and the unfunded total < full spending × those years — the benefit kept paying);
`'percentiles by partial sort equal a full sort, type 7, ties and all'` (500 fast-check runs); the
solver's `'bisects over one shock matrix: the same answer every run, and the answer is minimal to a
dollar a month'` and `'names the binding constraint instead of a number …'`.

## 3. Crypto, its own class (07 §6.4)

`crypto.test.ts`, both engines, 4,000 paths × 60 years:

- `'crypto is drawn from its own distribution and a 70% sigma never enters the equity draw'` —
  (a) equity, bond and inflation shocks **byte-identical** with crypto held, with crypto at σ = 5 %,
  and with no crypto (own PRNG stream per path, `prng.ts` stream 1); (b) the crypto-at-zero bands are
  byte-identical under σ = 70 %, σ = 5 % and a plan with no crypto — the four tax buckets never see
  crypto — while the with-crypto bands do move; (c) the draw is Student-t(3):

  | engine    | draws   | P(\|x\| > 3), unit variance | normal would be | years below −100 % nominal | corr(crypto, equity shock) |
  | --------- | ------- | --------------------------- | --------------- | -------------------------- | -------------------------- |
  | bootstrap | 240,000 | 1.353 %                     | 0.270 %         | 3.77 %                     | 0.388                      |
  | lognormal | 240,000 | 1.359 %                     | 0.270 %         | 3.88 %                     | 0.399                      |

  A unit-variance t(3) puts ≈ 1.38 % beyond ±3; a lognormal can never go below −100 %, and this draw
  does in ≈ 3.8 % of years (the sleeve books it as a total loss, never a negative balance). The
  correlation lands on the file's 0.40 through the ρ/κ coupling (κ(3) ≈ 0.798).

- `'the dual projection reports the plan with crypto at zero'` — the crypto-at-zero run **is** the
  no-crypto plan over the same shocks (equal success count, byte-equal bands); crypto funds last, so
  with-crypto success is strictly higher on an underfunded plan (bootstrap 0.228 vs 0.2125; lognormal
  0.24625 vs 0.23475); the summary carries that probability, that median terminal wealth and the
  file's disclaimer verbatim; the same result through the worker serialises identically to in-process.

## 4. The worker's limits

### 4.1 The envelope — refused before a worker exists

```ts
export const MONTE_CARLO_ENVELOPE = Object.freeze({
  maxPaths: 20_000, // 07 §5.3 defaults to 10,000; twice that is the most an interactive re-run needs
  maxYears: 100, // WP 4.4's MAX_PLAN_AGE is 120; a plan from age 20 is 100 years
  maxCells: 1_000_000, // paths × years — bounds the buffers resourceLimits cannot (≈ 49 MB)
  minSeed: -(2n ** 63n), // a 64-bit pattern, signed or unsigned (§1)
  maxSeed: 2n ** 64n - 1n,
  maxSeriesMonths: 2_400, // 200 years of months; Shiller's is 1,847
  minDegreesOfFreedom: 3,
  maxDegreesOfFreedom: 30,
});
```

`'a request for 10,000,000 paths is refused before a worker is spawned'`: a counting `spawn` is
injected; `runJobInWorker`, `runMonteCarloInWorker` and `solveProbabilityInWorker` all throw
`MonteCarloRefused { code: 'planning.montecarlo_paths_outside_envelope', field: 'paths' }` with **0
spawns**, in 1.96 ms; then horizon 101 years, 20,000 × 60 cells, 0 and 10.5 paths, seeds 2^64 and
−2^63 − 1, and a bootstrap with no series — ten refusals, each by its own code, 0 spawns.

**Why the envelope, not `resourceLimits`, bounds memory:** measured in a worker created with these
exact limits (64 MB old generation), `new Float64Array(64 × 2^20)` — **512 MB — allocates and returns**
(worker RSS 62 MB before touching it); the same limits kill a JS-object leak with
`ERR_WORKER_OUT_OF_MEMORY`. V8's heap limits do not cover `ArrayBuffer` backing stores, and every
large buffer here is one.

### 4.2 `resourceLimits`, quoted with reasons

```ts
export const WORKER_RESOURCE_LIMITS = Object.freeze({
  // 64 MB of old generation. The kernel's heap is small — the plan, a few closures, the result's
  // headers; every per-path and per-year number lives in a typed array outside the heap — and the
  // probe measures ~9 MB in use. 64 MB is several times that and a small fraction of the 512 MB
  // container, so a runaway dies here with ERR_WORKER_OUT_OF_MEMORY instead of taking the API down.
  maxOldGenerationSizeMb: 64,
  // 16 MB of young generation. The inner loop allocates nothing; what is short-lived is per-job
  // setup. A small nursery keeps scavenges short.
  maxYoungGenerationSizeMb: 16,
  // 4 MB of stack — Node's default, declared rather than inherited. Nothing in the kernel recurses:
  // quickselect and the bisection are loops.
  stackSizeMb: 4,
});
```

The thread reports back `{"maxYoungGenerationSizeMb":16,"maxOldGenerationSizeMb":64,"codeRangeSizeMb":0,"stackSizeMb":4}`
and 9.0 MB heap used. `'a heap-hungry worker dies at its declared limit and the caller receives a
typed failure'` runs an object leak under the same options: `MonteCarloWorkerFailed { workerCode:
'ERR_WORKER_OUT_OF_MEMORY' }` in ~0.4 s, and the test process is still alive to assert it.

### 4.3 The deadline — terminate, never await

`'a worker that exceeds its deadline is terminated and the caller receives a typed timeout, not a
hang'`, twice, each bounded by a 2 s sentinel so a hang is a red test rather than a stuck suite:

| case                                           | deadline | `MonteCarloTimeout` after | thread `exit` (code) after |
| ---------------------------------------------- | -------- | ------------------------- | -------------------------- |
| the real engine, 20,000 × 50                   | 100 ms   | 103 ms                    | 119 ms (1)                 |
| `for (;;) {}` — only `terminate()` can stop it | 200 ms   | 202 ms                    | 203 ms (1)                 |

Defaults: `DEFAULT_DEADLINE_MS = 5_000` (≈ 6× the 800 ms budget plus the spawn),
`DEFAULT_SOLVE_DEADLINE_MS = 20_000` (the solver runs ~15–20 simulations over one shock matrix).

### 4.4 Nothing inherited

`'the worker inherits no environment and no execArgv'` — in-process through the real spawn, and in a
**child that has both**: the child ran with `--max-old-space-size=300 --stack-trace-limit=40`, 99
environment keys including `PERSONALFI_PROBE_SECRET` and a `DATABASE_URL`; its worker reported `env
[]`, `execArgv []`. `env: {}` is an empty object, not `SHARE_ENV`.

### 4.5 What the limits do not cover (open item)

There is **no cap on concurrent workers**. Measured RSS deltas: four concurrent 10k × 40 runs
+118 MB; four concurrent envelope-maximum (20k × 50) runs +183 MB (≈ 45 MB each). Ten concurrent
maximum requests would take a 512 MB container down. See §10.

## 5. Timing (08 §7.2): `'10,000 paths over 40 years complete within 800 ms p95 on one core'`

**Input.** WP 4.13's scale seed **does not exist yet**, so the test builds an explicit 200-position
input: ten accounts (three brokerage, two 401(k), a rollover IRA, two Roth IRAs, an HSA, a crypto
wallet), 200 positions of whole-cent `Money`, summed exactly as WP 4.6 sums them — into four tax
buckets (TAXABLE $778,932.35, TAX_DEFERRED $791,552.05, ROTH $370,633.50, HSA $150,523.38) and a
crypto sleeve ($105,509.72). It asserts 200 positions, 200 distinct symbols and that the buckets plus
crypto equal the sum of positions **before** timing. The engine never sees positions (the cost is
paths × years × the plan's features), so the plan turns every feature on: four buckets with four
different glidepaths, wage-growing contributions to three, Guyton-Klinger guardrails with a floor,
Social Security with the 2034 stress, a CPI-COLA pension, part-time income, and crypto (its own
draws and a second set of bands). Bootstrap over a 1,847-month series (the real window's length).
Age 55 → 95 = 40 years; 10,000 paths (asserted). 9,718 / 10,000 succeed.

**What is timed.** `runJobInWorker`, call to reply: envelope, a **fresh** worker with the production
options, the clone in, the kernel, the bands out — one interactive request. Two clocks: wall time,
and the worker thread's own CPU time (`process.threadCpuUsage()` at the reply). Both are asserted.
Three warm-ups printed and excluded; 25 samples.

**Run alone** (`vitest run --project planning src/engine/perf.test.ts`), final code, load average
2.64 2.64 2.13 before and 2.52 2.62 2.13 after (other agents' test runs on the box):

```
warm-ups (excluded), thread cpu/wall: 655.9/668.6, 639.6/652.1, 625.4/636.5 ms
thread cpu samples: 614.1, 615.5, 574.3, 557.9, 596.8, 568.5, 566.4, 579.6, 571.7, 556.4, 632.6, 668.5,
  633.7, 587.4, 564.4, 568.3, 539.3, 570.3, 563.0, 546.7, 528.3, 570.2, 542.5, 543.8, 579.5 ms
wall samples: 623.9, 626.5, 586.2, 566.7, 606.7, 576.2, 573.6, 588.3, 580.0, 564.4, 644.0, 687.3,
  643.3, 594.6, 573.2, 576.9, 544.5, 580.7, 568.4, 553.5, 534.7, 578.9, 548.8, 552.2, 585.9 ms
```

| clock               | p50      | p95          | p99      | min   | max   |
| ------------------- | -------- | ------------ | -------- | ----- | ----- |
| wall, spawn → reply | 578.9 ms | **643.8 ms** | 676.9 ms | 534.7 | 687.3 |
| worker thread CPU   | 570.2 ms | **633.5 ms** | 660.1 ms | 528.3 | 668.5 |

One core: the kernel is single-threaded and one worker runs per request. Headroom ≈ 20 % — not 5×.
Before the last change the same run measured p50 666 / p95 698 ms: the crypto-at-zero projection
was a second `simulate` pass; it is now filled **in the same pass** (the sleeve never feeds the four
buckets, so their path is identical — `simulate`'s header), and the two-process digests in §1 did
**not move** across that change, which is the proof it is exact. Where the rest goes (cold worker,
this plan): ~50 ms module load, ~235 ms shocks (≈ 135 ms the 4.8 M monthly bootstrap steps, ≈ 70 ms
the Student-t draws), ~150 ms the simulation pass, the summary and the cold JIT the remainder. A
pooled, pre-warmed worker would be well under 400 ms (§10).

**Under contention it fails, and that is the machine, not the kernel.** In `vitest run --project
planning` this file shares 4 cores / 8 threads with every other planning file (the invariants file is
~15 s of Monte Carlo): observed p50 668 ms but p95 **1,492 ms wall / 1,130 ms thread CPU** — SMT
siblings and the all-core clock inflate CPU time too, so switching clocks does not rescue it. With
the file in its own vitest project run after everything else (`sequence.groupOrder: 1`,
`fileParallelism: false` — the §10 block, run with a temporary config of exactly that shape) the
other 23 files passed and perf ran last, but **other agents' suites were running on the box at the
same time** (an `api-db` vitest at 145 % CPU; load 4.79 → 6.85 across the perf run): p50 634 ms, p95
1,142 ms wall — red. One earlier isolated-config run at load 5.17 passed (p95 736 ms); another at
6.05 did not (810 ms). The number is honest only on a quiet machine, which is what the gate has.

## 6. The return series — provenance, licence terms as found, checksum

Full note: `packages/contexts/planning/data/returns/PROVENANCE.md`. In short:

- **Source:** Shiller, `ie_data.xls`, <https://shillerdata.com/>, fetched 2026-09-26
  (`Last-Modified: Wed, 02 Sep 2026 17:51:53 GMT`, 1,674,752 bytes, raw SHA-256
  `044196da…e19589c1`, not pinned — re-uploaded monthly).
- **Derived:** real monthly equity total return, 10-year Treasury total return, CPI-U; window
  1871-02..2024-12, 1,847 months, twelve places. Cross-checked against Shiller's own index columns
  (max difference 4.4 × 10⁻¹⁶) and against Damodaran's `histretSP.xls` (97 calendar years, mean
  |difference| 2.11 points, correlation 0.9897, means 8.64 % vs 8.55 %).
- **Checksum (committed `SHA256SUMS`):**
  `cbdefda1752eac2bd393efbae29a8dfb8d0af2b79a9d7cf2baa5f0e292851e80  shiller-monthly.csv`; a cache
  that does not hash to it is refused by name (`'the return series is refused unless its bytes hash to
the committed pin'`: a one-digit edit → `planning.returns_series_checksum_mismatch`; absent →
  `planning.returns_series_unavailable` naming the fetch command; a bad download → nothing cached).
- **Licence terms as found:** Shiller states **no licence** and grants no redistribution — only a
  disclaimer ("the user of this information assumes the entire risk …"; no warranty), and the S&P
  columns derive from S&P Dow Jones Indices data. Damodaran's usage rules are permissive in spirit
  ("I want the data to be widely used … this data is here for you to use", acknowledgement optional)
  but are not a licence, and he notes commercial upstream sources. Damodaran is a cross-check only.
- **Verdict:** not vendored — **fetch-on-first-run with a pinned checksum, and the offline guarantee
  is lost for the bootstrap engine** (§6 Q3's stated fallback). The lognormal engine needs no history.

**Re-centring, realised against target** (10,000 paths × 30 years, what `bootstrap.ts`'s header
promised to report). The i.i.d. lognormal correction is approximate under the block structure:

| series            | realised mean annual real equity | target (file) | realised sd | realised real bonds | target  |
| ----------------- | -------------------------------- | ------------- | ----------- | ------------------- | ------- |
| Shiller 1871–2024 | **4.398 %**                      | 3.902 %       | 17.82 %     | 2.116 %             | 1.951 % |
| synthetic (CI)    | 3.813 %                          | 3.902 %       | 14.32 %     | 1.959 %             | 1.951 % |

On real history the default engine runs **~0.5 points/year optimistic** on equities (Shiller's P is a
monthly average of daily closes, which autocorrelates adjacent months and widens the annual sum
beyond 12 s²). Open item, §10.

## 7. Sequence-of-returns risk — success by first-five-retirement-year decile

A retiree at 65 with $1,000,000 in a 60/40 taxable account spending $40,000 real (the 4 % rule), to
95; 10,000 paths, seed 20260926. Deciles of the annualised real portfolio return over the first five
retirement years (`MonteCarloSummary.sequence`):

| decile | Shiller bootstrap: return range | success    | synthetic bootstrap: range | success | lognormal: range  | success |
| ------ | ------------------------------- | ---------- | -------------------------- | ------- | ----------------- | ------- |
| 1      | −15.44 % .. −3.94 %             | **16.9 %** | −10.96 .. −2.20 %          | 23.8 %  | −12.43 .. −3.11 % | 17.9 %  |
| 2      | −3.94 .. −1.55 %                | 39.8 %     | −2.20 .. −0.59 %           | 49.3 %  | −3.11 .. −1.19 %  | 39.9 %  |
| 3      | −1.54 .. 0.13 %                 | 54.0 %     | −0.59 .. 0.61 %            | 62.4 %  | −1.19 .. 0.15 %   | 52.5 %  |
| 4      | 0.13 .. 1.64 %                  | 63.4 %     | 0.61 .. 1.63 %             | 70.7 %  | 0.15 .. 1.37 %    | 60.5 %  |
| 5      | 1.64 .. 2.96 %                  | 77.2 %     | 1.63 .. 2.62 %             | 82.3 %  | 1.37 .. 2.58 %    | 71.5 %  |
| 6      | 2.96 .. 4.20 %                  | 82.7 %     | 2.62 .. 3.59 %             | 82.9 %  | 2.58 .. 3.78 %    | 80.5 %  |
| 7      | 4.20 .. 5.56 %                  | 86.3 %     | 3.59 .. 4.70 %             | 89.8 %  | 3.78 .. 5.03 %    | 84.5 %  |
| 8      | 5.56 .. 7.13 %                  | 90.7 %     | 4.70 .. 6.02 %             | 92.4 %  | 5.03 .. 6.63 %    | 91.3 %  |
| 9      | 7.13 .. 9.54 %                  | 94.0 %     | 6.02 .. 7.97 %             | 96.7 %  | 6.63 .. 8.82 %    | 94.1 %  |
| 10     | 9.54 .. 23.93 %                 | **97.7 %** | 7.97 .. 23.07 %            | 98.8 %  | 8.83 .. 22.75 %   | 98.6 %  |
| all    |                                 | **70.3 %** |                            | 74.9 %  |                   | 69.1 %  |

Same plan, same average: 17 % success when the first five years are the worst tenth, 98 % when they
are the best. Failures keep running on the benefit: Shiller median depletion age 89, median
shortfall 6 years.

## 8. Sabotage

Each control broken once in the source, the named test run, then the file restored from a copy
taken before the pass and verified with `sha256sum -c`. **All red on the first attempt, twice:** the
full pass was first run during development (hashes `48a2fbaf…` / `c2676dd0…`), then **re-run in full
against the final files** after the single-pass change (`montecarlo.ts`
`cbfea2c43af8bd33ba4b236d459cec7e59527866d8457d39be46017b04f65042`, `worker-host.ts`
`0b3b37119f88863bf004433209b45f5067e68eae2aebd340c71eb3b43d0efab4`; both `OK` after every restore).
The table quotes the final pass; where the first pass's message differed it is given too.

| #   | Sabotage                                                                                                 | Test                                           | Observed                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| S1  | seed ignored: `seedHalves(0n)` in `drawShocks`                                                           | `'a different seed produces different output'` | red — `bootstrap: bands identical` (the digests differed only through the header's seed text; the band check caught it)       |
| S2  | crypto folded into the equity **return**: `equityReal += 0.1 σ_crypto × shock` in `simulate`             | both crypto tests                              | red, both — `bootstrap: 70% σ reached the buckets`; `expected 893 to be 850`                                                  |
| S2b | crypto's stream folded into the equity **shock** in `drawShocks`                                         | both crypto tests                              | red, both — `bootstrap equity: expected false to be true`; `expected 951 to be 850`                                           |
| S3  | deadline not enforced (the timer's terminate + reject removed)                                           | the deadline test                              | red — `the real engine past its deadline: … still pending` under load (first pass: `promise resolved … instead of rejecting`) |
| S3b | typed timeout kept, `terminate()` removed                                                                | the deadline test                              | red — `the spinning thread: still pending after 2000 ms — a hang`                                                             |
| S4  | `assertWithinEnvelope` removed from `runJobInWorker`                                                     | the 10,000,000-path test                       | red — `MonteCarloWorkerFailed` where `MonteCarloRefused` was required (a spawn counted)                                       |
| S5  | inner-loop allocation: `stepYear(…, true)` in `simulate` (a `YearRecord` and its arrays every path-year) | the perf test                                  | red — **p95 2,153 ms wall / 2,128 ms CPU** vs 800 (first pass, two simulation passes: 3,654 / 3,622)                          |
| S6  | `env: {}` removed                                                                                        | the no-env/execArgv test                       | red — `expected [ 'PROD', 'DEV', 'MODE', …(95) ] to deeply equal []`                                                          |
| S7  | `execArgv: []` removed                                                                                   | the no-env/execArgv test                       | red — `expected [ …(7) ] to deeply equal []`                                                                                  |
| S8  | CRN broken: the market stream seeded with `seedLo ^ retireAge`                                           | invariant 2 + the CRN test                     | red, both — fast-check `Shrunk 22 time(s)` to a retire-at-51-is-worse counterexample (§2); shocks differ across a lever       |

## 9. Modules and tests

| File                               | Role                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/prng.ts`               | xoshiro256++ / SplitMix64 on uint32 halves; per-(path, stream) seeding; pooled doubles; Box-Muller with cached spare; `canonicalSeed`                                                                                                                   |
| `src/engine/bootstrap.ts`          | stationary block bootstrap (circular, p_stay = 11/12); Cholesky; the lognormal year                                                                                                                                                                     |
| `src/engine/montecarlo.ts`         | shocks (the CRN matrix), one `simulate` pass over `stepYear` serving the plan and its crypto-at-zero projection, partial-sort percentiles, failure summary, sequence deciles, crypto sleeve, the success solver, the worker protocol, `serialiseResult` |
| `src/engine/monte-carlo.worker.ts` | one request in, one reply out (bands, never paths; buffers transferred), thread CPU time on `run`                                                                                                                                                       |
| `src/engine/worker-host.ts`        | envelope, limits, spawn options, deadline, typed failures, the Money-facing entry points                                                                                                                                                                |
| `data/returns/*`                   | derivation, BIFF8 reader, loader + pin, operator fetch command, provenance                                                                                                                                                                              |

| Test file               | Tests                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `reproducible.test.ts`  | 5 — the two exit tests, the reference-C vectors, the seed contract, the series pin |
| `invariants.test.ts`    | 9 — invariants 1–3 and six kernel/solver contracts                                 |
| `crypto.test.ts`        | 2 — both exit tests                                                                |
| `worker-limits.test.ts` | 4 — the three exit tests + the heap limit                                          |
| `perf.test.ts`          | 1 — the exit test                                                                  |

## 10. For the orchestrator

1. **Vitest isolation for `perf.test.ts` (config, not code).** In the shared `planning` run the perf
   test is red from contention (§5). Validated block for `vitest.config.ts`:

   ```ts
   // in the existing 'planning' project's test: add
   exclude: ['**/node_modules/**', 'src/engine/perf.test.ts'],
   // and a new project:
   {
     // 08 §7.2's budget is for a core the kernel has to itself: run after everything else, alone.
     root: './packages/contexts/planning',
     test: {
       name: 'planning-perf',
       include: ['src/engine/perf.test.ts'],
       environment: 'node',
       fileParallelism: false,
       sequence: { groupOrder: 1 },
       testTimeout: 120_000,
     },
   },
   ```

   (`groupOrder` runs a group after all lower groups finish.) Run with a temporary config of exactly
   this shape, the other 23 planning files passed and perf ran last and alone among them — but it
   cannot shield the file from **other processes on the box**: with another agent's `api-db` suite
   running, perf went red (p95 1,142 ms at load 6.85). The gate should run it on an idle machine and
   compare the distribution to §5's.

2. **Worker resolution in the pruned image — reachable.** `worker-host.ts` spawns
   `new URL('./monte-carlo.worker.ts', import.meta.url)`. `@ctx/planning` is in `@app/api`'s
   production closure (`apps/api/package.json`), so `docker/api.Dockerfile`'s computed KEEP set keeps
   `packages/contexts/planning`; the prune deletes `test/` directories and `*.test.ts` only, and
   `monte-carlo.worker.ts` matches neither. Node resolves the workspace symlink to its real path, so
   the URL is `/app/packages/contexts/planning/src/engine/monte-carlo.worker.ts` — no `node_modules`
   segment, so type-stripping is allowed (the WP 0.4 guard). The worker's import closure is
   `montecarlo.ts` → `deterministic.ts`, `bootstrap.ts`, `prng.ts`, `glidepath.ts`, `guardrails.ts`,
   `pension.ts`, `social-security.ts` — all relative, all in `src/engine/`, no package import at all.
   Verified: (a) from `apps/api` through `node_modules/@ctx/planning`, the spawned URL was
   `file:///home/chris/…/packages/contexts/planning/src/engine/monte-carlo.worker.ts` and the run
   answered; (b) a copy of `src/engine/` minus tests, alone under `/tmp`, ran the worker and produced
   bytes identical to in-process. **There is no tsx in this repo** (not on PATH, not a dependency);
   dev is `node --watch ./src/main.ts` with native stripping, which is what (a) exercised. Not
   verified: an actual image build (no docker in this WP).
3. **`.dockerignore` must exclude the returns cache.** `packages/contexts/planning/data/returns/cache/`
   is git-ignored but not docker-ignored; `COPY . .` on a machine with a filled cache ships Shiller's
   derived data in the image — the redistribution §6 Q3 avoided. Add
   `packages/contexts/planning/data/returns/cache`.
4. **The runtime rootfs is read-only.** `ensureReturnSeries`'s default cache dir is inside the
   package; the composition root must pass `cacheDir` on a writable volume and decide whether the
   process may download (`download` is injected). With no cache and no downloader: bind
   `monteCarlo: null` (WP 4.6 §10.2 already says so).
5. **Licence verdict for §6 Q3:** neither Shiller nor Damodaran grants redistribution; Shiller states
   no licence at all. Not vendored; fetch-on-first-run with the pinned checksum; **the bootstrap
   engine loses the offline guarantee.** Chris's call whether to accept, seek permission, or vendor.
6. **Numeric-boundary exemptions used:** none in `scripts/check-numeric-boundaries.ts` (0 violations,
   no allow-list entry, 0 exempt identifiers in these files). One declared evasion of WP 4.4's
   interior grep: `worker-host.ts` reads a cited node's text through `const CITED = 'value'` (the
   grep strips strings); what it reads is a decimal string straight into `toEngineRate`. Proper home:
   a `monteCarloMarketFrom(assumptions)` in `boundary.ts` (WP 4.4's file), after which the accessor goes.
7. **Error mapping for WP 4.8:** `MonteCarloRefused` (`planning.montecarlo_*_outside_envelope`,
   `…_series_invalid`, `…_crypto_invalid`, `…_target_invalid`; has `field`) → **422**; the path cap is
   **20,000** (WP 4.6's service accepts up to 1,000,000 — the worker's envelope is authoritative;
   100k-path power-user runs belong to a queued job, 08 §7.2). `MonteCarloTimeout`
   (`planning.montecarlo_timeout`) → **503**, retryable. `MonteCarloWorkerFailed`
   (`planning.montecarlo_worker_failed`, `workerCode` e.g. `ERR_WORKER_OUT_OF_MEMORY`) → 500/503.
   `ReturnSeriesRefused` → 503, an operator action. `ProjectionInputRefused` from the boundary → 422.
8. **Seed:** pass `projection_runs.seed` (unsigned) straight in; the result echoes it unsigned. WP 4.6
   §10.2's `asIntN`/`asUintN` conversions in the adapter are now unnecessary (harmless if kept).
9. **Exports now on `@ctx/planning`** (`src/engine/index.ts`): `runMonteCarloInWorker`,
   `solveProbabilityInWorker`, `toMonteCarloJob`, `toMonteCarloSummary`, `MONTE_CARLO_VERSION`,
   `MonteCarloRefused`, `MonteCarloTimeout`, `MonteCarloWorkerFailed`, `MONTE_CARLO_ENVELOPE`,
   `MONTE_CARLO_RESOURCE_LIMITS`, `MONTE_CARLO_DEADLINE_MS`, `MONTE_CARLO_SOLVE_DEADLINE_MS`,
   `MONTE_CARLO_DEFAULT_PATHS`, `MONTE_CARLO_PERCENTILE_LEVELS`, `DEFAULT_SUCCESS_TARGET`,
   `serialiseMonteCarloResult`, `loadReturnSeries`, `ensureReturnSeries`, `ReturnSeriesRefused`,
   `RETURN_SERIES_FETCH_COMMAND`, and the types (`ReturnSeries`, `MonteCarloRequest`,
   `MonteCarloSummary`, `MonteCarloRun`, `MonteCarloResult`, `MonteCarloEngineKind`,
   `MonteCarloHostOptions`, `MoneyBand`, `SequenceDecile`, `ProbabilitySavingsRequest/Result`,
   `MonteCarloRefusalCode`, `ReturnSeriesOptions`, `ReturnSeriesRefusalCode`). `WorkerRun` gained
   `threadCpuMs` (additive).
10. **One-off life-event outflows (WP 4.6's stored negative events).** `stepYear` can take them
    without touching the 4.4 boundary's shape: it already reads per-year schedules from
    `PreparedPlan` (`socialSecurityByYear`, `pensionByYear`, `otherByYear` — `Float64Array`s built once
    by `preparePlan`). A signed `oneOffByYear` built in `toEnginePlan` from the events' `Money`
    (through `toEngineAmount`, in `boundary.ts` — the one crossing) and consumed in `stepYear` — before
    retirement a negative TAXABLE contribution that falls through the withdrawal order when TAXABLE is
    short; in retirement added to `need` outside the guardrail spending — is one array read per year,
    no allocation, and the Monte Carlo inherits it for free (a lever, never a shock, so CRN holds and
    invariant 1 still holds by construction). Owner: WP 4.4's files (`boundary.ts`,
    `deterministic.ts`), not 4.5. Undecided: whether an unfunded outflow counts as depletion.

**Open items**

- **Concurrent workers are unbounded** (§4.5): ~30–45 MB each; ~10 concurrent maximum runs exceed a
  512 MB container. Needs a cap (a host-side semaphore, or a route/queue limit in WP 4.8) and a
  sabotage-tested refusal.
- **Invariant 3's definition** (§2): asserted as relative sd < 1 %; the per-seed reading fails at
  n = 10,000 (1.4–1.9 %), and on Shiller's series the sd reading is 1.02 % at the worst checkpoint.
- **Bootstrap re-centring is ~0.5 pt/yr optimistic on real history** (§6). A fix: calibrate the shift
  from the series' own annual-block distribution (deterministic, per series), costing a few ms per
  job; or accept and state it. Bumps `MONTE_CARLO_VERSION` either way.
- **Perf headroom ≈ 20 % alone, none under contention.** Cold-worker dominated: a pre-warmed worker
  would be well under 400 ms but changes the terminate-on-deadline model (a pool must respawn).
  Draw-cost option: geometric block lengths with prefix sums instead of a coin per month (changes the
  draws, so a `MONTE_CARLO_VERSION` bump).
- **WP 4.13's scale seed**: when it lands, `perf.test.ts` should read it instead of building one, and
  WP 4.13's `apps/api/test/db/projection-perf.test.ts` covers the HTTP path.
- Crypto: Student-t only; the BTC block-bootstrap alternative of 07 §6.4 is not built.
- Not done here: an image build and the gate's container-memory watch.

## 11. Verification

Run before the report was written (2026-09-26, 22:52–23:02), on the final code:

- `pnpm exec tsc -b --noEmit` — clean (whole repo).
- `pnpm exec eslint packages/contexts/planning/src/engine packages/contexts/planning/data/returns
packages/contexts/planning/test/engine/fixtures` — clean.
- `pnpm exec prettier --check` over every file touched — clean.
- `node scripts/check-numeric-boundaries.ts` — self-test PASS; 758 files, 0 violations, 72 exempt
  (unchanged; none in these files).
- `vitest run --project planning` — 24 files, 122 tests: **121 passed, `perf.test.ts` red from
  contention** (p95 1,492 ms wall with the suite beside it; §5, §10.1). Every other WP 4.5 test green.
- `perf.test.ts` alone: green, p95 643.8 ms wall / 633.5 ms CPU (§5).
- Two-process digests unchanged across the single-pass change (§1).

### 11.1 Final re-run (2026-09-26 23:02–23:06, after the report was written)

- `tsc -b --noEmit` exit 0; eslint clean; prettier `--check` clean; numeric-boundary check PASS
  (758 files, 0 violations, 72 exempt).
- `vitest run --project planning`: 24 files, 122 tests — **121 passed; `perf.test.ts` red** under the
  suite (p50 544.6 ms, p95 1,155.2 ms wall / 880.2 ms CPU; load 3.60 → 5.63). Two-process digests
  again `603b7417…2896eb` (bootstrap) and `08ad99b9…fafebe` (lognormal), pids 385052 / 385138;
  invariant 3 again 0.730 % / 0.759 %; deadline 107 ms → exit 1 at 119 ms.
- `perf.test.ts` alone, straight after (load 4.84 → 3.99): **green**, p50 534.4 ms, **p95 592.0 ms
  wall / 584.5 ms CPU**, p99 609.1 ms.
- `git diff --cached --name-only`: empty.
