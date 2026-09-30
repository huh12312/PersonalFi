-- SPDX-License-Identifier: MIT
-- 0031_insight_narrations: a narration is linked to the finding it narrates,
--                          never ranked beside it (WP 5.3;
--                          05-phase-5-dispatch.md §3 WP 5.3 and §4's table;
--                          07 §7.5 rules 1 and 3).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- References only `insights`, which 0012_insights.sql created -- 05 §4's
-- ordering rule, so a fresh install applying 0031 before any other Phase 5
-- number converges. No new table: a narration is an `insights` row written
-- by the `local_model` narrator (`local.narrator`) through the same seven-step
-- validator as every other row, and this column is the only thing that makes
-- it different.
--
-- What the column means, in the terms the read models use:
--
--   * `narrates_insight_id IS NULL`  -- a finding. Ranked, budgeted, shown in
--     the feed, the dashboard and the Brief; the only kind of row any of them
--     reads (`read.ts`'s `listInsights` filters on it).
--   * `narrates_insight_id IS NOT NULL` -- alternative wording of the finding
--     it names, shown *on that finding's card* under an "AI-assisted wording"
--     badge with the template text one click away (07 §7.5 rule 3). It never
--     takes a feed, dashboard or Brief slot of its own, it emits no
--     `InsightProposed` (a narration is not a finding), and every figure the
--     card displays is the built-in's. A rejected narration writes no row at
--     all: the built-in's text stands (07 §7.5 rule 1).
--
-- ---------------------------------------------------------------------------
-- The composite target
-- ---------------------------------------------------------------------------
--
-- A user-scoped composite FK needs a unique key on (user_id, id) to point at;
-- `id` alone is the primary key, which proves the row exists *somewhere* and
-- never that it belongs to the same holder as the narration naming it (0025's
-- header, 0034's G4-23). The index name is this migration's own
-- (`insights_narration_target_idx`), deliberately not the `<table>_user_id_idx`
-- shape 0028 used for `advisor_runs`, so a later migration following that
-- precedent for `insights` cannot collide with it by name.

CREATE UNIQUE INDEX insights_narration_target_idx ON insights (user_id, id);

-- ---------------------------------------------------------------------------
-- insights.narrates_insight_id
-- ---------------------------------------------------------------------------
--
-- Nullable: every existing row, and every row a built-in writes, is a finding.
-- ON DELETE CASCADE: a narration of a finding that no longer exists is wording
-- for nothing, and must not survive to be shown on its own. MATCH SIMPLE (the
-- default), so a NULL link is not checked -- which is exactly "a finding".

ALTER TABLE insights
  ADD COLUMN narrates_insight_id UUID;

ALTER TABLE insights
  ADD CONSTRAINT insights_narration_same_user
    FOREIGN KEY (user_id, narrates_insight_id) REFERENCES insights (user_id, id) ON DELETE CASCADE;

-- A row cannot narrate itself. Narrating a narration is refused by the
-- application (`advisors/local/findings.ts` builds the envelope from rows with
-- `narrates_insight_id IS NULL` only); a CHECK cannot see the referenced row.
ALTER TABLE insights
  ADD CONSTRAINT insights_narration_not_self
    CHECK (narrates_insight_id IS NULL OR narrates_insight_id <> id);

-- The card's lookup: "the narration of this finding, if any".
CREATE INDEX insights_narrates_idx
  ON insights (user_id, narrates_insight_id)
  WHERE narrates_insight_id IS NOT NULL;

COMMENT ON COLUMN insights.narrates_insight_id IS
  'WP 5.3. NULL: a finding (ranked, shown). Set: alternative wording of that same user''s finding, written by a narrates_only advisor; never ranked, never shown on its own, cascades with its finding.';
