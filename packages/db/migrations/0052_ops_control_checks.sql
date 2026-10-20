-- SPDX-License-Identifier: MIT
-- 0052_ops_control_checks: the GenAI controls self-test's dated evidence rows
--                          (WP 10.16; RUNBOOK "Proving the GenAI controls").
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one new table and one index. Nothing is altered, dropped or
-- narrowed, and no existing row is touched. References only `users` (0002).
--
-- One row per press of Settings, Language model, "Run control checks" (or
-- `just genai-selftest`): the holder's active narrator provider and model at
-- the start, the per-check results, and the overall verdict -- the same
-- footing `ops_restore_drills` (0036) gives a restore drill, but per holder,
-- because the narrator, its consent and its payload approval are a holder's.
-- `results` carries facts in words and refusal classes only: never a prompt,
-- a payload, a key or a model's reply (the route and the job only ever write
-- the catalogue's own sentences).
--
-- A row is written at the start with `finished_at` and `overall` NULL (the
-- run is in progress, its checks `pending`), updated as each check finishes,
-- and closed once: `finished_at` and `overall` are set together
-- (ops_control_checks_finished_has_overall). The route's "one run per holder
-- per 10 minutes" reads `started_at` from this table, so the window survives
-- a restart.

CREATE TABLE ops_control_checks (
  id                UUID         PRIMARY KEY,
  user_id           UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  started_at        TIMESTAMPTZ  NOT NULL,
  finished_at       TIMESTAMPTZ,
  -- The holder's active narrator provider when the run started.
  provider          TEXT         NOT NULL
                                 CONSTRAINT ops_control_checks_provider_check
                                 CHECK (provider IN ('ollama', 'openai', 'openrouter', 'anthropic', 'off')),
  -- `provider:model` or the local model's `name@sha256:...`; NULL when Off or not configured.
  model             TEXT         CONSTRAINT ops_control_checks_model_check
                                 CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  -- One object per check of the catalogue, in catalogue order.
  results           JSONB        NOT NULL DEFAULT '[]'::jsonb
                                 CONSTRAINT ops_control_checks_results_is_array
                                 CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 32),
  overall           TEXT         CONSTRAINT ops_control_checks_overall_check
                                 CHECK (overall IS NULL OR overall IN ('pass', 'fail', 'partial')),
  -- The catalogue's version, e.g. 'genai-controls/1': a result is read against the checks it ran.
  evidence_version  TEXT         NOT NULL
                                 CONSTRAINT ops_control_checks_evidence_version_check
                                 CHECK (length(btrim(evidence_version)) BETWEEN 1 AND 64),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT ops_control_checks_finished_has_overall CHECK ((finished_at IS NULL) = (overall IS NULL)),
  CONSTRAINT ops_control_checks_finished_after_started CHECK (finished_at IS NULL OR finished_at >= started_at)
);

-- "The holder's latest run" (the 10-minute window, the dashboard line) and "the last 20".
CREATE INDEX ops_control_checks_user_started_idx
  ON ops_control_checks (user_id, started_at DESC);

COMMENT ON TABLE ops_control_checks IS
  'One row per GenAI controls self-test run (WP 10.16): Settings, Language model, Run control checks, or just genai-selftest. Facts in words and refusal classes only, never a prompt, payload, key or model reply.';
COMMENT ON COLUMN ops_control_checks.results IS
  'The catalogue''s checks in order: {id, status pending|running|pass|fail|skipped|reported, reason, facts[], durationMs, notApplicable}.';
COMMENT ON COLUMN ops_control_checks.overall IS
  'pass: every applicable check passed. fail: any check failed. partial: none failed but at least one could not run. NULL while the run is in progress.';
