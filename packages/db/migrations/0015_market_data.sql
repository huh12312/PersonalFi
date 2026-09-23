-- SPDX-License-Identifier: MIT
-- 0015_market_data: prices, FX rates, the per-kind source ladder, and the
--                   ledger of every outbound market-data run (WP 3.4; 07 §6.1,
--                   08 §1.3 #7 and §6.6, decisions D3, D4 and D17).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Four tables, two owners
-- ---------------------------------------------------------------------------
--
--   prices                 @ctx/investments — security × date × source
--   fx_rates               @ctx/investments — pair × date × source
--   price_source_priority  @ctx/investments — 07 §6.1's ladder, per security
--                          kind, user-editable
--   market_data_runs       @ctx/integrations — what we asked a provider for,
--                          what it cost against that provider's published
--                          budget, and what came back
--
-- The split follows 08 §1.3: #7 gives Investments `prices`, `fx_rates` and
-- `price_source_priority` because `PriceReader`/`FxReader` are its published
-- ports; the *fetching* is `@ctx/integrations`' job and the record of a fetch
-- is therefore its table. Integrations never writes a price row directly — it
-- hands rows to an injected writer the composition root adapts onto
-- `@ctx/investments` — which is what keeps "one context may write a table"
-- true across a seam that spans two of them. `lint:schema-ownership` checks the
-- claim; the port is what makes the claim survive contact with the code.
--
-- ---------------------------------------------------------------------------
-- Staleness is a property of *now*, so it is not stored (07 §6.1)
-- ---------------------------------------------------------------------------
--
-- 07 §6.1 is unambiguous: "if last price > 24h old, mark the holding STALE and
-- exclude from 'as of now' deltas." That is a statement about the clock at read
-- time, and a boolean written at insert time would be wrong twenty-five hours
-- later while still reading as authoritative. So `prices.observed_at` records
-- when the provider answered and `priceStalenessOf(observed_at, now)` in
-- `@ctx/investments/src/prices.ts` decides FRESH vs STALE against an injected
-- `Clock`. Nothing in this schema can be out of date, because nothing in it
-- claims to be current.
--
-- `prices.stale` is a *different, narrower* fact and the comment on the column
-- says so: the provider itself served a carry-forward rather than a close for
-- the day we asked about (a market holiday, a CoinGecko quote whose
-- `last_updated_at` predates the requested date). It is what the provider said,
-- not what the clock says.
--
-- ---------------------------------------------------------------------------
-- History is never recomputed from today's price (07 §6.1)
-- ---------------------------------------------------------------------------
--
-- 07 §6.1: "Store price_snapshot(asset, ts, price, source) — never recompute
-- history from today's price." The structural form of that rule here is which
-- values `prices.source` will accept. `last_known` is the *fourth rung of the
-- read ladder* — "no row for this date, so carry the most recent earlier row
-- forward, labelled" — and it is deliberately absent from the CHECK, so a
-- carry-forward can never be written back as though it were an observation. A
-- bug that tried would get a 23514 naming `prices_source_is_an_observation`
-- rather than a plausible-looking row that quietly rewrites a chart.
--
-- ---------------------------------------------------------------------------
-- A missing FX rate is an error, never 1.0 (D4, 08 §6.6)
-- ---------------------------------------------------------------------------
--
-- 08 §6.6: "A missing rate is an explicit FxRateUnavailable domain error with a
-- UI affordance to enter one manually — never a silent 1.0." The failure mode
-- D4 names is a CAD account quietly counting as USD: arithmetically plausible,
-- materially wrong, invisible.
--
-- The schema's contribution is `fx_rates_is_a_real_pair`, which refuses
-- `base = quote`. The one legitimate 1.0 in the system — USD→USD — is answered
-- structurally by `FxReader.rate`, which returns `{ kind: 'identity' }` without
-- reading a row at all. Because an identity rate can never be *stored*, no
-- query can find a 1.0 row and mistake it for a fetched rate, and no fixture
-- can accidentally create one. The sabotage is in `src/fx.test.ts`.
--
-- ---------------------------------------------------------------------------
-- No float, anywhere. And no minor units for a price.
-- ---------------------------------------------------------------------------
--
-- Decision D3 and docs/CONVENTIONS.md. `close` and `rate` are
-- `NUMERIC(20,10)` — `@core/db`'s `rateColumn`, read back as a decimal string,
-- never as a float. Not `BIGINT` minor units: a unit price is routinely
-- sub-cent (a money-market fund at 1.0001, ETH at 0.0000000342 BTC), and minor
-- units would round it at the storage layer where nobody would ever see it
-- happen. 03-phase-3-dispatch.md §3 writes this as NUMERIC(20,8); (20,10) is
-- the house column vocabulary and is strictly finer, so every value the
-- dispatch's shape could hold, this one holds exactly.
--
-- Every instant is `TIMESTAMPTZ`. Every business date is `DATE`: a daily close
-- is a calendar day at UTC 00:00 (07 §6.1's reporting convention, which exists
-- because mixed exchange timezones "produce phantom volatility in the net-worth
-- chart"), and a `TIMESTAMPTZ` would re-introduce the offset the convention is
-- there to remove.
--
-- ---------------------------------------------------------------------------
-- No API key is stored anywhere in this migration
-- ---------------------------------------------------------------------------
--
-- Provider keys are file secrets under `${SECRETS_DIR}` (decision D5:
-- `tiingo_api_key`, `fred_api_key`, `coingecko_api_key`, `openfigi_api_key`),
-- read at boot by `@core/config` and handed to an adapter as an opaque
-- `ApiKey` that redacts itself in every string context. There is no column here
-- for one — not sealed, not hashed, not truncated — which is why WP 3.4's
-- `test/custody.test.ts` ('the raw column contains no plaintext API key') can
-- assert against *every* text column of `market_data_runs` rather than against
-- one suspect field. `market_data_runs.error_message` is the column a key could
-- plausibly reach (providers echo the query string back in error bodies), so it
-- is written through the same redactor and that test sabotages it.

-- ---------------------------------------------------------------------------
-- prices
-- ---------------------------------------------------------------------------

CREATE TABLE prices (
  id             UUID         PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  security_id    UUID         NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  -- The daily close's calendar day, at UTC 00:00 (07 §6.1's reporting
  -- convention). A provider that answers in its own exchange timezone is
  -- normalised to this at the adapter, not here.
  price_date     DATE         NOT NULL,

  -- Which rung of 07 §6.1's ladder produced this row. `last_known` is absent on
  -- purpose — see the header. `exchange_fill` is a price we *paid*, taken from
  -- an investment transaction, which beats any provider quote for that day
  -- because it is not an estimate of anything.
  source         TEXT         NOT NULL,

  close          NUMERIC(20,10) NOT NULL,
  currency       CHAR(3)      NOT NULL,

  -- What the provider said about its own answer, not what the clock says. See
  -- the header: the 24-hour STALE rule is computed at read time from
  -- `observed_at`, because it is a statement about now.
  stale          BOOLEAN      NOT NULL DEFAULT FALSE,

  -- When the provider answered. The input to the 24-hour rule.
  observed_at    TIMESTAMPTZ  NOT NULL,

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT prices_source_is_an_observation CHECK (source IN (
    'user_override', 'exchange_fill', 'tiingo', 'coingecko', 'yfinance')),
  -- A negative price is not a price. Zero is legal and meaningful: a delisted
  -- security or a worthless token is genuinely worth nothing, and refusing to
  -- record that would leave the last real price standing forever.
  CONSTRAINT prices_close_is_not_negative CHECK (close >= 0),
  CONSTRAINT prices_currency_is_iso4217 CHECK (currency ~ '^[A-Z]{3}$')
);

-- One answer per security, per day, per source, per quote currency. The upsert
-- target: a re-run of the 03:45 refresh overwrites the day's row rather than
-- appending a second opinion, and two sources disagreeing about AAPL on
-- 2026-09-21 is two rows the ladder chooses between, not a conflict.
CREATE UNIQUE INDEX prices_user_security_date_source_idx
  ON prices (user_id, security_id, price_date, source, currency);

-- The reader's query: "the best row for this security on or before this date."
CREATE INDEX prices_user_security_date_idx
  ON prices (user_id, security_id, price_date DESC);

COMMENT ON TABLE prices IS
  'A daily close per security per source, at UTC 00:00 (07 6.1). History is never recomputed from today''s price: source cannot be last_known, so a carry-forward can only ever be a read-time label.';
COMMENT ON COLUMN prices.stale IS
  'The provider served a carry-forward rather than a close for the requested day. NOT the 24-hour staleness rule, which is computed against the clock at read time from observed_at.';
COMMENT ON COLUMN prices.observed_at IS
  'When the provider answered. The input to 07 6.1''s rule: a price older than 24 hours marks the holding STALE and is excluded from as-of-now deltas.';

-- ---------------------------------------------------------------------------
-- fx_rates
-- ---------------------------------------------------------------------------

CREATE TABLE fx_rates (
  id             UUID         PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  base_currency  CHAR(3)      NOT NULL,
  quote_currency CHAR(3)      NOT NULL,
  rate_date      DATE         NOT NULL,
  source         TEXT         NOT NULL,

  -- 1 base = `rate` quote. The direction is stated here because getting it
  -- backwards is the other invisible FX bug, and `FxReader` inverts a stored
  -- pair rather than storing both directions.
  rate           NUMERIC(20,10) NOT NULL,

  observed_at    TIMESTAMPTZ  NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT fx_rates_source_is_an_observation CHECK (source IN (
    'user_override', 'fred', 'tiingo', 'coingecko')),
  -- Strictly positive: a zero or negative exchange rate is not a rate, and a
  -- zero would divide a conversion into an infinity somewhere downstream.
  CONSTRAINT fx_rates_rate_is_positive CHECK (rate > 0),
  -- The identity rate is not storable. USD->USD is answered structurally by
  -- FxReader without a row, so no query can find a 1.0 and mistake it for a
  -- fetched rate (D4, 08 6.6).
  CONSTRAINT fx_rates_is_a_real_pair CHECK (base_currency <> quote_currency),
  CONSTRAINT fx_rates_base_is_iso4217 CHECK (base_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fx_rates_quote_is_iso4217 CHECK (quote_currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX fx_rates_user_pair_date_source_idx
  ON fx_rates (user_id, base_currency, quote_currency, rate_date, source);

CREATE INDEX fx_rates_user_pair_date_idx
  ON fx_rates (user_id, base_currency, quote_currency, rate_date DESC);

COMMENT ON TABLE fx_rates IS
  'One rate per pair per date per source: 1 base_currency = rate quote_currency. base = quote is refused, so the only 1.0 in the system is the identity FxReader returns without reading a row (D4).';

-- ---------------------------------------------------------------------------
-- price_source_priority
-- ---------------------------------------------------------------------------
--
-- 07 §6.1's ladder — "user override > exchange fill > CoinGecko/CoinPaprika
-- free API > last known" — as rows rather than as an ORDER BY, because it is
-- per security kind (a crypto token's ladder ends at CoinGecko; an ETF's ends
-- at Tiingo) and because §6 of the dispatch makes it user-editable.
--
-- Two rungs are pinned by CHECK rather than by convention, because the ladder
-- stops meaning anything if they move: a user override that is not first is not
-- an override, and a last-known carry-forward that is not last would shadow a
-- real quote with a stale one.

CREATE TABLE price_source_priority (
  id             UUID         PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The `securities.type` vocabulary, so a ladder is chosen by the kind of
  -- thing being priced. Same list as 0013, minus nothing: `cash` has a ladder
  -- too (it is priced at 1.0 in its own currency, via the identity rung).
  security_kind  TEXT         NOT NULL CHECK (security_kind IN (
                                'equity', 'etf', 'mutual_fund', 'crypto',
                                'bond', 'cash', 'other')),
  rung           SMALLINT     NOT NULL,
  source         TEXT         NOT NULL,
  enabled        BOOLEAN      NOT NULL DEFAULT TRUE,

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT price_source_priority_source_is_known CHECK (source IN (
    'user_override', 'exchange_fill', 'tiingo', 'coingecko', 'fred',
    'yfinance', 'last_known')),
  CONSTRAINT price_source_priority_rung_is_ranked CHECK (rung BETWEEN 1 AND 99),
  CONSTRAINT price_source_priority_override_is_first CHECK (
    source <> 'user_override' OR rung = 1),
  CONSTRAINT price_source_priority_last_known_is_last CHECK (
    source <> 'last_known' OR rung = 99)
);

-- One source per rung and one rung per source, within a kind: a ladder with two
-- second places is not a ladder.
CREATE UNIQUE INDEX price_source_priority_user_kind_rung_idx
  ON price_source_priority (user_id, security_kind, rung);
CREATE UNIQUE INDEX price_source_priority_user_kind_source_idx
  ON price_source_priority (user_id, security_kind, source);

COMMENT ON TABLE price_source_priority IS
  '07 6.1''s price ladder per security kind, user-editable. user_override is pinned to rung 1 and last_known to rung 99 by CHECK, because an override that is not first is not an override.';

-- ---------------------------------------------------------------------------
-- market_data_runs   (@ctx/integrations)
-- ---------------------------------------------------------------------------
--
-- Every outbound market-data call, counted against the provider's published
-- budget. 03-phase-3-dispatch.md §3 requires the documented number to be *in
-- the code* (Tiingo 50/hr and 1,000/day, FRED 120/60 s, CoinGecko ~100/min and
-- 10,000 credits/month, OpenFIGI 25,000 jobs/min); this table is where the
-- spend against those numbers is durable, so a budget survives a worker restart
-- rather than resetting to zero at 03:45 and hammering a provider that has
-- already answered a thousand times today.
--
-- It is also the audit trail for a refusal: a run whose `outcome` is `refused`
-- carries the `refusal_code` the egress guard returned, so "the price source
-- tried to reach something it should not" is a query rather than a log grep.

CREATE TABLE market_data_runs (
  id             UUID         PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  provider       TEXT         NOT NULL CHECK (provider IN (
                                'tiingo', 'fred', 'coingecko', 'openfigi', 'yfinance')),
  operation      TEXT         NOT NULL CHECK (operation IN (
                                'price_refresh', 'fx_refresh', 'macro_series',
                                'symbol_search', 'figi_map', 'test_fetch')),

  started_at     TIMESTAMPTZ  NOT NULL,
  finished_at    TIMESTAMPTZ,

  outcome        TEXT         NOT NULL CHECK (outcome IN (
                                'ok', 'partial', 'failed', 'refused',
                                'rate_limited', 'skipped_no_key')),

  -- What this run spent. `requests_made` is HTTP requests; `units_spent` is the
  -- provider's own unit where it differs (CoinGecko bills credits, OpenFIGI
  -- bills mapping jobs), so a budget can be read back in the units the
  -- provider's ToS is written in.
  requests_made  INTEGER      NOT NULL DEFAULT 0 CHECK (requests_made >= 0),
  units_spent    INTEGER      NOT NULL DEFAULT 0 CHECK (units_spent >= 0),
  symbols_asked  INTEGER      NOT NULL DEFAULT 0 CHECK (symbols_asked >= 0),
  rows_written   INTEGER      NOT NULL DEFAULT 0 CHECK (rows_written >= 0),

  -- `@core/platform`'s `RefusalCode`, when the egress guard said no. Not a
  -- CHECK against the list: the list lives in one TypeScript file and pinning
  -- it here too would make adding a refusal a migration.
  refusal_code   TEXT,
  -- Redacted before it is written (`redactSecrets`), never the raw provider
  -- body. See the header, and `test/custody.test.ts`.
  error_message  TEXT,
  -- When the client-side budget said "not yet". Surfaced to the scheduler so a
  -- retry waits rather than guessing.
  retry_after_ms INTEGER      CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT market_data_runs_refused_names_its_code CHECK (
    outcome <> 'refused' OR refusal_code IS NOT NULL),
  CONSTRAINT market_data_runs_finished_after_started CHECK (
    finished_at IS NULL OR finished_at >= started_at)
);

-- The budget query: "how many requests has this provider made since T?"
CREATE INDEX market_data_runs_provider_started_idx
  ON market_data_runs (user_id, provider, started_at DESC);

COMMENT ON TABLE market_data_runs IS
  'One row per outbound market-data call: what we asked, what it cost against the provider''s published budget, and what came back. No column here holds a credential — provider keys are file secrets and never reach the database.';
COMMENT ON COLUMN market_data_runs.error_message IS
  'Redacted before write. A provider that echoes the query string back in an error body would otherwise carry the API key into this column.';
