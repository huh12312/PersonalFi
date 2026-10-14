-- SPDX-License-Identifier: MIT
-- 0043_provider_credentials_market_data: market-data keys through the product,
--                                        and positions the resolver could not
--                                        identify kept visible (WP 10.4;
--                                        docs/evidence/phase-10/
--                                        wp10.4-market-data-credentials.md).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only, as every Phase 9/10 migration must be: two CHECKs re-declared
-- **wider** (a DROP and an ADD of the same name in this one transaction, the
-- shape 0029 and 0042 used, because Postgres has no ALTER for a CHECK
-- expression), one NOT NULL relaxed, two new CHECKs every existing row already
-- satisfies, three new columns on investment_transactions (one NOT NULL with a
-- constant default -- a catalogue-only change since Postgres 11, no rewrite --
-- and two nullable), and one new table. Nothing is dropped from the data,
-- renamed or narrowed; every row valid before this migration is valid after.
-- References only users (0002), provider_credentials (0041) and
-- investment_transactions (0014).
--
-- ---------------------------------------------------------------------------
-- 1. provider_credentials holds the four market-data keys
-- ---------------------------------------------------------------------------
--
-- WP 10.1 built this table for Plaid and said a later provider is "a one-line
-- CHECK widening in a later migration, not a new table". This is that line:
-- tiingo, fred, coingecko and openfigi join plaid. Same custody (SecretBox
-- envelopes under a per-record DEK wrapped by the KEK, D5), same AAD
-- (provider_credentials | column | <user_id>.<provider>), same never-returned,
-- never-logged, never-exported treatment (the export registry already names
-- this table as a reasoned deferral).
--
-- A market-data key is one value, not a pair, and has no environment. The
-- shape chosen for it, stated so nobody has to infer it:
--
--   secret_sealed     the key's SecretBox envelope.
--   client_id_sealed  the envelope of a fixed sentinel, not empty: the column's
--                     own CHECK (length > 0) is kept, and every byte in both
--                     columns stays a SecretBox envelope, so no reader has a
--                     "this one is not sealed" branch.
--   client_id_hint    the last four characters of the key. A Plaid hint is four
--                     characters of an identifier; this is four characters of a
--                     secret, so the route refuses a key shorter than 16
--                     characters and every hint is at most a quarter of the
--                     key. The four providers' keys are 24 to 40 characters
--                     (a Tiingo token is 40 hex: 144 bits stay unknown).
--   env               NULL. Plaid's sandbox | production does not apply, and a
--                     made-up value would be one more thing to explain. The new
--                     CHECK provider_credentials_env_by_provider ties the two:
--                     a plaid row has an env, a market-data row has none.
--
-- The provider CHECK was declared inline in 0041, so Postgres named it
-- provider_credentials_provider_check; it is re-declared under that name.

ALTER TABLE provider_credentials
  DROP CONSTRAINT provider_credentials_provider_check;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
    CHECK (provider IN ('plaid', 'tiingo', 'fred', 'coingecko', 'openfigi'));

ALTER TABLE provider_credentials
  ALTER COLUMN env DROP NOT NULL;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_env_by_provider
    CHECK ((provider = 'plaid') = (env IS NOT NULL));

COMMENT ON TABLE provider_credentials IS
  'A holder''s provider API credentials: Plaid''s client id and secret, and the tiingo / fred / coingecko / openfigi market-data keys (WP 10.4). SecretBox envelopes, AAD-bound to (provider_credentials, column, user_id.provider). Never exported.';
COMMENT ON COLUMN provider_credentials.client_id_sealed IS
  'SecretBox envelope of the provider client id (Plaid), or of a fixed sentinel for a single-value market-data key. Never plaintext.';
COMMENT ON COLUMN provider_credentials.secret_sealed IS
  'SecretBox envelope of the provider API secret or market-data key. Never plaintext, never logged, never returned by any route.';
COMMENT ON COLUMN provider_credentials.client_id_hint IS
  'Last four characters of the Plaid client id, or of a market-data key at least 16 characters long, plaintext, for display only.';
COMMENT ON COLUMN provider_credentials.env IS
  'Plaid environment (sandbox | production). NULL for a market-data key, which has none (provider_credentials_env_by_provider).';

-- ---------------------------------------------------------------------------
-- 2. investment_transactions keeps a movement whose security is unidentified
-- ---------------------------------------------------------------------------
--
-- Until now a buy, a sell or a dividend whose security the resolver abstained
-- on was dropped before it was stored, so the Activity tab could not list it.
-- It is now stored with security_id NULL and these columns carry what the
-- provider called it. security_id was already nullable (a cash sweep, a fee and
-- a deposit name no security); security_unresolved is what tells "named no
-- security" from "named one nobody could identify", so neither the lot engine
-- nor performance has to guess from a NULL.
--
--   security_unresolved     TRUE only when the provider named a security and
--                           the resolver could not identify it. Never TRUE
--                           with a security_id
--                           (investment_transactions_unresolved_has_no_security).
--   provider_security_name  the provider's name for it, verbatim, or NULL.
--   provider_ticker         the provider's ticker for it, verbatim, or NULL.
--
-- Lots ignore a NULL security_id as they always have; performance excludes an
-- unresolved row from its flows and names it, as it names an unpriced position.

ALTER TABLE investment_transactions
  ADD COLUMN security_unresolved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN provider_security_name TEXT,
  ADD COLUMN provider_ticker TEXT;

ALTER TABLE investment_transactions
  ADD CONSTRAINT investment_transactions_unresolved_has_no_security
    CHECK (NOT security_unresolved OR security_id IS NULL);

-- 0014's investment_transactions_trades_name_a_security refused a buy, a sell
-- or a reinvested dividend with no security_id, because such a row "cannot open
-- or close a lot". That stays true -- the lot engine skips a NULL security --
-- but the row is now wanted for Activity, so the CHECK is re-declared wider: a
-- trade names a security, or says it named one nobody could identify. Same
-- name, DROP + ADD in this transaction (0029/0042's shape); every row valid
-- before is valid after (security_unresolved is FALSE on all of them).
ALTER TABLE investment_transactions
  DROP CONSTRAINT investment_transactions_trades_name_a_security;

ALTER TABLE investment_transactions
  ADD CONSTRAINT investment_transactions_trades_name_a_security
    CHECK (type NOT IN ('BUY', 'SELL', 'REINVESTED_DIVIDEND')
           OR security_id IS NOT NULL
           OR security_unresolved);

COMMENT ON COLUMN investment_transactions.security_unresolved IS
  'TRUE when the provider named a security the resolver could not identify (WP 10.4). The row is kept for Activity; lots and performance exclude it.';
COMMENT ON COLUMN investment_transactions.provider_security_name IS
  'The provider''s own name for the security, verbatim. Display evidence for an unresolved row.';
COMMENT ON COLUMN investment_transactions.provider_ticker IS
  'The provider''s own ticker for the security, verbatim. Display evidence for an unresolved row.';

-- ---------------------------------------------------------------------------
-- 3. unresolved_holdings: a position nobody could identify, as of its last sync
-- ---------------------------------------------------------------------------
--
-- `holdings.security_id` is NOT NULL and every reader joins `securities`, so a
-- position the resolver abstained on has never had anywhere to live; the only
-- trace was an investments.SecurityResolutionFailed event, which carries no
-- account, no quantity and no value, and which cannot be retracted (the event
-- log is append-only), so a position that later resolved stayed "failed" in it
-- forever. This table is the read model instead, and it is the choice that
-- survives a re-sync:
--
--   the lot consumer REPLACES an account's rows on every run that reported
--   holdings for that account -- delete this provider's rows for the account,
--   insert the ones this run could not identify. A security that resolves on a
--   later sync is simply not re-inserted, so its row is gone; one that still
--   fails is rewritten with today's quantity and value.
--
-- institution_value_minor is the institution's own figure, labelled as such on
-- the wire; nothing here is priced. Never part of allocation or performance;
-- named in their excluded lists.
--
-- Not exported: a derived read model, rebuilt by the next sync on a restored
-- install (a reasoned deferral in apps/api/src/reports/export/registry.ts).

CREATE TABLE unresolved_holdings (
  id                      UUID           PRIMARY KEY,
  user_id                 UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Opaque, as everywhere in this context: @ctx/ledger owns accounts.
  account_id              UUID           NOT NULL,
  provider                TEXT           NOT NULL CHECK (length(provider) > 0),
  provider_security_id    TEXT,
  name                    TEXT,
  ticker                  TEXT,
  quantity                NUMERIC(38,18) NOT NULL,
  institution_value_minor BIGINT,
  currency                CHAR(3)        NOT NULL,
  -- Every tier the resolver tried and why it abstained: [{tier, reason, detail}].
  abstentions             JSONB          NOT NULL DEFAULT '[]'::jsonb
                                         CHECK (jsonb_typeof(abstentions) = 'array'),
  -- Opaque: @ctx/connections owns sync_runs.
  sync_run_id             TEXT,
  as_of_date              DATE           NOT NULL,
  observed_at             TIMESTAMPTZ    NOT NULL,
  created_at              TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX unresolved_holdings_user_account_idx
  ON unresolved_holdings (user_id, account_id);

COMMENT ON TABLE unresolved_holdings IS
  'Positions a sync reported that the security resolver could not identify, replaced per account on every sync (WP 10.4). Display only: never valued, never in allocation or performance. Not exported.';
COMMENT ON COLUMN unresolved_holdings.institution_value_minor IS
  'The institution''s own value for the position, as reported; never computed from a price here.';
