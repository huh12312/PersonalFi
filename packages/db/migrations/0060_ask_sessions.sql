-- SPDX-License-Identifier: MIT
-- 0060_ask_sessions: Ask PersonalFi, reporting mode (WP 11.5c; 11 §3.2's
--                    "Ask PersonalFi" row, "model as a compiler, not an
--                    oracle"; 12 §2.1-§2.3, §4, §5). One row per question the
--                    holder asks: the question, the catalogue calls a model
--                    compiled it into, every result's digest and figures, the
--                    narration or the refusal class, the provider and model,
--                    what was read from the knowledge base, and timings.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only. One new @ctx/insights table; nothing existing is touched.
-- References only `users` (0002).
--
-- ---------------------------------------------------------------------------
-- The status machine
-- ---------------------------------------------------------------------------
--
--   compiling -> running -> narrating -> shown
--        |           |           |------> refused      (the narration's checks; the
--        |           |           |                     results stand, as arithmetic)
--        |           |           |------> failed / cancelled
--        |           |------------------> unanswerable (no call answered)
--        |------------------------------> refused / unanswerable / failed / cancelled
--
-- A question the deterministic pre-check refuses (an instruction, a merchant
-- pseudonym) or rules out of scope (security selection, timing, tax filing,
-- insurance, estate, an execution) is written already finished, `refused` or
-- `unanswerable`, and no model is asked.
--
-- One model call per step: `compile_run_id` and `narrate_run_id` are each
-- claimed (written once, under the advisor row's lock) before the call; a job
-- that finds a step already claimed asks nothing.
--
-- `compile_input_digest` / `narrate_input_digest` are `advisor_runs.input_digest`
-- of the two runs: the canonical digest of exactly what each model call was
-- sent (the run inspector re-derives it from the retained payload).

CREATE TABLE ask_sessions (
  id                    UUID         PRIMARY KEY,
  user_id               UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question              TEXT         NOT NULL
                                     CONSTRAINT ask_sessions_question_check
                                     CHECK (char_length(question) BETWEEN 1 AND 500),
  status                TEXT         NOT NULL
                                     CONSTRAINT ask_sessions_status_check
                                     CHECK (status IN ('compiling', 'running', 'narrating', 'shown',
                                                       'refused', 'unanswerable', 'failed', 'cancelled')),
  catalogue_version     TEXT         NOT NULL
                                     CONSTRAINT ask_sessions_catalogue_version_check
                                     CHECK (catalogue_version ~ '^catalogue/[1-9][0-9]{0,3}$'),
  compiled_calls        JSONB        CONSTRAINT ask_sessions_calls_check
                                     CHECK (compiled_calls IS NULL
                                            OR (jsonb_typeof(compiled_calls) = 'array'
                                                AND jsonb_array_length(compiled_calls) <= 4)),
  results               JSONB        CONSTRAINT ask_sessions_results_check
                                     CHECK (results IS NULL
                                            OR (jsonb_typeof(results) = 'array'
                                                AND jsonb_array_length(results) <= 4)),
  narration_text        TEXT         CONSTRAINT ask_sessions_narration_check
                                     CHECK (narration_text IS NULL OR char_length(narration_text) BETWEEN 1 AND 900),
  refusal               TEXT         CONSTRAINT ask_sessions_refusal_check
                                     CHECK (refusal IS NULL OR refusal ~ '^(question|compile|narrate)\.[a-z][a-z_.]{0,47}$'),
  unanswerable_reason   TEXT         CONSTRAINT ask_sessions_unanswerable_check
                                     CHECK (unanswerable_reason IS NULL
                                            OR unanswerable_reason IN ('out_of_scope', 'not_computable')),
  unanswerable_topic    TEXT         CONSTRAINT ask_sessions_topic_check
                                     CHECK (unanswerable_topic IS NULL OR unanswerable_topic ~ '^[a-z][a-z_]{0,31}$'),
  nearest_screen        TEXT         CONSTRAINT ask_sessions_nearest_screen_check
                                     CHECK (nearest_screen IS NULL OR nearest_screen ~ '^/[a-z0-9/-]{0,63}$'),
  error_code            TEXT         CONSTRAINT ask_sessions_error_code_check
                                     CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  llm_provider          TEXT         CONSTRAINT ask_sessions_provider_check
                                     CHECK (llm_provider IS NULL
                                            OR llm_provider IN ('ollama', 'openai', 'openrouter', 'anthropic')),
  llm_model             TEXT         CONSTRAINT ask_sessions_model_check
                                     CHECK (llm_model IS NULL OR char_length(llm_model) BETWEEN 1 AND 200),
  compile_run_id        UUID,
  narrate_run_id        UUID,
  compile_input_digest  TEXT         CONSTRAINT ask_sessions_compile_digest_check
                                     CHECK (compile_input_digest IS NULL OR compile_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  narrate_input_digest  TEXT         CONSTRAINT ask_sessions_narrate_digest_check
                                     CHECK (narrate_input_digest IS NULL OR narrate_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  knowledge_read        JSONB        CONSTRAINT ask_sessions_knowledge_read_check
                                     CHECK (knowledge_read IS NULL OR jsonb_typeof(knowledge_read) = 'object'),
  compile_ms            INTEGER      CONSTRAINT ask_sessions_compile_ms_check
                                     CHECK (compile_ms IS NULL OR compile_ms >= 0),
  calls_ms              INTEGER      CONSTRAINT ask_sessions_calls_ms_check
                                     CHECK (calls_ms IS NULL OR calls_ms >= 0),
  narrate_ms            INTEGER      CONSTRAINT ask_sessions_narrate_ms_check
                                     CHECK (narrate_ms IS NULL OR narrate_ms >= 0),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,

  -- Each outcome whole or not at all.
  CONSTRAINT ask_sessions_shown_whole
    CHECK ((status = 'shown') = (narration_text IS NOT NULL)),
  CONSTRAINT ask_sessions_refused_whole
    CHECK ((status = 'refused') = (refusal IS NOT NULL)),
  CONSTRAINT ask_sessions_unanswerable_whole
    CHECK ((status = 'unanswerable') = (unanswerable_reason IS NOT NULL)
           AND (unanswerable_reason IS NULL) = (nearest_screen IS NULL)
           AND (unanswerable_topic IS NULL OR unanswerable_reason = 'out_of_scope')),
  CONSTRAINT ask_sessions_error_whole
    CHECK ((status IN ('failed', 'cancelled')) = (error_code IS NOT NULL)),
  CONSTRAINT ask_sessions_model_together
    CHECK ((llm_provider IS NULL) = (llm_model IS NULL)),
  -- A step's run is claimed with its digest and the model it asked.
  CONSTRAINT ask_sessions_compile_claim_whole
    CHECK ((compile_run_id IS NULL) = (compile_input_digest IS NULL)
           AND (compile_run_id IS NULL OR llm_provider IS NOT NULL)),
  CONSTRAINT ask_sessions_narrate_claim_whole
    CHECK ((narrate_run_id IS NULL) = (narrate_input_digest IS NULL)
           AND (narrate_run_id IS NULL OR compile_run_id IS NOT NULL)),
  CONSTRAINT ask_sessions_narration_has_run
    CHECK (narration_text IS NULL OR (narrate_run_id IS NOT NULL AND results IS NOT NULL)),
  CONSTRAINT ask_sessions_results_after_compile
    CHECK (results IS NULL OR compiled_calls IS NOT NULL),
  CONSTRAINT ask_sessions_finished
    CHECK ((status IN ('compiling', 'running', 'narrating')) = (finished_at IS NULL))
);

CREATE INDEX ask_sessions_user_created_idx
  ON ask_sessions (user_id, created_at DESC, id DESC);

COMMENT ON TABLE ask_sessions IS
  'WP 11.5c: Ask PersonalFi, reporting mode. One row per question: the compiled catalogue calls, each result''s digest and figures, the narration or the refusal class, the provider and model, knowledge read records and timings. At most one model call per step (compile, narrate), each its own advisor_runs row.';
COMMENT ON COLUMN ask_sessions.results IS
  'Per compiled call: the function, its arguments, ok | not_available | refused, the catalogue envelope''s input_digest and a digest of the whole envelope, and the figures as the app rendered them (label, text, source_refs).';
COMMENT ON COLUMN ask_sessions.refusal IS
  'The refusal class when status is refused, prefixed by the step that refused: question.* (the deterministic pre-check), compile.* or narrate.*; NULL otherwise.';
COMMENT ON COLUMN ask_sessions.knowledge_read IS
  'personalfi.knowledge-read/1 (WP 11.5a): the playbook pages and parameters the narration was sent, and the ones it cited.';
