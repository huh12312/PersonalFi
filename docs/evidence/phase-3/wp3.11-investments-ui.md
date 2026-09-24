<!-- SPDX-License-Identifier: MIT -->

# WP 3.11 — the investments UI: holdings, allocation, drift, per-account detail, performance

`docs/plan/03-phase-3-dispatch.md` §3, WP 3.11. Wave C, alongside WP 3.12 (`features/networth`,
`features/market-data`, `features/crypto`) and a backend agent in `packages/**`. Format follows
Phase 2's UI evidence (`wp2.9-budget-ui.md`, `wp2.11-inbox-ui.md`): what landed, every on-screen
number traced to the API field it came from, the axe run, screenshots in both themes, and the
checks verbatim.

---

## 1. What landed

| File                                                           | What                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/web/src/routes/_app.investments.tsx`                     | replaces the 16-line `PlaceholderRoute`; `validateSearch` over the whole view state                   |
| `apps/web/src/features/investments/search.ts`                  | the URL-state schema — tab, account, dimension, basis, drift targets, performance `from`              |
| `apps/web/src/features/investments/api.ts`                     | TanStack Query hooks over the **generated** client, plus the step-up-gated basis-method election      |
| `apps/web/src/features/investments/labels.ts`                  | wire enum → words; the one presentation-only `Ratio`/`Points` string→number conversion                |
| `apps/web/src/features/investments/InvestmentsScreen.tsx`      | the screen: header stats, basis selector, four tabs                                                   |
| `apps/web/src/features/investments/HoldingsTable.tsx`          | holdings aggregated by ticker, each row expanding into the accounts that hold it                      |
| `apps/web/src/features/investments/AccountPositionsPanel.tsx`  | per-account detail: positions, lots, `basisSource`, `unavailable`, the election control               |
| `apps/web/src/features/investments/BasisMethodControl.tsx`     | the mutual-fund-only, sticky, step-up-gated election                                                  |
| `apps/web/src/features/investments/AllocationDonut.tsx`        | the **visx** donut — eight CVD-safe hues each paired with its own SVG texture, plus a labelled legend |
| `apps/web/src/features/investments/AllocationPanel.tsx`        | dimension toggle, the donut, `% unclassified` **beside it**, and the excluded list                    |
| `apps/web/src/features/investments/DriftPanel.tsx`             | the drawn ±`bandPoints` band, the row table, and the suppress-not-invent empty state                  |
| `apps/web/src/features/investments/PerformancePanel.tsx`       | TWR and MWR labelled, in a rates group; the dollar gain in a separate section below a rule            |
| `apps/web/src/features/investments/StaleBadge.tsx`             | `STALE` as a word + a glyph + the observation date, driven by `PriceQuote.staleness`                  |
| `apps/web/src/features/investments/UnavailableValue.tsx`       | the single place `unavailable` is rendered; no branch in it can print a zero for an unknown           |
| `apps/web/src/features/investments/fixtures.ts`                | test-only wire fixtures transcribed from the committed spreadsheet fixture                            |
| `apps/web/src/features/investments/InvestmentsScreen.test.tsx` | 12 unit tests                                                                                         |
| `apps/web/src/features/investments/AllocationDonut.test.tsx`   | 3 unit tests, one of which reads the committed CSV off disk                                           |
| `apps/web/e2e/support/mock-investments.ts`                     | this work package's own Playwright network mock (never `mock-api.ts`)                                 |
| `apps/web/e2e/investments.spec.ts`                             | the four exit tests verbatim + 4 more; 15 axe runs                                                    |
| `docs/evidence/phase-3/screenshots/wp3.11-*.png`               | 12 screenshots, six screens × two themes                                                              |

**No file outside this list was modified.** Specifically: no `e2e/support/mock-api.ts`, no
`e2e/app-walkthrough.spec.ts`, no `apps/web/playwright.config.ts`, nothing in
`features/{networth,market-data,crypto}`, nothing in `packages/**` or `apps/api`.

**Coded against the generated client.** `pnpm --filter @app/web gen` was run first and every request
goes through `src/api/generated/@tanstack/react-query.gen.ts`
(`listHoldingsOptions`, `listAccountHoldingsOptions`, `getAllocationOptions`, `getDriftOptions`,
`getPerformanceOptions`) or `Sdk.__registry.get().electBasisMethod`. There is no hand-written URL
string anywhere in `features/investments/**`. `gen` produced **no diff** against the committed
`src/api/generated/` — WP 3.9 had already regenerated it at `e45fa1a`.

---

## 2. Every number on screen, traced to its API field

No client-side money arithmetic. The only computation this feature performs on a value is
`Number(decimalString)` for a `Ratio` or a `Points` string, and that result is used for two
presentation purposes only — `Intl.NumberFormat`'s percent output and the geometry of an arc or a
bar. **No `Money` ever passes through it**: every dollar figure is handed to `<Money>` as the
server's `{ minor, currency }` wire shape and formatted by `@core/kernel`'s exact decimal path
(`src/lib/money.ts`). The dispatch's risk table permits `toNumberApproximate` "for presentation";
this is that, and nothing more. `labels.ts`'s `ratioToNumber`/`pointsToNumber` are the only two
call sites.

### 2.1 Header

| On screen                           | Component / testid                                        | API field                                                  |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `$176,499.60`                       | `StatTile "Portfolio value"` / `portfolio-total`          | `GET /holdings` → `total`                                  |
| `1.7%`                              | `StatTile "% unclassified"` / `holdings-unclassified-pct` | `GET /holdings` → `unclassifiedPct` (Ratio `0.0174504645`) |
| `10`                                | `StatTile "Securities held"`                              | `GET /holdings` → `holdings.length`                        |
| `As of 2026-09-23`                  | header subtitle                                           | `GET /holdings` → `asOf`                                   |
| `USD`                               | header subtitle                                           | `GET /holdings` → `currency`                               |
| "stale prices excluded (as of now)" | header subtitle                                           | the `basis` URL param, echoed by `GET /holdings` → `basis` |

### 2.2 Holdings table (`GET /holdings` → `holdings[]`)

| Column       | API field                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Security     | `symbol`, falling back to `name`, then `securityId`                                                                  |
| sub-line     | `name`, `assetClass` (labelled), `accountCount`                                                                      |
| Quantity     | `quantity` (decimal string, printed verbatim — never reformatted)                                                    |
| Price        | `price.close` + `price.currency`, verbatim decimal string                                                            |
| STALE badge  | `price.staleness === 'STALE'`; the title is `price.priceDate`                                                        |
| Market value | `marketValue` (`Money`), or `unavailable` when `null`                                                                |
| Cost basis   | `costBasis` (`Money`), or `unavailable` when `null`                                                                  |
| Unrealized   | `unrealized.gain` when `unrealized.status === 'available'`; otherwise the word `unavailable` and `unrealized.reason` |
| Weight       | `weight` (Ratio), or `unavailable` when `null`                                                                       |

Per-account expansion rows come from `GET /accounts/{id}/holdings` → `positions[]`:
`quantity`, `marketValue`, `costBasis`, `costBasisSource`, `price.staleness`. The account _name_ is
`GET /accounts` → `name` via `useAccountsLookup`.

### 2.3 Allocation (`GET /investments/allocation`)

| On screen                                                          | API field                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| donut arc angle                                                    | `by{AssetClass,Region,Sector}.slices[].weight` (Ratio → arc geometry) |
| legend amount                                                      | `slices[].value` (`Money`)                                            |
| legend percentage                                                  | `slices[].weight`                                                     |
| donut centre "Total"                                               | `total` (`Money`, compact)                                            |
| **`% unclassified`**                                               | `unclassifiedPct` — required on the wire, rendered unconditionally    |
| "$3,080.00 of $176,499.60 has no asset class on record"            | `unclassifiedValue`, `total`                                          |
| "Basis: last known · cash included · fund-level look-through only" | `basis`, `includesCash`, `lookThrough`                                |
| "Left out of this total"                                           | `excluded[]` → `symbol`, `reason`                                     |

### 2.4 Drift (`GET /investments/drift`)

| On screen                                                              | API field                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| whether anything renders at all                                        | `targetsSet`                                    |
| "Rebalancing band: ±5.0000 percentage points" and the shaded rectangle | `bandPoints`                                    |
| Target / Actual columns                                                | `rows[].targetWeight`, `rows[].actualWeight`    |
| Gap column and the bar length                                          | `rows[].gapPoints`                              |
| "inside band" / "outside band"                                         | `rows[].insideBand`                             |
| "Add $29,598.96" / "Reduce by …"                                       | `rows[].proposal.direction`, `.amount`          |
| the noise notice                                                       | `noisy`, `proposalsWithheld`, `unclassifiedPct` |

### 2.5 Performance (`GET /investments/performance`)

| On screen                                    | API field                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `+11.4%` under "Time-weighted return (TWR)"  | `timeWeighted.periodReturn`                                                                    |
| Annualized / Method / Span                   | `timeWeighted.annualized` (or `annualizationWithheld`), `.method`, `.approximate`, `.spanDays` |
| warnings                                     | `timeWeighted.warnings[].detail`                                                               |
| `+9.3%` under "Money-weighted return (MWR)"  | `moneyWeighted.periodReturn` (or the `unavailable` branch's `reason`)                          |
| Solver / Span                                | `moneyWeighted.solver`, `.spanDays`                                                            |
| `+$18,242.10` under "Unrealized dollar gain" | `dollarGain.gain`                                                                              |
| Market value / Cost basis                    | `dollarGain.marketValue`, `dollarGain.costBasis`                                               |
| window subtitle                              | `from`, `to`, `currency`                                                                       |
| unvalued-transfer notice                     | `unvaluedTransfers`                                                                            |

### 2.6 Per-account detail (`GET /accounts/{id}/holdings`)

Position header: `symbol`/`name`/`assetClass`/`quantity`/`price.close`/`price.staleness`.
Definition list: `marketValue`, `costBasis`, `costBasisSource`, `unrealized`,
`unrealized.warning`. Lot table: `lots[].openDate`, `.quantityRemaining`, `.basis`,
`.basisSource`, `.longTerm`, `.ageDays`, `.basisWarning`. Election control:
`positions[].basisMethod` for the current value and the sticky lock;
`GET /holdings` → `securityType` for the mutual-fund eligibility test.

---

## 3. The spreadsheet check, reproduced from the browser

`packages/contexts/investments/test/fixtures/allocation-expected.csv` (WP 3.3, computed with an
independent Python `decimal` implementation — `wp3.3-analytics.md` §4) is the ground truth.
`e2e/support/mock-investments.ts` serves that portfolio; `e2e/investments.spec.ts` **reads the CSV
off disk at run time** and compares it against what Chromium painted. Nothing in the spec re-types
a number.

`'the allocation donut totals match the committed spreadsheet fixture'` asserts three things:

1. The header total equals the CSV's `last_known,portfolio,TOTAL` row — **$176,499.60**.
2. Every `last_known,asset_class` row is on screen at its `expected_value`, and the legend has
   exactly as many entries as the CSV has rows — so a missing slice fails as loudly as a wrong one.
3. **The check itself, from the rendered pixels**: the eight legend amounts are read back out of
   the DOM as text, parsed to minor units, summed, and compared both to the total the page shows
   and to the CSV's total. All three agree at `17649960` minor.

| CSV row (`last_known,asset_class`) | `expected_value` | Rendered in the legend |
| ---------------------------------- | ---------------- | ---------------------- |
| `US_EQUITY`                        | 76300.80         | `$76,300.80`           |
| `US_BOND`                          | 34632.00         | `$34,632.00`           |
| `CRYPTO`                           | 19870.60         | `$19,870.60`           |
| `INTL_DEV_EQUITY`                  | 19055.38         | `$19,055.38`           |
| `CASH`                             | 12500.00         | `$12,500.00`           |
| `REAL_ESTATE`                      | 5539.80          | `$5,539.80`            |
| `EM_EQUITY`                        | 5521.02          | `$5,521.02`            |
| `UNCLASSIFIED`                     | 3080.00          | `$3,080.00`            |
| **`portfolio,TOTAL`**              | **176499.60**    | **`$176,499.60`**      |

`unclassifiedPct` for that block is `0.0174504645` and renders as **1.7%**, beside the donut.

**What this does and does not prove.** The mock is authored from the same CSV, so this is not an
independent re-derivation of the arithmetic — WP 3.3's own tests are. What it proves is the part
that is this work package's: the number the API returns reaches the screen **unchanged** — no
rounding drift through the formatter, no client-side re-summing, no slice silently dropped, and the
rendered slices still add up to the rendered total. A regression where the UI recomputed a weight,
or formatted `1250000` minor as `$1,250,000.00`, fails this test.

---

## 4. The four exit tests, verbatim

`apps/web/e2e/investments.spec.ts`, names exactly as `docs/plan/03-phase-3-dispatch.md` §3 gives
them.

| Test                                                                    | What it pins                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'the allocation donut totals match the committed spreadsheet fixture'` | §3 above.                                                                                                                                                                                                                                                                                                                                                                                             |
| `'a holding with unknown basis renders "unavailable" and not "$0.00"'`  | BTC's `costBasis` is `null` and its `unrealized` is `{ status: 'unavailable', gain: null, reason: 'basis_unknown' }`. The aggregated row shows `unavailable (cost basis unknown)`; the lot behind it shows `unavailable` with `basisSource: unknown` and its `basisWarning`. The test then asserts `$0.00` appears **nowhere** in the whole BTC position panel, not merely in the two cells it names. |
| `'a stale price is visibly labeled'`                                    | `OLDCO`'s `price.staleness === 'STALE'` renders a `STALE` badge with a clock glyph and the accessible/`title` text `Price last observed 2026-09-11`. The test also asserts a FRESH row (`VTI`) has **no** badge, so the badge carries information rather than decorating every row.                                                                                                                   |
| `'drift renders nothing when no target is set'`                         | With no `?target`, `GET /investments/drift` answers `targetsSet: false, rows: []`; the panel renders only the "Set a target allocation" empty state. `drift-band-chart`, `drift-band`, `drift-table` and every `drift-row-*` are asserted at **count 0**. The test then applies a target and watches the band appear, so the absence is the app suppressing rather than the app failing to load.      |

Four more in the same file: the dark-mode axe control, the both-themes axe sweep, the
TWR/MWR/dollar-gain separation (including a geometric check that the dollar-gain block starts below
the bottom of the rate blocks), and the step-up-gated election with the API's own refusal.

---

## 5. The dispatch's named UI rules, and where each one is enforced

| Rule (dispatch §3, WP 3.11)                                    | Where                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| holdings aggregated by ticker with per-account expansion       | `HoldingsTable.tsx`; the expansion is assembled from `GET /accounts/{id}/holdings` because the aggregated row carries `accountCount` but not the breakdown and no "by security _and_ account" route exists                                                                                                           |
| **visx** donut                                                 | `AllocationDonut.tsx`, `@visx/shape`'s `Pie` — self-hosted, already a dependency                                                                                                                                                                                                                                     |
| `% unclassified` beside it, never hidden                       | `AllocationPanel.tsx`'s `<aside data-testid="allocation-unclassified">`, rendered before the donut's data is inspected and at `0%` as readily as at `40%`                                                                                                                                                            |
| drift's 5-point band **drawn**                                 | `DriftPanel.tsx` draws a dashed, shaded `<rect>` from `scale(-bandPoints)` to `scale(+bandPoints)` with a `±5.0000 pts` label; every bar is measured against it                                                                                                                                                      |
| "set a target" empty state that suppresses rather than invents | `DriftPanel.tsx`'s `!targetsSet` branch returns the empty state and nothing else. No equal-weight fallback, no 60/40 default, no current-allocation-as-target. The one sample target is behind an explicitly labelled button the user has to press, and it writes to the URL                                         |
| lots with basis source, `unavailable` never `$0.00`            | `AccountPositionsPanel.tsx` + `UnavailableValue.tsx`. `basisSource` is per **lot**, not per position, because that is the granularity at which it varies                                                                                                                                                             |
| STALE badges                                                   | `StaleBadge.tsx`, driven by the `staleness` **field** — nothing compares dates client-side                                                                                                                                                                                                                           |
| TWR/MWR labeled, never in the same row as a dollar gain        | `PerformancePanel.tsx`: the two rates share one `role="group"`; the dollar gain is a separate `<section>` after an `<hr>`. Asserted in unit tests (`$` absent from both rate blocks, `%` absent from the gain block) and in e2e (bounding boxes)                                                                     |
| CVD-safe colour **plus** a pattern or label                    | The donut's eight `--series-*` hues are each rendered through their own SVG `<pattern>` texture, and every slice is labelled with its name and percentage in the legend. Drift uses the teal/vermilion pair plus a hatch on the outside-band bars **plus** the literal words "inside band"/"outside band" in the row |
| self-hosted, no CSP widening                                   | §7 below                                                                                                                                                                                                                                                                                                             |

---

## 6. Accessibility

`e2e/investments.spec.ts` runs the real axe-core bundle (`e2e/support/axe.ts`'s `injectAxe`,
scoped to `#app-content`) **15 times**: seven screens × two themes, plus one unfiltered control run
on the Dashboard.

Screens covered per theme: holdings (with a ticker expanded), per-account detail with lots and the
election control, allocation by asset class, allocation by sector, the drift empty state, drift with
targets, and performance.

### 6.1 One finding, and it is not this screen's

The dark-theme run finds exactly one violation, on a **shared file this work package does not
own**: `src/app/shell/Sidebar.tsx`'s active nav link,
`active && 'bg-accent-wash text-accent-text'`. In dark mode `--accent-text` (`#3987e5`) on
`--accent-wash` (`#132537`) measures **4.28:1** against WCAG AA's 4.5:1.

```
- [serious] color-contrast
  .bg-accent-wash > span :: <span class="">Investments</span>
  Element has insufficient color contrast of 4.28 (foreground #3987e5, background #132537,
  font size 11.3pt (15px), font weight normal). Expected contrast ratio of 4.5:1
```

It fires on whichever nav item is current, on every route — the other e2e suites never saw it
because they run in the default (light/system) theme. The spec proves the attribution rather than
asserting it: `'the one dark-mode axe violation is the shared sidebar, not this screen'` runs an
**unfiltered** axe pass on the **Dashboard** — a screen this work package did not touch — in dark
mode, asserts the only violation id is `color-contrast`, asserts every failing node's selector
contains `bg-accent-wash`, and then shows that the Dashboard is clean once that one node is
excluded. The investments screens use the same exclusion (`exclude: [['a[aria-current="page"]']]`)
and **nothing else** — `color-contrast` stays enabled on every element this work package renders.

**For the orchestrator:** this is a one-token fix in a shared file (`--accent-text` in the dark
block of `src/styles/theme.css`, or the active-link treatment in `Sidebar.tsx`). It is adjacent to
Phase 1's still-open `--status-warning`/`--status-serious` row, which §2 of the Phase 3 dispatch
defers to Phase 9; this one is a _different_ token pair and is worth ruling on rather than
inheriting.

### 6.2 One violation found and fixed during the build

The first dark-theme run also failed on **this work package's own** markup: the per-account links
inside a ticker's expansion row used `text-accent-text` on `--bg-subtle`, measuring **4.33:1** in
dark mode. Fixed in `HoldingsTable.tsx` by dropping the accent hue entirely — the links are
`text-text-primary` with an underline, so "this is a link" is carried by the underline rather than
by colour, which is the same rule the CVD requirement states. Re-run: clean.

### 6.3 Other accessibility decisions

- The donut `<svg>` is `aria-hidden`, and the legend beside it is a real `<ul>` carrying every
  label, amount and percentage. A `role="img"` donut would make the numbers unreachable; this way
  assistive technology reads the data, not a shape. (Same reasoning as
  `features/reports/charts/CategoryMonthBarChart.tsx`'s own header.)
- The drift band chart is likewise `aria-hidden`, with a full `<table>` carrying the same rows and
  a `<caption>` naming the band.
- Every holdings row's expander is a real `<button>` with `aria-expanded`; the expanded group is a
  `<tr>` in the same `<table>`.
- The allocation dimension switch is a `radiogroup` with three `radio`s, not three buttons whose
  selected state is only a background colour.
- The `STALE` badge's accessible name includes the observation date, so a screen reader hears why.
- `<Money>` is used everywhere, so every amount ships its screen-reader spoken form.

---

## 7. CSP: unchanged, and no new directive

`pnpm --filter @app/web build` runs `scripts/check-csp.ts` as its last step. It passes with **no
change to any CSP directive**, and no `docker/Caddyfile` edit.

Nothing in this work package loads anything off-origin:

- visx (`@visx/shape`, `@visx/group`, `@visx/scale`) was already a dependency and is bundled from
  `node_modules` — D20's "self-hosted, no CDNs".
- No `<img src="http…">`, no web font, no iframe, no `eval`, no inline `<script>`.
- The SVG `<pattern>` fills are same-document fragment references (`url(#alloc-…)`), which are not
  a fetch and are not governed by `img-src`/`connect-src`.
- Every request goes to `/api/...` through the generated client.

Build output is in §9.

---

## 8. Screenshots

`docs/evidence/phase-3/screenshots/`, captured by the e2e suite itself (so they are regenerated by
`playwright test`, never hand-taken and never stale against the code):

| Screen                                                                                  | Light                             | Dark                             |
| --------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| Holdings, with `VTI` expanded into two accounts                                         | `wp3.11-holdings-light.png`       | `wp3.11-holdings-dark.png`       |
| Per-account detail (Taxable brokerage): positions, lots, basis source, election control | `wp3.11-account-detail-light.png` | `wp3.11-account-detail-dark.png` |
| Allocation donut by asset class, `% unclassified` beside it                             | `wp3.11-allocation-light.png`     | `wp3.11-allocation-dark.png`     |
| Drift, no target set — the suppress-not-invent empty state                              | `wp3.11-drift-empty-light.png`    | `wp3.11-drift-empty-dark.png`    |
| Drift with a target set — the ±5-point band drawn                                       | `wp3.11-drift-light.png`          | `wp3.11-drift-dark.png`          |
| Performance — TWR/MWR above the rule, dollar gain below it                              | `wp3.11-performance-light.png`    | `wp3.11-performance-dark.png`    |

---

## 9. Checks

### `pnpm --filter @app/web gen`

```
$ openapi-ts
@hey-api/openapi-ts v0.99.0
[Job 1] ✓ ./src/api/generated · 5 files · 1s
```

`git status --short apps/web/src/api/generated` → empty. WP 3.9 had already regenerated it at
`e45fa1a`; this work package re-ran `gen` before writing a line and confirmed there was no drift to
absorb.

### `pnpm --filter @app/web typecheck` — **one error, and it is not this work package's**

```
$ pnpm run gen && tsc -b --noEmit
src/features/networth/series.ts(28,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
  Type 'undefined' is not assignable to type 'string'.
```

`src/features/networth/**` is **WP 3.12's**, explicitly named in this work package's rules as a
directory it may not touch, and it is being written concurrently in this same wave. An earlier run
also showed `src/features/networth/NetWorthChart.tsx(9,34): Cannot find module './NetWorthFullView.tsx'`,
which cleared between runs — the signature of a live edit, the same pattern `wp3.9-routes.md` §9
recorded against WP 3.7.

Every file this work package owns typechecks, verified by filtering the same compiler run:

```
$ pnpm exec tsc -b --noEmit 2>&1 | grep -E 'features/investments|routes/_app.investments'
(no output)
```

Two real defects in this work package's own files were found by `tsc` and fixed before this was
recorded:

- `AllocationDonut.test.tsx` originally read the committed CSV with `node:fs`. `apps/web`'s
  `tsconfig.app.json` sets `"types": ["vite/client"]` and deliberately excludes `@types/node`, so
  that did not compile. Switched to Vite's `?raw` import, which is `vite/client`'s own declared
  module and needs no new type and no new dependency.
- An unused `Money` import left in `HoldingsTable.tsx` after the accent-contrast fix — caught by
  eslint, below.

### `pnpm --filter @app/web test`

```
 Test Files  51 passed (51)
      Tests  291 passed (291)
   Duration  36.43s
```

This work package's share, run alone:

```
$ pnpm --filter @app/web exec vitest run src/features/investments
 Test Files  2 passed (2)
      Tests  15 passed (15)
```

Twelve in `InvestmentsScreen.test.tsx` (the header figures; ticker aggregation and per-account
expansion; `unavailable` not `$0.00` on a holding and on a lot; the STALE badge; the donut legend
and the `% unclassified` beside it; the dimension switch going through URL state; drift suppressed
with no target; the ±5-point band and the inside/outside labels once targets exist; TWR/MWR/dollar
gain in three blocks; `AVERAGE_COST` withheld for an ETF and the API's refusal rendered verbatim;
the sticky lock) and three in `AllocationDonut.test.tsx` (every slice at its CSV value; one arc per
slice each filled with a `<pattern>`; every slice labelled in the legend).

### `pnpm --filter @app/web build` — **blocked on the same WP 3.12 file, so each step was run

individually**

```
$ pnpm --filter @app/web build
$ pnpm run gen && tsc -b --noEmit && vite build && node scripts/strip-sourcemaps.ts && node scripts/check-sw-precache.ts && node scripts/check-csp.ts
src/features/networth/series.ts(28,3): error TS2322: …
```

The script stops at its `tsc -b` step, which is the error above. The remaining four steps — the
ones that actually produce and inspect the artifact, **including the CSP check** — were run
directly and all pass:

```
$ pnpm exec vite build
✓ 68 modules transformed.
✓ built in 181ms
PWA v1.3.0 · mode injectManifest · precache 103 entries (1572.22 KiB)

$ node scripts/strip-sourcemaps.ts
Removed 92 source map(s) from dist.

$ node scripts/check-sw-precache.ts
OK — dist/sw.js's precache manifest excludes the dev kitchen-sink chunk.

$ node scripts/check-csp.ts
OK — 1 HTML file(s) under dist/ have no inline <script> or style=.
```

**CSP: no new directive, and no `docker/Caddyfile` edit.**
`git status --short docker/ packages/contracts/ apps/web/package.json` is empty — the policy source
and the dependency list are byte-identical to `ecaf9e0`. §7 lists why nothing in this work package
could need one.

### `pnpm exec eslint …`

```
$ pnpm exec eslint apps/web/src/features/investments apps/web/src/routes/_app.investments.tsx \
    apps/web/e2e/investments.spec.ts apps/web/e2e/support/mock-investments.ts
(no output — clean)
```

One error on the first run (`'Money' is defined but never used` in `HoldingsTable.tsx`, left over
from the contrast fix), fixed.

### `prettier --check`

```
$ pnpm exec prettier --check apps/web/src/features/investments apps/web/src/routes/_app.investments.tsx \
    apps/web/e2e/investments.spec.ts apps/web/e2e/support/mock-investments.ts \
    docs/evidence/phase-3/wp3.11-investments-ui.md
Checking formatting...
All matched files use Prettier code style!
```

### `playwright test e2e/investments.spec.ts`

**`apps/web/playwright.config.ts`'s `chromium` project has a hand-maintained `testMatch` regex that
does not list `investments`,** so the command in the brief finds nothing:

```
$ pnpm --filter @app/web exec playwright test e2e/investments.spec.ts --list
Error: No tests found.
```

That file is **shared and not this work package's to edit** (see §10 finding 1). The suite was
therefore run against an out-of-tree config that reuses the same dev server and selects only this
spec, leaving `playwright.config.ts` untouched:

```
$ pnpm exec playwright test --config /tmp/wp311-playwright/investments.config.ts

Running 8 tests using 1 worker
  ✓ 1 the allocation donut totals match the committed spreadsheet fixture (7.8s)
  ✓ 2 a holding with unknown basis renders "unavailable" and not "$0.00" (6.4s)
  ✓ 3 a stale price is visibly labeled (6.3s)
  ✓ 4 drift renders nothing when no target is set (6.7s)
  ✓ 5 the one dark-mode axe violation is the shared sidebar, not this screen (3.9s)
  ✓ 6 every investments screen is axe clean in both themes (18.8s)
  ✓ 7 TWR and MWR are labeled and never share a row with a dollar gain (3.3s)
  ✓ 8 the basis-method election is step-up gated and reflects the API refusal (3.5s)

  8 passed (1.1m)
```

Headless Chromium was present; no browser download was needed. **15 axe runs** in total (7 screens ×
2 themes in test 6, plus the unfiltered control run in test 5).

One transient failure is worth recording rather than hiding: an intermediate run failed test 4 with
`waiting for getByText('Set a target allocation')` because Prettier had just rewritten the source
files and the Vite dev server was mid-HMR when the suite started. Two consecutive clean runs
followed with no code change. It is a dev-server timing artefact of editing during a run, not a
flake in the assertion.

---

## 10. Findings and seams

1. **`apps/web/playwright.config.ts`'s `chromium` `testMatch` needs `investments` added** — a
   one-token edit for the orchestrator:

   ```
   testMatch: /(smoke|app-walkthrough|inbox|splits|rule-from-transaction|category-filter|
                notification-settings|recurring-insights|budget|investments)\.spec\.ts/,
   ```

   Until then the spec is invisible to `pnpm --filter @app/web test:e2e` and to CI. **WP 3.12 has
   the identical problem** for `networth.spec.ts` and `market-data.spec.ts`, so this is one edit
   covering three names, and it belongs with the wave-boundary batch in dispatch §4 rather than
   with either UI agent. The config's header prose ("Ten independent suites") also wants updating.

2. **No `mock-api.ts` edit is needed.** `e2e/support/mock-investments.ts` is self-contained, the
   `mock-budget.ts` / `mock-recurring-insights.ts` shape. Nothing in this work package requires a
   change to the shared mock or to `app-walkthrough.spec.ts`. If a future wave wants the
   walkthrough to reach the investments screen, the routes it would need are the eight this module
   already implements.

3. **A dark-mode contrast defect in a shared file** — `Sidebar.tsx`'s active nav link,
   `--accent-text` on `--accent-wash`, 4.28:1. §6.1 has the measurement, the reproduction on an
   untouched screen, and the suggested fix. Not this work package's file.

4. **There is no `allocation_targets` table**, so drift targets live in the URL
   (`?target=US_EQUITY:0.6`, repeated) — `wp3.9-routes.md` §8 item 1. The empty state suppresses
   rather than inventing, and the one sample target set is behind a button labelled as a sample.
   When a migration adds the table, the "set a target" empty state becomes a real editor and
   `search.ts`'s `target` param can stay as an override.

5. **The per-account expansion costs one request per investment account.** `GET /holdings` gives
   `accountCount` but not the breakdown, and there is no "by security _and_ account" route, so
   `useAccountsHoldingsQueries` fans out over `GET /accounts/{id}/holdings` — the same responses the
   detail panel needs, cached under the same keys, so opening an account afterwards is free. For a
   portfolio with many investment accounts this is the first thing to revisit; a
   `?groupBy=security,account` option on `/holdings` would collapse it to one call.

6. **Which accounts are "investment" accounts is decided client-side** by
   `account.type === 'investment' || 'crypto'` from `GET /accounts`. An account of another type that
   nonetheless holds securities would not get an account chip (its positions still appear in the
   aggregated table, and its expansion row would show the "still loading" line rather than a link).
   A `hasHoldings` flag on `GET /accounts`, or an `accounts[]` array on the aggregated holding,
   would remove the guess.

7. **`GET /investments/performance` needs a `from`**, and this screen defaults it to one year before
   today. That default is computed from an injectable `today` (`search.ts`'s
   `defaultPerformanceFrom`) so a test and a screenshot pin it, and it is overridable through
   `?from=`. There is no window picker yet — deliberately out of scope for this work package, and a
   small addition once somebody decides the preset list.

8. **A dollar gain over a historical window is computed over today's positions**, which is the
   route's own documented behaviour (`wp3.9-routes.md` §8 item 2). The performance panel says so on
   screen rather than leaving it implied by the number.
