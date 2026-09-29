-- SPDX-License-Identifier: MIT
-- 0028_advisor_run_control: the four-level kill ladder made real for an
--                           advisor that takes minutes -- per-run cancel, the
--                           kind switch's refusal, the payload preview gate,
--                           payload retention for the run inspector, and
--                           `advisors.enabled_source` (WP 5.1; 05-phase-5-
--                           dispatch.md §3 and §4; 08 §4.4, §4.6; 03 §8.3).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- References only objects 0012_insights.sql created (`advisors`,
-- `advisor_runs`, `users`) or objects this file creates -- 05 §4's ordering
-- rule, so a fresh install applying 0028 before any other Phase 5 number
-- converges.
--
-- ---------------------------------------------------------------------------
-- advisors.enabled_source -- who last decided `enabled`
-- ---------------------------------------------------------------------------
--
-- `apps/api`'s boot pass re-registers the built-in catalogue with each
-- entry's `defaultEnabled`. Without knowing who set `enabled`, the conflict
-- branch had two wrong options: overwrite (a restart undoes the holder's own
-- switch -- what the code did until this migration) or never touch (a wave
-- released in a later phase never reaches an existing install). With it, a
-- row follows the catalogue while it is `default` and stops the moment a
-- human (`user`) or WP 5.9's dismiss-reason loop (`feedback`) decides.
--
-- Existing rows are backfilled `default`. That is the honest value, not a
-- guess: until this migration every api boot re-applied the catalogue's
-- default to every built-in row, so what each row holds today *is* the
-- default as of the last boot.

ALTER TABLE advisors
  ADD COLUMN enabled_source TEXT NOT NULL DEFAULT 'default';

ALTER TABLE advisors
  ADD CONSTRAINT advisors_enabled_source_check
  CHECK (enabled_source IN ('default', 'user', 'feedback'));

COMMENT ON COLUMN advisors.enabled_source IS
  'Who last set enabled: default (follows the catalogue on re-registration), user (a human, via the step-up route), feedback (WP 5.9). Only default rows move when the catalogue changes.';

-- ---------------------------------------------------------------------------
-- advisor_runs -- cancel, the level that ended it, and what the model was
-- ---------------------------------------------------------------------------
--
-- `cancelled` is a fifth status, distinct from `refused` (the switches said
-- no before anything was built) and `failed` (the advisor did not produce
-- usable output -- a failure the breaker counts). A cancelled run was allowed
-- to start and then stopped by a kill level while in flight, or at the write
-- barrier between the reply and the insert. It wrote nothing, and
-- `cancel_reason` names the broadest level that applied, in the same
-- vocabulary as `refusal` plus `run_cancelled` (level 4, the holder's own
-- per-run cancel). `cancel_requested_at` is set only by level 4: it is the
-- flag the run watcher polls.
--
-- `llm_model` and `llm_prompt_hash` record, for a `local_model` run, the
-- pinned model the prompt went to and the sha256 of the exact prompt bytes --
-- the run inspector's answer to "which model, and what did it see?" without
-- storing the prompt a second time (the request that produced it is retained
-- below, and re-rendering it is deterministic).

ALTER TABLE advisor_runs
  ADD COLUMN cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN cancel_reason       TEXT,
  ADD COLUMN llm_model           TEXT,
  ADD COLUMN llm_prompt_hash     TEXT;

-- 0012 declared both of these as inline column CHECKs, which Postgres names
-- `<table>_<column>_check`; the drops below name constraints that exist.
ALTER TABLE advisor_runs
  DROP CONSTRAINT advisor_runs_status_check;
ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_status_check
  CHECK (status IN ('started', 'completed', 'failed', 'refused', 'cancelled'));

-- The refusal vocabulary, widened in blast-radius order: level 1 (global,
-- module), level 2 (kind), level 3 (advisor, quarantine), then the payload
-- preview gate, which is not a level but refuses a run the same way.
ALTER TABLE advisor_runs
  DROP CONSTRAINT advisor_runs_refusal_check;
ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_refusal_check CHECK (refusal IS NULL OR refusal IN (
    'advisors_disabled', 'module_disabled', 'kind_disabled',
    'advisor_disabled', 'advisor_quarantined', 'payload_not_approved'));

ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_cancel_reason_check CHECK (cancel_reason IS NULL OR cancel_reason IN (
    'advisors_disabled', 'module_disabled', 'kind_disabled',
    'advisor_disabled', 'advisor_quarantined', 'payload_not_approved',
    'run_cancelled'));

-- A cancelled run always names its level, and only a cancelled run has one.
ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_cancelled_has_reason
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL));

-- Level 4 is a request somebody made at a moment; the other levels are not.
ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_user_cancel_was_requested
  CHECK (cancel_reason IS DISTINCT FROM 'run_cancelled' OR cancel_requested_at IS NOT NULL);

ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_llm_prompt_hash_shape
  CHECK (llm_prompt_hash IS NULL OR llm_prompt_hash ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE advisor_runs
  ADD CONSTRAINT advisor_runs_llm_model_shape
  CHECK (llm_model IS NULL OR length(btrim(llm_model)) BETWEEN 1 AND 256);

-- The composite key `advisor_run_payloads` references, so a retained payload
-- can only ever belong to a run of the same user (the 0025 pattern).
CREATE UNIQUE INDEX advisor_runs_user_id_idx ON advisor_runs (user_id, id);

COMMENT ON COLUMN advisor_runs.cancel_requested_at IS
  'Kill level 4: when the holder asked this run to stop. The run watcher polls it at most once a second.';
COMMENT ON COLUMN advisor_runs.cancel_reason IS
  'Set exactly when status = cancelled: the broadest kill level that stopped the run in flight or at the write barrier.';

-- ---------------------------------------------------------------------------
-- advisor_payload_approvals -- the preview gate (03 §8.3)
-- ---------------------------------------------------------------------------
--
-- "Show Chris the exact payload before the first send of any new query type."
-- A query shape is sha256 over the canonical
-- `{advisor_id, advisor_version, kind, sorted effective scopes,
-- prompt_template_hash}`; a `local_model` or `external` run refuses
-- `payload_not_approved` until a live row exists here for the shape the run
-- would send. A changed scope set, a new advisor version or a new prompt
-- template is a new shape, and needs a new approval.
--
-- The shape's inputs are stored beside the hash so the approvals screen can
-- say what was approved without recomputing anything; the hash is the key.
-- Revocation stamps `revoked_at` rather than deleting, for the reason
-- `snapshot_grants` does: "when did I stop allowing this?" has an answer.

CREATE TABLE advisor_payload_approvals (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id            TEXT        NOT NULL,
  query_shape           TEXT        NOT NULL CHECK (query_shape ~ '^sha256:[0-9a-f]{64}$'),
  advisor_version       TEXT        NOT NULL CHECK (length(btrim(advisor_version)) > 0),
  kind                  TEXT        NOT NULL CHECK (kind IN ('local_model', 'external')),
  scopes                TEXT[]      NOT NULL,
  prompt_template_hash  TEXT        CHECK (prompt_template_hash IS NULL
                                           OR prompt_template_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_at           TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisor_payload_approvals_advisor_fk
    FOREIGN KEY (user_id, advisor_id) REFERENCES advisors (user_id, advisor_id) ON DELETE CASCADE,
  CONSTRAINT advisor_payload_approvals_revoked_after_approved CHECK (
    revoked_at IS NULL OR revoked_at >= approved_at
  ),
  -- A local model's shape always includes its prompt template: approving a
  -- payload whose prompt nobody could see is not an approval.
  CONSTRAINT advisor_payload_approvals_local_has_template CHECK (
    kind <> 'local_model' OR prompt_template_hash IS NOT NULL
  )
);

CREATE UNIQUE INDEX advisor_payload_approvals_user_advisor_shape_idx
  ON advisor_payload_approvals (user_id, advisor_id, query_shape);

COMMENT ON TABLE advisor_payload_approvals IS
  'The payload preview gate (03 §8.3): one row per approved query shape. A local_model or external run refuses payload_not_approved without a live row for its current shape.';

-- ---------------------------------------------------------------------------
-- advisor_run_payloads -- what we sent, for 30 days, for the inspector
-- ---------------------------------------------------------------------------
--
-- The canonical request of a `local_model` or `external` run, kept so "why
-- did it say that?" is answerable. The inspector does not trust these bytes:
-- it re-digests `payload -> 'snapshot'` and compares it with
-- `advisor_runs.input_digest`, which was computed before the call and is the
-- authority. No digest is stored here for exactly that reason.
--
-- Plain JSONB, bounded to 30 days by the CHECK below and pruned by the local
-- lane before every run. 05 §6 Q5 (the `@core/secretbox` dependency on
-- `@ctx/insights`) is unanswered at this migration; with the dependency this
-- column becomes a sealed envelope in a later migration.

CREATE TABLE advisor_run_payloads (
  run_id                UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id            TEXT        NOT NULL,
  query_shape           TEXT        NOT NULL CHECK (query_shape ~ '^sha256:[0-9a-f]{64}$'),
  payload               JSONB       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_bytes         INTEGER     NOT NULL CHECK (payload_bytes > 0),
  retained_at           TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisor_run_payloads_run_fk
    FOREIGN KEY (user_id, run_id) REFERENCES advisor_runs (user_id, id) ON DELETE CASCADE,
  CONSTRAINT advisor_run_payloads_retention_bound CHECK (
    expires_at > retained_at AND expires_at <= retained_at + INTERVAL '30 days'
  )
);

CREATE INDEX advisor_run_payloads_expiry_idx
  ON advisor_run_payloads (user_id, expires_at);

COMMENT ON TABLE advisor_run_payloads IS
  'The request sent to a local_model or external advisor, retained at most 30 days for the run inspector. Verified by re-digesting against advisor_runs.input_digest, never trusted as stored.';
