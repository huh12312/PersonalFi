-- SPDX-License-Identifier: MIT
-- 0021_plan_assumptions: a user's assumption overrides, stored as a delta
--                        against a named assumptions-file version (WP 4.2;
--                        07 §5.5, §7.3 and Appendix A; decisions D3, D6).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- One table, owned by @ctx/planning
-- ---------------------------------------------------------------------------
--
--   plan_assumptions   @ctx/planning — one row per user
--
-- The defaults are not in the database at all. They live in one checked-in,
-- cited, versioned file — `packages/contexts/planning/data/assumptions.ts` and
-- its year-keyed `data/us-2026.ts` — whose version is the SHA-256 of its
-- validated content (`assumptionsVersion()` in `src/assumptions.ts`). This
-- table stores only what a user changed, and the version it was changed
-- against.
--
-- ---------------------------------------------------------------------------
-- A delta, never a copy (the dispatch's rule, and why)
-- ---------------------------------------------------------------------------
--
-- "An override that silently pins a stale default is worse than no override."
-- If this column held a copy of the defaults, every default a user never
-- touched would be frozen at the day they first saved, and a corrected
-- contribution limit or a revised capital-market assumption would never reach
-- them — invisibly, because the stored copy looks like a choice. So:
--
--   1. `diffOverrides` in `src/assumptions.ts` drops every override equal to
--      the default it would replace before anything is written.
--   2. `plan_assumptions_deltas_are_a_delta` (below) refuses anything but a
--      flat JSON object of dotted path to decimal *string*. A copy of the file
--      — nested objects, bracket arrays, `{minor, currency}` pairs, citations —
--      cannot be expressed in the column at all, and a JSON number is refused
--      for the reason 0017 gives: D3 does not stop at the serialisation edge.
--   3. `assumptions_version` names the file the delta was computed against. A
--      delta is only meaningful against that file; `resolveOverrides` refuses
--      a version the build does not hold rather than re-applying the delta to
--      today's file (UnknownAssumptionsVersion, 409 domain). That is what makes
--      07 §7.3's "why did it say $720?" answerable six months later.
--
-- One row per user (`plan_assumptions_one_per_user_idx`): a save replaces the
-- whole override set (PUT semantics) and `planning.AssumptionsOverridden` is
-- the history. What-if deltas for a scenario are WP 4.6's `plan_scenarios`,
-- not this table.
--
-- ---------------------------------------------------------------------------
-- Why no macro table (WP 3.4 open item, decided here)
-- ---------------------------------------------------------------------------
--
-- WP 3.4 asked whether FRED's CPI and Treasury yields need a
-- `macro_observations` table. WP 4.2 decides no, for now: the figures the
-- assumptions surface cites (a current CPI and a current 10-year yield with a
-- date beside them) are dated constants in the assumptions file. A table would
-- make the file's version depend on database state, so one version could mean
-- two different sets of numbers on two installs. The reasoning, and the
-- condition under which a table becomes the right answer, are in
-- docs/evidence/phase-4/wp4.2-assumptions.md.

CREATE FUNCTION plan_assumption_deltas_are_well_formed(deltas JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(deltas) = 'object'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_each(deltas) AS entry (path, delta)
       WHERE entry.path !~ '^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$'
          OR jsonb_typeof(entry.delta) IS DISTINCT FROM 'string'
          OR (entry.delta #>> '{}') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
     );
$$;

COMMENT ON FUNCTION plan_assumption_deltas_are_well_formed(JSONB) IS
  'WP 4.2 as a CHECK: plan_assumptions.deltas is a flat JSON object of dotted assumption path to a decimal string. A copy of the defaults (nested objects, arrays, citations) and a JSON number are both refused.';

CREATE TABLE plan_assumptions (
  id                   UUID        PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- `sha256:` + 64 lowercase hex: the content hash of the assumptions file the
  -- delta was computed against. Never a label a human can reuse for different
  -- content.
  assumptions_version  TEXT        NOT NULL
    CONSTRAINT plan_assumptions_version_is_a_content_hash
      CHECK (assumptions_version ~ '^sha256:[0-9a-f]{64}$'),

  -- Only the paths that differ from the default. `{}` means every assumption
  -- is on its default, and is a legitimate row: it records that the user
  -- cleared their overrides, against which version.
  deltas               JSONB       NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT plan_assumptions_deltas_are_a_delta
      CHECK (plan_assumption_deltas_are_well_formed(deltas)),

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT plan_assumptions_updated_after_created CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX plan_assumptions_one_per_user_idx
  ON plan_assumptions (user_id);

COMMENT ON TABLE plan_assumptions IS
  'WP 4.2: a user''s assumption overrides as a delta against a named assumptions-file version (content hash). The defaults live in packages/contexts/planning/data/, never here. One row per user; planning.AssumptionsOverridden is the history.';

COMMENT ON COLUMN plan_assumptions.deltas IS
  'Dotted path to decimal string, only where the user differs from the default. Never a copy of the defaults: an unchanged default must keep following the file.';
