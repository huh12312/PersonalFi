-- SPDX-License-Identifier: MIT
-- 0062_advisor_sessions_origin: the Brief and the advisor meet (WP 11.5e; 12 §2.3
--                               step 6, §6 row 11.5e).
--
-- Two things, both on existing @ctx/insights tables:
--
--   * advisor_sessions gains the session's ORIGIN: a session opened from a
--     finding ("Talk this through" on a Brief item or an insight card) records
--     which finding (origin_insight_ref, the insight's id), which built-in rule
--     made it (origin_rule_id, 07 §3.3's identifier: C4, D1, R6, ...), its title
--     as the holder saw it when they asked (origin_title) and, when it was opened
--     from a Brief, that Brief's ISO week (origin_brief_week). A session started
--     from a typed question has none of them. The pair is set together or not at
--     all, and the title rides with the pair;
--   * advisor_sessions gains a terminal status, `completed`: a tracked plan whose
--     watched figure reached the plan's target. The watcher stops there. Only the
--     follow-up check moves a session into it, and only with the watcher recorded
--     as reached;
--   * advisory_brief_items gains `progress`: a Brief item that reports on a plan
--     the holder picked carries, snapshotted at publish like its title and
--     summary, the session it came from, the finding that opened it, when it was
--     picked, the baseline and current figure, the direction, whether the target
--     is reached, the deterministic wording, and — when the finding that opened
--     the session was itself still in the feed — that finding, marked as being
--     worked on (the Brief shows it once, as this item).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only. Nullable columns, a new value added to a status CHECK, and the
-- constraints that name the status re-stated to admit it — each new constraint
-- accepts every row the old one did (`completed` is new, so no existing row
-- carries it, and every existing row has the origin columns NULL). Nothing is
-- dropped from what a row may hold; no row is rewritten; no backfill.

ALTER TABLE advisor_sessions
  ADD COLUMN origin_insight_ref  UUID,
  ADD COLUMN origin_rule_id      TEXT
    CONSTRAINT advisor_sessions_origin_rule_check
    CHECK (origin_rule_id IS NULL OR origin_rule_id ~ '^[A-Z][0-9]{1,2}$'),
  ADD COLUMN origin_title        TEXT
    CONSTRAINT advisor_sessions_origin_title_check
    CHECK (origin_title IS NULL OR char_length(origin_title) BETWEEN 1 AND 200),
  ADD COLUMN origin_brief_week   TEXT
    CONSTRAINT advisor_sessions_origin_brief_week_check
    CHECK (origin_brief_week IS NULL
           OR origin_brief_week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$');

-- The pair: both set or both null. The title rides with it; a Brief week only with a finding.
ALTER TABLE advisor_sessions
  ADD CONSTRAINT advisor_sessions_origin_pair
    CHECK ((origin_insight_ref IS NULL) = (origin_rule_id IS NULL)),
  ADD CONSTRAINT advisor_sessions_origin_title_with_pair
    CHECK ((origin_title IS NULL) = (origin_insight_ref IS NULL)),
  ADD CONSTRAINT advisor_sessions_origin_week_with_pair
    CHECK (origin_brief_week IS NULL OR origin_insight_ref IS NOT NULL);

-- `completed`: the status CHECK gains the value (none removed).
ALTER TABLE advisor_sessions DROP CONSTRAINT advisor_sessions_status_check;
ALTER TABLE advisor_sessions
  ADD CONSTRAINT advisor_sessions_status_check
    CHECK (status IN ('clarifying', 'gathering', 'options', 'tradeoffs',
                      'awaiting_pick', 'planning', 'tracked', 'completed',
                      'refused', 'unanswerable', 'failed', 'cancelled'));

-- A completed session keeps its plan and its (stopped) watcher: tracked and completed are the two
-- statuses that carry them.
ALTER TABLE advisor_sessions DROP CONSTRAINT advisor_sessions_tracked_whole;
ALTER TABLE advisor_sessions
  ADD CONSTRAINT advisor_sessions_tracked_whole
    CHECK ((status IN ('tracked', 'completed'))
           = (plan IS NOT NULL AND watcher IS NOT NULL AND watcher_id IS NOT NULL));

-- Completed is final.
ALTER TABLE advisor_sessions DROP CONSTRAINT advisor_sessions_finished;
ALTER TABLE advisor_sessions
  ADD CONSTRAINT advisor_sessions_finished
    CHECK ((status IN ('tracked', 'completed', 'refused', 'unanswerable', 'failed', 'cancelled'))
           = (finished_at IS NOT NULL));

-- Completed only with the watcher recorded as having reached the plan's target.
ALTER TABLE advisor_sessions
  ADD CONSTRAINT advisor_sessions_completed_reached
    CHECK (status <> 'completed' OR (watcher ->> 'status') = 'reached');

-- The Brief's progress item (snapshotted at publish; never read through to the session afterwards).
ALTER TABLE advisory_brief_items
  ADD COLUMN progress JSONB
    CONSTRAINT advisory_brief_items_progress_check
    CHECK (progress IS NULL OR jsonb_typeof(progress) = 'object');

COMMENT ON COLUMN advisor_sessions.origin_insight_ref IS
  'WP 11.5e: the insight a "Talk this through" session was opened from; NULL for a typed question. Set with origin_rule_id.';
COMMENT ON COLUMN advisor_sessions.origin_rule_id IS
  'WP 11.5e: the built-in rule (07 §3.3 identifier) that made the origin finding. Set with origin_insight_ref.';
COMMENT ON COLUMN advisory_brief_items.progress IS
  'WP 11.5e: a plan the holder picked, as this Brief reported it (origin, baseline, current, direction, wording, the finding marked being worked on).';
