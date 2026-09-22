# Phase 3 dispatch — investments, crypto, net worth, market data

*Written 2026-09-21 at `5a96871`, while the Phase 2 gate finishes Standards C and D. Companion to
[`01-execution-log.md`](01-execution-log.md), which stays the orchestrator's ledger; this file is the
work-package breakdown, wave plan and gate standard for Phase 3. Plan of record remains
[`00-master-implementation-plan.md`](00-master-implementation-plan.md).*

---

## 1. Goal, exit criteria, rungs

**Goal (master plan §5).** Phase 3 — Investments, crypto, net worth, market data (12–18 days). Deliverables:
Investments context (securities with `SecurityResolver` via OpenFIGI, holdings and snapshots, investment
transactions, cost-basis lots with FIFO/LIFO/HIFO/specific-ID, corporate-action splits, asset-profile
overrides); `CoinbaseConnector` (Advanced Trade v3, CDP JWT, `key_permissions` assertion at startup) with
the **v3 ledger-gap prototype done first**; `WalletRpcConnector` for watch-only BTC and ETH; price + FX
ingestion (Tiingo, FRED, CoinGecko with attribution) with source priority and staleness flags;
`net_worth_daily` with seal semantics; net worth, allocation, holdings aggregated by ticker across accounts,
TWR and MWR, fee drag, idle cash, concentration, drift vs target; insights I1–I10 and debt rules D1–D6.

**Exit criteria, verbatim from §5:**

> net worth reconciles to a hand computation across every account type including a manual asset and a
> liability; a past date's net worth is immutable across a re-run; ETH on Coinbase and in a wallet resolves
> to one security; a missing FX rate surfaces rather than defaulting; allocation matches a spreadsheet check.

**Rung reached (§2.3).** **v0.5** "Portfolio" — *"Holdings reconcile to balances; allocation matches a
spreadsheet check; crypto on-ramps classified as transfers."* The third clause is the one nobody plans for:
a USD deposit into Coinbase followed by a BTC buy is **one transfer plus one trade**, never $5,000 of spending
in a "Crypto" category. A WP 3.5 exit test and a gate walk item, not a nicety.

**What Phase 3 does not do.** Projections and Monte Carlo (Phase 4), the Weekly Brief and the `local_model`
advisor (Phase 5), Vibe-Trading (Phase 6), tax-lot *optimization* and tax reporting (Phase 3 stores enough
lot detail that a later phase could, and claims nothing about tax). §2.3's cut order puts **crypto cost
basis last**: if the phase runs long, holdings-level crypto valuation ships and lot-level basis is carried.

---

## 2. Phase 2 carry-overs Phase 3 must absorb

| Item | Source | Disposition |
|---|---|---|
| **AT_RISK ruling** — WP 2.2 metric #7: `LIKELY_CANCELED` at 1.67 periods cannot beat 07 §2.8's literal 1.5 without changing the dormancy ladder | wp2.2 §9.4 | **Blocked on the Phase 2 gate verdict.** If the gate rules the ladder must change, it is a one-file change in `packages/contexts/recurring/src/` and lands in **WP 3.13**; if it rules the interpretation stands, 3.13 records it and closes. Phase 3 does not dispatch 3.13 until the verdict exists. |
| **Impact-ceiling ruling** — WP 2.7 found a poisoned $1,412,000 figure passing all seven validator steps because it was faithfully traced; the ceiling *withholds* rather than clamps, and the plan's test name says "clamped and logged" | wp2.7, gate §2.7 → "See the ruling in §5" (unwritten) | **Blocked on the gate verdict**, then **WP 3.13**. Phase 3 needs the answer before WP 3.10 writes fifteen new `$`-impact formulas over portfolio values, which are the largest numbers in the app and therefore the ones most likely to hit the ceiling legitimately. |
| **`?encrypt=true` never exercised** — `encryptWithAge` in `apps/api/src/routes/export.ts:117–125` falls back to `export.encryption_unavailable`; no `age` binary on the dev host | wp2.8, execution log 2026-09-19 21:00 | **WP 3.13** (install `age` in the api image or prove the documented degradation is the intended one) **and a gate walk item**: the cold `down -v` walk downloads an encrypted export and decrypts it. An untested branch on the export path is a data-recovery path nobody has walked. |
| **Multi-user taxonomy seeding** — `ensureTaxonomy` takes a list, `app.ts` supplies `findPrimary()`'s single answer | Phase 1 closeout §4, deferred in 02 §2 | **Deferred again, same reason.** Blocked on Identity growing a user enumeration (D6: additive, not built). No Phase 3 WP needs a second user; `net_worth_daily` and `holdings` are `user_id`-scoped from their first migration, so nothing Phase 3 writes makes it harder. |
| **`POST /categories` + create-from-combobox** | Phase 1 closeout §4, 02 §2 | **Closed by WP 2.5 and WP 2.11** (`apps/api/src/routes/categories.ts:102`, `apps/web/src/features/transactions/CategoryPicker.tsx`). Listed so it is not re-opened; **re-confirm at Phase 3 start, do not open a WP**. |
| **Notification delivery never proven end to end against a real host** — every egress proof was a refusal; no successful ntfy or SMTP send has been observed from inside the worker container | wp2.4 §10.1/§10.3, gate Standard C pending | **WP 3.13** adds a `mailpit` SMTP sink and an `ntfy` container behind the `dev-sinks` compose profile so a *successful* delivery is observable without Chris's real topic, and the **gate walks it**. §6 Q4 asks whether Chris would rather point at a real ntfy topic. A control proven only in the refusal direction is half a control. |
| **Kill-switch defaults** — `module.insights` ships `true`-but-inert until `advisor_token_secret` is mounted; the four-level switch has no Phase 3 owner and no documented default per level | execution log 2026-09-20 07:30, wiring 0cf642c | **WP 3.13** writes the defaults into `apps/api/src/platform.ts` and `docs/RUNBOOK.md` and asserts them; Phase 3 adds **`module.investments`** and **`module.integrations`**, both `defaultEnabled: false` until their consumers are registered and green (WP 3.14 proves flag-off registers nothing, the 2.13 pattern). |
| **Inbox's third queue has no data source** (`pending_review` has no reader); **`price_change_events` not projected onto `GET /recurring/series`**; **`advisor_version` absent from the evidence panel** | wp2.11 §5, wp2.10 §7 | **All three to WP 3.13; the first is stale as written — verify first.** `apps/api/src/routes/insights.ts` now exists (WP 2.r, `28b81f1`); what is missing is a `pending_review` *filter* on it, or `categoryConfidence` on `GET /transactions`. 3.13 deletes the stale claim from `wp2.11-inbox-ui.md` §5. The other two are one route field each; their UI is folded into WP 3.11 rather than given a frontend agent. |
| **`@core/secretbox` is not a dependency of `@ctx/insights`** — merchant pseudonyms use `configHash` (a keyed hash, not an HMAC); changing the construction later re-pseudonymises every merchant and orphans every stored `MERCHANT_…` evidence ref | wp2.6 §8 carried 2 | **WP 3.13, and it must be decided in Phase 3, not Phase 5.** The cost of the change is monotonically increasing in the number of stored evidence rows, and Phase 3's I-rules will write more of them than Phase 2's did. |
| **`budget_date` has no user override** (07 §1.4 wants three dates, the third overridable) | wp2.1 §12.1 | **Deferred to Phase 9's polish pass.** It is a `@ctx/ledger` column plus an `OverlayPatch` field plus a UI control, touching the one context Phase 3 reads hardest; opening `transactions` mid-phase while WP 3.7 is writing investment transactions is how two agents collide. |
| **Standard-price table** (07 §2.7 trial conversion, WP 2.2 metric #8); **no confirm-refund route** (`detectRefundHints` has no wrapper); **`scripts/lint-advice-copy.ts` never created** (the linter is `src/advisors/copy-lint.ts` and runs in CI) | wp2.2 §9.1, wp2.3 §10, wp2.8 §11.4, wp2.7 §10.1 | **Deferred, no WP, one reason each.** The price table is hand-maintained data about consumer subscriptions and unrelated to investments; refund netting already works in the aggregation path reports and budgets use; the copy linter runs under a different filename and a standalone script would add a vitest project to re-run the same assertions. |
| **Two real institutions on schedule; a month of real data with zero internal transfers; the recurring gold set against Chris's confirmed list** | Phase 1 wp1.7 §7, 02 §2, wp2.12 §1 | **Carried, owner Chris — third phase.** Phase 3 adds a *fourth* real-data item of the same shape (a real brokerage's holdings reconciling to its statement) and it is carried on the same terms. §6 Q1/Q2/Q5. |
| **`--status-warning` / `--status-serious` contrast unconfirmed** | Phase 1 wp1.6 §7 | **Deferred to Phase 9** (unchanged). WP 3.11/3.12 still run axe on every new screen, and the allocation donut and net-worth chart must not encode meaning in hue alone — D20's CVD-safe teal/vermilion, plus pattern or label. |
| **CI is green on the real runner (13/13 at `62ad15d`)** and **C-1c is closed**; **D-1/D26 ratified 2026-09-21** | execution log 2026-09-21 08:40, 10:30 | **Nothing to absorb.** Recorded because Phase 2's §2 carried both as open and a reader of this file should not go looking. Phase 3 must not widen CSP further; WP 3.11/3.12 use self-hosted visx and no CDN. |

---

## 3. Work packages

Same collision rules as Phases 1 and 2: disjoint path ownership, no dependency or lockfile edits by agents,
no commits (the orchestrator commits per package after `just verify`), a separate scratch database per agent,
foreground waits only, one agent on the compose stack at a time — plus Phase 2's process change: **agents
write evidence and post their report before the final verify**, and the orchestrator finishes cheap kills.

| WP | Package | Model | Agent type | Depends on |
|---|---|---|---|---|
| 3.1 | Securities master + `SecurityResolver` + OpenFIGI mapping; migration 0013 | Opus | backend-architect | — |
| 3.2 | Holdings, snapshots, investment transactions, cost-basis lots, corporate actions; migration 0014 | Opus | backend-architect | 3.1 |
| 3.3 | Portfolio analytics, pure: TWR, MWR/XIRR, fee drag, allocation, drift, concentration, idle cash | Opus | backend-architect | 3.2 shapes |
| 3.4 | `integrations` context: one `PriceSource` port, Tiingo/FRED/CoinGecko adapters, egress allow-list, cache, staleness, attribution, rate limits; migration 0015 | Opus | security-engineer | 3.1 |
| 3.5 | `CoinbaseConnector`: CDP JWT, `key_permissions` assertion, **v3 ledger-gap prototype first**, on-ramps classified as transfers | Opus | security-engineer | — |
| 3.6 | `WalletRpcConnector`: watch-only BTC (xpub + Esplora) and ETH (Etherscan v2 / Alchemy); migration 0016 | Sonnet | backend-architect | 3.1 |
| 3.7 | Plaid investments/liabilities wiring; promote the investment-transaction fact into `@connector/port`; orchestrator holdings/liabilities legs | Sonnet | backend-architect | 3.2 |
| 3.8 | `net_worth_daily` snapshotter (in `@ctx/planning`, its owner) with seal semantics, FX per D4, backfill; migration 0017 | Opus | backend-architect | 3.2, 3.4 |
| 3.9 | REST surface: holdings, securities, allocation, drift, performance, net-worth series, prices, market-data settings | Sonnet | backend-architect | 3.2, 3.3, 3.8 |
| 3.10 | Advisor catalog v2: investing I1–I10, debt D1–D6, crypto X1–X6, and the new snapshot scopes that unblock U8/C5/C6/C1/C2 | Opus | backend-architect | 3.3, 3.8 |
| 3.11 | UI: `_app.investments.tsx` — holdings, allocation, per-account detail, drift | Sonnet | frontend-architect | 3.9 contracts |
| 3.12 | UI: net-worth chart (visx), market-data settings + attribution, crypto connect flows | Sonnet | frontend-architect | 3.9 contracts |
| 3.13 | Phase 2 carry-over package: gate rulings, `?encrypt=true`, delivery sinks, kill-switch defaults, `pending_review` filter, `advisor_version`, `secretbox` decision | Sonnet | backend-architect | Phase 2 gate verdict |
| 3.14 | Quality pass: seed extensions (holdings, lots, prices, FX), spreadsheet-check fixture, perf budgets, exit-criteria audit | Sonnet | quality-engineer | all |
| Phase 3 gate | Independent security + architecture gate: sabotage every new control, walk the production stack in a real browser to the new screens, observe a scheduled price refresh, verdict to `docs/evidence/phase-3/gate-security-review.md` | Opus | security-engineer | all |

### WP 3.1 — Securities master, `SecurityResolver`, OpenFIGI (the serial gate)

**Scope.** `securities` (`ticker`, `cusip`, `isin`, `figi`, `name`, `type equity|etf|mutual_fund|crypto|bond|cash`, `currency`, `expense_ratio`, `asset_class`, `sector`, `region`, `is_cash_equivalent`, plus `chain` + `contract` for crypto — **no `sedol`**, Plaid removed it in 2026), `security_identifiers`. `SecurityResolver.resolve(identifier) → securityId` over 08 §2.5's `SecurityIdentifier` union (`ticker | cusip | isin | chain_contract | proprietary`): tiers, first answer wins, **every abstain named and returned**, and a provider identifier accumulates as corroborating evidence and is **never** the identity — the D25 shape applied to securities. OpenFIGI mapping (25,000 jobs/min with a free key, **batched**) behind the egress allow-list. The 07 §4.3 classification waterfall — `USER_OVERRIDE` → `LOCAL_SEED_TABLE` (~600 ETFs/funds, MIT, in-repo) → SEC EDGAR → issuer CSV → name heuristics → SIC sector map → `UNCLASSIFIED` — with `classification_source` recorded on **every** row and fund-of-funds recursion capped at depth 3 with cycle detection. Extends `@connector/port`: `ProviderSecurityFact`, `ProviderInvestmentTransactionFact` (promoting `PlaidInvestmentTransactionFact`, the gap `packages/connectors/plaid/src/map.ts:291` already names), `syncInvestmentTransactions` on the `Connector` interface, and the `INSUFFICIENT_SCOPE` / `DATA_UNAVAILABLE` error kinds of 08 §2.4.
**Owns.** `packages/contexts/investments/src/{securities,resolver,classify,identifiers}.ts`, `packages/contexts/investments/schema/index.ts`, `packages/contexts/investments/data/asset-classes.json`, `packages/connectors/port/src/{facts,connector,errors}.ts`, `packages/db/migrations/0013_securities.sql`.
**Events.** Emits `investments.SecurityResolutionFailed`. **Migrations.** 0013.
**Exit tests.** `src/resolver.test.ts` → `'ETH as a Coinbase ticker, a chain+contract and a brokerage CUSIP resolve to one securityId'` (the §5 exit criterion), `'an unresolvable identifier fails loudly and emits SecurityResolutionFailed rather than minting a row'`; `src/identifiers.test.ts` → `'a provider identifier never becomes the identity'` (sabotage-tested); `src/classify.test.ts` → `'every classified row records its classification_source'`, `'a fund whose component weights miss 1.0 by more than 5% is flagged'`, `'fund-of-funds recursion stops at depth 3 and detects a cycle'`; `test/openfigi.test.ts` → `'120 symbols are one batched request, not 120'`; the connector conformance suite stays green on the widened port.
**Evidence.** `docs/evidence/phase-3/wp3.1-securities.md`: the tier table with an abstain reason per tier; the one-security proof with all three identifiers shown; the waterfall's hit rate on the seed with `% unclassified` stated plainly; why the investment-transaction fact became a port change rather than staying a Plaid-local type.

### WP 3.2 — Holdings, lots, cost basis, corporate actions

**Scope.** `holdings` (`quantity NUMERIC(38,18)`, `cost_basis_per_unit`, `institution_value_minor`, `cost_basis_is_user_supplied`, `as_of_date`), `holdings_snapshots` (daily), `investment_transactions` (**idempotent on `investment_transaction_id`**; 01 §5.5 — there is no `/investments/transactions/sync`, so a date window and an upsert, never a cursor), `cost_basis_lots` per 07 §4.4 with `quantity_remaining`, `basis_source ENUM(BROKER,IMPORTED,USER,ESTIMATED)`, `wash_sale_adjustment_minor` and a **`holding_period_start_date` separate from `open_date`** (a wash sale tacks on the prior holding period). Methods: FIFO (default, and the IRS default), LIFO, HIFO, SPECIFIC_ID, AVERAGE_COST (mutual funds only, sticky per security per account once elected). Corporate actions: splits and reverse splits scale quantity and per-unit basis and **leave total basis unchanged**, then re-run lot math forward. **Unknown basis reports unrealized gain as `unavailable`, never as gain-from-zero** (04 §5.5). Wash sale is labeled **`POSSIBLE_WASH_SALE`, never `WASH_SALE`**, scanned across all accounts including IRAs, over the **61-day window including the sale date**; the digital-asset exclusion is a dated config flag (`wash_sale_applies_to_digital_assets: false  # as of 2026-09`), not a hardcoded branch. Per-wallet crypto basis per Rev. Proc. 2024-28; a missing basis is `ESTIMATED` with a visible warning and **never a silent zero**.
**Owns.** `packages/contexts/investments/src/{holdings,lots,basis,corporate-actions,store}.ts`, `packages/db/migrations/0014_holdings.sql`.
**Events.** Emits `investments.HoldingsUpdated`. **Migrations.** 0014.
**Exit tests.** `src/lots.test.ts` → `'FIFO, LIFO, HIFO and specific-ID select different lots for the same sale and each is reproducible'`, `'quantity_remaining is never negative'` (a `fast-check` property); `src/basis.test.ts` → `'an unknown basis yields unavailable, not zero'`; `src/corporate-actions.test.ts` → `'a 4:1 split quadruples quantity, quarters per-unit basis and leaves total basis unchanged to the cent'`; `src/quantity.test.ts` → `'0.00000001 BTC survives a database round trip'` (04 §2.3, verbatim); `test/wash-sale.test.ts` → `'a repurchase on day 30 after a loss is flagged POSSIBLE_WASH_SALE and one on day 31 is not'`, `'the digital-asset exclusion is read from config, not hardcoded'`.
**Evidence.** `docs/evidence/phase-3/wp3.2-holdings.md`: a worked five-lot table per method with the arithmetic shown; the split walked before and after; the 61-day window drawn with both boundaries tested; every `NUMERIC(38,18)` / `NUMERIC(20,8)` / `BIGINT` boundary named, with a grep proving no `number` crosses one.

### WP 3.3 — Portfolio analytics (pure)

**Scope.** No database, no I/O, over `Quantity` and `Money`. TWR by sub-period linking at every external cash flow (`r_j = (MV_end,j − CF_j)/MV_begin,j − 1`, `TWR = Π(1+r_j) − 1`), with **Modified Dietz** as the explicitly-flagged `approximate` fallback when daily prices are missing. MWR by XIRR with **Newton plus a bisection fallback** ("Newton alone diverges on sign-flipping flows") and a typed `n/a` when the flows never change sign. **Never annualize under one year.** 07 §4.2's rule — *"Never put a TWR next to a dollar gain, and never benchmark an MWR"* — is enforced as a **type** rule: the two live in different return shapes so no UI can pair them by accident. Allocation by asset class / region / sector, **fund-level only** in v1 (no fake look-through), with `unclassifiedPct` returned beside every number. Drift vs target on an **absolute 5-percentage-point band**. Fee drag `Σ(value × expense_ratio)`. Concentration: top-holding % and Herfindahl. Idle cash.
**Owns.** `packages/contexts/investments/src/analytics/**`.
**Events.** None (pure). **Migrations.** None.
**Exit tests.** `src/analytics/twr.test.ts` → `'a mid-period deposit does not change TWR'`, `'the same flows give a materially different MWR'`; `xirr.test.ts` → `'Newton diverges and bisection converges on the sign-flipping fixture'`, `'flows with no sign change return n/a rather than a number'`, `'a nine-month return is not annualized'`; `allocation.test.ts` → `'allocation matches the committed spreadsheet fixture to the cent'` (the §5 exit criterion and the v0.5 rung), `'unclassifiedPct is returned whenever any holding is UNCLASSIFIED'`; `drift.test.ts` → `'a 4.9-point gap proposes nothing and a 5.1-point gap proposes a trade'`.
**Evidence.** `docs/evidence/phase-3/wp3.3-analytics.md`: TWR vs MWR on one worked portfolio with the divergence explained; the XIRR convergence table including the fixture that breaks Newton; the spreadsheet fixture reproduced with its formulas beside it; a sabotage showing allocation goes red when the denominator silently drops cash.

### WP 3.4 — Market data: one `PriceSource` port (`@ctx/integrations`)

**Scope.** **One** `PriceSource` port — `price(securityId, date, currency)`, `fxRate(from, to, date)`, `search(symbol)` — with Tiingo (equity/ETF EOD, the D17 default), FRED (macro, **FX**, and the market rate C1/C2 have been withholding for since Phase 2) and CoinGecko Demo (crypto) behind it. `prices` is **`NUMERIC(20,8)` plus a currency, not minor units**; `fx_rates` is pair × date; `price_source_priority` implements 07 §6.1 — user override > exchange fill > provider > last known — at **UTC 00:00 daily close**, and **history is never recomputed from today's price**. **Staleness is a first-class field:** a price older than 24 hours marks the holding `STALE` and excludes it from "as of now" deltas. Rate limits are implemented with the documented number **in the code**: Tiingo 50/hr and **1,000/day**, FRED 120/60 s, CoinGecko ~100/min and 10,000 credits/month, OpenFIGI 25,000 jobs/min. **Egress reuses WP 2.4's allow-list module rather than reimplementing it.** Attribution is a licence condition, not a courtesy: CoinGecko requires *"Data provided by CoinGecko"* with logo and hyperlink on any surface showing a crypto price, FRED requires its exact disclaimer string, and Tiingo's personal tier **forbids redistribution**. yfinance, if built at all, is opt-in and labeled best-effort — never the documented default (01 §4.2: *"the legal risk is the data, not the code"*).
**Owns.** `packages/contexts/integrations/src/{price-source,cache,attribution}.ts`, `.../src/adapters/{tiingo,fred,coingecko}.ts`, `packages/contexts/integrations/schema/index.ts`, `packages/db/migrations/0015_market_data.sql`.
**Events.** Emits `integrations.PricesUpdated`, `integrations.PriceSourceUnavailable`. Schedule `integrations.price_refresh` at **03:45 local** (08 §3.7). **Migrations.** 0015.
**Exit tests.** `test/egress-allowlist.test.ts` → `'a price-source URL pointing at db:5432 is refused'`, `'169.254.169.254 is refused'`, `'a 302 to an internal host is not followed'`, `'a DNS answer that changes between check and connect is refused'`; `test/shared-allowlist.test.ts` → `'the price egress guard is the notifications module, not a copy of it'` (fails if the import is replaced by a local reimplementation); `test/attribution.test.ts` → `'CoinGecko and FRED adapters declare a non-empty attribution their ToS requires'`; `test/staleness.test.ts` → `'a 25-hour-old price marks the holding STALE'`; `test/rate-limit.test.ts` → `'the Tiingo adapter refuses its own 1,001st call of a day rather than being refused'`; `test/custody.test.ts` → `'the raw column contains no plaintext API key'`.
**Evidence.** `docs/evidence/phase-3/wp3.4-market-data.md`: the refusal matrix with each sabotage observed red; a ToS table quoting the clause per provider and naming the UI obligation it creates; the rate-limit ledger; the raw-column custody read; the priority ladder walked with one price answered by each rung.

### WP 3.5 — Coinbase read-only connector (prototype first)

**Scope.** **Deliverable one is the R6 ledger-gap prototype, reported to the orchestrator before any connector code is written:** does Advanced Trade v3 alone reconstruct a cost-basis-capable ledger, or do deposits, withdrawals and staking rewards exist only in the deprecated v2 `/transactions`? Then `CoinbaseConnector` over the **existing** `Connector` port: CDP key plus a **per-request Ed25519 (EdDSA) JWT** — `kid` = key name, random `nonce`, `sub = organizations/{org}/apiKeys/{key}`, `iss='cdp'`, `aud=['cdp_service']`, **120-second lifetime, bound to `"{METHOD} {host}{path}"`, minted fresh per request**. **Explicitly not ES256**, which is Plaid's *webhook* algorithm; 01 §3.2 warns against cargo-culting between them. `GET /api/v3/brokerage/key_permissions` asserted **at startup and again before every sync**; the connector refuses to run if `can_trade` or `can_transfer` is set, and **no trading endpoint appears anywhere in the adapter's code**. Keys sealed with `SecretBox` exactly as Plaid's are. Capabilities `accounts, balances, holdings, investment_txns`; `liabilities` honestly absent (08 §2.6: adapters *"degrade honestly"*). **The v0.5 rung clause lives here:** a USD deposit followed by a BTC buy is **one transfer plus one trade**, matched to its bank-side leg through the existing `POST /transfers/pair` machinery, and never $5,000 of spending.
**Owns.** `packages/connectors/coinbase/**`. **Migrations.** None.
**Exit tests.** `test/permissions.test.ts` → `'a key claiming can_trade is refused at startup'`, `'…and again before a sync, not only at boot'` (sabotage-tested); `test/jwt.test.ts` → `'a JWT is EdDSA, expires in 120 s and is bound to one method and path'`, `'a JWT is not reused across two endpoints'`; `test/onramp.test.ts` → `'a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending'` (the v0.5 rung); `test/custody.test.ts` → `'the raw sealed_credentials column contains no plaintext CDP key'` (the WP 1.3b pattern); `test/no-trade-surface.test.ts` → `'the package contains no code path that POSTs to /orders'`; the shared conformance suite green.
**Evidence.** `docs/evidence/phase-3/wp3.5-coinbase.md`: **the prototype finding first**, with each endpoint tried and what it returned; the JWT construction with one signed example decoded and redacted; the permission refusal observed; the on-ramp walked end to end; and, if v3 cannot reconstruct basis, the CSV fallback written down as the plan of record rather than left as a hope.

### WP 3.6 — `WalletRpcConnector` (watch-only)

**Scope.** `wallet_addresses`. BTC by **xpub derived locally** — Esplora and mempool.space have no xpub endpoint — using BIP32/44/49/84 chosen by prefix with the gap limit honored, balances via Blockstream Esplora. ETH by address via Etherscan v2 (one key, `chainid`, 5 calls/s, 100,000/day), with Alchemy `alchemy_getTokenBalances` documented as the upgrade path because **Etherscan has no "enumerate all token balances" primitive**. Capabilities `accounts, balances, holdings`. **No key material exists, therefore none can leak** (08 §2.6) — and the connector must have no code path that could accept any. Balances become holdings of the same `security_id` WP 3.1 resolved ETH to.
**Owns.** `packages/connectors/walletrpc/**`, `packages/db/migrations/0016_wallet_addresses.sql`.
**Events.** None of its own. **Migrations.** 0016.
**Exit tests.** `test/derive.test.ts` → `'a BIP84 zpub derives the published test-vector addresses'`, `'derivation stops at the gap limit of 20 empty addresses'`; `test/no-private-key.test.ts` → `'an input parsing as a WIF, a seed phrase or an xprv is refused'` (sabotage-tested); `test/one-security.test.ts` → `'a wallet ETH balance and a Coinbase ETH balance land on one securityId'` (the §5 exit criterion, jointly with 3.5); conformance suite green.
**Evidence.** `docs/evidence/phase-3/wp3.6-walletrpc.md`: derivation walked against published vectors; the private-key refusal shown; the egress hosts named and allow-listed; what "watch-only" is *enforced by* rather than promised by.

### WP 3.7 — Plaid investments and liabilities wiring

**Scope.** Wire the **already-mapped** adapter into the orchestrator. `packages/connectors/plaid/src/map.ts` has carried `holdingFactOf`, `investmentTransactionFactOf` and the liability map, fixture-asserted, since WP 1.3 — this WP adds the `holdings`, `investment_txns` and `liabilities` legs on exactly the shape of the existing `balances` leg in `packages/contexts/connections/src/orchestrator.ts`: **a leg's failure never relabels or rolls back the transactions delta**, each writes its own `sync_runs` row with an `operation:`, and a connector that does not declare the capability is **skipped, not caught as `NotImplemented`**. Investment transactions arrive by **date window, up to 24 months, idempotent on `investment_transaction_id`**. `cost_basis` is carried as reported and treated as the **fallback**: 01 §5.5 records that fill rates vary and the value is often *total* rather than per-share, so 3.2 derives basis from transactions wherever it can. `institution_value` is kept **for reconciliation only** — valuation comes from our own price source, so accounts are comparable. The liabilities leg delivers the APR / credit-limit / statement-balance block that WP 2.7's `CATALOGUE_GAPS` names as *the highest-value addition to the scope catalogue a later phase could make*.
**Owns.** the new legs in `packages/contexts/connections/src/{orchestrator,staging,ledger-writer}.ts`, and port-conformance changes only in `packages/connectors/plaid/src/connector.ts`.
**Events.** Emits `connections.SyncRunCompleted` per leg. **Migrations.** None.
**Exit tests.** `apps/api/test/db/investments-sync.test.ts` → `'a holdings leg failure leaves the transactions delta committed and correctly labeled'`, `'two syncs of the same window add no investment transactions'`, `'a connector without the holdings capability is skipped, not errored'`; `test/insufficient-scope.test.ts` → `'INSUFFICIENT_SCOPE clears the capability for this connection and leaves the others working'`; the existing Plaid suites stay green.
**Evidence.** `docs/evidence/phase-3/wp3.7-plaid-investments.md`: each leg's failure isolation shown; the idempotence proof with row counts before and after; the `cost_basis` fill rate measured on the Sandbox fixtures and the decision it drove; a reconciliation table of `institution_value` against our own valuation with every difference explained.

### WP 3.8 — Net worth over time

**Scope.** `net_worth_daily` — **owned by `@ctx/planning`** (08 §1.3 #8: *"Planning's snapshotter is the sole writer"*), so this WP opens exactly one table of a Phase 4 context and touches nothing else in it. Per-account breakdown in JSONB, a gapless calendar spine via `generate_series`, assets − liabilities over the **four independent booleans** of 07 §4.1 (`on_budget`, `in_net_worth`, `is_liquid`, `is_investable` — never conflated). **Seal semantics (08 §3.5):** today's row is incremental and mutable; at 02:00 local it is **sealed and never touched again**, and a correction writes a provenance-bearing row rather than mutating a sealed one. Backfill by `balance(d−1) = balance(d) − Σ txns(d)`, flagged `source='interpolated'` — **except investment accounts, which cannot be reconstructed that way** (04 §5.4) and are rebuilt from quantity × price with labeled linear interpolation between observations. **FX per D4:** dual native + base amounts with `fx_rate` and `fx_rate_date` stored **on the aggregate** — converting on read is wrong — and a missing rate is a typed `FxRateUnavailable` with a manual-entry affordance, **never a silent 1.0**. If prices fail the day still seals on the last known price, flagged `stale_price = true`.
**Owns.** `packages/contexts/planning/src/{net-worth,seal,fx}.ts`, `packages/contexts/planning/schema/index.ts`, `packages/db/migrations/0017_net_worth_daily.sql`.
**Events.** Consumes `investments.HoldingsUpdated`, `integrations.PricesUpdated`, `ledger.BalanceRecorded` and the 04:00 tick. Emits `planning.NetWorthSnapshotTaken`. Schedule `planning.net_worth_snapshot` — the name **must** match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, the Phase 2 worker crash-loop. **Migrations.** 0017.
**Exit tests.** `test/reconcile.test.ts` → `'net worth reconciles to a hand computation across every account type including a manual asset and a liability'` (the §5 exit criterion; the hand computation is committed as a fixture); `test/seal.test.ts` → `'a past date is byte-identical after a second snapshot run'` (the §5 exit criterion; sabotage: let the writer update a sealed row); `test/fx-missing.test.ts` → `'a missing rate raises FxRateUnavailable and never returns 1.0'` (the §5 exit criterion, sabotage-tested); `test/interpolation.test.ts` → `'an investment account is never backfilled by the transaction-subtraction path'`; `test/stale-price.test.ts` → `'a price outage still seals the day, flagged stale'`.
**Evidence.** `docs/evidence/phase-3/wp3.8-net-worth.md`: the hand computation beside the query result, line for line; the seal proved by two runs and a byte diff; the FX refusal shown; the interpolation policy per account class in one table; why this table lives in Planning and what that costs Phase 4.

### WP 3.9 — REST surface

**Scope.** Phase 2's lesson — the plan forgot the routes package and the orchestrator added WP 2.r mid-phase — applied up front. `GET /holdings` (aggregated by ticker **across** accounts), `GET /securities/{id}` and `PATCH /securities/{id}` (the asset-class overlay, 04 §3.2), `GET /investments/allocation`, `/drift`, `/performance`, `GET /net-worth/series`, `GET /accounts/{id}/holdings`, `GET /prices/{securityId}`, and market-data settings (source priority, **key presence — never key values** — and a test fetch). TWR, MWR and dollar gain occupy **separate response shapes** so 07 §4.2's rule survives the wire. `unclassifiedPct` and `stale` are returned as fields, never inferred by the client. Step-up on anything writing a credential; user scope asserted per route.
**Owns.** `apps/api/src/routes/{investments,net-worth,securities,prices,market-data}.ts`.
**Events.** None emitted; reads through published readers only. **Migrations.** None; 0018 is reserved and used only if reported necessary.
**Exit tests.** `apps/api/test/db/investments-routes.test.ts` → `'every route refuses another user's data'` (one case per route family), `'the performance response cannot express a TWR and a dollar gain in the same object'` (type-level), `'a stale price is labeled in the response rather than silently fresh'`; `market-data-routes.test.ts` → `'the settings response contains no API key value'`.
**Evidence.** `docs/evidence/phase-3/wp3.9-routes.md`: the route table with step-up and scope per row; the cross-user sabotages; the generated OpenAPI diff; **and the `just check` output appended** — the WP 2.r omission, not repeated.

### WP 3.10 — Advisor catalog v2

**Scope.** Through WP 2.6's contract **unchanged**, `kind: builtin`, `confidence_basis: deterministic`. Investing **I1–I10** and debt **D1–D6** per master plan §5, plus crypto **X1–X6** (07 §3.3) — Phase 3 is the only phase that can write them. New `SnapshotBuilder` scopes with 08 §4.2's minimization rules unchanged: `holdings.aggregate` (asset-class weights + top-N by symbol and weight; **no quantities, no account linkage, no cost basis**), `holdings.detail` (quantity, basis, lot ages, unrealized P&L; **still no account ids or institution**), `networth.summary` (**rounded to $100**), `liabilities.terms` (the APR / limit / statement-balance block — one block that unblocks **U8, C5, C6** and the whole D family at once), and a FRED-sourced market rate, which is exactly what **C1 and C2** have been withholding for since Phase 2 (*"a hardcoded 4% would be a numeral nothing could account for"*). **I1 suppresses itself when `unclassified_pct > 10%`** (07 §4.3, normative) and reports `Δσ`, not dollars. I4, I5, I10 and X1 are P0; X1 uses **drawdown framing**, never a projection. `lintInsightCopy` covers every new template unchanged — 07 §7.2's banned list bites hardest here (`\bbuy\b`, `\bsell\b`, `\bbest (stock|fund|investment)\b`) — and every recommendation is paired with its cost ("selling in a taxable account would realize $Y of gains"). Nothing here compounds a speculative return into a headline. **S1 and S5 are not in scope:** WP 2.7 recorded that they need an exact amount and a merchant-first-seen date, not investments data, and this WP does not relitigate that.
**Owns.** `packages/contexts/insights/src/advisors/builtin/{investing,debt,crypto}/**`, additions only to `packages/contexts/insights/src/snapshot/scopes.ts`.
**Events.** Emits `insights.InsightProposed` via WP 2.6. **Migrations.** None.
**Exit tests.** `test/catalog-v2.test.ts` → `'every new rule produces at least one resolvable evidence ref on the seed'`, `'every new rule returns zero insights when its inputs are absent'`; `test/i1-suppression.test.ts` → `'I1 withholds when unclassified exceeds 10 percent'` (sabotage-tested); `test/scope-minimization.test.ts` → `'holdings.aggregate emits no quantity, no cost basis and no account id'`, `'networth.summary is rounded to $100'`; `test/copy-lint.test.ts` → `'"the best fund" fails the linter'`; `test/no-execute-action.test.ts` → `'no rule proposes an action outside the four non-acting kinds'`.
**Evidence.** `docs/evidence/phase-3/wp3.10-advisor-catalog-v2.md`: one table of every new rule with trigger, formula, severity and the seed row that fires it; a rendered snapshot for each new scope with every identifier stripped; the alert budget applied after the investing wave is released; the copy linter before and after a deliberate violation.

### WP 3.11 — UI: holdings, allocation, per-account detail

**Scope.** `_app.investments.tsx` replacing the 16-line `PlaceholderRoute`: holdings aggregated by ticker across accounts with per-account expansion; allocation by asset class / region / sector as a **visx** donut with **`% unclassified` rendered beside it, never hidden**; drift with the 5-point band drawn and a "set a target" empty state that **suppresses rather than invents** (§8 Q9); per-account detail with lots, basis source, and `unavailable` where basis is unknown; `STALE` price badges; TWR and MWR labeled and **never in the same row as a dollar gain**. Colour is D20's CVD-safe pair **plus** a pattern or label — no meaning in hue alone. Self-hosted visx, no CDN, **no CSP widening**.
**Owns.** `apps/web/src/routes/_app.investments.tsx`, `apps/web/src/features/investments/**`, `apps/web/e2e/investments.spec.ts`. May not touch `e2e/support/mock-api.ts` or `app-walkthrough.spec.ts`.
**Exit tests.** `features/investments/*.test.tsx` unit; `e2e/investments.spec.ts` → `'the allocation donut totals match the committed spreadsheet fixture'`, `'a holding with unknown basis renders "unavailable" and not "$0.00"'`, `'a stale price is visibly labeled'`, `'drift renders nothing when no target is set'`; axe clean.
**Evidence.** `docs/evidence/phase-3/wp3.11-investments-ui.md`: screenshots under both themes; the axe run; every number on screen traced to the API field it came from (no client-side money math beyond formatting); the spreadsheet check reproduced from the browser.

### WP 3.12 — UI: net-worth chart, market-data settings, crypto connect

**Scope.** Net-worth chart on `_app.index.tsx` and its own view: visx area/line over `GET /net-worth/series`, **sealed history visually distinct from today's live row**, interpolated days labeled, and **one series per currency until an FX rate exists** — never one silently-summed line. Market-data settings: source priority, key presence, a test fetch, and **the attribution block rendered wherever those prices appear** — *"Data provided by CoinGecko"* with logo and hyperlink, and FRED's exact disclaimer string — not buried in an About page. Crypto connect flows: a CDP key form (sealed, never echoed) and watch-only address entry carrying an explicit *"we will never ask for a private key or a seed phrase"* line.
**Owns.** `apps/web/src/features/{networth,market-data,crypto}/**`, additions to `apps/web/src/routes/_app.settings.tsx` and `_app.index.tsx`, `apps/web/e2e/networth.spec.ts`. Same mock/spec exclusions as 3.11.
**Exit tests.** `e2e/networth.spec.ts` → `'a past date on the chart is unchanged after a re-sync'`, `'two currencies render as two series and never one sum'`; `e2e/market-data.spec.ts` → `'the CoinGecko attribution is present on every screen showing a crypto price'` (a real assertion, not a snapshot), `'the settings screen never renders an API key value'`; axe clean.
**Evidence.** `docs/evidence/phase-3/wp3.12-networth-ui.md`: screenshots; the attribution shown on each qualifying screen with the ToS clause quoted beside it; the URL-state round-trip; confirmation that no new CSP directive was needed.

### WP 3.13 — Phase 2 carry-overs

**Scope.** §2's assigned rows, and nothing else. The Phase 2 gate's **AT_RISK and impact-ceiling rulings** implemented, or recorded as ruled-and-unchanged. `age` available to the api image so `?encrypt=true` produces a real ciphertext — or the documented degradation confirmed as intended, with a test either way. A `dev-sinks` compose profile with `mailpit` and `ntfy` so a **successful** notification delivery is observable. Kill-switch defaults written into `apps/api/src/platform.ts` and `docs/RUNBOOK.md`. A `pending_review` filter on `GET /insights` — **verify first**, `apps/api/src/routes/insights.ts` now exists — and the stale claim deleted from `wp2.11-inbox-ui.md` §5. `advisor_version` on the insight response; `price_change_events` projected onto `GET /recurring/series`. `@core/secretbox` added to `@ctx/insights` and the merchant-pseudonym construction **decided now**, with the re-pseudonymisation cost stated in the evidence.
**Owns.** `apps/api/src/routes/{insights,recurring,export}.ts`, the flag defaults in `apps/api/src/platform.ts`, `packages/contexts/insights/src/snapshot/tokens.ts`, `docker/compose.dev-sinks.yml`, `docker/api.Dockerfile` (the `age` package line only), `docs/RUNBOOK.md`.
**Events.** None new. **Migrations.** None expected; 0018 reserved.
**Exit tests.** `apps/api/test/db/export-encrypt.test.ts` → `'an encrypted export decrypts to the same bundle'`; `notifications-delivery.test.ts` → `'a delivery to the dev sink is observed as delivered, not merely queued'`; `insights-pending-review.test.ts` → `'the pending_review filter returns exactly the queue the inbox needs'`; `tokens.test.ts` → `'the merchant pseudonym construction is pinned and a change fails loudly'`.
**Evidence.** `docs/evidence/phase-3/wp3.13-carry-overs.md`: §2's table with every row closed, deferred-with-reason, or ruled; and the **first observed successful notification delivery in this project's history**, with the sink's received message shown.

### WP 3.14 — Quality pass

**Scope.** Extend `@core/seed` with securities, holdings, lots (**with ground truth**), investment transactions, a price series, an FX series **with one deliberate gap**, a non-USD account, a manual asset and a liability. **Commit the spreadsheet check as a fixture** — a CSV plus its formulas — so *"allocation matches a spreadsheet check"* is a test rather than a ceremony. Perf budgets for holdings, allocation and the net-worth series on the seed. A CI boundary check implementing 08 §6.5's lint rule: `number` banned in any identifier matching `/amount|balance|price|value|cost|quantity/`. Audit every §5 exit criterion and say which are proven, which need Chris's real accounts, and which are carried.
**Owns.** `packages/seed/src/**`, `scripts/check-numeric-boundaries.ts`, `docs/TESTING.md`, and `.github/workflows/ci.yml` jointly with the orchestrator.
**Exit tests.** `packages/seed/test/investments-ground-truth.test.ts` → `'the generator's declared lots match what the basis engine computes'`; `scripts/check-numeric-boundaries.test.ts` → `'a float assigned to a price fails the check'` (self-test against fixtures first, then the real tree); `apps/api/test/db/investments-perf.test.ts` → `'holdings and allocation p95 < 200 ms on the seed'`.
**Evidence.** `docs/evidence/phase-3/wp3.14-quality.md`: the exit-criteria audit table; the spreadsheet fixture with its provenance; each new check sabotaged once and observed red; the seed's new ground truth enumerated.

---

## 4. Waves

Dependency line from master plan §6.4: *investments context (serial gate: `SecurityResolver`) ∥ Coinbase
prototype ∥ market-data ingestion ∥ net-worth UI.* Ceiling is **three concurrent agents, at most two Opus**
— the Phase 0/1 rate-limit lesson, re-confirmed by Phase 2's three session-limit kills.

| Wave | Agents | Packages |
|---|---|---|
| A | 3 (2 Opus) | 3.1 securities + resolver + port · 3.5 Coinbase (prototype first) · 3.13 carry-overs |
| A′ | 2 Opus, on 3.1 landing | 3.2 holdings/lots/corporate actions · 3.4 market data |
| B | 3 (1 Opus) | 3.3 portfolio analytics · 3.6 WalletRpc · 3.7 Plaid investments wiring |
| C | 3 (1 Opus) | 3.8 net worth over time · 3.9 REST surface · 3.11 holdings + allocation UI |
| D | 2 (1 Opus) | 3.10 advisor catalog v2 · 3.12 net-worth chart + market-data settings UI |
| E | 1, then 1 | 3.14 quality pass, then the Phase 3 gate |

**Why 3.5 is in Wave A.** R6's mitigation is *"prototype against the real account first"*. If the prototype
finds the v3 ledger gap, crypto cost basis falls back to a CSV export and **WP 3.2's lot engine has one fewer
source to satisfy** — a scope change that must arrive before 3.2 starts, not after it ships. **Why 3.13 is
in Wave A.** It is the one Wave A package a Sonnet can carry, and two of its items come from the Phase 2 gate
verdict: **Phase 3 does not dispatch until that verdict lands**, and 3.13 not until the rulings are written.

**UI packages code against contracts, never against a guess** — Phase 2's `notification-settings` failure,
a spec waiting on `/channels/{id}/test` when the real route was `/verify`, is what a guessed path costs.
**3.11 and 3.12 own disjoint route files, `features/` directories and e2e specs, and neither may touch
`e2e/support/mock-api.ts` or `app-walkthrough.spec.ts`;** the orchestrator applies shared mock edits at the
wave boundary.

Migration numbers are assigned before dispatch and are not negotiable in-flight: **0013** securities (3.1),
**0014** holdings/lots (3.2), **0015** market data (3.4), **0016** wallet addresses (3.6), **0017**
`net_worth_daily` (3.8); **0018** reserved for 3.9/3.13. `0013`/`0014` were reserved in Phase 2 and never
used, so `ls packages/db/migrations` shows `0012` as the highest and **0013 is genuinely free** — confirmed
at `5a96871`. Two waves may not both claim a number.

### Shared files an orchestrator applies between waves

No agent edits these. The orchestrator applies them once per wave boundary, then runs `just verify`.

1. **`vitest.config.ts`** — add `investments`, `investments-db`, `integrations`, `integrations-db`,
   `planning`, `planning-db`, `connector-coinbase`, `connector-walletrpc` (31 projects today → 39). `*-db`
   entries carry `fileParallelism: false` and `testTimeout: 30_000`.
2. **`scripts/eslint-boundaries.js`** — named layers for `packages/contexts/{investments,integrations,planning}/`
   inserted **before** the `context` catch-all: allow `@core/testkit`/`@core/seed` in tests, let `planning`
   read `@ctx/{ledger,investments}` (08 §1.6 — arrows point down), and **deny `@ctx/ledger` from
   `integrations`**, which 08 §1.3 #11 says must not reach Ledger, Connections or Identity.
3. **`apps/api/src/platform.ts`** — `MODULE_FLAGS` entries `module.investments`, `module.integrations` and
   `module.planning`, each `defaultEnabled: false` when its WP merges and flipped `true` at the wave
   boundary after its consumer is registered and green. Plus the WP 3.13 kill-switch defaults.
4. **`apps/api/src/modules.ts`** — events, consumers, the `integrations.price_refresh` and
   `planning.net_worth_snapshot` schedules (names **must** match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$` — the
   Phase 2 worker crash-loop), and the two new connectors in the registry. **`apps/api/src/domain.ts`** —
   the `LedgerPort`-style adapter `@ctx/investments` reads accounts and balances through, the `PriceSource`
   adapter it reads `@ctx/integrations` through, and the `HoldingsReader`/`PriceReader`/`FxReader` adapters
   `@ctx/planning` reads. **A new context's consumer starts at `seq = 0`** and catches up over the full
   event history on first boot (08 §3.4) — budget for it on the cold walk.
5. **`packages/db/test/migrate.test.ts`** — the exact alphabetical table list (65 names today → ~80) and
   the per-migration attribution comment block above it.
6. **`.github/workflows/ci.yml`** — **two** hand-maintained `--project` lists plus the prose project→job map
   in the header. `scripts/check-ci-projects.ts` (WP 2.12) fails the build if any of the three drifts, so
   this is mechanical rather than remembered — but it is still the orchestrator's edit, not an agent's.
7. **`packages/contracts/openapi/openapi.json`** — regenerate with `just openapi` after each wave that adds
   routes, then regenerate `apps/web/src/api/generated/`. `scripts/check-proxy-routes.ts` should stay green
   without a `docker/Caddyfile` edit; if it does not, that is a finding, not a routine edit. **No CSP
   directive may widen** — D26 is the one ratified exception and Phase 3 adds nothing to it.
8. **Config and secrets batch** — `MARKET_DATA_ALLOWED_HOSTS` (the `NOTIFICATIONS_ALLOWED_HOSTS` pattern:
   `api.tiingo.com`, `api.stlouisfed.org`, `api.coingecko.com`, `api.openfigi.com`) and
   `CRYPTO_ALLOWED_HOSTS` (`api.coinbase.com`, `blockstream.info`, `api.etherscan.io`); provider API keys as
   **file secrets under `/run/secrets`, sealed with `SecretBox` when user-supplied, never env vars** (D5),
   each covered by `harden-secrets`.
9. **Dependency batch** — `@scure/bip32` + `@scure/base` (MIT, audited, dependency-light) for WP 3.6's xpub
   derivation, plus the `@ctx/{investments,integrations,planning}` and `@connector/{coinbase,walletrpc}`
   workspace entries in `apps/api/package.json`, then one `pnpm install` and a `THIRD_PARTY.md` restamp, all
   under the seven-day `minimumReleaseAge`. **Rejected before an agent proposes it:** `decimal.js` /
   `big.js` / `bignumber.js` — `@core/kernel`'s `Quantity` (decimal strings, `QUANTITY_SCALE = 18`,
   `QUANTITY_PRECISION = 38`) already *is* the decimal type, and a second one is how a codebase ends up back
   on floats. Also rejected: `jose` for WP 3.5's CDP JWT — `node:crypto` signs **Ed25519** natively. **Note
   the algorithm, because it is the one thing an agent will get wrong:** the CDP JWT is **EdDSA/Ed25519**;
   ES256 is Plaid's *webhook* algorithm, and 01 §3.2 warns against cargo-culting between them. Agents never
   run `pnpm install`.

---

## 5. Gate standard for Phase 3

Carried verbatim in force from the Phase 0, 1 and 2 gates. Phase 2's gate ran 26 sabotages, all red on the first valid attempt — what a mature control set looks like, and **not** a reason to run fewer.

1. **Independent reviewer.** An Opus `security-engineer` who wrote none of the code re-runs the load-bearing
   proofs. A gate may not validate its own fixes — Phase 1 needed D-2 for exactly that reason.
2. **Sabotage every new control and observe it go red** before accepting its PASS. Record which sabotages
   were red on the first try. A control that has never been observed failing is not evidence.
3. **Walk the production stack in a real browser**, through Caddy, on an image rebuilt from the landing
   commit, and **the walk must reach the code Phase 3 added**: holdings render with a price and a staleness
   label; allocation matches the committed spreadsheet fixture; the net-worth chart draws a real series and a
   past date is unchanged after a re-run; a Coinbase or watch-only connection links and its on-ramp shows as
   a **transfer**, not spending; CoinGecko attribution is visible wherever a crypto price is. **A login that
   stops at the shell proves nothing.**
4. **Every "never" claim has a test that fails when the thing is made to happen.** Phase 3's list: a
   quantity never becomes a float; a sealed net-worth day never changes on a re-run; a missing FX rate never
   defaults to 1.0; an unmapped security never silently becomes two securities; a price source never
   resolves a private or link-local address; a `can_view` CDP key never reaches a trading endpoint; an
   on-ramp deposit never lands in a spending total.
5. **Every new vitest project is in `ci.yml` the day it is created.** `scripts/check-ci-projects.ts` enforces it; the gate confirms the check is still wired and still fails when a project is dropped.
6. **The walk starts from a genuinely cold install** — `docker compose down -v`, `up`, bootstrap, and no
   restart anywhere in between — **and it must observe a scheduled price refresh actually run**, not merely
   be registered: the gate waits out (or triggers) one `integrations.price_refresh` tick and shows prices
   moving and `sync_runs`/`domain_events` rows appearing. Phase 2's worker crash-loop existed only on the
   cold path and every unit test passed against a fake scheduler.
7. **`just verify`, not `just check`**, is what predicts CI, run at the landing commit — and CI on the real
   GitHub runner must also be green, because Phase 2 found four defects `just verify` structurally could not
   see. **And the Phase 2 gate's unfinished rulings are inputs, not outputs:** the Phase 3 gate must not be
   where the AT_RISK and impact-ceiling questions get answered for the first time.

### Phase-3-specific risks

| Risk | Control | Proven by |
|---|---|---|
| **A float reaches a quantity or a price.** D3 is irreversible and Phase 1 already caught `toFixed(18)` manufacturing seventeen digits of garbage from `268.4`. Portfolio math multiplies quantity × price and then sums — the error compounds where nobody looks. | `@core/kernel`'s `Quantity` (decimal strings, `NUMERIC(38,18)`) and `Money` (`BIGINT` minor units) only; no `number` crosses any `*_minor`, `quantity` or `price` boundary; `toNumberApproximate` is legal only for presentation and for confidence scores. | WP 3.2/3.3 property tests; gate greps the whole Phase 3 diff for `number` at those boundaries and for new `toFixed(` calls. |
| **A past net worth changes.** The §5 exit criterion is immutability across a re-run; a silently-moving history destroys every trend the app draws. | `net_worth_daily` rows are **sealed** after their day closes; a re-run writes a correction row with provenance rather than mutating; late-arriving balances dirty only unsealed days. | WP 3.8 `seal.test.ts`; gate re-runs the snapshotter twice over the seed and diffs the sealed range byte for byte. |
| **A missing FX rate defaults to 1.0.** D4 is dual native+base storage with a *historical* rate. The failure mode is a CAD account quietly counting as USD — arithmetically plausible, materially wrong, invisible. | The conversion function returns a discriminated result, never a number with a fallback; a missing rate produces a typed `fx_rate_missing` that surfaces in the API response and on screen; `netWorthNow` already reports one total per currency rather than one number. | WP 3.8 `fx-missing.test.ts` (the §5 exit criterion) sabotage-tested by deleting the rate row; gate walks a seeded non-USD account. |
| **Market data is the second egress surface**, and the first one that runs on a *schedule* with no human present. An SSRF here reaches `db:5432` and the container metadata endpoint on a timer. | One `PriceSource` port; the WP 2.4 allow-list machinery **reused, not reimplemented** — host allow-list, scheme allow-list, literal-IP refusal, private/link-local/loopback refusal, DNS re-check against rebinding, no redirect following, no user-supplied headers, timeouts. | WP 3.4 `egress-allowlist.test.ts` with each refusal sabotaged, plus a test that fails if the implementation forks from notifications'; gate re-runs it **from inside the worker container**, which Phase 2's gate established is strictly stronger. |
| **A read-only credential that is not read-only.** A CDP key with trade permission is indistinguishable from a `can_view` key until the day something posts an order. | `key_permissions` asserted **at startup and before every sync**, connector refuses to run otherwise; no trading endpoint exists in the adapter's code at all; keys sealed with `SecretBox` exactly as Plaid's are. | WP 3.5 `permissions.test.ts` + `custody.test.ts` (raw column read back through `psql`, the WP 1.3b pattern); gate sabotage: hand it a key claiming `trade` and watch the connector refuse. |
| **One asset, two securities.** ETH from Coinbase, ETH from a wallet, ETH from a brokerage — three identifiers. Two `securities` rows means allocation double-counts and TWR is wrong for both. | One `SecurityResolver`, four tiers, first answer wins, every tier named and enumerable; `security_identifiers` carries the provider identifiers as evidence, never as the identity — the D25 shape, applied to securities. | WP 3.1 `resolver.test.ts` → the §5 exit criterion; gate links a Coinbase account and a watch-only ETH address and asserts one row. |

---

## 6. Open questions for Chris

Work proceeds on the stated default; an answer is a cheap change.

1. **Which market-data keys will you create?** Default: **all four — Tiingo (equity/ETF EOD, the D17
   default), FRED (macro, FX, and the market rate C1/C2 need), CoinGecko Demo (crypto), OpenFIGI
   (symbol→FIGI)**. Every adapter degrades to "no price, stale flag, visible" without its key, so Phase 3
   completes with zero keys — it just cannot prove freshness. **The ToS terms are not negotiable defaults:**
   CoinGecko requires visible attribution with logo and link, FRED its exact disclaimer string, and Tiingo's
   personal tier forbids redistribution.
2. **Is the Coinbase account available, and may Wave A hit it?** Default: **yes, with a `can_view`-only CDP
   key, and the R6 ledger-gap prototype is the first thing WP 3.5 does.** If v3 has no deposit/withdrawal/
   staking ledger, the fallback is CSV export for basis, holdings-level valuation ships, and **lot-level
   crypto cost basis is carried** — which §2.3's cut order already puts last. If the account is unavailable,
   WP 3.5 builds against recorded fixtures and ships disabled.
3. **Base currency.** Default: **USD base, currency-aware model, USD-only UI in v1** (§8 Q2, D4). The
   consequence worth stating: a non-USD account without an FX rate **surfaces as an error on screen** rather
   than quietly counting as dollars. If you hold nothing outside USD, WP 3.8 still builds the path — the exit
   criterion requires it — and the seed is then the only thing that exercises it.
4. **Which brokerage via Plaid Sandbox investments?** Default: **a Sandbox institution declaring the
   `investments` product, `user_good`, and no Production link in Phase 3** — the 10-Item ratchet (D16, R5)
   means the institution list is decided before the first Production link, not during a build phase.
5. **Target allocation** (§8 Q9). Default: **ask in onboarding; drift alerts suppressed until it is set.**
   WP 3.10's rules withhold rather than invent a 60/40. An unset target never becomes an implied one.
6. **Notification delivery sink.** Default: **a `dev-sinks` compose profile (`mailpit`, `ntfy`) so a
   *successful* delivery is observable in CI and at the gate**; say the word and 3.13 aims it at your topic.
7. **Watch-only crypto addresses.** Default: **WP 3.6 ships one BTC xpub and one ETH address as test
   vectors, connector disabled until you add yours.** Never a private key, never a seed phrase (§8 Q5).
8. **Real-data exit criteria, now four** — two institutions on schedule, a month with zero internal
   transfers, the recurring gold set, and **a real brokerage's holdings reconciling to its own statement**.
   Default: **Phase 3 closes on seed and Sandbox evidence**, all four carried to the first production link,
   where they become one verification session rather than a phase.
