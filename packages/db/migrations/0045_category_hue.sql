-- SPDX-License-Identifier: MIT
-- 0045_category_hue: the chart hue a category is drawn in, one of thirteen
--                    named hues, stored once and never re-derived (WP 10.8;
--                    docs/research/10-visual-design-notes.md §3 V1).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one nullable column with a named CHECK. Nothing is dropped,
-- renamed or narrowed, no row is touched, and every row valid before this
-- migration is valid after it (each one's hue is NULL). References only
-- `categories`, which is 0006's and @ctx/categorization's.
--
-- ---------------------------------------------------------------------------
-- The field
-- ---------------------------------------------------------------------------
--
--   hue  teal | green | red | orange | yellow | cyan | purple | indigo | lime |
--        mint | pink | brown | sky. NULL = not yet assigned.
--
-- **No backfill here, on purpose.** The seed value is `hueForId(id)` -- a
-- 32-bit FNV-1a over the id, modulo 13 -- and it lives in TypeScript
-- (`packages/kernel/src/hue.ts`) because the web computes the same value for a
-- category it has not yet seen a persisted hue for; a second copy of the hash
-- in SQL would be a second answer that could drift. `@ctx/categorization`
-- assigns it on first read instead (`listCategories`: `UPDATE ... SET hue =
-- $1 WHERE id = $2 AND hue IS NULL`, so a concurrent first read is idempotent
-- and a holder's own choice is never overwritten), and after that the stored
-- value is the truth: a re-read returns it and nothing recomputes it.
-- `PATCH /categories/{id}` lets the holder change it.
--
-- The value list is a CHECK and is asserted equal to the TypeScript constant
-- `CHART_HUES` (`packages/kernel/src/hue.ts`) by
-- `packages/contexts/categorization/test/hue.test.ts`.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE categories
  ADD COLUMN hue TEXT
    CONSTRAINT categories_hue_check
    CHECK (hue IS NULL OR hue IN ('teal', 'green', 'red', 'orange', 'yellow', 'cyan', 'purple',
                                  'indigo', 'lime', 'mint', 'pink', 'brown', 'sky'));

COMMENT ON COLUMN categories.hue IS
  'The chart hue this category is drawn in: one of the thirteen CHART_HUES names (packages/kernel/src/hue.ts). NULL = not yet assigned; @ctx/categorization seeds it with hueForId(id) on first read and never re-derives it after. Editable by PATCH /categories/{id}. WP 10.8.';
