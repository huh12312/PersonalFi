-- SPDX-License-Identifier: MIT
-- 0051_insight_feedback: an insight's bookmark and the holder's "was this
--                        helpful?" answer (WP 10.15;
--                        docs/research/10-visual-design-notes.md
--                        §1.4 "Insights (Today)" and §3 V8, its insight fields (isBookmarked / feedback / feedbackReason)).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: three nullable columns, each with a named CHECK, and one named
-- cross-column CHECK. Nothing is dropped, renamed or narrowed, no row is
-- touched, and every row valid before this migration is valid after it (all
-- three are NULL). References only `insights`, which is 0012's and
-- @ctx/insights'.
--
-- ---------------------------------------------------------------------------
-- Why columns on `insights` and not rows in `insight_feedback`
-- ---------------------------------------------------------------------------
--
-- `insight_feedback` (0012, widened by 0030) is an append-only log of review
-- ACTIONS -- accept, dismiss, snooze, reopen -- and every row in it drives the
-- cooldown ladder, the NOT_TRUE quarantine rate and rule health
-- (src/policy/feedback.ts). A bookmark and a helpful / not-helpful answer are
-- neither: they are the holder's current opinion of one insight, replaced
-- when it changes, and they must NOT move an advisor's policy (dismissing is
-- the path that does). So they are state on the row, not events in the log.
-- No equivalent column existed before this migration.
--
-- ---------------------------------------------------------------------------
-- The fields
-- ---------------------------------------------------------------------------
--
--   bookmarked_at    when the holder bookmarked it; NULL = not bookmarked.
--   feedback         'helpful' | 'not_helpful'; NULL = not answered.
--   feedback_reason  one of 07 §8.3's seven reason codes (the same taxonomy as
--                    insight_feedback.reason_code, 0030), offered by the
--                    dismiss-reason dialog when the answer is "not helpful";
--                    NULL = none given. Only a not-helpful answer carries one
--                    (insights_feedback_reason_requires_not_helpful; the
--                    explicit `feedback IS NOT NULL` is load-bearing: a bare
--                    `feedback = 'not_helpful'` is NULL, which a CHECK
--                    passes, when feedback is NULL).
--
-- A re-proposal (store.ts's upsertInsight) does not touch any of the three:
-- its ON CONFLICT SET list names the advisor's fields only.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE insights
  ADD COLUMN bookmarked_at TIMESTAMPTZ,
  ADD COLUMN feedback TEXT
    CONSTRAINT insights_feedback_check
    CHECK (feedback IS NULL OR feedback IN ('helpful', 'not_helpful')),
  ADD COLUMN feedback_reason TEXT
    CONSTRAINT insights_feedback_reason_check
    CHECK (feedback_reason IS NULL OR feedback_reason IN (
      'NOT_TRUE', 'ALREADY_KNOW', 'NOT_ACTIONABLE', 'DONT_CARE',
      'WRONG_AMOUNT', 'INTENTIONAL', 'LATER'
    )),
  ADD CONSTRAINT insights_feedback_reason_requires_not_helpful
    CHECK (feedback_reason IS NULL OR (feedback IS NOT NULL AND feedback = 'not_helpful'));

COMMENT ON COLUMN insights.bookmarked_at IS
  'When the holder bookmarked this insight; NULL = not bookmarked. State, not an event: never read by the cooldown ladder or quarantine policy. WP 10.15.';
COMMENT ON COLUMN insights.feedback IS
  'The holder''s answer to "was this helpful?": helpful | not_helpful; NULL = not answered. Persisted on the row only; does not feed policy (dismissal does). WP 10.15.';
COMMENT ON COLUMN insights.feedback_reason IS
  'Why it was not helpful: one of the seven 07 §8.3 reason codes, only with feedback = not_helpful; NULL = none given. WP 10.15.';
