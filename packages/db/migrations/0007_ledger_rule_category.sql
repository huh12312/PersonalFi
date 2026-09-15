-- SPDX-License-Identifier: MIT
-- 0007_ledger_rule_category: the rule tier's slot on the ledger's stable row.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- 04 §2.2 describes a three-tier resolution order for a transaction's category:
-- an explicit user edit, then a rule the user wrote in advance, then provider
-- truth. Migration 0004 built the first tier (transactions.user_category_id)
-- and deliberately left the second unbuilt -- a resolution tier with no
-- producer is a tier nobody can test. WP 1.4 (@ctx/categorization) is that
-- producer now (docs/evidence/phase-1/wp1.4-categorization.md §6), so this adds
-- the column its rule tier writes to.
--
-- Same shape as user_category_id, and the same reasoning: opaque, no foreign
-- key. @ctx/categorization owns `categories`; a foreign key here would be
-- ledger reaching into another context's table (decision D8), and ledger must
-- not care what a category *is*.
--
-- Purely additive: one nullable column on an existing table, backfilled by
-- nothing. Every row that already exists resolves exactly as it did before this
-- migration, because resolveEffective()'s `rule` parameter defaults to NO_RULE
-- and a NULL here is what NO_RULE means. `transactions` is @ctx/ledger's table
-- already, so this needs no new OWNERSHIP.md entry -- only a table gets one.

ALTER TABLE transactions ADD COLUMN rule_category_id UUID;

COMMENT ON COLUMN transactions.rule_category_id IS
  'The rule tier''s answer (04 §2.2 middle tier). Written only by @ctx/categorization through the LedgerPort it reads this context through, never by a user edit. Opaque id owned by @ctx/categorization; NULL means no rule has matched. transactions.user_category_id always wins over this column -- see resolveEffective() in @ctx/ledger/src/effective.ts.';
