-- SPDX-License-Identifier: MIT
-- 0016_wallet_addresses: one watch-only Bitcoin xpub/ypub/zpub or Ethereum
--                        address per connection, plus BTC gap-limit scan state
--                        (Phase 3 WP 3.6; 08 §2.6, dispatch §3 "WP 3.6").
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Ownership, stated precisely because it is not this migration's own package
-- ---------------------------------------------------------------------------
--
-- `WalletRpcConnector` (`packages/connectors/walletrpc`) is a *connector
-- adapter* — per 08 §2.3 and every other adapter's own OWNERSHIP.md, "an
-- adapter never writes to the database" — so it holds no database handle and
-- cannot be this table's owner. `packages/contexts/investments/OWNERSHIP.md`
-- already claims `wallet_addresses` (written at WP 3.1, ahead of this
-- migration landing it — its own text: "`wallet_addresses` lands in 0016
-- (WP 3.6) and is still a claim"), so `scripts/check-schema-ownership.ts`
-- passes as soon as this migration exists: `@ctx/investments` is this table's
-- owner, and `packages/connectors/walletrpc/OWNERSHIP.md` states explicitly
-- that this package does not claim it, in the same shape
-- `packages/connectors/csv/OWNERSHIP.md` uses for the CSV mapping profile.
--
-- What is still carried to the orchestrator (named in
-- `docs/evidence/phase-3/wp3.6-walletrpc.md` §8, because this work package
-- owns neither `packages/contexts/investments/**` nor its schema): the actual
-- Drizzle `pgTable('wallet_addresses', …)` definition and a Postgres-backed
-- implementation of `packages/connectors/walletrpc/src/store.ts`'s
-- `WalletAddressStore` interface, which the composition root binds to this
-- connector exactly as it binds `@connector/csv`'s `DurableStore`.
--
-- ---------------------------------------------------------------------------
-- Why one table rather than `connections.config` (JSONB)
-- ---------------------------------------------------------------------------
--
-- The dispatch's own words: "per connection: chain, address or xpub
-- descriptor, derivation scheme, label, gap-limit scan state." The scan state
-- is the reason this is a table and not a JSONB blob like CSV's mapping
-- profile: `external_highest_used_index`/`internal_highest_used_index` are
-- integers a future backfill or repair job may want to query and update
-- independently of the rest of the connection row, and a CHECK constraint can
-- describe their relationship to `chain` and `derivation_scheme` in a way a
-- JSONB shape cannot enforce at the database layer.
--
-- ---------------------------------------------------------------------------
-- One row per connection
-- ---------------------------------------------------------------------------
--
-- This connector watches exactly one descriptor per connection — a user who
-- wants to watch two wallets creates two connections, exactly as Coinbase and
-- Plaid work one-connection-per-credential. `wallet_addresses_connection_idx`
-- is UNIQUE on `connection_id` to make that structural rather than a
-- convention the application layer might forget.
--
-- ---------------------------------------------------------------------------
-- No key material column exists, because none is ever accepted (08 §2.6)
-- ---------------------------------------------------------------------------
--
-- `descriptor` holds an xpub/ypub/zpub or a `0x…` address — public information
-- a block explorer would show anyone. There is no `sealed_credentials` column
-- here and no reference to `connections.sealed_credentials` either: nothing
-- this table stores is a secret, so nothing here is ever passed through
-- `SecretBox`. `WalletRpcConnector`'s own refusal seam
-- (`packages/connectors/walletrpc/src/guard.ts`) is what keeps a private key
-- from ever reaching this column in the first place; this schema's
-- contribution is simply that there is no column shaped to receive one.

CREATE TABLE wallet_addresses (
  id                            UUID        PRIMARY KEY,
  user_id                       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id                 UUID        NOT NULL REFERENCES connections (id) ON DELETE CASCADE,

  chain                         TEXT        NOT NULL CHECK (chain IN ('bitcoin', 'ethereum')),

  -- The xpub/ypub/zpub (bitcoin) or the `0x…` address (ethereum), verbatim.
  -- Public information, never a credential — see the header.
  descriptor                    TEXT        NOT NULL CHECK (length(btrim(descriptor)) > 0),

  -- NULL for ethereum: there is no derivation on that side at all (the
  -- connector watches a plain address). Bitcoin always carries one, chosen by
  -- the descriptor's own prefix.
  derivation_scheme             TEXT        CHECK (derivation_scheme IN ('bip44', 'bip49', 'bip84')),

  label                         TEXT        NOT NULL DEFAULT '',

  -- Gap-limit scan state (BIP44's own 20-address gap limit). NULL means
  -- "nothing observed yet on this chain". Bitcoin-only: an ethereum row never
  -- populates either column, because there is no chain of derived addresses
  -- to scan.
  external_highest_used_index   INTEGER     CHECK (external_highest_used_index IS NULL
                                                    OR external_highest_used_index >= 0),
  internal_highest_used_index   INTEGER     CHECK (internal_highest_used_index IS NULL
                                                    OR internal_highest_used_index >= 0),

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_addresses_bitcoin_has_a_derivation_scheme CHECK (
    (chain = 'bitcoin' AND derivation_scheme IS NOT NULL) OR
    (chain = 'ethereum' AND derivation_scheme IS NULL)
  ),
  CONSTRAINT wallet_addresses_ethereum_has_no_scan_state CHECK (
    chain = 'bitcoin' OR
    (external_highest_used_index IS NULL AND internal_highest_used_index IS NULL)
  )
);

-- One descriptor per connection — see the header.
CREATE UNIQUE INDEX wallet_addresses_connection_idx ON wallet_addresses (connection_id);
CREATE INDEX wallet_addresses_user_idx ON wallet_addresses (user_id);

COMMENT ON TABLE wallet_addresses IS
  'One watch-only Bitcoin xpub/ypub/zpub or Ethereum address per connection, plus BTC gap-limit scan state. Owner: @ctx/investments (see this file''s header). No key material column exists (08 2.6).';
COMMENT ON COLUMN wallet_addresses.descriptor IS
  'Public: an xpub/ypub/zpub or a 0x address. Never a credential; never sealed.';
COMMENT ON COLUMN wallet_addresses.external_highest_used_index IS
  'Highest external (receiving)-chain index ever observed with activity. NULL = nothing observed yet.';
COMMENT ON COLUMN wallet_addresses.internal_highest_used_index IS
  'Highest internal (change)-chain index ever observed with activity. NULL = nothing observed yet.';
