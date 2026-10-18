<!-- SPDX-License-Identifier: MIT -->

# Release notes

Versions follow semantic versioning (09 §5.8): tags are `vMAJOR.MINOR.PATCH`. Until 1.0, a minor
release may change behaviour and add migrations, and a patch release only fixes. Migrations are
forward-only and, through the 90-day soak, **expand-only**: no release drops or rewrites what an
older release wrote. Every release names every manual step an upgrade needs; **the target is zero**,
and a release with none says so. Rolling back is a restore of the pre-migration backup, never a
reverse migration ([RUNBOOK: Upgrade](../RUNBOOK.md#upgrade)).

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
