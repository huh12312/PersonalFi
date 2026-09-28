<!-- SPDX-License-Identifier: MIT -->

# WP 4.11 — UI: the client projection worker

_Finishing agent's evidence. A previous agent was killed by an account limit at "write the
montecarlo.ts kernel port (shocks, simulate, summary, serialise)"; its work was on disk under
`apps/web/src/workers/kernel/**` (snapshot-committed as a wip, not pushed) — `kernel/{prng,
glidepath,lognormal,deterministic,montecarlo}.ts`, five files, already carrying careful headers
explaining the port-not-import decision and the scope cuts. This session read every file, diffed
each against its server counterpart line by line, verified the port byte-for-byte against the
server engine (§1), and then finished the rest of the WP: `projection.worker.ts`,
`projection-client.ts`, the sliders UI, the golden-vector fixture and its two tests, the e2e suite,
and this document. Dispatch: `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.11"._

---

## 1. The golden vector — both digests, shown equal

The fixture is **one committed file**,
`packages/contexts/planning/test/fixtures/golden-vector.json` — produced once by running the
**server** engine (`packages/contexts/planning/src/engine/montecarlo.ts`'s `runMonteCarlo` +
`serialiseResult`) over a hand-built job (§4 has the plan), then read by both suites. Not copied:
`apps/web/src/workers/projection.worker.test.ts` reads this exact path with a relative JSON
import (§6 explains why not a module import of `@ctx/planning` itself, and why not `node:fs`), so
there is exactly one file that could ever drift.

| Half       | Test file                                               | Test name (verbatim)                                                      | SHA-256                                                            | Bytes |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----- |
| **Server** | `packages/contexts/planning/test/golden-vector.test.ts` | `'the server engine reproduces the same committed golden vector'`         | `f95d38a1df2ec51b680fc50c202b6c2b29c5009e8378ffafc7b90853c0c57c33` | 2,783 |
| **Client** | `apps/web/src/workers/projection.worker.test.ts`        | `'the client worker reproduces the committed golden vector for its seed'` | `f95d38a1df2ec51b680fc50c202b6c2b29c5009e8378ffafc7b90853c0c57c33` | 2,783 |

**Identical.** Both computed independently — the server test rebuilds a full `MonteCarloJob`
(engine `'lognormal'`, `series: null`, `crypto: { holding: 0, … }`) and runs the actual server
kernel; the client test rebuilds the client's narrower `MonteCarloJob` (no `engine`/`series`/
`crypto` fields at all — the client kernel has no such concept, §2) and runs
`apps/web/src/workers/kernel/montecarlo.ts`'s `runMonteCarlo`. Neither test reads the other's
output; both compare against the fixture's own committed `expected.sha256`/`expected.bytesBase64`.
**Neither test alone proves the two engines agree — both passing does**, and the two are printed
side by side by both test bodies (`console.log('server sha256: …')` / `console.log('client
sha256: …')`) so a future drift shows both lines in the same run's output, not just a pass/fail.

A third check closes the "is this vacuous" gap directly: `'a different seed produces a different
digest'` in both files (`seed + 1n`) — asserts the digest actually moves, not just that two
constants happen to be equal.

### 1.1 First-try reproduction (nothing hand-tuned to make it pass)

The client kernel was **not written to match this fixture** — it was already on disk from the
killed session, before this fixture existed. The plan/job below (§4) was constructed independently
from the server's own default assumptions
(`packages/contexts/planning/data/assumptions.ts`), run once through the server engine, and only
then checked against the client kernel with a throwaway script
(`node <script importing apps/web/src/workers/kernel/montecarlo.ts>`, outside the repo). It matched
byte-for-byte on the **first attempt** — no adjustment to either kernel was needed. That is the
actual evidence that the killed session's port is correct, independent of anything this session
wrote afterward.

## 2. The scoped kernel — verified line by line against the server, not just asserted

Per this WP's brief ("decide whether apps/web may import `@ctx/planning`'s engine barrel"): checked
`apps/web/package.json` — it does **not** declare `@ctx/planning` as a dependency (only
`apps/api/package.json` does), so there is no `apps/web/node_modules/@ctx/planning` symlink for
pnpm to resolve. `scripts/eslint-boundaries.js`'s `app` layer itself has `allow: null`
("composition root: allowed to wire anything together") — the layer rule does not forbid the
import; the missing dependency does, and this WP's RULES forbid `package.json` edits. **Verdict:
port, not import** (confirmed, not re-decided — the killed session's `kernel/prng.ts` header
already reached this conclusion and this session found no reason to overturn it). §7 states the
seam for the orchestrator.

Every file under `apps/web/src/workers/kernel/` was diffed against its server counterpart
(`packages/contexts/planning/src/engine/{prng,glidepath,bootstrap,deterministic,montecarlo}.ts`):

| Client file        | Server file (diffed against)    | Diff after stripping comments/citations                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prng.ts`          | `prng.ts`                       | Identical for every function the client kernel uses (`mulLo64`, `splitMix64Word`, `seedStream`, `refill`, `nextDouble`, `nextNormal`); server-only functions (`nextWord`, `nextChiSquare2`, `nextIndex`, `CRYPTO_STREAM`) simply absent — nothing needed for lognormal-only, no-crypto |
| `glidepath.ts`     | `glidepath.ts`                  | Identical numeric constants and formulas (`AGE_BASED_RULE`, `TARGET_DATE_KNOTS`, `RISING_EQUITY_RULE`, `interpolate`); only citation/`source` fields dropped                                                                                                                           |
| `lognormal.ts`     | `bootstrap.ts` (lognormal half) | `cholesky`, `reorderCorrelation`, `drawLognormalYear`'s three-normal draw and the `factor[0]`/`factor[8]`/`factor[9]` indexing — identical; bootstrap/crypto code absent                                                                                                               |
| `deterministic.ts` | `deterministic.ts`              | `stepYear`'s arithmetic identical for the `constant_real` policy with `income = 0` (client never models Social Security/pension/other, so `need = spending` where server has `need = spending − income`; algebraically the same when income is always 0, confirmed by §1's byte match) |
| `montecarlo.ts`    | `montecarlo.ts`                 | `drawShocks`, `transformFor`, `fillMarket`, `simulate`'s per-year loop, `quantilesInPlace`, `serialiseResult`'s header/byte layout — identical for the no-crypto, lognormal-only, `constant_real` path                                                                                 |

This is what makes §1's byte match meaningful rather than circular: the port was checked against
the server's actual source, not only against one fixture.

**Scope cuts, from the kernel's own headers (unchanged from the killed session, confirmed
accurate):** lognormal engine only (no block bootstrap — §3 says why); no crypto sleeve; policy is
`constant_real` only (`stepYear` throws `UnsupportedPolicy` otherwise); no Social Security,
pension, or other income streams (`EnginePlan` has no such fields at all — a year's income is
always 0, not merely defaulted to 0).

## 3. The return series decision, and what "refining…" means under it

**Decision: the client uses the synthetic lognormal engine for every preview. It never reads or
bundles Shiller's historical series.**

Why: `packages/contexts/planning/data/returns/**` (the block bootstrap's monthly return series) is
fetched server-side with a pinned SHA-256 checksum and is not vendored into the repo (`wp4.5-
montecarlo.md` §6 — no licence for redistribution). Bundling it into `apps/web` would mean either
(a) shipping the same 1,847-month CSV to every browser (bundle size, and a second copy of licensed
data to keep in sync), or (b) the client fetching it from the server on demand, which reintroduces
a network dependency the whole point of the local worker is to avoid. Neither is this WP's call to
make unilaterally (§7). The lognormal engine needs no history — it is a closed-form parametric
model over the assumptions file's own expected-return/volatility numbers — so it is the only engine
a client-only kernel can honestly run.

**Consequence for "refining…".** Because both the 250-path drag preview and the 5,000-path
pointer-up run use the **same engine, same seed, and the same common-random-numbers construction**
(`drawShocks` seeds path _i_'s stream from `(seed, i)` alone, independent of the total path count —
`kernel/montecarlo.ts`'s own header), the 250-path sample is a strict _prefix_ of the 5,000-path
sample's shocks. "Refining…" is therefore not a different simulation or a different scenario — it
is **more samples of the exact same distribution**, so the percentile estimate tightens toward the
same underlying answer rather than jumping to an unrelated one. This is the same reasoning
`wp4.5-montecarlo.md` §2 invariant 2 relies on for common random numbers across levers; here it is
across path counts within one lever setting.

The seed itself: a fresh random 64-bit pattern is drawn once per `GoalSliders` mount
(`crypto.getRandomValues`, `GoalSliders.tsx#randomSeed64`) and reused for every drag and refine in
that mount — never regenerated mid-session, which is what makes "refining" a real refinement rather
than noise.

## 4. The plan behind the golden vector

A lognormal-engine job with no crypto and no Social Security/pension/other income — the exact
subset the client kernel models — built from the server's own default assumptions
(`data/assumptions.ts`'s `capitalMarket.usEquity`/`usAggregateBonds`/`inflation`/`correlation`,
copied verbatim, not hand-typed from memory):

| Field                                         | Value                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `startAge` → `retireAge` → `endAge`           | 55 → 65 → 90 (35 years: 10 accumulation, 25 decumulation)                                                                             |
| `wealth0` (TAXABLE/TAX_DEFERRED/ROTH/HSA)     | $200,000 / $150,000 / $50,000 / $10,000                                                                                               |
| `contribution0`                               | $10,000 / $8,000 / $4,000 / $1,000 per year                                                                                           |
| `glidepaths`                                  | one of each kind — `age_based`, `target_date`, `rising_equity`, `static(0.6)` — exercising every glidepath the client kernel supports |
| `contributionGrowth`                          | 2%/yr                                                                                                                                 |
| `spending`                                    | $40,000/yr real                                                                                                                       |
| `inflation` / `equityNominal` / `bondNominal` | 2.5% / 6.5% / 4.5% (`data/assumptions.ts` defaults)                                                                                   |
| `volatility`                                  | equity 17%, bond 6%, inflation 1.5% (`data/assumptions.ts` defaults)                                                                  |
| `taxDeferredRate`                             | 15%                                                                                                                                   |
| `policy`                                      | `constant_real`                                                                                                                       |
| `seed` / `paths`                              | `20260928` / 1,000                                                                                                                    |

**Why this plan, not a trivial one.** Spending was swept ($30k/$35k/$38k/$40k/…) against the actual
kernel until the outcome mix was balanced rather than degenerate — at $40,000 the run is
**509/1,000 paths (50.9%) successful**, median terminal wealth **$4,636** (barely above the
depletion floor — the plan sits right at its own edge), p90/p95 in the millions. A plan this evenly
split exercises the accumulation phase, the decumulation phase, a real median shortfall
(`failure.medianShortfallYears = 7`, `medianDepletionAge = 83`), and both flat-zero and
positive-and-growing percentile bands in the same fixture — a stronger byte-identity proof than an
all-succeed or all-fail plan would be, since every summary field (`failure`, `sequence`, every
level's band) carries real, non-degenerate numbers on both sides of the comparison.

## 5. What shipped

| File                                                          | Role                                                                                                           | Lines |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----- |
| `apps/web/src/workers/projection.worker.ts`                   | The Comlink-exposed worker: `warmUp()`, `run(job)` — bands only, `Float32Array`, transferred                   | 144   |
| `apps/web/src/workers/projection-client.ts`                   | Spins the worker up on mount, `requestIdleCallback` warm-up, `available` flag for the fallback                 | 77    |
| `apps/web/src/workers/projection.worker.test.ts`              | Golden vector client half + the "bands, never paths" shape test (§8 S2)                                        | 153   |
| `apps/web/src/features/plan/sliders/defaults.ts`              | Capital-market defaults, verbatim from `data/assumptions.ts` (§3's own reasoning for why inlined, not fetched) | 70    |
| `apps/web/src/features/plan/sliders/buildPreviewJob.ts`       | Baseline scenario + levers → `ProjectionWorkerJob`; the panel's stated scope cuts                              | 173   |
| `apps/web/src/features/plan/sliders/SliderField.tsx`          | Base UI `Slider` + editable number input, one lever                                                            | 104   |
| `apps/web/src/features/plan/sliders/GoalSliders.tsx`          | The panel: mechanics, fallback, cross-fade, status text                                                        | 276   |
| `apps/web/src/features/plan/PlanScreen.tsx` (edited)          | One import line + one mount line (`git diff` below), nothing else                                              | +2    |
| `apps/web/e2e/plan-sliders.spec.ts`                           | The three named exit tests + axe both themes                                                                   | 189   |
| `apps/web/e2e/support/mock-plan-sliders.ts`                   | This WP's own mock module (new file, not a shared edit)                                                        | 202   |
| `packages/contexts/planning/test/fixtures/golden-vector.json` | The one committed golden vector                                                                                | 71    |
| `packages/contexts/planning/test/golden-vector.test.ts`       | Golden vector server half                                                                                      | 142   |
| `docs/evidence/phase-4/wp4.11-client-worker.md`               | This document                                                                                                  | —     |

`git diff apps/web/src/features/plan/PlanScreen.tsx` in full:

```diff
+import { GoalSliders } from './sliders/GoalSliders.tsx';
 …
+      <GoalSliders scenario={baseline} />
+
       <section aria-label="Life events" className="flex flex-col gap-3">
```

One import line, one blank line, one mount line. Nothing else in that file touched.

## 6. Test-location decisions, stated (the WP 4.5 precedent)

**`packages/contexts/planning/test/golden-vector.test.ts`**, not the dispatch's literal
`test/engine/golden-vector.test.ts`. The `planning` vitest project's `include` is
`['src/**/*.test.ts', 'test/*.test.ts']` (non-recursive) — `test/engine/*.test.ts` is not covered
(the same gap `wp4.5-montecarlo.md` §"Test location" already recorded and put to the orchestrator).
This WP's own instructions name `test/golden-vector.test.ts` directly and confirm the `test/*.test.ts`
include covers it — followed as given, consistent with the precedent rather than re-litigating it.

**The fixture is read by a relative JSON import, not `node:fs`.** Tried first as `node:fs` +
`node:crypto` (mirroring the server test) and reverted: `apps/web/tsconfig.app.json` deliberately
carries no Node ambient types (`types: ["vite/client"]` only — a browser-code project), so
`node:fs`/`node:crypto`/`Buffer` fail `tsc -b --noEmit` under it even though `vitest` itself would
run them fine (it's Node underneath). A plain JSON module import needs no ambient Node types at
all, and `crypto.subtle`/`btoa` (Web Crypto, a real browser API, also present as a Node global)
replace `node:crypto`/`Buffer` — the same restriction `./projection.worker.ts` itself lives under,
so the test now uses exactly the API surface the worker is allowed to use. The **server** test hit
a related but different wall: `no-restricted-imports` forbids `node:crypto` outside
`@core/secretbox` (`scripts/eslint-boundaries.js`'s cryptography chokepoint), and
`packages/contexts/planning/package.json` does not declare `@core/secretbox` as a dependency — so
it also uses the global `crypto.subtle` (a Node 19+ global, no import at all, so the restriction
does not apply), for the matching reason.

## 7. For the orchestrator

1. **A shared `@core/projection-kernel` package** (restated from the killed session's own note,
   confirmed still the right shape after this session's line-by-line diff, §2): hoist
   `prng.ts`/`glidepath.ts`/the lognormal half of `bootstrap.ts`/the `constant_real` subset of
   `deterministic.ts`/the no-crypto subset of `montecarlo.ts` out of both `@ctx/planning` and
   `apps/web` into one package both depend on. This WP's contribution: the diff table in §2 is a
   ready-made checklist of exactly which functions are candidates (identical) versus which stay
   server-only (bootstrap, crypto, guardrails, Social Security, pension). Until that lands, `apps/
web/src/workers/kernel/**` is a deliberate, documented duplication, and §1's golden vector is
   the control that catches drift between the two copies.
2. **Bootstrap-engine previews are an open product decision, not built here** (§3). If a future WP
   wants the client preview to use the same historical-bootstrap engine the server defaults to
   (rather than lognormal), the series either needs a licence-cleared bundle decision or a
   server-sent-once-and-cached design — this WP does not resolve which.
3. **`GoalSliders`'s "starting balance" has no server field to seed from** (`buildPreviewJob.ts`'s
   own header) — a scenario's `profile` carries levers and policy, not current account balances
   (those live in net worth/investments, outside this WP's ownership). It is the panel's own
   fourth slider, defaulted rather than derived. If a future WP wires real current balances into
   `BaselineScenario`, this is the seam to replace.
4. **`apps/web/playwright.config.ts`'s `chromium` `testMatch` does not include `plan-sliders`** —
   confirmed still missing at the time of writing (`RULES` for this WP explicitly forbid editing
   that file and say to run the spec by path instead). §9 records that running by path against the
   _real_ config reports "No tests found" (Playwright's per-project `testMatch` filters which files
   a project even considers; an explicit CLI file argument does not add a file outside it — confirmed
   empirically, not assumed) and documents the verification-only workaround used instead. Whoever
   adds the `plan-sliders` alternative to the regex should re-run `pnpm exec playwright test e2e/
plan-sliders.spec.ts --project chromium` afterward to confirm it then finds and passes the suite
   directly.
5. **A real, reproducible Base UI `Slider` + Playwright bug, worth a shared fix.** §9.2 documents it
   in full: a slider below the viewport fold silently drops every `page.mouse.down()`/`move()`
   gesture (`document.elementFromPoint` returns `null` for an off-screen coordinate, and Chromium's
   CDP-driven pointer dispatch appears to do the same internally) with **no error, no console
   warning** — the drag simply does nothing. `scrollIntoViewIfNeeded()` before computing the
   bounding box fixes it. This is not specific to this WP's slider; any future Base UI (or native
   `input[type=range]`) drag test in this repo below the fold will hit the same silent failure.
   Worth a shared Playwright helper (`dragSlider(locator, …)` that scrolls first) rather than every
   spec rediscovering it.

## 8. Sabotage

Each control broken once in the real production file, the named test re-run for real, red
observed, the file restored by hand, and SHA-256 compared before and after (all three matched).

| #   | Sabotage                                                                                          | File                   | Test driven                                                                                                         | Red?               | Observed                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | A kernel constant changed: `GAMMA_HI` (SplitMix64 seed constant) `0x9e3779b9` → `0x9e3779b8`      | `kernel/prng.ts`       | `projection.worker.test.ts` → `'the client worker reproduces the committed golden vector…'`                         | **red, first try** | digest `77f1f63d…` vs expected `f95d38a1…`; `successCount` 520 vs 509. **The server-half test stayed green** in the same run — the pair is directional: this sabotage only touches the client's copy, and only the client half caught it. |
| S2  | `toBands` returns a per-path-shaped array instead of bands: `new Float32Array(paths * years)`     | `projection.worker.ts` | `projection.worker.test.ts` → `'the worker's own reply carries bands sized levels × years, never a per-path array'` | **red, first try** | `expected 35000 to be 245` (`paths × years` = 1000 × 35 = 35,000 vs. `levels × years` = 7 × 35 = 245)                                                                                                                                     |
| S3  | The `!available` branch removed from `statusText` — the "Worker unavailable" reason never renders | `GoalSliders.tsx`      | `plan-sliders.spec.ts` → `'with Worker unavailable the server fallback renders and says so'`                        | **red, first try** | `expect(status).toContainText('unavailable')` — received `"Preview loading…"` instead                                                                                                                                                     |

**SHA-256, before every sabotage and after every restore (all three matched):**

```
3f1bf0dea5eb24f5dc817954544d8230118f1cae3ebee623fea645278a985f08  kernel/prng.ts
7d190fa7ba27c55c2e67b700c7fb876c4a553898c84ecc934933209e1a7e9f7e  projection.worker.ts
0b299261450e5fd41f87b9a09fdb1ba53e2a66ed3a78023c825c702a8ae3dcb3  sliders/GoalSliders.tsx
```

After the final restore, the full suite was re-run clean (§9's "Final re-run" is that re-run).

The dispatch's minimum ask — "a kernel constant changed (golden red); paths sent instead of bands
(red); the fallback removed (red)" — is S1/S2/S3 above, in that order.

## 9. Verification

### 9.1 The network trace during a drag, and frame timing

Measured directly (a throwaway timing harness against the real app, outside the repo — not
committed; the committed `plan-sliders.spec.ts` asserts the same zero-requests property without
printing latencies). One drag: mouse down on the "Monthly savings" thumb, a 12-step move to the
right, a pause, release, wait for the refine to finish:

```
=== TIMING (ms since drag mouse.move start) ===
pointer down:                                    93.0
12-step move dispatch complete:                 358.5
250-path preview visible (median changed):      365.3
mouse up (commit fired):                        378.7
5,000-path refine complete ("5,000" shown):     569.3
refine duration after release:                  190.6
=== NETWORK REQUESTS DURING DRAG WINDOW ===
count: 0
```

**Zero network requests** for the whole window (request log reset immediately before the drag,
covering pointerdown through the refine completing). **The 250-path preview lands ~7 ms after the
last synthesized pointermove** — well inside a frame budget, consistent with 05 §5.7's "~20–40 ms"
estimate for a Monte Carlo run this size in a worker. **The 5,000-path refine takes ~191 ms** after
release — comparable, at a fifth the path count and roughly the same year count, to
`wp4.5-montecarlo.md` §5's server-side measurement of ~590 ms wall for 10,000 paths × 40 years on
one core (a Node `worker_thread`, not a browser `Worker` — the two are not directly comparable
machines, but the same order of magnitude is the sanity check that matters here).

### 9.2 The Playwright quirk this WP had to work around, in full

`apps/web/playwright.config.ts`'s `chromium` project's `testMatch` regex does not include
`plan-sliders` (this WP's RULES confirm that entry is the orchestrator's and say to run the spec
"by path" instead). Tried literally: `pnpm exec playwright test e2e/plan-sliders.spec.ts --project
chromium` against the **real, committed** config → `Error: No tests found.` Confirmed this is not a
typo or a missing `--project` flag: Playwright's per-project `testMatch` filters which files a
project even considers before any CLI file argument is applied; a file the regex excludes is not
addressable by path at all under that config, with or without `--project`.

**Workaround, verification-only:** a config file outside the repo (`/tmp/pw-plan-sliders.config.ts`
— not committed, listed here for reproducibility only), identical `chromium` project shape,
`testMatch` widened to this one file, same `webServer` command (`vite dev --port 5183
--strictPort`) the real config uses. This runs the real app against the real spec; nothing about
the application or the test itself differs, only which project descriptor Playwright reads. The
committed `apps/web/playwright.config.ts` was never touched (`git status` below confirms; its
`chromium` `testMatch` and every other line is exactly as this session found it).

**A second, genuine bug found and fixed along the way**, worth recording because it cost real time
to diagnose and will bite the next person to write a slider drag test in this repo: the sliders
panel sits below the fold at the default 1280×720 viewport. `thumb.boundingBox()` correctly reports
its real (off-screen) page coordinates, but `page.mouse.down()`/`move()` at those coordinates
**silently did nothing** — no thrown error, no console warning, `aria-valuenow` simply never
changed. Diagnosis (the full trace, in order): confirmed a real `pointerdown` DOM event fired
(`window`-level listener count went to 1); confirmed Base UI's own `Slider.Control` `onPointerDown`
handler _never ran_ (patched debug `console.log` calls directly into the served
`node_modules/.vite/deps/@base-ui-components_react_slider.js` bundle — confirmed the patched code
was actually served and loaded, and it still never logged); confirmed a **synthetic**
`element.dispatchEvent(new PointerEvent(...))` at the same coordinates _did_ reach the handler and
correctly updated the value; the deciding check was `document.elementFromPoint(x, y)` at the exact
drag coordinates returning **`null`** — the canonical symptom of an off-screen point. Fix:
`thumb.scrollIntoViewIfNeeded()` before reading any bounding box (`plan-sliders.spec.ts`'s
`beginDraggingMonthlySavings` helper). §7 item 5 flags this for a shared Playwright helper.

### 9.3 The CSP, before and after — byte-identical

No CSP-relevant file was touched by this WP: `git status` shows zero changes to
`docker/Caddyfile`, `apps/web/vite.config.ts`, or `apps/web/scripts/check-csp.ts`. The worker is a
real, same-origin, hashed bundle file — confirmed in the production build:

```
$ pnpm --filter @app/web build
…
dist/assets/projection.worker-lpwGMv5G.js   (a real file, not a Blob URL)
OK — 1 HTML file(s) under dist/ have no inline <script> or style=.
```

— which `worker-src 'self' blob:'` (already present, for the PWA service worker) already covers;
no `worker-src` widening needed, matching the dispatch's own prediction ("No new CSP directive; the
worker is same-origin and bundled, not a blob URL"). Before = after, byte-identical, because
nothing changed.

### 9.4 Every number on screen traced to its source (the WP 4.10 §7 convention)

| Screen element                                                      | Source                                                                                                                             | Client computation                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slider values (retirement age, spending, savings, starting balance) | User-set lever state, seeded from `BaselineScenario.profile` where present (retirement age, planned spending, contributions total) | Formatting only (`Intl.NumberFormat`); defaults documented in `buildPreviewJob.ts` where no server field exists (starting balance)                                                                                                                                         |
| "Median at age X: $Y — Z% of simulated paths succeed"               | `ProjectionBands` from the **client kernel's own local run** — not a server field at all                                           | This is the one screen in the app that legitimately computes a dollar figure client-side: it is a local simulation's own output, explicitly labelled "a quick, local what-if preview" and never presented as the saved plan's number (D20; `GoalSliders.tsx`'s own header) |
| Fallback text ("Your saved plan: Z% of simulated paths succeed")    | `RunPlanProjectionResponse.run.successProbability`, the same server field `PlanScreen.tsx`'s own headline already uses             | Formatting only                                                                                                                                                                                                                                                            |

The one place this screen computes a number itself is the worker's own preview — which is the
entire point of WP 4.11, disclosed as exactly that everywhere it appears on screen.

### 9.5 Component-command results

```
$ pnpm --filter @app/web exec tsc -b --noEmit
(clean, exit 0)

$ pnpm exec tsc -b --noEmit
(clean, whole repo, exit 0)

$ pnpm exec eslint apps/web/src/workers apps/web/src/features/plan apps/web/e2e/plan-sliders.spec.ts packages/contexts/planning/test/golden-vector.test.ts
(clean, exit 0)

$ pnpm exec eslint apps/web/e2e/support/mock-plan-sliders.ts
(clean, exit 0)

$ pnpm exec prettier --check <every file this WP touched, incl. the .json fixture>
All matched files use Prettier code style!

$ pnpm --filter @app/web exec vitest run src/workers src/features/plan
 Test Files  6 passed (6)
      Tests  28 passed (28)

$ pnpm exec vitest run --project planning packages/contexts/planning/test/golden-vector.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ pnpm --filter @app/web build
✓ built in ~10s
dist/assets/projection.worker-lpwGMv5G.js   (real file, bundled)
OK — dist/sw.js's precache manifest excludes the dev kitchen-sink chunk.
OK — 1 HTML file(s) under dist/ have no inline <script> or style=.

$ pnpm exec playwright test e2e/plan-sliders.spec.ts --project chromium   # the real, committed config
Error: No tests found.                                                    # expected — §9.2

$ pnpm exec playwright test --config <verification-only config, §9.2> --project chromium
  ✓ dragging a slider reshapes the bands without a network request
  ✓ releasing the slider refines to full fidelity and the headline stops saying refining
  ✓ with Worker unavailable the server fallback renders and says so
  ✓ axe reports no violations on the goal sliders panel, in light and in dark
  4 passed
```

_The final re-run after this document was written is appended below, with no further edits to this
document in between._

### 9.6 Final re-run

```
$ pnpm --filter @app/web exec tsc -b --noEmit
(exit 0)

$ pnpm exec tsc -b --noEmit
(exit 0, whole repo)

$ pnpm exec eslint apps/web/src/workers apps/web/src/features/plan apps/web/e2e/plan-sliders.spec.ts apps/web/e2e/support/mock-plan-sliders.ts packages/contexts/planning/test/golden-vector.test.ts
(exit 0)

$ pnpm exec prettier --check apps/web/src/workers apps/web/src/features/plan/sliders apps/web/src/features/plan/PlanScreen.tsx apps/web/e2e/plan-sliders.spec.ts apps/web/e2e/support/mock-plan-sliders.ts packages/contexts/planning/test/golden-vector.test.ts packages/contexts/planning/test/fixtures/golden-vector.json
All matched files use Prettier code style!

$ pnpm --filter @app/web exec vitest run src/workers src/features/plan
 Test Files  6 passed (6)
      Tests  28 passed (28)

$ pnpm exec vitest run --project planning packages/contexts/planning/test/golden-vector.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ pnpm --filter @app/web build
✓ built (exit 0)

$ pnpm exec playwright test --config <verification-only config> --project chromium
  4 passed

$ git diff --cached --name-only
(empty)
```
