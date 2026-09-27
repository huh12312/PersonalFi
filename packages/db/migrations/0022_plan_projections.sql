-- SPDX-License-Identifier: MIT
-- 0022_plan_projections: saved scenarios, life events, projection runs and
--                        their percentile bands (WP 4.6; 04 §5.6, 07 §5.10
--                        and R6, 08 §7.2; decisions D3, D6 and D20).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Four tables, all @ctx/planning's
-- ---------------------------------------------------------------------------
--
--   plan_scenarios          the holder's baseline plan, and named forks of it
--                           that carry lever deltas and nothing else
--   plan_life_events        a dated, typed, signed amount on the timeline
--   projection_runs         one computed projection: its seed, engine version,
--                           assumptions version and input digest -- the cache
--                           key's inputs, every one NOT NULL
--   projection_percentiles  p5..p95 per projected year, for one run
--
-- Every one carries `user_id` REFERENCES users ON DELETE CASCADE (D6), and
-- every child reaches its parent through a **composite** foreign key on
-- (parent_id, user_id) -- 0020's rule, for 0020's reason: a plain foreign key
-- would accept a run stamped with one holder's id pointing at another holder's
-- scenario, visible to a `WHERE user_id = $me` query while describing somebody
-- else's plan.
--
-- ---------------------------------------------------------------------------
-- A fork is a delta, never a copy (the dispatch's rule, enforced here)
-- ---------------------------------------------------------------------------
--
-- 07 §5.10's levers are `{retire_age, savings_rate, annual_spending,
-- expected_return_shift, ss_claim_age, part_time_income, one_time_windfall,
-- glidepath}`. A fork row stores **only the levers that differ from its
-- baseline** -- `diffLevers` in `src/scenarios.ts` drops a lever equal to the
-- baseline's value before anything is written, exactly as 0021's
-- `diffOverrides` drops an override equal to the default. The same argument
-- applies with more force: a fork that copied the baseline's spending would
-- keep the old number after the holder corrected the baseline, and the
-- compare screen would show a difference nobody chose.
--
-- `plan_scenarios_shape` makes the two row kinds disjoint: a baseline has a
-- profile and no levers, a fork has levers and no profile, and
-- `plan_scenario_levers_are_well_formed` refuses any key that is not one of the
-- eight levers -- so "a fork holding a copy of the plan" cannot be expressed in
-- the column at all.
--
-- ---------------------------------------------------------------------------
-- Common random numbers, by construction
-- ---------------------------------------------------------------------------
--
-- The seed lives on the **baseline only** (`plan_scenarios_seed_is_the_baselines`).
-- A fork has no seed of its own and every fork run records its baseline's seed,
-- so "compare A with B" is computed under common random numbers (07 §5.4
-- detail 1) because there is no second seed a fork could have drawn from.
--
-- ---------------------------------------------------------------------------
-- No float, anywhere
-- ---------------------------------------------------------------------------
--
-- D3. Amounts are BIGINT minor units with a currency. The success probability
-- is NUMERIC(7,6), read back by node-postgres as a decimal string. The seed is
-- NUMERIC(20,0): xoshiro256++ is seeded from an unsigned 64-bit integer and
-- BIGINT is signed, so half of the seed space would not fit. The stored JSON
-- documents -- a baseline profile, a fork's levers, a run's input -- carry no
-- JSON number at all (`jsonb_path_exists(..., '$.** ? (@.type() == "number")')`):
-- amounts are {"minor": "<digits>", "currency": "USD"} and ages are strings, so
-- the serialisation edge is not where D3 stops.
--
-- ---------------------------------------------------------------------------
-- A stored run never changes
-- ---------------------------------------------------------------------------
--
-- D20: the server is authoritative for saved scenarios, and "a projection is
-- saved and the re-opened result is byte-identical" is a gate walk step.
-- `projection_runs_are_immutable` refuses every UPDATE except the one-way
-- stamp of `goals_evaluated_at` (NULL -> an instant, once) -- the claim the
-- R6 evaluation takes so a redelivered `planning.ProjectionCompleted` cannot
-- emit `planning.GoalOffTrack` twice. `projection_percentiles` refuses UPDATE
-- outright. A run against an assumptions version this build no longer holds
-- is read back **stale with its version named** by the service; it is never
-- recomputed in place, and there is no statement here that could do so.

-- ---------------------------------------------------------------------------
-- Shared shape checks
-- ---------------------------------------------------------------------------

CREATE FUNCTION plan_amount_json_is_well_formed(amount JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(amount) IS DISTINCT FROM 'object' THEN false
    ELSE
          (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(amount) AS key)
            = ARRAY['currency', 'minor']
      AND jsonb_typeof(amount -> 'minor') = 'string'
      AND (amount ->> 'minor') ~ '^-?(0|[1-9][0-9]{0,18})$'
      AND jsonb_typeof(amount -> 'currency') = 'string'
      AND (amount ->> 'currency') ~ '^[A-Z]{3}$'
  END;
$$;

COMMENT ON FUNCTION plan_amount_json_is_well_formed(JSONB) IS
  'WP 4.6: an amount inside a stored plan document is {"minor": "<integer string>", "currency": "<ISO 4217>"} and nothing else -- the wire form in docs/CONVENTIONS.md, never a JSON number.';

CREATE FUNCTION plan_document_has_no_json_number(document JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NOT jsonb_path_exists(document, 'lax $.** ? (@.type() == "number")');
$$;

COMMENT ON FUNCTION plan_document_has_no_json_number(JSONB) IS
  'WP 4.6 as a CHECK: a stored plan document holds no JSON number anywhere. Amounts are minor-unit strings, rates are decimal strings, ages are strings (D3).';

-- ---------------------------------------------------------------------------
-- plan_scenarios
-- ---------------------------------------------------------------------------

CREATE FUNCTION plan_scenario_levers_are_well_formed(levers JSONB)
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
          plan_amount_json_is_well_formed(lever.setting)
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
              AND plan_amount_json_is_well_formed(lever.setting -> 'annual')
              AND jsonb_typeof(lever.setting -> 'years') = 'string'
              AND (lever.setting ->> 'years') ~ '^[0-9]{1,2}$'
          END
        WHEN 'one_time_windfall' THEN
          CASE
            WHEN jsonb_typeof(lever.setting) IS DISTINCT FROM 'object' THEN false
            ELSE
                  (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lever.setting) AS key)
                    = ARRAY['amount', 'on']
              AND plan_amount_json_is_well_formed(lever.setting -> 'amount')
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

COMMENT ON FUNCTION plan_scenario_levers_are_well_formed(JSONB) IS
  'WP 4.6 as a CHECK: a fork''s levers are a non-empty flat object whose keys are among 07 §5.10''s eight levers, each in its own string form. Any other key -- a bucket, a birth date, a copy of the profile -- is refused.';

CREATE TABLE plan_scenarios (
  id           UUID        PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  kind         TEXT        NOT NULL CHECK (kind IN ('baseline', 'fork')),

  -- A fork names the baseline it forks. NULL on the baseline itself.
  baseline_id  UUID,

  name         TEXT        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 96),

  -- The baseline's stated plan: birth date, retirement and plan-end ages, the
  -- glidepath, the withdrawal policy, Social Security and pensions. What is
  -- *derived* (balances by tax bucket from a sealed `net_worth_daily` day,
  -- revealed contributions and spending) is read at projection time and is
  -- never stored here. Validated field by field in `src/scenarios.ts`; the
  -- CHECKs below hold the structural line.
  profile      JSONB,

  -- A fork's lever deltas. Only what differs from the baseline.
  levers       JSONB,

  -- The Monte Carlo seed, on the baseline only (see the header).
  seed         NUMERIC(20, 0),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT plan_scenarios_id_user_key UNIQUE (id, user_id),

  CONSTRAINT plan_scenarios_fork_is_the_same_users
    FOREIGN KEY (baseline_id, user_id) REFERENCES plan_scenarios (id, user_id) ON DELETE CASCADE,

  CONSTRAINT plan_scenarios_shape
    CHECK (
      (kind = 'baseline' AND baseline_id IS NULL AND profile IS NOT NULL AND levers IS NULL)
      OR
      (kind = 'fork' AND baseline_id IS NOT NULL AND profile IS NULL AND levers IS NOT NULL)
    ),

  CONSTRAINT plan_scenarios_seed_is_the_baselines
    CHECK ((kind = 'baseline') = (seed IS NOT NULL)),

  CONSTRAINT plan_scenarios_seed_is_unsigned_64
    CHECK (seed IS NULL OR (seed >= 0 AND seed <= 18446744073709551615)),

  CONSTRAINT plan_scenarios_levers_are_deltas
    CHECK (levers IS NULL OR plan_scenario_levers_are_well_formed(levers)),

  CONSTRAINT plan_scenarios_profile_is_well_formed
    CHECK (
      profile IS NULL
      OR (
            jsonb_typeof(profile) = 'object'
        AND jsonb_typeof(profile -> 'birthDate') = 'string'
        AND (profile ->> 'birthDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND plan_document_has_no_json_number(profile)
      )
    ),

  CONSTRAINT plan_scenarios_updated_after_created CHECK (updated_at >= created_at)
);

-- One baseline per holder: "is my plan on track?" has one plan behind it.
CREATE UNIQUE INDEX plan_scenarios_one_baseline_idx
  ON plan_scenarios (user_id)
  WHERE kind = 'baseline';

CREATE INDEX plan_scenarios_user_baseline_idx ON plan_scenarios (user_id, baseline_id, created_at);

COMMENT ON TABLE plan_scenarios IS
  'WP 4.6: the holder''s baseline plan (kind = baseline: a stated profile and the Monte Carlo seed) and named forks of it (kind = fork: 07 §5.10 lever deltas only, never a copy). Owner: @ctx/planning. The server is authoritative for saved scenarios (D20).';
COMMENT ON COLUMN plan_scenarios.levers IS
  'A fork''s levers that differ from its baseline -- retire_age, savings_rate, annual_spending, expected_return_shift, ss_claim_age, part_time_income, one_time_windfall, glidepath -- and nothing else.';
COMMENT ON COLUMN plan_scenarios.seed IS
  'Unsigned 64-bit Monte Carlo seed. Baseline rows only: every fork runs on its baseline''s seed, so a compare is under common random numbers by construction.';

-- ---------------------------------------------------------------------------
-- plan_life_events
-- ---------------------------------------------------------------------------
--
-- A signed amount on a date: positive arrives (an inheritance), negative
-- leaves (a home purchase). The sign is the holder's claim about direction and
-- `plan_life_events_sign_matches_kind` refuses the typo where a college bill
-- is entered as income. Amounts are **today's dollars**, the projection's
-- basis (07 §5.2), and belong to the holder's plan -- every scenario sees them.

CREATE TABLE plan_life_events (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  kind          TEXT        NOT NULL
                            CHECK (kind IN ('inheritance', 'home_purchase', 'college',
                                            'sabbatical', 'windfall', 'other')),

  name          TEXT        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 96),

  occurs_on     DATE        NOT NULL,

  -- D3. Signed, never zero: an event of nothing is not an event.
  amount_minor  BIGINT      NOT NULL CHECK (amount_minor <> 0),
  currency      CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT plan_life_events_sign_matches_kind
    CHECK (
      CASE kind
        WHEN 'inheritance'   THEN amount_minor > 0
        WHEN 'windfall'      THEN amount_minor > 0
        WHEN 'home_purchase' THEN amount_minor < 0
        WHEN 'college'       THEN amount_minor < 0
        WHEN 'sabbatical'    THEN amount_minor < 0
        ELSE true
      END
    ),

  CONSTRAINT plan_life_events_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX plan_life_events_user_date_idx ON plan_life_events (user_id, occurs_on, id);

COMMENT ON TABLE plan_life_events IS
  'WP 4.6: a dated, typed, signed amount on the plan''s timeline (inheritance, home purchase, college, sabbatical). Today''s dollars. Owner: @ctx/planning.';
COMMENT ON COLUMN plan_life_events.amount_minor IS
  'Signed minor units: positive arrives, negative leaves. The sign must agree with the kind (plan_life_events_sign_matches_kind).';

-- ---------------------------------------------------------------------------
-- projection_runs
-- ---------------------------------------------------------------------------
--
-- The cache (04 §5.6): `cache_key` is sha256 over the resolved assumptions
-- (the file's version and the holder's override deltas), the engine version,
-- the seed and the input digest; `projection_runs_cache_key_idx` makes an
-- identical request resolve to the one row it already produced. The inputs to
-- that key are stored beside it, each NOT NULL and each shape-checked, so a
-- run can always say what it was computed from: that is 07 §7.3's "why did it
-- say $720?", answerable six months later.

CREATE TABLE projection_runs (
  id                     UUID          PRIMARY KEY,
  user_id                UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scenario_id            UUID          NOT NULL,
  scenario_kind          TEXT          NOT NULL CHECK (scenario_kind IN ('baseline', 'fork')),
  method                 TEXT          NOT NULL CHECK (method IN ('deterministic', 'monte_carlo')),

  cache_key              TEXT          NOT NULL
    CONSTRAINT projection_runs_cache_key_is_a_digest
      CHECK (cache_key ~ '^sha256:[0-9a-f]{64}$'),

  seed                   NUMERIC(20, 0) NOT NULL
    CONSTRAINT projection_runs_seed_is_unsigned_64
      CHECK (seed >= 0 AND seed <= 18446744073709551615),

  engine_version         TEXT          NOT NULL
    CONSTRAINT projection_runs_engine_version_is_named
      CHECK (btrim(engine_version) <> '' AND char_length(engine_version) <= 64),

  assumptions_version    TEXT          NOT NULL
    CONSTRAINT projection_runs_assumptions_version_is_a_content_hash
      CHECK (assumptions_version ~ '^sha256:[0-9a-f]{64}$'),

  -- The holder's override deltas the run resolved, verbatim (0021's shape).
  assumptions_overrides  JSONB         NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT projection_runs_overrides_are_a_delta
      CHECK (plan_assumption_deltas_are_well_formed(assumptions_overrides)),

  input_digest           TEXT          NOT NULL
    CONSTRAINT projection_runs_input_digest_is_a_digest
      CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),

  -- The whole assembled input the digest is of: the plan after levers and
  -- life events, the balances' sealed day, which life events did not apply
  -- and why. A record, never re-read into a computation.
  input                  JSONB         NOT NULL
    CONSTRAINT projection_runs_input_is_a_document
      CHECK (jsonb_typeof(input) = 'object' AND plan_document_has_no_json_number(input)),

  paths                  INTEGER       NOT NULL CHECK (paths BETWEEN 1 AND 1000000),

  -- The starting balances' day, and whether it was sealed (08 §3.5). An
  -- open-day run is legal only when asked for, and says so here.
  as_of_date             DATE          NOT NULL,
  balances_sealed        BOOLEAN       NOT NULL,

  currency               CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  success_probability    NUMERIC(7, 6) NOT NULL
    CHECK (success_probability >= 0 AND success_probability <= 1),

  duration_ms            INTEGER       NOT NULL CHECK (duration_ms >= 0),

  -- The R6 evaluation's claim (see the header). NULL until taken, then never
  -- moved again.
  goals_evaluated_at     TIMESTAMPTZ,

  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT projection_runs_scenario_is_the_same_users
    FOREIGN KEY (scenario_id, user_id) REFERENCES plan_scenarios (id, user_id) ON DELETE CASCADE,

  -- One path is a deterministic run and a deterministic run is one path.
  CONSTRAINT projection_runs_method_matches_paths
    CHECK ((method = 'deterministic') = (paths = 1)),

  -- The target of projection_percentiles' composite key: a band row is this
  -- run's, this holder's, and in this run's currency.
  CONSTRAINT projection_runs_id_user_currency_key UNIQUE (id, user_id, currency)
);

CREATE UNIQUE INDEX projection_runs_cache_key_idx ON projection_runs (user_id, cache_key);

CREATE INDEX projection_runs_user_scenario_idx
  ON projection_runs (user_id, scenario_id, created_at DESC, id DESC);

COMMENT ON TABLE projection_runs IS
  'WP 4.6: one computed projection. seed, engine_version, assumptions_version and input_digest are the cache key''s inputs (04 §5.6) and are all NOT NULL; an identical request is served from here, never re-run. Immutable except goals_evaluated_at, stamped once. Owner: @ctx/planning.';
COMMENT ON COLUMN projection_runs.assumptions_version IS
  'Content hash of the assumptions file the run resolved. A run whose version this build no longer holds reads back stale with this version named; it is never recomputed against today''s defaults.';
COMMENT ON COLUMN projection_runs.goals_evaluated_at IS
  'Set once, by the R6 goal-pace evaluation that consumed this run''s planning.ProjectionCompleted. A redelivery finds it set and emits nothing.';

CREATE FUNCTION projection_runs_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'goals_evaluated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'goals_evaluated_at')
     OR (OLD.goals_evaluated_at IS NOT NULL
         AND NEW.goals_evaluated_at IS DISTINCT FROM OLD.goals_evaluated_at) THEN
    RAISE EXCEPTION
      'projection_runs % is a stored projection and may never be updated; only goals_evaluated_at may be stamped, once (WP 4.6, D20)',
      OLD.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'projection_runs_are_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projection_runs_are_immutable
  BEFORE UPDATE ON projection_runs
  FOR EACH ROW
  EXECUTE FUNCTION projection_runs_are_immutable();

-- ---------------------------------------------------------------------------
-- projection_percentiles
-- ---------------------------------------------------------------------------
--
-- One row per projected year: end-of-year wealth in today's dollars at seven
-- percentiles (08 §7.2: bands, never paths). A deterministic run has one path
-- and therefore a median and no spread -- its six outer bands are NULL rather
-- than six copies of the median pretending to be a distribution
-- (`projection_percentiles_bands_are_all_or_none`).

CREATE TABLE projection_percentiles (
  run_id         UUID        NOT NULL,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_index   INTEGER     NOT NULL CHECK (period_index >= 0 AND period_index <= 200),
  age            INTEGER     NOT NULL CHECK (age BETWEEN 0 AND 120),
  calendar_year  INTEGER     NOT NULL CHECK (calendar_year BETWEEN 1900 AND 2300),
  currency       CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  p5_minor       BIGINT,
  p10_minor      BIGINT,
  p25_minor      BIGINT,
  p50_minor      BIGINT      NOT NULL,
  p75_minor      BIGINT,
  p90_minor      BIGINT,
  p95_minor      BIGINT,

  PRIMARY KEY (run_id, period_index),

  CONSTRAINT projection_percentiles_run_is_the_same_users
    FOREIGN KEY (run_id, user_id, currency)
    REFERENCES projection_runs (id, user_id, currency) ON DELETE CASCADE,

  CONSTRAINT projection_percentiles_bands_are_all_or_none
    CHECK (
      (p5_minor IS NULL AND p10_minor IS NULL AND p25_minor IS NULL
        AND p75_minor IS NULL AND p90_minor IS NULL AND p95_minor IS NULL)
      OR
      (p5_minor IS NOT NULL AND p10_minor IS NOT NULL AND p25_minor IS NOT NULL
        AND p75_minor IS NOT NULL AND p90_minor IS NOT NULL AND p95_minor IS NOT NULL)
    ),

  CONSTRAINT projection_percentiles_are_ordered
    CHECK (
      p5_minor IS NULL
      OR (p5_minor <= p10_minor AND p10_minor <= p25_minor AND p25_minor <= p50_minor
          AND p50_minor <= p75_minor AND p75_minor <= p90_minor AND p90_minor <= p95_minor)
    )
);

CREATE INDEX projection_percentiles_user_run_idx ON projection_percentiles (user_id, run_id);

COMMENT ON TABLE projection_percentiles IS
  'WP 4.6: p5..p95 end-of-year wealth (today''s dollars, BIGINT minor units) per projected year of one projection run. A deterministic run stores the median only. Never updated. Owner: @ctx/planning.';

CREATE FUNCTION projection_percentiles_are_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'projection_percentiles for run % are part of a stored projection and may never be updated (WP 4.6, D20)',
    OLD.run_id
    USING ERRCODE = '23514',
          CONSTRAINT = 'projection_percentiles_are_immutable';
END;
$$;

CREATE TRIGGER projection_percentiles_are_immutable
  BEFORE UPDATE ON projection_percentiles
  FOR EACH ROW
  EXECUTE FUNCTION projection_percentiles_are_immutable();
