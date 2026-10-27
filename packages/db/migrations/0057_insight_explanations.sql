-- SPDX-License-Identifier: MIT
-- 0057_insight_explanations: "Explain this" (WP 11.3; 11 §3.2's Explain-this
--                            row, §4's `insight.explain`). A language model's
--                            short explanation of one insight or one health
--                            pillar, computed once per evidence digest.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only. One new @ctx/insights table; nothing existing is touched.
-- References only `users` (0002).
--
-- ---------------------------------------------------------------------------
-- The cache, and why nothing is ever deleted from it
-- ---------------------------------------------------------------------------
--
-- `evidence_digest` is `advisor_runs.input_digest` of the run that wrote the
-- row: the canonical digest of exactly what the model was sent (the rule's
-- text, the evidence rows as the evidence panel resolves them, the insight's
-- own figures; for a pillar, its ladder in words, its inputs and its bands).
-- One row per (holder, entity, digest): the same evidence is explained once
-- and the answer reused. A changed evidence set is a new digest and a new
-- row; the old one stays, so "what did the model say about this finding, and
-- what was it shown" has an answer for the audit. Dismissing an insight
-- deletes nothing here.
--
-- A refusal is cached too (`explanation_text` NULL, `refusal` the validator's
-- class): re-asking the same model about the same evidence until the
-- validator agrees would be retry-until-valid (WP 5.3's rule). A run that
-- failed (the model did not answer) writes no row and may be asked again.
--
-- `entity_id` is the insight's id, or the pillar's component id
-- (`emergency_fund_months`, …): text, with no foreign key, because a pillar
-- is not a row and an insight's explanation must outlive its insight's
-- dismissal and expiry.

CREATE TABLE insight_explanations (
  id                UUID         PRIMARY KEY,
  user_id           UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity_kind       TEXT         NOT NULL
                                 CONSTRAINT insight_explanations_entity_kind_check
                                 CHECK (entity_kind IN ('insight', 'health_pillar')),
  entity_id         TEXT         NOT NULL
                                 CONSTRAINT insight_explanations_entity_id_check
                                 CHECK (char_length(entity_id) BETWEEN 1 AND 64),
  evidence_digest   TEXT         NOT NULL
                                 CONSTRAINT insight_explanations_digest_check
                                 CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  explanation_text  TEXT         CONSTRAINT insight_explanations_text_check
                                 CHECK (explanation_text IS NULL OR char_length(explanation_text) BETWEEN 1 AND 900),
  refusal           TEXT         CONSTRAINT insight_explanations_refusal_check
                                 CHECK (refusal IS NULL OR refusal ~ '^[a-z][a-z_]{0,47}$'),
  llm_provider      TEXT         NOT NULL
                                 CONSTRAINT insight_explanations_provider_check
                                 CHECK (llm_provider IN ('ollama', 'openai', 'openrouter', 'anthropic')),
  llm_model         TEXT         NOT NULL
                                 CONSTRAINT insight_explanations_model_check
                                 CHECK (char_length(llm_model) BETWEEN 1 AND 200),
  run_id            UUID         NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT insight_explanations_text_or_refusal
    CHECK ((explanation_text IS NULL) <> (refusal IS NULL))
);

CREATE UNIQUE INDEX insight_explanations_digest_idx
  ON insight_explanations (user_id, entity_kind, entity_id, evidence_digest);

CREATE INDEX insight_explanations_entity_idx
  ON insight_explanations (user_id, entity_kind, entity_id, created_at DESC);

COMMENT ON TABLE insight_explanations IS
  'WP 11.3 "Explain this": one model explanation (or its refusal class) per holder, entity and evidence digest. Never deleted on dismissal; a new digest is a new row.';
COMMENT ON COLUMN insight_explanations.evidence_digest IS
  'advisor_runs.input_digest of the run that wrote the row: the canonical digest of what the model was sent.';
COMMENT ON COLUMN insight_explanations.refusal IS
  'The validator''s refusal class when the reply was refused (numeral, word_figure, copy, markup, link, too_long, empty, schema); NULL when explanation_text is set.';
