-- SPDX-License-Identifier: MIT
-- 0013_securities: the securities master, the identifier ledger behind it, and
--                   the user's overlay on top of it (WP 3.1, 08 §1.3 #7 and
--                   §2.5, 04 §3.2, 07 §4.3, decisions D3, D8 and D25).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- What this schema is
-- ---------------------------------------------------------------------------
--
-- 08 §1.3 #7 states the problem in one sentence: "Coinbase says `ETH`, Plaid
-- says `ETHEREUM`, a wallet says a contract address, a brokerage says a CUSIP.
-- One resolver, one `securities` table, everything else references
-- `security_id`." Three tables, and the split between them is the design:
--
--   securities            one real-world asset. The thing a holding, a lot, a
--                         price and an allocation weight all point at.
--   security_identifiers  every name anybody has ever called it, with who said
--                         so and how much that is worth. Append-mostly; this is
--                         the evidence, not the entity.
--   security_overlay      what the user says, when the provider's metadata is
--                         junk. 04 §2.2's immutable-facts + mutable-overlay
--                         principle, applied to securities exactly as 04 §3.2
--                         asks: "treated as *low-confidence provider metadata*
--                         with a user overlay ... make it editable and remember
--                         the edit."
--
-- `sedol` is deliberately absent from all three. 01 §5.5 records that Plaid
-- removed it in 2026; modelling a column no provider fills is how a resolver
-- grows a tier that can never hit.
--
-- ---------------------------------------------------------------------------
-- A provider's own id is evidence. It is never identity. (D25, applied here)
-- ---------------------------------------------------------------------------
--
-- D25 made a `merchants` row mean "a payee was involved" and nothing else. The
-- same shape applies to a `securities` row: it must mean "an asset the outside
-- world has a real name for", never "a provider mentioned something".
--
-- A Plaid `security_id`, a Coinbase `product_id` and a brokerage's internal
-- symbol are stable within one provider and meaningless across two. Accepting
-- one as identity would mint a row per provider for the same asset, and every
-- number downstream — allocation, concentration, TWR — would double-count it.
-- So a proprietary identifier is stored (it is genuinely useful: the *second*
-- time that provider mentions the same opaque id, it finds the row) but it may
-- never be the reason a row exists.
--
-- That claim is structural here, not a convention in TypeScript:
--
--   * `securities.identity_kind` is CHECKed against a list that **does not
--     contain `proprietary`**. A row whose only name is a provider's own id
--     cannot be inserted at all; the resolver must abstain, emit
--     `investments.SecurityResolutionFailed`, and mint nothing.
--   * `security_identifiers` has a UNIQUE (user_id, identifier_key), so one
--     name can point at exactly one security. Two providers that agree on an
--     ISIN therefore *cannot* end up with two rows — the second insert is a
--     23505 and the resolver's lookup found the first row before it tried.
--   * `security_identifiers_proprietary_names_its_issuer` CHECK: a proprietary
--     identifier must carry the `provider` that issued it. An unattributed
--     opaque string is not evidence of anything.
--
-- The sabotage that proves it is in `src/identifiers.test.ts` ('a provider
-- identifier never becomes the identity'), and its database half is in
-- `test/db/securities.test.ts`, which tries the insert and reads the CHECK's
-- name back out of the error.
--
-- ---------------------------------------------------------------------------
-- `identifier_key`, and why the resolver's tiers are not stored as an ORDER BY
-- ---------------------------------------------------------------------------
--
-- `identifier_key` is the canonical serialisation of one identifier —
-- `kind U+001F value U+001F chain U+001F mic U+001F provider` with case folded
-- per part — computed in TypeScript (`securityIdentifierKeyOf`) and written
-- here. It is a stored column rather than a GENERATED expression because the
-- folding rules are domain rules, not string rules: a contract address is
-- case-insensitive (checksummed from one wallet, lowercased from another, the
-- same address either way) while a ticker's punctuation is *not* noise
-- (`BRK.B` and `BRK-B` are different venues' spellings and normalising them
-- together would merge two securities). Encoding that in a Postgres expression
-- would put half the merge rule in SQL and half in TypeScript.
--
-- Strength ordering (FIGI > ISIN > CUSIP > ticker+MIC > chain+contract >
-- proprietary) is likewise *not* in the schema. It is a domain rule with
-- reasons — a FIGI is globally unique and permanent, an ISIN cannot separate
-- dual listings, a bare ticker is not an identity at all — and it lives in
-- `src/identifiers.ts` beside those reasons, pinned by a test. What the schema
-- holds is the *consequence*: whichever name won is denormalised onto
-- `securities.identity_kind` / `identity_key`, and it is unique per user.
--
-- ---------------------------------------------------------------------------
-- No float, anywhere
-- ---------------------------------------------------------------------------
--
-- Decision D3 and docs/CONVENTIONS.md "Money". No monetary column appears in
-- this migration at all — a security has no amount; holdings (0014) and prices
-- (0015) are where money and quantity arrive. The two numeric columns here are
-- an expense ratio and a confidence, both unit-interval scores, both
-- `NUMERIC(9,6)` / `NUMERIC(5,4)` rather than `REAL`, because
-- `packages/db/test/migrate.test.ts` bans every float type across the schema
-- and a ratio loses nothing by being exact. A 0.03% expense ratio is 0.000300
-- and reads back as the string '0.000300'.
--
-- Every instant is `TIMESTAMPTZ`. No `DATE` column appears yet; a security has
-- no business date of its own.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does not do
-- ---------------------------------------------------------------------------
--
-- No foreign key into another context's schema, in either direction. A holding
-- will carry `account_id` as an opaque UUID (0014) for the same reason
-- `recurring_series.merchant_id` does (0010): `@ctx/investments` cannot
-- reference a table it does not own, so "resolution never creates an account"
-- is a structural fact rather than a habit.
--
-- No `prices`, no `fx_rates`, no `holdings`. Those are 0014 (WP 3.2) and 0015
-- (WP 3.4) and they are claimed, not built, in this package's OWNERSHIP.md.

-- ---------------------------------------------------------------------------
-- securities
-- ---------------------------------------------------------------------------

CREATE TABLE securities (
  id                     UUID        PRIMARY KEY,
  user_id                UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The name this row exists *because of*: the strongest identifier the
  -- resolver had when it created the row, upgraded in place if a stronger one
  -- later arrives (a FIGI turning up for a row first seen as a CUSIP).
  --
  -- `proprietary` is absent from this list on purpose and the absence is the
  -- control. See the header.
  identity_kind          TEXT        NOT NULL CHECK (identity_kind IN (
                                       'figi', 'isin', 'cusip', 'ticker', 'chain_contract')),
  identity_key           TEXT        NOT NULL CHECK (length(btrim(identity_key)) > 0),

  -- Denormalised copies of the identifiers, for the queries that want to read
  -- a symbol without a join. `security_identifiers` is the record; these are a
  -- projection of it and the resolver rewrites them on every upgrade.
  ticker                 TEXT,
  mic                    TEXT,
  cusip                  TEXT,
  isin                   TEXT,
  figi                   TEXT,
  -- Crypto. `contract = 'native'` is the sentinel for a chain's own coin (ETH
  -- on ethereum, BTC on bitcoin), which has no contract address to carry. See
  -- `NATIVE_ASSETS` in src/identifiers.ts for why that sentinel exists and why
  -- WETH is deliberately *not* folded into it.
  chain                  TEXT,
  contract               TEXT,

  name                   TEXT,
  type                   TEXT        NOT NULL CHECK (type IN (
                                       'equity', 'etf', 'mutual_fund', 'crypto',
                                       'bond', 'cash', 'other')),
  currency               CHAR(3),
  expense_ratio          NUMERIC(9,6) CHECK (expense_ratio IS NULL
                                             OR (expense_ratio >= 0 AND expense_ratio < 1)),
  is_cash_equivalent     BOOLEAN     NOT NULL DEFAULT FALSE,

  -- 07 §4.3's taxonomy, kept small exactly as that section asks.
  asset_class            TEXT        NOT NULL DEFAULT 'UNCLASSIFIED' CHECK (asset_class IN (
                                       'US_EQUITY', 'INTL_DEV_EQUITY', 'EM_EQUITY', 'US_BOND',
                                       'INTL_BOND', 'TIPS', 'REAL_ESTATE', 'COMMODITY',
                                       'CRYPTO', 'CASH', 'OTHER', 'UNCLASSIFIED')),
  region                 TEXT        NOT NULL DEFAULT 'UNKNOWN' CHECK (region IN (
                                       'US', 'DEV_EX_US', 'EM', 'GLOBAL', 'UNKNOWN')),
  sector                 TEXT        NOT NULL DEFAULT 'UNKNOWN',

  -- 07 §4.3, normative: "always record `classification_source`". NOT NULL with
  -- no default that could mean "nobody looked" — `UNCLASSIFIED` is a positive
  -- statement that the waterfall ran and fell through every rung.
  classification_source  TEXT        NOT NULL CHECK (classification_source IN (
                                       'USER_OVERRIDE', 'LOCAL_SEED_TABLE', 'SEC_EDGAR',
                                       'ISSUER_HOLDINGS', 'NAME_HEURISTIC', 'SIC_SECTOR_MAP',
                                       'PROVIDER', 'UNCLASSIFIED')),
  classified_at          TIMESTAMPTZ,
  -- Fund-of-funds look-through: how deep the recursion went, capped at 3 by
  -- 07 §4.3 ("recursive resolution with cycle detection and a depth cap (3)").
  classification_depth   SMALLINT    NOT NULL DEFAULT 0
                                     CHECK (classification_depth BETWEEN 0 AND 3),
  -- |Σ classified weights − 1|. 07 §4.3: "Flag funds where this exceeds 5%" —
  -- a derivatives overlay reports market value, not notional, so the weights
  -- genuinely do not add up and the honest answer is to say so.
  classification_residual NUMERIC(9,6) CHECK (classification_residual IS NULL
                                              OR classification_residual >= 0),
  classification_flagged BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Set when two rows turn out to be one asset (a FIGI arrives that matches a
  -- row created from a CUSIP). The loser keeps its id forever so that anything
  -- already pointing at it can be followed forward rather than broken.
  merged_into_id         UUID        REFERENCES securities (id),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT securities_contract_needs_a_chain CHECK (contract IS NULL OR chain IS NOT NULL),
  CONSTRAINT securities_crypto_names_its_chain CHECK (type <> 'crypto' OR chain IS NOT NULL),
  CONSTRAINT securities_merge_is_not_a_self_loop CHECK (merged_into_id IS NULL
                                                        OR merged_into_id <> id),
  CONSTRAINT securities_flagged_has_a_residual CHECK (NOT classification_flagged
                                                      OR classification_residual IS NOT NULL)
);

-- One identity, one row, per user. The other half of "an unmapped security
-- never silently becomes two securities" (the Phase 3 gate's never-list).
CREATE UNIQUE INDEX securities_user_identity_idx ON securities (user_id, identity_key);
CREATE INDEX securities_user_ticker_idx ON securities (user_id, ticker) WHERE ticker IS NOT NULL;
CREATE INDEX securities_user_live_idx ON securities (user_id) WHERE merged_into_id IS NULL;

COMMENT ON TABLE securities IS
  'One asset, as the world outside this system names it. A row exists only because something out there named it: identity_kind cannot be proprietary, so a provider''s own opaque id can never mint one.';
COMMENT ON COLUMN securities.identity_key IS
  'The canonical key of the strongest identifier this row is known by. Unique per user; upgraded in place when a stronger name arrives.';
COMMENT ON COLUMN securities.classification_source IS
  '07 §4.3''s waterfall rung that produced asset_class/region/sector. UNCLASSIFIED means the waterfall ran and fell through, not that nobody looked.';

-- ---------------------------------------------------------------------------
-- security_identifiers
-- ---------------------------------------------------------------------------

CREATE TABLE security_identifiers (
  id              UUID        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  security_id     UUID        NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  kind            TEXT        NOT NULL CHECK (kind IN (
                                'figi', 'isin', 'cusip', 'ticker',
                                'chain_contract', 'proprietary')),
  value           TEXT        NOT NULL CHECK (length(btrim(value)) > 0),
  -- `chain_contract` only: ethereum, bitcoin, solana. NULL otherwise.
  chain           TEXT,
  -- `ticker` only: the ISO-10383 MIC. NULL when the provider gave an
  -- unqualified ticker — which is exactly the case the resolver refuses to
  -- treat as an identity, because `BHP` is three different securities.
  mic             TEXT,
  -- The canonical serialisation. See the header for why it is written rather
  -- than generated.
  identifier_key  TEXT        NOT NULL CHECK (length(btrim(identifier_key)) > 0),

  -- Who said so. NULL means we derived it ourselves — from OpenFIGI, from the
  -- in-repo seed table, or from the native-asset canonicalisation.
  provider        TEXT,
  confidence      NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT security_identifiers_chain_is_for_contracts CHECK (
    (kind = 'chain_contract') = (chain IS NOT NULL)
  ),
  CONSTRAINT security_identifiers_mic_is_for_tickers CHECK (
    mic IS NULL OR kind = 'ticker'
  ),
  -- An unattributed opaque string is not evidence of anything: a proprietary
  -- identifier must name the provider whose vocabulary it belongs to.
  CONSTRAINT security_identifiers_proprietary_names_its_issuer CHECK (
    kind <> 'proprietary' OR provider IS NOT NULL
  ),
  CONSTRAINT security_identifiers_seen_forward CHECK (last_seen_at >= first_seen_at)
);

-- One name, one security. This is what makes 'two identifiers for one security
-- never create two rows' a property of Postgres rather than of a code path:
-- the second insert is a 23505 even if the resolver's lookup were wrong.
CREATE UNIQUE INDEX security_identifiers_user_key_idx
  ON security_identifiers (user_id, identifier_key);
CREATE INDEX security_identifiers_security_idx
  ON security_identifiers (security_id);
-- The tier scan: the resolver reads identity-bearing names far more often than
-- it reads proprietary ones, and never mixes them in the same query.
CREATE INDEX security_identifiers_identity_idx
  ON security_identifiers (user_id, kind, value) WHERE kind <> 'proprietary';

COMMENT ON TABLE security_identifiers IS
  'Every name anybody has called a security, with who said so. Evidence, not identity: a proprietary row corroborates a security that some other name already established.';
COMMENT ON COLUMN security_identifiers.provider IS
  'The connector whose vocabulary this name belongs to. NULL means we derived it ourselves (OpenFIGI, the seed table, native-asset canonicalisation).';

-- ---------------------------------------------------------------------------
-- security_overlay
-- ---------------------------------------------------------------------------
--
-- 04 §2.2, applied to securities: provider facts are immutable and the user's
-- intent lives beside them, never on top of them. A provider re-sync rewrites
-- `securities.asset_class`; it cannot touch this table, so the override
-- survives — which is the claim `test/db/overlay.test.ts` makes ('a user
-- asset-class override survives a provider re-sync').
--
-- Sparse, and `locked_fields` is what makes it sparse: a NULL column means
-- "the user did not say", and a column named in `locked_fields` means "the
-- user said, and the waterfall may never overrule it" (07 §4.3 rung 1,
-- USER_OVERRIDE, "always wins, never re-derived").

CREATE TABLE security_overlay (
  id                 UUID        PRIMARY KEY,
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  security_id        UUID        NOT NULL REFERENCES securities (id) ON DELETE CASCADE,

  asset_class        TEXT        CHECK (asset_class IS NULL OR asset_class IN (
                                   'US_EQUITY', 'INTL_DEV_EQUITY', 'EM_EQUITY', 'US_BOND',
                                   'INTL_BOND', 'TIPS', 'REAL_ESTATE', 'COMMODITY',
                                   'CRYPTO', 'CASH', 'OTHER', 'UNCLASSIFIED')),
  region             TEXT        CHECK (region IS NULL OR region IN (
                                   'US', 'DEV_EX_US', 'EM', 'GLOBAL', 'UNKNOWN')),
  sector             TEXT,
  name               TEXT,
  expense_ratio      NUMERIC(9,6) CHECK (expense_ratio IS NULL
                                         OR (expense_ratio >= 0 AND expense_ratio < 1)),
  is_cash_equivalent BOOLEAN,
  note               TEXT,

  -- Which of the columns above the user actually set. 04 §2.2's `locked_fields`
  -- verbatim: only a locked field wins, so clearing an override is a change to
  -- this array and not a guess about whether NULL meant "no" or "not yet".
  locked_fields      TEXT[]      NOT NULL DEFAULT '{}',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT security_overlay_locked_fields_are_known CHECK (
    locked_fields <@ ARRAY['asset_class', 'region', 'sector', 'name',
                           'expense_ratio', 'is_cash_equivalent']::TEXT[]
  )
);

CREATE UNIQUE INDEX security_overlay_user_security_idx
  ON security_overlay (user_id, security_id);

COMMENT ON TABLE security_overlay IS
  'The user''s corrections to a security''s metadata (04 §3.2). A provider re-sync rewrites securities; it never writes here, which is what makes an override durable.';
