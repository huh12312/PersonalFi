-- SPDX-License-Identifier: MIT
-- 0030_insight_feedback_reasons: the dismiss-reason taxonomy, outcome
--                                verification and the NOT_TRUE quarantine
--                                reason (WP 5.9; 05-phase-5-dispatch.md §3
--                                and §4; 07 §8.3, 09 ADV-4).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- References only objects 0012_insights.sql created (`insights`,
-- `insight_feedback`, `advisors`, `users`) or objects this file creates --
-- 05 §4's ordering rule, so a fresh install applying 0030 before any other
-- Phase 5 number converges. Nothing here references `insight_dismissals`,
-- `insight_evidence` or `insight_actions` -- the ladder itself
-- (`insight_dismissals`) is untouched; its shape already supports every
-- effect this file's reason codes need (`policy/cooldown.ts`'s
-- `afterAlreadyKnow` and `afterIntentional` reach the existing rungs by
-- construction, not by a schema change).

-- ---------------------------------------------------------------------------
-- insight_feedback.reason_code -- the taxonomy beside the free-text reason
-- ---------------------------------------------------------------------------
--
-- 07 §8.3's seven codes. `reason` stays exactly what it was -- an optional
-- note, at most 240 characters -- and is never overwritten by this migration;
-- `reason_code` is additive. Only a `dismiss` or `snooze` response carries a
-- reason: `accept` and `reopen` are not refusals, and a code on either would
-- be a code for nothing (`insight_feedback_reason_code_for_response`).

ALTER TABLE insight_feedback
  ADD COLUMN reason_code TEXT;

ALTER TABLE insight_feedback
  ADD CONSTRAINT insight_feedback_reason_code_check
  CHECK (reason_code IS NULL OR reason_code IN (
    'NOT_TRUE', 'ALREADY_KNOW', 'NOT_ACTIONABLE', 'DONT_CARE',
    'WRONG_AMOUNT', 'INTENTIONAL', 'LATER'));

ALTER TABLE insight_feedback
  ADD CONSTRAINT insight_feedback_reason_code_for_response
  CHECK (reason_code IS NULL OR action IN ('dismiss', 'snooze'));

CREATE INDEX insight_feedback_reason_idx
  ON insight_feedback (user_id, advisor_id, reason_code);

COMMENT ON COLUMN insight_feedback.reason_code IS
  'The 07 §8.3 taxonomy: NOT_TRUE, ALREADY_KNOW, NOT_ACTIONABLE, DONT_CARE, WRONG_AMOUNT, INTENTIONAL, LATER. NULL for free text that matched no preset. reason stays the note.';

-- The three preset strings `apps/web/src/features/insights/
-- DismissReasonDialog.tsx` has been storing, mapped to codes by exact match.
-- Expand, never contract: every other stored `reason` -- custom text, or
-- NULL -- survives untouched, with `reason_code` left NULL. A one-time
-- backfill over rows that already exist; every row written after this
-- migration carries whatever `reason_code` the API sent (`store.ts`'s
-- `recordFeedback`), preset text included -- this UPDATE runs exactly once,
-- at deploy time, over the historical rows only.
UPDATE insight_feedback SET reason_code = 'NOT_TRUE'
  WHERE reason = 'That''s wrong' AND reason_code IS NULL;
UPDATE insight_feedback SET reason_code = 'ALREADY_KNOW'
  WHERE reason = 'Already handled' AND reason_code IS NULL;
UPDATE insight_feedback SET reason_code = 'NOT_ACTIONABLE'
  WHERE reason = 'Not useful' AND reason_code IS NULL;

-- ---------------------------------------------------------------------------
-- advisors.quarantine_reason -- widened for the feedback loop's own trip
-- ---------------------------------------------------------------------------
--
-- 0012 declared this as an inline column CHECK, which Postgres names
-- `<table>_<column>_check` (the 0028 precedent for `advisor_runs.status` and
-- `.refusal`); the drop below names a constraint that exists.

ALTER TABLE advisors
  DROP CONSTRAINT advisors_quarantine_reason_check;
ALTER TABLE advisors
  ADD CONSTRAINT advisors_quarantine_reason_check
  CHECK (quarantine_reason IS NULL OR quarantine_reason IN (
    'consecutive_failures', 'rejection_rate', 'manual', 'not_true_rate'));

-- ---------------------------------------------------------------------------
-- insight_outcomes -- outcome verification and forward validation
-- ---------------------------------------------------------------------------
--
-- One row per acceptance. `due_at` is fixed at acceptance (`accepted_at` +
-- `horizon_days`, 60 by default) and never recomputed; evaluation
-- (`policy/outcomes.ts`'s `evaluateDueOutcomes`) compares it against
-- `insights.last_proposed_at`, which can only advance -- the forward-only
-- property is structural, not a query-time filter (see the header in
-- `schema/insights.ts`). `outcome` is written at most once: the UPDATE that
-- sets it is guarded by `outcome IS NULL`, so "raises exactly one follow-up"
-- holds even if evaluation runs twice.
--
-- Re-accepting the same insight (accept, reopen, accept again) resets the
-- clock: the unique index is `(user_id, insight_id)`, and the write path
-- upserts on it rather than accumulating a second, stale horizon.

CREATE TABLE insight_outcomes (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  insight_id    UUID        NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
  advisor_id    TEXT        NOT NULL,
  insight_key   TEXT        NOT NULL,
  accepted_at   TIMESTAMPTZ NOT NULL,
  horizon_days  INTEGER     NOT NULL DEFAULT 60 CHECK (horizon_days > 0),
  due_at        TIMESTAMPTZ NOT NULL,
  outcome       TEXT        CHECK (outcome IS NULL OR outcome IN ('ACTED', 'INCOMPLETE')),
  evaluated_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT insight_outcomes_advisor_fk
    FOREIGN KEY (user_id, advisor_id) REFERENCES advisors (user_id, advisor_id) ON DELETE CASCADE,
  CONSTRAINT insight_outcomes_due_after_accepted CHECK (due_at > accepted_at),
  -- Evaluated exactly once: the pair moves together, and only forward.
  CONSTRAINT insight_outcomes_evaluated_has_outcome CHECK (
    (outcome IS NULL) = (evaluated_at IS NULL)
  ),
  CONSTRAINT insight_outcomes_evaluated_after_due CHECK (
    evaluated_at IS NULL OR evaluated_at >= due_at
  )
);

CREATE UNIQUE INDEX insight_outcomes_user_insight_idx
  ON insight_outcomes (user_id, insight_id);
CREATE INDEX insight_outcomes_due_idx
  ON insight_outcomes (user_id, due_at)
  WHERE outcome IS NULL;

COMMENT ON TABLE insight_outcomes IS
  'Outcome verification (09 ADV-4) and forward validation (05 §1 cut line 2): one row per acceptance, evaluated at most once at its horizon against insights.last_proposed_at, never against a proposal that predates acceptance.';
COMMENT ON COLUMN insight_outcomes.due_at IS
  'accepted_at + horizon_days, fixed at acceptance. The forward-validation cutoff: only a proposal at or after this instant can make the outcome INCOMPLETE.';
