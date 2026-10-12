-- SPDX-License-Identifier: MIT
-- 0041_provider_credentials: a holder's provider API credentials, sealed and tied
--                            to the setup (WP 10.1 "Plaid credentials through the
--                            product"; docs/plan/09-phase-9-dispatch.md §4's
--                            migration rule, docs/research/03-security-architecture.md
--                            §2.2, decision D5).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only, as every Phase 9/10 migration must be (09 §4 "Every Phase 9
-- migration is expand-only -- no contract steps on a live soak"): one new table.
-- Nothing is altered, dropped or rewritten, so `just upgrade` applies it to a
-- live production database with no contract step and no downtime beyond the
-- restart the upgrade already performs.
--
-- References only `users` (0002_identity.sql) and this file's own table. It
-- names no object a higher-numbered migration creates.
--
-- ---------------------------------------------------------------------------
-- Why a table, and why these columns
-- ---------------------------------------------------------------------------
--
-- Until now the Plaid connector registered only when the operator wrote
-- `secrets/plaid_client_id`, `plaid_secret` and `plaid_env` as files. A holder
-- who wants to add a bank from the "Add connection" menu had no way to supply
-- their own Plaid keys through the product. This table is where those keys live
-- when they come from the product rather than from the operator's files.
--
-- User-scoped (D6): one row per `(user_id, provider)`. `provider` is checked to
-- the set of providers the product can hold keys for; today only 'plaid', and a
-- later provider is a one-line CHECK widening in a later migration, not a new
-- table.
--
-- `client_id_sealed` and `secret_sealed` are `SecretBox` envelopes
-- (XChaCha20-Poly1305 under a per-record DEK wrapped by the KEK, D5) -- the
-- same custody tier as `connections.sealed_credentials`, the Plaid access token.
-- The AAD binds each ciphertext to this table, the column, and
-- `<user_id>.<provider>`, so a ciphertext lifted into another holder's row, into
-- the other column, or into `connections.sealed_credentials` does not
-- authenticate. There is no plaintext column and no path that stores a key any
-- other way.
--
-- `client_id_hint` is the last four characters of the client id, in the clear,
-- for display only ("ends in 3f9a"). A Plaid client id is an identifier, not a
-- secret, and four characters narrow nothing; the secret has no hint at all.
--
-- `env` is the Plaid environment ('sandbox' | 'production'). Plaid retired
-- 'development' (01 §1.2). Production is additionally refused at write time and
-- at use time unless PLAID_ALLOW_PRODUCTION=true (D16); that is a deployment
-- setting and cannot be a CHECK here.
--
-- `rotated_at` is NULL until the first replacement, then the time of the most
-- recent one.
--
-- Never exported. A credential never leaves the install in a bundle -- the same
-- treatment as `connections.sealed_credentials` -- and the export registry names
-- this table as a reasoned deferral (apps/api/src/reports/export/registry.ts).

CREATE TABLE provider_credentials (
  id               UUID        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('plaid')),
  client_id_sealed BYTEA       NOT NULL CHECK (length(client_id_sealed) > 0),
  secret_sealed    BYTEA       NOT NULL CHECK (length(secret_sealed) > 0),
  env              TEXT        NOT NULL CHECK (env IN ('sandbox', 'production')),
  client_id_hint   TEXT        NOT NULL CHECK (length(client_id_hint) BETWEEN 1 AND 4),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at       TIMESTAMPTZ
);

-- The natural key: setting credentials twice replaces the row, never adds one.
CREATE UNIQUE INDEX provider_credentials_user_provider_key
  ON provider_credentials (user_id, provider);

COMMENT ON TABLE provider_credentials IS
  'A holder''s provider API credentials. SecretBox envelopes, AAD-bound to (provider_credentials, column, user_id.provider). Never exported.';
COMMENT ON COLUMN provider_credentials.client_id_sealed IS
  'SecretBox envelope of the provider client id. Never plaintext.';
COMMENT ON COLUMN provider_credentials.secret_sealed IS
  'SecretBox envelope of the provider API secret. Never plaintext, never logged, never returned by any route.';
COMMENT ON COLUMN provider_credentials.client_id_hint IS
  'Last four characters of the client id, plaintext, for display only.';
