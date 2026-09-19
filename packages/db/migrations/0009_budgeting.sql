-- SPDX-License-Identifier: MIT
-- 0009_budgeting: the Envelope-lite budgeting ledger (WP 2.1, 07 §1.2-1.8).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- What this schema is
-- ---------------------------------------------------------------------------
--
-- 07 §1.9 picks Envelope-lite as the default: "zero-based envelope math
-- (§1.2-1.3) with rollover ON, but auto-assigned from targets and non-nagging".
-- The reason it is the substrate and not one mode among four is stated in the
-- same section -- "the envelope ledger is a *superset*. You can render a
-- target-only UI on top of it; you cannot render an envelope UI on top of a
-- target-only ledger." So `budgets.mode` changes presentation and auto-assign
-- aggressiveness and nothing else; every row below exists in all four modes.
--
-- Six tables, mapping onto 07 §1.10's sketch:
--
--   budgets             the settings a period grid is generated from
--   budget_periods      the grid itself: half-open [start_date, end_date)
--   budget_lines        §1.10's `category` + `budget_entry` collapsed into one
--                       row per (period, category) -- see "one line per period"
--   budget_line_actuals §1.10's `category_period_cache`, derived, dirty-flagged
--   rollovers           the audit row for every carryover, with conservation
--                       enforced by a CHECK rather than by a test alone
--   budget_alerts_state edge-triggering for `budgeting.BudgetThresholdCrossed`
--
-- ---------------------------------------------------------------------------
-- One line per period, not one category with a per-period entry
-- ---------------------------------------------------------------------------
--
-- 07 §1.10 sketches `category(...)` holding the rollover policy, goal and
-- priority, with `budget_entry(period_id, category_id, assigned_minor)` holding
-- the money. That splits a budget line's identity across two tables and makes
-- "what was my grocery target in March?" unanswerable after the user edits the
-- target in April -- the category row is mutable and has no history.
--
-- `budget_lines` is therefore one row per (period, category): the money *and*
-- the policy that governed it, frozen per period. Editing a target changes the
-- open period's row and every period opened after it; closed periods keep what
-- they were actually budgeted under. `@ctx/categorization` still owns the
-- category itself -- `category_id` here is an opaque UUID with no foreign key,
-- for the same reason `transactions.user_category_id` is (decision D8).
--
-- ---------------------------------------------------------------------------
-- No float, and every money column is a (BIGINT, CHAR(3)) pair
-- ---------------------------------------------------------------------------
--
-- Decision D3, docs/CONVENTIONS.md "Money". Every `*_minor` column below is
-- `BIGINT` and is paired with a currency; the only `NUMERIC` columns in this
-- migration are `goal_percent` and `budget_alerts_state.ratio`, which are ratios
-- and not money, and are `NUMERIC(7,4)` rather than a float because
-- `packages/db/test/migrate.test.ts` bans REAL/DOUBLE PRECISION/FLOAT outright
-- across the schema (the same call `transactions.refund_confidence` made).
--
-- A rollover that loses a cent per period is invisible for months, so the
-- arithmetic is `Money.*` on `bigint` end to end and `Money.allocate`'s
-- largest-remainder split is what divides a credit-card funding pot between two
-- cards. No `number` reaches a `*_minor` column; the evidence file names every
-- boundary.
--
-- ---------------------------------------------------------------------------
-- Periods are half-open and non-overlapping, enforced by the database
-- ---------------------------------------------------------------------------
--
-- 07 §1.7: `kind IN {CALENDAR_MONTH, SEMIMONTHLY, BIWEEKLY, WEEKLY, CUSTOM}`,
-- and "biweekly anchored to an actual payday means 26 periods/yr and two
-- '3-paycheck months' -- the engine must handle periods that don't tile
-- months." Half-open `[start_date, end_date)` is what makes a biweekly grid and
-- a calendar-month grid the same kind of object: a transaction belongs to the
-- period with `start_date <= budget_date < end_date`, exactly one of them.
--
-- "Exactly one" is a correctness precondition for the whole envelope ledger --
-- a date in two periods double-counts its activity, a date in none loses it --
-- so it is an `EXCLUDE` constraint over `daterange(start, end, '[)')` rather
-- than an application invariant. 04 §2.1 names exclusion constraints for
-- non-overlapping budget periods as one of the reasons the stack is Postgres
-- and not SQLite; this is that reason being spent. `btree_gist` is a trusted
-- extension (PG13+) so a database owner can create it, and 0004_ledger.sql set
-- the precedent for `CREATE EXTENSION IF NOT EXISTS` in a migration.
--
-- The dates themselves are `DATE`, never `TIMESTAMPTZ`: a period boundary is a
-- calendar date in the user's zone (`budgets.timezone`), computed once by
-- `todayIn(clock, zone)` and stored zone-free. That is what makes the DST test
-- in test/db/period-roll-dst.test.ts pass by construction rather than by luck --
-- 2026-03-08 is 23 hours long in America/New_York and the period boundary does
-- not care, because it is a date and not an instant.
--
-- ---------------------------------------------------------------------------
-- Which sum the Ready-to-Assign identity is over (a correction to 07 §1.2)
-- ---------------------------------------------------------------------------
--
-- 07 §1.2 line 77-80 states the identity as
--
--     RTA(p) = Σ_a balance(a)               # credit balances are negative
--            − Σ_c available(c, p)          # "includes credit-card payment categories"
--            − Σ_{p'>p} Σ_c assigned(c, p')
--
-- Those two annotations cannot both hold: a credit purchase moves the card's
-- balance down by |amt| *and* moves |amt| of envelope money from the category
-- into CCP[card], so counting the card balance and the CCP envelope in the same
-- equation books the same dollars twice. Worked in full in
-- docs/evidence/phase-2/wp2.1-budgeting.md §2; the short version is that with
-- both terms in, a $50 credit purchase moves RTA by −$50, and a credit purchase
-- out of an already-funded envelope must move RTA by $0.
--
-- The exact form, and what this schema implements, keeps the memo's right-hand
-- side and drops CCP from the left:
--
--     Σ_{lines WHERE kind='category'} available + RTA + future assignments
--       = Σ_{on-budget accounts} balance                              (identity I)
--
-- and pairs it with the card identity that makes `credit_card_payment` lines
-- load-bearing rather than decorative:
--
--     owed(card) = available(CCP[card]) + unfunded_debt(CCP[card])    (identity II)
--
-- "every dollar owed on a card is either earmarked to pay it, or was borrowed
-- without envelope money behind it." Identity II is why `unfunded_debt_minor`
-- exists below: without it, deleting the CCP auto-line leaves identity I green
-- and the error invisible, which is the exact failure shape the Phase 1 gates
-- kept finding.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- budgets: the settings, one row per budget (one per user in practice).
-- ---------------------------------------------------------------------------
CREATE TABLE budgets (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                    TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  -- One currency per budget. Envelope math is `Money.*`, and `Money.add` throws
  -- on a currency mismatch rather than coercing, so a multi-currency budget is a
  -- different feature and not a column default away.
  currency                CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The IANA zone every period boundary in this budget is computed in. Never
  -- the container's TZ and never the browser's (docs/CONVENTIONS.md, "Time").
  timezone                TEXT        NOT NULL CHECK (length(btrim(timezone)) > 0),
  -- 07 §1.9's settings switch. Presentation and auto-assign aggressiveness
  -- only: the ledger below is identical in all four.
  mode                    TEXT        NOT NULL DEFAULT 'ENVELOPE_LITE'
                                      CHECK (mode IN ('ENVELOPE', 'ENVELOPE_LITE', 'TARGETS_ONLY', 'OFF')),
  period_kind             TEXT        NOT NULL DEFAULT 'CALENDAR_MONTH'
                                      CHECK (period_kind IN (
                                        'CALENDAR_MONTH', 'SEMIMONTHLY', 'BIWEEKLY', 'WEEKLY', 'CUSTOM')),
  -- The payday (or arbitrary date) a non-calendar grid is anchored to. 07 §1.7:
  -- "biweekly anchored to an actual payday". NULL for CALENDAR_MONTH, where the
  -- first of the month is the anchor by definition.
  period_anchor_date      DATE,
  -- CUSTOM only: the fixed length in days.
  period_length_days      INTEGER     CHECK (period_length_days IS NULL
                                             OR (period_length_days >= 1 AND period_length_days <= 366)),
  -- SEMIMONTHLY only: the day the second half-month starts (YNAB's default is
  -- the 15th; 07 §1.7 leaves it open, so it is a setting).
  semimonthly_second_day  INTEGER     NOT NULL DEFAULT 16
                                      CHECK (semimonthly_second_day BETWEEN 2 AND 28),
  -- 07 §1.9 step 2: assign `needed_this_period` from RTA by priority on roll.
  -- Off is a supported configuration, not a broken one -- ENVELOPE (strict) runs
  -- with it off.
  auto_assign             BOOLEAN     NOT NULL DEFAULT true,
  -- Which accounts this budget considers on-budget, as an *exclusion* list.
  --
  -- `accounts` has no `on_budget` column (0004_ledger.sql) and adding one would
  -- be `@ctx/budgeting` writing `@ctx/ledger`'s table. So the default is a rule
  -- -- open, non-closed `depository` / `credit` / asset `manual` accounts -- and
  -- this column holds the ids the user has taken back out. An exclusion list
  -- rather than an inclusion list because a newly linked checking account should
  -- appear in the budget without a second action, and because an inclusion list
  -- that silently omits an account breaks the Ready-to-Assign identity in the
  -- one direction nobody notices (more money than the budget knows about).
  off_budget_account_ids  JSONB       NOT NULL DEFAULT '[]'::jsonb
                                      CHECK (jsonb_typeof(off_budget_account_ids) = 'array'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT budgets_custom_has_length CHECK (
    period_kind <> 'CUSTOM' OR (period_length_days IS NOT NULL AND period_anchor_date IS NOT NULL)
  ),
  -- The other direction too. A length left behind by a user who switched from
  -- CUSTOM to CALENDAR_MONTH is a number the grid generator must be able to
  -- ignore, and "must be able to ignore" is the shape of a bug that only shows
  -- up when someone switches back.
  CONSTRAINT budgets_length_only_custom CHECK (
    period_kind = 'CUSTOM' OR period_length_days IS NULL
  ),
  CONSTRAINT budgets_anchored_kinds_have_anchor CHECK (
    period_kind NOT IN ('BIWEEKLY', 'WEEKLY') OR period_anchor_date IS NOT NULL
  )
);

CREATE UNIQUE INDEX budgets_user_name_idx ON budgets (user_id, name);

COMMENT ON TABLE budgets IS
  'Envelope-lite budget settings; the period grid is generated from them. Owner: @ctx/budgeting.';
COMMENT ON COLUMN budgets.off_budget_account_ids IS
  'Ledger account ids the user excluded. Opaque UUIDs: @ctx/ledger owns accounts, so there is no FK.';
COMMENT ON COLUMN budgets.timezone IS
  'IANA zone. Every period boundary is a calendar date in this zone, never an instant.';

-- ---------------------------------------------------------------------------
-- budget_periods: the half-open grid.
-- ---------------------------------------------------------------------------
CREATE TABLE budget_periods (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  budget_id               UUID        NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  -- Denormalised from `budgets.period_kind` at open time. The grid a closed
  -- period was generated under is history: changing the setting must not
  -- retroactively re-describe periods that already happened.
  kind                    TEXT        NOT NULL
                                      CHECK (kind IN (
                                        'CALENDAR_MONTH', 'SEMIMONTHLY', 'BIWEEKLY', 'WEEKLY', 'CUSTOM')),
  -- Inclusive.
  start_date              DATE        NOT NULL,
  -- EXCLUSIVE. `[start_date, end_date)`. A transaction belongs to the period
  -- with start_date <= budget_date < end_date -- exactly one, by the EXCLUDE
  -- constraint below.
  end_date                DATE        NOT NULL,
  -- Monotonic within a budget, so "the period before this one" is an integer
  -- subtraction rather than a date comparison against a grid that may have been
  -- reconfigured.
  sequence                INTEGER     NOT NULL,
  status                  TEXT        NOT NULL DEFAULT 'open'
                                      CHECK (status IN ('open', 'closed')),
  -- 07 §1.2's Ready to Assign, cached. Computed from the balance-sheet identity
  -- (never by summing income) by `recomputePeriod`, and re-derivable from
  -- scratch at any time -- test/db/rta-identity.test.ts asserts that the cached
  -- value equals the recomputed one after every mutation.
  ready_to_assign_minor   BIGINT      NOT NULL DEFAULT 0,
  -- On-budget inflows landing in this period, transfers excluded and refunds
  -- netted. Not an input to Ready to Assign -- 07 §1.2 is explicit that summing
  -- income drifts, and identity I above is what RTA comes from. This column is
  -- the denominator for `goal_type = 'PCT_OF_INCOME'` (07 §1.8) and for the
  -- 50/30/20 derived layer (07 §1.6), both of which genuinely are defined on
  -- income, and it is stored rather than recomputed so that a period's percent
  -- goal does not silently re-base when a late paycheck arrives in a later one.
  income_minor            BIGINT      NOT NULL DEFAULT 0,
  currency                CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- 07 §1.4 rule 6: "Store `available` as a *computed, cached* value with a
  -- dirty-flag cascade, never as source of truth." This is that flag. A late
  -- transaction sets it on the period containing its budget_date and on every
  -- later period, and on nothing earlier.
  dirty                   BOOLEAN     NOT NULL DEFAULT true,
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at               TIMESTAMPTZ,
  recomputed_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT budget_periods_half_open CHECK (end_date > start_date),
  CONSTRAINT budget_periods_closed_has_timestamp CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- A date in two periods double-counts its activity; a date in none loses it.
  -- Both are silent, and both destroy the Ready-to-Assign identity, so this is a
  -- constraint and not a convention (04 §2.1).
  CONSTRAINT budget_periods_no_overlap EXCLUDE USING gist (
    budget_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  )
);

CREATE UNIQUE INDEX budget_periods_sequence_idx ON budget_periods (budget_id, sequence);
CREATE UNIQUE INDEX budget_periods_start_idx ON budget_periods (budget_id, start_date);
-- "Which period contains this date?" and "which periods are dirty?" are the two
-- hot reads; both are this index.
CREATE INDEX budget_periods_range_idx ON budget_periods (budget_id, start_date, end_date);
CREATE INDEX budget_periods_dirty_idx ON budget_periods (budget_id, start_date) WHERE dirty;
CREATE INDEX budget_periods_user_idx ON budget_periods (user_id);

COMMENT ON TABLE budget_periods IS
  'Half-open [start_date, end_date) budget periods in the user zone. Owner: @ctx/budgeting.';
COMMENT ON COLUMN budget_periods.end_date IS
  'EXCLUSIVE. A transaction belongs to the period with start_date <= budget_date < end_date.';
COMMENT ON COLUMN budget_periods.ready_to_assign_minor IS
  'Cached. Computed from the balance-sheet identity of 07 §1.2, never by summing income.';
COMMENT ON COLUMN budget_periods.dirty IS
  '07 §1.4 rule 6: available is a cache with a dirty-flag cascade, never the source of truth.';

-- ---------------------------------------------------------------------------
-- budget_lines: one envelope, in one period.
-- ---------------------------------------------------------------------------
CREATE TABLE budget_lines (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  budget_id               UUID        NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  budget_period_id        UUID        NOT NULL REFERENCES budget_periods (id) ON DELETE CASCADE,
  -- 'category'            -- an ordinary envelope, keyed by a categorization id.
  -- 'credit_card_payment' -- 07 §1.3: "CCP[card] is auto-created 1:1 with each
  --                          on-budget credit account and is not user-deletable."
  kind                    TEXT        NOT NULL CHECK (kind IN ('category', 'credit_card_payment')),
  -- @ctx/categorization owns `categories`; opaque here, no FK (decision D8),
  -- exactly as `transactions.user_category_id` is opaque to @ctx/ledger.
  category_id             UUID,
  -- @ctx/ledger owns `accounts`; opaque here, no FK, same reason.
  credit_account_id       UUID,
  -- Display name for a credit-card payment line ("Chase Sapphire"). NULL for a
  -- category line, whose name comes from @ctx/categorization at read time.
  name                    TEXT,

  assigned_minor          BIGINT      NOT NULL DEFAULT 0,
  -- 07 §1.10's `budget_entry.source`. ROLLOVER_FIX is an assignment the system
  -- made to cover a prior overspend, which the UI must be able to explain.
  assigned_source         TEXT        NOT NULL DEFAULT 'USER'
                                      CHECK (assigned_source IN ('USER', 'AUTO', 'ROLLOVER_FIX')),
  -- carryover(c, p) = rollover_fn(available(c, p-1), policy). Cached; the
  -- authoritative record of how it was derived is the `rollovers` row.
  carryover_minor         BIGINT      NOT NULL DEFAULT 0,
  -- available(c, p) = carryover + assigned + activity. Cached (07 §1.4 rule 6).
  available_minor         BIGINT      NOT NULL DEFAULT 0,
  -- 07 §1.3. The split of a negative `available` into the half that has already
  -- left a depository account (red) and the half that was borrowed on a card
  -- (yellow). |min(available,0)| = cash_overspend + credit_overspend, asserted
  -- in src/envelope.test.ts.
  cash_overspend_minor    BIGINT      NOT NULL DEFAULT 0 CHECK (cash_overspend_minor >= 0),
  credit_overspend_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (credit_overspend_minor >= 0),
  -- credit_card_payment lines only: what categories funded into this card this
  -- period, and what left it as statement payments.
  funded_minor            BIGINT      NOT NULL DEFAULT 0,
  payments_minor          BIGINT      NOT NULL DEFAULT 0,
  -- credit_card_payment lines only. Identity II in this file's header: the
  -- part of what is owed on this card that no envelope ever covered, carried
  -- across periods because the debt is. Grows by `|amt| - fundable` on every
  -- credit overspend (07 §1.3) and shrinks when a refund or a payment exceeds
  -- what the CCP envelope held.
  --
  -- Non-negative: you cannot owe a negative amount of unfunded debt. An
  -- over-funded card shows as a positive `available_minor` on this line, not as
  -- a negative here, which keeps the two quantities from cancelling each other
  -- out and hiding a cascade bug.
  unfunded_debt_minor     BIGINT      NOT NULL DEFAULT 0 CHECK (unfunded_debt_minor >= 0),
  currency                CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

  rollover_policy         TEXT        NOT NULL DEFAULT 'ROLLOVER'
                                      CHECK (rollover_policy IN (
                                        'ROLLOVER', 'RESET', 'ROLLOVER_ALLOW_NEGATIVE')),
  -- 07 §1.8's six goal types.
  goal_type               TEXT        NOT NULL DEFAULT 'NONE'
                                      CHECK (goal_type IN (
                                        'NONE', 'MONTHLY_TARGET', 'TARGET_BY_DATE',
                                        'MINIMUM_BALANCE', 'PCT_OF_INCOME', 'REFILL_UP_TO')),
  goal_amount_minor       BIGINT,
  goal_target_date        DATE,
  -- PCT_OF_INCOME only. A ratio, not money: NUMERIC(7,4) and never a float.
  goal_percent            NUMERIC(7,4) CHECK (goal_percent IS NULL
                                              OR (goal_percent >= 0 AND goal_percent <= 1)),
  -- 07 §1.9 step 2: auto-assign iterates "categories by user-set priority".
  -- Lower sorts first; ties break on id so a roll is deterministic.
  priority                INTEGER     NOT NULL DEFAULT 100,
  -- 07 §1.6's derived 50/30/20 layer. Nullable: a credit-card payment line is
  -- none of the three, and an unclassified category is honest about it.
  class                   TEXT        CHECK (class IS NULL OR class IN ('NEED', 'WANT', 'SAVINGS')),
  -- Per-line half of the dirty cascade: a transaction that moved category only
  -- needs its two lines recomputed, not the whole period.
  dirty                   BOOLEAN     NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT budget_lines_category_shape CHECK (
    (kind = 'category') = (category_id IS NOT NULL)
  ),
  CONSTRAINT budget_lines_credit_shape CHECK (
    (kind = 'credit_card_payment') = (credit_account_id IS NOT NULL)
  ),
  -- A goal that needs an amount and has none is a goal that silently computes
  -- `needed_this_period = 0` forever, which looks exactly like a working goal.
  CONSTRAINT budget_lines_goal_has_amount CHECK (
    goal_type NOT IN ('MONTHLY_TARGET', 'TARGET_BY_DATE', 'MINIMUM_BALANCE', 'REFILL_UP_TO')
    OR goal_amount_minor IS NOT NULL
  ),
  CONSTRAINT budget_lines_goal_has_date CHECK (
    goal_type <> 'TARGET_BY_DATE' OR goal_target_date IS NOT NULL
  ),
  CONSTRAINT budget_lines_goal_has_percent CHECK (
    goal_type <> 'PCT_OF_INCOME' OR goal_percent IS NOT NULL
  ),
  -- Only a credit-card payment line funds or pays a card, and only a
  -- credit-card payment line can carry unfunded debt: an ordinary envelope's
  -- overspend is `available_minor < 0` and is split across
  -- cash_overspend_minor / credit_overspend_minor within its own period.
  CONSTRAINT budget_lines_funding_is_ccp CHECK (
    kind = 'credit_card_payment'
    OR (funded_minor = 0 AND payments_minor = 0 AND unfunded_debt_minor = 0)
  ),
  -- 07 §1.3: a credit-card payment line is not an envelope the user overspends,
  -- it is a pot the funding rule moves money into. The cash/credit overspend
  -- split is a property of the *category* that did the spending.
  CONSTRAINT budget_lines_ccp_has_no_overspend CHECK (
    kind <> 'credit_card_payment' OR (cash_overspend_minor = 0 AND credit_overspend_minor = 0)
  ),
  -- 07 §1.3's decomposition, as a constraint rather than as a test alone:
  -- |min(available, 0)| = cash_overspend + credit_overspend. This is what makes
  -- "cash overspend is red, credit overspend is yellow" a statement about the
  -- data instead of a statement about the renderer, and it is the cheapest
  -- possible detector for a funding rule that loses or invents a cent -- a
  -- rollover that drops one cent per period is invisible for months, and this
  -- refuses the write on the first one.
  CONSTRAINT budget_lines_overspend_splits_available CHECK (
    kind <> 'category'
    OR LEAST(available_minor, 0) = -(cash_overspend_minor + credit_overspend_minor)
  )
);

-- One envelope per category per period, and one per card per period. Partial
-- rather than one composite unique index because `category_id` and
-- `credit_account_id` are each NULL for the other kind, and NULLs do not
-- conflict in a b-tree -- a plain UNIQUE would permit two CCP lines for one card.
CREATE UNIQUE INDEX budget_lines_category_idx
  ON budget_lines (budget_period_id, category_id) WHERE kind = 'category';
CREATE UNIQUE INDEX budget_lines_credit_idx
  ON budget_lines (budget_period_id, credit_account_id) WHERE kind = 'credit_card_payment';
CREATE INDEX budget_lines_period_priority_idx ON budget_lines (budget_period_id, priority, id);
CREATE INDEX budget_lines_dirty_idx ON budget_lines (budget_period_id) WHERE dirty;
CREATE INDEX budget_lines_user_idx ON budget_lines (user_id);

COMMENT ON TABLE budget_lines IS
  'One envelope in one period: the money and the policy that governed it. Owner: @ctx/budgeting.';
COMMENT ON COLUMN budget_lines.category_id IS
  'Opaque. @ctx/categorization owns categories; a FK here would be reaching into another context (D8).';
COMMENT ON COLUMN budget_lines.available_minor IS
  'Cached carryover + assigned + activity. Derived; never trust it in a migration (07 §1.10).';

-- ---------------------------------------------------------------------------
-- budget_line_actuals: 07 §1.10's `category_period_cache`, derived.
-- ---------------------------------------------------------------------------
--
-- Split out of `budget_lines` rather than folded into it because these columns
-- have a different *provenance*: everything here is a function of the ledger
-- read through `LedgerPort`, recomputed wholesale, while `budget_lines` holds
-- what the user decided. Keeping them apart means "recompute the actuals" is a
-- delete-and-insert over one table and can never clobber an assignment.
--
-- Transfers and net refunds are excluded here, at the only place activity is
-- ever computed -- the v0.8 rung is "budgets exclude transfers and net refunds",
-- and a rule applied in two places is a rule applied inconsistently in one of
-- them. `transfer_excluded_count` and `refund_netted_count` exist so that
-- exclusion is *observable* rather than merely claimed: a report that says "0
-- transfers excluded" on a month with a card payment in it is a bug with a
-- visible symptom.
CREATE TABLE budget_line_actuals (
  id                       UUID        PRIMARY KEY,
  user_id                  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  budget_period_id         UUID        NOT NULL REFERENCES budget_periods (id) ON DELETE CASCADE,
  budget_line_id           UUID        NOT NULL REFERENCES budget_lines (id) ON DELETE CASCADE,
  -- activity(c, p), signed, house convention: negative = outflow. Net of
  -- refunds, transfers excluded.
  activity_minor           BIGINT      NOT NULL DEFAULT 0,
  -- The signed halves, so the UI can show "spent" without re-deriving it and so
  -- the credit-card funding rule has the cash half to work from (07 §1.3's
  -- `fundable` is computed against what cash spending left behind).
  cash_activity_minor      BIGINT      NOT NULL DEFAULT 0,
  credit_activity_minor    BIGINT      NOT NULL DEFAULT 0,
  -- Magnitudes, for display and for the refund-netting proof.
  outflow_minor            BIGINT      NOT NULL DEFAULT 0 CHECK (outflow_minor >= 0),
  inflow_minor             BIGINT      NOT NULL DEFAULT 0 CHECK (inflow_minor >= 0),
  refund_minor             BIGINT      NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
  currency                 CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  transaction_count        INTEGER     NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
  transfer_excluded_count  INTEGER     NOT NULL DEFAULT 0 CHECK (transfer_excluded_count >= 0),
  refund_netted_count      INTEGER     NOT NULL DEFAULT 0 CHECK (refund_netted_count >= 0),
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT budget_line_actuals_halves_sum CHECK (
    activity_minor = cash_activity_minor + credit_activity_minor
  )
);

CREATE UNIQUE INDEX budget_line_actuals_line_idx ON budget_line_actuals (budget_line_id);
CREATE INDEX budget_line_actuals_period_idx ON budget_line_actuals (budget_period_id);
CREATE INDEX budget_line_actuals_user_idx ON budget_line_actuals (user_id);

COMMENT ON TABLE budget_line_actuals IS
  'Derived per-line activity for one period; transfers excluded and refunds netted. Owner: @ctx/budgeting.';
COMMENT ON COLUMN budget_line_actuals.transfer_excluded_count IS
  'How many transactions were dropped as internal transfers. Exists so the exclusion is observable.';

-- ---------------------------------------------------------------------------
-- rollovers: one audit row per carryover, with conservation as a CHECK.
-- ---------------------------------------------------------------------------
--
-- The property WP 2.1 has to prove is `Σ rolloverOut(n) = Σ rolloverIn(n+1)`.
-- A property test proves it about the pure function; this table proves it about
-- the data, because `rollover_in_minor = rollover_out_minor` is a CHECK and not
-- a convention. What the policy *discarded* is not lost either: it lands in
-- `absorbed_by_rta_minor`, and
--
--     available_minor = rollover_out_minor + absorbed_by_rta_minor
--
-- is the second CHECK. Every cent of a closing envelope is therefore accounted
-- for in exactly one of two places, by the database.
--
-- "Absorbed by RTA" is 07 §1.3's `RTA(p+1) -= |cash_overspend(p)|` and its RESET
-- counterpart, recorded rather than applied: because Ready to Assign is computed
-- from the balance-sheet identity, a cent that does not carry forward is already
-- absent from the next period's envelopes and therefore already reflected in its
-- RTA. Applying the subtraction a second time would double-count it. This column
-- is the audit trail for a number nobody has to add up.
CREATE TABLE rollovers (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  budget_id               UUID        NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  from_period_id          UUID        NOT NULL REFERENCES budget_periods (id) ON DELETE CASCADE,
  to_period_id            UUID        NOT NULL REFERENCES budget_periods (id) ON DELETE CASCADE,
  from_line_id            UUID        NOT NULL REFERENCES budget_lines (id) ON DELETE CASCADE,
  to_line_id              UUID        NOT NULL REFERENCES budget_lines (id) ON DELETE CASCADE,
  policy                  TEXT        NOT NULL
                                      CHECK (policy IN ('ROLLOVER', 'RESET', 'ROLLOVER_ALLOW_NEGATIVE')),
  -- available(c, p) at the moment `from_period_id` closed.
  available_minor         BIGINT      NOT NULL,
  rollover_out_minor      BIGINT      NOT NULL,
  rollover_in_minor       BIGINT      NOT NULL,
  absorbed_by_rta_minor   BIGINT      NOT NULL,
  currency                CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rollovers_conservation CHECK (rollover_in_minor = rollover_out_minor),
  CONSTRAINT rollovers_nothing_lost CHECK (
    available_minor = rollover_out_minor + absorbed_by_rta_minor
  ),
  CONSTRAINT rollovers_forward_only CHECK (from_period_id <> to_period_id)
);

CREATE UNIQUE INDEX rollovers_from_line_idx ON rollovers (from_line_id);
CREATE UNIQUE INDEX rollovers_to_line_idx ON rollovers (to_line_id);
CREATE INDEX rollovers_period_idx ON rollovers (from_period_id, to_period_id);
CREATE INDEX rollovers_user_idx ON rollovers (user_id);

COMMENT ON TABLE rollovers IS
  'One row per carryover. Conservation (in = out) and completeness (available = out + absorbed) are CHECKs. Owner: @ctx/budgeting.';
COMMENT ON COLUMN rollovers.absorbed_by_rta_minor IS
  'The part the policy discarded. Recorded, not applied: RTA comes from the identity and already reflects it.';

-- ---------------------------------------------------------------------------
-- budget_alerts_state: edge-triggering for BudgetThresholdCrossed.
-- ---------------------------------------------------------------------------
--
-- A threshold event has to fire on the *crossing*, once. Recomputing a period
-- after every sync page would otherwise emit "80% of Groceries spent" on every
-- page for the rest of the month, and WP 2.4's coalescing window would be
-- papering over a bug in this context rather than doing its job. So the crossing
-- is state: a row exists once the threshold has been crossed and is deleted (not
-- updated) when a recompute puts the line back below it, which is what makes a
-- re-crossing after a refund fire again.
CREATE TABLE budget_alerts_state (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  budget_id               UUID        NOT NULL REFERENCES budgets (id) ON DELETE CASCADE,
  budget_period_id        UUID        NOT NULL REFERENCES budget_periods (id) ON DELETE CASCADE,
  -- NULL for a budget-wide threshold (RTA_NEGATIVE), set for a line threshold.
  budget_line_id          UUID        REFERENCES budget_lines (id) ON DELETE CASCADE,
  threshold               TEXT        NOT NULL
                                      CHECK (threshold IN (
                                        'PCT_50', 'PCT_80', 'PCT_100',
                                        'OVERSPENT_CASH', 'OVERSPENT_CREDIT', 'RTA_NEGATIVE')),
  -- spent / assigned at the moment of crossing. A ratio, not money.
  ratio                   NUMERIC(7,4),
  -- The `domain_events.id` this crossing emitted, so an alert in the UI can be
  -- traced back to the event a notification was built from.
  event_id                UUID,
  crossed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT budget_alerts_state_line_scope CHECK (
    (threshold = 'RTA_NEGATIVE') = (budget_line_id IS NULL)
  )
);

-- Two partial unique indexes rather than one over (period, line, threshold):
-- `budget_line_id` is NULL for RTA_NEGATIVE and NULLs never conflict in a
-- b-tree, so the single index would let RTA_NEGATIVE be inserted twice.
CREATE UNIQUE INDEX budget_alerts_state_line_idx
  ON budget_alerts_state (budget_period_id, budget_line_id, threshold)
  WHERE budget_line_id IS NOT NULL;
CREATE UNIQUE INDEX budget_alerts_state_period_idx
  ON budget_alerts_state (budget_period_id, threshold)
  WHERE budget_line_id IS NULL;
CREATE INDEX budget_alerts_state_user_idx ON budget_alerts_state (user_id);

COMMENT ON TABLE budget_alerts_state IS
  'Edge-triggering state for budgeting.BudgetThresholdCrossed: a row means "already fired". Owner: @ctx/budgeting.';
