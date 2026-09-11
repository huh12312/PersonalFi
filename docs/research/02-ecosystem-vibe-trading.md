# 02 — Open-source ecosystem, Vibe-Trading, and prior art

*Compiled 2026-09-11 from six sub-research reports (Vibe-Trading repo inspection, OSS prior-art audit, closed-app benchmark, recurring/merchant library survey, ledger-engine and taxonomy survey, aggregator and market-data survey). The original panel agent was cut off by a rate limit before assembling its memo; this document consolidates the verified sub-reports it had already commissioned. All license and activity facts were pulled from the GitHub REST API, npm, PyPI, crates.io, or Hugging Face on 2026-09-10/11, not from memory. "NOASSERTION" from GitHub's detector was resolved by reading the raw LICENSE file in every case.*

## Executive summary

1. **Vibe-Trading is MIT (verified), v0.1.15 released 2026-09-09, Python 3.11+, `pip install vibe-trading-ai`.** No copyleft risk. But it is **not a research-only tool**: it connects to 14+ live brokers (Alpaca, IBKR, OKX, Binance, Futu, MT5, …), executes real orders, ships an MCP server with 74+ tools, and runs an autonomous agent loop. It must be integrated as a hostile-by-construction sidecar with no path to money.
2. **Its surfaces are a FastAPI HTTP server, a CLI, a web/Electron UI, and MCP over stdio.** It is a `0.x` project with ~551 commits and 35 contributors: no SemVer guarantees, heavy dependency closure (LangChain-class LLM stack plus broker SDKs). Pin by image digest; never import it into our process.
3. **Almost every mature open-source personal-finance app is AGPL.** Firefly III, Ghostfolio, Wealthfolio, Sure (the live Maybe fork), Paisa, Midday, OpenBB: all AGPL-3.0. **Actual Budget is the MIT exception** and the only project we may copy code from.
4. **Maybe Finance is archived (2025-07-24) and was always AGPL.** The "relicensing" story is a conflation with a codebase rewrite. Its live successor is `we-promise/sure` (AGPL, ~374 contributors, pushed 2026-09-11), whose 40-adapter provider registry is the best map of what a self-hoster can integrate in 2026.
5. **Ghostfolio does not compute TWR or MWR.** Those calculator classes are 29-line stubs that throw. It ships ROAI only. Do not cite it as prior art for performance math.
6. **The highest-value vendorable code, all from Actual (MIT/ISC):** the CRDT sync core, the recurring-schedule detector (`find-schedules.ts`), the OFX/QIF/CAMT parsers, and the YNAB importers. **One landmine:** Actual's `loot-core` depends on `hyperformula` (GPL-3.0-only) for its experimental formulas feature. Exclude it.
7. **No permissive library solves merchant-name normalization or recurring detection end to end.** We assemble both from MIT/BSD primitives plus our own rule corpus. A GPL trap sits next to the right answer: PyPI `Levenshtein` is GPL-2.0-or-later and published by the same org as MIT `rapidfuzz`.
8. **No mature MIT double-entry ledger library exists in TypeScript or Go.** The MIT-safe options are Ledger CLI (BSD-3), Tackler-NG (Apache-2.0, Rust), django-hordak (MIT, schema reference), and the `doubleentry` Rust crate (MIT/Apache). Beancount is GPL-2.0-only, hledger GPL-3.0-or-later. We roll our own on Beancount's *concepts*.
9. **Plaid's Personal Finance Category CSV has no license grant.** Use it as a structural blueprint with our own labels and descriptions; do not vendor the file. `greggles/mcc-codes` (Unlicense, derived from USDA/IRS) is the clean MCC source.
10. **Aggregator fallbacks for an individual:** SimpleFIN Bridge ($1.50/mo, US/CA, banking only, 90-day window) is the consensus fallback all three OSS apps support. Teller has a free tier of 100 connections aimed at indie developers. GoCardless/Nordigen closed to new signups July 2025; Enable Banking is quote-only; Akoya requires a company. EU hobbyist path has regressed badly.

---

## 1. Vibe-Trading deep dive

### 1.1 What it is

| Fact | Value | Source |
|---|---|---|
| License | **MIT**, "Copyright (c) 2026 Vibe-Trading Contributors" | LICENSE file, verified 2026-09-10 |
| Latest release | **v0.1.15, 2026-09-09** | GitHub releases |
| Runtime | Python **3.11+**, `pip install vibe-trading-ai` | README / pyproject |
| Surfaces | **FastAPI HTTP server**, CLI, web UI, Electron desktop, **MCP server (stdio)** | README |
| LLM | Anthropic / OpenAI / OpenAI-compatible / **Ollama** | README |
| Brokers | **14+ live**: Alpaca, IBKR, OKX, Binance, Futu, MT5, … | README |
| Execution | **Yes.** Paper *and* live order placement | README, 03-security §0 |
| Tool surface | **74+ MCP tools**, autonomous agent loop | README |
| Safety features (theirs) | kill switch, hash-chained append-only audit ledger, mandate-based position limits, fail-closed on missing data, OS-keyring credential storage | README |
| Activity | ~551 commits, 35 contributors, sub-1.0 versioning | GitHub API |

**What this means.** Chris described it as "a separate open-source effort" to integrate later. The panel's security seat fetched the repo and found a trading-execution platform. Its own safety model is thoughtful, but it is *their* code enforcing *their* invariants, on a `0.x` cadence, with an LLM in the loop and an attacker-controllable input channel if we ever feed it our transaction text. PersonalFi's controls must hold even if the sidecar is fully compromised.

### 1.2 Interfaces we can bind to

- **HTTP (FastAPI):** the intended integration surface. Endpoints are unversioned in 0.x. Treat every response as untrusted JSON validated against *our* schema.
- **MCP over stdio:** the richest surface (74+ tools) but requires spawning the process as a child, which puts it inside our process boundary. **Reject** for the app; acceptable only for an operator-run CLI experiment.
- **CLI:** usable for Stage 0 (batch export/import via files on an isolated volume).
- **Config:** environment variables plus a config file; broker and LLM credentials go through the OS keyring in native mode, which does not exist in a container. In our deployment, **only an LLM key is ever mounted**, and only as a Docker secret.

### 1.3 What breaks on upstream change, and how we isolate it

| Change upstream | Blast radius without isolation | With the adapter |
|---|---|---|
| HTTP route renamed / response reshaped | Our UI breaks | `vt-adapter` contract test fails in CI; sidecar profile goes dark; core app unaffected |
| New dependency with a copyleft or vulnerable transitive | Enters our SBOM and license gate | Stays in *their* image; excluded from our gate by policy (06 §7.3) |
| Python version bump | Our Alpine build breaks | Their image, their base; we pin by digest and bump deliberately |
| New broker integration enabled by default | New credential surface | We mount no broker credentials; egress allow-list denies broker hosts |
| Agent loop gains a new "execute" tool | Money moves | No broker write credentials exist in the container; structurally impossible |

---

## 2. Integration contract proposal

This section aligns with 08-system-architecture §5 (the seam) and 03-security §8 (the controls). It is stated here from the integration-engineering angle.

### 2.1 Topology

```
[api/worker] --HTTP (outbound only)--> [vt-adapter (ours, MIT, Alpine)] --HTTP--> [vibe-trading (upstream image, pinned digest)]
      |                                          |                                         |
   db network                              sidecar network                          sidecar network
                                                                                    + egress proxy (allow-list)
```

- `vibe-trading` has **no route to `db`**, no route to `api`, no volumes shared with core, no Plaid tokens, no exchange keys, no broker credentials. Evidence: `getent hosts db` fails from inside the container (03 P0-8).
- `vt-adapter` is the **anti-corruption layer** we own: it translates our versioned `AdvisorRequest` into upstream's request shape and validates upstream's response into our `Insight[]` schema (`additionalProperties: false`). Everything upstream-specific lives here and nowhere else.
- Traffic is **app → adapter → sidecar only**. No callbacks, no webhooks, no shared filesystem.

### 2.2 Data we push (minimized)

| Field | Form | Rationale |
|---|---|---|
| Holdings | ticker/FIGI, **weight as % of portfolio**, asset class | Percentages, never dollars (04 §6.6) |
| Cash | % of portfolio | same |
| Watchlist | tickers | user-curated, no PII |
| Risk profile | 0.5–10 score, horizon in years | scalar |
| Goals | type, horizon, target as % of current net worth | no absolute amounts |
| Transactions | **never** | prompt-injection channel; not needed for portfolio research |

### 2.3 Data we pull

`Insight[]` objects: `{kind, title, body, evidence[], confidence, severity ≤ "info", requires_review: true, advisor: "vibe-trading@<digest>"}`. Any `kind` that looks like an order (`buy`, `sell`, `rebalance_execute`) is rendered as an **inert card** requiring "I will execute this myself at my broker" acknowledgment, gated by step-up WebAuthn, and logged to the security event table. There is no code path from sidecar output to an order.

### 2.4 Pinning and upgrade

- `compose.yml` references `ghcr.io/hkuds/vibe-trading@sha256:…` (or our own build from a tagged upstream commit if they publish no image). Renovate watches the upstream repo; bumps arrive as PRs that run the adapter's contract tests against the new digest.
- `docs/compat/vibe-trading.yaml` records `{upstream_tag, digest, adapter_version, contract_version, verified_on}`.
- Kill switch: `docker compose --profile sidecar down` and the `ADVISOR_VIBE_ENABLED=false` flag; the dashboard must render identically with the sidecar absent.

### 2.5 Staged plan

| Stage | What | Effort | Exit criterion |
|---|---|---|---|
| 0 | "Export holdings CSV for Vibe-Trading" button; Chris runs it by hand on his own machine | 0.5 day | CSV round-trips into upstream's import |
| 1 | Sidecar + adapter on a schedule; signals ingested into the Insight review queue | 3–5 days | Contract tests green; P0-8/P0-9 evidence recorded; UI unchanged when sidecar down |
| 2 | Interactive panel (ask a research question, see a report) behind a feature flag | 5–8 days | Payload preview before first send of each query type; egress log shows only allow-listed hosts |

Stage 0 may be the permanent answer. We should be willing to say so.

---

## 3. Prior-art table

Verdict key: **(i)** safe to vendor code · **(ii)** design inspiration only (copyleft) · **(iii)** permissive with a caveat.

| Project | License (verified) | Stack | Status | Bank sync approach | Verdict |
|---|---|---|---|---|---|
| **Actual Budget** `actualbudget/actual` | **MIT** root; `loot-core` is **ISC** | TS, SQLite, CRDT | 28.7k★, v26.9.0, pushed 2026-09-10 | SimpleFIN, GoCardless (closed), Enable Banking, Pluggy, Akahu; **no Plaid** | **(i)** with `hyperformula` GPL exclusion |
| **Maybe** `maybe-finance/maybe` | AGPL-3.0 | Rails, PG, Sidekiq | **ARCHIVED 2025-07-24** | Plaid (US+EU); self-hosted Plaid explicitly unsupported | (ii), dead |
| **Sure** `we-promise/sure` | AGPL-3.0 | Rails | 9.8k★, ~374 contributors, pushed 2026-09-11 | ~40 adapters: Plaid, SimpleFIN, SnapTrade, Enable Banking, Akahu, Coinbase, Kraken, Etherscan, mempool.space, Tiingo, Twelve Data, … | (ii) — the adapter list is the map |
| **Firefly III** + `data-importer` | AGPL-3.0-or-later | PHP 8.5 / Laravel 13 | 24.6k★, v6.6.6, pushed 2026-09-10 | Separate importer container: CSV, CAMT.05x, GoCardless, SimpleFIN, Enable Banking, Sophtron, LunchFlow. **Spectre/Salt Edge removed.** | (ii); `import-configurations` and docs are **CC-BY-SA-4.0**, do not copy |
| **Ghostfolio** | AGPL-3.0 | Nx, NestJS, Prisma, Angular | 9.3k★, 3.69.0, pushed 2026-09-10 | **None** (activity-driven). Market data: Yahoo, CoinGecko, Alpha Vantage, EODHD, FMP, Google Sheets, RapidAPI, Manual, plus paid `GHOSTFOLIO` source | (ii); TWR/MWR are stubs |
| **Wealthfolio** | AGPL-3.0 | Tauri + Rust | 8.9k★, pushed 2026-09-10 | Manual/CSV | (ii) |
| **OpenBB** | **AGPL-3.0** (confirmed from LICENSE) | Python | 72.9k★ | n/a | (ii) |
| **Paisa** | AGPL-3.0 | Go + ledger | 3.2k★ | PTA files | (ii) |
| Lunch Money / Monarch / Copilot / Rocket Money / Wealthfront | closed | — | — | Plaid (Lunch Money, Monarch, Copilot), MX/Plaid (Rocket), Plaid/Yodlee (Wealthfront) | feature benchmark only |

### 3.1 What to borrow from each

**Actual (code, MIT/ISC):**
- `packages/crdt` — HLC timestamps, merkle-trie divergence detection, per-cell LWW, protobuf envelope, optional AES-GCM E2E. Vendor (copy in), don't depend on the npm package (its README disclaims semver).
- `server/schedules/find-schedules.ts` — recurring detector: hypothesis sweep over {weekly, every2weeks, monthly, monthlyLastDay, 1st/3rd, 2nd/4th}, ±2-day window, amount tolerance, `rank = 1/(dayDiff+1)`, backward walk to find true start. Port the algorithm; it is coupled to Actual's AQL layer.
- `server/transactions/import/` — `ofx2json.ts` (with SGML→XML repair), `qif2json.ts`, `xmlcamt2json.ts`. Only dep is `xml2js` (MIT).
- Envelope budget engine (`server/budget/envelope.ts`) — the `leftover` / `leftover-pos` / `carryover` triple and `to-budget = available + last-month-overspent + total-budgeted − buffered`. Model as a dependency graph of cells, not imperative recompute.
- Rules engine + `learn_categories` on payees.
- **Avoid:** `hyperformula` (GPL-3.0-only, formulas feature only); CRDT log growth without compaction; bank tokens stored outside the E2E envelope; manual-only sync.

**Maybe/Sure (ideas only):**
- `locked_attributes` jsonb on accounts and entries so provider syncs never clobber user edits. (We implement the equivalent as the immutable-facts + overlay model in 04 §2.2.)
- `rejected_transfers` — persist *negative* user decisions.
- Polymorphic `entryable` (Transaction | Trade | Valuation) with a DB-generated `classification` column.
- Raw provider payload stored beside normalized rows.
- Nested `syncs` with explicit backfill windows.
- **Avoid:** Plaid-as-schema (Sure fixed this with an adapter registry); dependence on a first-party data API (Synth died with the company).

**Firefly III (ideas only):**
- `TransactionGroup → TransactionJournal → Transaction` double-entry split; expense/revenue as first-class accounts.
- Out-of-process importer holding bank credentials, talking to core over a scoped token. (We adopt the boundary but keep credentials in core's encrypted store; see 03.)
- `LinkType` / `TransactionJournalLink` typed relations (refund-of, reimbursement-of).
- Rule actions that can change a transaction's *type* (`ConvertToTransfer`).
- **Avoid:** exposing raw double-entry to the user; single-maintainer bus factor; provider churn (Spectre added, deprecated, deleted).

**Ghostfolio (ideas only):**
- `DataSource` enum + one directory per provider behind one service; `MANUAL` and `GOOGLE_SHEETS` as pressure valves for illiquid assets.
- `AssetProfileOverrides` (user corrections over provider data) and `AssetProfileSplit` (corporate actions).
- X-ray rules as discrete, testable modules: account/asset-class/currency/regional cluster risk, emergency fund, fees, liquidity.
- FIRE calculator component.
- **Avoid:** empty abstraction scaffolding (four calculators, three throw); the paid `GHOSTFOLIO` hook.

### 3.2 Closed-app benchmark: what to imitate

| Product | Signature mechanic to adopt | Skip |
|---|---|---|
| **Wealthfront Path** | Forecast from **revealed behavior** (rolling 12-month actual savings/spending); Monte Carlo with explicit "this is the median"; **clickable dotted gap line** that solves for required monthly savings; threshold rebalancing with cash-flow-first execution; risk questionnaire with a consistency penalty; assumptions inspectable and editable behind "show assumptions" | TLH/direct-indexing execution; account minimums; hardcoded capital-market assumptions; standalone-Path removal |
| **Monarch** | **Flex budgeting** (Fixed / Flexible / Non-monthly with one flexible top-line); saved reports with click-through drill-down; sparkle-icon **inline** insights; draggable life-event timeline on the forecast; pay-down goals with avalanche vs snowball side-by-side; RSU vesting as an account type | Paywalled forecasting; Zestimate hard dependency; household features |
| **Copilot** | Two-line **spending-pace chart** (dotted ideal vs solid actual, color by pct-budget vs pct-month); "To Review" inbox on the dashboard; **internal-transfer auto-detection**; refund matching; Money Assistant contract (suggest → approve → graduated autonomy) | Email-forwarding integrations; referral widgets; iOS-native idiom |
| **Rocket Money** | Recurring tab as the product spine with price-change detection and "View instructions" per merchant; Comfy/Moderate/Aggressive presets + balance-protection floor for savings rules; auto-pause on goal completion; "you spent 23% more on groceries" comparatives; net worth as assets vs debt | Concierge cancellation/negotiation; hidden pricing; crippled free tier; credit-score monitoring (bureau agreements) |
| **Lunch Money** | Rules engine action set (split, link-to-recurring, notify); **rules-off-by-default on the API**; two-axis rollover (general pool + per-category); "remaining recurring" and "projected" columns on the summary card; Analyze query tool; OpenAPI + mock server | Crypto balance-only tracking (breaks cost basis); Plaid as the only sync path |

Cross-product: the ten features present in three or more products are dashboard (net worth + pace), transactions with review queue + rules, categories with groups, budget with rollover, recurring with upcoming timeline + price alerts, cash flow (Sankey/trend), reports with drill-through, investments aggregated by ticker, goals with status, and net worth over time split assets/debts.

---

## 4. Reusable components: verdicts

### 4.1 Recurring detection and recurrence math

| Component | License | Verdict |
|---|---|---|
| Actual `find-schedules.ts` | ISC | **(i) port the algorithm** |
| `rrule` (jkbrzt/rrule) | BSD-3-Clause (read from LICENCE; GitHub says NOASSERTION) | (i); stale since 2024 but stable, 1.6M weekly downloads |
| `@rschedule/core` | Unlicense | (iii) unmaintained since 2023; rule-composition algebra is nicer than rrule |
| `date-fns` | MIT | (i) |
| `ical.js` | MPL-2.0 | (iii) file-level copyleft; fine as unmodified dep, track separately |
| Dedicated "subscription detector" repos | mostly **no license** | unusable |
| stumpy / tsfresh / pyts | BSD/MIT | (i) but overkill for sparse series |

### 4.2 Merchant normalization

No end-to-end library exists. Pipeline: own descriptor-regex corpus (`SQ *`, `TST*`, `PAYPAL *`, `AMZN Mktp`, store numbers, city/state tails) → Unicode repair (`ftfy` Apache-2.0 / `String.normalize('NFD')`) → legal-suffix stripping (`cleanco` MIT) → OpenRefine fingerprint clustering (reimplement; BSD-3) → fuzzy match (`rapidfuzz` MIT in Python, `fastest-levenshtein` MIT or `Fuse.js` Apache-2.0 in JS) → MCC fallback (`greggles/mcc-codes` Unlicense). Study `opensanctions/rigour` (MIT, pushed 2026-09-10) as the closest permissive analogue. `usaddress`/`probablepeople` (MIT) CRF token tagging is the right shape if we later train a descriptor parser.

**Deny-list in CI:** `Levenshtein`, `python-Levenshtein` (GPL-2.0-or-later), `fuzzywuzzy` (GPL-2.0, archived). `thefuzz` is now MIT and depends only on rapidfuzz, but use rapidfuzz directly.

### 4.3 Ledger engines and money math

| Component | License | Verdict |
|---|---|---|
| Beancount v3 / beanquery / beangulp | GPL-2.0-only | (ii) copy the *concepts*: directive set, booking methods STRICT/FIFO/LIFO/HIFO/AVERAGE/NONE |
| hledger | GPL-3.0-or-later | (ii) |
| Ledger CLI | BSD-3-Clause | (i) |
| Tackler-NG (`tackler-core`) | Apache-2.0 | (iii) only embeddable production-grade PTA engine |
| django-hordak | MIT | (i) best permissive relational Account/Transaction/Leg model |
| `doubleentry` crate | MIT OR Apache-2.0 | (i) v0.x; scaled-i64 amounts, balanced-by-construction; no lots |
| `beancount_parser_lima` | MIT OR Apache-2.0 | (i) vendor `src/`, **not** `test-cases/` (GPL Beancount fixtures) |
| TigerBeetle | Apache-2.0 | (iii) cluster process, not a library; overkill |
| Formance Ledger / Numscript | MIT | (i) Numscript is the embeddable piece |
| Midaz | **Elastic License 2.0** | not open source; do not vendor |
| dinero.js, decimal.js, big.js, currency.js | MIT | (i) |
| `medici` | MIT | (i) but Mongoose-bound and float-limited |

### 4.4 Taxonomies and categorization

| Component | License | Verdict |
|---|---|---|
| Plaid PFC v1/v2 CSVs | **no license grant found**; ToS reserves all rights | structural blueprint only; own labels + descriptions; map at runtime |
| `greggles/mcc-codes` | Unlicense | (i) ship verbatim |
| `python-iso18245` | MIT code; bundled Visa/MC/Amex descriptions unverified | (iii) take range logic, not descriptions |
| GnuCash `.gnucash-xea` charts | GPL | (ii) richest tree; read, then author our own |
| Sure `category.rb` 22-category tree | AGPL | (ii) the right *size* target |
| `smart_importer` FeatureUnion→SVC | MIT code, GPL deps | reimplement the ~200-line pipeline on our types |
| `DoDataThings/us-bank-transaction-categories-v2` | MIT, synthetic, 68k rows | (i) evaluation / warm start only |
| `kuro-08/bert-transaction-categorization` | Apache-2.0, weights present | (iii) only credible pretrained model |
| `mitulshah/*` | "MIT" but gated / no weights | ignore |

### 4.5 File-format parsers (all permissive, vendor freely)

`bradenmacdonald/ofx-js` (MIT, 2026-05), `Fabiopf02/ofx-data-extractor` (MIT, 2026-09), `jseutter/ofxparse` (MIT, Python), `wolph/mt940` (BSD-3), `sepa` (MIT). **`ofxtools` is GPL-3.0-only despite common claims.** No maintained CAMT.053 parser exists; write our own against the XSD.

### 4.6 Market data and crypto (cross-reference 01)

Tiingo default (personal-use ToS matches), FRED macro, OpenFIGI mapping, CoinGecko Demo with mandatory attribution UI; Yahoo/yfinance opt-in only (no data license). Polygon rebranded to Massive.com. CryptoCompare's free tier was retired May 2026. Coinbase: Advanced Trade v3 + CDP keys (`can_view` only, Ed25519 JWT, 120 s); legacy keys expired 2025-02-05. Kraken "Query Funds/Ledger" keys, Gemini "Auditor" role, Binance.US "Enable Reading" for read-only exchange access. On-chain: Esplora/mempool.space address-level (derive from xpub ourselves), BlockCypher HD wallets (100 req/hr), Etherscan v2 multichain (free-tier chain coverage shrank Nov 2025; prefer Alchemy for token enumeration), Solana public RPC / Helius free tier.

---

## 5. Recommendations

1. **Integrate Vibe-Trading only through `vt-adapter`, in Stage 0 first.** MIT removes the legal concern; nothing removes the execution-engine concern.
2. **Copy code from Actual and nowhere else.** CRDT core, schedule detector, parsers, budget-cell engine. Exclude `hyperformula`.
3. **Treat Sure's provider list as the integration roadmap** and Firefly's importer boundary as the credential-isolation pattern; reimplement clean-room.
4. **Build merchant normalization and recurring detection ourselves** from the primitives in §4.1–4.2, with a labeled golden set from day one.
5. **Author our own category taxonomy** (about 20 top-level, 2 levels) shaped by PFCv2 and GnuCash, with our own descriptions; ship `mcc-codes` for fallback.
6. **Add a CI license deny-list** seeded with `Levenshtein`, `python-Levenshtein`, `fuzzywuzzy`, `hyperformula`, `ofxtools`, `beancount*`, and any `UNKNOWN`.
7. **Do not depend on any 2026-vintage single-author npm "double-entry" package.** Roll the ledger on django-hordak's shape and Beancount's booking concepts.

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| E1 | Vibe-Trading's HTTP surface changes without notice (0.x) | Adapter contract tests on every digest bump; sidecar profile fails closed |
| E2 | Upstream stops publishing images or changes license | We build from a pinned commit; standing policy for copyleft sidecars is separate image over network only |
| E3 | GPL creep via a look-alike package (`Levenshtein`, `ofxtools`) | Deny-list + two independent license scanners (06 §5.4) |
| E4 | Copying an AGPL project's "obvious" schema too literally | Clean-room rule: write from the concept list in this memo, never from source |
| E5 | Plaid PFC descriptions redistributed by accident | Runtime mapping table with our own text; CI grep for Plaid description strings |
| E6 | Hugging Face datasets with unverifiable provenance shipped as lookup tables | Evaluation-only policy; provenance note required before bundling |
| E7 | Merchant normalization quality below user tolerance | Labeled golden set, precision/recall gate, user-confirmed pinning, rules as the escape hatch (Actual's lesson) |
