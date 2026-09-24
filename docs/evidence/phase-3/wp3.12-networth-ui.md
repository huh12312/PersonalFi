<!-- SPDX-License-Identifier: MIT -->

# WP 3.12 — the net-worth UI: chart, market-data settings, crypto connect

`docs/plan/03-phase-3-dispatch.md` §3, WP 3.12. Wave D, alongside WP 3.10 (advisor
catalog v2, `packages/**`) and concurrent with a backend agent finishing carry-over
work in `apps/api` and `packages/contexts/insights`. Format follows WP 3.11's UI
evidence (`wp3.11-investments-ui.md`): what landed, every attribution surface traced
to its ToS clause, the axe run, screenshots in both themes, and the checks verbatim.

This work package was built by a prior agent instance that was killed by a provider
rate limit immediately after finishing eslint/prettier, before the e2e suites had
been run to green. This document reports on finishing that work: verifying the build
against the dispatch brief, fixing what was found broken, and recording the checks.

---

## 1. What landed

| File                                                             | What                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/charts/NetWorthAreaChart.tsx`                      | extended (not duplicated) with `sealed`/`source` on each point, driving sealed-vs-live line styling, interpolated-day markers, and a `color`/`seriesLabel` pair so a caller can stack one instance per currency |
| `apps/web/src/features/networth/search.ts`                       | the `netWorthRange` URL-state schema (`p30d/p90d/p1y/all`) and the `{from,to}` window it maps to                                                                                                                |
| `apps/web/src/features/networth/series.ts`                       | `groupByCurrency` — the one-series-per-currency mechanism — plus `interpolatedCount`/`latestValued`                                                                                                             |
| `apps/web/src/features/networth/api.ts`                          | `useNetWorthSeriesQuery` over the generated client                                                                                                                                                              |
| `apps/web/src/features/networth/NetWorthChart.tsx`               | the dashboard's compact chart + "View full history" dialog trigger                                                                                                                                              |
| `apps/web/src/features/networth/NetWorthFullView.tsx`            | the full view: range control, refresh, multi-currency notice, one chart per currency, the interpolated-day count, and a recent-day status table                                                                 |
| `apps/web/src/features/market-data/Attribution.tsx`              | `ProviderAttribution` — the licence-mandated attribution block, exported for WP 3.11 to reuse                                                                                                                   |
| `apps/web/src/features/market-data/MarketDataSettingsScreen.tsx` | source priority (step-up gated), key presence (never a value), budgets, test fetch, attribution per provider                                                                                                    |
| `apps/web/src/features/market-data/api.ts`                       | TanStack Query hooks over the generated client                                                                                                                                                                  |
| `apps/web/src/features/crypto/CoinbaseKeyForm.tsx`               | the CDP key form — sealed on submit, never echoed                                                                                                                                                               |
| `apps/web/src/features/crypto/WalletWatchOnlyForm.tsx`           | watch-only BTC/ETH entry, carrying the never-ask-for-a-private-key line                                                                                                                                         |
| `apps/web/src/features/crypto/CryptoConnectScreen.tsx`           | hosts both forms, gated on `GET /connectors`                                                                                                                                                                    |
| `apps/web/src/routes/_app.index.tsx`                             | `validateSearch` adds `netWorthRange`; renders `NetWorthDashboardSection`                                                                                                                                       |
| `apps/web/src/routes/_app.settings.tsx`                          | adds the "Market data" and "Crypto" tabs, additively                                                                                                                                                            |
| `apps/web/e2e/support/mock-networth.ts`                          | this work package's own Playwright network mock (never `mock-api.ts`)                                                                                                                                           |
| `apps/web/e2e/networth.spec.ts`                                  | the two `networth` exit tests verbatim + 2 more; screenshots                                                                                                                                                    |
| `apps/web/e2e/market-data.spec.ts`                               | the two `market-data` exit tests verbatim + 2 more; screenshots                                                                                                                                                 |
| `docs/evidence/phase-3/screenshots/wp3.12-*.png`                 | 8 screenshots, four screens × two themes                                                                                                                                                                        |

**No file outside this list was modified**, except the fixes recorded in §2 below (all
inside the same owned directories). Specifically: no `e2e/support/mock-api.ts`, no
`e2e/app-walkthrough.spec.ts`, no `apps/web/playwright.config.ts` (already carried the
`networth`/`market-data` entries in its `testMatch` before this pass started), nothing
in `features/investments`, nothing in `packages/**` or `apps/api`.

Every request goes through the generated client (`src/api/generated/`); `pnpm run gen`
produced no diff against the committed tree.

---

## 2. Gaps found and fixed this pass

The prior agent's code was structurally sound — every dispatch rule (sealed/live
styling, interpolated labels, per-currency series, attribution placement, the
never-ask line, key-never-echoed handling) was already implemented correctly in the
application code. What was broken was almost entirely in the **two spec files' own
test infrastructure**, plus two genuine small defects in the application:

| #   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                          | Fix                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `expectAxeCleanExceptSharedSidebar`'s axe invocation passed `exclude` as axe-core's _options_ argument. axe-core only reads `include`/`exclude` off the _context_ argument, so nothing was ever excluded and the known shared-sidebar `color-contrast` finding failed every dark-mode run.                                                                                                                                                                                                                                                                                                                | both spec files                | Matched WP 3.11's proven pattern: `window.axe.run({ include: [['#app-content']], exclude: [['a[aria-current="page"]']] })`                                                                                                                                                |
| 2   | **Genuine app defect**, dark-mode `color-contrast`: the "Key configured"/"Registered" badges used `bg-status-good/10 text-status-good`, measuring 4.46:1 — under WCAG AA's 4.5:1 by a hair.                                                                                                                                                                                                                                                                                                                                                                                                               | `MarketDataSettingsScreen.tsx` | Switched to the existing `Badge` component's `good` variant (`bg-bg-subtle text-status-good`) — the exact pairing `theme.css`'s own comment records as tuned to clear 4.5:1 in both themes (the `app-walkthrough.spec.ts` finding that produced `--status-good: #0c7a0c`) |
| 3   | **Genuine app defect**: the net-worth full view's `DialogContent` had no `max-h`/`overflow-y-auto`. Two stacked 280px charts plus the range/legend/table content routinely exceed one viewport; the popup is `fixed` + `top-1/2 -translate-y-1/2` with no scroll container, so a too-tall popup was pushed off-screen with nothing able to scroll it back — not merely visually clipped, but genuinely unreachable. This is what produced a 30 s timeout waiting for the `Refresh` click's network response and a 30 s timeout clicking the "1 year" range button ("element is outside of the viewport"). | `NetWorthChart.tsx`            | Added `max-h-[85vh] overflow-y-auto` to that one `DialogContent` instance                                                                                                                                                                                                 |
| 4   | Strict-mode locator violations (test-only): `getByTestId('net-worth-series-label-USD')` matched both the dashboard's compact chart (which legitimately also shows per-currency labels — "never a silently-summed line" applies there too) and the open dialog's full view                                                                                                                                                                                                                                                                                                                                 | `networth.spec.ts`             | Scoped the assertion to the open dialog: `page.getByRole('dialog', { name: 'Net worth over time' })`                                                                                                                                                                      |
| 5   | Strict-mode locator violation (test-only): `getByText('Key configured')` substring-matched "No key configured" too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `market-data.spec.ts`          | `{ exact: true }`                                                                                                                                                                                                                                                         |
| 6   | Strict-mode locator violation (test-only): two priority ladders ("crypto", "equity") each render a "Save priority" button; only the one the test's own reorder made dirty is enabled                                                                                                                                                                                                                                                                                                                                                                                                                      | `market-data.spec.ts`          | `getByRole('button', { name: 'Save priority', disabled: false })`                                                                                                                                                                                                         |
| 7   | Transition-timing flake: an axe color-contrast scan immediately after `setTheme()` could sample a genuinely mid-transition frame — `theme.css`'s `--dur-fast` (160 ms) animates `color`/`background-color` on any `transition-colors` element (the `Button` primitive among them) whenever a referenced custom property's value changes. Confirmed by a direct `getComputedStyle` probe of the affected button 300 ms after the flip: white text on the dark surface, correct.                                                                                                                            | both spec files                | Added a 250 ms wait in `setTheme()` after the attribute flip — a synchronization fix; the assertion itself (zero violations) is unchanged                                                                                                                                 |
| 8   | `react-hooks/exhaustive-deps` warning: `points = seriesQuery.data?.points ?? []` minted a fresh array reference every render, defeating the `useMemo` that depended on it                                                                                                                                                                                                                                                                                                                                                                                                                                 | `NetWorthFullView.tsx`         | Wrapped `points` itself in a `useMemo` keyed on `seriesQuery.data`                                                                                                                                                                                                        |

None of these fixes loosened an assertion — #1 and #7 made assertions that were
silently never running actually run; #2 and #3 are real product fixes; #4–6 correct
locators that were ambiguous by construction, not by weakening what they check; #8 is
a lint-clean fix with no behavioral change.

`e2e/networth.spec.ts` and `e2e/market-data.spec.ts` (8 tests total) were run three
times after these fixes, clean every time. `e2e/investments.spec.ts` (WP 3.11, not
touched) re-verified green (8/8) to confirm no regression from the shared-file
inspection this pass did.

---

## 3. The four exit tests, verbatim

`docs/plan/03-phase-3-dispatch.md` §3, WP 3.12:

| Test                                                                            | File                  | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'a past date on the chart is unchanged after a re-sync'`                       | `networth.spec.ts`    | `net_worth_daily`'s seal semantics on screen. The mock's day 5 is unsealed and its value is derived from a call counter that increments on every `GET /net-worth/series`; clicking "Refresh" is a real re-fetch (asserted via `page.waitForResponse`), and the sealed day (`2026-09-01`) stays byte-identical while the live day's figure changes — proving this is a working seal, not a cached response that could not tell a broken seal apart from a route that never re-fetches at all |
| `'two currencies render as two series and never one sum'`                       | `networth.spec.ts`    | The mock prices day 3 in CAD, everything else in USD. Both `net-worth-series-label-USD` and `-CAD` render, the "never summed into one total" notice is visible, and the forbidden blended figures (`$9,000.00`, `900,000.00` — USD + CAD minor units added together) appear nowhere on the page                                                                                                                                                                                             |
| `'the CoinGecko attribution is present on every screen showing a crypto price'` | `market-data.spec.ts` | Two screens, both with a **real assertion**, not a snapshot: the provider-list attribution block (`data-testid="attribution-coingecko"`, exact text "Data provided by CoinGecko", a link to `https://www.coingecko.com`, one logo glyph) present before any price is fetched; then a live test fetch against CoinGecko, and the **second** attribution instance travelling with the returned quote                                                                                          |
| `'the settings screen never renders an API key value'`                          | `market-data.spec.ts` | `SYNTHETIC_KEY_MARKER` (`pfi-synthetic-tiingo-key-do-not-use-9f3c1a77`) is planted as `debugApiKey` on the Tiingo provider row in the mock — "a defensive-in-depth field a buggy backend might one day add." The screen never renders it (checked via `body.innerText()`, not a single selector), and stays absent after every mutation this screen can make: a priority reorder + save, and a test fetch                                                                                   |

Two more per spec file: the axe sweep in both themes (§5), and the never-ask-for-a-
private-key/view-only-warning check on the crypto tab.

---

## 4. Attribution, traced to its ToS clause

`wp3.4-market-data.md` §4 is the source of record for the clauses; this work package's
job is to put them on screen, verbatim, wherever a crypto price is shown, and this
table is the trace from that obligation to the rendered surface.

| Screen                                                                      | Component / testid                                                               | Text rendered                                                                                                | ToS clause (quoted, `wp3.4-market-data.md` §4)                                                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings → Market data → provider list (CoinGecko row)                      | `Attribution.tsx`'s `ProviderAttribution`, `data-testid="attribution-coingecko"` | "Data provided by CoinGecko" + logo glyph + hyperlink to `https://www.coingecko.com`                         | _"Attribution required even on free tier — must display 'Data provided by CoinGecko' with logo + hyperlink"_; _"a hard license condition, not a courtesy"_                                                 |
| Settings → Market data → test-fetch result (when the provider is CoinGecko) | same component, second instance on the page                                      | identical text + link, attached to the returned quote                                                        | same clause — the obligation "travels with the data" (carried on the API's `attribution` field on every `PriceQuote`), not bolted on by the screen that happens to render it                               |
| Settings → Market data → provider list (FRED row)                           | same component                                                                   | "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis." | _"Requires displaying: 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.'"_ — rendered as the exact sentence, ® included, never a paraphrase     |
| Settings → Market data → provider list (Tiingo row)                         | same component                                                                   | nothing (renders `null`; `attribution.required` is `false`)                                                  | _"your own personal use… may not display or share the data with another person or organization"_ — the obligation is that the data does not leave, so no badge is the correct rendering, not a missing one |
| Settings → Crypto tab                                                       | n/a (no price rendered on this screen)                                           | —                                                                                                            | Correctly out of scope: this screen shows the Coinbase/wallet connect forms, never a price. The dispatch's rule is "wherever those prices appear"                                                          |

`AllocationDonut`/`HoldingsTable` (WP 3.11's screens, which can show a CoinGecko-priced
crypto position) import this same `ProviderAttribution` component rather than a second
implementation — see `Attribution.tsx`'s own header comment. This work package owns
`features/market-data/**`, not `features/investments/**`, so it could only make the
component importable, not wire it into WP 3.11's screens itself; whether WP 3.11 did so
is outside this document's scope to verify.

Every field the component reads (`text`, `linkUrl`, `logoRequired`, `clause`,
`required`) comes from the API's `Attribution` shape — nothing is hand-typed into the
component, so a ToS-string change is a one-file change in `@ctx/integrations` (WP 3.4),
not a hunt through every screen that renders a price.

---

## 5. The per-currency mechanism

`docs/plan/03-phase-3-dispatch.md` §3: _"one series per currency until an FX rate
exists, never a silently-summed line."_

`features/networth/series.ts#groupByCurrency` is the one function this rule runs
through:

1. Collects every currency any point in the window carries (skipping `null` days).
2. For each currency, builds a full-length series where every point either carries
   that currency's value (converted to a chart-local minor-unit number, presentation
   only, never sent back to the API or compared) or `null` — never a value borrowed
   from another currency, converted at par, or summed with another currency's.
3. `NetWorthChart.tsx` (compact) and `NetWorthFullView.tsx` (full) both render one
   `NetWorthAreaChart` instance per entry this function returns, each with its own
   colour (`colorForIndex`, cycling through existing theme tokens) and, once there is
   more than one currency, its own `seriesLabel` pill (`data-testid="net-worth-series-
label-{currency}"`, asserted directly by the exit test).

`series.test.ts` pins the negative property explicitly: _"never sums two currencies
into one line — each series carries the other currency's days as null."_ The e2e test
adds the pixel-level check: the forbidden blended figure (`100000 + 800000` minor
units summed across mismatched currencies) is asserted absent from the whole page,
not merely absent from one element.

`baseCurrency` on the wire response can legitimately vary day to day (a planning
context comment `series.ts` cites explains why); this mechanism is what keeps that
honest on screen instead of averaging over it.

---

## 6. Secret handling: sealed, never echoed, and how the tests prove it

### 6.1 The CDP key form

`CoinbaseKeyForm.tsx`: the private-key `textarea`'s state is cleared **the instant
the request body is built** — before the request is sent, not in a `finally` — so it
cannot linger through a slow round trip, a retry, or a re-render. Obscured by default
(`-webkit-text-security: disc`, the same technique `Money.tsx` uses for privacy mode)
with an explicit "Show"/"Hide" toggle, never `autoComplete`.

Proof, `CoinbaseKeyForm.test.tsx`: after a successful submit, the textarea's own
`.value` is asserted `''`, **and** `document.body.textContent` is asserted to not
contain the typed key at all — not merely that one field is empty, but that the value
does not appear anywhere on the rendered page. The API's own refusal message (never a
paraphrase) is what reaches the user on failure; the pasted value is never in it.

### 6.2 The watch-only wallet form

`WalletWatchOnlyForm.tsx` carries the dispatch's required line verbatim: **"We will
never ask for a private key or a seed phrase"** — and adds the reason it is safe to
promise: "this connector has no way to sign a transaction even if one were pasted
here." `market-data.spec.ts`'s `'the crypto tab carries the never-ask-for-a-private-
key line and the view-only warning'` asserts that exact text and the `can_view`
scope language are both visible.

`WalletWatchOnlyForm.test.tsx` pins the refusal path: a pasted seed phrase is rejected
by the connector's own guard, and the error surfaced to the user names the _kind_ of
thing it saw (`bip39_mnemonic_shaped`) without ever echoing the pasted value.

### 6.3 Market-data settings: never a key value

`GetMarketDataSettingsResponse`'s wire shape has no field a key value could travel in
— `ProviderRow` in `MarketDataSettingsScreen.tsx` names every field it reads
explicitly (`provider`, `keyPresent`, `registered`, `capabilities`, `budget`,
`attribution`) rather than spreading a raw object, so an unexpected extra field on the
wire has no path onto the screen.

`e2e/support/mock-networth.ts` plants `SYNTHETIC_KEY_MARKER` — a synthetic,
key-shaped-but-never-real string — as `debugApiKey` on the Tiingo provider row,
specifically to check this property against an actual leak candidate rather than
merely against a field name the real API happens not to have. `'the settings screen
never renders an API key value'` asserts the marker is absent from the whole page
(`body.innerText()`) on first render **and again** after a priority save and a test
fetch, so the property holds across every mutation this screen can make, not only on
initial load. `MarketDataSettingsScreen.test.tsx`'s first test makes the same
assertion at the component level.

---

## 7. The URL-state round trip

`features/networth/search.ts#netWorthSearchSchema` adds one field,
`netWorthRange: 'p30d' | 'p90d' | 'p1y' | 'all'`, to `_app.index.tsx`'s
`validateSearch` — the same `validateSearch` + `Route.useSearch()`/`Route.useNavigate()`
shape `_app.transactions.tsx` already uses.

`'the range control round-trips through the URL and survives a reload'`: clicking
"1 year" in the full view navigates with `replace: true` to
`?netWorthRange=p1y`; a full page reload (not a client-side navigation) is asserted to
land back on the Dashboard, and reopening the full view shows the "1 year" button with
`aria-pressed="true"` — the range came from the address bar on a cold reload, not from
component state that a reload would have discarded.

---

## 8. Accessibility

Both spec files run the real axe-core bundle (`e2e/support/axe.ts`'s `injectAxe`,
scoped to `#app-content`, with the one shared, not-owned-by-this-work-package defect
excluded via axe's own `context.exclude` — §2 item 1 above) across:

- **`networth.spec.ts`**: the dashboard's compact net-worth chart, and the full view
  dialog — both themes (4 scans).
- **`market-data.spec.ts`**: the Market data settings tab, and the Crypto tab — both
  themes (4 scans).

8 scans total, **zero unexpected violations** after the fixes in §2. The one excluded
finding (`Sidebar.tsx`'s active nav link, `--accent-text` on `--accent-wash`, 4.28:1 in
dark mode) is the same shared-shell defect WP 3.11 first found and recorded, not owned
by this work package, reproduced here because it fires on every authenticated screen's
active nav item.

One violation found and fixed **during this pass**, not excluded: `color-contrast` on
`MarketDataSettingsScreen.tsx`'s own "Key configured"/"Registered" badges (§2 item 2).

---

## 9. CSP: unchanged, and no new directive

`pnpm run build` runs `scripts/check-csp.ts` as its last step:

```
$ pnpm exec vite build
✓ built in 8.40s
PWA v1.3.0 · mode injectManifest · precache 103 entries (1572.05 KiB)

$ node scripts/check-sw-precache.ts
OK — dist/sw.js's precache manifest excludes the dev kitchen-sink chunk.

$ node scripts/check-csp.ts
OK — 1 HTML file(s) under dist/ have no inline <script> or style=.
```

Nothing in this work package loads anything off-origin: the "logo" beside CoinGecko's
attribution is `lucide-react`'s `Coins` glyph (already a dependency, already bundled),
not CoinGecko's own trademarked mark — fetching that from CoinGecko's host would need
a new `img-src` entry, and D26 says no new directive, so that trade was never taken.
Every request goes through `/api/...` via the generated client. `git status --short
docker/ packages/contracts/ apps/web/package.json` is empty for this pass.

---

## 10. Screenshots

`docs/evidence/phase-3/screenshots/`, captured by the e2e suites themselves
(`shoot()` helpers in both spec files) so they are regenerated by `playwright test`,
never hand-taken and never stale against the code:

| Screen                                                                                                       | Light                                   | Dark                                   |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------- |
| Dashboard, compact net-worth chart                                                                           | `wp3.12-dashboard-chart-light.png`      | `wp3.12-dashboard-chart-dark.png`      |
| Net-worth full view: range control, multi-currency notice, sealed/live/interpolated legend, recent-day table | `wp3.12-full-view-light.png`            | `wp3.12-full-view-dark.png`            |
| Settings → Market data: provider list with attribution, priority ladders, test fetch                         | `wp3.12-market-data-settings-light.png` | `wp3.12-market-data-settings-dark.png` |
| Settings → Crypto: Coinbase key form, watch-only wallet form, never-ask line                                 | `wp3.12-crypto-tab-light.png`           | `wp3.12-crypto-tab-dark.png`           |

---

## 11. Checks

### `pnpm run gen`

```
$ openapi-ts
[Job 1] ✓ ./src/api/generated · 5 files · 857ms
```

`git status --short apps/web/src/api/generated` → empty.

### `pnpm run typecheck`

```
$ pnpm run gen && tsc -b --noEmit
(no errors)
```

Clean across the whole project — no `features/networth` defect left over from the
concurrent WP 3.11 build this time (both work packages are done).

### `pnpm test` (full Vitest suite)

```
 Test Files  51 passed (51)
      Tests  291 passed (291)
```

This work package's own share, run alone:

```
$ pnpm exec vitest run src/features/networth src/features/market-data src/features/crypto src/charts
 Test Files  7 passed (7)
      Tests  34 passed (34)
```

11 in `series.test.ts` (per-currency grouping, gap-vs-zero, sealed/source pass-through,
colour cycling, interpolated counting, window math for all four ranges), 7 in
`NetWorthFullView.test.tsx` (per-currency labels, single-currency suppression of the
notice, interpolated count, sealed-vs-live distinction in the table, correction
reasons, range-change callback, a real refetch on Refresh), 3 in `Attribution.test.tsx`
(CoinGecko, FRED verbatim including ®, and the no-badge case), 4 in
`MarketDataSettingsScreen.test.tsx` (key-never-a-value, attribution placement,
step-up-gated priority save, step-up-gated test fetch), 3 in `CoinbaseKeyForm.test.tsx`
(the warning, the clear-on-submit + never-echoed proof, the verbatim API refusal), 4 in
`WalletWatchOnlyForm.test.tsx` (the never-ask line, BTC submit shape, ETH field
switching, the seed-phrase refusal without echoing), 2 in `CryptoConnectScreen.test.tsx`
(both forms shown when registered, an honest "not available" message otherwise).

### `pnpm run build`

```
$ vite build
✓ built in 8.40s
$ node scripts/strip-sourcemaps.ts
Removed 92 source map(s) from dist.
$ node scripts/check-sw-precache.ts
OK
$ node scripts/check-csp.ts
OK — 1 HTML file(s) under dist/ have no inline <script> or style=.
```

### `pnpm exec eslint …`

```
$ pnpm exec eslint src/features/networth src/features/market-data src/features/crypto \
    src/charts/NetWorthAreaChart.tsx src/routes/_app.index.tsx src/routes/_app.settings.tsx \
    e2e/networth.spec.ts e2e/market-data.spec.ts e2e/support/mock-networth.ts
(no output — clean)
```

One `react-hooks/exhaustive-deps` warning found and fixed during this pass (§2 item 8).

### `pnpm exec prettier --check …`

```
Checking formatting...
All matched files use Prettier code style!
```

One file (`e2e/networth.spec.ts`) needed `--write` after this pass's edits; reformatted
and reverified clean.

### `pnpm exec playwright test e2e/networth.spec.ts e2e/market-data.spec.ts`

```
Running 8 tests using 4 workers
  ✓ the CoinGecko attribution is present on every screen showing a crypto price
  ✓ the crypto tab carries the never-ask-for-a-private-key line and the view-only warning
  ✓ the settings screen never renders an API key value
  ✓ a past date on the chart is unchanged after a re-sync
  ✓ two currencies render as two series and never one sum
  ✓ the market-data settings and crypto tabs are axe clean in both themes
  ✓ the range control round-trips through the URL and survives a reload
  ✓ the net-worth screens are axe clean in both themes

  8 passed (31.4s)
```

Run three times after the §2 fixes landed, clean every time — no flake margin left in
by design (the transition-timing fix in §2 item 7 removes the one source of flake this
pass found, rather than papering over it with a retry).

`e2e/investments.spec.ts` (WP 3.11, untouched by this pass) re-verified separately:
8/8 passed, confirming no regression from this pass's shared-file inspection.

---

## 12. Findings and seams

1. **The Coinbase/watch-only forms are a second, self-contained entry point**
   (`_app.settings.tsx`'s "Crypto" tab) rather than wired into
   `features/connections/AddConnectionDialog.tsx`'s `credential_form` branch, which is
   the more natural home. That file is `features/connections/**`, outside this work
   package's ownership (`features/{networth,market-data,crypto}/**` only). A future
   work package can close this seam by wiring `CoinbaseKeyForm`/`WalletWatchOnlyForm`
   into that dialog's existing branch — `CryptoConnectScreen.tsx`'s own header comment
   records this.

2. **`ProviderAttribution` is exported for WP 3.11 to import** into
   `features/investments/**` (a holding or an allocation slice can be CoinGecko-priced
   crypto), but this work package cannot verify from its own files whether WP 3.11
   actually did so — that is WP 3.11's evidence to state, not this document's.

3. **The attribution "logo" is a generic monochrome glyph**, not CoinGecko's actual
   trademarked mark (§9) — recorded as a deliberate trade against D26's no-new-CSP-
   directive rule, not a silent approximation.

4. **Two genuine, if narrow, product defects were found and fixed by this pass**
   (§2 items 2 and 3) that the prior agent's build had not yet run far enough to
   surface: the badge contrast and the dialog overflow. Both are now covered by the
   e2e suite's own assertions (the axe sweep, and the re-sync/range-control tests that
   depend on being able to reach controls inside the dialog), so a regression on
   either would fail loudly rather than silently.

5. **Nothing in this work package's scope is carried or deferred.** Both `networth
.spec.ts` exit tests, both `market-data.spec.ts` exit tests, the attribution
   placement, the per-currency mechanism, the sealed/live/interpolated chart styling,
   the never-ask-for-a-private-key line, and the never-echoed key handling are all
   built, tested, and green.
