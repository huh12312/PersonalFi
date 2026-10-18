-- SPDX-License-Identifier: MIT
-- 0050_category_icon: the emoji a holder chose for a category (WP 10.14;
--                     docs/research/10-visual-design-notes.md §1.4
--                     and §3 V7, Monarch's Category.icon).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one nullable column with a named CHECK. Nothing is dropped,
-- renamed or narrowed, no row is touched, and every row valid before this
-- migration is valid after it (each one's emoji is NULL). References only
-- `categories`, which is 0006's and @ctx/categorization's.
--
-- ---------------------------------------------------------------------------
-- The field
-- ---------------------------------------------------------------------------
--
--   emoji  one emoji -- one extended grapheme cluster -- as the holder set it.
--          NULL = none set.
--
-- Named `emoji`, not `icon`, because `categories.icon` already exists: it is
-- the Lucide icon name of decision D20 (NOT NULL, default 'circle'), and it
-- stays exactly as it is.
--
-- **The fallback is never written.** A shipped category has a default emoji
-- for its key (`CATEGORY_DEFAULT_EMOJI`, packages/kernel/src/emoji.ts) and a
-- custom category has its initials, but both are display fallbacks the web
-- draws when this column is NULL. Unlike 0045's hue, nothing seeds this column
-- on read: only POST /categories, PATCH /categories/{id} (where `null` clears
-- it) and an import write it, so a NULL here always means "the holder has not
-- chosen one", and a changed default in a later release reaches every holder
-- who never chose.
--
-- The CHECK bounds the length only. `char_length` counts code points, and one
-- grapheme can be several (a ZWJ family is seven, a skin-toned profession
-- four), so the bound is 8 = `MAX_EMOJI_CODE_POINTS`. "Exactly one emoji" is
-- the application's rule -- `isSingleEmoji` from @core/kernel, which
-- @ctx/categorization applies before every write -- because SQL cannot
-- segment graphemes. `packages/contexts/categorization/test/emoji.test.ts`
-- asserts the CHECK exists and refuses a nine-code-point value.
--
-- Exported and imported like every other `categories` column (the export
-- registry reads columns from information_schema); a pre-0050 archive imports
-- with the column NULL.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE categories
  ADD COLUMN emoji TEXT
    CONSTRAINT categories_emoji_check
    CHECK (emoji IS NULL OR (char_length(emoji) BETWEEN 1 AND 8));

COMMENT ON COLUMN categories.emoji IS
  'One emoji (one extended grapheme cluster) the holder chose for this category; at most 8 code points (MAX_EMOJI_CODE_POINTS). NULL = none set: the web shows the shipped default for a system key (CATEGORY_DEFAULT_EMOJI, packages/kernel/src/emoji.ts) or the initials, and that fallback is never written. Validated by isSingleEmoji before every write. Not the Lucide icon (categories.icon, D20). WP 10.14.';
