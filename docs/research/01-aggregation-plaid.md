# 01 — Data Aggregation: Plaid, Alternatives, Crypto, Market Data

**Author:** Data Aggregation panelist
**Date:** 2026-09-10
**Scope:** Account aggregation and pricing-data strategy for a self-hosted, MIT-licensed, Dockerized (Alpine) single-user personal finance app.
**Verification note:** Every pricing / tier / API-shape claim below was fetched live on 2026-09-10. Items I could not verify from a primary source are explicitly marked **[UNVERIFIED]**.

---

## Executive summary

1. **Plaid is now genuinely viable for a solo self-hoster, and this is new.** As of **2026-04-15** Plaid replaced "Limited Production" with a free **Trial plan**: real Production data, **no business registration, no security questionnaire, no sales process**, auto-approved after identity verification. ([Plaid Support, updated 2026-09-03](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan))
2. **The Development environment no longer exists.** It was decommissioned **2024-06-20** and all Development Items were deleted. There are exactly two environments today: `https://sandbox.plaid.com` and `https://production.plaid.com`. ([Glossary](https://plaid.com/docs/quickstart/glossary/))
3. **The Trial plan's binding constraint is 10 Items, and it is a hard ratchet** — `/item/remove` does **not** free a slot. Design the Item budget up front; treat "which 10 institutions" as an architectural decision, not a runtime one.
4. **Trial includes exactly the 8 products we care about** (Auth, Transactions + Refresh, Balance, Identity, Assets, Liabilities, Investments + Refresh, Statements) — but **not Recurring Transactions and not Enrich**. Subscription detection must be built in-house. This is the single biggest feature implication in this memo.
5. **We do not need Auth or Identity.** Both are money-movement/KYC products and both bill a one-time per-Item fee. A read-only PFM should request `transactions`, `investments`, `liabilities` only.
6. **Plaid publishes no price list.** Confirmed on both the billing docs and the support article: pricing is only shown inside the Production application flow. Any dollar figure circulating online is third-party hearsay. Budget planning must therefore be *structural* (subscription vs one-time vs per-request), not numeric.
7. **Pending→posted is a delete+insert, not an update.** Plaid emits the pending `transaction_id` in `removed` and the posted transaction in `added`, linked by `pending_transaction_id` (which may be `null`). Our schema must model this explicitly or we will double-count.
8. **Plaid covers crypto** — `crypto exchange` and `non-custodial wallet` are real investment account subtypes and `cryptocurrency` is a security type — but **direct-to-exchange is better for us**: no Item consumed, no reauth treadmill, full ledger access. Use Coinbase CDP keys + Advanced Trade v3.
9. **The EU hobbyist path has regressed badly.** GoCardless/Nordigen Bank Account Data **stopped accepting new accounts in July 2025**; Enable Banking went quote-only; Salt Edge wants eIDAS certs. Not our problem (US user) but it kills "just use GoCardless" as a fallback.
10. **Build a provider-abstraction layer on day one.** Plaid's 10-Item cap, SimpleFIN's $1.50/mo simplicity, and direct exchange APIs each win different slices. Hard-coding Plaid is the one decision that would be expensive to reverse.

---

## 1. Plaid

### 1.1 Environments and base URLs

| Environment | Base URL | Status |
|---|---|---|
| Sandbox | `https://sandbox.plaid.com` | Free, unlimited test Items, fully featured |
| Production | `https://production.plaid.com` | Real data. Gated by plan (Trial / PAYG / Growth / Custom) |
| ~~Development~~ | — | **Decommissioned 2024-06-20**; all Development Items deleted |

> "the Plaid Development environment was decommissioned, and all Development Items were removed" — [Plaid Glossary](https://plaid.com/docs/quickstart/glossary/)

Required headers: `PLAID-CLIENT-ID`, `PLAID-SECRET`, `Content-Type: application/json`. Credentials may be sent in the body or headers; prefer headers. ([API overview](https://plaid.com/docs/api/))

### 1.2 Access tiers — "Development" is gone, "Limited Production" is gone too

This is the most commonly-stale piece of knowledge about Plaid. The current (2026) ladder is:

| Plan | Who | Cost | Item cap |
|---|---|---|---|
| **Trial** | US/CA devs, new teams created **on or after 2026-04-15** | **Free** | **10 Production Items** |
| Pay-as-you-go | Anyone approved for Production | No minimum, no commitment | — |
| Growth | Consistent usage | Annual commitment + minimum spend | — |
| Custom (Scale) | ~$2,000/mo+ consistent spend | Annual commitment, lowest per-use cost | — |
| ~~Limited Production~~ | Legacy only | Free, capped | Deprecated for teams created after 2026-04-15 |

> "For developers in the US and Canada creating a new Plaid team on or after April 15, 2026, Plaid offers a free Trial plan. The Trial plan lets you use Plaid with real production data at no cost, with a cap of 10 Production Items."
> — [Plaid Support: pricing plans, updated 2026-06-03](https://support.plaid.com/hc/en-us/articles/16110502116887-What-are-Plaid-s-prices-and-pricing-plans-and-how-do-they-differ)

**EU/UK note:** "For customers based in Europe, we only offer Custom plans at this time." Same source.

### 1.3 What an individual developer actually needs (the key finding)

From [What is the Plaid Trial plan?](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan), **article updated 2026-09-03** (one week ago):

> "The Plaid Trial plan provides free access to Plaid's production APIs. You can connect real financial accounts, call production endpoints, and build projects — **no business registration, security questionnaire, or sales process required**."

Concretely:

- **Eligibility:** located in US or Canada; must not already have a Production or Limited Production account. If you have a pending/approved Production application or existing Limited Production, "there is currently no self-service way to switch."
- **Agreements:** must accept the standard **Master Services Authorization Agreement (MSA)** plus attestations "about keeping your accounts, data, and code secure." Cannot submit without these.
- **Approval:** "Most Trial plan applications are approved automatically after identity verification." Manual review, if triggered, is 2–3 business days.
- **Included (8 products):** Auth, Transactions (incl. Transactions Refresh), Balance, Identity, Assets, Liabilities, Investments (incl. Investments Refresh), Statements.
- **Excluded:** Identity Verification, Signal Transaction Scores, Transfer, Consumer Report Access (CRA), Monitor.
- **Item cap:** 10. **"Calling `/item/remove` on the Trial plan does not free up slots against your 10-Item cap."**
- **API calls:** "API calls against your existing connected Items are not capped."
- **OAuth coverage:** "includes OAuth access to most major financial institutions, including Bank of America, Chase, Wells Fargo, Capital One, Citi, Navy Federal, PNC, U.S. Bank, American Express, and Merrill." Access typically live **6–24 hours** after approval.
- **One-way door:** "Upgrading from the Trial plan to Production is a one-way change. Once your Production account is approved, you cannot revert to the Trial plan."

> **Implication:** For Chris's use case — one person, a handful of institutions — the Trial plan is likely *permanently sufficient* and permanently free. 10 Items covers e.g. checking bank + credit card issuer + brokerage + 401k + mortgage servicer + 4 spares. The cost model only breaks if he churns institutions.

**Caveat worth internalizing:** Recurring Transactions and Enrich are *not* in the Trial bundle. The 8-product list is explicit and exhaustive. Plan accordingly (§5.6).

### 1.4 Pricing — what is and isn't knowable

Plaid does not publish a price list. Both primary sources agree:

> "A price list is not available in the documentation. To view pricing, apply for Production access. Pricing information for Pay-as-you-go and Growth plans will be displayed on the last page before you submit your request." — [Pricing and billing](https://plaid.com/docs/account/billing/)

What *is* documented is the **billing model per product**, which is what matters for architecture:

| Model | Products | Behavior |
|---|---|---|
| **Subscription (per Item, per calendar month UTC)** | Transactions, Recurring Transactions, Liabilities, Investments | **Not pro-rated.** Billed "even if no API calls are made for the Item" and even if the Item is in an error state. Ended by `/item/remove` or user depermissioning. |
| **One-time fee (per Item)** | Auth, Identity, Income, Layer | Charged when the product is successfully added to an Item. Identity via `optional_products` charges only on first call. |
| **Per-request flat fee** | Balance, Signal, `/transactions/refresh`, `/investments/refresh`, Identity Match, Asset Report PDF | Billed per successful call. |
| **Per-request flexible fee** | Assets, Statements Refresh, **Enrich** | Variable. |

Source: [plaid.com/docs/account/billing](https://plaid.com/docs/account/billing/), fetched 2026-09-10.

**Architectural consequences:**
- A dead/errored Item still bills. Our reconnect UX is a cost-control feature, not just a UX feature.
- Never poll `/accounts/balance/get` on a schedule — it's per-request billed. Use the cached balances in `/accounts/get` / the `accounts` array returned by `/transactions/sync`.
- Never call `/transactions/refresh` on a timer. Webhook-driven sync is free; refresh is not.

> Third-party sites quote figures like "$0.30/item for Transactions" or "$0.05–$0.15 per Balance call." **Do not plan against these.** They are unsourced aggregator-blog numbers, contradicted by Plaid's own "pricing is not published" statement. **[UNVERIFIED]**

### 1.5 Product-by-product: do we need it?

| Product | Endpoint(s) | Need it? | Why |
|---|---|---|---|
| **Link** | `/link/token/create`, `/item/public_token/exchange` | **Yes** | Only way to create an Item. `link_token` expires ~4h; `public_token` expires 30 min. |
| **Transactions** | `/transactions/sync` | **Yes — core** | Cursor model. See §5. |
| **Investments** | `/investments/holdings/get`, `/investments/transactions/get`, `/investments/refresh` | **Yes** | Holdings + cost basis for wealth trajectory. |
| **Liabilities** | `/liabilities/get` | **Yes** | Mortgage/student/credit APRs for net-worth and payoff modeling. |
| **Balance** | `/accounts/balance/get` | **Sparingly** | Forces real-time extraction (p50 ~3s, p95 ~11s), per-request billed. Cached balances update ~daily on a Transactions Item — good enough for a PFM. |
| **Auth** | `/auth/get` | **No** | Account/routing numbers for ACH. We never move money. |
| **Identity** | `/identity/get` | **No** | Account-owner verification. Irrelevant for a single-user app where the user *is* the owner. |
| **Recurring Transactions** | `/transactions/recurring/get` | **Not on Trial** | See §5.6. |
| **Enrich** | `/transactions/enrich` | **Not on Trial** | Useful later for CSV/manual imports; no Item required; max 100 txns/request. |

Auth/Identity guidance is explicit: Auth exists "to initiate credits or debits via ACH, wire transfer, or equivalent international networks." Requesting them adds Link friction and a per-Item fee for zero benefit. ([Auth docs](https://plaid.com/docs/auth/))

### 1.6 Webhooks

**Registration:** via the `webhook` parameter of `/link/token/create`; changed later with `/item/webhook/update` (which fires `WEBHOOK_UPDATE_ACKNOWLEDGED`). URL must be `http(s)://(www.)domain.com/` form with a valid SSL cert. ([Webhooks overview](https://plaid.com/docs/api/webhooks/))

**Envelope:** `webhook_type`, `webhook_code`, `item_id`, `environment`.

| Type | Codes we care about |
|---|---|
| `TRANSACTIONS` | **`SYNC_UPDATES_AVAILABLE`** (the only one we need), plus legacy `INITIAL_UPDATE`, `HISTORICAL_UPDATE`, `DEFAULT_UPDATE`, `TRANSACTIONS_REMOVED` |
| `ITEM` | `ERROR`, `LOGIN_REPAIRED`, `NEW_ACCOUNTS_AVAILABLE`, `PENDING_DISCONNECT`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED`, `USER_ACCOUNT_REVOKED`, `WEBHOOK_UPDATE_ACKNOWLEDGED` |
| `HOLDINGS` | `DEFAULT_UPDATE` |
| `INVESTMENTS_TRANSACTIONS` | `DEFAULT_UPDATE`, `HISTORICAL_UPDATE` |
| `LIABILITIES` | `DEFAULT_UPDATE` |
| `RECURRING_TRANSACTIONS` | `RECURRING_TRANSACTIONS_UPDATE` |

`SYNC_UPDATES_AVAILABLE` carries two booleans: `initial_update_complete` (true once "at least 30 days of history is available") and `historical_update_complete` (true once "the full history (up to 24 months) is available"). ([Transactions webhooks](https://plaid.com/docs/transactions/webhooks/))

#### Webhook verification (JWT / ES256) — implement exactly this

From [webhook-verification docs](https://plaid.com/docs/api/webhooks/webhook-verification/):

1. Read the `Plaid-Verification` header — it is a JWT.
2. Decode the **header only**, without verifying. Assert `alg == "ES256"`. > "Ensure that the value of the `alg` (algorithm) field in the header is `ES256`. Reject the webhook if this is not the case." (This blocks the classic `alg: none` / HMAC-confusion attack.)
3. Extract `kid`. Call `/webhook_verification_key/get` with `client_id`, `secret`, `key_id` → returns a JWK (EC).
4. **Cache the key by `kid`.**
5. Verify the JWT signature against the JWK.
6. Assert `iat` is not "more than 5 minutes old" — replay protection.
7. Compute SHA-256 of the **raw request body** and constant-time-compare against the `request_body_sha256` claim. Note the docs' quirk: the hash is over the body serialized with **2-space indentation** — so you must hash the bytes *as received*, not a re-serialized object.

> Use a vetted JWT library. Plaid: "It is highly recommended that you utilize well-tested libraries rather than trying to implement these specifications from scratch."

### 1.7 Item lifecycle

| State / webhook | Meaning | Remedy |
|---|---|---|
| `ITEM_LOGIN_REQUIRED` | Credentials changed / MFA / OAuth expired | **Link update mode** |
| `PENDING_EXPIRATION` | EU/UK consent expiring; fires **7 days** before | Link update mode |
| `PENDING_DISCONNECT` | US/CA consent expiry or institution migration | Link update mode |
| `USER_PERMISSION_REVOKED` / `USER_ACCOUNT_REVOKED` | User revoked at Item or account level | Re-link |
| `ACCESS_NOT_GRANTED` | Permissions need re-granting | Link update mode |
| `ITEM_NOT_SUPPORTED`, `ITEM_LOCKED`, `USER_SETUP_REQUIRED`, `NO_ACCOUNTS` | Institution-side problem | Re-link from scratch |
| `LOGIN_REPAIRED` | Item self-healed (possibly via another app) | Dismiss the error banner |
| `NEW_ACCOUNTS_AVAILABLE` | New account at the institution | Update mode with account selection |

`consent_expiration_time` (ISO 8601) on the Item indicates when consent lapses.

**Update mode** — `/link/token/create` with `access_token` set, plus `client_name`, `country_codes`, `language`, `user.client_user_id`, and `redirect_uri` for OAuth. Critically:

> "the `access_token` does not change when using Link in update mode, so there is no need to repeat the exchange token process."

Do **not** populate `products` during standard update mode. For account add/remove, set `update.account_selection_enabled: true` — but note "any de-selected accounts will no longer be shared with you." ([Update mode docs](https://plaid.com/docs/link/update-mode/))

#### OAuth institutions — the reauth treadmill

Registration requirements: create a hosted redirect URI (a blank HTTPS page is fine), register it under **Allowed redirect URIs** in the Dashboard, and pass `redirect_uri` to `/link/token/create`. HTTP localhost is Sandbox-only. ([OAuth docs](https://plaid.com/docs/link/oauth/))

**This matters for a self-hosted app:** Production OAuth requires a *publicly reachable HTTPS redirect URI*. A LAN-only Docker deployment cannot complete OAuth Link for Chase/BofA/etc. We need either a public hostname with TLS or a tunnel for the duration of the Link flow.

Documented reauth cadences:

| Institution | Consent refresh |
|---|---|
| Chase | User picks 6 months / 1 year / "always" — **no default** |
| Bank of America (new API), Capital One | Yearly |
| USAA | Every 18 months |
| Brex | Every 3 months |

Most institutions approve within hours after Production/Trial approval; **Charles Schwab may take up to six weeks.**

### 1.8 Rate limits

Per-Item and per-client, Production ([rate-limit docs](https://plaid.com/docs/errors/rate-limit-exceeded/)):

| Endpoint | Per Item | Per client |
|---|---|---|
| `/transactions/sync` | 50/min | 2,500/min (**500/min for empty-cursor requests**) |
| `/transactions/refresh` | 2/min, 120/hr, 2,880/day | 100/min, 18,000/hr, 432,000/day |
| `/transactions/recurring/get` | 20/min | 1,000/min |
| `/investments/holdings/get` | 15/min | 2,000/min |
| `/investments/transactions/get` | 30/min | 20,000/min |
| `/investments/refresh` | 1/min, 10/hr, **20/day** | 100/min, 6,000/hr, 144,000/day |
| `/liabilities/get` | 30/min | 10,000/min |
| `/accounts/get` | 15/min | 15,000/min |
| `/accounts/balance/get` | **5/min, 30/hr** | 1,200/min |
| `/item/get` | 15/min | 5,000/min |

The 500/min empty-cursor sub-limit is the one that bites during a full resync — if we ever need to rebuild from scratch across many Items, throttle deliberately.

### 1.9 SDKs and API versioning

**Two independent version numbers. Do not conflate them.**

- **API version** — date-based, set via the `Plaid-Version` header. Versions: `2017-03-08`, `2018-05-22`, `2019-05-29`, **`2020-09-14` (latest)**. If the header is omitted, the Dashboard-configured default applies. ([Versioning](https://plaid.com/docs/api/versioning/))
  → **Pin `Plaid-Version: 2020-09-14` explicitly in code.** Relying on a Dashboard setting is invisible, un-reviewable configuration drift.
- **SDK version** — semver-ish, bumped ~monthly, generated from [plaid/plaid-openapi](https://github.com/plaid/plaid-openapi). Major bumps are frequent and reflect *SDK* breaking changes, not API version changes.

Verified live on 2026-09-10:

| SDK | Latest | Released |
|---|---|---|
| `plaid` (npm, Node) | **47.0.0** | 2026-09-01 |
| `github.com/plaid/plaid-go/v47` | **v47.0.0** | 2026-09-01 |
| `plaid-python` (PyPI) | **44.0.0** | — (trails Node/Go) |

Note Go's module path embeds the major version (`/v47`), so every SDK major bump is a `go.mod` path edit. Python lags Node/Go by ~3 majors as of today — if we go Python, verify the endpoints we need are present before committing.

### 1.10 Data retention and developer obligations

Plaid's [Developer Policy](https://plaid.com/developer-policy/) requires:

- **Cryptography:** "Use modern and industry standard cryptography when storing or transmitting any End User Data" and ensure "Account Information is encrypted in storage and during transit."
- **Credential secrecy:** "You must never publish, distribute, or share your Account credentials, Client ID or Plaid API secret … with any third parties."
- **Data minimization:** do not "collect and store end users' bank credentials and/or End User Data other than as required to access or use the Services, as authorized by the end user."
- **No resale:** "sell or rent End User Data to marketers or any other third party" is prohibited.

On Plaid's own side, per the [End User Privacy Policy](https://plaid.com/legal/): "If a developer removes your connection from their app to your data, Plaid's systems are designed to automatically delete your personal data, subject to certain exceptions."

Access-token guidance: "Access tokens should always be stored securely, and associated with the user whose data they represent." Tokens do **not** expire.

> **[UNVERIFIED]** I could not find an explicit clause obligating the *developer* to delete their own local copy of End User Data upon `/item/remove`. The obligations I could source are about encryption, minimization, and non-resale. For a single-user self-hosted app this is mostly moot — Chris is both developer and end user — but we should still implement cascade-delete on Item removal as a matter of hygiene and to make the MSA security attestations honest.

**Concrete requirements this creates for us:**
- Encrypt `access_token` at rest (app-level envelope encryption with a key from env/secret, not just "the DB file is on an encrypted disk").
- Never log access tokens, `link_token`s, or webhook bodies containing them.
- `PLAID_SECRET` must never ship in an image layer or a committed `.env`.
- Implement `/item/remove` + local cascade delete as a first-class user action.

### 1.11 Sandbox

Free, unlimited Items, fully featured. Credentials `user_good` / `pass_good`. Key testing endpoints:

- `/sandbox/public_token/create` — skip the Link UI entirely in tests
- `/sandbox/item/reset_login` — force `ITEM_LOGIN_REQUIRED` to exercise update mode
- `/sandbox/item/fire_webhook` — trigger webhooks on demand

This is enough to build and test the entire sync engine before ever touching Production. **Do that.**

---

## 2. Alternatives and fallbacks

### 2.1 Comparison

| Provider | Individual signup, no company? | Cost (seen 2026-09-10) | API model | Coverage | Verdict |
|---|---|---|---|---|---|
| **SimpleFIN Bridge** | **Yes** — email only | **$1.50/mo or $15/yr** | Setup token → claim URL → Access URL w/ embedded Basic Auth; `GET /accounts?version=2`; polling, no webhooks | US/CA, depository + credit | **Best fallback** |
| **Teller** | Likely yes | **Free** developer tier, **100 live connections**; then Transactions $0.30/enrollment/mo, Balance $0.10/call, Identity $1.75/call, Verify $1.50/account | REST + **mTLS client certs**, hosted Teller Connect widget | US | Strong #2; verify eligibility |
| **MX** | Free dev tier, up to 100 users | Free tier; enterprise otherwise | REST platform API | US/CA | Production likely sales-gated |
| **GoCardless Bank Account Data** (ex-Nordigen) | **No — closed** | Was free ≤50 conn/mo | REST requisition/consent flow; ~4 calls/day/account | EEA/PSD2 | **Dead for new users** |
| **Akoya** | **No — company account required** | Standard / Enterprise tiers | REST | US bank-direct | Structurally excluded |
| **Finicity / Mastercard** | No | Undisclosed, negotiated | REST | US | Enterprise sales only |
| **Yodlee (Envestnet)** | Sandbox yes, Production no | Undisclosed | REST + FastLink | Global; strong investments | Needs signed agreement |
| **Flinks** | No | ~$0.20–0.25/connection, 1-yr term + minimums | REST | Canada | Contract minimums |
| **Enable Banking** | No (quote-only since ~2026-04) | Undisclosed | REST | EEA/PSD2 | Regressed |
| **Salt Edge** | Unlikely | Undisclosed | REST | Global-ish | Typically needs own eIDAS certs |

**The GoCardless closure is worth quoting**, because half the open-source ecosystem's docs still reference it:

> "From July 2025 onwards, GoCardless has stopped accepting new Bank Account Data accounts."
> — [Actual Budget GoCardless setup docs](https://actualbudget.org/docs/advanced/bank-sync/gocardless/), fetched 2026-09-10

### 2.2 SimpleFIN protocol (the fallback worth implementing)

From the [SimpleFIN Developer Guide](https://beta-bridge.simplefin.org/info/developers):

1. User creates a **Setup Token** in the Bridge UI (My Accounts → Apps → New Connection).
2. App base64-decodes it to get a **claim URL**, then `POST`s to it **once** → returns a permanent **Access URL** with embedded Basic Auth credentials.
3. App polls `GET {ACCESS_URL}/accounts?version=2`, optionally with `start-date`, `end-date`, `account`, `pending`, `balances-only`.

Response shape: accounts carry `org`, `id`, `name`, `currency`, `balance`, `available-balance`, `balance-date`; transactions carry `id`, `posted`, `amount`, `description`, `payee`, `memo`, `pending`. Errors surface in an `errlist` property.

Constraints: **90-day maximum query window**; quota of **"24 requests or fewer per day"**, with warnings before token disablement. The claim URL → access URL exchange is **one-shot** — lose the access URL and you must issue a new setup token.

Notably: **no investments, no cost basis, no securities.** SimpleFIN is a banking-and-credit-card protocol. It cannot serve the brokerage/retirement half of this app.

### 2.3 How the open-source ecosystem actually solves this

| Project | Aggregation approach | License | Status |
|---|---|---|---|
| **Actual Budget** | SimpleFIN, GoCardless (legacy), Enable Banking, Akahu (NZ), Pluggy.ai (BR). **No Plaid at all.** | MIT | Active |
| **Firefly III** | Separate **Data Importer** service: GoCardless, SimpleFIN, Spectre, Enable Banking | AGPL-3.0 | Active |
| **Maybe Finance** | Hosted SaaS used Plaid; **self-hosted Plaid was explicitly never supported** | **AGPL-3.0** | **Archived 2025-07-24** (54k stars). Community fork: `we-promise/sure`, also AGPLv3 |
| **Ghostfolio** | **No bank aggregation whatsoever** — investments only, manual/CSV entry + market data providers | AGPL-3.0 | Active |

Two conclusions:

1. **Actual Budget's choice is the strongest signal for individual-friendliness**: the most popular self-hosted budgeting app deliberately does not integrate Plaid, and centers SimpleFIN. Its reasoning holds — but it predates the April 2026 Trial plan, which materially changes the calculus.
2. **Licensing landmine:** Maybe, Sure, Firefly III, and Ghostfolio are all **AGPL-3.0**. We cannot copy code, schema definitions, or category taxonomies from any of them into an MIT project. Read them for *ideas*; write our own implementation. This is a real constraint on "just port Maybe's Plaid integration."

### 2.4 Recommended abstraction

Define a narrow port so no provider is load-bearing. Sketch:

```
AccountSource (interface)
  connect(user) -> ConnectionHandle          # Link / setup-token / API-key flows all collapse here
  listAccounts(handle) -> [Account]
  syncTransactions(handle, cursor) -> {added, modified, removed, cursor, hasMore}
  listHoldings(handle) -> [Holding]          # optional capability
  listLiabilities(handle) -> [Liability]     # optional capability
  capabilities() -> set                      # TRANSACTIONS | HOLDINGS | LIABILITIES | REALTIME_BALANCE
  disconnect(handle)
```

Design rules:
- **Adopt Plaid's `/transactions/sync` cursor semantics as the *internal* contract**, because it is the most expressive. Providers without a cursor (SimpleFIN, exchange APIs) get a shim adapter that diffs a fetched window against local state and synthesizes `added`/`modified`/`removed`. Diffing down to a weaker model is easy; upgrading a weak model to a strong one after the fact is not.
- Store a `provider` discriminator + opaque `provider_ref` on every account and transaction row; never let a Plaid `transaction_id` become the primary key.
- Make `capabilities()` explicit so the UI can degrade (e.g. hide cost-basis views for SimpleFIN-sourced accounts) rather than silently showing zeros.
- Keep credentials in a provider-agnostic encrypted `connections` table, not in Plaid-named columns.

---

## 3. Crypto

### 3.1 Coinbase — what's current, what's dead

| API | 2026 status |
|---|---|
| **Coinbase Developer Platform (CDP)** | Current umbrella; key management at `portal.cdp.coinbase.com` |
| **Advanced Trade API** (`/api/v3/brokerage/*`) | **Current — build against this** |
| Legacy HMAC API keys (key/secret/passphrase) | **Expired 2025-02-05** — "Users will need to migrate to CDP API keys to continue using the Coinbase App API" ([CDP changelog](https://docs.cdp.coinbase.com/coinbase-app/introduction/changelog)) |
| Coinbase Pro API | **Fully dead** (2024-06-06) |
| Wallet API v2 `/v2/accounts`, `/v2/transactions` | Documented as **deprecated** in favor of Advanced Trade v3 (the doc page is literally titled "Wallet API: Accounts (Deprecated)") |
| CDP Wallet API v1 / Server Wallet v1 | Deprecating **2026-02-02** → Server Wallet v2 (custody product; not our concern) |
| Advanced Trade INTX perpetuals | Deprecated, retiring **2026-09-09** (yesterday) |

### 3.2 Auth — CDP API keys + short-lived JWT

Per [JWT Authentication](https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication):

- **Key algorithm:** **Ed25519 (EdDSA) is recommended.** ECDSA/ES256 is explicitly legacy — "ECDSA is a legacy key algorithm. You should use Ed25519 instead." (Note this is the *opposite* of Plaid webhooks, which are ES256. Don't cargo-cult between them.)
- **JWT header:** `alg` (`EdDSA`), `kid` (= API key name), `nonce` (random per request).
- **Claims:** `sub` (key name, `organizations/{org_id}/apiKeys/{key_id}`), `iss` = `"cdp"`, `nbf` = now, `exp` = now + **120s**, `aud` = `["cdp_service"]`, and `uri` = `"{METHOD} {host}{path}"` e.g. `GET api.coinbase.com/api/v3/brokerage/accounts`.
- **Lifetime: 120 seconds.** "Your JWT expires after 2 minutes, after which all requests are unauthenticated." **Mint a fresh JWT per request.** Because `uri` is bound to the exact method+path, JWTs are not reusable across endpoints anyway.
- Sent as `Authorization: Bearer <JWT>`.

**Read-only scoping:** keys carry four booleans — `can_view`, `can_trade`, `can_transfer`, `can_receive`. **Create the key with `can_view` only.** Verify at runtime via `GET /api/v3/brokerage/key_permissions` and refuse to start if the key has `can_trade` or `can_transfer` — cheap, high-value defense for a self-hosted app holding exchange credentials.

**OAuth2 still exists** (`https://login.coinbase.com/oauth2/auth`, scopes `wallet:accounts:read`, `wallet:transactions:read`) but it is the wrong tool here — it's for delegated third-party access. Chris owns the account; API keys are simpler and involve no redirect URI.

### 3.3 Endpoints

Base `https://api.coinbase.com/api/v3/brokerage`:

- `GET /accounts` — balances (page size default 49, max 250); `GET /accounts/{account_uuid}`
- `GET /portfolios`, `GET /portfolios/{portfolio_uuid}` — valuation breakdown
- `GET /orders/historical/fills` — trade fills; `GET /orders/historical/batch` — orders
- `GET /products/{product_id}/ticker`, `GET /best_bid_ask` — pricing
- `GET /key_permissions` — scope introspection

**Rate limits [UNVERIFIED]:** roughly 10 req/s public, 15 req/s private, per IP. Sourced from secondary references; the official rate-limit page didn't render. Irrelevant at our volume but verify before any backfill loop.

> **Real gap to flag:** `fills`/`orders` cover *trading* only. Deposits, withdrawals, staking rewards, and transfers historically lived in the now-deprecated v2 `/transactions` ledger. **Prototype against a real account early** to confirm we can reconstruct a complete cost-basis-capable ledger from v3 alone. This is the single riskiest unknown in the crypto section.

### 3.4 Other exchanges (read-only scoping)

- **Kraken** — "Query Funds" + "Query Ledger Entries" permissions, no trade/withdraw. Kraken explicitly recommends minimal-scope keys for accounting tools.
- **Gemini** — dedicated **"Auditor"** role: read-only, cannot be combined with trade/transfer. Purpose-built for this.
- **Binance.US** — "Enable Reading" only. Gotcha: keys without IP allowlisting auto-reset to read-only after 90 days of inactivity.

### 3.5 On-chain

**Ethereum**
- **Etherscan API v2**: one key across **60+ EVM chains** via a `chainid` param. Free tier **5 calls/sec, 100,000 calls/day** shared across chains. ([Rate limits](https://docs.etherscan.io/etherscan-v2/rate-limits))
- **[UNVERIFIED, but important]** A 2025-11-22 policy change reportedly moved several major chains (Avalanche, Base, BNB Chain, Optimism) off the free tier. Ethereum mainnet remains free. Re-check `docs.etherscan.io/supported-chains` before depending on any L2.
- **No "enumerate all token balances" primitive** on Etherscan — you get per-contract `tokenbalance` only, so you must first discover the token set from transfer events. **Alchemy's `alchemy_getTokenBalances` is materially better** for this. Alchemy free ≈30M compute units/mo; Infura free 6M credits/day @ 2,000 credits/s.

**Bitcoin (xpub/ypub/zpub)**
- **mempool.space** and **Blockstream Esplora** have **no xpub endpoint** in their public REST APIs. You must derive addresses client-side (BIP32/44/49/84 by prefix), honor the gap limit, and query `GET /api/address/:address[/txs|/utxo]` per address. Both are "fair use," no published numeric limit, 429s enforced.
- **BlockCypher** is the only free option with **native HD Wallet objects** (register an xpub, it does derivation + gap scanning server-side) — but free tier is only **3 req/sec, 100 req/hour**.
- Recommendation: derive locally (a solved problem with standard libs), query Esplora/mempool.space. Avoids a vendor dependency and the 100 req/hr ceiling.

**Solana**
- Public RPC `api.mainnet-beta.solana.com`: `getBalance` (SOL), `getTokenAccountsByOwner` (SPL). Aggressively rate-limited, not production-grade.
- Helius free: 10 req/s, 1M credits/mo. **[UNVERIFIED]** whether `getTokenAccountsByOwner` is specifically throttled on free tier — it's an account-scanning method that many providers restrict.

### 3.6 Crypto price feeds

| Provider | Free tier (2026) | Notes |
|---|---|---|
| **CoinGecko Demo** | **10,000 credits/month**, ~100 calls/min. Free API key now required. | **Attribution required even on free tier** — must display "Data provided by CoinGecko" with logo + hyperlink ([Attribution Guide](https://brand.coingecko.com/resources/attribution-guide)). Paid "Basic" ~$29–35/mo. |
| **CoinMarketCap Basic** | 15,000 credits/mo, 50 req/min; commercial use approved for one product ≤100k users; no resale | [Pricing](https://coinmarketcap.com/api/pricing/) |
| **CryptoCompare / CoinDesk Data** | **Free tier retired ~2026-05-21** | Do not plan around it |
| Exchange public tickers | Free, keyless (`GET /v2/prices/{pair}/spot`, Kraken `Ticker`) | Good fallback for assets we already hold |

**Recommendation:** CoinGecko Demo. 10k credits/month is enormous for daily revaluation of one person's holdings. Budget the attribution UI element from the start — it's a hard license condition, not a courtesy.

### 3.7 Does Plaid cover crypto?

Yes, partially — and more than most people assume:

- Investment **account subtypes** include **`crypto exchange`** ("Standard cryptocurrency exchange account") and **`non-custodial wallet`**, plus `prediction market`. ([Accounts API](https://plaid.com/docs/api/accounts/))
- **`cryptocurrency`** is a documented security type, with a "Plaid Crypto Exchange Account" sample response in the [Investments API docs](https://plaid.com/docs/api/products/investments/).
- Plaid's 2022 announcement named Gemini, Robinhood, and SoFi. **[UNVERIFIED]** whether Coinbase specifically is connectable via Plaid in 2026 — not confirmed on any current official page.

**Recommendation: don't use Plaid for crypto.** Each exchange would consume one of our 10 Trial Items, inherit the reauth treadmill, and give us less data than the native API. Direct-to-exchange read-only keys are cheaper (free), richer, and don't burn Item budget.

---

## 4. Market / price data

### 4.1 Comparison

| Provider | Free tier | Paid entry (2026-09-10) | Mutual funds | License posture |
|---|---|---|---|---|
| **Tiingo** | 50 req/hr, **1,000/day**, 500 unique symbols/mo | **$30/mo** individual ("Power") | **Best in class** — 60,542 ETFs+funds of 109,910 securities | Free ToS: "your own personal use… may not display or share the data with another person or organization" |
| **Twelve Data** | 8 credits/min, **800/day** | $29/mo (Grow); funds need Pro $99 | Pro+ only | Not explicit |
| **Alpha Vantage** | **25 req/day** | $49.99/mo → $249.99/mo | Limited | Not addressed |
| **Polygon** (rebranded **Massive.com**) | 5 calls/min, **EOD only**, 2 yrs | $29 Starter (still 15-min delayed), $79, $199 | No | Personal plans marked "individual use only" |
| **Finnhub** | 60 calls/min | $11.99–$99.99 **[UNVERIFIED]** | Paid | Free tier "personal, non-commercial only" |
| **EODHD** | 20/day | $19.99/mo | Yes | Personal only; commercial needs separate plan |
| **Stooq** | Undocumented low quota; now CAPTCHA-gated key | — | Limited | No formal ToS found |
| **Yahoo via `yfinance`** | Unofficial, no quota, throttled ad hoc | — | Yes | **Library is Apache-2.0; the data is unlicensed.** Yahoo ToS prohibits automated collection; yfinance's own disclaimer: "the Yahoo! finance API is intended for personal use only" |
| **FRED** | **120 req/60s**, no daily cap, free forever | — | Macro only | Attribution string required |
| **OpenFIGI** | 25,000 mapping jobs/min with free key | — | Symbol mapping only | Free |
| **SEC EDGAR** | 10 req/s, no key (User-Agent w/ email required) | — | Fundamentals | Public domain |

### 4.2 The yfinance question, answered directly

The library is Apache-2.0 and safe to depend on from MIT code. **The legal risk is the data, not the code.** There is no Yahoo data license; Yahoo's ToS prohibits "robots, spiders, scrapers, data mining tools… without express, prior permission"; and yfinance's own README says the API "is intended for personal use only."

Ghostfolio ships Yahoo (via `yahoo-finance2`) as its default free provider, and its issue tracker documents the consequence — self-hosters hitting "Too Many Requests" and missing historical data as recently as January 2026 ([#6188](https://github.com/ghostfolio/ghostfolio/issues/6188), [#2640](https://github.com/ghostfolio/ghostfolio/issues/2640)).

**My read:** shipping Yahoo as the *documented default* of an MIT-licensed project puts the project in the position of instructing every user to violate a ToS. Shipping it as an *opt-in, clearly-labeled, best-effort* adapter is defensible. Those are different postures and we should pick the second.

### 4.3 Recommendation

**Default: Tiingo.** Reasons, in order:
1. Its free-tier ToS language ("your own personal use… may not display or share") is an almost exact description of our deployment model — a single self-hoster, own API key, own data. No other provider's terms fit this cleanly.
2. Best mutual-fund/ETF coverage surveyed (60,542 funds) — and retirement accounts are full of mutual funds, which is precisely the "holistic wealth trajectory" use case.
3. EOD-oriented, which is all a net-worth tracker needs. We are not paying for realtime.
4. 1,000 req/day free is ~20× what one person's portfolio needs; the $30/mo escape hatch exists but almost certainly won't be needed.

**Macro: FRED.** Free, 120 req/min, ideal for CPI (inflation-adjusted projections) and Treasury yields (risk-free rate). Requires displaying: *"This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."* Trivial to satisfy.

**Symbol mapping: OpenFIGI.** Free, 25k jobs/min. Necessary because Plaid returns `cusip`/`isin`/`ticker_symbol`/`figi` inconsistently while price providers key on tickers with differing exchange conventions.

**Opt-in fallbacks:** Twelve Data (800/day free, better FX/international) and `yfinance` (clearly labeled best-effort/unsupported).

Same lesson as §2.4: **put price data behind a `PriceSource` port.** Ghostfolio's pluggable-provider design is the validated pattern; its Yahoo issues are the validated failure mode.

---

## 5. Data model implications

### 5.1 `/transactions/sync` — the cursor contract

Request: `access_token`, `cursor` (omit on first call), `count` (default 100, **max 500**), `days_requested` (1–730, default 90), `options.include_original_description`, `options.personal_finance_category_version` (`v1`|`v2`), `options.account_id`.

Response: `accounts`, `added[]`, `modified[]`, `removed[]`, `next_cursor`, `has_more`, `transactions_update_status`.

**Semantics that must be encoded in the sync loop:**

- **Never persist mid-pagination.** > "It is important to retrieve all available updates before persisting the transactions updates to your database." Accumulate all pages, then commit in **one transaction** together with the final `next_cursor`.
- **Mutation during pagination.** If `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` is returned, > "the entire pagination request loop must be restarted beginning with the cursor for the first page." So: keep the *page-1 cursor* in memory for the whole loop, discard the accumulator, and restart. Do not retry from the latest page cursor.
- **Cursor is the sync state.** Persist it atomically with the data. A committed cursor with uncommitted data means permanent silent gaps — Plaid will never resend.
- `days_requested` defaults to **90**, not the 730 maximum. Set it explicitly to 730 on the first sync or we silently lose ~21 months of history we can never get back without re-linking.
- `removed[]` contains **IDs only**, not objects.

### 5.2 Pending → posted (the dedup trap)

This is the highest-risk modeling detail in the whole integration:

> "When a transaction posts, the transition from a pending to posted transaction will be represented through the /transactions/sync endpoint with the pending transaction's `transaction_id` in the `removed` field of the response and the new posted transaction in the `added` section of the response."
> — [Transactions data docs](https://plaid.com/docs/transactions/transactions-data/)

So: **`transaction_id` changes when a pending transaction posts.** It is a delete + insert, not a modify. The link is `pending_transaction_id` on the posted transaction.

> "Some institutions … do not provide pending transaction data. If no pending transaction is provided, or the pending transaction cannot be matched, the `pending_transaction_id` will be `null`."

**Schema requirements:**
- `plaid_transaction_id` — unique, but **not** the internal PK.
- Internal surrogate PK (UUID) that survives the pending→posted transition, so user edits (splits, notes, category overrides, budget assignments, receipt attachments) don't evaporate when a charge settles.
- On `added` with non-null `pending_transaction_id`: look up the local row by that ID and **rewrite it in place** (new `plaid_transaction_id`, `pending=false`, updated amount/date), preserving the surrogate PK and all user annotations.
- On `removed`: if the row was already migrated by the above rule, **no-op**. Order is not guaranteed, so handle `removed`-before-`added` and `added`-before-`removed` identically (idempotent).
- When `pending_transaction_id` is `null`, we own the fuzzy match: same account, amount within tolerance, date within a few days. **Prefer showing a duplicate over silently merging two real transactions** — under-merging is a UI annoyance, over-merging is data loss.
- Amounts commonly change between pending and posted (tips, FX, gas holds). Don't assert equality.

### 5.3 Transaction fields worth persisting

`transaction_id`, `account_id`, `pending`, `pending_transaction_id`, `amount`, `iso_currency_code` / `unofficial_currency_code`, `date`, `authorized_date`, `datetime`, `name`, `original_description` (requires opt-in), `merchant_name` (~97% fill), `logo_url` (100×100 PNG), `website`, `personal_finance_category{primary, detailed, confidence_level}` (~95% fill), `personal_finance_category_icon_url`, `counterparties[]` (type/name/confidence/entity_id), `payment_channel` (`online`|`in store`|`other`), `location{}`, `account_owner`.

Note the sign convention: Plaid amounts are **positive for outflow** from a depository account. Normalize once, at the adapter boundary, and document it.

### 5.4 `personal_finance_category` taxonomy

- **PFCv2 released 2025-12-03.** Verified by downloading [plaid.com/documents/pfc-taxonomy-all.csv](https://plaid.com/documents/pfc-taxonomy-all.csv) on 2026-09-10: **18 primary categories, 127 detailed categories.**
- Primary: `BANK_FEES`, `ENTERTAINMENT`, `FOOD_AND_DRINK`, `GENERAL_MERCHANDISE`, `GENERAL_SERVICES`, `GOVERNMENT_AND_NON_PROFIT`, `HOME_IMPROVEMENT`, `INCOME`, `LOAN_DISBURSEMENTS`, `LOAN_PAYMENTS`, `MEDICAL`, `OTHER`, `PERSONAL_CARE`, `RENT_AND_UTILITIES`, `TRANSFER_IN`, `TRANSFER_OUT`, `TRANSPORTATION`, `TRAVEL`.
- The CSV header states: *"PFCv2 is a superset of PFCv1. All new customers after December 2025 are on PFCv2."* As a brand-new team we get **v2 by default** — but **pass `options.personal_finance_category_version: "v2"` explicitly anyway** so behavior is pinned in code.
- Plaid reports PFCv2 as "~10% improvement at the category level and 20% at the subcategory level" over v1 ([changelog](https://plaid.com/docs/changelog/)).

**Model note:** store Plaid's category as an immutable *source* field and keep a separate user-facing category with a user-editable mapping layer. Plaid will revise this taxonomy again; our budget history must not shift under us when they do. `TRANSFER_IN`/`TRANSFER_OUT` in particular must be excluded from spend totals and used to detect inter-account transfers (which are double-counted by construction when both accounts are linked).

### 5.5 Investments

Endpoints: `/investments/holdings/get`, `/investments/transactions/get` (up to 24 months), `/investments/refresh`. **There is no `/investments/transactions/sync`** — no cursor model. We must implement date-window fetch + our own idempotent upsert by `investment_transaction_id`.

- **Holding:** `account_id`, `security_id`, `quantity`, `institution_price`, `institution_price_as_of`, `institution_value`, `cost_basis`, `vested_quantity`, `vested_value`, `iso_currency_code`.
- **Security:** `security_id`, `ticker_symbol`, `cusip`, `isin`, **`figi`** (added 2026-06-18), `type`, `subtype`, `close_price`, `close_price_as_of`, `is_cash_equivalent`, `market_identifier_code`. **`sedol` was removed in 2026** — do not model it.
- **`tax_lots`** added 2026-06-18 — valuable for capital-gains modeling where the institution supplies it.
- **InvestmentTransaction:** `investment_transaction_id`, `type`, `subtype`, `quantity`, `price`, `fees`, `amount`, `date`. Subtypes `fund fee`, `loan payment`, `rebalance` were **removed in 2026**.
- Webhooks: `HOLDINGS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: HISTORICAL_UPDATE`.

**Modeling caution:** `cost_basis` fill rates vary wildly by institution and is often *total* rather than per-share — verify per-institution rather than assuming. For trajectory math, prefer deriving from investment transactions where available and treat institution-reported `cost_basis` as a fallback. `institution_price` is the institution's mark and may be stale; for consistent cross-account valuation, revalue everything from our own price source (§4) and keep `institution_value` only for reconciliation.

### 5.6 Liabilities

`/liabilities/get` covers credit cards (incl. PayPal), student loans, and mortgages:

- **Credit:** `aprs[]` (rate + balance subject to it), `last_statement_balance`, `last_statement_issue_date`, `minimum_payment_amount`, `next_payment_due_date`, `is_overdue`, `last_payment_amount/date`.
- **Student:** `interest_rate_percentage`, `loan_status`, `servicer_address`, `pslf_status`, `expected_payoff_date`, `origination_date`.
- **Mortgage:** `interest_rate{type, percentage}`, `origination_principal_amount`, `escrow_balance`, `maturity_date`, `property_address`, `next_monthly_payment`.

Webhook: `LIABILITIES: DEFAULT_UPDATE`, which identifies both affected accounts and which fields changed.

This is exactly the input the retirement/wealth-trajectory engine needs for debt-payoff modeling — APR-weighted paydown and mortgage amortization both fall out of these fields.

### 5.7 Recurring transactions / subscription advice — **build it ourselves**

`/transactions/recurring/get` returns `inflow_streams[]` and `outflow_streams[]`, with per-stream `stream_id`, `description`, `merchant_name`, `first_date`, `last_date`, `frequency`, `average_amount`, `last_amount`, `is_active`, `status`, `category`, `predicted_next_date`. A "matured" stream needs ≥3 occurrences, and Plaid recommends ≥180 days of history. Webhook: `RECURRING_TRANSACTIONS_UPDATE`. Rate limit 20/min per Item.

**But it is a paid add-on and is not in the Trial bundle's 8 products.** Given subscription/recommendation advice is an explicit product requirement, we must implement our own recurrence detection over the transaction table: group by (`merchant_name` or `counterparties[0].entity_id`), cluster on amount similarity and inter-arrival cadence, require ≥3 occurrences, then project `predicted_next_date`.

Silver lining: `merchant_name` (97% fill) and `counterparties[].entity_id` give us a far better grouping key than raw descriptions, so this is a tractable heuristic rather than an NLP project. And owning it means the feature survives any provider switch.

### 5.8 Sync engine — recommended shape

```
on SYNC_UPDATES_AVAILABLE(item_id):
    verify JWT (ES256, kid, iat<5min, body sha256)   # §1.6
    enqueue SyncJob(item_id)                          # respond 200 immediately

SyncJob(item_id):
    page_one_cursor = load_cursor(item_id)
    cursor, acc = page_one_cursor, []
    loop:
        r = POST /transactions/sync {cursor, count:500, days_requested:730,
                                     options:{personal_finance_category_version:"v2"}}
        on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION:
            cursor, acc = page_one_cursor, []; continue    # full restart
        acc += r; cursor = r.next_cursor
        if not r.has_more: break
    BEGIN TX
        apply removed, then added-with-pending_transaction_id, then rest, then modified
        save_cursor(item_id, cursor)
    COMMIT
```

Respond `200` to the webhook before doing work — Plaid retries on non-2xx, and a slow sync must not look like a delivery failure. Queue by `item_id` with a single in-flight job per Item to avoid concurrent cursor writes.

---

## Decisions I recommend

1. **Use Plaid as the primary aggregator, on the free Trial plan.** The 2026-04-15 Trial plan removes the historical blocker (company registration + security questionnaire). 10 Items and free-forever fits a single user. This is a genuinely different answer than it would have been 12 months ago.
2. **Request only `transactions`, `investments`, `liabilities`.** Skip Auth and Identity — they cost money, add Link friction, and provide nothing to a read-only PFM.
3. **Build the `AccountSource` port before the Plaid adapter.** Plaid ships first, but SimpleFIN ($1.50/mo, US/CA, banking-only) is the designated fallback and must be implementable without touching core. Adopt Plaid's cursor semantics as the internal contract; shim weaker providers up to it.
4. **`/transactions/sync` only.** Never `/transactions/get`. Webhook-driven, never polling. Never persist mid-pagination; commit data+cursor atomically; restart pagination from the page-1 cursor on mutation errors.
5. **Model pending→posted as identity migration, not update.** Internal surrogate PK + `pending_transaction_id` rewrite-in-place + idempotent `removed` handling. This protects user annotations and prevents double-counting.
6. **Pin everything explicitly:** `Plaid-Version: 2020-09-14`, `personal_finance_category_version: "v2"`, `days_requested: 730`, `count: 500`. All four have defaults that differ from what we want, and three of the four fail silently.
7. **Crypto direct-to-exchange, not via Plaid.** Coinbase CDP API key with `can_view` only, Ed25519 JWT (120s, per-request, `uri`-bound), Advanced Trade v3. Assert `key_permissions` at startup. Saves Item budget and gets a richer ledger.
8. **On-chain: derive xpub addresses locally**, query Blockstream Esplora / mempool.space. Etherscan v2 for EVM (one key, `chainid` param), with Alchemy as the upgrade path for token enumeration.
9. **Market data: Tiingo as default** (cleanest personal-use ToS, best mutual-fund coverage, 1,000 req/day free), **FRED for macro**, **OpenFIGI for symbol mapping**, `yfinance` as an opt-in clearly-labeled best-effort adapter — not the documented default. **CoinGecko Demo for crypto prices**, with the required attribution UI built in from day one.
10. **Build our own recurring/subscription detection.** Recurring Transactions isn't in the Trial bundle. Use `merchant_name` + `counterparties[].entity_id` as the grouping key, ≥3 occurrences to confirm a stream.
11. **Read AGPL projects for ideas; copy nothing.** Maybe/Sure, Firefly III, and Ghostfolio are all AGPL-3.0 and license-incompatible with our MIT goal. Actual Budget is MIT and is the one we could legitimately borrow from.
12. **Treat reconnect UX as a cost and correctness feature.** Errored Items still bill on paid plans, and Chase/BofA/Cap One force reauth on a 6–12 month cadence. Surface `ITEM_LOGIN_REQUIRED` / `PENDING_DISCONNECT` prominently and make update mode one click.

---

## Open risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **10-Item cap is a ratchet** — `/item/remove` does not free slots | Hard ceiling; institution churn permanently burns budget | Audit the institution list before linking anything. Test every flow in Sandbox first. Treat each Production Link as irreversible. |
| R2 | **OAuth needs a public HTTPS redirect URI** | A LAN-only Docker deploy cannot link Chase/BofA/etc. | Design the Link flow to run behind a temporary public hostname or tunnel; document it as a setup prerequisite. Localhost HTTP is Sandbox-only. |
| R3 | **Trial→Production is a one-way door** | Cannot revert; unknown pricing on the other side | Stay on Trial as long as possible. Don't apply for Production "to see pricing" — that forfeits Trial eligibility. |
| R4 | **Recurring Transactions + Enrich excluded from Trial** | Core subscription-advice feature has no vendor path | Own the algorithm (§5.7). Also removes a provider dependency. |
| R5 | **Plaid pricing is unknowable pre-application** | Cannot model costs if we ever exceed Trial | Architect to the billing *model* (subscription/one-time/per-request), keep Item count low, avoid per-request endpoints on timers. |
| R6 | **Coinbase v3 may not expose a full ledger** (deposits/withdrawals/staking/transfers vs. trade fills only) | Cost basis and crypto cash flows could be incomplete | **Prototype against a real Coinbase account early.** Highest-priority unknown in this memo. |
| R7 | **Yahoo/`yfinance` has no data license** | Reputational/legal exposure if made the documented default | Default to Tiingo; ship Yahoo opt-in and clearly labeled. |
| R8 | **`cost_basis` fill rate varies by institution**, and may be total vs. per-share | Wrong gains math in the trajectory engine | Derive from investment transactions where possible; treat institution `cost_basis` as fallback; show provenance in the UI. |
| R9 | **Inter-account transfers double-count** when both sides are linked | Inflated spend and income totals | Use `TRANSFER_IN`/`TRANSFER_OUT` PFC + amount/date matching across accounts to auto-pair and exclude from spend. |
| R10 | **`plaid-python` trails Node/Go by ~3 majors** (44.0.0 vs 47.0.0 as of 2026-09-10) | Missing endpoints/fields in a Python stack | Verify required endpoints exist in the chosen SDK before committing to a language. |
| R11 | **Etherscan free-tier chain coverage shrank** (2025-11 policy change) **[UNVERIFIED]** | L2 balances may silently require payment | Re-check `docs.etherscan.io/supported-chains` at implementation time; prefer Alchemy for multi-chain. |
| R12 | **Plaid taxonomy will change again** (v1→v2 happened 2025-12) | Budget history shifts retroactively | Store Plaid category as immutable source data; keep a separate user-facing category + mapping layer. |
| R13 | **SimpleFIN cannot serve investments** — banking/credit only, 90-day window, ≤24 req/day | Fallback is partial, not equivalent | Make `capabilities()` explicit; degrade the UI rather than showing zeros. Accept that losing Plaid means losing brokerage sync. |
| R14 | **No explicit Plaid clause found obliging developer-side deletion on item removal [UNVERIFIED]** | Compliance ambiguity | Implement cascade-delete anyway; encrypt `access_token` at rest; honor the MSA security attestations literally. |

---

## Source index

**Plaid (all fetched 2026-09-10):** [API overview](https://plaid.com/docs/api/) · [Versioning](https://plaid.com/docs/api/versioning/) · [Libraries](https://plaid.com/docs/api/libraries/) · [Pricing & billing](https://plaid.com/docs/account/billing/) · [Glossary](https://plaid.com/docs/quickstart/glossary/) · [Sandbox](https://plaid.com/docs/sandbox/) · [Transactions](https://plaid.com/docs/transactions/) · [Transactions API ref](https://plaid.com/docs/api/products/transactions/) · [Transactions data (pending→posted)](https://plaid.com/docs/transactions/transactions-data/) · [Sync migration](https://plaid.com/docs/transactions/sync-migration/) · [Transactions webhooks](https://plaid.com/docs/transactions/webhooks/) · [PFC taxonomy CSV](https://plaid.com/documents/pfc-taxonomy-all.csv) · [Investments API ref](https://plaid.com/docs/api/products/investments/) · [Liabilities API ref](https://plaid.com/docs/api/products/liabilities/) · [Accounts API ref](https://plaid.com/docs/api/accounts/) · [Items API ref](https://plaid.com/docs/api/items/) · [Item errors](https://plaid.com/docs/errors/item/) · [Rate limits](https://plaid.com/docs/errors/rate-limit-exceeded/) · [Webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/) · [Webhooks overview](https://plaid.com/docs/api/webhooks/) · [OAuth](https://plaid.com/docs/link/oauth/) · [Update mode](https://plaid.com/docs/link/update-mode/) · [Auth](https://plaid.com/docs/auth/) · [Balance](https://plaid.com/docs/balance/) · [Enrich](https://plaid.com/docs/api/products/enrich/) · [Changelog](https://plaid.com/docs/changelog/) · [Developer Policy](https://plaid.com/developer-policy/) · [Legal/privacy](https://plaid.com/legal/) · [Support: Trial plan (upd. 2026-09-03)](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan) · [Support: pricing plans (upd. 2026-06-03)](https://support.plaid.com/hc/en-us/articles/16110502116887-What-are-Plaid-s-prices-and-pricing-plans-and-how-do-they-differ)

**Alternatives:** [SimpleFIN developer guide](https://beta-bridge.simplefin.org/info/developers) · [Teller](https://teller.io/) · [Actual Budget SimpleFIN](https://actualbudget.org/docs/advanced/bank-sync/simplefin/) · [Actual Budget GoCardless](https://actualbudget.org/docs/advanced/bank-sync/gocardless/) · [Akoya getting started](https://docs.akoya.com/docs/getting-started) · [maybe-finance/maybe (archived, AGPL-3.0)](https://github.com/maybe-finance/maybe) · [we-promise/sure](https://github.com/we-promise/sure) · [Firefly III data importer](https://docs.firefly-iii.org/how-to/data-importer/how-to-configure/)

**Crypto:** [CDP JWT auth](https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication) · [Advanced Trade REST endpoints](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api) · [Coinbase App changelog](https://docs.cdp.coinbase.com/coinbase-app/introduction/changelog) · [Key permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions) · [Kraken API keys](https://docs.kraken.com/exchange/guides/rest/api-keys) · [Gemini roles](https://developer.gemini.com/roles) · [Etherscan v2 rate limits](https://docs.etherscan.io/etherscan-v2/rate-limits) · [BlockCypher](https://www.blockcypher.com/dev/bitcoin/#rate-limits) · [mempool.space API](https://mempool.space/docs/api) · [CoinGecko pricing](https://www.coingecko.com/en/api/pricing) · [CoinGecko attribution](https://brand.coingecko.com/resources/attribution-guide) · [CoinMarketCap pricing](https://coinmarketcap.com/api/pricing/)

**Market data:** [Tiingo pricing](https://www.tiingo.com/about/pricing) · [Twelve Data pricing](https://twelvedata.com/pricing) · [Alpha Vantage premium](https://www.alphavantage.co/premium/) · [Massive/Polygon pricing](https://massive.com/pricing) · [EODHD pricing](https://eodhd.com/pricing) · [FRED API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html) · [OpenFIGI](https://www.openfigi.com/api/documentation) · [yfinance](https://github.com/ranaroussi/yfinance) · [Ghostfolio #6188](https://github.com/ghostfolio/ghostfolio/issues/6188)
