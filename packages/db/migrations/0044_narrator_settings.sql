-- SPDX-License-Identifier: MIT
-- 0044_narrator_settings: the language model in Settings -- the local model or
--                         a hosted provider with the holder's own key (WP 10.6;
--                         docs/evidence/phase-10/wp10.6-language-model-settings.md;
--                         decision D30, which revises D22).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only, as every Phase 9/10 migration must be: one CHECK re-declared
-- **wider** (a DROP and an ADD of the same name in this one transaction, the
-- shape 0029, 0042 and 0043 used), two new nullable columns on
-- advisor_payload_approvals, and two new tables. Nothing is dropped from the
-- data, renamed or narrowed; every row valid before this migration is valid
-- after. References only users (0002), provider_credentials (0041/0043) and
-- advisor_payload_approvals (0028).
--
-- ---------------------------------------------------------------------------
-- 1. provider_credentials holds a language-model key
-- ---------------------------------------------------------------------------
--
-- openai, openrouter and anthropic: the holder's own API key for a hosted
-- provider; ollama: an optional bearer token, for an Ollama endpoint behind a
-- proxy that asks for one. Same custody and shape as 0043's market-data keys:
-- secret_sealed is the key's SecretBox envelope, client_id_sealed the envelope
-- of a fixed sentinel, env NULL (provider_credentials_env_by_provider already
-- requires that of every provider but plaid), client_id_hint the last four
-- characters of a key at least 16 characters long. Never returned, logged or
-- exported.

ALTER TABLE provider_credentials
  DROP CONSTRAINT provider_credentials_provider_check;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
    CHECK (provider IN ('plaid', 'tiingo', 'fred', 'coingecko', 'openfigi',
                        'openai', 'openrouter', 'anthropic', 'ollama'));

COMMENT ON TABLE provider_credentials IS
  'A holder''s provider API credentials: Plaid''s client id and secret, the tiingo / fred / coingecko / openfigi market-data keys (WP 10.4), and the openai / openrouter / anthropic language-model keys and an optional ollama bearer token (WP 10.6). SecretBox envelopes, AAD-bound to (provider_credentials, column, user_id.provider). Never exported.';

-- ---------------------------------------------------------------------------
-- 2. narrator_settings: which model narrates, one row per holder
-- ---------------------------------------------------------------------------
--
-- No row is today's behaviour: the local model from the operator's
-- LOCAL_MODEL_* environment when it is configured, otherwise no narrator.
--
--   active_provider   ollama | openai | openrouter | anthropic | off. A hosted
--                     provider is made active only with a standing consent row
--                     for it (section 3) -- enforced by the route, which also
--                     revokes every standing payload approval of the narrator
--                     so the holder re-approves under the new provider.
--   <provider>_model  the model id for a hosted provider; NULL means the
--                     product's default for that provider.
--   ollama_*          a local endpoint, model name and sha256 digest pin set in
--                     Settings, used only when the operator's environment does
--                     not configure the local model (the environment wins).
--                     All three or none.

CREATE TABLE narrator_settings (
  user_id           UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  active_provider   TEXT        NOT NULL
                                CHECK (active_provider IN ('ollama', 'openai', 'openrouter', 'anthropic', 'off')),
  openai_model      TEXT        CHECK (openai_model IS NULL OR openai_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
  openrouter_model  TEXT        CHECK (openrouter_model IS NULL OR openrouter_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
  anthropic_model   TEXT        CHECK (anthropic_model IS NULL OR anthropic_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
  ollama_endpoint   TEXT        CHECK (ollama_endpoint IS NULL OR length(ollama_endpoint) BETWEEN 1 AND 512),
  ollama_model      TEXT        CHECK (ollama_model IS NULL OR ollama_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
  ollama_digest     TEXT        CHECK (ollama_digest IS NULL OR ollama_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT narrator_settings_ollama_all_or_none CHECK (
    (ollama_endpoint IS NULL) = (ollama_model IS NULL)
    AND (ollama_model IS NULL) = (ollama_digest IS NULL)
  )
);

COMMENT ON TABLE narrator_settings IS
  'Which language model narrates the Brief for this holder (WP 10.6, D30). No row: the operator''s LOCAL_MODEL_* environment, as before. Not exported (a reasoned deferral: a consent to send data to a vendor is given on this install).';

-- ---------------------------------------------------------------------------
-- 3. narrator_provider_consents: the holder's consent, per hosted provider
-- ---------------------------------------------------------------------------
--
-- One row per consent given; withdrawing sets withdrawn_at and never deletes,
-- so "when did I agree to what" stays answerable. consent_text_version names
-- the exact wording the holder ticked (the route refuses a version it does not
-- show); consent_text_sha256 pins its bytes. At most one standing consent per
-- (holder, provider).

CREATE TABLE narrator_provider_consents (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider              TEXT        NOT NULL CHECK (provider IN ('openai', 'openrouter', 'anthropic')),
  consent_text_version  TEXT        NOT NULL CHECK (length(btrim(consent_text_version)) > 0),
  consent_text_sha256   TEXT        NOT NULL CHECK (consent_text_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  consented_at          TIMESTAMPTZ NOT NULL,
  withdrawn_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT narrator_provider_consents_withdrawn_after_given CHECK (
    withdrawn_at IS NULL OR withdrawn_at >= consented_at
  )
);

CREATE UNIQUE INDEX narrator_provider_consents_standing_idx
  ON narrator_provider_consents (user_id, provider)
  WHERE withdrawn_at IS NULL;

COMMENT ON TABLE narrator_provider_consents IS
  'The holder''s consent to send the narrator''s minimised, previewed and approved payload to one hosted provider (WP 10.6, D30): the consent text version and its sha256, when given, when withdrawn. Never deleted by the product; not exported.';

-- ---------------------------------------------------------------------------
-- 4. advisor_payload_approvals records the model it was given for
-- ---------------------------------------------------------------------------
--
-- An approval is already keyed to a query shape whose prompt template hash
-- covers the provider and model (a hosted provider's template hash includes
-- both), so a switch needs a new approval. These two columns say, in words,
-- which provider and model the holder approved the payload for. NULL on every
-- row written before this migration.

ALTER TABLE advisor_payload_approvals
  ADD COLUMN llm_provider TEXT
    CHECK (llm_provider IS NULL OR llm_provider IN ('ollama', 'openai', 'openrouter', 'anthropic')),
  ADD COLUMN llm_model TEXT
    CHECK (llm_model IS NULL OR length(llm_model) BETWEEN 1 AND 200);

COMMENT ON COLUMN advisor_payload_approvals.llm_provider IS
  'The language-model provider the payload was approved for (WP 10.6). NULL before 0044 and for an external advisor.';
COMMENT ON COLUMN advisor_payload_approvals.llm_model IS
  'The model the payload was approved for, as the run records it (name@sha256:digest for the local model, provider:model for a hosted one). NULL before 0044.';
