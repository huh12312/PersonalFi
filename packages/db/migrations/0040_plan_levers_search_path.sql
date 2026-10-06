-- SPDX-License-Identifier: MIT
-- 0040_plan_levers_search_path: F-94-6 (WP 9.4, docs/evidence/phase-9/wp9.4-upgrade.md
-- §5 and §9 item 5; found by the upgrade chain's HEAD restore drill, check iv).
--
-- 0022's `plan_scenario_levers_are_well_formed` calls
-- `plan_amount_json_is_well_formed` UNQUALIFIED. A CHECK constraint holds its
-- function by OID, but a SQL-language function's body is parsed when the
-- planner inlines it, under whatever search_path is in force then -- and
-- `pg_restore` runs every COPY with an empty search_path. So from 0022 to 0036
-- a backup holding a single `plan_scenarios` row could not be restored:
-- `function plan_amount_json_is_well_formed(jsonb) does not exist`. The monthly
-- drill passed only because the drill database held no plan.
--
-- Same body as 0022, with the two inner calls schema-qualified (`public.`),
-- which keeps the function inlinable; a `SET search_path` clause would also
-- work but stops inlining. Expand-only: CREATE OR REPLACE of one function; no
-- table, no row, no constraint touched, so it is safe on the live soak install
-- and on every backup taken before it. The orchestrator's, 0040 being the
-- plan's spare number (09 §4). packages/db/test/restore-search-path.test.ts is
-- the regression: every public function names the public functions it calls
-- schema-qualified, and a baseline and a fork insert under an empty
-- search_path.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
CREATE OR REPLACE FUNCTION plan_scenario_levers_are_well_formed(levers JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(levers) IS DISTINCT FROM 'object' THEN false
    WHEN levers = '{}'::jsonb THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_each(levers) AS lever (name, setting)
      WHERE NOT (CASE lever.name
        WHEN 'retire_age' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^[0-9]{1,3}$'
        WHEN 'savings_rate' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        WHEN 'annual_spending' THEN
          public.plan_amount_json_is_well_formed(lever.setting)
        WHEN 'expected_return_shift' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        WHEN 'ss_claim_age' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^[0-9]{2,3}y([0-9]|1[01])m$'
        WHEN 'part_time_income' THEN
          CASE
            WHEN jsonb_typeof(lever.setting) IS DISTINCT FROM 'object' THEN false
            ELSE
                  (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lever.setting) AS key)
                    = ARRAY['annual', 'years']
              AND public.plan_amount_json_is_well_formed(lever.setting -> 'annual')
              AND jsonb_typeof(lever.setting -> 'years') = 'string'
              AND (lever.setting ->> 'years') ~ '^[0-9]{1,2}$'
          END
        WHEN 'one_time_windfall' THEN
          CASE
            WHEN jsonb_typeof(lever.setting) IS DISTINCT FROM 'object' THEN false
            ELSE
                  (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lever.setting) AS key)
                    = ARRAY['amount', 'on']
              AND public.plan_amount_json_is_well_formed(lever.setting -> 'amount')
              AND jsonb_typeof(lever.setting -> 'on') = 'string'
              AND (lever.setting ->> 'on') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          END
        WHEN 'glidepath' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}')
                ~ '^(age_based|target_date|rising_equity|static:(0|1|0\.[0-9]+|1\.0+))$'
        ELSE false
      END)
    )
  END;
$$;

