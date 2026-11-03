-- SPDX-License-Identifier: MIT
-- 0064_market_data_consent: the holder's consent to an opt-in market-data provider
--                            (WP 12.6, D33; docs/research/14 §3 "Consent (the holder half)").
--
-- One new @ctx/integrations table, market_data_consents, in the shape of 0044's
-- narrator_provider_consents: one row per consent given; withdrawing sets withdrawn_at
-- and never deletes, so "when did I agree to what" stays answerable;
-- consent_text_version names the exact wording the holder ticked (`yahoo-consent/1`)
-- and consent_text_sha256 pins its bytes. At most one standing consent per
-- (holder, provider).
--
-- Why a new table and not 0044's: narrator_provider_consents is @ctx/insights' table,
-- and its provider CHECK names the hosted language models; widening it would put a
-- market-data consent in another context's table (schema ownership) and alter a CHECK
-- an existing release relies on. A market-data consent belongs beside market_data_runs.
--
-- The provider CHECK names `yfinance` only: it is the one market-data provider whose
-- terms need the holder's word (Yahoo publishes no data licence; research 14 §2). A
-- keyed provider's consent is the holder pasting their own key.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this file and
-- refuses to start if it ever changes.
--
-- Expand-only: a new table referencing only `users`. No existing table, column or
-- constraint is touched; no row is rewritten; no backfill (no consent exists until a
-- holder gives one).

CREATE TABLE market_data_consents (
  id                    UUID         PRIMARY KEY,
  user_id               UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider              TEXT         NOT NULL
                                     CONSTRAINT market_data_consents_provider_check
                                     CHECK (provider IN ('yfinance')),
  consent_text_version  TEXT         NOT NULL
                                     CONSTRAINT market_data_consents_version_check
                                     CHECK (consent_text_version ~ '^[a-z][a-z0-9-]*/[1-9][0-9]*$'),
  consent_text_sha256   TEXT         NOT NULL
                                     CONSTRAINT market_data_consents_sha256_check
                                     CHECK (consent_text_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  consented_at          TIMESTAMPTZ  NOT NULL,
  withdrawn_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT market_data_consents_withdrawn_after_given CHECK (
    withdrawn_at IS NULL OR withdrawn_at >= consented_at
  )
);

CREATE UNIQUE INDEX market_data_consents_standing_idx
  ON market_data_consents (user_id, provider)
  WHERE withdrawn_at IS NULL;

COMMENT ON TABLE market_data_consents IS
  'WP 12.6 (D33): the holder''s consent to an opt-in market-data provider (yfinance): the consent text version and its sha256, when given, when withdrawn. Never deleted by the product; not exported (a consent to an unofficial source is given on this install).';
