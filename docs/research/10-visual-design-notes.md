<!-- SPDX-License-Identifier: MIT -->

# Visual design notes from a competitor study, and what PersonalFi took from them

**Request (Chris, 2026-10-17, paraphrased):** he likes the visuals in Monarch Money for spend tracking and financial health, and asked for a study of them and a set of strategic visual improvements that would bring PersonalFi closer.

**What this document is.** A pattern-level study of a leading budgeting product's public interface — the screens a subscriber sees, as described in the product, its marketing site and its documentation — followed by PersonalFi's own gap analysis (§2), the eight-package programme that came out of it (§3), and the close-out of that programme (§5). The design conclusions and everything in §2, §3 and §5 are PersonalFi's own work. No asset of theirs — no font, icon, illustration, copy or code — is used anywhere in this repository; where a colour scale is adopted it is the open-source Radix Colors (MIT), which is published independently of any product. Component and identifier names are PersonalFi's.

---

## 1. What the product shows (pattern-level observations)

### 1.1 Stack

A React Native application with a charting library behind every graph, a single design system of reusable components (cards, banners, badges, bottom sheets, control cards, empty states, progress meters, timelines, calendars, fields, choice groups, avatars, a search bar, an icon set) and a token layer the components read. That is the same shape PersonalFi had already chosen; the lesson was in how consistently the tokens are applied.

### 1.2 Colour system (the one thing to adopt wholesale)

Twelve-step scales per hue, in light and dark, with semantic roles layered on top: surfaces (page, primary, secondary, tertiary, inset, frosted, overlay), text (primary, secondary, tertiary, muted, disabled), status quartets (success, danger, warning, info — each with a background, border, text and bold), and **chart roles**: income, expenses, a negative-area fill, line, axis, label, a categorical fill per hue, and four marker roles per hue (background, border, dot, foreground) for events on a timeline. A category keeps its hue across every chart on every screen. The scales themselves match the open-source Radix Colors palette, which PersonalFi adopted directly.

### 1.3 Scale vocabulary

T-shirt ladders for font size, icon size and control height; a named `default` spacing step distinct from the t-shirt sizes that every card and row uses; a small set of text variants (display, headings in three sizes, body in two, label, caption, eyebrow); tabular figures on money.

### 1.4 The spend-tracking surfaces

**Cash flow.** Three tabs (cash flow, income, spending); a "display by" switch between a flow diagram and bars; a timeframe stepper (month, quarter, year); a summary strip of income, expenses, net and a savings rate; breakdowns by category, category group and merchant as horizontal bar rows; comparisons against last period, the trailing average and the same period last year.

**Budget.** A "left to budget" header with income, expenses and rollover; a progress meter on every group header with a pace mark showing where spending would be at an even pace, a rollover glyph, and a colour for the state; categories grouped by variability (fixed, flexible, non-monthly).

**Category detail.** Monthly bars for the trailing year with a dashed average line, the selected month highlighted and pressable, and a sentence comparing this month to the average month.

**Net worth.** Stacked bars by account type with a net line over them, a scrubbable readout with the delta and percent, time-period chips, and a celebration when a milestone is crossed.

**Recurring.** A daily balance projection with a safe-to-spend figure and an overdraft warning — the same forward-cash-flow idea PersonalFi ships, surfaced on the dashboard.

**Dashboard.** A customisable list of widgets: net worth, spending (this month's cumulative daily spend against last month), budgets, goals, investments, transactions to review, recurring, debts, trends, the health score.

**Financial health.** A score shown as an arc gauge, a grid of pillar cards (score out of a maximum, a status, a one-line meaning), per-pillar charts plotting the metric against coloured health zones, a history of the score, and plain-words tiers.

**Insights.** Cards whose title, body and context line carry links to the entities they mention, a value line, a call to action, bookmarking and feedback; a weekly recap.

**Reports.** Server-driven blocks (text, key-value, horizontal bars, pie, stacked bars, sparkline rows, a net-worth chart, transaction lists, tables, badges, calls to action) rendered by one vocabulary across reports, insights and the recap.

**Transactions.** A total in the header, a rapid review mode, an emoji icon per category, a logo per merchant.

### 1.5 Typography (observed, not adoptable)

A commercial typeface family licensed to the product. PersonalFi's Geist and Geist Mono with tabular lining figures (WP 10.2) are the equivalent decision already made; nothing to change.

---

## 2. Gap analysis against PersonalFi today

| Monarch surface | PersonalFi today | Gap |
|---|---|---|
| 13-hue categorical chart palette with four roles per hue, stable per category; semantic chart tokens | Two chart tokens (`--chart-axis-ink`, `--chart-gridline`) plus WP 10.7's three-role forecast palette; categories have no colour of their own | **Foundational.** Every chart picks its own colours. |
| Cash Flow hub: tabs, Display by (Sankey / bars), Timeframe, Income / Expenses / Net / savings-rate strip, breakdowns by category, group, merchant, period comparisons | Reports screen with a Sankey and a category-by-month bar chart; no savings rate; no period comparison; no merchant breakdown | A hub screen and three comparison framings. |
| Dashboard as widgets; mini spending pace (this month's cumulative spend vs last month, by day) | Dashboard route with a net-worth tile and the Brief; no spending pace | The single most "Monarch" visual is missing. |
| Budget: Left-to-budget header, group progress meters with a pace tick and rollover icon, variability grouping | Budget screen with rollover, targets, refill rules; tabular rows, no meters, no pace tick | Meters and the pace tick. |
| Category detail: monthly bars with dashed 12-month average, selected month | No category drill screen (drill-through goes to transactions) | A small screen. |
| Net worth: stacked by account type with net line, scrub, period chips, milestones | Net worth line with history | Stacking and scrubbing. |
| Health score: gauge, pillars grid, zone charts, trend of score snapshots, plain-words tier | `HealthScoreSection` (a number with factors) | The gauge/pillar/zone presentation and the snapshot series. |
| Insight cards with entity-linked title/body/context, value captured, bookmark/feedback | `InsightCard` with evidence panel and dismiss reasons | Entity links and the "value" line. |
| Server-driven report blocks | Bespoke components per screen | A block kit would let the Brief, reports and insights share one visual language. |
| Merchant logos, emoji category icons | Neither (merchant logos would mean a third-party fetch per merchant) | Emoji icons yes; logos no. |

---

## 3. Strategic visual improvements, in the order to build them

Each item is scoped as one Phase 10 package. The order puts foundations first and the most visible wins early.

**V1 — Colour and chart tokens (foundation).** Adopt Radix Colors (MIT) as the scale layer: *sand* for neutrals in both themes, and thirteen hues as `--chart-fill-*`. Add semantic roles: `--bg-page|primary|secondary|tertiary|inset`, `--text-primary|secondary|tertiary|muted`, `--border-primary|secondary|divider`, `--status-{success,danger,warning,info}-{bg,border,text,bold}`, `--chart-income|expenses|negative-area|line|axis|label`, and `--chart-event-{bg,border,dot,fg}-{hue}`. Assign every category and account type a hue once (`categoryHue(id)`, stable, persisted on the category row) and make every chart read it. Validate every pair with the dataviz skill's contrast check in both themes. Migrate WP 10.7's forecast tokens onto it.

**V2 — Dashboard as widgets, with the spending pace widget.** Turn the dashboard into a widget grid (net worth, spending pace, budgets mini, upcoming/pulse, goals, investments, review count, top insights) with a "Customize" order. The spending pace widget draws this month's cumulative daily spend as a solid line against last month (and the 3-month average) as a dotted line, coloured by whether pace is above or below, with "You've spent X; last month by this day you had spent Y". Data: a by-day aggregate with empty days filled, straight from the ledger.

**V3 — Cash Flow hub.** A `/cash-flow` screen: tabs Cash flow / Income / Spending; Display by (Flow = the existing Sankey, Bars = income vs expenses per period with a net line); Timeframe (month / quarter / year with a date stepper); the summary strip Income · Expenses · Net cash flow · **Savings rate**; breakdowns by category, category group and merchant as horizontal bar rows (label, bar percent, right label); the three comparisons "vs last month", "vs average month (12 mo)", "vs last year". Reports keeps the saved-report role; the hub replaces nothing, it fronts it.

**V4 — Budget meters.** A "Left to budget" hero card (Income − budgeted expenses − savings) with rollover shown; group-header progress meters with a **pace tick** at the fraction of the month elapsed, a rollover glyph, and state colours (under / on pace / over) from the V1 status roles; variability grouping (Fixed / Flexible / Non-monthly) as a view toggle over the existing categories. Progress-meter sizes `xs|sm|md`, `squared|rounded`.

**V5 — Financial health as a gauge and pillars.** Keep PersonalFi's score and factors; present them as an arc gauge with segments and a sweep (respecting reduced motion), a pillars grid of cards (score / max, status, one-line meaning), per-pillar zone charts (the metric plotted against coloured bands), a score-snapshot sparkline over time, and a plain-words tier line. Where a questionnaire would ask which categories are fixed to compute living expenses, PersonalFi can read that from the budget's variability grouping (V4) instead.

**V6 — Net worth stacked by account type.** Stacked bars (cash, investments, property, crypto, liabilities negative) with a net line over them, rounded bar tops, a scrub readout showing the date, value and delta with a percent, period chips (1M 3M 6M 1Y All), and a milestone toast when a round number is crossed.

**V7 — Category detail screen.** `/categories/:id`: monthly bars for the trailing 12 months with a dashed average line and the selected month highlighted; the "this month vs average month" sentence; the transactions beneath. Also the emoji icon per category (user-chosen, stored on the category row, rendered in a tinted circle in the category's hue).

**V8 — Block kit.** A renderer for a small block vocabulary (`text`, `info`, `horizontal-bars`, `pie`, `stacked-bars`, `sparkline-row`, `net-worth`, `transactions-list`, `table`, `badge`, `cta`, `divider`, `group`) used by the Brief, Insights and Reports so the three stop drawing their own. Insight cards gain `contextLine`, entity links and a "value captured" line.

Skip, deliberately: merchant logos (a network fetch per merchant to a logo CDN leaks the merchant list), share cards, celebration confetti beyond a toast, and anything that would need another product's fonts or icons.

---

## 4. Sources

The product's public interface as a subscriber sees it, its marketing site and its documentation, read in October 2026; the Radix Colors project for the palette; PersonalFi's own tree for the "today" column of §2. Proportions, motion timing and exact layouts were not measured, so the packages in §3 specify PersonalFi's own, validated with the dataviz method and the accessibility lanes.

---

## 5. Visual programme V1–V8: close-out

Chris's request was "Dispatch v1 and once complete continue thru v8". All eight packages in §3 have
landed. Each row below gives the commit, what landed against §3's intent, and what was deliberately
left out. The evidence file named in each row holds the tests, the sabotages and the screenshots.

| Package | Commit | What landed against §3 | Deliberately not done |
|---|---|---|---|
| V1 colour and chart tokens | `5342a1f` (WP 10.8) | Radix Colors (MIT) vendored as the scale layer: sand plus the thirteen hues. One generated source gives the semantic roles: surfaces, text, borders, status quartets, chart roles, `--chart-fill-<hue>` and the four event roles per hue. Each category's hue is assigned once (kernel `hueForId`), stored in `categories.hue` (0045) and read by every chart. | No swatch picker (it came with V7). Text, accent, money and destructive colours stay named house values rather than scale steps. The legacy status tokens were left for V4 to move. |
| V2 dashboard as widgets | `27c0a84` (WP 10.9) | A grid of eight widgets in `DashboardWidgetCard`, with Customize (show, hide, reorder) saved per holder (0046). The spending-pace widget draws this month's cumulative spend against last month and the three-month average, from `GET /reports/spending-pace`. | The dashboard layout is not exported (`users` is exempt from the bundle). |
| V3 Cash Flow hub | `514afa4` (WP 10.10) | `/cash-flow`: tabs, Display by (Flow, Bars, Categories), a month/quarter/year timeframe, the Income · Expenses · Net · Savings-rate strip (the rate withheld with a reason), three comparisons in money, and category, group and merchant breakdowns as horizontal bar rows. Merchant drill-through now lands filtered. | The current-year timeframe is measured against the 200 ms budget, not asserted (it reads all 50k rows of the dense corpus). |
| V4 budget meters | `2adcd82` (WP 10.11) | The Left-to-budget hero, one `BudgetMeter` (sizes, shapes, a pace tick, a rollover glyph, the state in an icon and words, "no amount set" at zero), and fixed/flexible/non-monthly as a view (0047). `Badge` and every legacy status consumer moved onto the quartets. | "Group" means today's grouping by category kind, not parent categories. There is no UI for a line's savings class. |
| V5 health gauge and pillars | `b0f5b71` (WP 10.12) | `/health`: a 270° gauge with a one-time sweep (never under reduced motion), plain-words tiers, six pillar cards, per-pillar zone charts with the edges from the thresholds, and a 90-day snapshot sparkline (0048). Living expenses come from V4's fixed categories, so there is no questionnaire. | The score is unchanged. **The emergency-fund factor is not re-fed from living expenses**: that factor already had a defined input, so living cover is shown on its pillar but not scored. Chris's call is pending. |
| V6 net worth stacked | `a225e3f` (WP 10.13) | Stacked bars by account type with a net line, keyboard and pointer scrub, the hero following the selection, period chips, and milestones (0049) as an inline notice that stays until dismissed. | No hatched "not converted" segment (such a day is never written). No confetti or timed toast. **All-history p95 is noisy (83–208 ms)** because of stalls across the whole endpoint that predate the WP; p50 is 74–76 ms. **The milestone key has no currency**, so a base-currency change can hide a crossing. Milestones are not exported. |
| V7 category detail and emoji | `9791050` (WP 10.14) | `/categories/:id`, reachable from every category name: this month against the 12-month average in a sentence (withheld below two complete months), 13 monthly bars with a dashed average and the current month hatched, selectable months, and the transactions beneath. Emoji icons (`categories.emoji`, 0050) appear in a hue-tinted circle everywhere a category does. | The column is `emoji`, because `icon` was already the Lucide name (D20). Merchant logos are skipped: fetching them would leak the merchant list. |
| V8 block kit | `edba38a` (WP 10.15) | A versioned block vocabulary of fifteen kinds (`contractVersion` 1) in the kernel, published in OpenAPI. The server's and the web's Zod schemas run one shared fixture corpus. `BlockRenderer` has one component per kind and wraps the existing ones (`BudgetMeterRow`, the Cash Flow bar row, `NetWorthStackedChart`, `NarratedSummary`); every chart has its table, and a Blocks gallery sits on the kitchen sink. Reports (Spending, Income, Budget vs. actual) and the Brief (its overview and each card's body) are drawn through blocks, with figure-for-figure tests against their routes. The narrator's payload is unchanged and proved so. Insight cards gain links that are checked against the evidence, a context line, a value line, a bookmark and Helpful / Not helpful (0051). | No saved-report store exists, so the block routes serve the three existing reports. The Sankey stays bespoke. Merchant mentions never resolve (merchants reach an advisor as one-way pseudonyms, D22); the web supports the kind. "Saved $Y so far" has no source field. Feedback does not move the advisor policy. Insights do not render as blocks; their cards keep their bespoke interactive chrome. |

**Open items the evidence recorded.** None of these blocks a release. All are on the record for Chris:

1. **The 13-fill palette has limits** (WP 10.8 §1.4). It cannot pass the all-pairs CVD check, and four hues are under the chroma floor at every in-band step. Charts therefore use `CHART_FILL_ORDER` adjacency and never cycle past thirteen, and V6 chose its stacking order by the adjacency check.
2. **Current-year Cash Flow performance** (WP 10.10) is measured, not asserted, against 200 ms on the dense corpus.
3. **All-history net-worth p95** (WP 10.13) is noisy, at 83–208 ms. The stalls predate the WP: they come from serialising 3,652 daily points.
4. **The emergency-fund factor decision** (WP 10.12): should living cover replace the emergency-fund input in the score? It is Chris's call, and is not done.
5. **The milestone key has no currency** (WP 10.13): `(user_id, milestone_minor, direction)`.
6. **User preferences are not exported** (WP 10.9, WP 10.13). This covers the dashboard layout and milestone dismissals; `users` and derived tables are exempt from the bundle.
7. **New in V8:** the web's test-support copy of the block builders (`apps/web/src/test-support/block-fixtures.ts`) is kept equal to the server's by a test, not by an import, because the web cannot import `apps/api`.
