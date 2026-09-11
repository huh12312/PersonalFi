# PersonalFi — Product Requirements Document

**Doc:** `09-requirements-prd.md`
**Owner:** Requirements / Product (panel role)
**Date:** 2026-09-10
**Status:** Draft for Chris's review — see §7 Open Questions
**Scope of this doc:** WHAT and WHY, plus acceptance criteria. Technical architecture (stack, schema, deployment topology) is owned by other panel members; where this doc touches technology it is stating a *requirement*, not a design.

---

## 1. Vision & Principles

### 1.1 Vision statement

> **PersonalFi is a private financial advisor that happens to run on Chris's own hardware.**
> It ingests the full picture — cash, credit, brokerage, retirement, crypto — and then does the thing a good advisor does and a ledger never does: it tells him what to do next, shows the arithmetic behind the advice, and connects today's $14.99 subscription to the year he can stop working.

The product is judged on one question: **after connecting accounts, does it say something true, specific, and actionable that Chris did not already know?** Tracking is table stakes and is only ever a means to that end.

### 1.2 Principles

These are binding. A feature that violates a principle is rejected or redesigned, not negotiated.

| # | Principle | What it means in practice | How it constrains us |
|---|---|---|---|
| **P1** | **Your data never leaves your box except to the providers you chose.** | The only outbound network destinations are an explicit allowlist: Plaid, market-data provider, crypto sources, and (later) a Vibe-Trading instance. No analytics, no crash reporting, no font/CDN fetches, no "phone home" version check that carries data. | Egress allowlist is a shipped, enforced config. Any new outbound host is a reviewed change with a user-visible entry in Settings → Data Flows. No third-party JS or web fonts. |
| **P2** | **Every recommendation shows its evidence.** | Each insight carries: the transactions/holdings it was derived from, the formula or rule, the assumptions used, and a confidence. "Why am I seeing this?" is a first-class UI affordance on every card, not a tooltip. | No black-box scoring. If a model can't explain itself, it produces a *candidate* that a rule-based explainer must justify before it is shown. |
| **P3** | **Calm, not gamified.** | No streaks, no confetti, no badges, no red-alert framing of normal variance, no daily engagement loop. The app should be *pleasant to ignore for a week*. Notifications are rare, batched, and each one must be worth an interruption. | Hard cap on proactive notifications (§3.13). Weekly digest is the default cadence. Any "you spent a lot on dining" style nag requires a materiality threshold. |
| **P4** | **Advice, never execution.** | PersonalFi recommends; Chris acts. It never moves money, never places a trade, never cancels a service on his behalf, never submits a negotiation. | Removes an entire class of liability, credential scope, and failure mode. Read-only provider scopes wherever the provider offers them. Applies to the Vibe-Trading integration too (§3.16). |
| **P5** | **Correct beats clever, and uncertainty is shown.** | Money math is exact (integer minor units, no floats). Projections state their assumptions inline and render as a *range*, not a single heroic number. When data is stale or an account failed to sync, the number is labelled stale rather than silently wrong. | Every derived figure has a provenance and an as-of timestamp. Monte Carlo results always show percentile bands. |
| **P6** | **You own the data and can walk away.** | Full export of everything (accounts, transactions, rules, insights, assumptions) in open formats, plus direct SQL access. The schema is documented. Import from CSV/OFX so history predating Plaid's window isn't lost. | No proprietary blob storage. Export completeness is an acceptance criterion, not a nice-to-have. |
| **P7** | **Single user today, not single user forever.** | Built for exactly one person, but the data model, auth, and authorization carry a user/household dimension from day one so partner access is a feature later, not a rewrite. | Every row that is user-scoped has an owner from v0.1. No multi-user *UI* in v1. |

---

## 2. Persona & Context

### 2.1 Primary (and only) persona — "Chris"

| Attribute | Value |
|---|---|
| **Role** | Sole user, sole admin, sole operator. Technically strong: comfortable with Docker, compose files, reverse proxies, `psql`, reading logs. |
| **Hosting** | Self-hosts on home server hardware. Alpine-based containers. Expects `docker compose up` to work and upgrades not to break. |
| **Location / tax** | Assumed US, USD base currency, US tax concepts (401(k)/IRA/HSA/brokerage, Social Security, federal + state). **To confirm — §7.** |
| **Financial surface** | Multiple institutions: checking/savings, several credit cards, at least one brokerage, at least one tax-advantaged retirement account, crypto on an exchange (Coinbase) and possibly self-custody. |
| **Primary job-to-be-done** | "Tell me whether I'm on track, and tell me the two or three things I should change this month." |
| **Secondary jobs** | Kill waste (subscriptions, fees, creep). Never be surprised by a bill. See net worth trajectory honestly. Understand portfolio risk he actually holds, not the one he thinks he holds. |
| **Anti-jobs** | Does not want a daily chore. Does not want to hand-enter transactions. Does not want to be nagged. Does not want a toy. |
| **Trust posture** | Elevated. Accepts an aggregator as a necessary evil but treats the resulting datastore as crown jewels. Security friction is acceptable *if it is proportionate and doesn't fire every session*. |
| **Device mix** | Desktop-primary for analysis, phone for glances and notifications. Responsive web (PWA) assumed sufficient; native app not required. **Mobile share to confirm — §7.** |
| **Aesthetic target** | Rocket Money's clarity and subscription-first legibility; Wealthfront's calm, chart-forward, plan-centric feel. Dense where it needs to be, never busy. |

### 2.2 Context of use

- **Weekly ritual (primary):** 5–10 minutes, desktop, Sunday-ish. Read the Advisory Brief, clear the categorization queue, accept/dismiss recommendations.
- **Glance (frequent):** 20 seconds, phone. "Am I fine?" → safe-to-spend, upcoming bills, net worth delta.
- **Deep dive (monthly/quarterly):** 30–60 minutes, desktop. Portfolio X-ray, retirement scenario work, reports.
- **Incident (rare):** an account disconnects, a bill spikes, an anomaly fires. Needs to be resolvable in under 2 minutes.

### 2.3 Assumptions to confirm

Each assumption is stated with the default we will build against if unanswered, so work is never blocked. Full question list with rationale in §7.

| # | Assumption | Default we build against | Blast radius if wrong |
|---|---|---|---|
| A1 | Country / tax residency = US | US federal + one state; US retirement account types | High — rewrites projection and account-type modelling |
| A2 | Base currency = USD, occasional foreign-currency transactions | USD base; multi-currency data model from day one; FX at transaction date | Low — model is already currency-aware |
| A3 | Individual, not household | Single user; `owner_id` on all user-scoped rows; no sharing UI | Low if modelled, High if not — hence P7 |
| A4 | Partner access wanted eventually | Multi-user *readiness* only in v1 | Low |
| A5 | Mobile is ~30% of sessions, glance-oriented | Responsive PWA, mobile-optimised glance surfaces, no native app | Medium — native app is a large v2+ bet |
| A6 | ~10–15 connected accounts across ~6–9 institutions | Sync + UI perf budgets sized for 25 accounts / 15 items / 250k transactions | Low — headroom built in |
| A7 | Plaid covers banks/cards/brokerage; crypto needs its own path | Plaid for FI data; direct read-only Coinbase API + manual/on-chain for crypto | Medium — affects Crypto epic sequencing |
| A8 | No public internet exposure | LAN/VPN-only by default; public ingress is an opt-in documented path | Medium — changes the hardening bar |
| A9 | History wanted beyond Plaid's 730-day window | CSV/OFX import path in v1 ladder | Low |
| A10 | Advisory scope excludes tax filing, insurance, estate | Out of scope (§6.4) | Low |

---

## 3. Feature Map

### 3.0 Epic roll-up (MoSCoW)

Priorities are **for v1.0**. `M` = Must, `S` = Should, `C` = Could, `W` = Won't (this release).

| # | Epic | v1 Priority | One-line outcome |
|---|---|---|---|
| E1 | Accounts & Connections | **M** | Every account is connected, healthy, and reconnects without drama. |
| E2 | Transactions | **M** | A clean, trustworthy ledger: no dupes, no phantom spending from transfers. |
| E3 | Categorization & Rules | **M** | ≥90% auto-correct; corrections teach the system once, not repeatedly. |
| E4 | Budgeting | **S** | Flexible category targets that reflect reality, not a second job. |
| E5 | Recurring & Subscriptions | **M** | Every recurring charge found, priced, trended, and judged. |
| E6 | Cash Flow & Bills | **M** | Forward-looking daily balance and a real safe-to-spend number. |
| E7 | Net Worth | **M** | One honest trajectory line across everything. |
| E8 | Investments & Portfolio | **M** | Look-through allocation, drift, concentration, fee drag. |
| E9 | Crypto | **S** | Crypto counted in net worth and allocation, with cost basis where possible. |
| E10 | Goals & Retirement Planning | **M** | "Am I on track?" answered with a range and editable assumptions. |
| E11 | Insights & Advisory | **M** | The Weekly Advisory Brief — ranked actions with dollar impact and evidence. |
| E12 | Reports & Export | **S** | Full portability plus the handful of reports worth having. |
| E13 | Notifications | **S** | Rare, batched, material. |
| E14 | Security & Privacy | **M** | Proportionate, provable, no telemetry. |
| E15 | Settings & Admin | **M** | Backup, restore, sync health, assumptions, zero-touch upgrade. |
| E16 | Trading-Research Integration | **W** (v1) | Read-only research surface from Vibe-Trading, post-v1. |

---

### E1 — Accounts & Connections

**Outcome:** Chris connects every institution once, sees at a glance whether data is fresh, and repairs a broken link in under two minutes.

| ID | Priority | User story |
|---|---|---|
| AC-1 | M | Connect an institution via Plaid Link |
| AC-2 | M | See per-account sync health and last-successful-sync time |
| AC-3 | M | Repair a connection that requires re-authentication |
| AC-4 | M | Add a manual account for assets Plaid can't reach |
| AC-5 | M | Mark an account as closed without losing its history |
| AC-6 | M | Prevent/resolve the same account connected through two providers |
| AC-7 | S | Classify each account's role (spending, savings, taxable, tax-deferred, tax-free, liability) |
| AC-8 | S | Exclude an account from specific calculations (e.g. net worth, budgeting) |
| AC-9 | S | Backfill maximum available history on connect |
| AC-10 | C | Import historical transactions from CSV/OFX for pre-Plaid periods |
| AC-11 | C | Disconnect an institution and choose whether to purge or retain its data |

**Acceptance criteria**

- **AC-1** — *As Chris, I want to connect an institution through Plaid Link so that balances and transactions flow in without manual entry.*
  - Given a valid Plaid configuration, When Chris completes Link for an institution, Then an Item is persisted with its access token encrypted at rest, all discovered accounts are listed for selection, and only accounts he selects are activated.
  - Given a successful connect, When the initial sync completes, Then accounts show a balance and an `as of` timestamp, and the UI states how many days of history were retrieved.
  - Given Link is cancelled or errors, When Chris returns, Then no partial Item is left active and the error is shown in plain language with a retry action.
- **AC-2** — *As Chris, I want per-account sync health so that I never trust a stale number.*
  - Given an account synced successfully 3 hours ago, When Chris views it, Then it shows "Updated 3 hours ago" with a healthy indicator.
  - Given an account whose last successful sync is older than 48 hours, When Chris views any screen containing its balance, Then the figure is visibly marked stale and the dashboard surfaces a single consolidated "N accounts need attention" entry.
- **AC-3** — *As Chris, I want to repair a broken connection so that a bank MFA change doesn't quietly rot my data.*
  - Given Plaid returns `ITEM_LOGIN_REQUIRED`, When Chris opens the account, Then a "Reconnect" action launches Link in update mode for that Item.
  - Given update mode completes successfully, When the next sync runs, Then the existing account records are reused (same internal IDs), no duplicate accounts are created, and any transactions missed during the outage are backfilled.
  - Given the reconnect changes which accounts the Item exposes, When sync runs, Then newly appearing accounts are queued for explicit confirmation rather than auto-activated.
- **AC-4** — *As Chris, I want manual accounts so that assets outside Plaid still count.*
  - Given Chris creates a manual account with a type, currency and current value, When he views net worth, Then it is included and flagged as manually valued with its last-updated date.
  - Given a manual account has not been updated in 90 days, When the Advisory Brief runs, Then it includes a low-priority prompt to refresh the value.
- **AC-5** — *As Chris, I want to close an account so that history is preserved but the account stops distorting the present.*
  - Given an account is marked closed with a closure date, When Chris views current net worth or budgets, Then the account contributes zero going forward, but historical net worth points before the closure date are unchanged.
  - Given an account is closed, When sync runs, Then it is not polled and generates no sync-health warnings.
- **AC-6** — *As Chris, I want duplicate connections detected so that my net worth isn't double-counted.*
  - Given two active accounts share an institution and a matching account mask/last-4 and type, When sync completes, Then a duplicate-candidate warning is raised naming both, and net worth uses only the account designated primary.
  - Given Chris designates a primary, When calculations run, Then the secondary is excluded from net worth, cash flow, and budgets while remaining browsable.
  - Given two accounts are *not* duplicates despite matching heuristics, When Chris dismisses the warning, Then it is not raised again for that pair.
- **AC-7** — *As Chris, I want to classify account roles so that tax treatment and advice are correct.*
  - Given an account is classified `tax_deferred`, When retirement projections run, Then its balance is modelled with pre-tax treatment and its withdrawals with ordinary-income assumptions.
  - Given an account type is inferred from Plaid, When it is inferred rather than confirmed, Then the UI marks it as inferred and invites confirmation.
- **AC-8** — *As Chris, I want per-calculation exclusions so that e.g. a custodial or business account doesn't pollute my budget.*
  - Given an account has `exclude_from_budget = true`, When budgets are computed, Then its transactions are omitted from budget actuals but remain visible in the ledger and (unless also excluded) in net worth.
- **AC-9** — *As Chris, I want maximum history on connect so that trend analysis has something to chew on.*
  - Given a new Item, When initial sync runs, Then the maximum supported history window is requested (Plaid's ceiling is 730 days / `days_requested` max 730), and the UI states the actual window returned per account.
  - Given the institution returns less than requested, When Chris views reports, Then charts show a "data begins here" boundary rather than implying zero activity before it.
- **AC-10** — *As Chris, I want CSV/OFX import so that history older than the provider window survives.*
  - Given a CSV with a column mapping, When Chris imports into an account, Then rows are inserted with an `import` source, and any row matching an existing transaction on (account, date ±3 days, amount, normalised description) is flagged as a duplicate candidate and not auto-inserted.

**Edge cases & rules**

- **Reconnect (update mode)** must be idempotent: same Item, same internal account IDs, cursor preserved, gap backfilled.
- **Backfill limits:** provider history is capped (Plaid: up to 730 days). Never render a chart that implies "$0 spent" for periods before the data boundary.
- **Closed accounts** keep historical rows; balance series terminates at closure date; no orphaned recurring-series alerts.
- **Duplicate across providers:** heuristic = institution + mask + type + balance proximity + transaction overlap ratio > 0.6. Warn, never silently merge.
- **Institution rename/merger:** match on Plaid `institution_id`, not display name.
- **Item with mixed products:** an Item may support transactions but not investments (or vice versa); per-product capability is tracked per Item and the UI never promises data a product can't deliver.
- **Investment accounts return no transactions** via the transactions product — they must be sourced from the investments product, and their absence from the ledger must not be read as "no activity".

---

### E2 — Transactions

**Outcome:** A ledger Chris believes. The single biggest trust-killer in this category is phantom spending from internal transfers and duplicates; this epic exists mostly to kill those.

| ID | Priority | User story |
|---|---|---|
| TX-1 | M | Ingest transactions incrementally without gaps or dupes |
| TX-2 | M | See pending transactions distinctly and have them resolve cleanly when posted |
| TX-3 | M | Have transfers between my own accounts excluded from spending and income |
| TX-4 | M | Have refunds net against the original spend |
| TX-5 | M | Split a transaction across categories |
| TX-6 | M | See foreign-currency transactions in both original and base currency |
| TX-7 | M | Search and filter the full ledger fast |
| TX-8 | S | Add notes, tags and attachments to a transaction |
| TX-9 | S | Manually add or edit a transaction in a manual account |
| TX-10 | S | Hide/exclude a one-off transaction from analysis with a reason |
| TX-11 | S | See a clean merchant name instead of bank gibberish |
| TX-12 | C | Bulk-edit a selection of transactions |

**Acceptance criteria**

- **TX-1** — *As Chris, I want incremental sync so that my ledger is complete and never double-counts.*
  - Given a stored sync cursor, When sync runs, Then only adds/modifies/removes since that cursor are applied, and the cursor advances only after the batch commits atomically.
  - Given the same provider transaction ID arrives twice, When it is written, Then a uniqueness constraint on (provider, provider_txn_id) prevents a second row and the existing row is updated instead.
  - Given a sync fails mid-batch, When it is retried, Then the result is identical to a clean run (idempotent) and the cursor has not advanced past unapplied data.
  - Given the provider reports a transaction as removed, When sync applies it, Then the transaction is soft-deleted, excluded from all aggregates, and visible in an audit view.
- **TX-2** — *As Chris, I want pending transactions handled properly so that my balances and budgets don't flicker.*
  - Given a pending transaction, When it is displayed, Then it is visually distinct and labelled pending.
  - Given a posted transaction arrives carrying a `pending_transaction_id` matching a stored pending row, When sync applies it, Then the pending row is replaced by the posted row — not kept alongside — and any user edits (category, notes, splits, tags) on the pending row are carried over to the posted row.
  - Given the posted amount differs from the pending amount (e.g. a tip on a restaurant charge), When it posts, Then the posted amount wins, budgets recompute, and the delta is not reported as a new transaction.
  - Given a pending transaction never posts within 14 days and is not returned by the provider, When cleanup runs, Then it is dropped from aggregates with an audit entry.
  - Given the user has configured it, When budgets and safe-to-spend are computed, Then pending transactions are included by default (setting: include/exclude pending).
- **TX-3** — *As Chris, I want internal transfers excluded so that moving my own money doesn't look like income or spending.*
  - Given a debit in account A and a credit in account B within ±4 days, with equal absolute amounts in the same currency, and both accounts owned by Chris, When transfer detection runs, Then the two are linked as a transfer pair, `is_transfer = true`, and **neither** appears in spending, income, budget actuals, or cash-flow-in/out.
  - Given a credit-card payment (debit from checking, credit to card), When it is paired, Then it is excluded from spending — and the card's *purchases* remain the spending, so spending is never counted twice.
  - Given only one leg of a transfer is visible (the counterpart account isn't connected), When Chris marks it as a transfer manually, Then it is excluded from spending/income and flagged as an unmatched transfer.
  - Given amounts differ slightly due to fees or FX, When detection runs within a configurable tolerance (default 1% or $1, whichever is greater), Then the pair is proposed as a *candidate* requiring one-click confirmation rather than auto-applied.
  - Given a transfer pair is confirmed or rejected, When similar pairs appear later, Then the decision informs future matching for that account pair.
- **TX-4** — *As Chris, I want refunds netted so that returns don't look like income.*
  - Given an inflow to a spending account from a merchant with a prior outflow of equal or lesser amount within 120 days, When refund detection runs, Then it is typed as a refund, categorised to the original transaction's category, and reduces that category's spend rather than increasing income.
  - Given a partial refund, When it is applied, Then the category's net spend decreases by the refund amount and both transactions remain individually visible and linked.
  - Given a refund arrives in a later budget period than the original spend, When budgets compute, Then the refund reduces spend in the period it *posted* (default), with an option to attribute it to the original period.
- **TX-5** — *As Chris, I want to split transactions so that a warehouse-store run isn't all "Groceries".*
  - Given a $180 transaction, When Chris splits it into $120 Groceries and $60 Household, Then the split amounts must sum exactly to the parent amount, the parent is excluded from category aggregates, and the children are included.
  - Given a split transaction is later modified by the provider (amount change on posting), When sync applies the change, Then the split is flagged for review rather than silently rescaled, and the transaction is surfaced in the review queue.
  - Given a split transaction is deleted/removed upstream, When cleanup runs, Then all child splits are removed with it.
- **TX-6** — *As Chris, I want foreign-currency clarity so that a trip abroad reconciles.*
  - Given a transaction in EUR on a USD account, When it is displayed, Then both the original amount+currency and the USD amount are shown, along with the rate and rate source used.
  - Given the provider supplies the settled base-currency amount, When storing, Then the provider's settled amount is authoritative and any FX markup is derivable by comparing to the mid-market rate on the transaction date.
  - Given historical reports are run, When FX rates have since changed, Then historical transactions retain the rate captured at transaction time (no retroactive restatement of past spending).
- **TX-7** — *As Chris, I want fast search so that the ledger is usable at scale.*
  - Given 250,000 transactions, When Chris filters by text, date range, account, category, amount range, or tag, Then results render in under 300 ms p95 and the list virtualises without jank.
  - Given a search term, When it matches merchant name, original description, notes, or tags, Then all are searched and the matched field is indicated.
- **TX-10** — *As Chris, I want to exclude one-off distortions so that a car purchase doesn't wreck my averages.*
  - Given a transaction marked excluded with a reason, When trends, budget actuals, and averages compute, Then it is omitted, but net worth and cash-flow *history* still reflect that the money actually moved.
  - Given any excluded transaction, When Chris views a report, Then a footnote states "N transactions excluded" with a link to review them.
- **TX-11** — *As Chris, I want clean merchant names so that the ledger is readable.*
  - Given a raw description like `SQ *BLUE BOTTLE 0123 SAN FRANC`, When it is normalised, Then the display name is "Blue Bottle Coffee", the raw string remains accessible, and the normalisation is reversible/overridable per merchant.
  - Given Chris renames a merchant, When future transactions match the same normalised key, Then they adopt his name.

**Edge cases & rules**

- Amounts stored as **integer minor units** with an explicit currency; no floating point anywhere in money math. Sign convention documented once and enforced (outflow negative).
- **Transfer detection must run before** budget/cash-flow aggregation, and re-run when an account is newly connected (historic pairs may become matchable).
- **Credit card payments, brokerage contributions, and crypto on-ramps are all transfers**, not spending. Brokerage/crypto contributions must still count as *savings rate* — excluded from spending, included in "money to goals".
- A transaction may be simultaneously a transfer *candidate* and a refund *candidate*; precedence order is: explicit user decision > transfer > refund > normal.
- Reimbursements from a person (Venmo/Zelle inflows) are **not** refunds by default — separate treatment, user-configurable.
- Duplicate detection across providers: same account reachable via two Items → dedupe on (normalised description, amount, date ±2 days, account-duplicate-group).
- Timezones: store provider date as a calendar date; do not shift by timezone, or month-boundary spending will drift.

---

### E3 — Categorization & Rules

**Outcome:** Chris corrects a category once and never sees that mistake again. Copilot's per-user learning model is the bar; Monarch's transparent rule engine is the trust mechanism. We want both: **learn automatically, but let the user see and override the logic.**

| ID | Priority | User story |
|---|---|---|
| CAT-1 | M | Get sensible categories automatically on first sync |
| CAT-2 | M | Correct a category and have the system learn from it |
| CAT-3 | M | Create explicit rules with visible, ordered precedence |
| CAT-4 | M | Work a small review queue of low-confidence transactions |
| CAT-5 | M | Customise the category taxonomy (add/rename/merge/archive) |
| CAT-6 | S | Preview a rule's effect before saving it |
| CAT-7 | S | Apply a rule retroactively to existing transactions |
| CAT-8 | S | See why a transaction got its category |
| CAT-9 | C | Tag transactions independently of category (e.g. `trip:japan`) |
| CAT-10 | C | Auto-categorise by merchant across accounts consistently |

**Acceptance criteria**

- **CAT-1** — Given a newly synced transaction, When categorization runs, Then it receives a category and a confidence score in the same pipeline run, and ≥80% of transactions on a cold system land in the correct category (rising to ≥90% after 30 days of corrections — see §8).
- **CAT-2** — Given Chris recategorises a transaction from merchant M, When the next transaction from merchant M arrives, Then it is categorised as Chris chose, with the reason "you categorised Blue Bottle as Coffee".
  - Given Chris recategorises a *second* time differently, When the system learns, Then the most recent decision wins and no rule-thrash occurs (no oscillation across syncs).
  - Given a learned merchant mapping exists, When Chris views Settings → Learned Rules, Then every auto-learned mapping is listed, editable, and deletable.
- **CAT-3** — Given a rule "if description contains X and amount between A and B then category C, tag T", When new transactions match, Then the rule applies deterministically and the rule's ordinal position determines precedence over other matching rules.
  - Given two rules match, When precedence is evaluated, Then the higher-priority rule wins and the UI shows which rule was applied.
  - Given a manual user categorization exists on a transaction, When rules re-run, Then the manual value is never overwritten (explicit user intent is the top of the precedence stack).
- **CAT-4** — Given transactions with confidence below threshold, When Chris opens the review queue, Then they are presented newest-first with one-tap accept/change, and the queue is empty-able in under 2 minutes for a typical week (<15 items).
- **CAT-5** — Given Chris merges category "Coffee" into "Dining", When the merge commits, Then all historical transactions, budgets, and rules referencing "Coffee" are repointed, historical reports remain consistent, and the operation is reversible via backup.
  - Given a category is archived, When new transactions are categorised, Then it is not offered, but historical data retains it.
- **CAT-6** — Given a draft rule, When Chris previews it, Then the UI shows the count and a sample of transactions that would be affected, *before* any write occurs.
- **CAT-8** — Given any transaction, When Chris opens "Why this category?", Then it names the source: `manual` | `rule #N` | `learned merchant mapping` | `model (confidence 0.82)` | `provider default`.

**Edge cases & rules**

- Precedence (highest first): **manual override → user rule (by ordinal) → learned merchant mapping → model prediction → provider category → Uncategorised.**
- Transfers and refunds bypass normal categorization (they have their own types).
- Splits: each split leg carries its own category; rules apply to legs, not the parent.
- Re-running the model on historical data must **never** overwrite manual or rule-derived categories. Backfill jobs touch only `model`-sourced rows.
- Category taxonomy ships with a sane default set (Rocket Money/Monarch-like), but is fully user-owned.
- All categorization runs locally. No transaction text is sent to a third-party model unless Chris explicitly enables an LLM feature and names the endpoint (P1).

---

### E4 — Budgeting

**Outcome:** Budgeting that survives contact with real life. YNAB's zero-based envelope discipline is powerful but high-maintenance and conflicts with P3 (calm); we adopt **flexible category targets + rollover**, and leave strict envelope budgeting as an optional later mode.

| ID | Priority | User story |
|---|---|---|
| BUD-1 | M | Set monthly targets per category and see actual vs target |
| BUD-2 | M | Have budget actuals correctly exclude transfers, include refunds as reductions |
| BUD-3 | S | Get targets suggested from my own trailing history |
| BUD-4 | S | Roll unspent/overspent amounts into the next period |
| BUD-5 | S | Budget non-monthly expenses (annual insurance, quarterly taxes) sanely |
| BUD-6 | S | See a mid-month pace indicator, not just a month-end verdict |
| BUD-7 | C | Group categories into budget groups with group-level targets |
| BUD-8 | C | Copy last month's budget as a starting point |
| BUD-9 | W (v1) | Strict zero-based envelope mode |

**Acceptance criteria**

- **BUD-1** — Given a target of $600 for Groceries in September, When $410 of qualifying transactions have posted, Then the UI shows $410 / $600, $190 remaining, and the period's date boundaries explicitly.
- **BUD-2** — Given a $2,000 transfer from checking to brokerage in the period, When budget actuals compute, Then $0 is attributed to any spending category.
  - Given a $75 refund in a budgeted category, When actuals compute, Then the category's spend decreases by $75 and cannot be driven below $0 by refunds alone without a visible "net negative spend" indicator.
- **BUD-3** — Given ≥3 months of categorised history, When Chris requests suggested targets, Then each suggestion shows the trailing median and the P75 of that category, and identifies which months contained excluded one-offs.
- **BUD-4** — Given rollover is enabled for a category and $50 was unspent in August, When September begins, Then September's available amount is target + $50, and the rollover component is displayed separately from the base target.
- **BUD-5** — Given an annual $1,200 insurance premium, When Chris marks it as a sinking-fund expense, Then $100/month is reserved, the accrued balance is tracked, and in the month the bill hits, it draws from the accrued balance rather than blowing the monthly budget.
- **BUD-6** — Given it is day 10 of a 30-day month with $250 of a $600 target spent, When Chris views the budget, Then a pace indicator shows he is ahead of a linear pace and projects month-end spend based on his own historical intra-month distribution for that category (not naive linear extrapolation).

**Edge cases & rules**

- Period boundaries: calendar month by default; **custom pay-cycle periods** are a Could. Whatever is chosen, transactions are assigned by posted date consistently.
- A transaction that changes amount on posting must move budget actuals in the period it posted.
- Budgets never include investment contributions as *spending* — they appear as savings (see E6/E10).
- Overspend is reported factually, without alarm language (P3).

---

### E5 — Recurring & Subscriptions

**Outcome:** This is the Rocket Money-shaped heart of the product's "waste-killing" value, and one of the strongest near-term ROI features. But per P4, we **detect, price, trend, and advise** — we never cancel or negotiate on his behalf.

| ID | Priority | User story |
|---|---|---|
| SUB-1 | M | Have recurring charges detected automatically |
| SUB-2 | M | See all subscriptions in one place with cost, cadence, next charge, and annualised total |
| SUB-3 | M | Be alerted when a subscription's price increases |
| SUB-4 | M | Confirm, merge, or reject detected series so the list is trustworthy |
| SUB-5 | M | Be told about subscriptions that look unused or low-value |
| SUB-6 | S | See a free-trial converting to paid *before* it charges |
| SUB-7 | S | Get cancellation guidance (where to go, what to click, what I lose) |
| SUB-8 | S | Detect a "zombie" subscription that stopped being charged (cancelled or card expired) |
| SUB-9 | S | See total subscription load as a share of income, trended |
| SUB-10 | C | Manually add a subscription not visible in transaction data |
| SUB-11 | C | Flag duplicate/overlapping services (two music services, three cloud storage plans) |
| SUB-12 | W (v1) | Automated cancellation or bill negotiation on my behalf |

**Acceptance criteria**

- **SUB-1** — Given ≥3 charges from the same merchant at a consistent cadence (monthly ±4 days, or annual ±10 days) with amounts within ±5%, When detection runs, Then a recurring series is created with cadence, mean amount, and a confidence score.
  - Given only 2 observations exist, When detection runs, Then the series is created as *provisional* and is not used to drive alerts until confirmed by a third charge or by Chris.
  - Given charges are variable-amount but regular (utilities, phone), When detection runs, Then a `variable recurring` series is created with an amount range rather than a fixed amount, and is classed as a **bill**, not a **subscription**.
- **SUB-2** — Given confirmed series, When Chris opens Subscriptions, Then each row shows merchant, amount, cadence, last charge, next expected charge date, annualised cost, and lifetime paid-to-date; and the page shows total monthly and annualised subscription spend.
- **SUB-3** — Given a series with mean $9.99, When a charge of $12.99 posts (>5% increase and >$1), Then a price-increase insight is raised stating old price, new price, % change, effective date, and new annualised cost, with the two transactions as evidence.
- **SUB-4** — Given a detected series Chris rejects, When detection re-runs, Then it is not re-created.
  - Given two series are actually the same service billed under different descriptors, When Chris merges them, Then history unifies and cadence is recomputed across the merged set.
- **SUB-5** — Given a subscription whose merchant has produced no other engagement signal and which Chris has not interacted with in the app, When the value review runs, Then it is surfaced with its annualised cost, months paid, total paid to date, and an explicit statement that usage is *not* directly observable — never a fabricated usage claim (P2/P5).
- **SUB-6** — Given a first charge from a merchant of $0.00–$1.00 followed by an expected larger charge, or a known trial pattern, When detected, Then Chris is alerted at least 3 days before the projected first full charge where the data supports a projection.
- **SUB-7** — Given Chris asks how to cancel, When guidance is shown, Then it presents a locally-stored, user-editable playbook (URL, steps, retention-offer notes, what access is lost, billing-period end date) and explicitly states the app will not do it for him.
- **SUB-8** — Given a monthly series with no charge for 2× its cadence, When detection runs, Then it is marked dormant and Chris is asked whether it was cancelled (archive) or failed (potential expired-card problem worth chasing).
- **SUB-9** — Given 12 months of history, When Chris views subscription load, Then it shows subscriptions as a % of net income, trended monthly, with the delta year-over-year.

**Edge cases & rules**

- **Annual subscriptions** must be detected despite sparse data — a single annual charge plus a matching charge 12 months prior (if history allows) creates a series; otherwise it is provisional.
- Amount drift from **tax/FX changes** should not be reported as a price increase; compare pre-tax where derivable, and suppress alerts under materiality threshold.
- **Same merchant, multiple subscriptions** (e.g. two Apple line items) must be separable by amount clustering.
- A subscription charged to a card that later closes must be flagged as *needs re-pointing*, not auto-archived.
- Refunded subscription charges must not inflate lifetime-paid totals.
- Detection runs across **all** accounts, so a service moved from one card to another is recognised as continuing, not as a cancellation plus a new subscription.

---

### E6 — Cash Flow & Bills

**Outcome:** The glance-surface answer to "am I fine?" — a forward-looking daily balance projection and a safe-to-spend number that accounts for bills that haven't hit yet.

| ID | Priority | User story |
|---|---|---|
| CF-1 | M | See a forward projection of my checking balance for the next 30–90 days |
| CF-2 | M | See a safe-to-spend figure that already reserves upcoming bills |
| CF-3 | M | See a calendar/list of upcoming bills with expected amounts and dates |
| CF-4 | M | Be warned before a projected balance goes below my cushion |
| CF-5 | S | See income detected and its regularity (paycheck cadence, amount, variability) |
| CF-6 | S | See a Sankey-style flow of income → spending → savings for a period |
| CF-7 | S | See my savings rate (contributions + debt principal + cash accumulation ÷ net income) |
| CF-8 | S | Be warned when a bill's amount deviates materially from its norm |
| CF-9 | C | Model a one-off future expense into the projection |
| CF-10 | C | See credit-card statement balance vs. projected payment date impact |

**Acceptance criteria**

- **CF-1** — Given detected recurring inflows and outflows plus a discretionary-spend model derived from trailing history, When the projection runs, Then it renders a daily balance line for the next 30/60/90 days with a P10–P90 band, and lists the specific events (bills, paychecks) driving each step change.
  - Given the projection is displayed, When Chris clicks any inflection point, Then the underlying predicted event and its evidence (the recurring series and its history) are shown (P2).
- **CF-2** — Given upcoming bills totalling $1,420 in the next 14 days and a current balance of $3,000 with a $500 cushion setting, When safe-to-spend is computed, Then it shows $1,080 with the arithmetic visible on tap.
  - Given a pending transaction exists, When safe-to-spend computes, Then it is already deducted.
- **CF-3** — Given confirmed bill series, When Chris opens the bills view, Then each upcoming bill shows expected amount (point or range), expected date, source account, and confidence; past-due-but-unseen bills are flagged.
- **CF-4** — Given the projection crosses below the cushion within the horizon, When the check runs, Then exactly one notification is raised per crossing event (not one per recompute), naming the date, the shortfall, and the two largest contributing outflows.
- **CF-5** — Given regular inflows, When income detection runs, Then it identifies pay cadence (weekly/biweekly/semimonthly/monthly), typical amount, and variability, and flags irregular income explicitly rather than assuming a steady salary.
- **CF-7** — Given a period, When savings rate computes, Then the numerator includes transfers to investment/savings accounts and debt *principal* repayment, excludes interest, and the definition used is stated on the figure.

**Edge cases & rules**

- The projection must **not** double-count: a credit-card bill payment and the underlying card purchases are the same money at different times. Card purchases reduce available funds at statement/payment time, not at purchase time, for cash-balance projection purposes.
- Paycheck timing must respect weekends/holidays (biweekly on a Friday that's a holiday lands earlier).
- If a bill's series is dormant or unconfirmed, exclude it from the reserved amount but show it as "possible, unconfirmed".
- Projections degrade gracefully with <60 days of history: show wider bands and say so.

---

### E7 — Net Worth

**Outcome:** One honest line. This is the number Chris will look at most, so its correctness bar is absolute.

| ID | Priority | User story |
|---|---|---|
| NW-1 | M | See total net worth = assets − liabilities, across all connected and manual accounts |
| NW-2 | M | See net worth trended over time with daily granularity |
| NW-3 | M | Break net worth down by account, type, and liquidity |
| NW-4 | M | Have net worth exclude duplicate/excluded accounts correctly |
| NW-5 | S | See the drivers of a period's change (contributions vs market movement vs spending vs debt paydown) |
| NW-6 | S | See net worth in real (inflation-adjusted) terms |
| NW-7 | C | Annotate the timeline with life events |
| NW-8 | C | Compare my trajectory against my own goal path |

**Acceptance criteria**

- **NW-1** — Given accounts with balances, When net worth computes, Then liabilities are subtracted (credit card balances, loans, mortgage), each account's contribution is inspectable, and the as-of timestamp reflects the *oldest* contributing sync (so a stale account can't masquerade as current).
- **NW-2** — Given historical balance snapshots, When the trend renders, Then it shows a daily series; for periods before an account existed, the series must not imply a discontinuity caused merely by connecting the account late — newly connected accounts either backfill their history or the chart marks the connection date.
- **NW-5** — Given a month where net worth rose $8,400, When the attribution runs, Then it decomposes into contributions/savings, investment market movement, debt principal reduction, and spending drawdown, and the components sum to the total change within rounding.
- **NW-6** — Given an inflation series (user-set default rate or an imported index), When real terms are toggled, Then the series is deflated to a stated base period and the assumption is labelled.

**Edge cases & rules**

- **A newly connected account must not appear as a sudden net-worth jump.** Either backfill its balance history or render its contribution as beginning at its data boundary with an explicit marker.
- Closed accounts stop contributing after their closure date and do not create a phantom drop.
- Manual accounts use last-stated value, carried flat forward, visually distinguished from live-valued accounts.
- Crypto and securities are valued at a stated valuation timestamp; never mix a live price with a day-old balance without saying so.

---

### E8 — Investments & Portfolio

**Outcome:** The Wealthfront-shaped half of the product. Move from "here are your balances" to "here is the portfolio you actually hold, and here is what's wrong with it."

| ID | Priority | User story |
|---|---|---|
| INV-1 | M | See all holdings across all brokerage and retirement accounts |
| INV-2 | M | See true asset allocation with look-through into funds/ETFs |
| INV-3 | M | See allocation drift versus my target allocation |
| INV-4 | M | See portfolio performance (time-weighted and money-weighted) over periods |
| INV-5 | M | See concentration risk (single position, single issuer, single sector) |
| INV-6 | S | See fee drag — weighted expense ratio and its dollar cost per year |
| INV-7 | S | See cash drag — uninvested cash sitting in brokerage accounts |
| INV-8 | S | See cost basis and unrealised gain/loss by lot where available |
| INV-9 | S | Get rebalancing guidance that is tax-aware (prefer tax-advantaged accounts, avoid wash sales) |
| INV-10 | S | See dividend/interest income and its trend |
| INV-11 | C | See asset location efficiency (are bonds in taxable when they should be in tax-deferred?) |
| INV-12 | C | Track a benchmark comparison against a chosen index |
| INV-13 | W (v1) | Execute trades or rebalances |

**Acceptance criteria**

- **INV-1** — Given investment accounts, When holdings sync, Then each holding shows symbol, name, quantity, price, price-as-of, market value, and account; and the sum of holdings reconciles to the account balance within a stated tolerance, with any unreconciled residual shown explicitly rather than hidden.
- **INV-2** — Given holdings including ETFs and mutual funds, When look-through runs, Then allocation is reported by asset class (US equity / intl equity / bonds / cash / real assets / crypto / other) using each fund's composition, and any holding lacking composition data is bucketed as `unclassified` and reported as such — never silently assumed.
- **INV-3** — Given a target allocation Chris has set, When drift computes, Then each asset class shows current %, target %, drift in percentage points and dollars, and whether it exceeds his rebalance band (default ±5pp absolute).
- **INV-4** — Given cash flows into and out of accounts, When performance computes, Then **time-weighted return** is reported for comparing to benchmarks and **money-weighted (IRR)** for his actual experience, both labelled, with the periods stated; and a deposit is never reported as a gain.
- **INV-5** — Given holdings, When concentration analysis runs, Then it reports the largest single position as % of total portfolio, flags any position >10% (configurable), and detects issuer overlap across funds (e.g. the same mega-cap held directly *and* via three index funds).
- **INV-6** — Given expense ratios for held funds, When fee analysis runs, Then it reports the asset-weighted expense ratio, the annual dollar cost, and the projected 10/20/30-year cost of that drag at his assumed return — with a concrete cheaper-equivalent suggestion where one exists.
- **INV-9** — Given drift beyond band, When rebalancing guidance is generated, Then it proposes specific buys/sells, **prioritises executing them inside tax-advantaged accounts** to avoid realising gains, warns where a sale would realise a taxable gain (with estimated tax), and flags any proposed purchase that would trigger a wash sale given a loss sale in the prior/following 30 days. The output is guidance only; no order is ever placed (P4).

**Edge cases & rules**

- **Investment accounts return no data through the transactions product** — holdings and investment transactions come from the investments product. Absence of ledger rows must never be presented as "no activity".
- Investment *transactions* (buys, sells, dividends, fees) must not leak into spending/budgets. A dividend is portfolio income, not salary; a buy is not spending.
- Contributions to retirement accounts are transfers for budgeting purposes and savings for goal purposes.
- Stock splits, symbol changes, and mergers must not be misread as buys/sells — reconcile on corporate-action detection or at minimum flag the anomaly.
- Options, RSUs, vesting schedules, and private holdings are manual-entry only in v1.
- Market data licensing: pick a provider whose terms permit personal self-hosted use; delayed (EOD) pricing is acceptable and is the default (P5 — label the as-of).
- Holdings prices and FX: non-USD-denominated securities convert at a stated rate/time.

---

### E9 — Crypto

**Outcome:** Crypto is part of net worth and part of the allocation picture — not a separate toy dashboard.

| ID | Priority | User story |
|---|---|---|
| CRY-1 | M | Connect Coinbase (read-only) and see balances by asset |
| CRY-2 | M | Have crypto included in net worth and asset allocation |
| CRY-3 | S | Track cost basis and unrealised gain/loss per asset |
| CRY-4 | S | Add a read-only on-chain address and see its balance |
| CRY-5 | S | Have on-ramp/off-ramp transfers (bank → exchange) treated as transfers, not spending |
| CRY-6 | S | See crypto as a % of total portfolio with a concentration warning |
| CRY-7 | C | See staking/rewards income separately from price appreciation |
| CRY-8 | C | Manually record holdings for exchanges/wallets with no integration |
| CRY-9 | W (v1) | Full multi-chain DeFi position tracking (LP, lending, NFTs) |

**Acceptance criteria**

- **CRY-1** — Given a read-only Coinbase API key (or an aggregator path where available — Plaid's investments product now covers crypto accounts at supported exchanges such as Gemini, Robinhood and SoFi), When sync runs, Then balances per asset, quantities, and USD values are stored with a valuation timestamp, and the credential is stored encrypted with read-only scope verified at setup.
- **CRY-2** — Given crypto holdings, When net worth and allocation compute, Then crypto appears as its own asset class with its valuation timestamp shown, and the user can choose whether it counts toward the retirement projection's risk assets (default: yes, with a distinct volatility assumption).
- **CRY-3** — Given buy transactions with known prices, When basis computes, Then cost basis per asset is tracked with a stated method (FIFO default, documented), and unrealised gain/loss is shown; where basis is unknown (transferred in from elsewhere), it is explicitly marked unknown rather than assumed zero.
- **CRY-5** — Given a $1,000 debit from checking and a corresponding $1,000 (less fee) deposit at the exchange within 4 days, When transfer detection runs, Then the pair is linked, excluded from spending, counted toward savings rate, and the fee difference is categorised as a fee — not as a discrepancy.
- **CRY-6** — Given crypto is 22% of total portfolio against a 5% target, When the allocation check runs, Then a concentration insight fires with the dollar amount over target and its contribution to portfolio volatility.

**Edge cases & rules**

- **Extreme volatility:** avoid alerting on normal crypto price movement (P3). Materiality thresholds for crypto must be separately tuned, or every day becomes an alert.
- Pricing source and timestamp must be recorded per valuation; 24/7 markets mean "end of day" needs an explicit definition (default 00:00 UTC).
- Transfers *between his own wallets/exchanges* are internal transfers — not disposals, not purchases.
- Self-custody addresses are **watch-only**: the app must never accept, store, or request a private key or seed phrase. This is a hard security requirement (§5.1).
- Tax lot reporting for crypto is informational only and explicitly not tax advice (§6.4).

---

### E10 — Goals & Retirement Planning

**Outcome:** The Wealthfront Path equivalent, self-hosted: connect real accounts, state real assumptions, get a real answer with a range. This is where "holistic wealth goals" gets satisfied.

| ID | Priority | User story |
|---|---|---|
| GOAL-1 | M | Define a retirement goal (target age, target annual spend) and see whether I'm on track |
| GOAL-2 | M | See every assumption behind the projection and edit any of them |
| GOAL-3 | M | See the projection as a probability range, not a single number |
| GOAL-4 | M | Have the projection driven by my *actual* balances, contributions and spending |
| GOAL-5 | M | Run what-if scenarios and save/compare them |
| GOAL-6 | S | Define non-retirement goals (emergency fund, house down payment, sabbatical) with funding progress |
| GOAL-7 | S | See the required-savings answer ("to hit this, save $X/month") |
| GOAL-8 | S | Model Social Security with a claiming-age choice |
| GOAL-9 | S | See the trade-off between a spending change today and my retirement date |
| GOAL-10 | S | Model a drawdown/withdrawal phase with sequence-of-returns sensitivity |
| GOAL-11 | C | Model tax treatment by account type during accumulation and drawdown |
| GOAL-12 | C | Model lumpy events (inheritance, home purchase, college) |
| GOAL-13 | W (v1) | Tax filing, tax-form generation, or formal tax optimisation advice |

**Acceptance criteria**

- **GOAL-1** — Given target retirement age 60 and target spend $85,000/yr in today's dollars, When the projection runs, Then it reports probability of success, the projected portfolio balance path, and the shortfall/surplus at target age in today's dollars.
- **GOAL-2** — Given a projection, When Chris opens Assumptions, Then every input is listed with its current value, its source (`derived from your data` vs `default` vs `you set this`), and is editable: expected real return by asset class, inflation, contribution rate, salary growth, retirement age, life expectancy, Social Security estimate, tax rates, spending in retirement. Changing any assumption re-runs the projection and the previous result remains visible for comparison.
- **GOAL-3** — Given a Monte Carlo run of ≥1,000 trials, When results render, Then P10/P25/P50/P75/P90 bands are shown, the number of trials and the return/volatility model are disclosed, and the headline is a probability of success — never a single deterministic "you will have $X".
  - Given identical inputs and a fixed seed, When the simulation re-runs, Then results are reproducible (deterministic seed) so that Chris can trust that a changed number reflects a changed input, not noise.
- **GOAL-4** — Given connected accounts, When the projection runs, Then starting balances come from actual account data classified by tax treatment, contribution rates are derived from observed transfers over the trailing 12 months (and are overridable), and retirement spending is anchored to his observed non-savings spending (with one-offs excluded).
- **GOAL-5** — Given a baseline, When Chris forks a scenario ("retire at 57", "spend $10k/yr less", "market returns 1pp lower"), Then the fork is saved, named, and displayable side-by-side with the baseline showing the delta in success probability and in retirement date.
- **GOAL-7** — Given a goal with a gap, When the required-savings calculation runs, Then it reports the additional monthly contribution needed to reach a stated success probability (default 80%), and states which levers are available (save more / retire later / spend less / accept more risk) with the magnitude of each.
- **GOAL-9** — Given a candidate action (e.g. cancelling $85/mo of subscriptions and investing it), When the trade-off is computed, Then it reports the effect in concrete terms — e.g. "+$41,000 at age 60, or retirement ~4 months earlier" — with the assumptions used stated inline.
- **GOAL-10** — Given a drawdown phase, When sequence-of-returns sensitivity runs, Then it shows outcome dispersion for poor early-retirement returns and identifies the portfolio's vulnerability window.

**Edge cases & rules**

- **Validation is mandatory:** deterministic outputs must match an independent reference calculator within 1% for a defined set of test cases (§8). Ship the test fixtures.
- Nominal vs real must be unambiguous everywhere; default display is **today's dollars** with a toggle.
- Account-type tax treatment materially changes answers — tie to AC-7 classification.
- Contribution derivation must exclude one-off transfers (a $40k house-deposit move is not a monthly contribution rate).
- Employer match, contribution limits, and catch-up contributions: model if data allows; otherwise expose as editable assumptions rather than ignoring them.
- The app must state clearly, once and non-intrusively, that this is a personal planning tool and not regulated financial advice (§6.4).

---

### E11 — Insights & Advisory

**Outcome:** **The differentiator.** Everything upstream exists to feed this. The Weekly Advisory Brief is the product's signature surface: a short, ranked, evidence-backed set of actions with dollar impact.

| ID | Priority | User story |
|---|---|---|
| ADV-1 | M | Get a Weekly Advisory Brief: a ranked, finite list of actions worth taking |
| ADV-2 | M | See the evidence and arithmetic behind every recommendation |
| ADV-3 | M | See each recommendation's estimated dollar impact (annual and lifetime) |
| ADV-4 | M | Accept, snooze, or dismiss a recommendation — and have that stick |
| ADV-5 | M | Be alerted to anomalies: unusual charges, duplicate charges, new fees |
| ADV-6 | M | Have recommendations tied to my goals, not generic advice |
| ADV-7 | S | See a financial health score with its component breakdown |
| ADV-8 | S | Get a fee hunter: bank fees, overdrafts, ATM fees, FX markups, fund expense ratios |
| ADV-9 | S | Get idle-cash guidance (cash above cushion earning nothing) |
| ADV-10 | S | Get debt guidance (payoff ordering, rate-vs-invest comparison) |
| ADV-11 | S | See a month-in-review narrative explaining what actually changed and why |
| ADV-12 | C | Ask a natural-language question about my own finances |
| ADV-13 | C | Get a quarterly "portfolio checkup" deep report |

**Acceptance criteria**

- **ADV-1** — Given a week of data, When the Brief generates, Then it contains at most 5 recommendations ranked by estimated annual dollar impact × confidence, each with a one-line headline, a dollar figure, and a single primary action; and if nothing material happened, the Brief says so plainly rather than manufacturing filler (P3).
- **ADV-2** — Given any recommendation, When Chris expands "Why am I seeing this?", Then it shows: the specific transactions/holdings used (clickable through to the ledger), the rule or calculation applied, the assumptions, the confidence, and the date range analysed. **A recommendation that cannot render this panel must not be shown** (P2).
- **ADV-3** — Given a recommendation to cancel a $14.99/mo service, When impact is computed, Then it shows $179.88/yr and the long-horizon compounded value at his assumed return over his years-to-retirement, with the assumption stated.
- **ADV-4** — Given Chris dismisses a recommendation with a reason ("I use this"), When the engine re-runs, Then that recommendation is suppressed permanently for that entity; snooze suppresses it for a chosen period; accept marks it done and the engine tracks whether the expected change actually occurred (verification loop).
  - Given Chris accepted "cancel Service X" 60 days ago and charges continue, When verification runs, Then a single follow-up is raised noting the action appears incomplete.
- **ADV-5** — Given a transaction >3σ above the merchant/category norm, or a second identical charge from the same merchant on the same day, or a new fee-type transaction, When anomaly detection runs, Then an alert is raised with the comparison baseline shown; and a materiality floor (default $25) prevents trivial alerts.
- **ADV-6** — Given an active retirement goal, When recommendations are ranked, Then each states its effect on that goal where computable, linking the micro-action to the macro outcome.
- **ADV-7** — Given the health score, When Chris views it, Then it decomposes into named components (emergency-fund months, savings rate, debt-to-income, subscription load, portfolio diversification, fee drag), each with its own value, weight, and direction of travel — no opaque single number.
- **ADV-8** — Given 12 months of history, When the fee hunter runs, Then it totals fees paid by type, names the worst offenders, and quantifies the annual cost of avoidable fees.
- **ADV-9** — Given $42,000 in checking against a $15,000 target cushion, When idle-cash analysis runs, Then it quantifies foregone yield versus a stated reference rate and names the excess amount — while stating the reference rate's source and date.
- **ADV-12** — Given an NL question, When it is answered, Then the answer is generated from a locally-computed result set, cites the underlying data, and **no financial data is sent to an external model** unless Chris has explicitly configured and named a model endpoint (P1). This feature is off by default.

**Edge cases & rules**

- **Cold-start:** with <30 days of data, the Brief must limit itself to what is genuinely computable (subscriptions, fees, allocation, idle cash) and say what it can't yet assess.
- **No fabricated precision.** If usage data doesn't exist, don't imply it (SUB-5).
- Recommendations must be **idempotent and deduplicated** across runs — the same finding must not resurface as "new" each week.
- Ranking must not be dominated by one noisy category; enforce diversity across recommendation types.
- Every recommendation type needs an explicit suppression key so dismissal is meaningful.

---

### E12 — Reports & Export

| ID | Priority | User story |
|---|---|---|
| RPT-1 | M | Export all my data in open formats |
| RPT-2 | S | Run spending reports by category/merchant/time with drill-down |
| RPT-3 | S | Run an income vs expense report for any period |
| RPT-4 | S | Export a filtered transaction set to CSV |
| RPT-5 | S | Produce a year-in-review summary |
| RPT-6 | C | Produce a portfolio report (allocation, performance, fees) as PDF |
| RPT-7 | C | Produce a tax-preparation helper summary (realised gains, dividends, interest, deductible-candidate categories) |
| RPT-8 | C | Access my data via a local read-only API |

**Acceptance criteria**

- **RPT-1** — Given Chris requests a full export, When it completes, Then it produces a single archive containing every user-scoped table as CSV **and** JSON, including transactions, accounts, categories, rules, splits, tags, budgets, goals, assumptions, insights and their dismissal state; and a documented schema file. Re-importing that archive into a fresh instance reproduces the prior state (round-trip test).
- **RPT-2** — Given a date range, When a spending report runs, Then totals exclude transfers, net refunds, and every figure drills down to the contributing transactions.
- **RPT-7** — Given a tax year, When the helper runs, Then it summarises realised gains/losses, dividends, interest, and categories Chris has flagged as potentially deductible — clearly labelled as a *preparation aid, not tax advice*, with the caveat that basis data may be incomplete.

**Edge cases & rules** — Exports must handle 250k+ rows without OOM (stream, don't buffer). Exports contain sensitive data: the UI must warn where the file lands, and offer optional encryption of the archive.

---

### E13 — Notifications

**Outcome:** Rare, batched, material. Every notification is a withdrawal from a trust account.

| ID | Priority | User story |
|---|---|---|
| NOT-1 | M | Receive the Weekly Advisory Brief on a schedule I choose |
| NOT-2 | M | Be alerted to a projected low balance |
| NOT-3 | M | Be alerted when an account needs reconnection |
| NOT-4 | S | Be alerted to a subscription price increase or a converting free trial |
| NOT-5 | S | Be alerted to large/anomalous transactions above my threshold |
| NOT-6 | S | Choose my delivery channel (in-app, email via my own SMTP, webhook/ntfy) |
| NOT-7 | S | Set per-type thresholds and mute anything |
| NOT-8 | C | Quiet hours and digest batching |

**Acceptance criteria**

- **NOT-1** — Given a configured schedule, When it fires, Then the Brief is delivered via the chosen channel, and its content matches the in-app Brief exactly.
- **NOT-5** — Given a threshold of $500, When a $612 charge posts, Then exactly one alert fires; and when it later changes from pending to posted, Then no second alert fires for the same underlying transaction.
- **NOT-6** — Given email delivery, When configured, Then it uses **Chris's own SMTP server** — the app never routes notifications through a vendor service (P1). Notification content is configurable to omit amounts for shoulder-surfing safety.
- **NOT-7** — Given all alert types, When Chris views notification settings, Then every type is individually toggleable with its threshold, and a global cap (default: max 3 non-critical notifications/week) is enforced with overflow rolled into the next digest (P3).

**Edge cases & rules** — Never alert on the same underlying event twice across pending→posted, sync retries, or recompute. Failed deliveries retry with backoff and surface in-app rather than silently dropping. A provider outage produces **one** aggregated alert, not one per account.

---

### E14 — Security & Privacy

**Outcome:** Proportionate to "this is my financial data", provable, and with zero telemetry. Detailed controls in §5.1–5.2; the stories here are the user-visible surface.

| ID | Priority | User story |
|---|---|---|
| SEC-1 | M | Authenticate strongly without daily friction |
| SEC-2 | M | Know that provider tokens and credentials are encrypted at rest |
| SEC-3 | M | Confirm the app sends nothing anywhere except the providers I chose |
| SEC-4 | M | See an audit log of security-relevant events |
| SEC-5 | M | Lock/log out all sessions immediately |
| SEC-6 | S | Require re-authentication for sensitive actions (export, disconnect, credential change) |
| SEC-7 | S | Run with no inbound internet exposure by default |
| SEC-8 | S | Rotate the encryption key and the session secret |
| SEC-9 | S | Have secrets and financial data never appear in logs |
| SEC-10 | C | Encrypt the database at the application layer for the most sensitive fields |

**Acceptance criteria**

- **SEC-1** — Given first-run setup, When Chris creates his account, Then he can register a passkey/WebAuthn credential as the primary factor, with a strong password (Argon2id) plus TOTP as the fallback path; and a session lasts a configurable duration (default 14 days on a trusted device) so normal use is not friction-heavy.
- **SEC-2** — Given provider access tokens and API keys, When they are stored, Then they are encrypted with a key derived from a secret supplied at container start (env/file/secret mount), never stored in plaintext, never committed to backups unencrypted, and never returned by any API response.
- **SEC-3** — Given the running container, When Chris inspects Settings → Data Flows, Then every outbound destination is listed with its purpose and last contact time; and an integration test proves that with the allowlist enforced, no request reaches any host outside it.
- **SEC-4** — Given security events (login success/failure, credential change, export, account disconnect, key rotation, backup/restore), When they occur, Then each is recorded immutably with timestamp, source IP, and outcome, and is viewable and exportable.
- **SEC-5** — Given a "sign out everywhere" action, When invoked, Then all sessions and refresh tokens are invalidated immediately, verified by an existing session becoming unauthorised on its next request.
- **SEC-6** — Given a sensitive action, When invoked more than N minutes after last authentication, Then re-authentication is required before it proceeds.
- **SEC-9** — Given any log level including debug, When logs are inspected, Then no access token, password, API key, session token, or full account number appears; account identifiers are masked to last-4.

**Edge cases & rules** — Backups contain everything; therefore backups must be encrypted by default and restore must require the key (§5.7). Brute-force protection with lockout/backoff. CSRF, strict CSP with no external origins, secure cookie flags, HSTS when TLS is terminated. Never store or accept crypto private keys or seed phrases (CRY-4).

---

### E15 — Settings & Admin

| ID | Priority | User story |
|---|---|---|
| ADM-1 | M | Upgrade the container without manual migration steps |
| ADM-2 | M | Take and restore backups, and verify a restore works |
| ADM-3 | M | See sync health, job history, and failures in one place |
| ADM-4 | M | Trigger a manual sync |
| ADM-5 | M | Configure provider credentials and environment safely |
| ADM-6 | S | See app health/readiness endpoints for my own monitoring |
| ADM-7 | S | Configure personal defaults: currency, cushion, thresholds, categories, fiscal periods |
| ADM-8 | S | Read structured logs at a configurable level |
| ADM-9 | C | Schedule sync frequency and quiet windows |

**Acceptance criteria**

- **ADM-1** — Given a new image version, When the container starts, Then pending schema migrations run automatically, forward-only, inside a transaction where the engine permits; a pre-migration backup is taken automatically; and on failure the app refuses to start in a half-migrated state and reports the failure clearly. No manual `exec` step is ever required for a normal upgrade.
- **ADM-2** — Given a backup schedule, When it runs, Then an encrypted, timestamped, restorable artifact is produced to a configured path; retention is enforced; and a documented `restore` path reconstitutes a working instance. A restore drill is part of the release acceptance tests.
- **ADM-3** — Given sync jobs, When Chris opens sync health, Then each Item/account shows last attempt, last success, duration, rows affected, and the error (with provider error code and a human explanation) for failures, plus a retry action.
- **ADM-5** — Given credentials are supplied via environment or secret files, When the app starts without a required secret, Then it fails fast with an actionable message rather than starting in a degraded state.

---

### E16 — Trading-Research Integration (post-v1)

**Outcome:** Consume research from a **separately versioned, independently updated** Vibe-Trading instance (MIT, Python/FastAPI, exposing REST and an MCP tool surface) without coupling PersonalFi's release cycle to it — and without ever executing a trade (P4).

| ID | Priority | User story |
|---|---|---|
| TRD-1 | W (v1) / M (v2) | Optionally point PersonalFi at my own Vibe-Trading instance |
| TRD-2 | W (v1) | See research/analysis for symbols I actually hold |
| TRD-3 | W (v1) | Have research context include my real position size and cost basis |
| TRD-4 | W (v1) | Keep PersonalFi fully functional when Vibe-Trading is absent, down, or upgraded |
| TRD-5 | W (v1) | Have the integration be strictly read-only — no order placement, ever |
| TRD-6 | W (v1) | Keep advisory recommendations clearly separated from trading signals |

**Acceptance criteria (for the v2 design contract)**

- **TRD-1** — Given no Vibe-Trading URL is configured, When the app runs, Then every trading-research surface is hidden and nothing degrades. The dependency is **optional at runtime and absent by default.**
- **TRD-4** — Given a configured instance that is unreachable or returns an unexpected schema, When PersonalFi calls it, Then the call fails within a short timeout, the failure is contained to the research panel, an anti-corruption layer rejects unrecognised payload shapes, and no other feature is affected.
- **TRD-5** — Given the integration client, When it is built, Then it is capability-restricted to read/analysis endpoints only; order/execution endpoints are not callable, and this is enforced in code and covered by a test.
- **TRD-6** — Given a trading signal from Vibe-Trading, When it is displayed, Then it is visually and semantically distinct from PersonalFi's own advisory output, attributed to the external system, and never counted in the health score or goal projections.

**Edge cases & rules** — The external project updates independently: pin a compatible version range, version the integration contract, and treat schema drift as an expected condition rather than a bug. Credentials for Vibe-Trading are separate from PersonalFi's. Adding it must not expand PersonalFi's egress allowlist beyond a host Chris explicitly configures (P1).

---

## 4. Benchmark Matrix

Legend: **Y** = core strength · **P** = partial/limited · **N** = absent · **$** = paid tier / success fee
Our stance: **Adopt** (build substantially as-is) · **Adapt** (build a changed version, rationale given) · **Skip** (deliberately not building)

| # | Capability | Rocket Money | Wealthfront | Monarch | Copilot | YNAB | Actual | Maybe | **Our stance** | Rationale |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Bank/card aggregation | Y | Y | Y | Y | P | P | P | **Adopt** | Plaid; foundational. Actual/Maybe show self-hosted aggregation is viable but patchier. |
| 2 | Auto-categorization (ML/per-user) | Y | N | Y | **Y** (best-in-class) | P | P | P | **Adopt + Adapt** | Copilot's adaptive model is the bar; we add Monarch's *transparent* rules so the logic is inspectable (P2). |
| 3 | Transparent rules engine | P | N | **Y** | P | Y | Y | P | **Adopt** | Monarch-style rules are the trust layer over the model. |
| 4 | Envelope / zero-based budgeting | N | N | P | P | **Y** | **Y** | P | **Adapt → defer** | YNAB's method is effective but high-maintenance; conflicts with P3. Flexible targets + sinking funds in v1; envelope mode optional later. |
| 5 | Subscription detection & management | **Y** (category-defining) | N | Y | Y | N | N | N | **Adopt + extend** | Core value. We add price-increase tracking, value review, and zombie detection. |
| 6 | Bill negotiation as a service | **Y ($, 35–60% of savings)** | N | N | N | N | N | N | **Skip** | Requires a human service and a fee model. Impossible and undesirable self-hosted. We give negotiation *scripts and leverage data* instead. |
| 7 | One-click cancellation on your behalf | **Y ($)** | N | N | N | N | N | N | **Skip** | Violates P4 (advice, never execution) and needs vendor infrastructure. Replaced by cancellation playbooks (SUB-7). |
| 8 | Recurring bill calendar / forecast | Y | N | Y | Y | P | P | P | **Adopt** | Table stakes for "never be surprised". |
| 9 | Forward cash-flow projection + safe-to-spend | P | P | Y | Y | P | N | N | **Adopt + extend** | We add a probability band and driver attribution (P5). |
| 10 | Net worth tracking & trend | Y ($) | Y | Y | Y | N | P | **Y** (its core) | **Adopt** | Maybe's net-worth-first framing is the right centre of gravity for a holistic app. |
| 11 | Investment holdings sync | P | **Y** | Y | Y | N (manual only) | N | P | **Adopt** | Required for "portfolio trajectory". |
| 12 | Look-through asset allocation & overlap | N | **Y** | P ($ Plus, Morningstar-powered) | P | N | N | N | **Adopt** | Signature. Monarch gates this behind its top tier; we make it core. |
| 13 | Rebalancing guidance | N | **Y** (automated, in-house accounts only) | N | N | N | N | N | **Adapt** | Wealthfront rebalances only assets it custodies. We *advise* across all accounts, tax-aware, no execution (P4). |
| 14 | Fee / expense-ratio drag analysis | N | P | P | N | N | N | N | **Adopt** | High-value, low-effort, almost nobody does it well across *all* accounts. |
| 15 | Retirement projection (Monte Carlo, external accounts) | N | **Y** (Path — free, links external accounts) | P | N | N | N | P | **Adopt** | The single biggest gap in every budgeting app. This is what makes it advisory. |
| 16 | Goal-based planning & what-if scenarios | P | **Y** | Y | P | Y (goal targets) | N | Y | **Adopt + extend** | We add saved, comparable scenario forks and the micro→macro trade-off link. |
| 17 | Crypto tracking | P | P | Y | Y | N | N | Y | **Adopt** | Explicit user requirement; Plaid's investments product now reaches supported exchanges. |
| 18 | Cash-flow Sankey / flow visualisation | N | N | **Y** | P | N | N | P | **Adopt** | Cheap to build, exceptional at making a year legible. |
| 19 | Anomaly / unusual-spend alerts | Y | N | P | Y | N | N | N | **Adopt + extend** | Extended into the fee hunter and duplicate-charge detection. |
| 20 | Financial health score | P | P | P | N | N | N | N | **Adapt** | Only with a fully decomposed, inspectable breakdown — a bare score violates P2. |
| 21 | Credit score monitoring | Y | N | N | N | N | N | N | **Skip** | Requires a bureau relationship; unavailable to a self-hosted single user. |
| 22 | AI assistant / NL Q&A | Y (Rowan agent, Premium Plus) | N | Y (NL assistant, weekly recap) | P | N | N | P | **Adapt (opt-in, local-first)** | Valuable, but off by default and never sending data to an external model without explicit configuration (P1). |
| 23 | Receipt scanning / item-level detail | N | N | Y (2026) | N | N | N | N | **Skip (v1)** | Nice, not advisory. Reconsider post-v1. |
| 24 | Couples / shared household | P | N | **Y** (its differentiator) | P | Y | P | P | **Skip UI, Adopt model** | P7: multi-user readiness in the schema, no sharing UI in v1. |
| 25 | Automated money movement | P (Smart Savings) | **Y** (Self-Driving Money) | N | N | N | N | N | **Skip** | Violates P4. Also requires money-transmission rails. |
| 26 | Trade execution | N | Y | N | N | N | N | N | **Skip** | P4. Vibe-Trading integration is read-only research (E16). |
| 27 | Self-hosted / data sovereignty | N | N | N | N | N | **Y** | **Y** | **Adopt** | The entire premise. Actual and Maybe are the reference implementations for "self-host without misery". |
| 28 | Open data export / API | P | N | P | P | P | **Y** | **Y** | **Adopt** | P6. Full export + documented schema + local read-only API. |
| 29 | Multi-currency | N | N | P | P | P | **Y** | Y | **Adopt (model), defer UI)** | Data model is currency-aware from day one; UI is USD-first. |
| 30 | Tax-lot / tax-aware guidance | N | **Y** (TLH) | P | N | N | N | N | **Adapt** | Surface tax *consequences* of suggested actions; explicitly not tax advice or filing. |

### 4.1 The 10 signature features

These are what make PersonalFi feel like an advisor rather than a ledger. If v1 ships these, it succeeds; if it ships everything else and misses these, it's a nicer Actual Budget.

| # | Signature feature | Why it's advisory, not ledger | Epic |
|---|---|---|---|
| **S1** | **The Weekly Advisory Brief** — ≤5 ranked actions, each with a dollar figure and one primary action | A ledger shows you data; an advisor tells you what to do next, in priority order | E11 |
| **S2** | **Evidence panel on every recommendation** — "Why am I seeing this?" with transactions, formula, assumptions, confidence | Advice you can audit is advice you can trust and act on; it is also the honesty mechanism (P2) | E11 |
| **S3** | **Micro→macro trade-off engine** — "cancelling this $14.99/mo moves your retirement ~4 months earlier" | Connects the trivial decision to the life outcome. No budgeting app does this; no robo-advisor sees your subscriptions | E10/E11 |
| **S4** | **Retirement readiness with editable assumptions and probability bands** | The Wealthfront Path capability, over *all* your accounts, with every assumption in your hands | E10 |
| **S5** | **Scenario sandbox** — saved, named, side-by-side what-if forks of the full projection | Advisors model alternatives; ledgers record the past | E10 |
| **S6** | **Portfolio X-ray** — look-through allocation, issuer overlap, concentration, drift vs target | Reveals the portfolio you actually hold, not the one you think you hold | E8 |
| **S7** | **Fee & drag hunter** — expense ratios, bank fees, FX markups, idle cash, quantified over a 10/20/30-year horizon | Turns invisible, compounding leakage into a number worth acting on | E8/E11 |
| **S8** | **Subscription intelligence** — detection plus price-increase tracking, value review, zombie and duplicate-service detection, annualised load vs income | Goes beyond Rocket Money's list to a judgment about whether each one deserves to exist | E5 |
| **S9** | **Tax-aware rebalancing guidance** — what to trade, in which account, with gain/wash-sale warnings | The most valuable thing a human advisor does mechanically, without the AUM fee or the execution risk | E8 |
| **S10** | **Forward cash-flow projection with safe-to-spend and driver attribution** | Replaces "what did I spend?" with "what will happen, and what's causing it" | E6 |

---

## 5. Non-Functional Requirements

### 5.1 Security

Ties directly to "highly secure — even though I'm using an aggregator, this is my financial data."

| ID | Requirement | Acceptance |
|---|---|---|
| NFR-S1 | **Authentication**: WebAuthn/passkey primary; Argon2id password + TOTP fallback. No default credentials; first-run forces setup. | Fresh install cannot be used without completing credential setup; default-credential scan returns nothing. |
| NFR-S2 | **Secrets at rest**: provider tokens, API keys, and SMTP credentials encrypted with a key supplied at runtime (env var, file, or secret mount), never persisted in plaintext, never in the image. | DB dump inspection reveals no plaintext token; app fails fast if the key is missing. |
| NFR-S3 | **Zero outbound egress beyond an enforced allowlist** (Plaid, market data, crypto sources, user-configured hosts). | Integration test with a deny-all-except-allowlist network proves no other host is contacted. |
| NFR-S4 | **No telemetry, analytics, crash reporting, or update pings that carry data.** No third-party JS, fonts, or CDN assets. | Static asset audit finds no external origins; CSP has no third-party sources; network capture at idle shows zero outbound traffic. |
| NFR-S5 | **Least-privilege provider scopes**: read-only where the provider offers it; no payment-initiation or transfer scopes requested. | Scope configuration reviewed and documented per provider. |
| NFR-S6 | **Container hardening**: non-root user, read-only root filesystem where feasible, no unnecessary packages, dropped capabilities, minimal Alpine base, pinned digests, SBOM published per release. | Image scan shows non-root default user, no high/critical CVEs at release, SBOM artifact exists. |
| NFR-S7 | **Transport**: TLS supported/expected; secure cookie flags, HSTS when TLS-terminated, strict CSP, CSRF protection, no mixed content. | Automated header check in CI. |
| NFR-S8 | **Audit log** of security-relevant events, append-only, exportable. | Events for login, credential change, export, disconnect, key rotation, restore are present and tamper-evident. |
| NFR-S9 | **No secrets or financial data in logs** at any level. | Log scrubbing tested with a debug-level run against a fixture dataset. |
| NFR-S10 | **Never accept or store private keys/seed phrases.** Watch-only addresses only. | No input field, API field, or storage column exists for key material. |
| NFR-S11 | **Dependency hygiene**: pinned dependencies, automated vulnerability scanning, documented patch SLA (critical ≤7 days). | CI gate + release notes. |
| NFR-S12 | **Rate limiting & brute-force protection** on all auth endpoints. | Lockout/backoff verified by test. |

### 5.2 Privacy

- **No telemetry of any kind** — this is a product principle (P1), not a setting. There is no opt-out because there is nothing to opt out of.
- **Settings → Data Flows** page enumerates every external destination, what is sent, why, and when it was last contacted. This is the user-visible proof of NFR-S3.
- Any future LLM/AI feature is **off by default**, requires an explicitly configured endpoint, states exactly what leaves the machine, and supports a fully local model.
- Data minimisation: request only the provider products actually in use; do not store provider payload fields the app never uses.
- Deleting an institution offers true deletion (purge) as well as retention.

### 5.3 Performance

Targets assume modest home-server hardware (≈4 cores, 8 GB RAM) and a dataset of 25 accounts / 250,000 transactions / 500 holdings.

| Operation | Target (p95) |
|---|---|
| Dashboard first meaningful paint (warm cache, LAN) | < 1.5 s |
| Dashboard API aggregate response | < 800 ms |
| Transaction list filter/search | < 300 ms |
| Net worth trend (2y, daily) render | < 1 s |
| Monte Carlo, 1,000 trials × 40 years | < 3 s (< 10 s at 10,000 trials) |
| Full sync, 15 Items | < 3 min, incremental sync < 45 s |
| Recategorisation of 250k rows (rule backfill) | < 60 s, as a background job with progress |
| Container cold start to ready | < 20 s including migrations |
| Idle memory footprint | < 1 GB total across services |

Long operations run as observable background jobs with progress — never as a blocking request.

### 5.4 Availability & graceful degradation

- It is a home server: **no HA, no clustering, no five-nines promise.** Target is "restart-safe and honest".
- **Provider outage** → the app remains fully usable on last-known-good data; every affected figure is labelled stale with its as-of time; one aggregated notification, not one per account; automatic retry with exponential backoff and jitter.
- **Market data unavailable** → holdings show last known prices with timestamps; allocation and net worth still render; projections still run and say which inputs are stale.
- **Partial sync success** is normal, not an error state: per-Item status, not a global pass/fail.
- Crash/restart must not corrupt sync state: cursors advance only on committed batches (TX-1).
- A failed migration must leave the app refusing to start rather than running half-migrated (ADM-1).

### 5.5 Data portability

- Full export in CSV **and** JSON, plus a documented schema (P6, RPT-1); round-trip import verified by test.
- Direct database access is supported and documented — no obfuscation, no proprietary encoding of user data.
- Import paths: CSV with column mapping, OFX/QFX; duplicate-safe (AC-10).
- No feature may depend on a cloud service such that export loses fidelity.

### 5.6 Accessibility & i18n

- **WCAG 2.2 AA**: keyboard operable end-to-end, visible focus, 4.5:1 contrast, semantic landmarks, screen-reader labels on every chart with a data-table equivalent.
- Charts must not encode meaning by colour alone (colour-blind-safe palettes; red/green gains/losses always paired with sign or shape).
- `prefers-reduced-motion` and `prefers-color-scheme` respected; dark mode is first-class.
- Responsive from 360 px to ultrawide; touch targets ≥44 px; the mobile glance surface is designed, not merely reflowed.
- **i18n readiness**: all user-facing strings externalised in ICU-format catalogs from day one; locale-aware date/number/currency formatting; multi-currency data model; RTL-safe layout primitives. Only `en-US` ships in v1 — readiness, not translation.

### 5.7 Backup / restore

- **Automated, encrypted, scheduled backups** to a configurable path/volume, with retention policy (default: 7 daily, 4 weekly, 6 monthly).
- **Pre-upgrade backup is automatic and mandatory** before migrations run.
- **Restore is a documented, tested, single-command path**; a restore drill is part of every release's acceptance checklist (an untested backup is not a backup).
- Backups include the encrypted secrets material only if the operator opts in; otherwise restore requires supplying the key — documented explicitly so Chris cannot lose access accidentally.
- Backup integrity verified by checksum; the app reports last successful backup age and warns if it exceeds the schedule.
- **RPO ≤ 24 h, RTO ≤ 1 h** (documented targets for a single-node home deployment).

### 5.8 Upgrade path

- **Zero-touch schema migrations**: run automatically on container start, forward-only, idempotent, transactional where the engine allows, with a pre-migration backup (ADM-1).
- Semantic versioning; release notes state any breaking change and any manual step (the goal is zero manual steps).
- The app refuses to start against a database newer than the binary (prevents accidental downgrade corruption).
- Migrations tested against a realistic fixture database in CI, including a multi-version jump (skipping releases must work).
- Rollback policy documented: restore the pre-migration backup; forward-only migrations mean downgrade is a restore, not a reverse migration.
- MIT licence; dependency licences audited for compatibility (permissive only) and listed per release.

---

## 6. MVP Definition & Release Ladder

### 6.1 MVP thesis

The MVP is **not** "connect accounts and see transactions" — that is Actual Budget and it delivers no advisory value. The smallest slice that is genuinely advisory is:

> **Connect accounts → get a trustworthy ledger (transfers and duplicates handled) → detect every subscription and recurring bill → project cash flow forward → project retirement with editable assumptions → and deliver a Weekly Advisory Brief of ≤5 evidence-backed actions, each showing its dollar impact and its effect on the retirement date.**

That chain is the minimum that lets Chris say "it told me something I didn't know, and I acted on it." Everything else (budgets, reports, Sankey, crypto depth, portfolio X-ray refinements) can follow.

### 6.2 Release ladder

| Rung | Name | Contents | "Done" means |
|---|---|---|---|
| **v0.1** | *Foundation* | Alpine Docker compose stack; auth (password + TOTP); encrypted secrets; Plaid Link + Item storage; account list; balances; net worth (point-in-time); automated migrations; backup/restore; audit log. | Chris connects one institution, sees correct balances and net worth, restarts the container without data loss, and restores from a backup successfully. Zero outbound traffic outside the allowlist. |
| **v0.2** | *Trustworthy ledger* | `transactions/sync` incremental ingest; pending→posted resolution; **transfer pairing**; refund netting; duplicate detection; merchant normalisation; fast search/filter; manual accounts; closed accounts; reconnect (update mode). | A month of real data reconciles: spending totals contain **zero** internal transfers, no duplicates, pending transactions resolve cleanly. This is the trust gate — nothing downstream is believable until it passes. |
| **v0.3** | *Understanding* | Auto-categorization + learning + rules engine + review queue; category taxonomy; splits; tags; exclusions; net worth trend with history. | ≥85% auto-categorization accuracy on Chris's real data; the weekly review queue clears in <2 minutes. |
| **v0.4** | *Recurring & forward-looking* | Subscription/bill detection, confirm/merge/reject, price-increase alerts, annualised load; upcoming bills; forward cash-flow projection; safe-to-spend; low-balance warning. | Every real subscription Chris can name is detected (recall ≥0.85, precision ≥0.95); the 30-day projection is directionally correct against the following month's actuals. |
| **v0.5** | *Portfolio* | Holdings sync; look-through allocation; target allocation & drift; concentration; TWR/MWR performance; fee drag; idle cash; crypto via Coinbase read-only; crypto in net worth and allocation. | Holdings reconcile to account balances within tolerance; allocation matches a manual spreadsheet check; crypto on-ramps are correctly classified as transfers. |
| **v0.6** | *Planning* | Retirement goal; assumptions panel; deterministic + Monte Carlo projection with bands; required-savings; scenario forks; secondary goals (emergency fund, etc.). | Deterministic output matches an independent reference calculator within **1%** on the shipped fixture cases; Monte Carlo is reproducible with a fixed seed. |
| **v0.7** | *Advisory* | Insight engine; **Weekly Advisory Brief**; evidence panel on every recommendation; dollar-impact and retirement-date trade-off; accept/snooze/dismiss with persistence and verification; anomaly + fee hunter; health score with breakdown. | The Brief produces ≥3 recommendations Chris judges genuinely useful in its first month, and **every** recommendation renders a complete evidence panel. |
| **v0.8** | *Budget & report* | Flexible category targets, rollover, sinking funds, pace indicator; spending/income reports; Sankey; year-in-review; full export + CSV/OFX import. | Budgets exclude transfers and net refunds correctly; full export round-trips into a clean instance with identical state. |
| **v0.9** | *Polish & harden* | Notifications (channels, thresholds, caps, quiet hours); accessibility pass to WCAG 2.2 AA; performance pass to §5.3 targets; mobile glance surfaces; security review; docs (install, upgrade, backup, restore, threat model). | All §5.3 performance targets met on target hardware; automated a11y checks pass; security review closed; a stranger could install it from the README. |
| **v1.0** | *PersonalFi 1.0* | Stabilisation; 90 days of Chris's real usage; migration path validated across a multi-version jump; SBOM; MIT licence and dependency audit. | Chris has used it as his **only** finance tool for 90 days without falling back to spreadsheets or a competitor app; §8 metrics met; upgrade from v0.1 → v1.0 works unattended. |
| **v1.x** | *Trading research* | Vibe-Trading integration (E16): optional, read-only, isolated by an anti-corruption layer, absent by default. | PersonalFi is fully functional with the integration unconfigured, broken, or version-drifted. |

### 6.3 Cut lines

If schedule pressure hits, cut in this order: Sankey (RPT/CF-6) → health score (ADV-7) → sinking funds (BUD-5) → tax-aware rebalancing detail (INV-9 reduces to drift alerts only) → crypto cost basis (CRY-3). **Never cut:** transfer pairing (TX-3), evidence panels (ADV-2), backup/restore (ADM-2), or projection validation (GOAL-1/§8).

### 6.4 Explicitly OUT of scope for v1

| Out of scope | Why |
|---|---|
| **Bill negotiation** | Requires a human service and a success-fee business model; impossible self-hosted. We ship negotiation *leverage data and scripts* instead. |
| **Automated subscription cancellation** | Violates P4; requires vendor infrastructure and credential handling we refuse. Playbooks only. |
| **Trade execution / order routing** | Violates P4. Even the Vibe-Trading integration is read-only. |
| **Any money movement** (transfers, auto-save, bill pay) | Violates P4; would require payment scopes and money-transmission considerations. |
| **Multi-user / household sharing UI** | Single user by requirement. Schema is ready (P7); UI is not built. |
| **Tax filing or tax-form generation** | Regulatory and correctness burden far exceeds value. A *tax-prep helper summary* (RPT-7) is the ceiling. |
| **Formal/regulated financial advice** | This is a personal planning tool. Disclaimer stated once, clearly, non-intrusively. |
| **Credit score / credit monitoring** | Requires a bureau relationship unavailable to a self-hosted single user. |
| **Native mobile apps** | Responsive PWA covers the glance use case at a fraction of the cost. |
| **Receipt scanning / OCR / item-level purchase detail** | Pleasant, not advisory. Post-v1 candidate. |
| **Insurance, estate planning, college planning** | Scope discipline. Retirement is the goal that matters here. |
| **Full DeFi / NFT / multi-chain position tracking** | Long tail of integration effort for a small share of net worth. Watch-only balances only. |
| **Public multi-tenant hosting** | Not the product. |

---

## 7. Open Questions

Every question carries a **recommended default** so that no answer is a blocking answer — work proceeds on the default and the answer becomes a (cheap) change.

### 7.1 Must answer before build

| # | Question | Recommended default | Why it's blocking |
|---|---|---|---|
| Q1 | Country of tax residence and state? | **US, with one configurable state** | Determines retirement account types, Social Security modelling, and tax assumptions throughout E10. |
| Q2 | Base currency, and do you hold non-USD assets? | **USD base; currency-aware data model; USD-only UI in v1** | Cheap now, expensive to retrofit. Model must be right from schema v1. |
| Q3 | Individual or household finances — and will a partner ever need access? | **Individual now; `owner_id` on every user-scoped row so multi-user is additive later (P7)** | A missing ownership dimension is a full-schema migration later. |
| Q4 | Which institutions and roughly how many accounts? Any Plaid can't reach? | **Assume ~12 accounts / ~8 institutions; manual accounts cover the gaps** | Sizes sync architecture, perf budgets, and whether a second aggregator is needed. |
| Q5 | Plaid environment and cost tolerance — Sandbox → Production, and which products (transactions, investments, liabilities)? | **Develop against Sandbox; Production with transactions + investments + liabilities; accept per-Item pricing** | Products chosen determine which epics are even possible; Production access has lead time. |
| Q6 | Crypto: exchange accounts only, or self-custody too? Which exchanges? | **Coinbase via read-only API key; watch-only addresses for self-custody; manual entry otherwise. Never any key material (NFR-S10).** | Determines whether E9 needs on-chain indexing at all. |
| Q7 | Budgeting philosophy: strict envelope (YNAB) or flexible targets? | **Flexible category targets + rollover + sinking funds; envelope mode deferred** | Rewriting the budget model mid-build is expensive; it also sets the app's whole personality (P3). |
| Q8 | Authentication appetite: passkey, password+TOTP, or both? Session length? | **Passkey primary + password/TOTP fallback; 14-day session on a trusted device** | Auth is foundational and unpleasant to change after data exists. |
| Q9 | Network exposure: LAN/VPN only, or public with a reverse proxy? | **LAN/VPN-only by default; public ingress documented as an opt-in hardened path** | Sets the security bar (NFR-S7) and the threat model doc. |
| Q10 | Retirement inputs: target retirement age, target annual spend, current contribution rates, Social Security expectation? | **Derive from data where possible; ask once in an onboarding wizard; defaults: age 65, spend = observed non-savings spend, SS at full retirement age** | E10 is meaningless without them, but the wizard design depends on how much you want to be asked. |
| Q11 | Target allocation for the portfolio (for drift/rebalancing)? | **Ask during onboarding; default to current allocation as the target until set, with drift alerts suppressed until an explicit target exists** | INV-3/INV-9 are inert without it, and a wrong default produces noisy false advice. |
| Q12 | How much history do you want, and do you have pre-Plaid records to import? | **Request the maximum provider window (730 days); ship CSV/OFX import at v0.8** | Affects whether the import path is v1 or v2, and trend-analysis credibility. |

### 7.2 Can defer

| # | Question | Recommended default | Defer until |
|---|---|---|---|
| Q13 | Notification channels — email via your SMTP, ntfy/webhook, or in-app only? | **In-app + webhook; SMTP optional** | v0.9 |
| Q14 | Do you want an AI/NL assistant, and would you run a local model? | **Build the deterministic engine first; NL layer opt-in, off by default, local-model-capable (P1)** | Post-v1 |
| Q15 | Market data provider preference and licensing tolerance? | **EOD pricing from a provider whose terms permit personal self-hosted use; delayed data is fine (P5)** | v0.5 |
| Q16 | Mobile: is responsive PWA enough, or do you want installable/offline? | **Responsive PWA with installability; no native app** | v0.9 |
| Q17 | How aggressive should anomaly alerting be? | **Materiality floor $25 and 3σ; tune against real data after 60 days** | v0.7, then tuned empirically |
| Q18 | Should crypto count as risk assets in the retirement projection? | **Yes, with a distinct volatility assumption; toggleable** | v0.6 |
| Q19 | Rebalancing bands and tax sensitivity? | **±5pp absolute band; prefer tax-advantaged accounts; warn on realised gains and wash sales** | v0.5 |
| Q20 | Vibe-Trading: which parts do you actually want — research, backtests, signals? | **Read-only research and analysis for held symbols; no signals in the health score or projections (TRD-6)** | v1.x |
| Q21 | Retention: keep data forever, or prune? | **Keep everything; disk is cheap and history is the product's raw material** | Post-v1 |
| Q22 | Do you want a local read-only API for your own scripting? | **Yes — token-scoped, read-only, off by default** | Post-v1 |
| Q23 | Envelope budgeting mode later? | **Revisit after 90 days of real use; only if flexible targets prove insufficient** | Post-v1 |

---

## 8. Success Metrics

Single-user products can't use DAU/retention/NPS. These metrics measure **correctness, usefulness, and low burden** — and each is measurable on Chris's own instance.

### 8.1 Correctness (the trust floor — non-negotiable)

| Metric | Target | How measured |
|---|---|---|
| Transaction auto-categorization top-1 accuracy | ≥80% cold; **≥90% after 30 days**; ≥95% after 90 days | Corrections ÷ categorised transactions, rolling 30 days |
| Internal transfer pairing accuracy | **≥98%**; false-positive rate <1% | Manual audit of a 200-transaction sample per release |
| Phantom spending from transfers | **Zero** internal transfers in any spending total | Automated invariant test on the fixture dataset + monthly reconciliation |
| Duplicate transactions in the ledger | **Zero** | Uniqueness invariant test; monthly audit query |
| Subscription detection | **Precision ≥0.95, recall ≥0.85** | Against a hand-built ground-truth list of Chris's known subscriptions |
| Pending→posted resolution | 100% resolve without duplication or lost user edits | Automated test + weekly audit query |
| Holdings reconciliation to account balance | Within 0.5% or explicitly surfaced as a residual | Per-sync invariant check |
| Retirement projection vs reference calculator | **Within 1%** on all shipped deterministic fixture cases | CI test against an independent calculator's published outputs |
| Monte Carlo reproducibility | Bit-identical for a fixed seed | CI test |
| Net worth vs manual reconciliation | Within 0.1% monthly | Monthly manual check for the first 3 months |

### 8.2 Usefulness (is it actually advisory?)

| Metric | Target |
|---|---|
| **Time-to-first-insight**: first account connected → first genuinely useful, evidence-backed recommendation | **< 15 minutes** |
| Recommendations Chris rates useful (thumbs/accept) in the Weekly Brief | **≥60% useful; ≥3 acted upon in the first 30 days** |
| Recommendations dismissed as "obvious" or "wrong" | <20% |
| Measured annual savings identified in year 1 (subscriptions + fees + idle cash + fund expense ratios) | **≥$1,000 identified**, with evidence |
| Recommendation follow-through verified (accepted action actually occurred in the data) | ≥70% |
| Questions Chris can answer in PersonalFi that previously required a spreadsheet | ≥5 (net worth trend, savings rate, retirement probability, true allocation, subscription load) |
| Fallback to a spreadsheet or a competitor app | **Zero occurrences in the final 90 days before v1.0** |

### 8.3 Burden (does it stay calm?)

| Metric | Target |
|---|---|
| Manual interventions per week (recategorisations, confirmations, queue clearing) | **< 10 at v0.4; < 5 by v1.0** |
| Weekly review ritual duration | **< 10 minutes** |
| Non-critical notifications per week | **≤ 3** (hard cap, NOT-7) |
| False-alarm rate on anomaly alerts | < 20% |
| Uncategorised transactions at any time | < 2% of trailing 90 days |

### 8.4 Operational

| Metric | Target |
|---|---|
| Scheduled sync success rate | **≥99%** of runs complete or degrade gracefully |
| Unattended upgrade success (including migrations) | **100%** — any manual step is a defect |
| Successful restore drills | 100% of releases |
| Unplanned data loss events | **Zero** |
| §5.3 performance targets met on target hardware | 100% at v0.9 |
| Outbound requests to non-allowlisted hosts | **Zero** (automated network test per release) |
| Known critical/high vulnerabilities at release | **Zero** |
| Mean time to repair a broken Plaid connection (from notification to healthy) | < 2 minutes of Chris's time |

---

## Appendix A — Benchmark sources

- Rocket Money — subscription detection/cancellation, bill negotiation (35–60% success fee), net worth and budgeting in Premium, Rowan AI agent (Aug 2026): [Motley Fool review](https://www.fool.com/money/personal-finance/rocket-money-review/), [Rob Berger review](https://robberger.com/rocket-money-review/), [Penny Hoarder review](https://www.thepennyhoarder.com/budgeting/rocket-money-review/)
- Wealthfront — Path planning over linked external accounts, retirement projections, Self-Driving Money: [Wealthfront Planning](https://www.wealthfront.com/planning), [How Path generates retirement advice](https://support.wealthfront.com/hc/en-us/articles/115000627183-How-does-Wealthfront-come-up-with-its-retirement-advice), [Portfolio return projections](https://support.wealthfront.com/hc/en-us/articles/211003503-How-do-you-project-my-portfolio-s-returns-in-the-graph)
- Monarch vs Copilot vs YNAB — investment sync, subscription manager, rules engine, Sankey cash flow, 2026 AI additions, Morningstar-powered analysis in Monarch Plus: [WalletHub comparison](https://wallethub.com/edu/b/ynab-vs-monarch-vs-copilot-vs-wallethub/150687), [Monarch 2026 review](https://walletgrower.com/blog/monarch-money-review-2026), [Copilot vs Monarch](https://getfinny.app/blog/copilot-money-vs-monarch-money-2026), [Best budgeting apps 2026](https://www.engadget.com/apps/best-budgeting-apps-120036303.html)
- Actual Budget & Maybe — self-hosted posture, envelope method, multi-currency, rules, REST API, net-worth-first framing: [Open source budgeting tools](https://impause.com/blog/open-source-budgeting-software-6-free-private-tools-2026), [Open source Maybe alternatives](https://openalternative.co/alternatives/maybe)
- Plaid — `/transactions/sync` cursor model, 730-day `days_requested` ceiling, `pending_transaction_id` linkage, update statuses, investment accounts omitted from transactions: [Transactions API](https://plaid.com/docs/api/products/transactions/), [Transaction states](https://plaid.com/docs/transactions/transactions-data/), [Transactions intro](https://plaid.com/docs/transactions/)
- Plaid crypto coverage — digital asset exchanges via the Investments product: [Leading digital asset exchanges join the Plaid network](https://plaid.com/blog/digital-asset-exchanges/)
- Vibe-Trading — MIT, Python 3.11+/FastAPI, REST + MCP tool surface, broker integrations (execution deliberately unused here): [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)
