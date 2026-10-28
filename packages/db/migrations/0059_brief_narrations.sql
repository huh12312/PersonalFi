-- SPDX-License-Identifier: MIT
-- 0059_brief_narrations: the Brief's own narration and the weekly recap
--                        (WP 11.4; 11 §3.2's "Narrating one finding — keep;
--                        extend to the Brief as a whole" row; the Phase 5
--                        gate's G5-15). One language-model composition per
--                        published Brief: a two-or-three-sentence narration
--                        of the week's ranked actions in the Brief's own
--                        order, and the one-paragraph "Your week" recap.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only. One new @ctx/insights table; nothing existing is touched.
-- References only `users` (0002) and `advisory_briefs` (0032), through the
-- user-scoped composite key every Brief child carries.
--
-- ---------------------------------------------------------------------------
-- One call per Brief, by construction
-- ---------------------------------------------------------------------------
--
-- The row is claimed (`status = 'calling'`) in the same transaction that opens
-- the run, before the model is asked; `brief_narrations_brief_idx` is UNIQUE on
-- (user_id, brief_id), so a second job for the same Brief - a replay, a
-- schedule that ticked twice, a retry - finds the row and asks nothing. The
-- call's outcome is then written once onto that row: `shown` (both texts,
-- validated), `refused` (the validator's class; nothing shown), `failed` (the
-- model did not answer) or `cancelled` (a kill switch landed). None of those is
-- asked again: re-asking until the validator agrees would be
-- retry-until-valid, and the Brief's deterministic opening already stands.
--
-- `input_digest` is `advisor_runs.input_digest` of the run: the canonical
-- digest of exactly what the model was sent (the run inspector re-derives it
-- from the retained payload).

CREATE TABLE brief_narrations (
  id              UUID         PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  brief_id        UUID         NOT NULL,
  status          TEXT         NOT NULL
                               CONSTRAINT brief_narrations_status_check
                               CHECK (status IN ('calling', 'shown', 'refused', 'failed', 'cancelled')),
  narration_text  TEXT         CONSTRAINT brief_narrations_narration_check
                               CHECK (narration_text IS NULL OR char_length(narration_text) BETWEEN 1 AND 1200),
  recap_text      TEXT         CONSTRAINT brief_narrations_recap_check
                               CHECK (recap_text IS NULL OR char_length(recap_text) BETWEEN 1 AND 600),
  refusal         TEXT         CONSTRAINT brief_narrations_refusal_check
                               CHECK (refusal IS NULL OR refusal ~ '^[a-z][a-z_]{0,47}$'),
  input_digest    TEXT         NOT NULL
                               CONSTRAINT brief_narrations_digest_check
                               CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  llm_provider    TEXT         NOT NULL
                               CONSTRAINT brief_narrations_provider_check
                               CHECK (llm_provider IN ('ollama', 'openai', 'openrouter', 'anthropic')),
  llm_model       TEXT         NOT NULL
                               CONSTRAINT brief_narrations_model_check
                               CHECK (char_length(llm_model) BETWEEN 1 AND 200),
  run_id          UUID         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,

  CONSTRAINT brief_narrations_brief_fk
    FOREIGN KEY (user_id, brief_id) REFERENCES advisory_briefs (user_id, id) ON DELETE CASCADE,
  CONSTRAINT brief_narrations_shown_whole
    CHECK ((status = 'shown') = (narration_text IS NOT NULL AND recap_text IS NOT NULL)),
  CONSTRAINT brief_narrations_texts_together
    CHECK ((narration_text IS NULL) = (recap_text IS NULL)),
  CONSTRAINT brief_narrations_refusal_when_refused
    CHECK ((status = 'refused') = (refusal IS NOT NULL)),
  CONSTRAINT brief_narrations_finished
    CHECK ((status = 'calling') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX brief_narrations_brief_idx
  ON brief_narrations (user_id, brief_id);

COMMENT ON TABLE brief_narrations IS
  'WP 11.4: the Brief''s own narration and the weekly recap, one language-model call per published Brief (UNIQUE on user_id, brief_id; claimed before the call). Never asked again.';
COMMENT ON COLUMN brief_narrations.input_digest IS
  'advisor_runs.input_digest of the run: the canonical digest of what the model was sent.';
COMMENT ON COLUMN brief_narrations.refusal IS
  'The validator''s refusal class when status is refused (schema, empty, too_long, markup, link, numeral, word_figure, copy, item_reference, order); NULL otherwise.';
