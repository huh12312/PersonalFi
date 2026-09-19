-- SPDX-License-Identifier: MIT
-- 0010_recurring: recurring persistence, lifecycle and forecast (WP 2.3,
--                  07 §2, 04 §5.1, decisions D18 and D25).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- What this schema is
-- ---------------------------------------------------------------------------
--
-- WP 2.2 shipped the detector as a pure function: `detectRecurring(inputs,
-- options)` takes rows carrying a D25 `merchantId` -- never a descriptor --
-- and returns streams, price changes and duplicate-service findings. It mints
-- no identifiers and writes nothing. This migration is where that output stops
-- being a value and becomes a record the user can argue with.
--
-- Five tables:
--
--   recurring_series        one detected (or human-pinned) stream. The natural
--                           key is the engine's content-derived `stream_key`,
--                           so a re-run over the same history updates rather
--                           than duplicates.
--   recurring_occurrences   the transactions a series is made of, with the
--                           residual against the predicted slot. The audit
--                           trail behind "why do you think this is monthly?"
--   recurring_candidates    the *decision log*: what was proposed, what the
--                           human said, and -- on a rejection -- the permanent
--                           `merchant -> NOT_RECURRING` override that keeps it
--                           from ever being proposed again.
--   subscription_metadata   what the user (or a future curated catalogue) knows
--                           that the transactions cannot say: service taxonomy
--                           node, bundle SKU, "this one is for someone else",
--                           usage declaration, cancellation URL.
--   price_change_events     07 §2.6 changepoints, one row per confirmed or
--                           provisional price move, with the before/after
--                           transaction ids an insight must cite.
--
-- ---------------------------------------------------------------------------
-- Detection never creates a merchant (decision D25)
-- ---------------------------------------------------------------------------
--
-- D25 made a `merchants` row mean "a payee was involved", and nothing else. A
-- detector that minted rows from descriptors would undo that silently and put
-- bank operations into budget groupings. Two structural facts here enforce it,
-- and neither is a convention somebody has to remember:
--
--   * `merchant_id` below is a bare `UUID` with **no foreign key** to
--     `merchants`, exactly as `budget_lines.category_id` is a bare UUID with no
--     foreign key to `categories` (0009) and `transactions.user_category_id` is
--     (decision D8). `@ctx/recurring` cannot reference a table it does not own.
--   * `pnpm lint:schema-ownership` fails if any non-test file in
--     `packages/contexts/recurring/` so much as names `merchants` in SQL. There
--     is therefore no write path, and `test/db/no-merchant-creation.test.ts`
--     asserts the row count *and the ids* are unchanged after a full pass.
--
-- The consequence worth stating plainly: a transaction whose merchant identity
-- D25's gate refused (`empty`, `too_few_letters`, `self_transfer`,
-- `bank_operation`) has `merchant_id IS NULL` in the ledger and is simply not
-- an input to detection. A recurring series with no payee is not a thing this
-- schema can express, which is the point.
--
-- ---------------------------------------------------------------------------
-- No float, anywhere
-- ---------------------------------------------------------------------------
--
-- Decision D3 and docs/CONVENTIONS.md "Money". Every monetary column is a
-- (`BIGINT` minor units, `CHAR(3)` currency) pair. The detector's confidence,
-- cadence score, amount coefficient of variation and coverage are genuinely
-- floats -- they are scores, not money -- and they are stored as
-- `NUMERIC(7,6)` / `NUMERIC(10,6)` rather than `REAL`, because
-- `packages/db/test/migrate.test.ts` bans `REAL`/`DOUBLE PRECISION`/`FLOAT`
-- outright across the schema and a unit-interval score loses nothing by being
-- exact. No `NUMERIC(38,18)` quantity column appears here: nothing in recurring
-- detection is a security or crypto quantity, and inventing a column to match a
-- convention it does not need would be worse than saying so.
--
-- Every instant is `TIMESTAMPTZ`; every business date -- an anchor, a due date,
-- a price-change effective date -- is `DATE`, carried as `DateOnly`. A next-due
-- date is a calendar date in the user's zone, and converting it through an
-- instant is how a charge due on the 1st becomes due on the 31st.
--
-- ---------------------------------------------------------------------------
-- `state` and `status` are two different questions
-- ---------------------------------------------------------------------------
--
-- A series carries both and they are not redundant:
--
--   * `state` is *our* relationship with the row: `CANDIDATE` (detected, below
--     the auto-confirm bar, waiting for a human), `ACTIVE` (auto-confirmed at
--     >= 0.80 or pinned by the user), `ARCHIVED` (detection no longer sees it
--     and no human ever vouched for it). It decides whether the row is allowed
--     to appear in a forecast.
--   * `status` is the *stream's* lifecycle as 07 §2.8's dormancy ladder scores
--     it: `EARLY_DETECTION`, `ACTIVE`, `AT_RISK`, `MIGRATED`, `LIKELY_CANCELED`,
--     `CANCELED`. It decides what the user is told.
--
-- Collapsing them would make "the user confirmed this subscription and it then
-- went dormant" unrepresentable, which is precisely the state the dormancy
-- prompt exists for.
--
-- ---------------------------------------------------------------------------
-- `user_confirmed` pins, permanently
-- ---------------------------------------------------------------------------
--
-- 04 §5.1: "`user_confirmed = true` pins a series permanently -- detection never
-- overrides a human." That sentence is load-bearing and is enforced in three
-- places: `recurring_series.user_confirmed` is never written `false` by the
-- detection path (only by an explicit user action), an undetected confirmed
-- series is never archived by the sweep, and `test/db/lifecycle.test.ts` ->
-- `'a confirmed series survives a re-run that would have rejected it'` asserts
-- it against an unconfirmed control that *is* archived under identical
-- conditions -- so the test cannot pass vacuously.
--
-- The mirror image is the rejection. `recurring_candidates` is append-and-decide
-- rather than a queue that empties: a rejected row keeps `override =
-- 'NOT_RECURRING'` forever, and the detection pass reads those overrides
-- *before* it reads transactions, so a rejected merchant's rows never reach the
-- engine at all. "Never proposed again" is therefore a property of what we feed
-- the detector, not of a filter somebody might forget to apply to its output.

-- ---------------------------------------------------------------------------
-- recurring_series
-- ---------------------------------------------------------------------------

CREATE TABLE recurring_series (
  id                        UUID        PRIMARY KEY,
  user_id                   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The engine's content-derived key: `merchantId:sign:currency:bucket[:anchor]`.
  -- Stable across re-runs over the same history, which is what makes the upsert
  -- below an update rather than a duplicate. Never shown to a user.
  stream_key                TEXT        NOT NULL CHECK (length(btrim(stream_key)) > 0),
  -- @ctx/ledger's `merchants.id`. Opaque here, and deliberately NOT a foreign
  -- key -- see the header on D25. A series always has one: a row whose merchant
  -- identity was refused is never an input to detection.
  merchant_id               UUID        NOT NULL,
  sign                      TEXT        NOT NULL CHECK (sign IN ('OUTFLOW', 'INFLOW')),
  currency                  CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Every account the stream has ever posted on. More than one means a card was
  -- reissued (07 §2.2 CARD_MIGRATION) and `merge_proposal` says so.
  account_ids               UUID[]      NOT NULL DEFAULT '{}',

  -- Our relationship with the row. See the header: not the same question as
  -- `status`.
  state                     TEXT        NOT NULL DEFAULT 'CANDIDATE'
                                        CHECK (state IN ('CANDIDATE', 'ACTIVE', 'ARCHIVED')),
  -- 04 §5.1: pins the series permanently. Detection may never write this false.
  user_confirmed            BOOLEAN     NOT NULL DEFAULT false,
  confirmed_at              TIMESTAMPTZ,
  archived_at               TIMESTAMPTZ,
  -- Set when this series was merged into another (07 §2.2's card migration, or
  -- a user merging two rows by hand). The surviving row is the target; this one
  -- stays for its history and stops forecasting.
  merged_into_id            UUID        REFERENCES recurring_series (id) ON DELETE SET NULL,

  -- 07 §2.3 cadence inference. UNKNOWN is a real answer for a stream the engine
  -- kept but could not schedule.
  cadence                   TEXT        NOT NULL
                                        CHECK (cadence IN (
                                          'WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY',
                                          'BIMONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL',
                                          'UNKNOWN')),
  cadence_score             NUMERIC(7,6) NOT NULL DEFAULT 0
                                        CHECK (cadence_score BETWEEN 0 AND 1),
  -- Every slot is measured from this anchor, never from the previous slot, so a
  -- Feb-28 clamp releases in March instead of pinning the rest of the year.
  anchor_date               DATE        NOT NULL,
  -- SEMIMONTHLY only: the two days of the month that host the stream.
  day_of_month_pair         SMALLINT[]  CHECK (day_of_month_pair IS NULL
                                               OR array_length(day_of_month_pair, 1) = 2),

  amount_model              TEXT        NOT NULL
                                        CHECK (amount_model IN ('FIXED', 'VARIABLE', 'IRREGULAR')),
  typical_amount_minor      BIGINT      NOT NULL,
  typical_amount_currency   CHAR(3)     NOT NULL CHECK (typical_amount_currency ~ '^[A-Z]{3}$'),
  -- Median absolute deviation of the amount, in minor units. Zero for a FIXED
  -- stream, and the half-width the forecast band is built from.
  amount_mad_minor          BIGINT      NOT NULL DEFAULT 0 CHECK (amount_mad_minor >= 0),
  -- Coefficient of variation: a ratio, not money. NUMERIC rather than a float
  -- because the schema bans floats outright (migrate.test.ts).
  amount_cv                 NUMERIC(10,6) NOT NULL DEFAULT 0 CHECK (amount_cv >= 0),
  -- The smallest and largest occurrence amounts observed, in minor units. Kept
  -- because the honest forecast band for a VARIABLE stream ("we have seen
  -- between $42 and $178 from this biller") is empirical, and recomputing it
  -- from `recurring_occurrences` on every forecast read is a join the upcoming
  -- calendar does not otherwise need.
  observed_min_minor        BIGINT      NOT NULL DEFAULT 0,
  observed_max_minor        BIGINT      NOT NULL DEFAULT 0,

  type                      TEXT        NOT NULL
                                        CHECK (type IN (
                                          'SUBSCRIPTION', 'RECURRING_BILL', 'RECURRING_INCOME',
                                          'LOAN_PAYMENT', 'FREQUENT_MERCHANT', 'ONE_OFF')),
  -- 07 §2.8's dormancy ladder. The lifecycle of the *stream*, not of our
  -- relationship with it.
  status                    TEXT        NOT NULL
                                        CHECK (status IN (
                                          'EARLY_DETECTION', 'ACTIVE', 'AT_RISK', 'MIGRATED',
                                          'LIKELY_CANCELED', 'CANCELED')),
  confidence                NUMERIC(7,6) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- 07 §2.4: an EARLY_DETECTION stream never drives a $-impact insight.
  eligible_for_impact       BOOLEAN     NOT NULL DEFAULT false,

  first_seen                DATE        NOT NULL,
  last_seen                 DATE        NOT NULL,
  missed_periods            INTEGER     NOT NULL DEFAULT 0 CHECK (missed_periods >= 0),
  coverage                  NUMERIC(7,6) NOT NULL DEFAULT 0 CHECK (coverage BETWEEN 0 AND 1),

  -- 07 §2.5 next-due prediction. All three are NULL together: a CANCELED stream
  -- stops forecasting rather than forecasting zero.
  next_due_date             DATE,
  next_due_uncertainty_days INTEGER     CHECK (next_due_uncertainty_days IS NULL
                                               OR next_due_uncertainty_days >= 0),
  next_due_amount_minor     BIGINT,

  -- 07 §2.9 duplicate-service. Held on the series rather than in a sixth table
  -- because a finding is a property of a group of series and the only durable
  -- question is "has this group changed since we last said something?" --
  -- which is what stops `recurring.DuplicateServiceDetected` being re-emitted
  -- on every replay.
  duplicate_node            TEXT,
  duplicate_peer_keys       TEXT[],
  duplicate_annual_impact_minor BIGINT,

  -- Why this stream is *not* a subscription, in the engine's own vocabulary
  -- (`merchant_class_loan`, `amount_above_subscription_ceiling`, ...). Not
  -- diagnostics: it is the answer to "why is my mortgage not listed here?", so
  -- it has to survive into the read model.
  suppressions              JSONB       NOT NULL DEFAULT '[]'::jsonb
                                        CHECK (jsonb_typeof(suppressions) = 'array'),
  -- 07 §2.2's cross-account merge, persisted as a *proposal* and never applied.
  -- The whole point is that the merge is offered before a cancellation is
  -- claimed.
  merge_proposal            JSONB       CHECK (merge_proposal IS NULL
                                               OR jsonb_typeof(merge_proposal) = 'object'),
  -- Audit: who says this is recurring. `[{"source":"local_detector","version":
  -- "...","at":"...","confidence":0.94}]` today; Plaid's Recurring Transactions
  -- streams (07 §2.11's hybrid) and the user's own confirmation append here
  -- later. An array rather than a column because the interesting question is
  -- "did two independent detectors agree?", which a single `source` column
  -- cannot answer.
  sources                   JSONB       NOT NULL DEFAULT '[]'::jsonb
                                        CHECK (jsonb_typeof(sources) = 'array'),
  -- 04 §5: "every engine carries a version string that is stamped onto its
  -- outputs, so you can find and recompute everything produced by a buggy
  -- version."
  detection_version         TEXT        NOT NULL,
  last_detected_at          TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The upsert key. One row per (user, engine stream key): a re-run over the
  -- same history updates this row, and two users' identical subscriptions are
  -- two rows.
  CONSTRAINT recurring_series_user_key_uniq UNIQUE (user_id, stream_key),
  -- All three next-due columns are set together or not at all.
  CONSTRAINT recurring_series_next_due_complete CHECK (
    (next_due_date IS NULL AND next_due_uncertainty_days IS NULL AND next_due_amount_minor IS NULL)
    OR (next_due_date IS NOT NULL AND next_due_uncertainty_days IS NOT NULL
        AND next_due_amount_minor IS NOT NULL)
  ),
  -- A confirmed series carries the instant it was confirmed. Without this, "the
  -- user confirmed it" and "we do not know when" become indistinguishable, and
  -- the audit trail 07 §7.3 calls non-negotiable has a hole in it.
  CONSTRAINT recurring_series_confirmed_has_instant CHECK (
    user_confirmed = false OR confirmed_at IS NOT NULL
  ),
  CONSTRAINT recurring_series_archived_has_instant CHECK (
    state <> 'ARCHIVED' OR archived_at IS NOT NULL
  ),
  -- The pin, in the schema rather than only in the code: a confirmed series can
  -- never be in the ARCHIVED state. The detection sweep skips confirmed rows;
  -- this is what makes a future sweep that forgets to unable to commit.
  CONSTRAINT recurring_series_confirmed_not_archived CHECK (
    user_confirmed = false OR state <> 'ARCHIVED'
  ),
  CONSTRAINT recurring_series_observed_range CHECK (observed_min_minor <= observed_max_minor)
);

-- The forecast read: "this user's live series, by when they are next due."
-- Partial, because an archived or cancelled series is most of the table after a
-- year and none of this query.
CREATE INDEX recurring_series_due_idx
  ON recurring_series (user_id, next_due_date)
  WHERE state <> 'ARCHIVED' AND next_due_date IS NOT NULL;

-- The detection pass's own read: "what do I already have for these merchants?"
CREATE INDEX recurring_series_merchant_idx ON recurring_series (user_id, merchant_id);

COMMENT ON TABLE recurring_series IS
  'One detected or human-pinned recurring stream (07 §2, decision D18). Owner: @ctx/recurring.';
COMMENT ON COLUMN recurring_series.merchant_id IS
  'Ledger merchants.id, opaque and deliberately unreferenced: @ctx/recurring has no write path to merchants (D25).';
COMMENT ON COLUMN recurring_series.user_confirmed IS
  'Pins the series permanently. Detection never writes this false and never archives a row where it is true (04 §5.1).';

-- ---------------------------------------------------------------------------
-- recurring_occurrences
-- ---------------------------------------------------------------------------
--
-- The evidence. Every insight about a stream -- a price rise, a dormancy
-- prompt, a duplicate service -- has to be clickable through to the raw
-- transactions (04 §5.1: "every insight must be clickable through to the raw
-- data, or the user cannot verify it and will not trust it"), and this is the
-- join that makes that a single index lookup rather than a re-run of the
-- detector.
--
-- The unique key is `(user_id, transaction_id)`, **not** `(series_id,
-- transaction_id)`. That is the engine's own partition property written into
-- the schema -- `grouping.test.ts` asserts "every usable row ends in exactly
-- one stream, and no other row does" -- and it is also what makes a re-run that
-- moves a transaction between series an UPDATE rather than a second row the
-- first series never cleans up.

CREATE TABLE recurring_occurrences (
  id                 UUID        PRIMARY KEY,
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  series_id          UUID        NOT NULL REFERENCES recurring_series (id) ON DELETE CASCADE,
  -- @ctx/ledger's `transactions.id`. Opaque, no foreign key: same reasoning as
  -- `merchant_id` above.
  transaction_id     UUID        NOT NULL,
  account_id         UUID        NOT NULL,
  -- The ledger's budget date. A calendar date, never an instant.
  occurred_on        DATE        NOT NULL,
  amount_minor       BIGINT      NOT NULL,
  amount_currency    CHAR(3)     NOT NULL CHECK (amount_currency ~ '^[A-Z]{3}$'),
  -- Signed days from the slot the schedule predicted; NULL when this occurrence
  -- is not one the schedule explains. The raw material of the MAD band, and the
  -- honest answer to "is this stream drifting?".
  residual_days      INTEGER,
  -- 07 §2.12's duplicate charge: a second charge on a date the schedule already
  -- explains. Both ids are kept, the date counts once, and the pair is flagged.
  duplicate_of       UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT recurring_occurrences_transaction_uniq UNIQUE (user_id, transaction_id)
);

CREATE INDEX recurring_occurrences_series_date_idx
  ON recurring_occurrences (series_id, occurred_on);

COMMENT ON TABLE recurring_occurrences IS
  'The transactions a series is made of, with residuals against the predicted slot. Owner: @ctx/recurring.';

-- ---------------------------------------------------------------------------
-- recurring_candidates
-- ---------------------------------------------------------------------------
--
-- The decision log, and the home of the permanent rejection override.
--
-- A candidate row is created the first time a stream clears the candidate bar
-- (07 §2.4's 0.55) without already being pinned. It then never disappears: the
-- human's answer is written onto it, and a rejection additionally sets
-- `override = 'NOT_RECURRING'`. The detection pass loads those overrides before
-- it loads transactions, so a rejected merchant's rows are never handed to the
-- engine.
--
-- `override_scope` exists because a single merchant can host two genuinely
-- different streams -- 07 §2.12's `ANNUAL_TO_MONTHLY` reality is exactly that,
-- an annual plan ending and a monthly one beginning at the same payee. The
-- dispatch plan specifies a `merchant -> NOT_RECURRING` override and that is
-- the default a rejection writes; `STREAM` exists so that a user who rejects
-- one of two streams at a merchant is not silently told about the other one
-- forever, and `service.ts` takes the scope as an argument rather than deciding
-- for them.
--
-- "merchantKey", in the dispatch plan's wording, is `merchant_id` here. D25
-- moved merchant identity out of descriptor text and into a `merchants` row,
-- the engine groups on that id and can see nothing else, so an override keyed
-- on anything else would be an override keyed on something the detector never
-- consults.

CREATE TABLE recurring_candidates (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  merchant_id             UUID        NOT NULL,
  stream_key              TEXT        NOT NULL CHECK (length(btrim(stream_key)) > 0),
  -- Set when the candidate became (or was matched to) a series. ON DELETE SET
  -- NULL rather than CASCADE: the decision outlives the series, and a rejection
  -- whose series row was later cleaned up must still suppress the merchant.
  series_id               UUID        REFERENCES recurring_series (id) ON DELETE SET NULL,
  state                   TEXT        NOT NULL DEFAULT 'PROPOSED'
                                      CHECK (state IN (
                                        'PROPOSED', 'CONFIRMED', 'REJECTED', 'MERGED', 'EXPIRED')),
  -- The permanent override a rejection writes. NULL for every other state.
  override                TEXT        CHECK (override IS NULL OR override = 'NOT_RECURRING'),
  override_scope          TEXT        CHECK (override_scope IS NULL
                                             OR override_scope IN ('MERCHANT', 'STREAM')),

  -- What was proposed, frozen at proposal time. Not a join to the series: the
  -- series moves on (a price rises, the cadence firms up) and the question this
  -- table answers is "what were they shown when they decided?".
  proposed_cadence        TEXT        NOT NULL,
  proposed_type           TEXT        NOT NULL,
  proposed_confidence     NUMERIC(7,6) NOT NULL CHECK (proposed_confidence BETWEEN 0 AND 1),
  proposed_amount_minor   BIGINT      NOT NULL,
  proposed_amount_currency CHAR(3)    NOT NULL CHECK (proposed_amount_currency ~ '^[A-Z]{3}$'),
  -- Same audit array as the series carries: which detectors proposed this, and
  -- at what confidence.
  sources                 JSONB       NOT NULL DEFAULT '[]'::jsonb
                                      CHECK (jsonb_typeof(sources) = 'array'),

  -- Set when a human (or the auto-confirm bar) decided. `decided_reason` is
  -- free text from the UI's reject dialog: "not mine", "this is my rent".
  decided_at              TIMESTAMPTZ,
  decided_reason          TEXT,
  merged_into_series_id   UUID        REFERENCES recurring_series (id) ON DELETE SET NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT recurring_candidates_user_key_uniq UNIQUE (user_id, stream_key),
  CONSTRAINT recurring_candidates_override_on_reject CHECK (
    (override IS NULL AND override_scope IS NULL)
    OR (state = 'REJECTED' AND override = 'NOT_RECURRING' AND override_scope IS NOT NULL)
  ),
  CONSTRAINT recurring_candidates_decided_has_instant CHECK (
    state = 'PROPOSED' OR decided_at IS NOT NULL
  ),
  CONSTRAINT recurring_candidates_merged_has_target CHECK (
    state <> 'MERGED' OR merged_into_series_id IS NOT NULL
  )
);

-- The question the detection pass asks first, before it reads one transaction:
-- "which merchants has this user permanently refused?"
CREATE INDEX recurring_candidates_override_idx
  ON recurring_candidates (user_id, merchant_id)
  WHERE override = 'NOT_RECURRING';

-- The candidate queue the UI renders.
CREATE INDEX recurring_candidates_open_idx
  ON recurring_candidates (user_id, created_at)
  WHERE state = 'PROPOSED';

COMMENT ON TABLE recurring_candidates IS
  'Candidate proposals and their permanent human decisions, incl. the merchant -> NOT_RECURRING override. Owner: @ctx/recurring.';
COMMENT ON COLUMN recurring_candidates.override IS
  'Set by a rejection and never cleared: the detection pass drops these merchants before the engine sees them.';

-- ---------------------------------------------------------------------------
-- subscription_metadata
-- ---------------------------------------------------------------------------
--
-- What the transactions cannot say.
--
-- This table is not decoration: `service.ts` reads it *back into* detection as
-- the engine's `MerchantFacts`, so a user marking a stream "for someone else"
-- (07 §2.9 refinement b) or declaring a merchant a loan changes what the next
-- pass concludes. A metadata table that only flows outward would drift from the
-- detector within a week.
--
-- 07 §2.10 is the reason `usage_declaration` carries a `usage_source`: we have
-- no usage telemetry, must not claim to detect unused subscriptions from
-- transactions alone, and only a `USER_DECLARED` answer earns a confident
-- message.

CREATE TABLE subscription_metadata (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  series_id               UUID        NOT NULL REFERENCES recurring_series (id) ON DELETE CASCADE,
  -- 07 §2.9's taxonomy node, e.g. `media/video`. A taxonomy key, never a
  -- merchant name -- the engine compares two of these for equality and is not
  -- allowed to read either as text about a payee.
  service_node            TEXT,
  -- 07 §2.9 refinement (a): this price matches a known bundle SKU, so the
  -- duplicate-service finding is suppressed.
  bundle_sku              TEXT,
  -- 07 §2.9 refinement (b): "this one is for someone else". Suppresses
  -- permanently.
  for_someone_else        BOOLEAN     NOT NULL DEFAULT false,
  -- Lets a user (or a future curated catalogue) tell the detector what a payee
  -- is, which drives 07 §2.4's merchant prior and gates stream typing. NULL
  -- means UNKNOWN, which is what the engine assumes without this row.
  merchant_class          TEXT        CHECK (merchant_class IS NULL OR merchant_class IN (
                                        'SUBSCRIPTION', 'UTILITY', 'LOAN', 'TAX', 'P2P',
                                        'RETAIL', 'PAYROLL', 'UNKNOWN')),
  plan_name               TEXT,
  -- 07 §2.7's seeded standard-price table, per series. The free-trial rule is
  -- WP 2.7's and is not implemented; the column is where its input lands.
  standard_price_minor    BIGINT,
  standard_price_currency CHAR(3)     CHECK (standard_price_currency IS NULL
                                             OR standard_price_currency ~ '^[A-Z]{3}$'),
  -- 07 §2.10: no usage telemetry exists. USER_DECLARED is the only source that
  -- earns a confident message; HEURISTIC is corroborating signal and says so.
  usage_declaration       TEXT        CHECK (usage_declaration IS NULL
                                             OR usage_declaration IN ('USED', 'UNUSED', 'UNKNOWN')),
  usage_source            TEXT        CHECK (usage_source IS NULL
                                             OR usage_source IN ('USER_DECLARED', 'HEURISTIC')),
  usage_declared_at       TIMESTAMPTZ,
  cancel_url              TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT subscription_metadata_series_uniq UNIQUE (series_id),
  CONSTRAINT subscription_metadata_price_pair CHECK (
    (standard_price_minor IS NULL) = (standard_price_currency IS NULL)
  ),
  CONSTRAINT subscription_metadata_usage_has_source CHECK (
    usage_declaration IS NULL OR usage_source IS NOT NULL
  )
);

CREATE INDEX subscription_metadata_user_idx ON subscription_metadata (user_id);

COMMENT ON TABLE subscription_metadata IS
  'Per-series facts the transactions cannot supply; read back into detection as MerchantFacts. Owner: @ctx/recurring.';

-- ---------------------------------------------------------------------------
-- price_change_events
-- ---------------------------------------------------------------------------
--
-- 07 §2.6 / 04 §5.1 stage 3: a price change is a two-sided changepoint, not an
-- outlier. The engine requires stability on *both* sides, which is what
-- separates a genuine rise from a one-off proration.
--
-- `confirmed` carries 07 §2.6's guard: a change is only P1 once the *next*
-- occurrence confirms it, unless the jump exceeds 15% of the baseline. An
-- unconfirmed row is still recorded -- it is what the following pass upgrades
-- rather than re-derives -- and `recurring.PriceChangeDetected` is emitted for
-- both, with the flag in the payload, because a notification rule is entitled
-- to wait for confirmation and an audit trail is not.
--
-- The two id arrays are the evidence an insight must cite. Without them, "your
-- Netflix went up 15%" is an assertion the user cannot check.

CREATE TABLE price_change_events (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  series_id               UUID        NOT NULL REFERENCES recurring_series (id) ON DELETE CASCADE,
  direction               TEXT        NOT NULL CHECK (direction IN ('INCREASE', 'DECREASE')),
  -- The date of the first occurrence at the new amount.
  effective_date          DATE        NOT NULL,
  -- **Magnitudes**, not signed amounts: the engine models a price on the size of
  -- the charge, so a $15.99 subscription rising to $18.99 is `from = 1599`,
  -- `to = 1899`, `direction = 'INCREASE'`, whichever way the house sign
  -- convention points the underlying transactions. The `sign` that says whether
  -- this is money leaving or arriving lives on the series, once, and is not
  -- duplicated here where it could disagree.
  from_minor              BIGINT      NOT NULL CHECK (from_minor >= 0),
  to_minor                BIGINT      NOT NULL CHECK (to_minor >= 0),
  -- `|to - from|`, carried rather than computed so a reader cannot re-derive it
  -- with the opposite sign convention.
  delta_minor             BIGINT      NOT NULL CHECK (delta_minor > 0),
  -- `delta × periodsPerYear(cadence)`. Exact bigint arithmetic; never a float
  -- multiplied by 12 and rounded.
  annual_impact_minor     BIGINT      NOT NULL,
  currency                CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  confirmed               BOOLEAN     NOT NULL DEFAULT false,
  prior_transaction_ids   UUID[]      NOT NULL DEFAULT '{}',
  recent_transaction_ids  UUID[]      NOT NULL DEFAULT '{}',
  -- Set by @ctx/notifications (WP 2.4) when this change has been announced, so
  -- a re-detection does not announce it twice. Nullable and unset here: this
  -- context writes the fact, not the delivery.
  notified_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The idempotence key. One changepoint per (series, effective date,
  -- direction): a re-run over the same history upgrades `confirmed` rather than
  -- appending a second row, which is what makes "replaying the consumer twice
  -- produces identical rows" true of this table.
  CONSTRAINT price_change_events_natural_uniq UNIQUE (series_id, effective_date, direction),
  CONSTRAINT price_change_events_delta_consistent CHECK (delta_minor = abs(to_minor - from_minor)),
  CONSTRAINT price_change_events_direction_agrees CHECK (
    (direction = 'INCREASE' AND to_minor > from_minor)
    OR (direction = 'DECREASE' AND to_minor < from_minor)
  )
);

CREATE INDEX price_change_events_user_date_idx
  ON price_change_events (user_id, effective_date DESC);

COMMENT ON TABLE price_change_events IS
  'Two-sided price changepoints with the before/after transaction ids an insight must cite (07 §2.6). Owner: @ctx/recurring.';
