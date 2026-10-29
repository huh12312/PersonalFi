-- SPDX-License-Identifier: MIT
-- 0063_merchant_name_suggestions: merchant display-name suggestions, narrow (WP 11.6;
--                                  11 §3.1's "Merchant display name for noise
--                                  descriptors" row, §4's `merchant.name`).
--
-- One new @ctx/ledger table, beside `merchants`, whose `normalized_key` it is keyed
-- on. A local model's suggestion for a NOISE merchant (the ledger's
-- `detectMerchantNoise`: the normaliser's residue still carries a processor star, a
-- hash, a reference word, a web address, a vowel-less abbreviation or words run
-- together), validated as a substring-preserving cleanup of that residue before a
-- row is written. One row per (user_id, normalized_key): a key is asked once and
-- never again — suggested, accepted, dismissed or refused.
--
-- An accepted suggestion is applied ONLY through the `user_merchant_name` overlay
-- on `transactions` (the manual rename's own write path); this table never writes
-- `merchants.display_name` or `transactions.effective_name`, and nothing here is
-- applied without the holder's Accept.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this file
-- and refuses to start if it ever changes.
--
-- Expand-only: a new table referencing only `users`. No existing table, column or
-- constraint is touched; no row is rewritten; no backfill (the nightly job fills it).

CREATE TABLE merchant_name_suggestions (
  id               UUID         PRIMARY KEY,
  user_id          UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  normalized_key   TEXT         NOT NULL
                                CONSTRAINT merchant_name_suggestions_key_check
                                CHECK (normalized_key ~ '^[a-z0-9]+$' AND char_length(normalized_key) <= 256),
  descriptor       TEXT         NOT NULL
                                CONSTRAINT merchant_name_suggestions_descriptor_check
                                CHECK (char_length(descriptor) BETWEEN 1 AND 200),
  stripped_prefix  TEXT         CONSTRAINT merchant_name_suggestions_prefix_check
                                CHECK (stripped_prefix IS NULL OR char_length(stripped_prefix) BETWEEN 1 AND 32),
  status           TEXT         NOT NULL
                                CONSTRAINT merchant_name_suggestions_status_check
                                CHECK (status IN ('suggested', 'accepted', 'dismissed', 'refused')),
  display_name     TEXT         CONSTRAINT merchant_name_suggestions_name_check
                                CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40),
  refusal_class    TEXT         CONSTRAINT merchant_name_suggestions_refusal_check
                                CHECK (refusal_class IS NULL OR refusal_class ~ '^[a-z][a-z_.]{0,47}$'),
  llm_provider     TEXT         NOT NULL
                                CONSTRAINT merchant_name_suggestions_provider_check
                                CHECK (llm_provider = 'ollama'),
  llm_model        TEXT         NOT NULL
                                CONSTRAINT merchant_name_suggestions_model_check
                                CHECK (char_length(llm_model) BETWEEN 1 AND 200),
  run_id           UUID         NOT NULL,
  input_digest     TEXT         NOT NULL
                                CONSTRAINT merchant_name_suggestions_digest_check
                                CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  suggested_at     TIMESTAMPTZ  NOT NULL,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Whole or none, per status: a name exactly when not refused, a refusal class exactly when refused,
  -- a decision instant exactly when the holder accepted or dismissed.
  CONSTRAINT merchant_name_suggestions_name_whole
    CHECK ((status = 'refused') = (display_name IS NULL)),
  CONSTRAINT merchant_name_suggestions_refusal_whole
    CHECK ((status = 'refused') = (refusal_class IS NOT NULL)),
  CONSTRAINT merchant_name_suggestions_decided_whole
    CHECK ((status IN ('accepted', 'dismissed')) = (decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX merchant_name_suggestions_key_idx
  ON merchant_name_suggestions (user_id, normalized_key);

COMMENT ON TABLE merchant_name_suggestions IS
  'WP 11.6: a local model''s display-name suggestion for one noise merchant (merchant.name), one row per (user_id, normalized_key), asked once. Accepting writes the transactions'' user_merchant_name overlay; nothing here is applied without it.';
COMMENT ON COLUMN merchant_name_suggestions.descriptor IS
  'The normaliser''s residue exactly as sent to the model; the suggestion is a substring-preserving cleanup of it.';
COMMENT ON COLUMN merchant_name_suggestions.refusal_class IS
  'The validator''s class when status is refused (schema, abstained, name.invented, name.out_of_order, name.too_long, name.markup, name.link, name.digits_only, name.unchanged, name.copy, name.empty); NULL otherwise.';
