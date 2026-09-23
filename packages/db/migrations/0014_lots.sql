-- SPDX-License-Identifier: MIT
-- 0014_lots: holdings, the investment-transaction ledger behind them, the
--             cost-basis lots those transactions open and close, and the
--             basis-method election that decides which lot a sale consumes
--             (WP 3.2; 04 §3.1 and §5.5, 07 §4.4 and §6.2, decisions D3, D6,
--             D25; the R6 verdict in docs/evidence/phase-3/wp3.5-coinbase.md §1).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Five tables, and why the split is the design
-- ---------------------------------------------------------------------------
--
--   holdings                what the institution says you own *right now*, per
--                           account × security. One row per position; a sync
--                           overwrites it. This is a **provider assertion**,
--                           not a derived number.
--   holdings_snapshots      the same assertion, kept per calendar day, so a
--                           chart of the past is a read rather than a replay.
--   investment_transactions every buy, sell, transfer, dividend and staking
--                           receipt, idempotent on the provider's own natural
--                           key. 01 §5.5: there is no
--                           `/investments/transactions/sync`, so this arrives
--                           by date window and upsert, never by cursor.
--   cost_basis_lots         what we *computed* from those transactions: an open
--                           tax lot with a remaining quantity, a basis, and the
--                           two dates a holding period actually needs.
--   basis_method_elections  which lot a sale consumes. Per account × security,
--                           because that is the granularity the election has.
--
-- The line that matters runs between `holdings` and `cost_basis_lots`. A
-- provider's cost basis is an assertion we store and may not overwrite when the
-- user corrects it (`cost_basis_is_user_supplied`, 04 §5.5); a lot is *our*
-- arithmetic over transactions, reproducible from them, and rebuildable by
-- replaying the consumer from `seq = 0`. Mixing the two would make a re-sync
-- able to silently rewrite a realised gain.
--
-- ---------------------------------------------------------------------------
-- An unknown basis is NULL. It is never 0. (04 §5.5, 07 §6.2)
-- ---------------------------------------------------------------------------
--
-- 04 §5.5: "Where basis is unknown, report unrealized gain as *unavailable*
-- rather than computing it from a zero basis." 07 §6.2 says the same for crypto
-- and adds the reason: an ACATS transfer, a hardware-wallet receive and (per
-- the measured R6 verdict) every Coinbase movement that is not an Advanced
-- Trade fill arrive with no basis at all. A zero there is not conservative, it
-- is a fabricated 100%-gain that flows into allocation, into the tax estimate
-- and onto the screen.
--
-- So `cost_basis_lots.basis_minor` is **nullable**, and two CHECKs make the
-- nullability mean something rather than merely permit it:
--
--   * `cost_basis_lots_unknown_basis_is_declared_estimated` — a lot with no
--     number must say so: `basis_source = 'ESTIMATED'`. A `BROKER` lot with a
--     NULL basis is not storable, because a broker that reported nothing did
--     not report zero.
--   * `cost_basis_lots_estimated_basis_carries_a_warning` — an `ESTIMATED` lot
--     must carry `basis_warning`, the string the UI is obliged to show. 07 §6.2:
--     "a visible warning ... never silently assume zero". A warning column that
--     could be NULL is a warning nobody has to write.
--
-- `basis_minor >= 0` is checked; a negative basis is not a thing. And note what
-- is *not* checked: `basis_minor <> 0`. A genuinely free lot exists — an airdrop
-- with a $0.00 FMV at receipt — and the difference between "zero, measured" and
-- "unknown" is exactly what `basis_source` and the NULL are for.
--
-- ---------------------------------------------------------------------------
-- `holding_period_start_date` is not `open_date`
-- ---------------------------------------------------------------------------
--
-- 07 §4.4, verbatim: "separate from open_date: wash sales tack on the prior
-- holding period". §1091 disallows the loss on a sale whose replacement was
-- bought inside the 61-day window, adds the disallowed loss to the replacement
-- lot's basis, and **tacks the sold lot's holding period onto the replacement**.
-- So a lot opened yesterday can be long-term today, and a single `open_date`
-- cannot express it. One column cannot be made to mean two things, so there are
-- two, and `cost_basis_lots_holding_period_starts_no_later_than_open` states the
-- only direction tacking can move it: earlier, never later.
--
-- The same pair is what makes `wash_sale_adjustment_minor` auditable. It is a
-- separate column rather than a silent addition to `basis_minor` so that "what
-- did we add, and why" survives; `basis_minor` carries the adjusted figure
-- because that is the number the arithmetic must use, and the adjustment column
-- carries the delta because that is the number a human checks.
--
-- ---------------------------------------------------------------------------
-- Per-wallet basis: `account_id` is the Rev. Proc. 2024-28 boundary
-- ---------------------------------------------------------------------------
--
-- Rev. Proc. 2024-28 ended universal cost-basis tracking for digital assets on
-- 2025-01-01: basis is tracked per wallet or account. A `cost_basis_lots` row
-- therefore carries `account_id` NOT NULL and every match is scoped to it —
-- FIFO across two wallets is simply the wrong answer, not a rounding
-- difference. A watch-only wallet (0016, WP 3.6) is an account like any other,
-- which is why there is no second `wallet_id` column: two columns meaning "the
-- basis scope" is how half the queries end up using the wrong one.
--
-- `SAFE_HARBOR_ALLOC` is in `basis_source` for the same section: the safe
-- harbour for allocating previously-universal basis to specific wallets is a
-- *provenance*, and recording it as `USER` would lose the one fact that makes
-- the allocation defensible.
--
-- ---------------------------------------------------------------------------
-- AVERAGE_COST is sticky, and the stickiness is enforced here
-- ---------------------------------------------------------------------------
--
-- 07 §4.4: AVERAGE_COST is "mutual funds only; once elected, it's sticky per
-- security per account". The IRS rule is a revocation requirement, not a
-- preference, and a UI that merely hides the dropdown is a control that lives
-- in one place and is bypassed by every other write path.
--
-- So `basis_method_elections_average_cost_is_sticky()` is a BEFORE UPDATE
-- trigger that raises `23514` with that constraint name. It is deliberately
-- **not** a BEFORE DELETE trigger: `user_id` cascades from `users`, and a
-- delete trigger would make deleting an account holder fail. The consequence is
-- stated rather than hidden — a DELETE + INSERT bypasses stickiness, and
-- nothing in the application deletes an election.
--
-- ---------------------------------------------------------------------------
-- No float, anywhere
-- ---------------------------------------------------------------------------
--
-- Decision D3 and docs/CONVENTIONS.md "Money". Every column here is one of
-- three shapes and there is no fourth:
--
--   * a quantity   → NUMERIC(38,18), read back as a decimal *string*. This is
--                    where `0.00000001 BTC` either survives or does not.
--   * money        → BIGINT minor units + a CHAR(3) currency beside it.
--   * a unit price → NUMERIC(20,10). Prices have sub-cent precision, so they
--                    are not minor units; `@core/db`'s `rateColumn` is this.
--
-- `packages/db/test/migrate.test.ts` bans REAL/DOUBLE PRECISION/FLOAT/MONEY
-- across every migration, and `src/quantity.test.ts` plus
-- `test/db/quantity.test.ts` carry the satoshi round trip at both ends of the
-- boundary.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does not do
-- ---------------------------------------------------------------------------
--
-- No foreign key into another context's schema. `account_id` is an opaque UUID
-- exactly as `recurring_series.merchant_id` is (0010) and as
-- `securities`-adjacent tables were promised to be in 0013's header: this
-- context cannot reference a table `@ctx/ledger` owns, so "the lot engine never
-- creates an account" is structural rather than a habit. `security_id` *is* a
-- foreign key, because `securities` is this context's own table.
--
-- No `prices` and no `fx_rates`: those are 0015 (WP 3.4), and a lot's market
-- value is therefore not computable from this schema alone — which is correct.
-- An unrealised gain needs a price, a price has a source and a staleness, and
-- pretending otherwise is how a stale quote becomes a fact.

-- ---------------------------------------------------------------------------
-- holdings
-- ---------------------------------------------------------------------------

CREATE TABLE holdings (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Opaque. `@ctx/ledger` owns `accounts`; see the header.
  account_id                  UUID        NOT NULL,
  security_id                 UUID        NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  -- Signed: a short position is negative. NUMERIC(38,18) so an 18-decimal
  -- token and a satoshi both survive.
  quantity                    NUMERIC(38,18) NOT NULL,

  -- What the institution says the position is worth. An assertion, timestamped
  -- by `as_of_date`, never a number we computed from a price.
  institution_value_minor     BIGINT      NOT NULL,
  currency                    CHAR(3)     NOT NULL,

  -- NULL means the provider did not report a basis. See the header: it is not
  -- zero, and every consumer must render `unavailable`.
  cost_basis_minor            BIGINT      CHECK (cost_basis_minor IS NULL OR cost_basis_minor >= 0),
  cost_basis_per_unit         NUMERIC(20,10) CHECK (cost_basis_per_unit IS NULL
                                                    OR cost_basis_per_unit >= 0),
  -- 04 §5.5: "HOLDING.cost_basis_is_user_supplied exists so user corrections
  -- are never overwritten by a sync" — the §2.2 overlay principle, applied to
  -- one column rather than to a whole table because that is the only column a
  -- user corrects here.
  cost_basis_is_user_supplied BOOLEAN     NOT NULL DEFAULT FALSE,
  cost_basis_source           TEXT        CHECK (cost_basis_source IS NULL OR cost_basis_source IN (
                                            'BROKER', 'IMPORTED', 'USER', 'ESTIMATED',
                                            'SAFE_HARBOR_ALLOC')),

  as_of_date                  DATE        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A user-supplied basis is a number the user actually supplied.
  CONSTRAINT holdings_user_supplied_basis_has_a_value CHECK (
    NOT cost_basis_is_user_supplied OR cost_basis_minor IS NOT NULL
  ),
  CONSTRAINT holdings_user_supplied_basis_says_so CHECK (
    NOT cost_basis_is_user_supplied OR cost_basis_source = 'USER'
  )
);

-- One position per account × security. This is what makes a re-sync an UPDATE
-- rather than a second row, and it is the conflict target the consumer's
-- upsert names.
CREATE UNIQUE INDEX holdings_user_account_security_idx
  ON holdings (user_id, account_id, security_id);
CREATE INDEX holdings_user_security_idx ON holdings (user_id, security_id);

COMMENT ON TABLE holdings IS
  'What the institution says is held right now, per account x security. A provider assertion with an as_of date, never a number derived from a price.';
COMMENT ON COLUMN holdings.cost_basis_minor IS
  'NULL means the provider reported no basis. Not zero: 04 §5.5 requires unrealized gain to read unavailable rather than gain-from-zero.';
COMMENT ON COLUMN holdings.cost_basis_is_user_supplied IS
  'The user corrected the basis. A sync may never overwrite the row when this is true (04 §5.5).';

-- ---------------------------------------------------------------------------
-- holdings_snapshots
-- ---------------------------------------------------------------------------
--
-- The same assertion, one row per calendar day, so WP 3.3's allocation history
-- and WP 3.8's net-worth series are reads rather than replays. Append-mostly:
-- a second sync on the same day overwrites that day's row (the institution
-- revised its own number), and a day that has passed is never rewritten by a
-- later day's sync because the conflict target includes the date.

CREATE TABLE holdings_snapshots (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id              UUID        NOT NULL,
  security_id             UUID        NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  as_of_date              DATE        NOT NULL,
  quantity                NUMERIC(38,18) NOT NULL,
  institution_value_minor BIGINT      NOT NULL,
  currency                CHAR(3)     NOT NULL,
  cost_basis_minor        BIGINT      CHECK (cost_basis_minor IS NULL OR cost_basis_minor >= 0),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX holdings_snapshots_day_idx
  ON holdings_snapshots (user_id, account_id, security_id, as_of_date);
CREATE INDEX holdings_snapshots_user_date_idx ON holdings_snapshots (user_id, as_of_date);

COMMENT ON TABLE holdings_snapshots IS
  'One holdings assertion per calendar day, so a past allocation is a read rather than a replay.';

-- ---------------------------------------------------------------------------
-- investment_transactions
-- ---------------------------------------------------------------------------
--
-- Idempotent on the provider's natural key, per account. 01 §5.5 records that
-- there is no `/investments/transactions/sync` endpoint: these arrive by date
-- window, the same window is re-fetched on the next run, and the upsert is what
-- makes that harmless. A cursor column here would be a lie the connector port
-- has already refused to tell (`syncInvestmentTransactions` returns an array,
-- not a page).
--
-- `type` is the *house* vocabulary, not the provider's. Plaid says `buy`,
-- Coinbase says `BUY` on a fill and nothing at all for a staking reward (the
-- R6 verdict), and a CSV says `Staking Income`. Normalising at the adapter
-- boundary is the same rule the house sign convention follows, and the reason
-- the lot engine can be one engine.

CREATE TABLE investment_transactions (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id              UUID        NOT NULL,
  -- NULL is legitimate and common: a cash sweep, an account fee and a deposit
  -- are all investment transactions with no security behind them.
  security_id             UUID        REFERENCES securities (id) ON DELETE SET NULL,

  -- The natural key. `provider` is part of it because two providers' opaque ids
  -- share a namespace only by accident.
  provider                TEXT        NOT NULL CHECK (length(btrim(provider)) > 0),
  provider_transaction_id TEXT        NOT NULL CHECK (length(btrim(provider_transaction_id)) > 0),

  type                    TEXT        NOT NULL CHECK (type IN (
                                        'BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT',
                                        'DIVIDEND', 'REINVESTED_DIVIDEND', 'INTEREST',
                                        'STAKING_REWARD', 'AIRDROP', 'MINING', 'FORK',
                                        'GIFT_IN', 'FEE', 'CASH', 'SPLIT', 'OTHER')),
  -- The provider's own word, kept verbatim. Evidence for a mapping review; the
  -- engine never switches on it.
  subtype                 TEXT,
  name                    TEXT,

  -- Signed, as the provider reports it: negative on a disposal.
  quantity                NUMERIC(38,18) NOT NULL,
  -- Unit price. NULL for a transaction with no security (a deposit has no
  -- price) and for a transfer in kind whose price nobody stated.
  price                   NUMERIC(20,10) CHECK (price IS NULL OR price >= 0),
  -- House sign convention: negative = money left the account.
  amount_minor            BIGINT      NOT NULL,
  fees_minor              BIGINT      NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),
  currency                CHAR(3)     NOT NULL,

  trade_date              DATE        NOT NULL,
  settle_date             DATE,

  -- Where this row came from, which is what decides whether a lot it opens is
  -- BROKER or IMPORTED. The R6 verdict makes both real on the same account:
  -- an Advanced Trade fill is exact, and the deposit beside it comes from the
  -- CSV export.
  source                  TEXT        NOT NULL CHECK (source IN ('BROKER', 'IMPORTED', 'USER')),
  -- `investmentTransactionFingerprintOf(...)`, for the CSV/manual paths where
  -- the "provider id" is one we derived. Evidence, never the key.
  fingerprint             TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT investment_transactions_settles_after_trade CHECK (
    settle_date IS NULL OR settle_date >= trade_date
  ),
  -- A buy or a sell is *about* a security. A row that claims one without
  -- naming it cannot open or close a lot, and storing it would produce a
  -- holding nobody can attribute.
  CONSTRAINT investment_transactions_trades_name_a_security CHECK (
    type NOT IN ('BUY', 'SELL', 'REINVESTED_DIVIDEND') OR security_id IS NOT NULL
  )
);

-- The idempotency key, and the reason a re-fetched date window is harmless.
CREATE UNIQUE INDEX investment_transactions_provider_key_idx
  ON investment_transactions (user_id, account_id, provider, provider_transaction_id);
CREATE INDEX investment_transactions_user_security_date_idx
  ON investment_transactions (user_id, security_id, trade_date);
CREATE INDEX investment_transactions_user_account_date_idx
  ON investment_transactions (user_id, account_id, trade_date);

COMMENT ON TABLE investment_transactions IS
  'Every investment movement, idempotent on the provider natural key per account. There is no sync cursor (01 §5.5): a date window plus this upsert.';
COMMENT ON COLUMN investment_transactions.type IS
  'The house vocabulary, normalised at the adapter boundary. subtype keeps the provider''s own word as evidence.';
COMMENT ON COLUMN investment_transactions.source IS
  'BROKER = the provider reported it exactly; IMPORTED = a CSV export (the R6 fallback); USER = hand-entered.';

-- ---------------------------------------------------------------------------
-- cost_basis_lots
-- ---------------------------------------------------------------------------

CREATE TABLE cost_basis_lots (
  id                         UUID        PRIMARY KEY,
  user_id                    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The basis scope. Rev. Proc. 2024-28: per wallet or account, never
  -- universal. A watch-only wallet is an account here.
  account_id                 UUID        NOT NULL,
  security_id                UUID        NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  open_date                  DATE        NOT NULL,
  -- Earlier than `open_date` when a wash sale tacked the replaced lot's period
  -- on. Never later. See the header.
  holding_period_start_date  DATE        NOT NULL,

  quantity                   NUMERIC(38,18) NOT NULL CHECK (quantity > 0),
  quantity_remaining         NUMERIC(38,18) NOT NULL CHECK (quantity_remaining >= 0),

  -- NULL = unknown. Never 0-meaning-unknown. See the header and the two CHECKs
  -- below.
  basis_minor                BIGINT      CHECK (basis_minor IS NULL OR basis_minor >= 0),
  -- What has already been taken out of `basis_minor` by disposals, so that
  -- (consumed + remaining) = basis_minor exactly, with no rounding drift across
  -- a long chain of partial sales.
  basis_consumed_minor       BIGINT      NOT NULL DEFAULT 0 CHECK (basis_consumed_minor >= 0),
  currency                   CHAR(3)     NOT NULL,

  basis_source               TEXT        NOT NULL CHECK (basis_source IN (
                                           'BROKER', 'IMPORTED', 'USER', 'ESTIMATED',
                                           'SAFE_HARBOR_ALLOC')),
  acquisition_type           TEXT        NOT NULL CHECK (acquisition_type IN (
                                           'BUY', 'REINVESTED_DIVIDEND', 'TRANSFER_IN',
                                           'STAKING', 'AIRDROP', 'MINING', 'FORK', 'GIFT',
                                           'SPLIT')),
  -- The string the UI is obliged to show. Mandatory on an ESTIMATED lot.
  basis_warning              TEXT,

  -- The §1091 loss added to this lot's basis, kept separately so the
  -- adjustment is auditable and `basis_minor` stays the number the arithmetic
  -- uses. Always >= 0: a wash sale only ever raises a replacement's basis.
  wash_sale_adjustment_minor BIGINT      NOT NULL DEFAULT 0
                                         CHECK (wash_sale_adjustment_minor >= 0),

  -- Opaque links back to what opened the lot. Never foreign keys: the first
  -- points at this context's own table but the lot must survive a provider
  -- re-sync that replaced the row, and the second is a chain identifier.
  opened_by_transaction_id   UUID,
  source_txn_hash            TEXT,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 'quantity_remaining is never negative', as a property of Postgres and not
  -- only of the matcher: the CHECK above bounds it below, this one above.
  CONSTRAINT cost_basis_lots_remaining_within_quantity CHECK (
    quantity_remaining <= quantity
  ),
  CONSTRAINT cost_basis_lots_holding_period_starts_no_later_than_open CHECK (
    holding_period_start_date <= open_date
  ),
  -- A lot with no number must say it has no number. A BROKER lot with a NULL
  -- basis is unstorable, because a broker that reported nothing did not report
  -- zero.
  CONSTRAINT cost_basis_lots_unknown_basis_is_declared_estimated CHECK (
    basis_minor IS NOT NULL OR basis_source = 'ESTIMATED'
  ),
  -- 07 §6.2's "visible warning". A nullable warning is a warning nobody has to
  -- write.
  CONSTRAINT cost_basis_lots_estimated_basis_carries_a_warning CHECK (
    basis_source <> 'ESTIMATED' OR length(btrim(coalesce(basis_warning, ''))) > 0
  ),
  CONSTRAINT cost_basis_lots_consumed_within_basis CHECK (
    basis_minor IS NULL OR basis_consumed_minor <= basis_minor
  ),
  -- A wash-sale adjustment is an addition to a basis. There is no basis to add
  -- it to when the basis is unknown, and recording one anyway would turn an
  -- `unavailable` into a number.
  CONSTRAINT cost_basis_lots_wash_adjustment_needs_a_basis CHECK (
    wash_sale_adjustment_minor = 0 OR basis_minor IS NOT NULL
  )
);

-- The matcher's query: open lots for one basis scope, oldest first.
CREATE INDEX cost_basis_lots_open_idx
  ON cost_basis_lots (user_id, account_id, security_id, open_date)
  WHERE quantity_remaining > 0;
-- The wash-sale scan, which is deliberately **not** scoped to an account:
-- 07 §4.4, "scan across all accounts including IRAs — that's the trap most
-- software misses."
CREATE INDEX cost_basis_lots_user_security_open_date_idx
  ON cost_basis_lots (user_id, security_id, open_date);

COMMENT ON TABLE cost_basis_lots IS
  'One open tax lot, scoped to an account (Rev. Proc. 2024-28 per-wallet basis). Our arithmetic over investment_transactions, rebuildable by replaying the consumer from seq 0.';
COMMENT ON COLUMN cost_basis_lots.basis_minor IS
  'NULL means unknown, and basis_source is then ESTIMATED with a basis_warning. Never 0-meaning-unknown: a measured $0.00 airdrop is a different fact.';
COMMENT ON COLUMN cost_basis_lots.holding_period_start_date IS
  'Where the holding period actually starts. Earlier than open_date after a wash sale tacked the replaced lot''s period on (07 §4.4, IRC §1091).';
COMMENT ON COLUMN cost_basis_lots.wash_sale_adjustment_minor IS
  'The disallowed loss added into basis_minor. Kept separately so the adjustment is auditable rather than folded away.';

-- ---------------------------------------------------------------------------
-- basis_method_elections
-- ---------------------------------------------------------------------------

CREATE TABLE basis_method_elections (
  id                  UUID        PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id          UUID        NOT NULL,
  security_id         UUID        NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  method              TEXT        NOT NULL CHECK (method IN (
                                    'FIFO', 'LIFO', 'HIFO', 'SPECIFIC_ID', 'AVERAGE_COST')),
  -- The date the election takes effect, which a tax return may need to cite.
  elected_on          DATE        NOT NULL,
  elected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX basis_method_elections_scope_idx
  ON basis_method_elections (user_id, account_id, security_id);

COMMENT ON TABLE basis_method_elections IS
  'Which lot a sale consumes, per account x security. FIFO is the default and is not stored: an absent row means FIFO, which is also the IRS default.';

-- 07 §4.4: AVERAGE_COST, "once elected, it's sticky per security per account".
-- Enforced here rather than in the UI so every write path is covered. BEFORE
-- UPDATE only — see the header for why a DELETE trigger would break the
-- `users` cascade.
CREATE FUNCTION basis_method_elections_average_cost_is_sticky()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.method = 'AVERAGE_COST' AND NEW.method <> 'AVERAGE_COST' THEN
    RAISE EXCEPTION
      'AVERAGE_COST is sticky for this account and security once elected (07 §4.4)'
      USING ERRCODE = '23514',
            CONSTRAINT = 'basis_method_elections_average_cost_is_sticky';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER basis_method_elections_average_cost_is_sticky
  BEFORE UPDATE ON basis_method_elections
  FOR EACH ROW
  EXECUTE FUNCTION basis_method_elections_average_cost_is_sticky();
