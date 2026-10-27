-- SPDX-License-Identifier: MIT
-- 0058_transaction_auto_category: the automatic tiers' answer, on the ledger's
--                                 stable row (WP 11.2b; the effective category is
--                                 now `user ?? rule ?? auto`).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: nullable columns on an existing table, one new boolean with a
-- constant default on `users`, one partial index. Nothing is altered, dropped or
-- narrowed, no row is rewritten and no backfill runs here: every existing row
-- resolves exactly as it did, because NULL here is what "the machine has said
-- nothing" means. The backfill is a job (docs/CONVENTIONS.md, expand -> backfill
-- -> contract): `reprojectAutoCategories` in @ctx/categorization reads the
-- current assignments and writes this projection through @ctx/ledger.
--
-- ---------------------------------------------------------------------------
-- Why columns on `transactions`, not a side table
-- ---------------------------------------------------------------------------
--
-- Same call as 0004's overlay and 0007's rule tier. Every reader of the
-- effective category (the list, budgets' actuals, the spending, cash-flow and
-- pace reports, the insights snapshot) reads `transactions` already; a side
-- table would put a join on the hottest statements in the app, and the aggregate
-- reads sum 50,000 rows in one pass. Six nullable columns cost nothing to rows
-- that have none. The history 04 §5.2 wants kept lives where it always did, in
-- `category_assignments`; what stays here after a holder's own pick is the
-- machine's last answer, stamped `auto_superseded_at`.
--
-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------
--
--   auto_category_id    an @ctx/categorization `categories.id`, opaque here, no
--                       foreign key (decision D8), like user_category_id.
--   auto_tier           which automatic tier decided: merchant_default (3),
--                       provider (4) or classifier (5). Tiers 1, 2 and 6 never
--                       project: a rule has rule_category_id, the holder has
--                       user_category_id, and "none" is the absence of a row's
--                       worth of columns.
--   auto_confidence     the calibrated figure the engine stored with the
--                       assignment, read back, never recomputed.
--   auto_decided_at     when that assignment was decided.
--   auto_assignment_id  the category_assignments row this mirrors. Writes are
--                       idempotent per assignment id.
--   auto_superseded_at  set when the holder's own pick landed on this row; the
--                       machine's answer stays as history. Cleared if the pick
--                       is withdrawn.
--
-- The first five are set together or not at all.
--
-- The projection is DERIVED: the export omits these columns and the import
-- re-derives them from the bundle's category_assignments.

ALTER TABLE transactions
  ADD COLUMN auto_category_id   UUID,
  ADD COLUMN auto_tier          TEXT
    CONSTRAINT transactions_auto_tier_check
    CHECK (auto_tier IS NULL OR auto_tier IN ('merchant_default', 'provider', 'classifier')),
  ADD COLUMN auto_confidence    NUMERIC(5, 4)
    CONSTRAINT transactions_auto_confidence_check
    CHECK (auto_confidence IS NULL OR auto_confidence BETWEEN 0 AND 1),
  ADD COLUMN auto_decided_at    TIMESTAMPTZ,
  ADD COLUMN auto_assignment_id UUID,
  ADD COLUMN auto_superseded_at TIMESTAMPTZ,
  ADD CONSTRAINT transactions_auto_whole CHECK (
    (auto_category_id IS NULL) = (auto_tier IS NULL)
    AND (auto_category_id IS NULL) = (auto_confidence IS NULL)
    AND (auto_category_id IS NULL) = (auto_decided_at IS NULL)
    AND (auto_category_id IS NULL) = (auto_assignment_id IS NULL)
    AND (auto_superseded_at IS NULL OR auto_category_id IS NOT NULL)
  );

COMMENT ON COLUMN transactions.auto_category_id IS
  'The automatic tiers'' answer (3 merchant default, 4 provider, 5 classifier at or above its floor). Written only through @ctx/ledger''s setAutoCategories by the categorization pass that decided it, in that pass''s transaction. Effective category = user_category_id ?? rule_category_id ?? auto_category_id (resolveCategoryId). Derived: the export omits it and the import re-derives it from category_assignments.';

-- The Inbox's "Auto-categorised, unreviewed" section and its count: rows the
-- machine placed that neither a rule nor the holder has since decided.
CREATE INDEX transactions_auto_review_idx
  ON transactions (user_id, effective_date DESC, id DESC)
  WHERE auto_category_id IS NOT NULL
    AND user_category_id IS NULL
    AND rule_category_id IS NULL
    AND removed_at IS NULL;

-- The Inbox's one preference: whether to show that section. Per holder, on the
-- one per-holder preferences row this schema has (0046's precedent); not
-- exported (registry.ts exempts `users`). Default shown.
ALTER TABLE users
  ADD COLUMN inbox_show_auto_review BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN users.inbox_show_auto_review IS
  'Whether the Inbox lists "Auto-categorised, unreviewed" (WP 11.2b). TRUE = shown (the default). Not exported (users is exempt).';
