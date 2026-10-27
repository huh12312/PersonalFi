-- SPDX-License-Identifier: MIT
-- 0055_category_suggestions: a language model's category suggestion for the
--                            abstained residue, stored beside the working that
--                            abstained, never as an assignment (WP 11.2;
--                            11 §3.1's residue row, §6 items 1, 2 and 4).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only. Four nullable columns on 0053's `category_abstentions` and three
-- new @ctx/categorization tables. Nothing is dropped, narrowed or rewritten;
-- every existing row keeps its values and reads NULL in the new columns.
-- References only `users` (0002) and `categories` (0006).
--
-- ---------------------------------------------------------------------------
-- Why the suggestion lives on the abstention row
-- ---------------------------------------------------------------------------
--
-- A suggestion is not an assignment (04 §5.2: "never silently apply"). Putting
-- it in `category_assignments` would make it an answer to "what category is
-- this?" for every reader of that table -- budgets, reports, the export -- and
-- 0006's source CHECK has no 'model' for a reason. The abstention row is the
-- one place that already means "uncategorised, and here is why"; the
-- suggestion is one more line of that "why". It is deleted with the row the
-- moment an assignment is written (a rule, a pick, a learned default), which is
-- what "a suggestion for a merchant the holder later rules is cleared" means.
-- `suggested_category_id` is a REFERENCES clause: both tables are this
-- context's, and a category deleted (never done: they are archived) must not
-- leave a dangling suggestion.

ALTER TABLE category_abstentions
  ADD COLUMN suggested_category_id UUID         NULL REFERENCES categories (id) ON DELETE SET NULL,
  ADD COLUMN suggestion_reason     TEXT         NULL
                                   CONSTRAINT category_abstentions_reason_len
                                   CHECK (suggestion_reason IS NULL OR char_length(suggestion_reason) BETWEEN 1 AND 140),
  -- `advisor_runs.id` of the categorize.suggest run that produced it. @ctx/insights' table: no REFERENCES (D8).
  ADD COLUMN suggestion_run_id     UUID         NULL,
  ADD COLUMN suggested_at          TIMESTAMPTZ  NULL,
  ADD CONSTRAINT category_abstentions_suggestion_whole
    CHECK ((suggested_category_id IS NULL) = (suggestion_reason IS NULL)
       AND (suggested_category_id IS NULL) = (suggested_at IS NULL));

-- ---------------------------------------------------------------------------
-- The merchant cache: a merchant is asked about once per taxonomy version
-- ---------------------------------------------------------------------------
--
-- `merchant_key` is the normaliser's fingerprint of the cleaned descriptor --
-- the payee tokens the model was shown, joined -- never a raw descriptor.
-- `taxonomy_version` is a digest over the holder's assignable categories (id,
-- key, label): renaming or adding a category is a new version and the merchant
-- may be asked again; nothing else re-asks. `verdict` records what came back:
-- a suggestion, the model's own abstention, or a refusal by the validator
-- (`refusal` names the class) -- a refused answer is cached too, so a merchant
-- whose name talks the model into an unknown key is not re-sent every sync.
-- `rejected_at` is the holder's "Not this": the negative example. It stops the
-- cached suggestion from being shown again for that merchant and touches
-- nothing in the classifier (its abstain floor is unaffected).

CREATE TABLE category_suggestion_cache (
  id                UUID         PRIMARY KEY,
  user_id           UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  merchant_key      TEXT         NOT NULL CHECK (char_length(merchant_key) BETWEEN 1 AND 256),
  taxonomy_version  TEXT         NOT NULL CHECK (char_length(taxonomy_version) BETWEEN 1 AND 128),
  -- `name@sha256:…` or `provider:model`: which model answered.
  model             TEXT         NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  verdict           TEXT         NOT NULL CHECK (verdict IN ('suggested', 'abstained', 'refused')),
  category_id       UUID         NULL REFERENCES categories (id) ON DELETE SET NULL,
  reason            TEXT         NULL CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 140),
  refusal           TEXT         NULL CHECK (refusal IS NULL OR char_length(refusal) BETWEEN 1 AND 64),
  run_id            UUID         NULL,
  rejected_at       TIMESTAMPTZ  NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT category_suggestion_cache_verdict_shape CHECK (
    (verdict = 'suggested' AND category_id IS NOT NULL AND reason IS NOT NULL AND refusal IS NULL)
    OR (verdict = 'abstained' AND category_id IS NULL AND refusal IS NULL)
    OR (verdict = 'refused' AND category_id IS NULL AND refusal IS NOT NULL))
);

CREATE UNIQUE INDEX category_suggestion_cache_merchant_idx
  ON category_suggestion_cache (user_id, merchant_key, taxonomy_version);

-- ---------------------------------------------------------------------------
-- The precision gate's measurements
-- ---------------------------------------------------------------------------
--
-- One row per "Measure": the gold-set replay with the model as a seventh tier
-- on the residue the six tiers abstain on (leave-one-merchant-out over the
-- holder's own hand-filed history), scored against the holder's pick. The
-- Enable switch reads the latest completed row: precision >= 0.85 over >= 20
-- scored rows, for the model currently chosen. A measurement writes this row
-- and nothing else.

CREATE TABLE category_suggestion_evals (
  id             UUID          PRIMARY KEY,
  user_id        UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Which pinned model was measured: the narrator's, or LOCAL_MODEL_CLASSIFIER_*.
  model_choice   TEXT          NOT NULL CHECK (model_choice IN ('narrator', 'classifier')),
  model          TEXT          NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  model_digest   TEXT          NULL CHECK (model_digest IS NULL OR char_length(model_digest) <= 80),
  status         TEXT          NOT NULL CHECK (status IN ('completed', 'failed')),
  failure        TEXT          NULL CHECK (failure IS NULL OR char_length(failure) <= 64),
  -- The holder's hand-filed transactions replayed, and how many the six tiers abstained on.
  gold_total     INTEGER       NOT NULL CHECK (gold_total >= 0),
  residue        INTEGER       NOT NULL CHECK (residue >= 0),
  -- Residue rows the model was asked about (one representative per merchant, scored on every row).
  asked          INTEGER       NOT NULL CHECK (asked >= 0),
  -- Rows the model placed (a validated suggestion) and of those, how many matched the pick.
  scored         INTEGER       NOT NULL CHECK (scored >= 0),
  correct        INTEGER       NOT NULL CHECK (correct >= 0 AND correct <= scored),
  abstained      INTEGER       NOT NULL CHECK (abstained >= 0),
  refused        INTEGER       NOT NULL CHECK (refused >= 0),
  precision_ratio NUMERIC(5,4) NULL CHECK (precision_ratio IS NULL OR precision_ratio BETWEEN 0 AND 1),
  coverage_ratio NUMERIC(5,4)  NULL CHECK (coverage_ratio IS NULL OR coverage_ratio BETWEEN 0 AND 1),
  -- `[{expected, got, count}]`, category keys only, most frequent first, at most ten.
  confusions     JSONB         NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(confusions) = 'array'),
  -- `sha256:` per batch sent, so the measurement's payloads are identifiable without being kept.
  batch_digests  JSONB         NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(batch_digests) = 'array'),
  duration_ms    INTEGER       NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  measured_at    TIMESTAMPTZ   NOT NULL,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX category_suggestion_evals_latest_idx
  ON category_suggestion_evals (user_id, model_choice, measured_at DESC);

-- ---------------------------------------------------------------------------
-- The holder's choices: which model, and the separate hosted consent
-- ---------------------------------------------------------------------------
--
-- D22 / 11 §6 item 1: categorisation runs on the local model only. A hosted
-- provider may be used only under a consent separate from the narrator's,
-- whose text says that merchant names leave this machine. Shipped unticked:
-- no row means the narrator's pinned local model and no hosted consent.
-- `hosted_consent_text_hash` is the sha256 of the exact text consented to, so a
-- reworded consent is not covered by an old tick. The Enable switch is not
-- here: it is kill level 3, `advisors.enabled` for `categorize.suggest`.

CREATE TABLE category_suggestion_settings (
  user_id                   UUID         PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  model_choice              TEXT         NOT NULL DEFAULT 'narrator'
                                         CHECK (model_choice IN ('narrator', 'classifier')),
  hosted_consented_at       TIMESTAMPTZ  NULL,
  hosted_consent_text_hash  TEXT         NULL CHECK (hosted_consent_text_hash IS NULL OR char_length(hosted_consent_text_hash) <= 80),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT category_suggestion_settings_consent_whole
    CHECK ((hosted_consented_at IS NULL) = (hosted_consent_text_hash IS NULL))
);
