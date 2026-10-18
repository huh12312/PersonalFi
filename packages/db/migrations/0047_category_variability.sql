-- SPDX-License-Identifier: MIT
-- 0047_category_variability: whether a category's spending is fixed, flexible
--                            or non-monthly, as the holder classifies it
--                            (WP 10.11; docs/research/10-visual-design-notes-visual-
--                            analysis.md §1.4 and §3 V4, Monarch's
--                            budgetVariability).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one nullable column with a named CHECK. Nothing is dropped,
-- renamed or narrowed, no row is touched, and every row valid before this
-- migration is valid after it (each one's variability is NULL). References
-- only `categories`, which is 0006's and @ctx/categorization's.
--
-- ---------------------------------------------------------------------------
-- The field
-- ---------------------------------------------------------------------------
--
--   variability  fixed | flexible | non_monthly. NULL = unclassified.
--
--   fixed        the same amount most periods (rent, a loan payment, a
--                subscription);
--   flexible     varies with choices made inside the period (groceries,
--                dining);
--   non_monthly  irregular or annual (insurance premiums, gifts, car repairs).
--
-- **No backfill and no default, on purpose.** Only the holder classifies a
-- category. The budget screen *suggests* `fixed` for a category with an active
-- recurring stream (GET /categories/variability-suggestions, computed on read
-- from @ctx/recurring's read model and the ledger) and shows the suggestion as
-- a chip until the holder confirms it with PATCH /categories/{id}; nothing ever
-- writes this column except that PATCH, POST /categories and an import.
--
-- The value list is a CHECK and is asserted equal to the TypeScript constant
-- `CATEGORY_VARIABILITIES` (@ctx/categorization) by
-- `apps/api/test/db/category-variability-routes.test.ts`.
--
-- Exported and imported like every other `categories` column (the export
-- registry reads columns from information_schema); a pre-0047 archive imports
-- with the column NULL.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE categories
  ADD COLUMN variability TEXT
    CONSTRAINT categories_variability_check
    CHECK (variability IS NULL OR variability IN ('fixed', 'flexible', 'non_monthly'));

COMMENT ON COLUMN categories.variability IS
  'How this category''s spending behaves, as the holder classified it: fixed | flexible | non_monthly. NULL = unclassified. Only the holder sets it (PATCH /categories/{id}); a recurring stream only suggests fixed. WP 10.11.';
