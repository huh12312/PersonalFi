# WP 9.8 — WCAG 2.2 AA sweep

Written incrementally; a finisher resumes from the last section that is filled in. State at each save is in §0.

## 0. Progress marker

- [x] Harness rewritten (`e2e/support/axe.ts`): WCAG 2.2 A/AA tag set, `target-size` on, `document` scope, devtools the only exclusion, `scanBothThemes`.
- [x] Every per-spec axe/theme helper and every exclusion removed (§1.2). Red run at unchanged tokens recorded (§2).
- [x] Tokens (`--danger*`, dark accent pair, status-warning pair, control borders, series, axis ink), `contrast.test.ts` (13 tests, red first §3.1, sabotaged §3.3).
- [ ] Sweep spec, keyboard spec, structural checks.
- [ ] Fixes for what the sweep finds.
- [ ] O-3, O-4, O-6, O-7 copy; add-wallet form.
- [ ] Checklist `wcag-checklist.md`; screenshots; sabotage log; final check.

## 1. What was wrong in the harness at HEAD `b9fa4d2`

### 1.1 The inventory (read, not assumed)

| Defect                                                        | Where                                                                                                                | Fix                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| CF-6 `target-size` never ran                                  | every spec called `axe.run('#app-content')` with no options                                                          | `runOnly` tags + `rules: { 'target-size': { enabled: true } }` |
| CF-7 portals never scanned                                    | scope `#app-content`; Base UI portals render to `document.body`                                                      | scan `include: [['html']]`                                     |
| CF-8 four `a[aria-current="page"]` exclusions                 | `advisors`, `networth`, `market-data`, `investments` specs                                                           | removed; the helper copies deleted                             |
| **A fifth mask the brief did not name**: a whole-rule disable | `budget.spec.ts`: `rules: { 'color-contrast': { enabled: false } }` for "the documented `--status-warning` deferral" | removed; token fixed (§3)                                      |
| per-spec `setTheme` / scan copies                             | `advisors`, `networth`, `market-data`, `investments`, `brief`, `goals`, `accounts-overrides`                         | one `setTheme` / `scanBothThemes` in `support/axe.ts`          |
| `test.fail` pin on the CF-9 defect                            | `goals.spec.ts` 'the delete confirmation is axe clean in dark'                                                       | annotation deleted (red first, then green with the token)      |

### 1.2 Honest correction to CF-8

CF-8 says the active nav link is `--accent-text` on `--accent-wash` at 4.29:1 in dark. **At HEAD that is no longer true of the sidebar.**
WP 4.10 re-pointed the sidebar's active pair (15.58:1, `wp4.10-plan-ui.md`), so the four exclusions had been inert for a phase and the
four specs pass with them removed (§2). The _token pair itself_ (`--accent-text #3987e5` on `--accent-wash #132537`) is still 4.28:1 in
dark and is still what the shared accent `Badge` reads, which is why 9.6 worked around it in `NarrationBadge` (§3).

## 2. Red first — new harness, unchanged tokens, unchanged components

Run: `pnpm exec playwright test --project=chromium --workers=1` over the 22 axe-using specs, source untouched except the harness and the
removal of the masks. Logs: `/tmp/w98/red{1,2,3}.log` (not committed; the failures are quoted).

| Spec · test                                                                                                                                                                  | Result         | Finding                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.spec.ts` ×3 (assigning money, rolling a period, Sankey band)                                                                                                         | **red**        | `color-contrast` `.bg-status-warning` "Credit overspend": `#0b0b0b` on `#8e650e` = **3.76:1** (the rule the old wrapper disabled)                                         |
| `goals.spec.ts` 'axe reports no violations on the goals screen or its dialogs…'                                                                                              | **red** (dark) | CF-9: `.bg-money-neg` destructive button in the delete confirmation: `#ffffff` on `#e8604a` = **3.38:1** — only visible because the dialog is in the document scan (CF-7) |
| `goals.spec.ts` 'the delete confirmation is axe clean in dark' (annotation removed)                                                                                          | **red**        | the same 3.38:1                                                                                                                                                           |
| `app-walkthrough.spec.ts`                                                                                                                                                    | **red**        | CF-6 first catch: `target-size` on the login screen's "Use an authenticator code instead" / "Use a recovery code instead" (334 × 18 px, 20 px of safe space; needs 24)    |
| `investments`, `networth`, `advisors`, `market-data` (the four CF-8 specs)                                                                                                   | green          | CF-8's named link no longer fails (§1.2)                                                                                                                                  |
| `brief`, `accounts-overrides`, `plan`, `plan-sliders`, `inbox`, `splits`, `rule-from-transaction`, `category-filter`, `notification-settings`, `recurring-insights`, `smoke` | green          | their screens, in their own states                                                                                                                                        |

(The remaining screens, dialogs and popovers are measured by the sweep, §5.)

## 3. Tokens and the contrast test

### 3.1 `contrast.test.ts`, red first

`apps/web/src/styles/contrast.test.ts` reads `theme.css` itself (`?raw`), parses `:root`, `[data-theme='dark']` and the `prefers-color-scheme`
copy, computes WCAG ratios with a twenty-line luminance function, and checks (a) the two dark blocks are identical, (b) a declared matrix of
text pairs at 4.5:1 and UI pairs at 3:1, in both themes, (c) every `bg-<token>` + `text-<token>` pair a _component_ names together, per
`hover:`/`data-[…]:` state (derived by scanning the source, with `bg-x/10` composited over the surfaces), and (d) that no component writes a
colour outside the tokens (hex, `rgb()`, `white`/`black`, palette classes), with a short named allow-list.

First run, with the three new tokens added at the values the destructive button and the badge actually had (so the red is today's defect,
not an invented one) — 7 of 12 red:

| Pair                                              | Ratio                       | Where it bites                                                    |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| dark `--accent-text` on `--accent-wash`           | 4.28:1                      | `Badge accent`, `SyncStatusPill` syncing, combobox highlight      |
| dark `--accent-text` on `--bg-subtle`             | 4.34:1                      | `CategoryPicker` hover                                            |
| dark white on `--danger`(= `--money-neg` #e8604a) | 3.39:1                      | the destructive button (CF-9)                                     |
| dark `--text-primary` on `--status-warning` fill  | 1.83:1                      | credit-overspend badge (`EnvelopeLineRow`, `BudgetVsActualTable`) |
| light `--text-primary` on `--status-warning` fill | 3.77:1                      | the same badge (the budget spec's disabled `color-contrast`)      |
| light `--status-serious` on `--bg-inset` (hover)  | 4.26:1                      | `SyncStatusPill` error hover                                      |
| light `--chart-axis-ink` on page/surface          | 3.35 / 3.59:1               | every chart's tick labels (SVG text, which axe does not measure)  |
| `--border-strong` on every surface                | 1.29–1.59:1 (both themes)   | every text input, select and switch boundary (1.4.11)             |
| light `--series-2/3/4/5` on surface               | 3.20 / 2.82 / 2.17 / 2.69:1 | chart marks (1.4.11)                                              |
| dark `--status-critical` on `--accent-wash`       | 4.44:1                      | (declared matrix only)                                            |

Not axe findings, any of them but the badge and the destructive button — which is the point of testing the tokens, not the pixels.

### 3.2 What changed in `theme.css` (both dark copies, test-held identical)

| Token                                       | Before                                                            | After (light / dark)                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--danger`, `--on-danger`, `--danger-hover` | (the button read `--money-neg`, `text-white`, `hover:opacity-90`) | `#c23a25` / `#ffffff` / `#a8321d`; dark `#e8604a` / `#0b0b0b` / `#ef7a66` — 5.35 / 6.69 light, 5.81 / 7.17 dark; `--money-neg` untouched |
| `--on-status-warning`                       | `--text-primary`                                                  | `#ffffff` light (5.23:1), `#0b0b0b` dark (10.7:1)                                                                                        |
| dark `--accent-text`                        | `#3987e5` (4.28:1)                                                | `#6da7ec` (6.23:1 on the wash); `--accent` stays `#3987e5`, a fill                                                                       |
| dark `--status-critical`                    | `#da6464` (4.50:1, one rounding from red)                         | `#e06c6c` (4.91:1)                                                                                                                       |
| `--border-strong`                           | `#d6d6d0` / `#33373b` (1.3–1.6:1)                                 | `#85847d` / `#70767c` (≥ 3.0:1 on page, surface, raised, subtle)                                                                         |
| light `--series-2/4/5` (and 3)              | `#eb6834` `#eda100` `#e87ba4` (`#1baf7a`)                         | `#d95926` `#b07300` `#d55181` (`#199e70`) — dark-theme hues, already CVD-validated; ≥ 3:1 on surface                                     |
| `--chart-axis-ink`                          | `#898781` both                                                    | `#6b6a64` light (5.4:1), `#9a9a92` dark                                                                                                  |

Components: `Button` destructive → `bg-danger text-on-danger hover:bg-danger-hover`; the two overspend badges → `bg-danger text-on-danger` /
`bg-status-warning text-on-status-warning`; `SyncStatusPill` error hover → `hover:bg-bg-surface hover:underline`.

### 3.3 Sabotage log (contrast test) — recorded as it happened

Backups in `/tmp/w98/sab/`, restored with `cp` and verified with `cmp`.

| #   | Sabotage                                                                                                    | Result                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | the `prefers-color-scheme` copy's `--text-muted` changed to `#777777` (the `[data-theme='dark']` copy left) | **red**: 'the two dark palettes are identical' (`--text-muted`) and the omnibus exit test ('dark palettes differ on --text-muted')                                            |
| S2  | dark `--accent-text` put back to `#3987e5` in both copies                                                   | **red**: declared dark text pairs (4.34 / 4.28:1) and the used-pairs test (`SyncStatusPill`, `badge`, `combobox`, `CategoryPicker`) and the omnibus                           |
| S3  | `Badge accent` given `text-[#999999]`                                                                       | **red**: 'no component writes a colour that this file cannot see' (`badge.tsx: a hex literal "#999999"`)                                                                      |
| S4  | `Button` destructive put back to `bg-money-neg text-white hover:opacity-90`                                 | **red**: 'no component writes a colour…' (`text-white`). Honest note: the _pair_ is not derived because `text-white` is not a token, so the off-token rule is what catches it |
