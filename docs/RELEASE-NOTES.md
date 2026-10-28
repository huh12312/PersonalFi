<!-- SPDX-License-Identifier: MIT -->

# Release notes

Versions follow semantic versioning (09 §5.8): tags are `vMAJOR.MINOR.PATCH`. Until 1.0, a minor
release may change behaviour and add migrations, and a patch release only fixes. Migrations are
forward-only and, through the 90-day soak, **expand-only**: no release drops or rewrites what an
older release wrote. Every release names every manual step an upgrade needs; **the target is zero**,
and a release with none says so. Rolling back is a restore of the pre-migration backup, never a
reverse migration ([RUNBOOK: Upgrade](../RUNBOOK.md#upgrade)).

## v0.9.20: the Brief in its own few sentences

**Status:** a patch release on v0.9.19 (if v0.9.18 or v0.9.19 has not been tagged when this is, tag
them in order). The tag `v0.9.20` is pushed by the maintainer once CI is green. Package 11.4 of the
Phase 11 programme (11 §5); closes the Phase 5 gate's G5-15.

### Upgrading to v0.9.20

```bash
git pull
just upgrade
```

Migration `0059_brief_narrations` (expand-only: one new table; nothing existing is touched).

### Manual steps

None. To see the composition, approve `brief.narrate`'s payload once in Advisors (it says so on
`/brief` until you do); to be told when the Brief is ready, add a notification rule for
`insights.BriefRecapReady` ([RUNBOOK](../RUNBOOK.md#the-briefs-own-narration-v0920)).

### What changed

- **The Brief narrates the Brief.** `/brief`'s header opens with a deterministic sentence (the
  count of ranked actions, the largest by its title and figure, the attention count). Under it, once
  a week, a two-or-three-sentence wording of the week's actions in the Brief's own order, and at the
  top the one-paragraph **Your week** recap — both from one language-model call per Brief, on the
  narrator's provider, each badged with the provider and model and "AI-assisted wording". A wording
  that fails the checks is said to have failed; the Brief's own words stand.
- **The checks.** Only the Brief's and its items' figures; only the items the Brief chose; the
  Brief's order; plain text; the copy linter. The controls self-test gains a fourteenth check,
  `brief_narration_grounding`.
- **A weekly notification.** A new event, `insights.BriefRecapReady`, can be routed by a rule: the
  Brief's own lines, then the recap when it passed.
- **API.** `AdvisoryBrief` gains `opening` and `narration` (`BriefNarration`: `shown` | `refused` |
  `pending` | `unavailable`, with both texts and `narratedBy` when shown). Advisor management's
  preview and approval routes serve `brief.narrate`.

## v0.9.19: what the automatic tiers decide now counts

**Status:** a patch release on v0.9.18 (v0.9.18 is package 11.3; if it has not been tagged when this
is, tag them in order). The tag `v0.9.19` is pushed by the maintainer once CI is green. Package
11.2b of the Phase 11 programme (11 §5), on Chris's decision of 2026-10-27.

### Upgrading to v0.9.19

```bash
git pull
just upgrade
```

Migration `0058_transaction_auto_category` (expand-only: six nullable columns and a partial index on
`transactions`, one boolean with a default on `users`; no row is rewritten).

### Manual steps

None. The worker fills the new columns from your existing assignments shortly after it starts (the
`categorization.project_auto` job; idempotent). Until it has run, only rows categorised after the
upgrade show the new behaviour ([RUNBOOK](../RUNBOOK.md#the-effective-category-and-the-inboxs-review-section-v0919)).

### What changed

- **The effective category is your pick, else a rule's, else an automatic tier's.** A learned
  merchant default (tier 3), Plaid's category (tier 4) and the classifier at or above its floor
  (tier 5) used to be recorded and explainable but invisible: a row they had placed read as
  uncategorised in the list, the Inbox, budgets and every report. They now count everywhere, through
  the one resolver. Your pick, or a rule, always wins. **Budgets and reports can therefore move** on
  upgrade, by exactly the rows that only a machine had placed.
- **Never silently.** Every automatic placement wears a chip ("Plaid", "Learned", "Classifier
  92 %") on the transaction list, the detail sheet and a category's screen; hover it, or focus it
  and press Enter, to read the stored explanation ("Learned from 4 confirmations"). A category you
  picked or a rule set shows none.
- **The Inbox.** "Uncategorised" is now only what every tier declined. A second section,
  **Auto-categorised, unreviewed**, lists what the machine placed in the last 30 days and you have
  not looked at (newest first, a page of 50): **Looks right** teaches the learning tiers like any
  pick, **Change** opens the picker. A switch in its header, stored on your account, hides it.
- **Export and import.** The projection is derived: the export omits it and the import re-derives it
  from the bundle's category assignments.
- **API.** `GET /transactions` rows gain `categorySource` and `autoCategory`; `autoReview=true`
  filters the Inbox's review rows; the `categoryIds` and `uncategorized` filters follow the resolver
  (a rule's category is now found by `categoryIds`); `GET /transactions/explanations` tiers carry
  the stored `facts`; new `GET`/`PUT /inbox/preferences`; the import answers `autoCategoriesReprojected`.

## v0.9.18: Explain this, on insights and health pillars

**Status:** a patch release on v0.9.17. The tag `v0.9.18` is pushed by the maintainer once CI is green.
Package 11.3 of the Phase 11 programme (11 §5).

### Upgrading to v0.9.18

```bash
git pull
just upgrade
```

Migration `0057_insight_explanations` (expand-only: one new, empty table, the explanation cache).
Nothing is backfilled.

### Manual steps

None. To use it: approve the `insight.explain` payload once in Advisors
([RUNBOOK](../RUNBOOK.md#explain-this-v0918)).

### What changed

- **Explain this.** A button on every insight card and on each scored health pillar (card and
  detail) asks the language model why the finding appeared or why the pillar scores as it does,
  what it is built from and what would change it. The text carries a badge naming the provider and
  model and "AI-assisted wording"; the evidence stays beneath it. A reply with a figure not in the
  evidence, advice, a link or markup is refused, and the refusal is shown as one.
- **The narrator's provider and consent.** It runs on the local model by default, or on a hosted
  provider only when that provider is your narrator under its consent; the payload is the
  narrator's class (the entity's own evidence, minimised; its scopes bounded by your narrator
  grant), so there is no new consent. The api never calls a model; the worker does.
- **Cached per evidence.** One explanation per entity and evidence digest, reused; changed evidence
  is a new explanation and the old one is kept. The weekly Brief prefetches its ranked items, at
  most five.
- **Self-test.** The GenAI controls self-test gains a thirteenth check, `explain_grounding`.
- **API.** New: `POST`/`GET /insights/{insightId}/explain` and
  `POST`/`GET /insights/health/{pillar}/explain` (202 while the worker explains). Advisors' payload
  preview and approval cover `insight.explain` (its preview's `request` is the explain request).

## v0.9.17: category suggestions from the local model, and picks that teach

**Status:** a patch release on v0.9.16. The tag `v0.9.17` is pushed by the maintainer once CI is green.
Package 11.2 of the Phase 11 programme (11 §5).

### Upgrading to v0.9.17

```bash
git pull
just upgrade
```

Migrations `0055_category_suggestions` (expand-only: four nullable columns on the abstention table
and three new, empty tables — the per-merchant answer cache, the precision-gate measurements, and
the suggestion settings) and `0056_snapshot_grant_scopes_v1_8` (expand-only: the advisor scope
list widened by one, advisor contract 1.8.0). Nothing is backfilled automatically.

### Manual steps

None. Optional: `just categorization-learn-backfill holder="<name>"` once, to teach the merchant
defaults and the classifier from the categories you picked before this release; and, to offer a
second, smaller local model for suggestions, set `LOCAL_MODEL_CLASSIFIER_NAME` and
`LOCAL_MODEL_CLASSIFIER_DIGEST` ([RUNBOOK](../RUNBOOK.md#category-suggestions-v0917)).

### What changed

- **Your picks teach.** Picking a category — one row, a bulk edit, or Confirm on a suggestion — now
  also counts towards the merchant's default (three agreeing picks and the merchant files itself)
  and the classifier's examples. Before, a pick changed that row only.
- **Category suggestions.** Where every tier abstains, the local model may suggest a category from
  your own list with a one-line reason: "Suggested by the model: <category> — <reason>", with
  Confirm and Not this, in the Inbox and the transaction list. Nothing is filed without the tap.
- **Off until measured.** Settings, Language model, Category suggestions: choose the model, preview
  and approve the payload, Measure on your own history, and Enable — which stays refused below
  85 % precision over 20 scored rows. Nothing leaves this machine; a hosted provider needs a
  separate consent that says merchant names would leave it, and ships unticked.
- **Self-test.** The GenAI controls self-test gains a twelfth check: a suggestion naming a category
  outside your list is refused.
- **API.** New: `/categories/suggestions/settings`, `/preview`, `/approve`, `/measure`,
  `/enabled`, `/hosted-consent`, and `POST /transactions/{id}/suggestion/reject`;
  `GET /transactions/explanations` items gain `suggestion`. The advisor contract gains the
  `transactions.residue` scope (1.8.0, strictly additive). The generic advisor switch refuses to
  turn `categorize.suggest` on (409).

## v0.9.16: a classifier that abstains when it should, "make this a rule?", and why a row is uncategorised

**Status:** a patch release on v0.9.15. The tag `v0.9.16` is pushed by the maintainer once CI is green.
The first package of the Phase 11 programme (11 §5, package 11.1). No language model is involved.

### Upgrading to v0.9.16

```bash
git pull
just upgrade
```

Migrations `0053_category_abstentions` (expand-only: one new, empty table holding the working behind
an "uncategorised" decision) and `0054_snapshot_grant_scopes_v1_7` (expand-only: the advisor scope
list widened by one, advisor contract 1.7.0). Nothing is backfilled.

### Manual steps

None.

### What changed

- **The classifier stops guessing.** Measured on merchants it had never seen, the old classifier was
  sure enough to file a transaction but wrong two times in three. A prediction that no word of the
  payee backs is now capped at a coin flip, so it stays uncategorised under the default 60 % floor;
  one the payee's own words back is scored on a re-derived curve. It also reads three new signals:
  the merchant-category-code family, your bank's broad category, and the part of the month.
- **Why is this uncategorised?** Each uncategorised row in the Inbox says, in one line, what each
  tier tried: for example "Every tier abstained: none of your 4 rules matched, merchant confirmed 1
  of 3 times needed, no bank category, classifier 41 % below its 60 % floor." It is read from what
  was recorded when the decision was made, never recomputed. Rows from before this release say that
  nothing was recorded yet, until their next sync.
- **"Make this a rule?"** When you have filed a merchant under the same category three or more times
  by hand and no rule or pinned category covers it, the Inbox and Insights offer **Create rule**,
  which opens the rule editor already filled in. Nothing is created until you save it; saving
  resolves the suggestion, and **Not now** dismisses it with the usual 30-day, 90-day, then permanent
  quiet. Like every built-in advisor it runs only once you grant it its data: Settings, Advisors,
  "A merchant you keep filing the same way", grant `categorization.rule_candidates`.
- **From the host:** `just categorization-eval holder="<name>"` replays everything you filed by hand
  through the categorisation tiers and prints each tier's precision, recall and abstain rate (add
  `json=true` for the JSON the next package's precision gate reads). It only reads.
- **API.** New: `GET /transactions/explanations?ids=…`. The advisor contract gains the
  `categorization.rule_candidates` scope (1.7.0, strictly additive).

## v0.9.15: prove the GenAI controls from the app

**Status:** a patch release on v0.9.14. The tag `v0.9.15` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.15

```bash
git pull
just upgrade
```

Migration `0052_ops_control_checks` (expand-only: one new, empty table for the self-test's dated
results). Nothing is backfilled.

### Manual steps

None.

### What changed

- **Run control checks.** Settings, Language model has a **Run control checks** button. With your
  passkey it proves, against this install, that a payload you have not approved is refused, that a
  cancel stops a run within 2 seconds and closes the connection to the model, that a reply carrying
  a number the app did not write (or a reply outside the format) is refused, that the model's
  egress policy refuses a host it does not list, that withdrawing a provider's consent turns the
  narrator off, that the run inspector's digest verifies, that the hourly window counts every call,
  that the Brief's badge names the right model, and, for the local model, that the pinned model is
  the one served. The screen says what a run costs before you press it (with a hosted provider, up
  to 3 calls with your key). Results are a table of facts in words; past runs are listed.
- **The dashboard** adds "controls proven <date>" (or "controls never proven") to the backup line.
- **From the host:** `just genai-selftest holder="<name>"` runs the same checks and prints the table.
- **API.** New: `GET /narrator/control-checks` and `POST /narrator/control-checks` (step-up; 202,
  one per 10 minutes). The hosted and local adapters gain fixed control probes, an abort counter,
  and their egress policy as a classifier; nothing about how a narration is built, previewed,
  approved or validated changed.

## v0.9.14: one block kit for the Brief and Reports, and insight cards with links

**Status:** a patch release on v0.9.13. The tag `v0.9.14` is pushed by the maintainer once CI is green.
This closes the eight-package visual programme that began with v0.9.7.

### Upgrading to v0.9.14

```bash
git pull
just upgrade
```

Migration `0051_insight_feedback` (expand-only: three new, empty columns on `insights` — when you
bookmarked an insight, whether you found it helpful, and why not). Nothing is backfilled.

### Manual steps

None.

### What changed

- **One way to draw a report.** The Brief and Reports are now drawn from a small, versioned set of
  blocks the server builds: headings and text, labelled figures, money, bar lists, a donut, stacked
  bars, sparklines, budget meters, the net-worth chart, a transaction list, tables, badges, links,
  dividers and groups. Every chart block has its table. A block never carries a figure its own
  report does not: a test checks every figure on the Reports screen against the report it comes
  from. A figure that is withheld says why instead of showing a zero.
- **Reports.** Spending and Income by category and month are stacked bars, and each segment still
  opens its transactions. Budget vs. actual is a table whose category names open the category's
  screen. The cash-flow Sankey is unchanged.
- **The Brief.** Above the cards: the week, the ranked actions by dollar impact (yearly and one-time
  figures are never drawn on one scale, and an action with no figure is named, not drawn as zero),
  any net-worth milestones you have not dismissed, and the health score card. Each card's wording,
  figure and "carried" badge are blocks too. A narrator's wording keeps its badge naming the
  provider and model, and the rules for what reaches a model are unchanged: blocks are built by the
  server and are never sent to one.
- **Insight cards.** Names in an insight (a category, an account, a transaction) are links, but only
  when the insight's own evidence cites that entity. A line under the title says what the insight is
  about. A value line reads "Worth $X / year" (or "one-time") when the insight claims a figure.
  Bookmark an insight, and filter the list to your bookmarks. Mark it Helpful or Not helpful; Not
  helpful asks why with the same reasons as Dismiss. Your answer is kept on the insight and does not
  change which insights you are shown.
- **API.** `GET /reports/blocks/spending`, `GET /reports/blocks/income` and
  `GET /reports/blocks/budget-vs-actual` return a `BlockDocument`. `AdvisoryBrief` and `BriefItem`
  gain `blocks`. `Insight` gains `bookmarkedAt`, `feedback`, `feedbackReason`, `mentions`,
  `titleSegments`, `bodySegments` and `contextLine`. New: `POST /insights/{insightId}/bookmark` and
  `POST /insights/{insightId}/feedback`.

## v0.9.13: a screen for every category, and emoji icons

**Status:** a patch release on v0.9.12. The tag `v0.9.13` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.13

```bash
git pull
just upgrade
```

Migration `0050_category_icon` (expand-only: one new, empty column, `categories.emoji`, holding the
emoji you choose for a category). Nothing is backfilled: every category keeps showing a default icon
until you pick one, and the default is never written.

### Manual steps

None.

### What changed

- **A screen for every category** at `/categories/…`, opened from any category name: the Cash Flow
  breakdowns (by category and by group), the Budget rows, the Reports tables and the Transactions
  category filter. It shows this month so far, and the sentence "This month vs. average month (last
  12 months)" in money, such as "$146.67 less than your average month of $356.67". The average is
  over the complete months in your ledger. Months with no spend count as zero, and the current
  month is never included. With fewer than two complete months the average is withheld and the
  screen says why.
- **The months as bars.** The last twelve complete months and this one appear as bars in the
  category's colour. This month is hatched and marked "so far", and the average is a dashed line
  labelled with its amount. A month with no spend is drawn as zero and listed as "No spend" in
  "View as table". Hover a month to read it. Press a month, or focus the chart and use ← → Home
  End, to select it: its transactions are listed beneath, with the usual row actions, and "See
  transactions" opens the same list on the Transactions screen. The bars grow in once, and never
  with reduced motion.
- **Emoji icons.** Every category shows an icon in a circle of its colour: the Transactions rows,
  the category picker, the Inbox, Cash Flow, Budget and Reports. Built-in categories have a default
  (🛒 Groceries, 🍽️ Dining, 🚗 Transportation, ✈️ Travel, ❔ Uncategorised and so on). Your own
  categories show their initials until you choose an icon.
- **Edit a category.** The Edit button on a category's screen lets you rename it, choose its icon
  (from a grid, or type exactly one emoji) or go back to the default, choose its colour (thirteen
  swatches, each named) and say whether its spending is fixed, flexible or non-monthly. The same
  dialog creates a category from the picker. Only what you changed is saved.
- **API.** `GET /reports/category-history?categoryId=…` returns the thirteen months, the average and
  the comparison. `Category` gains `emoji` (null when none is set), and `POST /categories` and
  `PATCH /categories/{id}` accept it (exactly one emoji, `null` clears it). Export and import carry
  it.

## v0.9.12: net worth by account type, scrubbable, and milestones

**Status:** a patch release on v0.9.11. The tag `v0.9.12` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.12

```bash
git pull
just upgrade
```

Migration `0049_net_worth_milestones` (expand-only: one new table recording each round net-worth
figure you cross, once). Nothing is backfilled: milestones are noticed from the first snapshot after
you upgrade.

### Manual steps

None.

### What changed

- **Net worth is drawn by account type.** The dashboard's Net worth card and the full history show
  one bar per period, split into property, cash, crypto, investments and other above the line and
  liabilities below it, each in its own fixed colour, with your net worth as a line over the bars.
  1M shows a bar per day, 3M and 6M a bar per week (Monday to Sunday) and 1Y and All a bar per
  month; a week's or month's bar is the last recorded day in it. "View as table" lists every bar,
  every account type and the net, and says which of those rules applies.
- **Scrub it.** Move the pointer over the chart, or focus it and use ← → Home End: the bar is
  picked out, the date, net worth and the change since the bar before and since the start of the
  period (in money and as a percent) are shown above it, and the big figure at the top follows. A
  percent is not shown when the starting figure is zero or negative; it says so instead. Leaving the
  chart, Escape or moving focus away returns everything to today.
- **The legend** names each account type you have, with its total at the bar you are looking at.
- **The full history** now uses the same 1M 3M 6M 1Y All chips as the card (old links with
  `netWorthRange=p30d`, `p90d`, `p1y` or `all` still work) and has its own figure at the top that
  follows its own scrub.
- **Milestones.** When your net worth crosses $10,000, $25,000, $50,000, $100,000 or any further
  $100,000 — or rises above or falls below zero — the dashboard says so in one line the next time
  you open it ("You crossed $50,000 in net worth on Oct 3"). Dismiss it and it does not come back.
  Each milestone is noticed once, however often the figure moves back and forth.
- Several currencies are still never added together: each is drawn as its own chart, and a currency
  that no bar at the chosen scale ends on is named rather than silently missing.

## v0.9.11: financial health as a gauge, six pillars and a daily history

**Status:** a patch release on v0.9.10. The tag `v0.9.11` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.11

```bash
git pull
just upgrade
```

Migration `0048_health_score_snapshots` (expand-only: one new table holding your financial health
score once a day, with its six parts and the figures each was built from). Nothing is backfilled:
the history starts on the day you upgrade.

### Manual steps

None.

### What changed

- **A Financial health screen** (under Overview, after Insights). Your score is the same score as
  before, worked out the same way; it is now drawn as a **gauge** with three bands — **Building**
  (under 50), **Steady** (50 to 79) and **Strong** (80 and over) — with the band in words, one
  sentence on the single thing to do next (from your lowest-scoring part), the date it is as of, a
  line of your score over the last 90 days and how it has moved since 30 days ago, in points and in
  words. "View as table" lists every day.
- **Six cards, one per part of the score** (emergency fund, savings rate, debt-to-income,
  subscriptions, diversification, fees): its score out of 100, its band in words and colour, what it
  measures, your figure, how much it counts towards the total, and **the figures it was built from**.
  A part there is not yet enough data for says so, says why, and says what would let it be scored —
  it is never shown as a zero.
- **Each part has its own page**: your figure plotted against coloured zones whose edges are the
  scoring rules' own (for example under 1 month, 1 to 3, 3 to 6 and 6 months or more of cover), how
  it has moved, the part's score over time, and the scoring rules in words.
- **Living expenses from your budget.** Once you have marked categories **Fixed** or **Non-monthly**
  on the Budget screen (v0.9.10), the emergency-fund card also shows how many months of living
  expenses your cash covers: the average of your fixed categories over the last three full months,
  plus a twelfth of your non-monthly categories over the last twelve. Flexible and unclassified
  categories are never counted. It is shown beside the score, not part of it. Until a category is
  classified it says "Classify your categories on the Budget screen."
- **The score is recorded every day at about 04:10** (your time zone), and on the spot when you open
  the screen and today's is missing. A day nothing ran stays empty; nothing is filled in afterwards.
- **A Financial health card on the dashboard** (after Top insights): the gauge, the band and the
  change over 30 days. Hide it under Customize like any other card.
- The Brief's health section is now a short card linking to the new screen.
- With reduced motion turned on, the gauge does not sweep.

## v0.9.10: budget meters, the pace mark, and fixed, flexible or non-monthly

**Status:** a patch release on v0.9.9. The tag `v0.9.10` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.10

```bash
git pull
just upgrade
```

Migration `0047_category_variability` (expand-only: one nullable column on `categories` saying
whether its spending is fixed, flexible or non-monthly, with a CHECK on the three values). Nothing is
backfilled: every category starts unclassified until you choose.

### Manual steps

None.

### What changed

- **Left to budget** leads the Budget screen: the money not yet given to a category (the same
  figure as before, now large, green when there is some and red with "fix this first" when you have
  assigned more than you have), with your income this period, your budgeted expenses and your
  planned savings and goals beneath it, and what rolled over from last month.
- **A bar on every spending group and category** showing how much of its budget is spent, with a
  **mark for where you would be at an even pace** (day 15 of a 30-day month is halfway). Each bar
  says its state in words as well as colour: _under pace_, _on pace_ (within 5 points of the mark),
  _ahead of pace_ or _over budget_, with "$spent of $budgeted · $left". A category with no amount set
  says "no amount set" instead of an empty bar; when the month is over the mark goes and the bar says
  so. With reduced motion turned on, the bars do not animate. "Show the bars as a table" lists every
  group with its pace.
- **By variability**: a second view of the same budget sorted into **Fixed**, **Flexible** and
  **Non-monthly**, each with its own bar and total ("Budgeted fixed expenses"), and an
  **Unclassified** list where one click sorts a category. A category a recurring charge lands in is
  marked **Suggested: Fixed** — only a suggestion; nothing changes until you press a button. Your
  choices are kept in your export and restored by an import.
- **The dashboard's Budgets card** uses the same bars, with the pace mark.
- **Status colours are now one set** (success, warning, danger, information) everywhere a badge or a
  status message appears, so badges read a little differently: a tinted background with matching
  text and edge. Every status still carries a word and an icon, never colour alone.

## v0.9.9: Cash flow, month by month

**Status:** a patch release on v0.9.8. The tag `v0.9.9` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.9

```bash
git pull
just upgrade
```

No migration.

### Manual steps

None.

### What changed

- **A Cash flow screen** (under Money, between Transactions and Budget) with three tabs: **Cash
  flow**, **Income** and **Spending**. Pick how it is drawn (**Flow**, the diagram from Reports;
  **Bars**, income and expenses side by side for each month, quarter or year with your net cash
  flow as a line over them; or, on Income and Spending, **Categories**) and the timeframe (Month,
  Quarter, Year), and step back and forward with the arrows; **This month** brings you back.
- **Income, Expenses, Net cash flow and Savings rate** at the top. The current month says "so far";
  its savings rate waits until the month is over (pay lands unevenly, so a rate part-way through
  would mislead), and a month with no income says so instead of showing a rate.
- **Comparisons in money**: against last month, your 12-month average, or the same month last year —
  "Expenses: $40.00 less than last month at this point ($1,500.00 against $1,540.00)". Part-way
  through a month, the other month is read to the same day. A comparison with nothing to compare
  against says what is missing instead.
- **Breakdowns by category, by category group and by merchant**, each a row with a bar for its share,
  the amount and the share; past twelve rows the rest are gathered into "Other" with how many it
  holds. Every row opens the transactions behind it.
- **Every figure is the spending and income report's own**: transfers between your accounts are left
  out, refunds are netted, anything you excluded stays excluded. Activity in a second currency is
  named, never converted or added in.
- **Links you can share inside the app**: the screen's address carries the tab, view, timeframe,
  period, breakdown and comparison.
- **Transactions** can now be filtered to one merchant (from a merchant row here, or a merchant band
  in the Reports flow diagram); the filter shows above the list with a button to remove it.
- **Reports** keeps saved reports and Budget vs. actual, links to Cash flow from its flow diagram,
  and its flow diagram's table now lists every flow as a link to its transactions (the keyboard's
  way in; the bands themselves are for a pointer). Reports also reads faster on a busy ledger.

## v0.9.8: the dashboard as widgets, with your spending pace

**Status:** a patch release on v0.9.7. The tag `v0.9.8` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.8

```bash
git pull
just upgrade
```

Migration `0046_dashboard_layout` (expand-only: one nullable column on `users` holding the
dashboard's widget order, with a CHECK that it is a list). Nothing is backfilled: every install
starts with the default layout.

### Manual steps

None.

### What changed

- **The dashboard is a grid of widgets.** Net worth, Spending pace, Budgets, Upcoming, To review,
  Goals, Investments and Top insights each sit in their own card with a title and a link to the
  screen that owns the data. One column on a phone, two on a tablet, three on a desktop.
- **Spending pace.** A line of what you have spent so far this month, day by day, against last
  month (dotted) and your three-month average (a thin line), with today marked, and a sentence that
  says it in words: "You've spent $X this month. By this day last month you had spent $Y." Spending
  is counted exactly as the spending report counts it: transfers between your accounts and income
  are left out, refunds are netted, and anything you excluded stays excluded. Pending charges are
  counted once they post, and the widget says how many are waiting. **View as table** shows every
  day.
- **Net worth** gains period buttons (1M, 3M, 6M, 1Y, All) and shows its change over the period,
  in money and as a percentage, once there are two real days to compare.
- **Budgets** shows Left to budget (your budget's Ready to Assign) and the three categories closest
  to or over their budget as small bars, each saying in words whether it is on budget, nearly
  spent or over.
- **Upcoming** lists the charges expected in the next seven days with Safe to spend, and warns in
  words when your projected balance would fall below zero, naming how low and when.
- **Customize** lets you hide widgets and change their order with buttons (no dragging needed);
  your choice is saved, and **Reset to default** brings the original layout back. The layout is not
  part of an export (like your time zone, it lives with your account on this install).
- **No widget draws a zero it does not have.** A widget with nothing to show says what is missing
  and links to where you can fix it ("No budget yet: set one"), and a source that has not synced in
  over a day says when it last did.

## v0.9.7: one colour system, and a colour of its own for every category

**Status:** a patch release on v0.9.6. The tag `v0.9.7` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.7

```bash
git pull
just upgrade
```

Migration `0045_category_hue` (expand-only: one nullable column on `categories`, with a CHECK over
thirteen colour names). Nothing is backfilled by the migration: each category gets its colour the
first time the categories list is read after the upgrade, and keeps it.

### Manual steps

None.

### What changed

- **One colour system underneath every screen.** Colours now come from a single generated set of
  tokens built on the open-source Radix Colors scales (MIT): neutrals from its warm grey, and
  thirteen chart hues. Screens look the same: backgrounds and chart lines moved by less than a
  just-noticeable difference, and text, the blue accent and the money colours are unchanged.
- **Every category has its own colour, everywhere.** A category is given one of thirteen colours
  the first time it is seen and keeps it, so it is the same colour in the spending chart, the cash
  flow diagram and every chart that comes later. The colour is stored with the category, can be
  changed through the API (a picker arrives with the category screen), and is included in an
  export and restored by an import.
- **Charts draw in a palette checked for colour-blind readers.** The spending chart, the cash flow
  diagram and the allocation donut use the thirteen hues in an order where every pair of
  neighbours stays distinguishable with and without colour-vision deficiency. Labels, the legend
  and **View as table** still carry every value, so no chart relies on colour alone.
- **Fixed: one badge colour fell just under the contrast minimum** on the new grey surface; it is
  a shade darker now.

## v0.9.6: the Recurring screen's Forward cash flow, redrawn

**Status:** a patch release on v0.9.5. The tag `v0.9.6` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.6

```bash
git pull
just upgrade
```

No migration. A web-only change.

### Manual steps

None.

### What changed

- **The three figures no longer overlap.** Safe to spend, Expected net and Worst case were drawn on
  top of one another (a stat tile in a row that gave it no width collapsed to nothing). Every stat
  tile now keeps its own width wherever it is placed, and on Recurring they sit in a strip: Safe to
  spend as the one large figure, the other two smaller beside it, each with a line saying what it
  means. On a phone they stack.
- **A chart that shows when money leaves.** The running total is a step that drops on the day a
  charge is due, with the detector's uncertainty band around it, a labelled $0 line, a light money
  axis, and a mark for every expected charge on its due date (money out and money in drawn
  differently). Hovering a day lists that day's charges by name and amount; **View as table** lists
  them too. The last date label is no longer cut off.
- **Honest when there is nothing to draw.** A month with no charge due says so and names the streams
  that fall outside it ("1 stream (Uber, yearly) has no due date in this window") instead of drawing
  a flat line at $0. A month whose charges are all fixed says the band is empty because nothing is
  uncertain.
- **Fixed: an outflow sent with its sign could have plotted as money in.** The chart read the
  forecast's amounts as unsigned and negated an outflow a second time; it now signs every amount by
  its direction, so the chart's last day equals the Expected net and Worst case figures above it.

## v0.9.5: the language model in Settings — local, or your own key

**Status:** a patch release on v0.9.4. The tag `v0.9.5` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.5

```bash
git pull
just upgrade
```

Migration `0044_narrator_settings` (expand-only: two new tables, one CHECK widened, two nullable
columns on `advisor_payload_approvals`; every row valid before is valid after). `just upgrade` takes
the verified pre-migration backup first and creates the three new optional secret files empty
(`secrets-placeholders`).

### Manual steps

None. Nothing changes until you choose a provider: with no choice the narrator behaves exactly as in
v0.9.4 (the local model if the operator configured one, otherwise none). To use a hosted model:
Settings, **Language model**, the provider's card: save your key with your passkey, tick the
consent, press **Test**, then make it active — and approve the narrator's payload again in Advisor
management (a switch withdraws the old approval on purpose).

### What changed

- **Settings, Language model (decision D30, revising D22).** Choose the narrator: Ollama (local, the
  default), OpenAI, OpenRouter, Anthropic, or Off. A hosted provider needs your own key (saved with
  your passkey, sealed, shown only by its last four characters; or the operator's
  `openai_api_key` / `openrouter_api_key` / `anthropic_api_key` file, which wins) and your consent,
  whose text says what leaves the machine: _Brief findings: aggregated amounts, bucketed, merchants
  pseudonymised — never a transaction, never an account number_. A model id per provider (defaults:
  `claude-sonnet-5-5`, `gpt-6.1-sol`, `anthropic/claude-sonnet-5.5`). A **Test** button sends a
  fixed probe with no personal data and says how it went, in words.
- **The same payload, the same checks.** A hosted narrator gets exactly what the local model gets —
  the minimised, previewed, approved payload — and its reply goes through the same reply format,
  the same narration match and the same rule that it may not introduce a number. Each provider's
  adapter can reach one host only (`api.openai.com`, `openrouter.ai`, `api.anthropic.com`), within
  the local model's timeout ceiling, under the same kill switches, with an hourly call window.
- **Switching withdraws the approval.** Making a hosted provider active, or changing its model,
  withdraws the narrator's payload approval; the approval now records the provider and model it was
  given for.
- **The Brief names the model.** Each narration's badge says who wrote it: "Narrated by Anthropic
  claude-sonnet-5-5", "Narrated by the local model qwen2.5:7b-instruct-q4_K_M".
- Changes reach the worker without a restart.

## v0.9.4: prices actually refresh, Refresh prices, and US tickers identified

**Status:** a patch release on v0.9.3. The tag `v0.9.4` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.4

```bash
git pull
just upgrade
```

That is all. No migration. `just upgrade` still takes the verified pre-migration backup and checks
that the stack is ready.

### Manual steps

None. To see prices at once instead of after the next 03:45 run: Investments, **Refresh prices**
(or Settings, Market data). US-dollar stocks, ETFs and funds that showed as "Could not identify this
security" are identified on the next investment sync (nightly, or Sync now on the connection), then
priced by the next refresh.

### What changed

- **The nightly price refresh prices your holdings.** It never did: nothing gave the 03:45 job the
  list of holdings, so it ran an empty plan every night and a saved Tiingo or CoinGecko key priced
  nothing. It now prices every security with a non-zero position, routed by kind (Tiingo for
  equities, ETFs and funds; CoinGecko for crypto by coin id), with FX through FRED for every
  non-US-dollar position currency. Cash, bonds and "other" are counted, not sent anywhere; a
  holding it cannot price (no ticker, a token CoinGecko has no id for, no key) is named with the
  reason.
- **Refresh prices**: a button on the Investments header and in Settings, Market data runs the same
  refresh for you now, once per ten minutes, and says what happened in words ("Priced 12 of 13;
  1 unpriced: no CoinGecko key"). A saved key's card now says "Holdings sync and price refresh use
  this key from the next run; use Refresh prices to fetch now."
- **The latest close, not today's.** Tiingo was asked for exactly one day, so a run on a weekend, a
  holiday or before the close found nothing; it now takes the latest close in the week before (one
  request), marked as carried forward. FRED's exchange rates, published with a lag, look back two
  weeks.
- **US tickers identified (decision D29).** A bare ticker still never identifies a security on its
  own, with one exception: a US-dollar stock, ETF or mutual fund with nothing stronger is looked up
  on OpenFIGI as a US listing and identified only when OpenFIGI returns exactly one composite FIGI.
  Plaid sends bare tickers for US holdings, so this is what turns them from "Could not identify" into
  holdings. Anything ambiguous stays a named "could not identify" row, with the reason in words.
- Developers: `compose.dev.yml`'s data volume is scoped to the compose project, so a second stack
  under another `-p` name can no longer mount the dev database's data directory.

## v0.9.3: market-data keys in Settings, and positions nobody could identify made visible

**Status:** a patch release on v0.9.2. The tag `v0.9.3` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.3

```bash
git pull
just upgrade
```

That is all. `just upgrade` takes the verified pre-migration backup, applies migration 0043
(expand-only: `provider_credentials` accepts the four market-data providers and a NULL environment
for them; `investment_transactions` gains `security_unresolved`, `provider_security_name` and
`provider_ticker`, and its "a trade names a security" CHECK is re-declared wider; one new table,
`unresolved_holdings`; every row valid before is valid after, nothing dropped from the data) and
checks that the stack is ready.

### Manual steps

None. To add a market-data key without touching the secrets directory: Settings, Market data, paste
the key, **Save with passkey**. Positions that could not be identified appear on Holdings after the
next investment sync (nightly, or Sync now).

### What changed

- **Market-data keys in Settings** (the WP 10.1 Plaid pattern): Tiingo, FRED, CoinGecko and
  OpenFIGI keys can be saved in the product, checked with the provider first, sealed under the
  install's key, never shown again (only the last four characters), never exported, taken up by the
  worker within 30 seconds with no restart. A non-empty secret file still wins, and Settings says
  which source is in force.
- **OpenFIGI without a key works.** The anonymous tier (10 per request, 25 requests a minute) is
  now wired, as the RUNBOOK always said. And the OpenFIGI mapper now actually reaches the security
  resolver: before this release the runtime built it and nothing ever used it, keyed or not.
- **"Could not identify this security."** A position the resolver could not identify is a named
  row on Holdings (and on the account's own page): the institution's name and ticker, quantity,
  the institution's own value (labelled as such), no price, no gain, and the reasons in plain
  words. It is left out of allocation and performance and named in their excluded lists.
- **Activity keeps those movements.** A buy, sell, dividend or contribution in such a security is
  stored and listed under Activity with the same marker; lots and performance leave it out (and
  performance names it), and a contribution is still classified as a contribution.
- **Note for the upgrade:** a Plaid cash position whose only name is the institution's own id (or a
  bare ticker such as `CUR:USD`) now shows on Holdings as "could not identify", with its value as
  the institution's figure, where before it showed nothing.

## v0.9.2: investment activity, and performance by who manages each account

**Status:** a patch release on v0.9.1. The tag `v0.9.2` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.2

```bash
git pull
just upgrade
```

That is all. `just upgrade` takes the verified pre-migration backup, applies migration 0042 (one
nullable column, `account_overrides.management`, with a CHECK, and the row-not-empty CHECK
re-declared wider so a row may hold only that field; expand-only: every row valid before is valid
after, nothing dropped from the data) and checks that the stack is ready.

### Manual steps

None. Investment activity a Plaid sync already fetched is listed at once; an account whose
investment activity has not synced yet says so until the next sync.

### What changed

- **Activity.** Investments has an Activity tab: every buy, sell, dividend, reinvested dividend,
  interest payment, contribution, withdrawal, fee and split in your investment accounts (Plaid's
  investment transactions, which never appear under Transactions), with the account, the security,
  quantity, price, amount and where the row came from. Filter by account, type and dates; the last
  twelve months by default.
- **Who manages each account.** An investment account's settings page has "Managed by": an
  advisor, a robo-advisor, or you. It changes nothing in your plan.
- **Performance by scope.** The Performance tab measures the whole portfolio, one account, or each
  kind of manager side by side. The comparison puts the time-weighted returns in one table (the
  one rate that is fair to compare) and the money-weighted returns and the dollars in separate
  tables, never on one row.
- **A health snapshot** above it: the value, what you put in or took out, dividends and interest,
  fees, and the gain that did not come from your own money; the time-weighted return beside it in
  its own block, with whether it is annualized. Anything that could not be valued is named rather
  than counted as zero.
- **Fixed: what counts as money in or out.** A 401(k) payroll contribution that a provider reports
  as a purchase, and an IRA distribution reported as a sale, are now counted as contributions and
  withdrawals; a fund's capital-gain distribution, a tax withheld and a margin expense are no longer
  counted as deposits or withdrawals; a transfer of shares is valued on the day it happened. Returns
  for affected accounts change on upgrade, to the right numbers
  ([wp10.3-investment-activity-performance.md](evidence/phase-10/wp10.3-investment-activity-performance.md)).

## v0.9.1: Plaid credentials in the product

**Status:** a patch release on v0.9.0. The tag `v0.9.1` is pushed by the maintainer once CI is green.

### Upgrading to v0.9.1

```bash
git pull
just upgrade
```

That is all. `just upgrade` takes the verified pre-migration backup, applies migration 0041 (one new
table, `provider_credentials`; expand-only, nothing altered or dropped, so it applies to a live
install with no contract step) and checks that the stack is ready.

### Manual steps

None. In particular: no new secret, no `.env` edit, no restart sequence beyond the one `just
upgrade` performs, and nothing to do if you already supply Plaid through the secret files: they
keep working and keep winning.

### What changed

- **You can add your Plaid keys from the product.** Accounts, Add connection, the Plaid tab ("Set up
  Plaid"): paste the client id and secret, choose the environment (sandbox, or production once the
  install allows it), and save with your passkey. The keys are checked with Plaid first, then stored
  sealed with the same key that protects your bank access tokens, and the Plaid connector is
  available at once, without a restart. **Change** and **Remove** are on the same tab.
- **The operator's secret files still win.** If `plaid_client_id` and `plaid_secret` have content, the
  tab says so and offers no way to change them. `PLAID_ENABLED=true` is still the proxy's switch for
  Plaid Link's script, whichever way the keys are supplied. Production still needs
  `PLAID_ALLOW_PRODUCTION=true`.
- Never in an export bundle, never in a log line, never returned by any route; the evidence is
  [wp10.1-plaid-credentials.md](evidence/phase-10/wp10.1-plaid-credentials.md).
- **A new typeface.** The interface is set in Geist, and code and identifiers in Geist Mono, in
  place of Inter: both open-licensed (SIL OFL 1.1) and shipped inside the app, so nothing is loaded
  from Google or any other host. Figures in money columns, tables, dates and counts use tabular,
  lining digits so they line up. Nothing to do on upgrade
  ([wp10.2-typeface.md](evidence/phase-10/wp10.2-typeface.md)).

## v0.9.0: polish and harden

**Status:** the release candidate for the Phase 9 gate. The tag `v0.9.0` is pushed by the maintainer
once the gate has passed (09 §6 Q8), which is also the first run of `release.yml`. Until then,
upgrade to a commit of `main` that CI shows green.

### Upgrading to v0.9.0

From any earlier release, including a v0.8 install and one as old as v0.1, however many releases
you skip:

```bash
git pull
just upgrade
```

That is all. `just upgrade` creates the placeholders for any optional secret your install predates,
rebuilds the images, **takes a verified, encrypted backup before the first migration** (automatic;
no separate `just backup` is needed), applies the migrations, and checks that the stack is ready
and stable. It refuses to start an older release against a newer database. A v0.1 install was
upgraded to a release candidate by `just upgrade` alone (a direct jump, and a chain through each
wave), and the same test runs on a GitHub runner before any release image is published
([wp9.4-upgrade.md](evidence/phase-9/wp9.4-upgrade.md)).

The host needs `git`, Docker with Compose v2, `just` 1.21+ and Node.js 18+ (the host scripts only;
an install made by an earlier release already has all of these). No new environment variable is
required.

### Manual steps

| Step                                                                                                                                                                        | Who needs it                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approve the narrator's payload preview again** (Settings, then Advisor management at `/settings/advisors`: open the local-model advisor's payload preview and approve it) | Only an install that has enabled the local-model narrator | The narrator now writes figure slots (`{{e1}}`) that the app fills in from each finding, so its prompt template and reply format changed. That changes the template hash, so an earlier approval covers a different query shape. Until you re-approve, a narration is **refused** `payload_not_approved`. It fails closed: nothing is written and nothing else is affected. Installs that never enabled the local model have nothing to do. |

There is no other manual step. In particular: no new secret to create (new optional secrets are
made empty for you), no `.env` edit, no data migration to run by hand, no re-linking of any
provider, and no restart sequence.

### What changed

- **Security: the app no longer runs as the database superuser.** Migration 0039 adds `personalfi_app` (DML only); api and worker use it from the first query with no action. Optional, for a hard boundary: split the roles with the new optional secret `migrator_database_url` (RUNBOOK "Database roles"). No manual step.
- **Security: published images can be verified before they run.** `PERSONALFI_PULL=1 PERSONALFI_RELEASE=x.y.z just upgrade` pulls only images whose cosign signature and provenance attestation match this repository's tagged release at your checked-out commit (`scripts/verify-release.sh`). Building from source stays the default. On `personalfi-prod`, `just upgrade` now runs the isolation guard first.
- **Builds no longer expire.** The images pin their base by digest and no longer pin exact Alpine package builds (which Alpine stops serving); the weekly upgrade test rebuilds them with no cache and scans them with `trivy image`.
- **Budget actuals no longer stop on a new account without a balance**, and a failing `GET /budgets/current` no longer leaves a half-created budget. A stopped consumer can be resumed: `just consumer-resume <name>`. A credit card that already owes money when a budget starts, and card spending in a category with no budget line, no longer stop it either (WP 9.14).
- **Recovery codes and sessions are in the app (Settings, then Security).** The first-run wizard shows your ten recovery codes once, after the backup passkey, and will not move on until you tick that you saved them (you can skip it and create them later). Settings › Security lists your signed-in sessions (sign one out, or all the others), removes the authenticator-code factor, and replaces your recovery codes; each of those needs a fresh passkey touch.
- **`just bootstrap-user` can no longer take the running app down.** It derives its key in its own short-lived container (about 1.2 GiB for six seconds) instead of inside the api's, so a small host that used to end it with `exit code 137` now has the memory it needs or fails the one-shot alone.
- **Boot memory: api and worker derive their keys one at a time**: the boot peak drops from ~2.4 GiB to ~1.5 GiB; the worker is ready ~6 s after the api.
- **Accessibility (WCAG 2.2 AA sweep):** every screen has its own page title, every chart has a data table, the lock screen traps focus, Escape closes a dialog from a category field, nothing animates under reduced motion, every screen reflows at 320 px, and the destructive button has its own contrast-checked tokens; 15 defects fixed, none by excluding an element from the scan.
- Also from the security review's fixes: outbound TLS certificate checks are now tested for every provider client; session list and sign-out-everywhere routes; `DELETE /auth/totp`; step-up refusals, exports and imports are in the security event log, which is append-only; `Cache-Control: no-store` on every API response; Caddy's error pages carry the security headers; every container has a PIDs cap; an import re-validates plan data.

**Upgrades are safe to run unattended (WP 9.4).**

- A database newer than the code is refused (`migration.database_newer`); "newer" is set
  membership, never a maximum, so migrations applied out of number order converge.
- A verified encrypted backup is taken before any migration runs, and the migration does not run if
  the backup fails.
- New optional secrets get empty placeholders automatically (`just secrets-placeholders`).
- A test installs v0.1 cold and upgrades it to the release by `just upgrade` alone (direct jump and
  a chain through every wave), and `release.yml` will not publish an image unless it passes.

**Backups you can trust (WP 9.1, WP 9.4).**

- The dashboard shows the age of the last backup and the date of the last restore drill, and warns
  past 26 hours without a backup or 35 days without a drill (`GET /ops/backup-status`).
- **Fixed: a backup of any install holding a plan scenario could not be restored** (migration 0040;
  found by the upgrade test, F-94-6). The restore drill had passed only because its database held no
  plan. The drill now needs one: see [RUNBOOK: Restore drill](../RUNBOOK.md#restore-drill).
- `just restore-drill` no longer picks the first backups volume, network and database on a host
  with several Compose projects: it filters by `COMPOSE_PROJECT_NAME` and refuses when ambiguous.
- A false refusal of a valid backup whose dump table of contents was large is fixed (F-94-1).

**A production install that agents and gates cannot damage (WP 9.1).** The RUNBOOK's
[production install](../RUNBOOK.md#production-install-and-the-real-use-soak) section: an isolation
guard, a SHA-pinned image tag, a weekly aggregates-only soak report with a seeded leak canary, and
the 90-day clock.

**Real-data readiness (WP 9.2).** You can now set an account's tax treatment, role and valuation
yourself, so a mis-typed IRA no longer projects as taxable. A changed override makes the existing
projection read as stale and never recomputes it behind your back. Migration 0035.

**Planning that says what it did (WP 9.7).** Every projection problem is explained in words (56
codes); a deterministic run is labelled as one and is never phrased as a probability; the Monte
Carlo engine says when it is unavailable; every staleness reason names its version. A new `/goals`
screen has goal create, edit, contributions and a risk questionnaire, and a plan can be forked and
compared.

**The advisory surface (WP 9.6, WP 9.3, WP 9.5).**

- The narrator's payload preview can now be approved through the product, and a narrator's wording
  is attached to the Brief item it describes ("AI-assisted wording"). The text of a narration is
  shown only when `NARRATION_TEXT_SHOWN=true`, which **stays false in this release**: the narrator's
  figures are 100% correct on the first five validation steps and 92.9% through all seven on the
  measured 56-item run, under the 95% bar this release sets for showing it. Every figure it does
  write is the finding's own (slots), and the red-team pass found 0 fabricated figures in 32
  payloads.
- A first request to a cold local model no longer times out: the model is loaded by a data-free
  warm-up call first.
- All four kill levels have a screen and read back their real state in words
  ([RUNBOOK: Advisor kill switches](../RUNBOOK.md#advisor-kill-switches)); a published Brief item
  records its action; grant changes are recorded in an append-only history.
- Closed: nightly anomaly runs no longer need per-run consent for built-in advisors, a run's digest
  is verified when inspected, six scoping predicates each have a test, and a category's creep is no
  longer reported on a single large purchase.

**Performance, measured (WP 9.9).** Every master-plan budget was measured on the target host with
the load printed, and all pass: the 50,000-row transaction list p95 15 to 58 ms over real HTTP (budget
200); a 10,000-path Monte Carlo 543 ms (800); the nightly sync chain 243 s (300); a restore to
`/ready` in 36 s (1 hour); idle RAM 317 MiB and 351 MiB through a nightly chain. The
exception is the boot window, when `api` and `worker` each derive their encryption key at once and the
stack peaks near 2.4 GiB for about 3 seconds. The full table is in
[RUNBOOK: Resource envelope](../RUNBOOK.md#resource-envelope).

**Security review (WP 9.10).** An external-style review against ASVS 5.0 (278 requirements) and a
refreshed [threat model](security/threat-model.md): 88 met, 16 met by documentation, 61 gaps, 104 not
applicable. Its 33 gaps and what became of them are in
[wp9.10-security-review.md](evidence/phase-9/wp9.10-security-review.md); the
[ASVS assessment](security/asvs-assessment.md) has the row-by-row evidence.

**Security fixes (WP 9.11).**

- Outbound TLS certificate verification is now tested for every client that dials out (Plaid,
  Coinbase, market data, ntfy, Esplora and Etherscan, SMTP and a remote local-model endpoint): each
  was sabotaged to accept any certificate and the new test went red, where 219 existing tests had
  stayed green (G-27). One dialer now implements the pinned lookup, the TLS options and the header
  checks for the shared transport and the local-model endpoint, and a header value containing a line
  break is refused before any connection is made (G-24, G-16).
- The serving processes no longer run as the database superuser. Migration 0039 adds a DML-only
  role, `personalfi_app`; `api` and `worker` start every connection as it, with no action on your
  part. An optional second secret, `migrator_database_url`, makes that a hard boundary: see
  [RUNBOOK: Database roles](../RUNBOOK.md#database-roles). `security_events`, the audit trail, is
  append-only (G-01, G-25).

**Documentation (WP 9.12).** A README that takes a stranger from a clean host to a passkey login; a
consolidated RUNBOOK with a cryptography inventory, a logging inventory and a lockout section; and
`scripts/check-docs.ts`, a CI check that fails when a doc names a `just` recipe, an environment
variable, a secret, a path or a link the tree does not have.

### Migrations in this release

| Migration                         | What it adds                                                          |
| --------------------------------- | --------------------------------------------------------------------- |
| 0035 `account_overrides`          | Holder-set tax treatment, role and valuation per account              |
| 0036 `ops_status`                 | `ops_backup_runs`, `ops_restore_drills` (the dashboard's backup line) |
| 0038 `brief_actions_grant_events` | A Brief item's recorded action; the append-only grant history         |
| 0040 `plan_levers_search_path`    | Makes backups of databases holding plan scenarios restorable          |

Numbers 0037 (unused) and 0023 (burned in an earlier phase) are gaps; the runner tolerates gaps and
out-of-order application. All are expand-only.

### Known limits

- **`NARRATION_TEXT_SHOWN` stays `false`.** The narration's text is hidden until a counted run
  reaches 95% through step 7. Nothing is lost: the Brief shows that a narration exists.
- **Plaid runs in sandbox until you opt in.** `compose.yml` passes `PLAID_ALLOW_PRODUCTION`
  (default `false`) to the api and worker; production needs it set to `true` in `.env` as well as
  `plaid_env` reading `production`
  ([RUNBOOK: Create secrets](../RUNBOOK.md#2-create-secrets)).
- **A first link of years of history is consumed slowly.** The categorisation and recurring
  consumers re-read a payee's whole history for each page of a backfill, so a 730-day, 20,000-row
  backfill takes about ten minutes (about 33 rows a second); a day's sync is seconds. Nothing is lost
  while it runs, and the nightly chain no longer waits on the job poll (243 s became 48 s in WP 9.14).
  `GET /holdings` and `/investments/allocation` at 200 positions, about 2 s in WP 9.9, are now about
  60 ms.
- **Key rotation has no operator procedure yet** ([RUNBOOK: Master-key rotation](../RUNBOOK.md#master-key-rotation)).
- **v1.0 is not this release.** It needs 90 days as the author's only finance tool, and the
  earliest date is 2027-01-10 ([path to v1.0](plan/06-path-to-v1.md)).

### Dependencies and licences

Permissive licences only, audited by `just licenses` and listed in
[`THIRD_PARTY.md`](../THIRD_PARTY.md).
