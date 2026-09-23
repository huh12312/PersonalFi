-- SPDX-License-Identifier: MIT
-- 0017_net_worth_daily: the daily net-worth read model, its seal, and the
--                       gapless calendar spine the chart is drawn on (WP 3.8;
--                       04 §5.4, 07 §4.1, 08 §1.3 #8 and §3.5/§3.7, decisions
--                       D3, D4, D6).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- One table, and why it belongs to @ctx/planning
-- ---------------------------------------------------------------------------
--
--   net_worth_daily   @ctx/planning — user x date, one row per revision
--
-- Every input to this table belongs to somebody else: balances and the
-- account roster are `@ctx/ledger`'s, holdings are `@ctx/investments`', prices
-- and FX rates are `@ctx/investments`' too, and the refresh that writes them is
-- `@ctx/integrations`'. None of that makes any of them the owner. 08 §1.3 #8 is
-- explicit — "`net_worth_daily` (read model; Planning's snapshotter is the sole
-- writer)" — and the reason is that the rule this table exists to enforce is a
-- *planning* rule: a past day is a snapshot and not a recomputation. Ledger
-- cannot enforce that; it does not know a day has closed. Investments cannot
-- enforce it; it does not know what a liability is. The context that draws the
-- series is the context that must refuse to redraw it.
--
-- So the snapshotter reads its inputs through four injected ports —
-- `BalancesReader`, `HoldingsReader`, `PriceReader`, `FxReader` (see
-- `packages/contexts/planning/src/ports.ts`) — and never through a table
-- handle. `pnpm lint:schema-ownership` checks that no SQL in
-- `packages/contexts/planning/` names `accounts`, `holdings`, `prices` or
-- `fx_rates`; the ports are what make the check survive contact with the code.
--
-- What it costs Phase 4: Planning's first table lands a phase early and its
-- migration number is spent. Nothing else in Planning is opened — `goals`,
-- `plan_scenarios`, `projection_runs` and the rest are still claims in
-- OWNERSHIP.md — so Phase 4 inherits one live table with one writer and a
-- reader surface, which is strictly less work than inheriting the same table
-- from Ledger and having to move it.
--
-- ---------------------------------------------------------------------------
-- Seal semantics (08 §3.5): today is mutable, yesterday is history
-- ---------------------------------------------------------------------------
--
-- 08 §3.5: "today's row is maintained incrementally and is mutable; at 02:00
-- local it is sealed and never touched again." The failure mode it guards
-- against is not a crash — it is a chart that quietly rewrites itself. A past
-- day recomputed tonight uses tonight's prices and tonight's corrected
-- balances, so every trend the app draws would be a trend through numbers that
-- were never true on the days they are plotted against.
--
-- "Never touched again" is enforced three ways, deliberately overlapping:
--
--   1. `net_worth_daily_sealed_rows_are_immutable`, a BEFORE UPDATE trigger
--      that raises 23514 when `OLD.sealed_at IS NOT NULL`. This is the one
--      that holds when a future writer forgets — it covers `psql`, a
--      migration, a repair script, and any code path that has not been
--      written yet. BEFORE UPDATE only, and never BEFORE DELETE, for the
--      reason 0014_lots.sql gives about
--      `basis_method_elections_average_cost_is_sticky`: a DELETE trigger would
--      break the `users` ON DELETE CASCADE, and "deleting the account holder
--      deletes their data" outranks "a sealed row is forever".
--   2. `net_worth_daily_one_open_day_idx`, a partial UNIQUE index on
--      (user_id, as_of_date) WHERE sealed_at IS NULL. At most one mutable row
--      per day can exist, so "the row the writer may touch" is never ambiguous.
--   3. The guarded UPDATE in `src/seal.ts`, which is what produces a *typed*
--      refusal rather than a 23514 for the ordinary case.
--
-- A correction does not mutate. It inserts the *next revision* of the day,
-- carrying `supersedes_id` and `correction_reason`, and the sealed row it
-- replaces is not written to at all — which is what makes the byte-for-byte
-- diff of a sealed range across two snapshot runs a meaningful test rather
-- than a tautology about an idempotent UPDATE. The current row for a date is
-- the highest revision; history is every revision below it.
--
-- ---------------------------------------------------------------------------
-- FX is stored on the aggregate (D4), never applied on read
-- ---------------------------------------------------------------------------
--
-- D4: "dual native+base storage with a historical FX rate on aggregates".
-- Converting on read is the bug this shape prevents: today's rate applied to a
-- 2024 balance produces a 2024 net worth that moves every time the currency
-- market does. So each entry in `breakdown` carries the native amount, the
-- base amount, and the `fxRate`/`fxRateDate` pair that produced the second
-- from the first — `net_worth_breakdown_is_well_formed` refuses a row whose
-- breakdown omits any of them, so a writer cannot accidentally store a base
-- amount with no provenance.
--
-- The same function requires `nativeMinor` and `baseMinor` to be JSON
-- *strings*. A JSON number cannot hold a BIGINT without silently rounding past
-- 2^53, which is D3's failure mode dressed up as serialisation — the same rule
-- `investments.RealizedGainRecorded` applies to its payload.
--
-- There is deliberately no `fx_rate_missing` column and no default. A missing
-- rate is `FxRateUnavailable`, thrown by `FxReader`, and the day does not get
-- written at all for that account — never a silent 1.0 (08 §6.6).
--
-- ---------------------------------------------------------------------------
-- The four booleans (07 §4.1) live in the breakdown, not in columns
-- ---------------------------------------------------------------------------
--
-- 07 §4.1 names four independent booleans — `on_budget`, `in_net_worth`,
-- `is_liquid`, `is_investable` — and says "get these four booleans right and
-- every downstream rule's denominator is unambiguous." They are properties of
-- an *account*, so their home is `accounts`, which is `@ctx/ledger`'s table and
-- not this context's to alter. What this table stores is the four totals they
-- produce (`liquid_minor`, `investable_minor`, `on_budget_minor`, and
-- `assets_minor`/`liabilities_minor` over `in_net_worth`) plus the flags as
-- they were on the day, per account, in `breakdown` — so a total can always be
-- audited back to the flags that produced it even after the user re-flags an
-- account.
--
-- **Today `accounts` carries only `include_in_net_worth`** (0004_ledger.sql).
-- `on_budget` is derived by `@ctx/budgeting`'s exclusion list
-- (`budgets.off_budget_account_ids`, 0009_budgeting.sql, which says in as many
-- words that adding an `on_budget` column would be Budgeting writing Ledger's
-- table), and `is_liquid` / `is_investable` do not exist at all. WP 3.8 does
-- not add them: they are `@ctx/ledger` columns and this WP owns one table in
-- one other context already. `BalancesReader.accounts()` returns all four, the
-- composition root derives the three that have no column from 07 §4.1's class
-- table, and `docs/evidence/phase-3/wp3.8-net-worth.md` §7 records the gap.
--
-- ---------------------------------------------------------------------------
-- The calendar spine (04 §5.4)
-- ---------------------------------------------------------------------------
--
-- 04 §5.4: "Use generate_series for the calendar spine so there are no gaps on
-- days with no activity — a gapless series is what makes charts and deltas
-- trivial downstream." `net_worth_calendar_spine(from, to)` is that, as a
-- function rather than as a string built in TypeScript, so "the spine has no
-- gaps" is a property of the database that a test can assert directly and a
-- future reader cannot accidentally reimplement with a `WHERE` that drops a
-- weekend.

-- ---------------------------------------------------------------------------
-- The breakdown's shape, as a function so a CHECK can use it
-- ---------------------------------------------------------------------------
--
-- Declared *before* the table because `net_worth_daily`'s CHECK calls it and
-- Postgres resolves that dependency as the table is created. (Phrased that way
-- deliberately: `scripts/check-schema-ownership.ts` scans this file for
-- `CREATE TABLE <name>` and the obvious wording of that sentence makes it
-- believe the migration creates a table called `time`.) A CHECK cannot
-- contain a subquery and `jsonb_array_elements` is set-returning, so the
-- per-element rule has to live behind a function call. It is IMMUTABLE and
-- PARALLEL SAFE and reads nothing outside its argument, which is what makes
-- that legitimate rather than the usual "a function in a CHECK can lie" trap:
-- there is no table it could consult and later disagree with.
--
-- What it refuses, entry by entry:
--
--   accountId     a JSON string. The account this contribution came from, so a
--                 total can be audited back to its parts.
--   currency      the account's own ISO code, upper-case. Not the base
--                 currency: that is the row's `base_currency`.
--   nativeMinor   BIGINT minor units in `currency`, as a JSON **string**.
--   baseMinor     the same amount in the row's `base_currency`, also a string.
--                 Both signed: a liability's contribution is negative.
--   fxRate        the historical rate that produced `baseMinor` from
--                 `nativeMinor`, as a decimal string (D4). Never a JSON
--                 number, for the same reason the amounts are not.
--   fxRateDate    the date that rate was observed. A rate with no date is a
--                 rate that cannot be checked, which is the same as no rate.
--   onBudget, inNetWorth, isLiquid, isInvestable
--                 07 §4.1's four booleans **as they were on the day**, each
--                 stored independently. All four required and all four
--                 booleans: a missing flag would let a denominator be guessed
--                 at read time, which is exactly the conflation 07 §4.1 warns
--                 about.
--
-- The string rule on the amounts is D3 dressed as serialisation: a JSON number
-- cannot hold a BIGINT past 2^53 without silently rounding, so the one place
-- the amount leaves the BIGINT columns is the one place it could quietly lose
-- precision. `investments.RealizedGainRecorded` applies the same rule to its
-- payload.
--
-- USD -> USD is not an exception: it stores fxRate '1' with the day as its
-- date, because the identity conversion is a conversion whose rate is known.
-- That is not the "silent 1.0" of 08 §6.6 — the silent 1.0 is a *missing*
-- rate, and a missing rate never reaches this table at all: `FxReader` throws
-- `FxRateUnavailable` and the account is not written.

CREATE FUNCTION net_worth_breakdown_is_well_formed(breakdown JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(breakdown) = 'array'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(breakdown) AS entry
       WHERE jsonb_typeof(entry) IS DISTINCT FROM 'object'
          OR jsonb_typeof(entry -> 'accountId') IS DISTINCT FROM 'string'
          OR btrim(entry ->> 'accountId') = ''
          OR jsonb_typeof(entry -> 'currency') IS DISTINCT FROM 'string'
          OR entry ->> 'currency' !~ '^[A-Z]{3}$'
          OR jsonb_typeof(entry -> 'nativeMinor') IS DISTINCT FROM 'string'
          OR entry ->> 'nativeMinor' !~ '^-?[0-9]+$'
          OR jsonb_typeof(entry -> 'baseMinor') IS DISTINCT FROM 'string'
          OR entry ->> 'baseMinor' !~ '^-?[0-9]+$'
          OR jsonb_typeof(entry -> 'fxRate') IS DISTINCT FROM 'string'
          OR entry ->> 'fxRate' !~ '^[0-9]+(\.[0-9]+)?$'
          OR jsonb_typeof(entry -> 'fxRateDate') IS DISTINCT FROM 'string'
          OR entry ->> 'fxRateDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          OR jsonb_typeof(entry -> 'onBudget') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(entry -> 'inNetWorth') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(entry -> 'isLiquid') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(entry -> 'isInvestable') IS DISTINCT FROM 'boolean'
     );
$$;

COMMENT ON FUNCTION net_worth_breakdown_is_well_formed(JSONB) IS
  'D4 and 07 §4.1 as a CHECK: every net_worth_daily.breakdown entry carries accountId, currency, nativeMinor, baseMinor (both JSON strings, never numbers), the fxRate/fxRateDate pair that produced the second from the first, and all four account booleans as they were that day.';

-- ---------------------------------------------------------------------------
-- net_worth_daily
-- ---------------------------------------------------------------------------

CREATE TABLE net_worth_daily (
  id                 UUID        PRIMARY KEY,
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The business date this row is *about*. A DATE, not a timestamp: "net worth
  -- on the 14th" is a calendar claim, and storing an instant would make it
  -- depend on the reader's zone.
  as_of_date         DATE        NOT NULL,

  -- 1 for the snapshot, 2+ for each correction. The current row for a date is
  -- the highest revision; a correction never overwrites the one below it.
  revision           INTEGER     NOT NULL DEFAULT 1 CHECK (revision >= 1),

  -- D4's base currency. Stored per row rather than assumed globally: an install
  -- that changes base currency must not silently restate its own history.
  base_currency      CHAR(3)     NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),

  -- All BIGINT minor units in `base_currency` (D3). `liabilities_minor` is a
  -- magnitude in the ordinary case: a card you owe $420 on stores 42000 here
  -- and -42000 in the breakdown's `baseMinor`, which is the account's signed
  -- contribution.
  --
  -- Neither side is constrained to a sign, and that is deliberate. An
  -- overdrawn checking account is still an *asset account*, so `assets_minor`
  -- may be negative; by exactly the same rule an overpaid credit card is still
  -- a *liability account*, so `liabilities_minor` may be negative too. Which
  -- side an account counts on is its classification's business, never its
  -- balance's — a `CHECK (liabilities_minor >= 0)` would look like prudence and
  -- would in fact force the writer to move an overpaid card's credit into
  -- `assets_minor`, so the totals and the breakdown would describe different
  -- account rosters and no total could be audited back to its parts. The
  -- identity below is what actually has to hold, and it holds either way.
  assets_minor       BIGINT      NOT NULL,
  liabilities_minor  BIGINT      NOT NULL,
  net_worth_minor    BIGINT      NOT NULL,

  -- 07 §4.1's other three denominators, each summed over its own boolean and
  -- never derived from another. `is_liquid` and `is_investable` are about
  -- assets; `on_budget` spans both sides, because a credit card is on-budget.
  liquid_minor       BIGINT      NOT NULL,
  investable_minor   BIGINT      NOT NULL,
  on_budget_minor    BIGINT      NOT NULL,

  -- Per-account, so the series is decomposable without a join explosion
  -- (04 §5.4) and without joining another context's tables at read time (which
  -- would be a second, worse reason the numbers could move).
  breakdown          JSONB       NOT NULL,

  -- 04 §5.4 and 08 §3.5. `observed` = every account had a genuine observation;
  -- `interpolated` = at least one account was reconstructed; `corrected` = this
  -- revision replaces a sealed row and says why.
  source             TEXT        NOT NULL CHECK (source IN ('observed', 'interpolated', 'corrected')),

  -- 08 §3.7: "If prices fail, net worth still seals using the last known
  -- price, flagged stale_price = true." A day that could not be priced freshly
  -- is still a day; refusing to seal it would leave a permanent hole in the
  -- series because tomorrow's prices can never make yesterday fresh.
  stale_price        BOOLEAN     NOT NULL DEFAULT false,

  accounts_counted   INTEGER     NOT NULL CHECK (accounts_counted >= 0),
  -- Accounts in net worth that could not be valued at all. Stored rather than
  -- inferred, because "net worth is $X across 9 of 11 accounts" and "net worth
  -- is $X" are different claims and the UI must be able to tell them apart.
  accounts_unvalued  INTEGER     NOT NULL CHECK (accounts_unvalued >= 0),

  -- The event-maintained half of 08 §3.5's table: a consumer sets this when a
  -- balance, a holding or a price lands, and the snapshotter recomputes. Only
  -- ever true on an unsealed row — a sealed day has nothing left to redo.
  dirty              BOOLEAN     NOT NULL DEFAULT false,

  -- NULL while the day is still open. Set once, at 02:00 local or later.
  sealed_at          TIMESTAMPTZ,

  -- Provenance for a correction: which revision it replaces, and why.
  supersedes_id      UUID        REFERENCES net_worth_daily (id) ON DELETE CASCADE,
  correction_reason  TEXT,

  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The identity, in the database rather than only in the aggregate. A writer
  -- that summed the breakdown one way and the totals another cannot persist
  -- the disagreement.
  CONSTRAINT net_worth_daily_net_is_assets_minus_liabilities
    CHECK (net_worth_minor = assets_minor - liabilities_minor),

  -- D4 and the four booleans, made structural. See the header.
  CONSTRAINT net_worth_daily_breakdown_is_well_formed
    CHECK (net_worth_breakdown_is_well_formed(breakdown)),

  -- 08 §3.5: "a correction writes a provenance-bearing row". Both directions:
  -- a correction must name what it replaces and why, and a row that names one
  -- must be a correction.
  CONSTRAINT net_worth_daily_correction_carries_provenance
    CHECK ((source = 'corrected')
           = (supersedes_id IS NOT NULL
              AND correction_reason IS NOT NULL
              AND btrim(correction_reason) <> '')),

  -- There is nothing for revision 1 to correct.
  CONSTRAINT net_worth_daily_corrections_are_later_revisions
    CHECK (source <> 'corrected' OR revision > 1),

  -- A sealed day has no pending recompute, by definition.
  CONSTRAINT net_worth_daily_sealed_rows_are_not_dirty
    CHECK (sealed_at IS NULL OR NOT dirty)
);

-- One row per user x date x revision.
CREATE UNIQUE INDEX net_worth_daily_day_revision_idx
  ON net_worth_daily (user_id, as_of_date, revision);

-- At most one *mutable* row per day, so "the row the writer may touch" is
-- never ambiguous and a second open revision cannot be created by a race.
CREATE UNIQUE INDEX net_worth_daily_one_open_day_idx
  ON net_worth_daily (user_id, as_of_date)
  WHERE sealed_at IS NULL;

-- The series read: newest revision of each day, over a date range.
CREATE INDEX net_worth_daily_series_idx
  ON net_worth_daily (user_id, as_of_date DESC, revision DESC);

-- The consumer's target: which open days need recomputing.
CREATE INDEX net_worth_daily_dirty_idx
  ON net_worth_daily (user_id, as_of_date)
  WHERE dirty;

COMMENT ON TABLE net_worth_daily IS
  'Daily net worth, one row per user x date x revision. Owner: @ctx/planning (08 §1.3 #8 — the snapshotter is the sole writer). Today is mutable; a sealed day is never updated and a correction is a new revision.';

COMMENT ON COLUMN net_worth_daily.sealed_at IS
  'NULL while the day is open. Once set, net_worth_daily_sealed_rows_are_immutable refuses every UPDATE on the row (08 §3.5).';
COMMENT ON COLUMN net_worth_daily.breakdown IS
  'One JSON object per account: the four booleans of 07 §4.1 as they were that day, plus D4''s native amount, base amount, fxRate and fxRateDate. Minor units are JSON strings, never numbers.';
COMMENT ON COLUMN net_worth_daily.liabilities_minor IS
  'The liability side, negated so that net = assets - liabilities: normally a positive magnitude, negative in the one honest case where the liability accounts net to a credit (an overpaid card). The breakdown carries each account''s signed contribution.';
COMMENT ON COLUMN net_worth_daily.stale_price IS
  '08 §3.7: the day sealed on a last-known price because the refresh could not reach a provider. The day is still genuine; the price is labelled.';
COMMENT ON COLUMN net_worth_daily.source IS
  '04 §5.4: observed | interpolated (at least one account reconstructed) | corrected (this revision replaces a sealed one).';
COMMENT ON COLUMN net_worth_daily.supersedes_id IS
  'The revision this one corrects. Set if and only if source = ''corrected''.';

-- ---------------------------------------------------------------------------
-- The seal
-- ---------------------------------------------------------------------------

CREATE FUNCTION net_worth_daily_sealed_rows_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'net_worth_daily % revision % was sealed at % and may never be updated; a correction is a new revision carrying supersedes_id and correction_reason (08 §3.5)',
      OLD.as_of_date, OLD.revision, OLD.sealed_at
      USING ERRCODE = '23514',
            CONSTRAINT = 'net_worth_daily_sealed_rows_are_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER net_worth_daily_sealed_rows_are_immutable
  BEFORE UPDATE ON net_worth_daily
  FOR EACH ROW
  EXECUTE FUNCTION net_worth_daily_sealed_rows_are_immutable();

-- ---------------------------------------------------------------------------
-- The calendar spine (04 §5.4)
-- ---------------------------------------------------------------------------

CREATE FUNCTION net_worth_calendar_spine(from_date DATE, to_date DATE)
RETURNS TABLE (as_of_date DATE)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT day::date
  FROM generate_series(from_date, to_date, INTERVAL '1 day') AS day
$$;

COMMENT ON FUNCTION net_worth_calendar_spine(DATE, DATE) IS
  '04 §5.4: every calendar day between two dates inclusive, so a net-worth series has no gaps on days with no activity. Empty when to_date < from_date.';
