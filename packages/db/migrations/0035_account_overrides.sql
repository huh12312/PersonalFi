-- SPDX-License-Identifier: MIT
-- 0035_account_overrides: the holder's overlay on an account -- a tax
--                         treatment, a role and a valuation basis that
--                         outrank what the provider's own metadata implies
--                         (CF-16, O-2; docs/plan/09-phase-9-dispatch.md §3
--                         "WP 9.2"; docs/research/09-requirements-prd.md
--                         AC-7).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only, as every Phase 9 migration must be (09 §4 "no contract steps
-- on a live soak"): one additive UNIQUE constraint on an existing table and
-- one new table. Nothing is dropped, renamed or narrowed. It references no
-- object a higher-numbered migration creates (09 §4's rule): `accounts` is
-- 0004's, `users` is 0001's.
--
-- ---------------------------------------------------------------------------
-- Why an overlay table and not columns on `accounts`
-- ---------------------------------------------------------------------------
--
-- `accounts` is the provider's: a nightly sync refreshes name, subtype, mask
-- and currency from the institution (`upsertAccount`). A holder's claim about
-- an account -- "this is my Roth, whatever Plaid calls it" -- must survive
-- that refresh and must never be mistaken for a provider fact. D11's shape
-- (provider facts immutable, user intent in an overlay, one pure resolver
-- deciding) applies here exactly as it does to `transactions`, with one
-- difference: a transaction's overlay is four sparse columns on a row every
-- read already touches, while an account override is read by two consumers
-- (the accounts screen and the projection's input) and written by one route,
-- and "has the holder said anything about this account" is a question the
-- table answers by having a row.
--
-- One row per (user, account); the row exists exactly when at least one of
-- the three fields is set. `DELETE /accounts/{id}/overrides` deletes the
-- row. A row with all three NULL is refused by `account_overrides_not_empty`,
-- so "no override" has one representation, not two.
--
-- ---------------------------------------------------------------------------
-- The three fields, and what NULL means in each
-- ---------------------------------------------------------------------------
--
--   tax_treatment  TAXABLE | TAX_DEFERRED | ROTH | HSA -- the four buckets
--                  `@ctx/planning`'s projection starts from (`TAX_BUCKETS`).
--                  NULL = unset: the provider-subtype default decides
--                  (`defaultTaxBucketFor`).
--   role           spending | savings | taxable | tax_deferred | tax_free |
--                  liability -- AC-7's closed list. NULL = unclassified.
--   valuation      holdings | balance. NULL = holdings, the default: an
--                  investment account is Σ quantity x price. `balance` says
--                  that an investment or crypto account with no priced
--                  holdings counts at its latest typed balance instead --
--                  labelled as such wherever it appears (O-2).
--
-- The value lists are CHECK constraints and are asserted equal to the
-- TypeScript constants in `packages/contexts/ledger/src/overrides/vocab.ts`
-- by `test/db/account-overrides.test.ts`, so a column CHECK and a domain rule
-- cannot drift apart (0026's convention).
--
-- ---------------------------------------------------------------------------
-- A user-scoped composite foreign key
-- ---------------------------------------------------------------------------
--
-- `(user_id, account_id) REFERENCES accounts (user_id, id)`, following
-- 0025/0026's convention (Phase 3 gate C-14): a bare `REFERENCES accounts
-- (id)` proves the account exists *somewhere*, not that it belongs to the user
-- overriding it. Postgres requires a UNIQUE target for a composite FK, so this
-- migration first adds `accounts_user_id_id_uniq` -- trivially satisfied
-- (`id` is already the primary key) and additive.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE accounts
  ADD CONSTRAINT accounts_user_id_id_uniq UNIQUE (user_id, id);

CREATE TABLE account_overrides (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL,

  tax_treatment  TEXT        CHECK (tax_treatment IN ('TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA')),
  role           TEXT        CHECK (role IN (
                               'spending', 'savings', 'taxable', 'tax_deferred', 'tax_free',
                               'liability')),
  valuation      TEXT        CHECK (valuation IN ('holdings', 'balance')),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT account_overrides_account_belongs_to_user
    FOREIGN KEY (user_id, account_id) REFERENCES accounts (user_id, id) ON DELETE CASCADE,
  CONSTRAINT account_overrides_not_empty
    CHECK (tax_treatment IS NOT NULL OR role IS NOT NULL OR valuation IS NOT NULL)
);

CREATE UNIQUE INDEX account_overrides_user_account_uniq
  ON account_overrides (user_id, account_id);

COMMENT ON TABLE account_overrides IS
  'The holder''s overlay on an account: tax treatment, role, valuation basis. Provider facts on `accounts` are never mutated; one pure resolver (`resolveAccountOverlay`) decides. One row per account, present exactly when at least one field is set. Owner: @ctx/ledger (WP 9.2).';
COMMENT ON COLUMN account_overrides.tax_treatment IS
  'NULL = unset: the provider-subtype default decides. A holder-set value outranks it (CF-16).';
COMMENT ON COLUMN account_overrides.valuation IS
  'NULL = holdings. `balance`: an investment or crypto account with no priced holdings counts at its latest typed balance, labelled as such (O-2).';
COMMENT ON CONSTRAINT account_overrides_account_belongs_to_user ON account_overrides IS
  'An override''s account must belong to the same user (0025''s C-14 convention): overriding another user''s account is structurally impossible, not merely predicate-deep.';
