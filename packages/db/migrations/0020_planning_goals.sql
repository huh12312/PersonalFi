-- SPDX-License-Identifier: MIT
-- 0020_planning_goals: goals, the contribution plans that fund them, the risk
--                      profile with its consistency penalty, and cash earmarks
--                      (WP 4.1; 02 §3 "Wealthfront Path", 07 I3, 08 §1.3 #8 and
--                      §4.2, decisions D3 and D6).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Four tables, all @ctx/planning's
-- ---------------------------------------------------------------------------
--
--   goals               what the holder is saving towards, by when
--   goal_contributions  a *plan* of contributions to one goal, never a ledger
--   risk_profile        one row per answering of the questionnaire, append-only
--   cash_earmarks       a named reservation of cash in one account for one goal
--
-- Every one carries `user_id` REFERENCES users ON DELETE CASCADE (D6), and
-- every child row reaches its goal through a **composite** foreign key on
-- (goal_id, user_id) against `goals_id_user_key`. A plain `goal_id` foreign
-- key would accept a contribution stamped with one holder's `user_id` that
-- points at another holder's goal -- the row would then be visible to a
-- `WHERE user_id = $me` query while describing somebody else's plan. That is
-- WP 3.9's S1 finding one layer down: a join that "also scopes" hides whether
-- either predicate is doing any work. The composite key makes the two halves
-- agree by construction, so the database refuses the mixed row outright and
-- `test/db/goals.test.ts` asserts it by constraint name.
--
-- ---------------------------------------------------------------------------
-- No float, and every amount is a (BIGINT, CHAR(3)) pair
-- ---------------------------------------------------------------------------
--
-- D3. `goals.target_minor`, `goal_contributions.amount_minor` and
-- `cash_earmarks.amount_minor` are BIGINT minor units, each paired with a
-- currency. The one rate in this migration, `goal_contributions.escalation_pct`,
-- is NUMERIC(7,4) in percentage points and is read back by node-postgres as a
-- decimal *string* (`packages/db/src/types.ts` leaves NUMERIC alone on purpose),
-- so an escalation of 3.25% a year never passes through an IEEE-754 double on
-- its way in or out. `migrate.test.ts` bans the float types outright anyway.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does not do
-- ---------------------------------------------------------------------------
--
-- No foreign key into another context's schema. `funded_from_account_ids`
-- and `cash_earmarks.account_id` are opaque UUIDs exactly as
-- `holdings.account_id` is (0014): `accounts` is @ctx/ledger's and this
-- context may not reference it. "The funding account exists" is enforced by
-- the service through an injected port (`FundingAccountsReader`, a `Pick` of
-- the snapshotter's `BalancesReader`) and refused as
-- `planning.goal_funding_account_not_found` -- a typed domain refusal, not a
-- 23503.
--
-- No CHECK that `target_date` is in the future. `current_date` is STABLE, not
-- IMMUTABLE, and a CHECK that consults the clock is a CHECK whose verdict on
-- an existing row changes overnight: every goal would become invalid on its
-- own target date and the next unrelated UPDATE to it would fail. "A target
-- date in the past" is a refusal at *creation*, computed in the holder's zone
-- (docs/CONVENTIONS.md "Time"), and it lives in `src/goals.ts`.
--
-- No income column anywhere. `risk_profile.tax_bracket_band` is a band
-- (`'22-32'`) derived from an income the service is handed and drops; 08 §4.2
-- says the bracket crosses "as a band, never a figure", and the cheapest way to
-- keep a figure out of an advisor snapshot is to never have stored it. The
-- band CHECK refuses anything that is not two small integers and a hyphen, and
-- `risk_profile_answers_are_well_formed` refuses an answers document holding
-- anything but option identifiers, so there is no column a figure could hide in.

-- ---------------------------------------------------------------------------
-- goals
-- ---------------------------------------------------------------------------

CREATE TABLE goals (
  id                       UUID        PRIMARY KEY,
  user_id                  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  kind                     TEXT        NOT NULL
                                       CHECK (kind IN ('retirement', 'emergency_fund', 'purchase',
                                                       'sabbatical', 'custom')),

  -- 96 is the published `goals.list` scope's limit (advisor contract 1.0.0,
  -- GoalsListSchema.name), so a goal can always cross that scope unabridged.
  name                     TEXT        NOT NULL
                                       CHECK (btrim(name) <> '' AND char_length(name) <= 96),

  -- D3. Strictly positive: a goal of nothing is not a goal, and a negative
  -- target would invert every funded-ratio computed from it.
  target_minor             BIGINT      NOT NULL CHECK (target_minor > 0),
  currency                 CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  -- A calendar claim, so DATE. See the header for why "not in the past" is
  -- not a CHECK.
  target_date              DATE        NOT NULL,

  -- 1 is the most important. Five levels because a ranking longer than that
  -- is a list nobody maintains.
  priority                 SMALLINT    NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),

  -- Opaque @ctx/ledger account ids; no foreign key (see the header). An
  -- array rather than a join table because the set is small, is only ever
  -- read whole, and has no attributes of its own. May be empty: a goal can be
  -- created before the account that will fund it is linked.
  funded_from_account_ids  UUID[]      NOT NULL DEFAULT '{}',

  status                   TEXT        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('active', 'paused', 'achieved', 'abandoned')),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT goals_funding_accounts_are_well_formed
    CHECK (array_position(funded_from_account_ids, NULL) IS NULL
           AND cardinality(funded_from_account_ids) <= 32),

  -- The target of every child table's composite foreign key. `id` alone is
  -- already unique; this exists so a child can say "this goal, *and* it is
  -- mine" in one reference.
  CONSTRAINT goals_id_user_key UNIQUE (id, user_id)
);

-- The list read: a holder's goals by status, soonest first.
CREATE INDEX goals_user_status_idx ON goals (user_id, status, target_date);

-- One live retirement goal per holder. The projection plans *a* retirement;
-- two live ones would make "is retirement on track?" a question with two
-- answers. Achieved and abandoned ones are history and may accumulate.
CREATE UNIQUE INDEX goals_one_live_retirement_idx
  ON goals (user_id)
  WHERE kind = 'retirement' AND status IN ('active', 'paused');

COMMENT ON TABLE goals IS
  'A goal the holder is saving towards. Owner: @ctx/planning (WP 4.1). Target is BIGINT minor units plus currency (D3); funding accounts are opaque @ctx/ledger ids checked through a port, never a foreign key.';
COMMENT ON COLUMN goals.target_date IS
  'The date the target should be reached. Refused at creation when already past in the holder''s zone (planning.goal_target_date_in_past); deliberately not a CHECK, because a CHECK against the clock would invalidate every goal on its own target date.';
COMMENT ON COLUMN goals.funded_from_account_ids IS
  'Opaque @ctx/ledger account ids. Existence is checked by the service through FundingAccountsReader; no foreign key crosses a context boundary.';

-- ---------------------------------------------------------------------------
-- goal_contributions
-- ---------------------------------------------------------------------------

CREATE TABLE goal_contributions (
  id               UUID        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id          UUID        NOT NULL,

  cadence          TEXT        NOT NULL
                               CHECK (cadence IN ('weekly', 'biweekly', 'semimonthly', 'monthly',
                                                  'quarterly', 'annually')),

  -- D3. Per-cadence amount, strictly positive. A withdrawal is not a
  -- contribution plan and belongs to the projection's decumulation phase.
  amount_minor     BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency         CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  -- Annual step-up in **percentage points**: 3.25 means the amount grows by
  -- 3.25% each year from `starts_on`. NUMERIC, read back as a string.
  escalation_pct   NUMERIC(7,4) NOT NULL DEFAULT 0
                               CHECK (escalation_pct >= 0 AND escalation_pct <= 100),

  starts_on        DATE        NOT NULL,
  ends_on          DATE,

  -- 09 GOAL-4: a plan is either derived from observed transfers (and says as
  -- of when) or typed by the holder. Never both, never neither.
  source           TEXT        NOT NULL CHECK (source IN ('DERIVED', 'USER')),
  derived_as_of    DATE,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT goal_contributions_goal_is_the_same_users
    FOREIGN KEY (goal_id, user_id) REFERENCES goals (id, user_id) ON DELETE CASCADE,

  CONSTRAINT goal_contributions_window_is_ordered
    CHECK (ends_on IS NULL OR ends_on >= starts_on),

  -- Both directions: a derived plan names the day its derivation was taken,
  -- and a plan that names such a day is a derived one.
  CONSTRAINT goal_contributions_derived_carries_as_of
    CHECK ((source = 'DERIVED') = (derived_as_of IS NOT NULL))
);

CREATE INDEX goal_contributions_user_goal_idx ON goal_contributions (user_id, goal_id, starts_on);

COMMENT ON TABLE goal_contributions IS
  'A contribution plan for one goal: cadence, per-cadence amount, annual escalation, window. A plan, not a ledger -- what actually moved is @ctx/ledger''s. Owner: @ctx/planning (WP 4.1).';
COMMENT ON COLUMN goal_contributions.escalation_pct IS
  'Annual step-up in percentage points (3.25 = 3.25% a year), NUMERIC(7,4), carried in code as a decimal string and applied with exact integer arithmetic, rounded once.';
COMMENT ON COLUMN goal_contributions.derived_as_of IS
  'Set if and only if source = ''DERIVED'': the last day of the observation window the plan was derived from (09 GOAL-4).';

-- ---------------------------------------------------------------------------
-- risk_profile
-- ---------------------------------------------------------------------------
--
-- Append-only: each answering of the questionnaire is a new row, and the
-- current profile is the newest `answered_at`. There is no UPDATE path in
-- `src/goals-store.ts`. A profile the holder re-takes after a bad year is
-- exactly the history an explanation needs ("you moved from moderate to
-- conservative in March").
--
-- `tolerance` is **derived, never typed in** (02 §3). `answers` holds the
-- option chosen for each item, keyed by item id, under an instrument version;
-- `deriveTolerance(answers)` in `src/risk-profile.ts` is one pure function of
-- that document alone, so every stored score can be re-derived from its own
-- row and a disagreement between the two is a bug that a test can find.

CREATE FUNCTION risk_profile_answers_are_well_formed(answers JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(answers) IS DISTINCT FROM 'object' THEN false
    WHEN jsonb_typeof(answers -> 'items') IS DISTINCT FROM 'object' THEN false
    ELSE
          jsonb_typeof(answers -> 'instrument') = 'string'
      AND answers ->> 'instrument' ~ '^risk-v[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_object_keys(answers) AS key
        WHERE key NOT IN ('instrument', 'items')
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(answers -> 'items') AS item
        WHERE item.key !~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
           OR jsonb_typeof(item.value) IS DISTINCT FROM 'string'
           OR (item.value #>> '{}') !~ '^[a-z][a-z0-9_]*$'
      )
  END;
$$;

COMMENT ON FUNCTION risk_profile_answers_are_well_formed(JSONB) IS
  'WP 4.1: an answers document is {instrument: "risk-vN", items: {"<disposition>.<framing>": "<option id>"}} and nothing else. Option ids start with a letter, so no figure -- an income, a balance -- can be carried in one.';

CREATE TABLE risk_profile (
  id                   UUID        PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The contract's vocabulary (08 §4.2's example is `moderate_aggressive`).
  tolerance            TEXT        NOT NULL
                                   CHECK (tolerance IN ('conservative', 'moderate_conservative',
                                                        'moderate', 'moderate_aggressive',
                                                        'aggressive')),

  -- The instrument's own points, stored beside the tolerance so the
  -- consistency penalty is visible on the row and not only recomputable.
  -- `unpenalised_score` is what averaging the two framings would have given;
  -- `composite_score` is what crediting only the more conservative framing
  -- gives; the difference is the penalty, by CHECK.
  composite_score      SMALLINT    NOT NULL CHECK (composite_score >= 0),
  unpenalised_score    SMALLINT    NOT NULL CHECK (unpenalised_score >= 0),
  consistency_penalty  SMALLINT    NOT NULL CHECK (consistency_penalty >= 0),

  horizon_years        SMALLINT    NOT NULL CHECK (horizon_years BETWEEN 0 AND 100),

  -- A band of marginal federal rates in whole percent (`'22-32'`), never a
  -- figure. NULL when the holder declined to give an income: an unknown band
  -- is honest, a guessed one is not.
  tax_bracket_band     TEXT        CHECK (tax_bracket_band ~ '^[0-9]{1,2}-[0-9]{1,2}$'),

  liquidity_need       TEXT        NOT NULL CHECK (liquidity_need IN ('low', 'medium', 'high')),

  answers              JSONB       NOT NULL,

  answered_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT risk_profile_penalty_is_the_difference
    CHECK (composite_score = unpenalised_score - consistency_penalty),

  CONSTRAINT risk_profile_answers_are_well_formed
    CHECK (risk_profile_answers_are_well_formed(answers))
);

-- The current profile: newest answering first.
CREATE INDEX risk_profile_user_answered_idx ON risk_profile (user_id, answered_at DESC, id DESC);

COMMENT ON TABLE risk_profile IS
  'One row per answering of the risk questionnaire; the newest answered_at is current. Tolerance is derived from answers by one pure function, never typed in. No income is stored: tax_bracket_band is a band. Owner: @ctx/planning (WP 4.1).';
COMMENT ON COLUMN risk_profile.consistency_penalty IS
  'Points withheld because two framings of the same disposition disagreed: unpenalised_score - composite_score. The score moves to the more conservative framing, never to the mean (02 §3).';
COMMENT ON COLUMN risk_profile.tax_bracket_band IS
  'Marginal federal bracket band in whole percent, e.g. 22-32. Derived from an income the row never stores (08 §4.2). NULL when no income was given.';

-- ---------------------------------------------------------------------------
-- cash_earmarks
-- ---------------------------------------------------------------------------
--
-- 07 I3 fires on brokerage cash that has sat uninvested for more than 14 days
-- "and not earmarked". This is the earmark: the holder saying "this $6,000 in
-- that account is the house deposit". It lives in Planning and not in
-- Investments because it is a statement about a *goal* -- it references
-- `goals` by composite key -- and 08 §1.6's arrows point planning ->
-- investments, never back. WP 4.7 composes it with Investments' dwell at the
-- composition root, which may read both.

CREATE TABLE cash_earmarks (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id       UUID        NOT NULL,

  -- Opaque @ctx/ledger account id; see the header.
  account_id    UUID        NOT NULL,

  name          TEXT        NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 96),

  amount_minor  BIGINT      NOT NULL CHECK (amount_minor > 0),
  currency      CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  -- NULL while the reservation holds. Released rather than deleted, so "was
  -- this cash earmarked on the day I3 looked at it?" stays answerable.
  released_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cash_earmarks_goal_is_the_same_users
    FOREIGN KEY (goal_id, user_id) REFERENCES goals (id, user_id) ON DELETE CASCADE
);

-- The I3 composition's read: live earmarks per account.
CREATE INDEX cash_earmarks_user_account_live_idx
  ON cash_earmarks (user_id, account_id)
  WHERE released_at IS NULL;

CREATE INDEX cash_earmarks_user_goal_idx ON cash_earmarks (user_id, goal_id);

COMMENT ON TABLE cash_earmarks IS
  'A named reservation of cash in one account against one goal -- what "not earmarked" means in 07 I3. Owner: @ctx/planning (WP 4.1); read by the I3 idle-cash composition at the composition root (WP 4.7).';
COMMENT ON COLUMN cash_earmarks.released_at IS
  'NULL while the earmark holds. Released, never deleted, so a past idle-cash verdict can be re-checked against what was earmarked at the time.';
