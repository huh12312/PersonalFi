-- SPDX-License-Identifier: MIT
-- 0004_ledger: the Ledger bounded context — accounts, balances, immutable
--              provider facts, the user-facing transaction row and its overlay,
--              splits, transfer links, merchants, and dedup keys.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this file
-- and refuses to start if it ever changes. Destructive changes use
-- expand -> backfill -> contract across releases.
--
-- Owner of every table below: @ctx/ledger. See that package's OWNERSHIP.md.
--
-- ---------------------------------------------------------------------------
-- The two ideas this schema exists to encode
-- ---------------------------------------------------------------------------
--
-- 1. **Immutable provider facts + mutable user overlay** (decision D11, 04 §2.2).
--    `transactions_provider` is what the provider said. It is written by sync and
--    never edited by a user. `transactions` is the stable identity a user, a
--    split, a budget and a recurring series point at; it carries a pointer at the
--    current fact, the user's overlay columns, and *denormalised effective
--    columns* so the list query is one index scan. The effective columns are a
--    projection, not a source of truth: `resolveEffective(fact, overlay)` in
--    `packages/contexts/ledger/src/effective.ts` is the only function permitted to
--    compute them, and a test asserts every stored row equals its output.
--
-- 2. **The surrogate id survives pending -> posted** (decision D10, 01 §5.2).
--    Plaid represents a pending transaction settling as a *delete plus insert*:
--    the pending `transaction_id` appears in `removed[]` and a brand-new posted
--    transaction appears in `added[]`, linked only by `pending_transaction_id`.
--    Naively that destroys the user's category, note, splits and exclusions. Here
--    the `transactions.id` never changes — only `current_fact_id` advances from
--    the pending fact to the posted one, and the old fact is stamped
--    `superseded_by_id`. This is the single highest-value invariant in the schema.
--
-- Sign convention, stated on the column as docs/CONVENTIONS.md requires:
-- **negative = outflow, positive = inflow**. Plaid uses the opposite convention;
-- every adapter normalises at the edge, never here.

-- ---------------------------------------------------------------------------
-- pg_trgm: trigram search on merchant/description text.
-- ---------------------------------------------------------------------------
--
-- Decision D2 named `pg_trgm` as one of the reasons this is Postgres and not
-- SQLite. It backs the transaction list's free-text filter, which has to match
-- "wholefds" against "WHOLEFDS MKT #10259" — a prefix index cannot, and a
-- tsvector tokenises statement-descriptor noise into garbage. `pg_trgm` is a
-- trusted extension from PG 13 on, so the database owner may create it without
-- superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- merchants: the normalised payee.
-- ---------------------------------------------------------------------------
--
-- Deliberately minimal. Ledger's job is to converge "SQ *BLUE BOTTLE 4471" and
-- "SQ *BLUE BOTTLE COFFE" onto one row so the list can group by payee and the
-- transfer/refund heuristics have a key to match on. Everything richer — logos,
-- websites, subscription-likeness, the alias corpus, the clustering pipeline —
-- belongs to @ctx/categorization (WP 1.4), which will extend this table by
-- migration rather than owning a second one.
CREATE TABLE merchants (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The canonical slug produced by `normaliseMerchantName()`. Lower case, no
  -- processor prefixes, no store numbers, no city/state tail.
  normalized_key TEXT        NOT NULL CHECK (length(normalized_key) > 0),
  display_name   TEXT        NOT NULL CHECK (length(btrim(display_name)) > 0),
  -- Provider entity ids seen for this merchant (Plaid `counterparties[].entity_id`,
  -- which is stable across descriptor noise and is a far better key than the text).
  provider_entity_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX merchants_user_key_idx ON merchants (user_id, normalized_key);
CREATE INDEX merchants_display_name_trgm_idx ON merchants USING gin (display_name gin_trgm_ops);

COMMENT ON TABLE merchants IS
  'Normalised payee. Minimal by design; @ctx/categorization extends it in WP 1.4. Owner: @ctx/ledger.';

-- ---------------------------------------------------------------------------
-- accounts: what money sits in, wherever it came from.
-- ---------------------------------------------------------------------------
--
-- `connection_id` is nullable and carries no foreign key. Nullable because a
-- manual account (a paid-off car, a savings bond, a cash envelope) has no
-- provider behind it; no FK because `connections` is owned by @ctx/connections
-- and a context may not declare a constraint against another context's table.
-- Ledger has no idea Plaid exists, and that asymmetry is what makes "swap the
-- aggregator" a one-context change (08 §1.3).
CREATE TABLE accounts (
  id                  UUID        PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id       UUID,
  provider            TEXT        NOT NULL CHECK (length(btrim(provider)) > 0),
  -- The provider's natural key. Separate from the UUIDv7 primary key on purpose
  -- (decision D10): a provider id is not ours to use as an identity.
  provider_account_id TEXT        NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
  name                TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  official_name       TEXT,
  type                TEXT        NOT NULL CHECK (
                        type IN ('depository', 'credit', 'loan', 'investment', 'crypto', 'manual')),
  -- Provider vocabulary (`checking`, `savings`, `credit card`, `401k`, ...). Left
  -- unconstrained: it is long, provider-specific, and changes without notice.
  subtype             TEXT,
  -- Which side of net worth this account lands on. Derived from `type` at upsert
  -- for provider accounts, explicit for manual ones (a manual account can be
  -- either a boat or a loan from a relative).
  classification      TEXT        NOT NULL CHECK (classification IN ('asset', 'liability')),
  currency            CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Last 2-4 digits. Never the full number; it is neither needed nor safe to hold.
  mask                TEXT        CHECK (mask IS NULL OR mask ~ '^[0-9A-Za-z*]{2,8}$'),
  closed_at           TIMESTAMPTZ,
  include_in_net_worth BOOLEAN    NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_provider_key_idx
  ON accounts (user_id, provider, provider_account_id);
CREATE INDEX accounts_user_open_idx ON accounts (user_id) WHERE closed_at IS NULL;
CREATE INDEX accounts_connection_idx ON accounts (connection_id) WHERE connection_id IS NOT NULL;

COMMENT ON TABLE accounts IS
  'Every account, provider-backed or manual. Owner: @ctx/ledger.';
COMMENT ON COLUMN accounts.connection_id IS
  'NULL for a manual account. No FK on purpose: connections belongs to @ctx/connections.';
COMMENT ON COLUMN accounts.classification IS
  'asset | liability. Which side of net worth this account contributes to.';

-- ---------------------------------------------------------------------------
-- account_balances: point-in-time, append-only.
-- ---------------------------------------------------------------------------
--
-- Not a mutable `current_balance` column on `accounts`. Every balance in the UI
-- has to be able to answer "as of when?" (04 §4.5), a net-worth series is built
-- from observations rather than from whatever the last sync happened to leave
-- behind, and a provider that reports a stale balance must not silently overwrite
-- a fresher manual one.
--
-- Sign: `current_minor` is the account's contribution to net worth, so a credit
-- card you owe $420 on stores -42000. `limit_minor` is a magnitude, not a
-- contribution, so it is stored positive.
CREATE TABLE account_balances (
  id              UUID        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id      UUID        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  current_minor   BIGINT      NOT NULL,
  available_minor BIGINT,
  limit_minor     BIGINT      CHECK (limit_minor IS NULL OR limit_minor >= 0),
  currency        CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  as_of           TIMESTAMPTZ NOT NULL,
  source          TEXT        NOT NULL CHECK (source IN ('provider', 'manual', 'derived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replaying a sync page must be a no-op (04 §4.4, idempotency layer 1).
CREATE UNIQUE INDEX account_balances_observation_idx
  ON account_balances (account_id, as_of, source);
-- The hot path: "the latest balance for each account".
CREATE INDEX account_balances_latest_idx ON account_balances (account_id, as_of DESC);

COMMENT ON TABLE account_balances IS
  'Append-only point-in-time balances. Owner: @ctx/ledger.';
COMMENT ON COLUMN account_balances.current_minor IS
  'Net-worth contribution in minor units: negative = owed. Adapters normalise at the edge.';

-- ---------------------------------------------------------------------------
-- transactions_provider: immutable provider facts.
-- ---------------------------------------------------------------------------
--
-- One row per provider revision. Sync writes here and nothing else does; a user
-- edit never touches this table. `raw` keeps the verbatim payload, which buys
-- free auditability ("what did Plaid say last Tuesday"), free replay of derived
-- data after an algorithm fix, and a place to find the field we did not think to
-- model in Phase 1.
CREATE TABLE transactions_provider (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id              UUID        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider                TEXT        NOT NULL CHECK (length(btrim(provider)) > 0),
  provider_transaction_id TEXT        NOT NULL CHECK (length(btrim(provider_transaction_id)) > 0),
  -- Plaid's link from a posted transaction back to the pending one it replaces.
  -- NULL when the institution does not supply pending data, or the match failed.
  pending_transaction_id  TEXT,
  amount_minor            BIGINT      NOT NULL,
  currency                CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The provider's own currency string, kept verbatim for reconciliation:
  -- `iso_currency_code` or `unofficial_currency_code`, which may disagree with
  -- the normalised `currency` above for a crypto or a non-ISO instrument.
  iso_currency            TEXT,
  -- When it settled. Plaid's `date`. Always present.
  posted_date             DATE        NOT NULL,
  -- When the card was swiped. Often NULL.
  authorized_date         DATE,
  -- Precise instants, both frequently NULL. A DATE above is a calendar date with
  -- no zone; these are genuine instants. Never mix them (04 §2.4).
  posted_at               TIMESTAMPTZ,
  authorized_at           TIMESTAMPTZ,
  name                    TEXT        NOT NULL,
  merchant_name           TEXT,
  original_description    TEXT,
  payment_channel         TEXT,
  -- Plaid `personal_finance_category` {primary, detailed, confidence_level}, or
  -- whatever the provider's taxonomy is. An immutable *source* field: our own
  -- category lives in the overlay, so a Plaid taxonomy revision cannot shift
  -- budget history under us (01 §5.4).
  provider_category       JSONB,
  pending                 BOOLEAN     NOT NULL,
  location                JSONB,
  counterparties          JSONB,
  raw                     JSONB       NOT NULL,
  -- Idempotency layer 2 (04 §4.4): a `modified` whose content hash matches the
  -- current fact bumps `last_seen_at` and writes nothing else. Plaid re-sends
  -- unchanged rows often; without this the fact table grows without bound.
  content_hash            TEXT        NOT NULL,
  revision                INTEGER     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  first_seen_at           TIMESTAMPTZ NOT NULL,
  last_seen_at            TIMESTAMPTZ NOT NULL,
  -- Set when the provider puts this id in `removed[]`. A tombstone, not a DELETE.
  removed_at              TIMESTAMPTZ,
  -- Set when a posted fact took this pending fact's place. Audit trail for the
  -- identity migration; the `transactions` row itself did not move.
  superseded_by_id        UUID        REFERENCES transactions_provider (id) ON DELETE SET NULL,
  CONSTRAINT transactions_provider_amount_currency_agree
    CHECK (currency = upper(currency))
);

-- Idempotency layer 1: "unique per account", so two providers reporting the same
-- opaque id for different accounts cannot collide, and replaying a page is a no-op.
CREATE UNIQUE INDEX transactions_provider_natural_key_idx
  ON transactions_provider (account_id, provider, provider_transaction_id);
-- The pending -> posted lookup: "which fact does this posted row replace?".
CREATE INDEX transactions_provider_pending_link_idx
  ON transactions_provider (account_id, pending_transaction_id)
  WHERE pending_transaction_id IS NOT NULL;
CREATE INDEX transactions_provider_account_date_idx
  ON transactions_provider (account_id, posted_date DESC);

COMMENT ON TABLE transactions_provider IS
  'Immutable provider facts, append-only. Never edited by a user. Owner: @ctx/ledger.';
COMMENT ON COLUMN transactions_provider.amount_minor IS
  'House sign convention: negative = outflow, positive = inflow. Plaid is the opposite; adapters normalise at the edge.';
COMMENT ON COLUMN transactions_provider.superseded_by_id IS
  'The posted fact that replaced this pending one. The user-facing transactions row did not move.';

-- ---------------------------------------------------------------------------
-- transactions: stable identity + user overlay + effective projection.
-- ---------------------------------------------------------------------------
--
-- The row users, splits, budgets and recurring series point at. Its `id` is a
-- UUIDv7 generated app-side, and it **survives the pending -> posted transition**:
-- only `current_fact_id` advances.
--
-- Three groups of columns, and confusing them is the bug this design exists to
-- prevent:
--
--   * `current_fact_id` — the pointer into immutable provider truth;
--   * `user_*` — sparse overlay. NULL means "the user has not spoken";
--   * `effective_*` — a denormalised projection of the two, written only by
--     `resolveEffective()`. Rebuildable at any time. Never hand-edited.
CREATE TABLE transactions (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id            UUID        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  current_fact_id       UUID        NOT NULL REFERENCES transactions_provider (id),

  -- --- effective projection (resolveEffective(fact, overlay)) ---------------
  -- The accounting date: COALESCE(authorized_date, posted_date) (04 §2.4). The
  -- swipe is when the user experienced the spend, and budgets live on month
  -- boundaries where the two disagree.
  effective_date        DATE        NOT NULL,
  effective_amount_minor BIGINT     NOT NULL,
  effective_currency    CHAR(3)     NOT NULL CHECK (effective_currency ~ '^[A-Z]{3}$'),
  effective_name        TEXT        NOT NULL,
  effective_merchant_id UUID        REFERENCES merchants (id) ON DELETE SET NULL,
  pending               BOOLEAN     NOT NULL,

  -- --- user overlay ---------------------------------------------------------
  user_note             TEXT,
  user_excluded         BOOLEAN     NOT NULL DEFAULT false,
  -- Opaque on purpose. @ctx/categorization owns `categories`; a foreign key here
  -- would be Ledger reaching into another context's table (decision D8), and
  -- Ledger must not care what a category *is*.
  user_category_id      UUID,
  user_merchant_name    TEXT,

  -- --- ledger-derived facts -------------------------------------------------
  is_transfer           BOOLEAN     NOT NULL DEFAULT false,
  transfer_link_id      UUID,
  -- A *hint*, never an automatic net. Marking a refund and silently subtracting
  -- it are different products; the second one loses a user's trust the first time
  -- it guesses wrong (01 §5.2, "prefer showing a duplicate over silently merging").
  refund_of_id          UUID        REFERENCES transactions (id) ON DELETE SET NULL,
  -- NUMERIC(5,4), not DOUBLE PRECISION. A confidence score is not money and a
  -- float would be numerically fine here, but the migration gate bans REAL /
  -- DOUBLE PRECISION / FLOAT outright across the schema rather than adjudicating
  -- "is this column allowed to be a float?" per column — and a ban with an
  -- exception list is a ban that erodes. 0.0000-1.0000 is four decimals of
  -- confidence, which is three more than anyone can justify.
  refund_confidence     NUMERIC(5,4)
                          CHECK (refund_confidence IS NULL
                                 OR (refund_confidence >= 0 AND refund_confidence <= 1)),
  -- Cross-provider duplicate: this row is a duplicate of that one. Set by
  -- detection, cleared by the user. Never auto-deleted.
  superseded_by_id      UUID        REFERENCES transactions (id) ON DELETE SET NULL,
  superseded_reason     TEXT        CHECK (superseded_reason IS NULL
                                           OR superseded_reason IN ('duplicate', 'merged')),
  -- The provider put this transaction in `removed[]`. Soft, not a DELETE: Plaid
  -- does not guarantee that `removed` arrives in the same page as the `added`
  -- that supersedes it, so a hard delete here would destroy an overlay that a
  -- later page was about to reclaim. `purgeRemovedTransactions()` does the
  -- eventual physical delete after a grace window.
  removed_at            TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT transactions_superseded_pair
    CHECK ((superseded_by_id IS NULL) = (superseded_reason IS NULL)),
  CONSTRAINT transactions_not_self_superseded CHECK (superseded_by_id <> id),
  CONSTRAINT transactions_not_self_refund CHECK (refund_of_id <> id),
  CONSTRAINT transactions_transfer_link_pair
    CHECK (is_transfer = true OR transfer_link_id IS NULL)
);

-- One user-facing row per provider fact. This is what makes `applyProviderTransactions`
-- idempotent at the identity level: re-pointing is an UPDATE, never a second INSERT.
CREATE UNIQUE INDEX transactions_current_fact_idx ON transactions (current_fact_id);

-- The list query, which is the app's most-run statement: keyset pagination over
-- (effective_date DESC, id DESC), scoped to one user, skipping removed rows.
CREATE INDEX transactions_feed_idx
  ON transactions (user_id, effective_date DESC, id DESC)
  WHERE removed_at IS NULL;
-- The same, filtered to one or more accounts (the account-detail page).
CREATE INDEX transactions_account_feed_idx
  ON transactions (account_id, effective_date DESC, id DESC)
  WHERE removed_at IS NULL;
CREATE INDEX transactions_merchant_idx
  ON transactions (user_id, effective_merchant_id, effective_date DESC)
  WHERE removed_at IS NULL AND effective_merchant_id IS NOT NULL;
-- Partial: "what is still pending?" is a small answer to a frequent question.
CREATE INDEX transactions_pending_idx
  ON transactions (user_id, effective_date DESC)
  WHERE pending = true AND removed_at IS NULL;
-- Free-text search over the payee, per D2. `gin_trgm_ops` and not a tsvector:
-- statement descriptors are not prose and tokenise into noise.
CREATE INDEX transactions_effective_name_trgm_idx
  ON transactions USING gin (effective_name gin_trgm_ops);
-- Transfer pairing and refund hinting both scan "same user, near this date, this
-- magnitude", so index the magnitude rather than the signed amount.
CREATE INDEX transactions_amount_scan_idx
  ON transactions (user_id, effective_date, abs(effective_amount_minor))
  WHERE removed_at IS NULL;
CREATE INDEX transactions_refund_of_idx ON transactions (refund_of_id)
  WHERE refund_of_id IS NOT NULL;
CREATE INDEX transactions_superseded_idx ON transactions (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

COMMENT ON TABLE transactions IS
  'Stable user-facing identity: fact pointer + user overlay + effective projection. The id survives pending -> posted. Owner: @ctx/ledger.';
COMMENT ON COLUMN transactions.id IS
  'UUIDv7, app-generated, and it never changes. Splits, notes and categories hang off it.';
COMMENT ON COLUMN transactions.effective_date IS
  'COALESCE(authorized_date, posted_date). Written only by resolveEffective(); a projection, not truth.';
COMMENT ON COLUMN transactions.user_category_id IS
  'Opaque id owned by @ctx/categorization. Deliberately no foreign key (decision D8).';
COMMENT ON COLUMN transactions.removed_at IS
  'Provider tombstone. Soft, because removed[] and added[] are not ordered relative to each other.';

-- ---------------------------------------------------------------------------
-- transaction_splits: one transaction, several categories.
-- ---------------------------------------------------------------------------
--
-- Pure user intent; sync never writes here. The splits must sum to the parent,
-- and `Money.allocate` (largest remainder) is what produces 3.34/3.33/3.33 for a
-- three-way split of $10 without losing a cent. The sum is enforced in the
-- application rather than by a trigger: a trigger would have to fire per-row and
-- would make an intermediate state of a legitimate multi-row edit illegal.
CREATE TABLE transaction_splits (
  id               UUID        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  transaction_id   UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  position         INTEGER     NOT NULL CHECK (position >= 0),
  amount_minor     BIGINT      NOT NULL,
  currency         CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Opaque, same reasoning as transactions.user_category_id.
  user_category_id UUID,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX transaction_splits_position_idx
  ON transaction_splits (transaction_id, position);
CREATE INDEX transaction_splits_transaction_idx ON transaction_splits (transaction_id);

COMMENT ON TABLE transaction_splits IS
  'User-authored division of one transaction across categories. Must sum to the parent. Owner: @ctx/ledger.';

-- ---------------------------------------------------------------------------
-- transfer_links: the paired internal transfer.
-- ---------------------------------------------------------------------------
--
-- Money moving between two accounts you own is double-counted by construction
-- when both are linked: once as an outflow, once as an inflow. Phase 1's exit
-- criterion is "spend totals contain zero internal transfers", and this table is
-- how. One row per pair, with the evidence for the match kept so a user can see
-- *why* the app decided two rows were one movement.
CREATE TABLE transfer_links (
  id                     UUID        PRIMARY KEY,
  user_id                UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  outflow_transaction_id UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  inflow_transaction_id  UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  -- The magnitude moved, stored positive: a transfer has no direction as a whole.
  amount_minor           BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency               CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Days between the two legs, kept so the confidence score is explicable.
  day_gap                INTEGER     NOT NULL CHECK (day_gap >= 0),
  -- NUMERIC(5,4), same reasoning as transactions.refund_confidence.
  confidence             NUMERIC(5,4) NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  how_matched            TEXT        NOT NULL CHECK (
                           how_matched IN ('exact_amount_same_day', 'exact_amount_near_date',
                                           'amount_within_tolerance', 'user_confirmed')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfer_links_distinct_legs
    CHECK (outflow_transaction_id <> inflow_transaction_id)
);

-- A transaction belongs to at most one pair, on either side. Two unique indexes
-- rather than application discipline: "already paired" is the precondition the
-- pairing algorithm is most likely to get wrong under concurrency.
CREATE UNIQUE INDEX transfer_links_outflow_idx ON transfer_links (outflow_transaction_id);
CREATE UNIQUE INDEX transfer_links_inflow_idx ON transfer_links (inflow_transaction_id);
CREATE INDEX transfer_links_user_idx ON transfer_links (user_id);

COMMENT ON TABLE transfer_links IS
  'A paired internal transfer: one outflow, one inflow, with the evidence for the match. Owner: @ctx/ledger.';

ALTER TABLE transactions
  ADD CONSTRAINT transactions_transfer_link_fk
  FOREIGN KEY (transfer_link_id) REFERENCES transfer_links (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- rejected_transfer_pairs: the user said no, and it must stay no.
-- ---------------------------------------------------------------------------
--
-- Without this table the pairing heuristic re-proposes the pair it was told to
-- drop on every sync, which is the single most annoying behaviour a finance app
-- can have. A negative decision is data and it is persisted like any other.
-- The pair is stored in canonical (lower, higher) id order so "did they reject
-- this?" is one index lookup rather than two.
CREATE TABLE rejected_transfer_pairs (
  id                  UUID        PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  low_transaction_id  UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  high_transaction_id UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  reason              TEXT,
  rejected_at         TIMESTAMPTZ NOT NULL,
  CONSTRAINT rejected_transfer_pairs_canonical_order
    CHECK (low_transaction_id < high_transaction_id)
);

CREATE UNIQUE INDEX rejected_transfer_pairs_key_idx
  ON rejected_transfer_pairs (user_id, low_transaction_id, high_transaction_id);

COMMENT ON TABLE rejected_transfer_pairs IS
  'Persisted negative decisions, so a rejected pairing is never re-proposed. Owner: @ctx/ledger.';

-- ---------------------------------------------------------------------------
-- ledger_dedup_keys: the same real-world transaction, seen twice.
-- ---------------------------------------------------------------------------
--
-- Provider ids are provider-specific, so a bank linked through both Plaid and a
-- CSV import produces two rows for one purchase and every aggregate is wrong.
-- The key is deliberately provider-*agnostic*: date, amount, currency, and a
-- normalised name. The hash is a bucketing device that makes the lookup one
-- fixed-width index probe; the components are stored beside it so a candidate is
-- verified exactly rather than trusted on a hash match.
--
-- Detection marks (`transactions.superseded_by_id`), it never merges. 01 §5.2 is
-- explicit: under-merging is a UI annoyance, over-merging is data loss.
CREATE TABLE ledger_dedup_keys (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  transaction_id UUID        NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider       TEXT        NOT NULL,
  -- sha256(posted_date | amount_minor | currency | name_key), first 16 bytes hex.
  dedup_key      TEXT        NOT NULL CHECK (dedup_key ~ '^[0-9a-f]{32}$'),
  name_key       TEXT        NOT NULL,
  posted_date    DATE        NOT NULL,
  amount_minor   BIGINT      NOT NULL,
  currency       CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ledger_dedup_keys_transaction_idx ON ledger_dedup_keys (transaction_id);
CREATE INDEX ledger_dedup_keys_lookup_idx ON ledger_dedup_keys (user_id, dedup_key);

COMMENT ON TABLE ledger_dedup_keys IS
  'Provider-agnostic fingerprint for cross-provider duplicate detection. Owner: @ctx/ledger.';
COMMENT ON COLUMN ledger_dedup_keys.dedup_key IS
  'A bucketing key, not a security control. The components beside it are what a match is verified against.';
