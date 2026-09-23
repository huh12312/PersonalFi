# WP 3.4 — Market data and FX behind one `PriceSource` port

**Status:** complete, with two carry-overs for the orchestrator (§9) and one
honest gap recorded in the sabotage table (§2.1, scheme control).

**Packages:** `@ctx/integrations` (port, four adapters, egress binding, rate
budgets, attribution, the 03:45 refresh), `@ctx/investments` (`PriceReader`,
`FxReader`, `prices`/`fx_rates`/`price_source_priority`), `@core/config` (four
optional file secrets).

**Migration:** `0015_market_data.sql`.

Market data is the **second egress surface and the first that runs on a
schedule with no human present** (dispatch §5). An SSRF here reaches `db:5432`
and the container metadata endpoint on a timer. Everything in §1–§3 exists
because of that sentence.

---

## 1. The egress matrix, per adapter

The WP 2.4 allow-list is **reused, not reimplemented**. It lives in
`@core/platform/src/egress/{policy,transport}.ts` — the module WP 2.4 wrote for
notifications, moved down a layer in commit `6ad393c` so a second context could
use it; `@ctx/notifications/src/{egress,transport}.ts` are now re-export seams
with no logic in them, and `git log --follow` on either reaches WP 2.4.

`@ctx/integrations/src/egress.ts` contributes only the **binding**: which
hosts, which scheme, which port, how many bytes, how long. There is no guard in
it.

### 1.1 One host per adapter, not four

`policyFor(provider)` hands each adapter a policy whose `allowedHosts` has
**exactly one** entry — its own. Tiingo cannot reach `api.coingecko.com` even
though CoinGecko is a legitimate destination for this context. A compromised or
merely buggy adapter does not inherit the blast radius of every provider we
speak to, and the matrix below is therefore a per-adapter claim.

| Adapter   | Host allowed              | Scheme | Port | Body cap | Timeout                 | Redirects      | Key transport                                       |
| --------- | ------------------------- | ------ | ---- | -------- | ----------------------- | -------------- | --------------------------------------------------- |
| Tiingo    | `api.tiingo.com` only     | https  | 443  | 1 MiB    | 15 s (×3 hard deadline) | never followed | `Authorization: Token …` header                     |
| FRED      | `api.stlouisfed.org` only | https  | 443  | 1 MiB    | 15 s                    | never followed | `api_key` **query param** (FRED has no header auth) |
| CoinGecko | `api.coingecko.com` only  | https  | 443  | 1 MiB    | 15 s                    | never followed | `x-cg-demo-api-key` header                          |
| OpenFIGI  | `api.openfigi.com` only   | https  | 443  | 1 MiB    | 15 s                    | never followed | `X-OPENFIGI-APIKEY` header (omitted when absent)    |

Context-wide list (`MARKET_DATA_ALLOWED_HOSTS`) is exactly those four hosts.
**Not** on it: `query1.finance.yahoo.com` (01 §4.2 — Yahoo data is unlicensed,
so an opt-in adapter that was never opted into cannot reach the network at
all), and `api.coinbase.com` / `blockstream.info` / `api.etherscan.io`, which
are WP 3.5/3.6's `CRYPTO_ALLOWED_HOSTS`. A price source has no business at an
exchange's account API.

Ports are `[443]` and nothing else — narrower than notifications' `[443, 465,
587]`, which gives `db:5432` a second, independent reason to be refused even if
a host allow-list were somehow wrong.

### 1.2 Header vocabulary is closed

`ProviderRequest.headers` is keyed by a six-member union (`HEADER_NAMES`), so a
header name outside it is a type error, and `buildHeaders` re-checks at runtime
for untyped edges. 08 §4.4's "no user-supplied headers" is enforced by a caller
who _cannot express one_. The port also takes no URL, no host and no `baseUrl`:
a port that accepts a URL is an SSRF primitive with a domain-shaped wrapper.

---

## 2. Refusal matrix, each sabotage observed red

`test/egress-allowlist.test.ts` drives **real adapters** through the **real**
guard and the **real** client. Only the socket is faked, and the fake records
requests _after_ the guard runs — so `transport.requests` being empty is a
direct assertion that nothing reached the network.

| Refusal                                  | Test                                                               | Code observed                         | Reached network                   |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- | --------------------------------- |
| `db:5432`                                | `'a price-source URL pointing at db:5432 is refused'`              | `host_not_allowed`                    | no                                |
| Cloud metadata                           | `'169.254.169.254 is refused'`                                     | `literal_ip`                          | no                                |
| Redirect laundering                      | `'a 302 to an internal host is not followed'`                      | `redirect_not_followed`               | first hop only; no second request |
| DNS rebinding                            | `'a DNS answer that changes between check and connect is refused'` | `private_address`                     | no                                |
| Private answer, allow-listed name        | `'a private answer is refused even when the name is allow-listed'` | refused for all five hosts            | no                                |
| Cross-provider reach                     | `'the <p> adapter cannot reach <other host>'` ×4                   | `host_not_allowed`                    | no                                |
| Cleartext                                | `'only https, only 443'`                                           | `scheme_not_allowed`                  | no                                |
| Odd port                                 | `'only https, only 443'`                                           | `port_not_allowed`                    | no                                |
| Non-allow-listed host, all four adapters | `'no adapter can reach a non-allow-listed host'` ×4                | refused; sabotaged control reaches it | no                                |

### 2.1 Sabotages actually run (each reverted immediately)

| #   | Sabotage                                                        | Expected                                      | Observed                        |
| --- | --------------------------------------------------------------- | --------------------------------------------- | ------------------------------- |
| A   | `policyFor` returns the context-wide list instead of one host   | per-adapter isolation tests red               | **4 tests red** ✅              |
| B   | `createMarketDataEgressPolicy` allows `http` as well as `https` | `'only https, only 443'` red                  | **stayed green — see below** ⚠️ |
| C   | `MARKET_DATA_ALLOWED_PORTS` widened to `[443, 5432, 8443]`      | `'only https, only 443'` red                  | **1 test red** ✅               |
| D   | `http.ts` ignores `classifyStatus` and treats a 3xx as ok       | redirect test red                             | **1 test red** ✅               |
| E   | `http.ts` skips the `guardUrl` decision entirely                | rebinding + budget + honest-refusal tests red | **3 tests red** ✅              |

**Finding (B), recorded honestly.** Widening this package's `allowedSchemes` does
_not_ make cleartext reachable, because `@core/platform`'s `checkUrl` hard-codes
`scheme !== 'https' → scheme_not_allowed` independently of
`policy.allowedSchemes`. The cleartext control is therefore a platform-level
invariant, not something this package can weaken — which is a _strength_, but it
means the `allowedSchemes: ['https']` line in `egress.ts` is a second,
belt-and-braces statement rather than the load-bearing control, and this WP
cannot demonstrate a red for it from inside its own package. The port half of
the same test (sabotage C) does go red. Flagged for the Phase 3 gate so it is
not mistaken for an unexercised control.

Sabotages against the credential redactor and the rate budget are asserted
**in-suite** rather than by editing source, so they run in CI every time:

| Sabotage                                       | Test                                                                      | Observed                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| `createProviderClient` built without `keys`    | `'SABOTAGE: a client built without its keys leaks the provider body'`     | leak reproduced, then redacted path asserted clean ✅ |
| Redactor given no keys                         | `'SABOTAGE: without the redactor the key leaks…'`                         | plaintext present ✅                                  |
| Budget limit raised past the documented number | `'SABOTAGE: raising the documented limit lets the 1,001st call through'`  | call reaches transport ✅                             |
| Attribution `required` flipped to false        | `'SABOTAGE: an empty CoinGecko attribution would be a licence breach…'`   | obligation disappears from the read model ✅          |
| FX reader falling back to `1`                  | `'SABOTAGE: a reader that fell back to 1.0 would pass nothing here'`      | par conversion reproduced; real reader throws ✅      |
| Staleness threshold raised to 48 h             | `'SABOTAGE: raising the threshold past 25 hours hides the stale holding'` | stale holding reported fresh ✅                       |
| Unbatched OpenFIGI mapping                     | `'SABOTAGE: unbatched mapping would cost 120 requests…'`                  | 120 requests vs 2 ✅                                  |

---

## 3. Rate budgets — the published number is in the code

Dispatch §3 requires the documented number **in the code**. The posture is
_ours, not theirs_: a provider that refuses us answers 429 — sometimes. What
Tiingo does at request 1,001 is Tiingo's business and might be a 429, a 403, a
silent throttle, or an account suspension for a personal-tier key. Discovering
the limit by hitting it is a strategy that works until the one time it does not.

| Provider       | Windows enforced client-side          | Unit                 | Source                 |
| -------------- | ------------------------------------- | -------------------- | ---------------------- |
| Tiingo         | 50 / hour **and** 1,000 / day         | request              | 01 §4.1                |
| FRED           | 120 / 60 s                            | request              | 01 §4.1                |
| CoinGecko Demo | 100 / minute **and** 10,000 / 30 days | request, credit      | 01 §3.6                |
| OpenFIGI       | 25,000 / minute                       | **job**, not request | 01 §4.1                |
| yfinance       | 60 / hour, self-imposed               | request              | 01 §4.1 publishes none |

Notes that matter:

- Windows **slide** (timestamps, pruned), not fixed buckets. A fixed hourly
  bucket lets 100 calls through at 10:59 and 11:01 while claiming 50/hour —
  asserted by `'the window slides rather than resetting on the hour'`.
- Both Tiingo windows are enforced, not the tighter one: they bind at different
  timescales and a refresh respecting only the daily number burns the hourly one
  in ninety seconds.
- CoinGecko's monthly window is a sliding **30 days** rather than a calendar
  month, deliberately conservative: a calendar bucket permits 10,000 on the 31st
  and 10,000 more on the 1st.
- OpenFIGI is billed in **jobs**, so `cost` is the batch size — 120 symbols cost
  120 against 25,000/minute but only **2 requests**.
- Tiingo's third documented limit, 500 unique symbols/month, is a _coverage_
  limit rather than a rate; it is tracked per symbol in
  `market_data_runs.symbols_asked` and is not modelled as a window.
- **Spend is durable.** `hydrate()` primes the windows from `market_data_runs`
  at boot. Without it a worker restarting at 03:44 starts the refresh with an
  empty counter and no memory of the 900 requests it made at 03:15 — which is
  precisely how a personal-tier key gets used the way its ToS forbids.
  Asserted by `'a restart does not reset the day…'`.
- A request the **egress guard refused costs nothing** — it never left the
  process. A request the provider answered 500 to _does_ cost, because the
  provider received it. Asserted by `'a spend is only recorded for a request
that actually left'`.

---

## 4. ToS and attribution obligations

Attribution is a **licence condition, not a courtesy** (01 §3.6, verbatim: _"a
hard license condition, not a courtesy"_). The obligation travels **with the
data** — on every `PriceQuote` and aggregated into the refresh's
`attributionRequirements` — because a UI cannot render an obligation it was
never told about, and the only alternative is a developer remembering, in a
different package, months later, that this number came from CoinGecko.

| Provider      | Clause (quoted)                                                                                                                                                     | Obligation created                                                                                                           | Where it binds                 | Redistribution             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------- |
| **CoinGecko** | 01 §3.6: _"Attribution required even on free tier — must display 'Data provided by CoinGecko' with logo + hyperlink"_; _"a hard license condition, not a courtesy"_ | Exact text **"Data provided by CoinGecko"**, **logo**, **hyperlink** to `https://www.coingecko.com` — all three              | `any_price`, `settings`        | permitted with attribution |
| **FRED**      | 01 §4.3: _"Requires displaying: 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.'"_                      | That **exact sentence**, ® included. Not a paraphrase — a paraphrase of a licence condition is a new licence condition       | `any_macro_figure`, `settings` | permitted with attribution |
| **Tiingo**    | 01 §4.1: _"your own personal use… may not display or share the data with another person or organization"_                                                           | **No badge.** The obligation is that the data does not leave                                                                 | —                              | **forbidden**              |
| **OpenFIGI**  | 01 §4.1: _"25,000 mapping jobs/min with free key… Free."_                                                                                                           | none                                                                                                                         | —                              | unrestricted               |
| **yfinance**  | 01 §4.2: _"The library is Apache-2.0 and safe to depend on from MIT code. The legal risk is the data, not the code."_                                               | No licence exists, so no badge would make redistribution lawful. Opt-in, best-effort, **never the documented default** (D17) | —                              | **forbidden**              |

**Redistribution is a separate axis from attribution, and folding them together
would lose it.** `Attribution.redistribution` is the field an export path or a
sharing feature must consult — specifically WP 3.13's `?encrypt=true` export and
any future "share my portfolio" feature, both of which would breach Tiingo's
personal tier if they shipped without checking.

**Downstream obligation this WP creates:** WP 3.12 must render the CoinGecko
element on every screen showing a crypto price. Its e2e test (_'the CoinGecko
attribution is present on every screen showing a crypto price'_) is the other
half of this seam; `test/attribution.test.ts` → `'the CoinGecko read model
carries the attribution requirement'` is this half.

**CryptoCompare is not used** — retired, per 01.

---

## 5. STALE and FX semantics

### 5.1 Staleness is computed, never stored

07 §6.1: _"if last price > 24h old, mark the holding STALE and exclude from 'as
of now' deltas."_ That is a claim about the clock at **read** time. A boolean
written at insert time is correct for a day and then silently wrong forever
while still reading as authoritative — the worst kind of wrong, because nothing
about the row looks stale.

So `prices.observed_at` records when the provider answered, and
`priceStalenessOf(observedAt, now)` decides against an injected `Clock`.
Boundary: **strictly greater than** 24 h is STALE; exactly 24 h is FRESH, which
leaves a price taken at yesterday's close still fresh at today's. Clock skew
into the future is FRESH, not an error — policing clocks is not that function's
job and treating skew as staleness would hide prices that had just arrived.

`prices.stale` is a **different, narrower** fact and the column comment says so:
the _provider_ served a carry-forward rather than a close for the day asked
about (a market holiday). Surfaced separately as
`PricePoint.providerCarriedForward` so it cannot be confused with the clock
rule — conflating them would make a market holiday look like an outage.

A STALE price is still **displayed** and still **seals** a net-worth snapshot
(08 §3.7, flagged `stale_price`); what it may not do is contribute to an
as-of-now delta, because the delta would be measuring the passage of time rather
than a change in value. `PricePoint.includeInAsOfNowDeltas` computes that once
rather than leaving five callers to re-derive it.

Three states, not two: `PRICED` / `STALE` / `UNPRICED`. "We have never had a
price" and "our price is old" need different words on screen and different
fixes.

### 5.2 The ladder (07 §6.1)

`user override > exchange fill > provider > last known`, per security kind,
user-editable, stored as `price_source_priority` rows rather than an `ORDER BY`.
Walked rung by rung in `src/prices.test.ts` → `'walks user override > exchange
fill > provider > last known'`, one price answered by each:

| Rung | Source                 | Answered                         | Why it ranks there                                                      |
| ---- | ---------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| 1    | `user_override`        | `250.00`                         | A human looked at the position and disagreed. Pinned to rung 1 by CHECK |
| 2    | `exchange_fill`        | `240.00`                         | A price we actually **paid**. Not an estimate of anything               |
| 3    | `tiingo` / `coingecko` | `232.35`                         | D17: Tiingo for equities and funds, CoinGecko for crypto                |
| 4    | `last_known`           | `230.00`, `carriedForward: true` | No row for the date; most recent earlier observation, **labelled**      |

**`last_known` is a label, never a row.** It is absent from `prices.source`'s
CHECK (`prices_source_is_an_observation`). A carry-forward written back as an
observation would be found by tomorrow's refresh, carried forward again, and
within a week the chart would be a flat line made of one real print — exactly
07 §6.1's _"never recompute history from today's price."_ The in-memory store
enforces the same refusal so a unit test cannot pass on a row Postgres would
reject.

### 5.3 A missing FX rate is an error, never 1.0

D4 and 08 §6.6. The failure being prevented is a CAD account quietly counting as
USD: arithmetically clean, plausible on screen, wrong by the whole spread,
invisible forever.

- `FxReader.rate(from, to, date)` returns a rate or **throws**
  `FxRateUnavailable`. No `| null` for a caller to `?? 1` past, no default
  parameter that would let one appear.
- The error carries `base`, `quote`, `date` and what was consulted, because 08
  §6.6's manual-entry affordance needs to say _which_ rate it is asking for.
- The **identity** (`USD → USD`) is answered structurally as `{ source:
'identity' }` **without reading a row** — proven by counting store reads.
  `fx_rates_is_a_real_pair` refuses `base = quote` at the schema level, so no
  query can find a stored 1.0 and mistake it for something a provider said, and
  no fixture can create one.
- **No cross via USD.** EUR→USD and USD→CAD present, EUR→CAD absent ⇒ throw.
  Chaining would produce a plausible number with no observation behind it; D4
  requires a _historical_ rate, not a plausible one.
- **One direction stored, the other inverted at read time**, flagged
  `inverted: true`. FRED publishes each pair in a fixed direction that is part
  of the series' identity (`DEXUSEU` is dollars per euro, `DEXCAUS` is Canadian
  dollars per dollar); storing both ways would mean two rows that must agree to
  fifteen places forever, and `1/1.35` does not round-trip. Arithmetic is exact
  decimal (`Quantity`), no `number` in the file.
- `fx_rate_date` is the date of the **observation used**, not the date asked
  for. A Friday rate read on Sunday reports Friday, `carriedForward: true` —
  recording Sunday would claim a print on a day nothing happened.

### 5.4 No float reaches a price

D3 and the Phase 3 risk table's first row. Provider JSON is parsed with
`parseDecimalJson`, whose reviver uses `context.source` (V8 12.4+/Node 22+; this
repo pins Node 26) to keep **the original text of every number**. `232.35` never
becomes `232.34999999999999432…`. `supportsSourceText()` is exported so a test
can assert we are on the exact path rather than silently on the `String(value)`
fallback. JSON is additionally bounded by depth (32) and node count (200,000),
because a 1 MiB body can still be a million-deep array.

Columns are `NUMERIC(20,10)` (`@core/db`'s `rateColumn`), read back as decimal
strings — not `BIGINT` minor units, because a unit price is routinely sub-cent
and minor units would round it at the storage layer where nobody would see it.
The dispatch writes `NUMERIC(20,8)`; (20,10) is the house vocabulary and is
strictly finer, so every value that shape could hold, this one holds exactly.

---

## 6. Secrets and custody

Four **optional, file-only** secrets, added to `SECRET_SPECS` in
`packages/config/src/schema.ts`:

| Secret              | File                               | Required for | Env fallback           |
| ------------------- | ---------------------------------- | ------------ | ---------------------- |
| `tiingo_api_key`    | `${SECRETS_DIR}/tiingo_api_key`    | no role      | **none, deliberately** |
| `fred_api_key`      | `${SECRETS_DIR}/fred_api_key`      | no role      | none                   |
| `coingecko_api_key` | `${SECRETS_DIR}/coingecko_api_key` | no role      | none                   |
| `openfigi_api_key`  | `${SECRETS_DIR}/openfigi_api_key`  | no role      | none                   |

File-only for the same reason as `plaid_client_id` (01 §1.10): an env var is
readable by every dependency in-process and survives into
`/proc/<pid>/environ`, child processes, crash dumps and `docker inspect`. All
four optional because **every adapter degrades honestly without its key** —
dispatch §6, _"Phase 3 completes with zero keys"_. `load.ts` needed no change:
the generic `SECRET_SPECS` loop already covers them, and
`gate-secret-custody.test.ts` derives its cases from the spec list, so all four
were picked up automatically (8 new gate assertions).

**No column in 0015 holds a credential** — not sealed, not hashed, not
truncated. That is what lets the custody test assert against _every_ text column
of `market_data_runs` rather than one suspect field.

**`ApiKey` cannot be printed by accident.** `toString`, `toJSON` and
`util.inspect.custom` all answer `'[redacted]'`; `reveal()` is the only path to
plaintext and is called in exactly one place per adapter.

**FRED is the one provider whose key necessarily travels in a URL** — `api_key`
is a query parameter and there is no header form. Consequences, both handled:
`http.ts` never interpolates a URL into an error message (it names the provider
and path), and every provider-authored string is passed through
`redactSecrets` before it is returned, logged or stored. Providers echo the
query string back in error bodies, which is the realistic way a key reaches
`market_data_runs.error_message`.

### 6.1 Defect found and fixed during this WP

**A missing key made three adapters throw instead of degrading.** Every adapter
built its request — including `key.reveal()` — _before_ `callJson` checked
`key.present`, and `reveal()` on an absent key throws by design. So an install
with no Tiingo key would have crashed the 03:45 refresh rather than returning
`skipped_no_key`, breaking dispatch §6 outright.

Fixed structurally rather than per-adapter: `callJson` now accepts a
`RequestSpec` — the request _or a thunk that builds one_ — and the credential is
only revealed after the key check. The property is now enforced in the shared
path instead of by each adapter remembering. Covered for all four adapters by
`test/rate-limit.test.ts` → `'a missing key spends nothing and dials nothing'`.

---

## 7. Schema and ownership

`0015_market_data.sql` creates four tables under **two owners**:

| Table                   | Owner               | Why                                                      |
| ----------------------- | ------------------- | -------------------------------------------------------- |
| `prices`                | `@ctx/investments`  | 08 §1.3 #7: `PriceReader` is its published port          |
| `fx_rates`              | `@ctx/investments`  | same                                                     |
| `price_source_priority` | `@ctx/investments`  | the ladder is read at price time                         |
| `market_data_runs`      | `@ctx/integrations` | it does the fetching; the record of a fetch is its table |

`@ctx/integrations` **never writes a price row**. `personalfi/layer-imports`
forbids it from importing `@ctx/investments` at all, so rows cross the seam
through an injected `MarketDataWriter` that the composition root adapts. That is
what keeps "exactly one context may write a table" structurally true across a
seam spanning two contexts. Both OWNERSHIP.md files state the split and say what
the other owns; `lint:schema-ownership` parses them.

Constraints carrying a rule rather than a type:

| Constraint                                 | Enforces                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `prices_source_is_an_observation`          | `last_known` can never be written (07 §6.1)                                          |
| `prices_close_is_not_negative`             | `>= 0`; zero is legal — a delisted security is genuinely worth nothing               |
| `fx_rates_is_a_real_pair`                  | `base <> quote`; the identity is not storable (D4)                                   |
| `fx_rates_rate_is_positive`                | `> 0`; a zero rate divides into an infinity downstream                               |
| `price_source_priority_override_is_first`  | a user override that is not rung 1 is not an override                                |
| `price_source_priority_last_known_is_last` | a carry-forward that is not rung 99 would shadow a real quote                        |
| `market_data_runs_refused_names_its_code`  | `outcome = 'refused'` ⇒ `refusal_code IS NOT NULL`, so "what refused us?" is a query |

`packages/db/test/migrate.test.ts` rows for 0015 were already present from the
snapshot (WP 3.2 owns that file this wave; the 0015 rows are mine and are
minimal — the four table names and the constraint commentary).

---

## 8. Test inventory

All run with **no network**. The live smokes (§8.3) skip unless a key is present
_and_ `MARKET_DATA_LIVE_SMOKE=1`.

### 8.1 `integrations` project — 55 passed, 4 skipped (live smokes)

| File                            | Tests         | Exit-test names from the dispatch                                                                                                                                                                                                                          |
| ------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/egress-allowlist.test.ts` | 17            | `'a price-source URL pointing at db:5432 is refused'`, `'169.254.169.254 is refused'`, `'a 302 to an internal host is not followed'`, `'a DNS answer that changes between check and connect is refused'`, `'no adapter can reach a non-allow-listed host'` |
| `test/shared-allowlist.test.ts` | 4             | `'the price egress guard is the notifications module, not a copy of it'`                                                                                                                                                                                   |
| `test/log-hygiene.test.ts`      | 8             | `'an API key never appears in a log line'`                                                                                                                                                                                                                 |
| `test/attribution.test.ts`      | 7             | `'CoinGecko and FRED adapters declare a non-empty attribution their ToS requires'`, `'the CoinGecko read model carries the attribution requirement'`                                                                                                       |
| `test/rate-limit.test.ts`       | 9             | `'the Tiingo adapter refuses its own 1,001st call of a day rather than being refused'`                                                                                                                                                                     |
| `test/openfigi.test.ts`         | 9             | `'120 symbols are two batched requests, not 120'`                                                                                                                                                                                                          |
| `test/live-smoke.test.ts`       | 1 + 4 skipped | one smoke per adapter, each gated on its own key                                                                                                                                                                                                           |

### 8.2 `investments` project — 31 passed (WP 3.4 files only)

| File                     | Tests | Names                                                                                                                                                                             |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/fx.test.ts`         | 13    | `'a missing FX rate is an explicit error, never 1.0'`, `'never returns 1 for a pair it has no observation for'`, `'the identity is answered structurally, without reading a row'` |
| `src/prices.test.ts`     | 12    | `'a carry-forward is a label, never a written row'`, `'a price older than 24 h is STALE and excluded from as-of-now deltas'`                                                      |
| `test/staleness.test.ts` | 6     | `'a 25-hour-old price marks the holding STALE'`                                                                                                                                   |

### 8.3 `config` project — 114 passed (+13 over baseline)

5 new in `load.test.ts` for the four market-data secrets; 8 auto-derived in
`gate-secret-custody.test.ts`.

### 8.4 `integrations-db` project — 9 passed

Scratch database `personalfi_wp_prices_<suite>`, harness mirroring
`@ctx/investments`' (no `@core/testkit` — `scripts/eslint-boundaries.js` has no
layer for these packages yet).

| #   | Test                                                                             |
| --- | -------------------------------------------------------------------------------- |
| 1   | `'the raw column contains no plaintext API key'`                                 |
| 2   | `'SABOTAGE: the unredacted provider body would be found by that sweep'`          |
| 3   | `'a refused run records its refusal code'`                                       |
| 4   | `'refuses a carry-forward written back as an observation'`                       |
| 5   | `'refuses a negative close but accepts zero'`                                    |
| 6   | `'refuses a self-pair, because the only 1.0 is the one FxReader never stores'`   |
| 7   | `'refuses a zero rate'`                                                          |
| 8   | `'pins the two rungs that make the ladder mean anything'`                        |
| 9   | `'a NUMERIC(20,10) close round-trips as an exact decimal string, never a float'` |

The exit test (1) drives the **real** `createFredSource` +
`createProviderClient` + `policyFor('fred')` with only the socket faked,
answering HTTP 400 whose body echoes the key, through `createPriceRefreshJob`
with a recorder that INSERTs into `market_data_runs`. It asserts the
preconditions — the key _was_ on the wire, and the run _did_ fail — then sweeps
**every** text/varchar column reported by `information_schema.columns` via
`sql.raw` (not a typed select) and asserts none contains the plaintext. The
generic sweep means a future column is covered without editing the test.

**Custody sabotage, three independent controls:**

| Control                            | Method                                                                                         | Observed                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| In-suite negative control (test 2) | insert the unredacted body, sweep                                                              | plaintext found, and found **only** in `error_message` ✅                                    |
| Mutation A                         | drop `keys: [key]` from the client and the job                                                 | exit test **red**: `expected '…' to contain '[redacted]'` ✅                                 |
| Mutation B                         | mutation A _plus_ the `[redacted]` assertion disabled, to prove the generic sweep itself bites | still **red**: `expected 'error_message=…' not to contain 'fredkey_…'`, naming the column ✅ |

Files restored after each mutation; re-run 9/9 green.

Constraint tests each assert `{ code: '23514', constraint: '<name>' }` rather
than merely "it threw": `market_data_runs_refused_names_its_code`,
`prices_source_is_an_observation`, `prices_close_is_not_negative` (zero accepted,
reads back `'0.0000000000'`), `fx_rates_is_a_real_pair`,
`fx_rates_rate_is_positive`, `price_source_priority_override_is_first`,
`price_source_priority_last_known_is_last`. The D3 test asserts `typeof ===
'string'` and the exact strings `'0.0000000342'` / `'232.3500000000'` — the
trailing zeros being scale-10 padding, i.e. evidence of a stored decimal rather
than a re-rendered float.

---

## 9. What the orchestrator must apply

1. **`compose.yml`** — four top-level `secrets:` entries (`tiingo_api_key`,
   `fred_api_key`, `coingecko_api_key`, `openfigi_api_key`, `file:
./secrets/<name>`) and per-service mounts on **`api` and `worker` only**. The
   `migrator` must **not** receive them: it applies DDL and has no `PriceSource`.
   Mode 0400, ownership matching the app user, or `loadConfig` reports EACCES.
2. **`harden-secrets`** coverage for the four new files (dispatch §5 item 8).
3. **`MARKET_DATA_ALLOWED_HOSTS`** — dispatch §4 item 8 puts this in the config
   batch. It is a **non-secret env var** and belongs in `environmentSchema`, not
   `SECRET_SPECS`, so it was deliberately **not** added here. Follow
   `NOTIFICATIONS_ALLOWED_HOSTS`'s pattern including the hand-validation
   (empty-string vs absent, no wildcards, no IP literals).
   `createMarketDataEgressPolicy(input)` already accepts an override so a
   deployment can **narrow** the list; the default is code, not environment, and
   an empty env var cannot silently widen anything.
4. **Composition root (`apps/api/src/domain.ts`)** — feature-detect each key
   exactly as Plaid's credentials are; build each adapter with
   `createProviderClient({ provider, policy: policyFor(provider), transport:
createNodeTransport(), keys })`; assign `createOpenFigiMapper` to
   `@ctx/investments`' `FigiMapper` port (TypeScript checks the structural match
   there, which is the intended build-time failure if the two ever drift); adapt
   `MarketDataWriter` onto `@ctx/investments`' `prices`/`fx_rates` writes; call
   `budget.hydrate(...)` from `market_data_runs` at boot.
5. **Schedule** `integrations.price_refresh` at **03:45 local** (08 §3.7), and
   register `INTEGRATIONS_EVENTS` (`integrations.PricesUpdated`,
   `integrations.PriceSourceUnavailable`) in the event registry.
6. **Seed `price_source_priority`** per user from `DEFAULT_LADDERS` via
   `ladderRows(...)`.
7. **`.env.example` / operator docs** — list the four secret file names.
8. **vitest/CI** — the `integrations` and `integrations-db` projects already
   exist in `vitest.config.ts`. CI must run `integrations-db` with a database,
   and must **not** set `MARKET_DATA_LIVE_SMOKE`.
9. **`apps/api/src/reports/export/registry.ts` — the one remaining `just check`
   failure, and it belongs to neither WP 3.4 nor WP 3.2.** WP 2.8's export
   registry asserts that _every user-scoped table_ appears in the export
   manifest, and migrations 0014 and 0015 together added nine that do not:

   | Table                                                                                                    | Migration | WP      |
   | -------------------------------------------------------------------------------------------------------- | --------- | ------- |
   | `basis_method_elections`, `cost_basis_lots`, `holdings`, `holdings_snapshots`, `investment_transactions` | 0014      | 3.2     |
   | `prices`, `fx_rates`, `price_source_priority`, `market_data_runs`                                        | 0015      | **3.4** |

   `apps/api/test/db/export-import.test.ts` → `'every user-scoped table appears
in the manifest'` is red with exactly those nine. Neither finishing agent
   owns `apps/api`, so neither fixed it; it is a shared-file task of the same
   kind as the vitest-project and boundary-layer entries the orchestrator has
   already applied this wave.

   **Decisions the registry entries require, which is why this is not a
   mechanical add.** Three of the four WP 3.4 tables are ordinary user data and
   should export and re-import like any other. `market_data_runs` is different
   and should be considered for **exclusion**: it is an operational audit
   ledger, it is the durable spend the rate budgets hydrate from, and importing
   another deployment's run history would seed this install's Tiingo budget
   with calls it never made — which is the precise failure the budget exists to
   prevent. It also carries `error_message`, which is redacted but is still
   provider-authored text. Recommend `prices`, `fx_rates` and
   `price_source_priority` in the manifest; `market_data_runs` excluded with the
   reason recorded, the same way any other deliberately-unexported table is.

   One further constraint on import ordering: `prices` and `fx_rates` are
   `NUMERIC(20,10)` and must round-trip as **decimal strings**, never through a
   float (D3). `prices.security_id` also references `securities`, so it must
   import after 0013's tables.

---

## 10. Open items

- **Sabotage B** (§2.1) — the cleartext control cannot be shown red from inside
  this package because `checkUrl` pins https at the platform layer. Recorded
  rather than papered over.
- **yfinance adapter not built.** 01 §4.2 makes it opt-in and best-effort;
  `PROVIDER_HOSTS` knows the host and `YFINANCE_WINDOWS` publishes a
  conservative self-imposed budget, but there is no adapter and the host is not
  in `MARKET_DATA_ALLOWED_HOSTS`, so nothing can reach it. Deliberate.
- **`search(symbol)`** is implemented for Tiingo and CoinGecko and honestly
  unsupported for FRED and OpenFIGI. No caller uses it yet; WP 3.1's manual
  security-add flow is the intended consumer.
- **Macro series** (`DGS10`, `DGS3MO`, `CPIAUCSL`) are fetchable via
  `FredSource.macro` — the market rate C1/C2 have withheld for since Phase 2 —
  but nothing consumes them until WP 3.10. No storage table for macro
  observations exists yet; WP 3.10 should decide whether it needs one rather
  than re-fetching.
- **`cache.ts`** named in the dispatch's "Owns" list was not built. The 03:45
  refresh writes to `prices`, and `prices` _is_ the cache: a second caching
  layer in front of a table that already stores one row per security per day
  would be a second source of truth for the same fact. Flagged in case the gate
  reads the file list literally.
