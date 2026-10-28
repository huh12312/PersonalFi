-- SPDX-License-Identifier: MIT
-- 0061_advisor_sessions: Ask PersonalFi, advisor mode (WP 11.5d; 12 §2.3's
--                        six-step protocol, §4's guardrails, §5's rubric
--                        judge; D31: the advisor's own hosted consent).
--
-- Three new @ctx/insights tables:
--
--   * advisor_sessions       one row per advisor conversation: the opening
--                            question, the status machine, the holder's
--                            answers, the clarification, the gathered context
--                            object (its digest), the options, the trade-offs,
--                            the picked option, the plan, the follow-up
--                            watcher, the judge's score, the token count;
--   * advisor_session_steps  one row per model call the session made, at most
--                            one per (session, step) — UNIQUE, so a second
--                            call for a step cannot even be recorded: the
--                            step's advisor_runs id, its input digest (the
--                            payload advisor_runs digests and the inspector
--                            re-digests), the provider and model, the
--                            knowledge read, the outcome;
--   * advisor_settings       the advisor's own hosted consent (D31): a
--                            tick-box separate from the narrator's, the sha256
--                            of the exact consent text ticked. No row means
--                            unticked: the local model runs the protocol.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only. Three new tables; nothing existing is touched. References only
-- `users` (0002) and this file's own advisor_sessions.
--
-- ---------------------------------------------------------------------------
-- The status machine
-- ---------------------------------------------------------------------------
--
--   clarifying --(holder answers)--> gathering -> options -> tradeoffs
--        |                               |           |          |
--        |                               |           |          v
--        |                               |           |    awaiting_pick --(holder picks)--> planning -> tracked
--        |                               |           |          |                              |
--        +--> refused | unanswerable | failed | cancelled  <-----+------------------------------+
--
-- `clarifying` covers both the clarify call and the wait for the holder's
-- answers (clarification set, answers not yet); `awaiting_pick` the wait for
-- a pick. A question the deterministic pre-check refuses or rules out of scope
-- is written already finished and no model is asked. `tracked` is the one
-- successful end: the plan is written and a deterministic watcher follows the
-- figure it was about.

CREATE TABLE advisor_sessions (
  id                    UUID         PRIMARY KEY,
  user_id               UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  question              TEXT         NOT NULL
                                     CONSTRAINT advisor_sessions_question_check
                                     CHECK (char_length(question) BETWEEN 1 AND 500),
  status                TEXT         NOT NULL
                                     CONSTRAINT advisor_sessions_status_check
                                     CHECK (status IN ('clarifying', 'gathering', 'options', 'tradeoffs',
                                                       'awaiting_pick', 'planning', 'tracked',
                                                       'refused', 'unanswerable', 'failed', 'cancelled')),
  catalogue_version     TEXT         NOT NULL
                                     CONSTRAINT advisor_sessions_catalogue_version_check
                                     CHECK (catalogue_version ~ '^catalogue/[1-9][0-9]{0,3}$'),
  -- Step 1: { restatement, questions[<=2], assumed[] } as validated, and the refs it was sent.
  clarification         JSONB        CONSTRAINT advisor_sessions_clarification_check
                                     CHECK (clarification IS NULL OR jsonb_typeof(clarification) = 'object'),
  -- The holder's answers to the clarifying questions, in order (at most two).
  answers               JSONB        CONSTRAINT advisor_sessions_answers_check
                                     CHECK (answers IS NULL
                                            OR (jsonb_typeof(answers) = 'array'
                                                AND jsonb_array_length(answers) <= 2)),
  -- Step 2: the compiled calls, the results, the pages read and withheld.
  gathered              JSONB        CONSTRAINT advisor_sessions_gathered_check
                                     CHECK (gathered IS NULL OR jsonb_typeof(gathered) = 'object'),
  context_digest        TEXT         CONSTRAINT advisor_sessions_context_digest_check
                                     CHECK (context_digest IS NULL OR context_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Step 3: the options that survived (two to four), each backed by a result figure.
  options               JSONB        CONSTRAINT advisor_sessions_options_check
                                     CHECK (options IS NULL
                                            OR (jsonb_typeof(options) = 'array'
                                                AND jsonb_array_length(options) BETWEEN 2 AND 4)),
  -- Step 4: one entry per option, each with at least one cost.
  tradeoffs             JSONB        CONSTRAINT advisor_sessions_tradeoffs_check
                                     CHECK (tradeoffs IS NULL
                                            OR (jsonb_typeof(tradeoffs) = 'array'
                                                AND jsonb_array_length(tradeoffs) BETWEEN 2 AND 4)),
  picked_option         TEXT         CONSTRAINT advisor_sessions_picked_check
                                     CHECK (picked_option IS NULL OR picked_option ~ '^o[1-4]$'),
  -- Step 5: one to six steps, each a link to an in-app screen.
  plan                  JSONB        CONSTRAINT advisor_sessions_plan_check
                                     CHECK (plan IS NULL
                                            OR (jsonb_typeof(plan) = 'array'
                                                AND jsonb_array_length(plan) BETWEEN 1 AND 6)),
  -- Step 6: the deterministic watcher (no model): what it follows, and what it last saw.
  watcher_id            UUID,
  watcher               JSONB        CONSTRAINT advisor_sessions_watcher_check
                                     CHECK (watcher IS NULL OR jsonb_typeof(watcher) = 'object'),
  -- The rubric judge (12 §5): evidence, never a gate.
  judge_score           NUMERIC(4, 3) CONSTRAINT advisor_sessions_judge_score_check
                                     CHECK (judge_score IS NULL OR (judge_score >= 0 AND judge_score <= 1)),
  judge_run_id          UUID,
  judge_detail          JSONB        CONSTRAINT advisor_sessions_judge_detail_check
                                     CHECK (judge_detail IS NULL OR jsonb_typeof(judge_detail) = 'object'),
  judge_error           TEXT         CONSTRAINT advisor_sessions_judge_error_check
                                     CHECK (judge_error IS NULL OR judge_error ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  refusal               TEXT         CONSTRAINT advisor_sessions_refusal_check
                                     CHECK (refusal IS NULL
                                            OR refusal ~ '^(question|answer|clarify|gather|options|tradeoffs|plan)\.[a-z][a-z_.]{0,47}$'),
  unanswerable_reason   TEXT         CONSTRAINT advisor_sessions_unanswerable_check
                                     CHECK (unanswerable_reason IS NULL
                                            OR unanswerable_reason IN ('out_of_scope', 'not_computable')),
  unanswerable_topic    TEXT         CONSTRAINT advisor_sessions_topic_check
                                     CHECK (unanswerable_topic IS NULL OR unanswerable_topic ~ '^[a-z][a-z_]{0,31}$'),
  nearest_screen        TEXT         CONSTRAINT advisor_sessions_nearest_screen_check
                                     CHECK (nearest_screen IS NULL OR nearest_screen ~ '^/[a-z0-9/-]{0,63}$'),
  error_code            TEXT         CONSTRAINT advisor_sessions_error_code_check
                                     CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  -- The per-session token budget (12 §8 "Cost") and what the session has spent.
  token_budget          INTEGER      NOT NULL
                                     CONSTRAINT advisor_sessions_token_budget_check
                                     CHECK (token_budget BETWEEN 1000 AND 1000000),
  tokens_used           INTEGER      NOT NULL DEFAULT 0
                                     CONSTRAINT advisor_sessions_tokens_used_check
                                     CHECK (tokens_used >= 0),
  -- A hosted provider's hourly window as the last hosted call left it; NULL for the local model.
  hosted_window_left    INTEGER      CONSTRAINT advisor_sessions_window_check
                                     CHECK (hosted_window_left IS NULL OR hosted_window_left >= 0),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,

  CONSTRAINT advisor_sessions_user_id_key UNIQUE (user_id, id),
  -- Each outcome whole or not at all.
  CONSTRAINT advisor_sessions_refused_whole
    CHECK ((status = 'refused') = (refusal IS NOT NULL)),
  CONSTRAINT advisor_sessions_unanswerable_whole
    CHECK ((status = 'unanswerable') = (unanswerable_reason IS NOT NULL)
           AND (unanswerable_reason IS NULL) = (nearest_screen IS NULL)
           AND (unanswerable_topic IS NULL OR unanswerable_reason = 'out_of_scope')),
  CONSTRAINT advisor_sessions_error_whole
    CHECK ((status IN ('failed', 'cancelled')) = (error_code IS NOT NULL)),
  -- The protocol's order: nothing later exists without what comes before it.
  CONSTRAINT advisor_sessions_answers_after_clarify
    CHECK (answers IS NULL OR clarification IS NOT NULL),
  CONSTRAINT advisor_sessions_gathered_after_answers
    CHECK (gathered IS NULL OR answers IS NOT NULL),
  CONSTRAINT advisor_sessions_context_with_gathered
    CHECK ((context_digest IS NULL) OR gathered IS NOT NULL),
  CONSTRAINT advisor_sessions_options_after_gather
    CHECK (options IS NULL OR context_digest IS NOT NULL),
  CONSTRAINT advisor_sessions_tradeoffs_after_options
    CHECK (tradeoffs IS NULL OR options IS NOT NULL),
  CONSTRAINT advisor_sessions_pick_after_tradeoffs
    CHECK (picked_option IS NULL OR tradeoffs IS NOT NULL),
  CONSTRAINT advisor_sessions_plan_after_pick
    CHECK (plan IS NULL OR picked_option IS NOT NULL),
  CONSTRAINT advisor_sessions_tracked_whole
    CHECK ((status = 'tracked') = (plan IS NOT NULL AND watcher IS NOT NULL AND watcher_id IS NOT NULL)),
  CONSTRAINT advisor_sessions_watcher_together
    CHECK ((watcher_id IS NULL) = (watcher IS NULL)),
  CONSTRAINT advisor_sessions_judge_whole
    CHECK ((judge_score IS NULL) = (judge_detail IS NULL)
           AND (judge_score IS NULL OR judge_run_id IS NOT NULL)
           AND (judge_score IS NULL OR judge_error IS NULL)),
  CONSTRAINT advisor_sessions_finished
    CHECK ((status IN ('tracked', 'refused', 'unanswerable', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE INDEX advisor_sessions_user_created_idx
  ON advisor_sessions (user_id, created_at DESC, id DESC);

-- The follow-up job reads only the tracked sessions.
CREATE INDEX advisor_sessions_tracked_idx
  ON advisor_sessions (user_id) WHERE status = 'tracked';

CREATE TABLE advisor_session_steps (
  id                    UUID         PRIMARY KEY,
  user_id               UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id            UUID         NOT NULL,
  step                  TEXT         NOT NULL
                                     CONSTRAINT advisor_session_steps_step_check
                                     CHECK (step IN ('clarify', 'gather', 'options', 'tradeoffs', 'plan', 'judge')),
  -- The advisor_runs row the call was recorded under (written in the same transaction).
  run_id                UUID         NOT NULL,
  -- advisor_runs.input_digest: sha256 over the payload the model was sent (07 §7.3).
  input_digest          TEXT         NOT NULL
                                     CONSTRAINT advisor_session_steps_digest_check
                                     CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  llm_provider          TEXT         NOT NULL
                                     CONSTRAINT advisor_session_steps_provider_check
                                     CHECK (llm_provider IN ('ollama', 'openai', 'openrouter', 'anthropic')),
  llm_model             TEXT         NOT NULL
                                     CONSTRAINT advisor_session_steps_model_check
                                     CHECK (char_length(llm_model) BETWEEN 1 AND 200),
  egress                TEXT         NOT NULL
                                     CONSTRAINT advisor_session_steps_egress_check
                                     CHECK (egress IN ('local', 'hosted')),
  outcome               TEXT         CONSTRAINT advisor_session_steps_outcome_check
                                     CHECK (outcome IS NULL
                                            OR outcome IN ('accepted', 'refused', 'failed', 'cancelled')),
  refusal               TEXT         CONSTRAINT advisor_session_steps_refusal_check
                                     CHECK (refusal IS NULL OR refusal ~ '^[a-z][a-z_]{0,15}\.[a-z][a-z_.]{0,47}$'),
  error_code            TEXT         CONSTRAINT advisor_session_steps_error_code_check
                                     CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  knowledge_read        JSONB        CONSTRAINT advisor_session_steps_knowledge_read_check
                                     CHECK (knowledge_read IS NULL OR jsonb_typeof(knowledge_read) = 'object'),
  tokens                INTEGER      CONSTRAINT advisor_session_steps_tokens_check
                                     CHECK (tokens IS NULL OR tokens >= 0),
  duration_ms           INTEGER      CONSTRAINT advisor_session_steps_duration_check
                                     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,

  CONSTRAINT advisor_session_steps_session_fk
    FOREIGN KEY (user_id, session_id) REFERENCES advisor_sessions (user_id, id) ON DELETE CASCADE,
  -- One model call per step: the claim is this row, and there is room for one.
  CONSTRAINT advisor_session_steps_one_per_step UNIQUE (session_id, step),
  CONSTRAINT advisor_session_steps_refused_whole
    CHECK ((outcome = 'refused') = (refusal IS NOT NULL)),
  CONSTRAINT advisor_session_steps_finished_whole
    CHECK ((outcome IS NULL) = (finished_at IS NULL))
);

CREATE INDEX advisor_session_steps_user_session_idx
  ON advisor_session_steps (user_id, session_id);

CREATE TABLE advisor_settings (
  user_id                   UUID         PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- Which hosted provider the advisor uses when the box is ticked; NULL = the narrator's own.
  hosted_provider           TEXT         CONSTRAINT advisor_settings_provider_check
                                         CHECK (hosted_provider IS NULL
                                                OR hosted_provider IN ('openai', 'openrouter', 'anthropic')),
  hosted_consented_at       TIMESTAMPTZ,
  hosted_consent_text_hash  TEXT         CONSTRAINT advisor_settings_consent_hash_check
                                         CHECK (hosted_consent_text_hash IS NULL
                                                OR hosted_consent_text_hash ~ '^sha256:[0-9a-f]{64}$'),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT advisor_settings_consent_whole
    CHECK ((hosted_consented_at IS NULL) = (hosted_consent_text_hash IS NULL))
);
