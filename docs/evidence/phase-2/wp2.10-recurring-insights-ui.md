<!-- SPDX-License-Identifier: MIT -->

# WP 2.10 — UI: recurring and insights

Scope: `apps/web/src/features/{recurring,insights}/**`, `apps/web/src/routes/
{_app.recurring,_app.insights}.tsx` (+ one import line in `_app.index.tsx`),
new shared components under `apps/web/src/components/finance/`,
`apps/web/e2e/recurring-insights.spec.ts` (new) + its own mock module
`apps/web/e2e/support/mock-recurring-insights.ts` (new), `playwright.config.ts`
(one line, chromium `testMatch`), this file. Repo
`/home/chris/Projects/PersonalFi`, branch `main`. Contracts read from
`docs/evidence/phase-2/wp2.r-routes.md` (the REST surface), `wp2.3-recurring.md`
(candidate/series state machine, forecast band), `wp2.6-insights.md` +
`wp2.7-advisor-catalog.md` (Insight shape, alert budget, catalogue gaps), and
master plan D22 ("an insight may not show a number that is not in its
evidence").

---

## 1. What shipped, per screen

### `/recurring`

- **Candidates inbox** (`CandidatesQueue.tsx`): one-tap **Confirm**
  (`POST /recurring/candidates/{id}/confirm`); **Reject** behind
  `RejectCandidateDialog.tsx`, which states the permanent-override consequence
  explicitly ("This is permanent... never proposed again") and offers the
  `MERCHANT`/`STREAM` scope choice plus an optional reason
  (`POST .../reject`).
- **Confirmed series list** (`SeriesList.tsx`): cadence, amount model, next
  due, dormancy status phrased as a question never an accusation
  (`cadence-format.ts#formatStatusLabel` — "Haven't seen a charge in a
  while", never "you cancelled", per the dispatch's own instruction), a
  duplicate-service badge off the real `duplicateNode` field, and a
  **merge picker** (`MergeSeriesDialog.tsx`, `POST /recurring/series/{id}/
merge`).
- **Upcoming calendar** (`UpcomingCalendar.tsx`): `GET /recurring/upcoming`,
  30 days, one row per day that actually has a charge.
- **Forecast band chart** (`ForecastBandChart.tsx`, visx) + **safe-to-spend**
  stat: `GET /recurring/forecast` + `GET /recurring/safe-to-spend`, following
  `charts/NetWorthAreaChart.tsx`'s established single-visx-pattern shape
  (gradient/shaded band, `curveMonotoneX`, hand-drawn axis, pointer tooltip).
  The band is built by a pure, independently-tested function
  (`forecast-series.ts#buildForecastBand`) from the route's own
  `low`/`high`/`expected` per charge — never a client-invented uncertainty.
- **Empty states**: no candidates, no series (`Repeat` icon, matches the old
  stub's copy), nothing scheduled in 30 days.

### `/insights`

- **Feed** (`InsightsScreen.tsx`, `InsightCard.tsx`): severity badge,
  $-impact (annualized or one-time, never both — `severity.ts#
headlineImpactOf`), confidence percent, per 02-dispatch §3.
- **Full evidence panel on every card** (`EvidencePanel.tsx`), inline
  disclosure (05 §5.8's pattern): advisor id, confidence + basis,
  `requires_review` (always "Yes"), the impact basis prose, every evidence
  row with its `source_ref` named on screen, caveats, and the proposed
  actions — see §2 for the D22 proof.
- **Accept / Dismiss with reason** → `POST /insights/{id}/review`;
  `DismissReasonDialog.tsx` offers three presets plus freeform, all
  optional; the cooldown outcome (`dismissCount`/`permanent`/
  `suppressedUntil`) is surfaced as a banner immediately after.
- **Advisors settings** (`AdvisorsSettings.tsx`): enable/disable (`Switch`)
  and manual run (`Run now`), both routed through `useStepUpRetry` — the same
  passkey step-up ceremony `useExportTransactions.ts`/the connections screen
  use — because both routes are `requireFreshSession`-gated
  (`wp2.r-routes.md` §1). `CATALOGUE_GAPS` shown as "not yet available: needs
  <field>" — see §3 for why this list is a maintained copy, not a live read.
- **Dashboard widget** (`TopInsightsWidget.tsx`): one query
  (`feed.dashboard`, already alert-budget-limited server-side), no
  mutations, no dialogs — a single new import line in `_app.index.tsx`, per
  the "only if isolated" instruction.

---

## 2. The evidence-panel rule (D22), proved three ways

> "An insight may not show a number that is not in its evidence — the UI
> renders numbers FROM the evidence refs, never recomputes."

**What the client actually has to do.** `@ctx/insights`' seven-step pipeline
(`wp2.6-insights.md` §3) already proves every numeral in `summary_md` traces
to the snapshot, server-side, before an insight is ever written; the
persisted `insight_evidence` rows carry the advisor's own already-validated
`value`/`resolvedDisplay` text. The client's job is narrower but still real:
**never let the evidence panel print a number that isn't one of _this
insight's own_ evidence rows.**

1. **The resolver, and its throw.** `evidence-resolver.ts#resolveEvidenceRef`
   looks up a `source_ref` against exactly the `evidence[]` array passed to
   it; `evidence-resolver.test.ts` — 8 tests — asserts it throws
   `UnresolvedEvidenceRefError` when the ref is not present, **including a
   case where the ref is real but only exists on a _different_ insight's
   evidence array**, so a caching/props bug that fed the wrong insight's data
   into the panel cannot silently resolve. `EvidencePanel.tsx` calls this
   resolver for every rendered row rather than mapping the array directly —
   the same code path the test exercises.
2. **A number with nothing behind it never lies.** `displayValueOf` falls
   back `resolvedDisplay → value → '—'`, and explicitly never fabricates a
   number when both are `null` (tested).
3. **Browser proof.** `recurring-insights.spec.ts`'s
   `'every insight in the feed opens an evidence panel whose links resolve to
real transactions'` reads the duplicate-charge insight's evidence value
   (`$54.00`) straight off the DOM, follows its `href` to `/transactions?
q=CafeSprocket`, and asserts the **real** transaction list returned by the
   mock's own `/api/transactions` handler contains a row at exactly
   `-5400` minor units — the number on screen equals the number in the
   transaction it cites, not a coincidence of matching fixtures.

**What the client does _not_ re-derive.** `InsightView`/`Insight` (the wire
type) carries no `derivations[]` — those are validated and folded into each
evidence row's `resolvedDisplay` server-side. The panel's provenance strip
(`advisorId`, `confidence`, `confidenceBasis`) and the impact money
(`annualizedImpact`/`oneTimeImpact`) are rendered straight off the `Insight`
object the feed route returned — never computed client-side. This is stated
explicitly in `EvidencePanel.tsx`'s own header comment.

---

## 3. Contract gaps found, and what this WP did instead

Recorded rather than worked around by editing `apps/api` (out of scope):

| Gap                                                                                                                                                                                                   | What this WP did                                                                                                                                                                                                                                                                            | Where                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `GET /recurring/series` / `/candidates` name a stream only by `merchantId` (D25 — `@ctx/recurring` never carries payee text) — no display name.                                                       | Resolve names through the ledger's own reader, `GET /transactions?merchantIds=...` (already supported), batched into one query per screen; falls back to a truncated id if no transaction is found. Never a second write path, never invented.                                              | `useMerchantNames.ts` |
| The per-insight `advisor_version` that _produced_ this specific insight is stored (`insights.advisor_version`) but not serialised by `GET /insights`/`GET /insights/{id}` (`insightSchema` omits it). | The evidence panel shows `advisorId` (available) and omits the per-insight version; `AdvisorsSettings` shows the _currently registered_ version from `GET /advisors`, which is a different, available fact. Carried as a route-contract gap, not fixed here.                                | `EvidencePanel.tsx`   |
| `CATALOGUE_GAPS` (`packages/contexts/insights/src/advisors/catalogue.ts`) is a server-only constant in a Node/drizzle package with no browser build target and no route exposing it.                  | A maintained, dated copy of the same nine rows lives in `catalogue-gaps.ts`, explicit about being a copy and about which test (`catalog.test.ts`, server-side) keeps the _source_ list exhaustive.                                                                                          | `catalogue-gaps.ts`   |
| `RecurringSeries` carries no price-change history (`price_change_events` is not projected by the route).                                                                                              | Not fabricated or cross-referenced through a second, unrelated query; simply not shown on the series row. Recorded here as a real gap for a future WP wanting `wp2.3`'s price-change badges on this screen — it would need either a route addition or a join this WP was not scoped to add. | —                     |

---

## 4. Two accessibility bugs this WP's own e2e suite found and fixed

`recurring-insights.spec.ts` was the **first** suite to `axe`-scan a real
page using `Badge` variants `warning`/`serious`/`critical` (the severity
badges) and an `InsightCard` heading. Both findings were sabotage-style —
observed red on the first real run, fixed, re-observed green:

**Color contrast (`src/styles/theme.css`, `tokens.md`).** `--status-warning`/
`--status-serious`/`--status-critical` against light mode's `--bg-subtle`
(`#f1f1ee`) measured 1.62:1 / 2.33:1 / 4.24:1 — all under WCAG AA's 4.5:1.
`tokens.md` had already flagged exactly this ("visibly light colours that
likely have the same problem ... left for a broader contrast pass") after
`--status-good` got the identical treatment in Phase 1. Followed the same
precedent: computed darkened light-mode values (`#8e650e` / `#a35a3e` /
`#c83939`, all ≥4.5:1 against `#f1f1ee`) and restored/replaced dark-mode
values (`critical`'s _original_ value also failed dark mode's `--bg-subtle`
at 3.29:1, unlike `good`'s, so it gets a brighter dark-only replacement,
`#da6464`, 4.50:1). Verified with the exact WCAG relative-luminance formula
before touching CSS (not guessed).

**Heading order (`heading-order`, moderate).** `InsightCard`'s title and
`TopInsightsWidget`'s `CardTitle` both rendered as the first heading under
`TopBar.tsx`'s own `<h1>` route title, at `h3` — an h1→h3 skip. Fixed to
`h2` (`InsightCard.tsx`, a raw `<h2>` in `TopInsightsWidget.tsx` in place of
`CardTitle`), with `EvidencePanel.tsx`'s sub-headings correspondingly moved
to `h3` (one level under the card's own `h2`, since the panel renders inline
inside the card). `RecurringScreen.tsx`'s `Card` title was also converted to
a raw `h2` — its `h3` only avoided the same bug because "Needs your
confirmation" (`h2`) happens to render first in every scenario this WP's own
tests exercise; the empty-candidates case would have hit it too.

---

## 5. Tests

```
$ pnpm --filter @app/web exec vitest run
 Test Files  42 passed (42)
      Tests  242 passed (242)
```

New files in that total:

| File                                          | Tests | What                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/recurring/cadence-format.test.ts`   | 22    | cadence/amount-model/status labels, dormancy phrasing never accusatory, next-due band formatting, uncertainty-days pluralisation, duplicate-group label                                                                                                                                     |
| `features/recurring/forecast-series.test.ts`  | 8     | cumulative band construction, outflow worst-case = high magnitude negated (never low), inflow worst-case = low magnitude (never high), band always contains the expected line                                                                                                               |
| `features/recurring/RecurringScreen.test.tsx` | 5     | empty states, confirm posts `{}` and refreshes, reject shows the permanent warning and posts `{scope, reason}`, series list renders cadence/next-due/dormancy, safe-to-spend renders the real route figure                                                                                  |
| `features/insights/evidence-resolver.test.ts` | 8     | resolves by exact `sourceRef`; **throws on an unresolvable ref, including a ref real on a different insight**; `displayValueOf` fallback chain incl. the `'—'` no-invention case; `citedSourceRefs`                                                                                         |
| `features/insights/InsightsScreen.test.tsx`   | 6     | empty state; severity/impact/confidence render; evidence panel shows a number equal to the mocked evidence value with its source named; accept posts `{action:'accept'}`; dismiss captures a reason and shows the cooldown notice; **no proposed action of any kind renders as a transfer** |

`pnpm --filter @app/web typecheck`: clean for every file this WP touched.
(Three pre-existing errors remain in WP 2.9's concurrently-in-flight
`features/budget`/`features/reports` — untouched by this WP, unrelated
imports/types, `git status` confirms they were already present before this
session started editing.)

`pnpm --filter @app/web build`: clean, `dist/assets/_app.recurring-*.js` and
`_app.insights-*.js` present.

`pnpm prettier --write` / `pnpm eslint` over every file this WP owns: clean,
no changes needed (already formatted) / zero problems.

### Playwright — `e2e/recurring-insights.spec.ts`, 5 tests

Own mock module `e2e/support/mock-recurring-insights.ts` (does not import or
edit `e2e/support/mock-api.ts` or `app-walkthrough.spec.ts`, per this WP's
instructions) — an in-memory candidate/series/insight/transaction store with
real mutation semantics (reject/confirm permanently changes what a
subsequent `GET` returns).

```
$ pnpm --filter @app/web exec playwright test recurring-insights.spec.ts \
    --project=chromium --workers=1   (run 3x for stability)
  5 passed (× 3 consecutive runs)
```

- `'rejecting a candidate removes it and it does not return after a
re-detect'` (plan-named verbatim) — rejects with a reason, asserts the
  permanent-override dialog copy, asserts the row is gone, then **reloads
  the page** and asserts it still does not return. (The real server-side
  re-detect permanence is `wp2.3-recurring.md`'s own proof —
  `lifecycle.test.ts`'s `'a rejected merchant never returns as a
candidate'`; this browser test proves the UI's contract: once rejected,
  a fresh fetch after a full reload still excludes it.)
- `'confirming a candidate moves it into the confirmed series list'` —
  confirm, then switch tabs and find it in the series list.
- `'every insight in the feed opens an evidence panel whose links resolve to
real transactions'` (plan-named verbatim) — opens **every** card's panel
  (not just one), axe-scans each, and proves the numeral-equals-evidence
  claim from §2.
- `'no insight renders an action that performs a transfer'` (plan-named
  verbatim) — opens every panel and asserts no button/link anywhere is
  labelled or shaped like a transfer.
- `'dismissing an insight captures a reason and shows the cooldown notice'`
  — picks a preset reason, asserts the exact posted body, asserts the
  cooldown banner and the card's disappearance.

**axe**: clean at every checkpoint in every test (login, recurring
candidates, the reject dialog, the insights feed, each individual evidence
panel, the dismiss dialog, post-dismissal, and the transactions page reached
via the evidence link) — after the two fixes in §4.

**Full local Playwright suite** (`--workers=1`, to remove sandbox
parallel-worker contention as a variable): 17/18 passed. The one failure,
`notification-settings.spec.ts` → `'a test send reports a real delivery
result'`, reproduces in isolation against `mock-api.ts` alone, touches no
file this WP owns or edited, and is recorded here as a pre-existing,
unrelated finding rather than fixed (out of this WP's ownership —
`features/notifications/**` is WP 2.11's).

**A real bug this suite's own construction found and fixed, worth recording
for future e2e authors in this codebase:** an unscoped
`getByRole('list', {name: 'Insights'}).getByRole('listitem')` matches nested
`<li>`s inside an _expanded_ `EvidencePanel`'s own evidence/action lists, so
a `.nth(n)` index computed before any panel opened silently drifts once one
does. Fixed by scoping to direct children only (`.locator('> li')`,
`insightCards()`). Also found: `src/app/App.tsx`'s
`TanStackRouterDevtoolsPanel` (the always-open variant, not the collapsible
button) can visually cover a lower button on a long feed — hidden for this
suite's own Playwright interactions via a `page.addInitScript`-injected
style rule (test-only; the app under test is unchanged).

---

## 6. Files touched

- `apps/web/src/features/recurring/{cadence-format,forecast-series,
useMerchantNames}.ts` (+ two `.test.ts`), `{CandidatesQueue,
RejectCandidateDialog,MergeSeriesDialog,SeriesList,UpcomingCalendar,
ForecastBandChart,RecurringScreen}.tsx` (+ `RecurringScreen.test.tsx`)
- `apps/web/src/features/insights/{evidence-resolver,severity,
catalogue-gaps}.ts` (+ `evidence-resolver.test.ts`), `{InsightCard,
EvidencePanel,DismissReasonDialog,AdvisorsSettings,InsightsScreen,
TopInsightsWidget}.tsx` (+ `InsightsScreen.test.tsx`)
- `apps/web/src/components/finance/SeverityBadge.tsx` (new)
- `apps/web/src/routes/{_app.recurring,_app.insights}.tsx` (wired to the real
  screens); `_app.index.tsx` (one import + one JSX line: `<TopInsightsWidget
/>`)
- `apps/web/src/styles/theme.css`, `apps/web/src/styles/tokens.md`
  (contrast fix, §4 — outside this WP's nominal ownership but a
  shared-component/token bug this WP's own axe run found; minimal,
  precedent-following change, not a redesign)
- `apps/web/e2e/recurring-insights.spec.ts`, `apps/web/e2e/support/
mock-recurring-insights.ts` (both new)
- `apps/web/playwright.config.ts` (chromium `testMatch`, one entry added —
  landed already as part of WP 2.9's commit `6ae02b1`, which included this
  addition alongside its own `budget` entry)
- This file.

## 7. Left open

- Price-change badges on the confirmed series list (§3) — needs either a
  route addition (`price_change_events` projected onto `GET /recurring/
series`) or is otherwise out of reach without fabricating a cross-reference.
- The per-insight `advisor_version` is not shown in the evidence panel (§3)
  — a route-contract gap, not a UI omission.
- `notification-settings.spec.ts`'s pre-existing failure (§5) — not this
  WP's to fix.
- `CATALOGUE_GAPS` in `catalogue-gaps.ts` is a maintained copy (§3); it will
  drift silently if the server-side list changes without a matching edit
  here. No automated check ties the two together (would need a route or a
  build-time export, both out of this WP's scope).

---

## 8. `just check`

Run in the foreground after everything above, verbatim below.
