-- SPDX-License-Identifier: MIT
-- 0012_insights: the Advisor contract's persistence -- the registry, the scope
--                grants, the run log, the review queue and its evidence, and
--                the dismissal ladder (WP 2.6, 08 §4, decisions D6, D22).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- What this schema is for
-- ---------------------------------------------------------------------------
--
-- Insights is the only context that reads broadly. Every other one owns its
-- corner; this one assembles a view over the ledger, the budget and the
-- recurring streams, hands it to something that may in Phase 5 be a language
-- model and in Phase 6 a third-party sidecar, and takes back a list of claims
-- about the user's money.
--
-- So the tables below are shaped by one question -- *what can an advisor's
-- return value cause to happen?* -- and the answer the schema enforces is
-- **nothing except a row in a review queue**:
--
--   * `insights.status` starts at `pending_review` and there is no column an
--     advisor's payload maps onto that could set it otherwise. The wire schema
--     has no `status` property at all (`AdvisorResponse`), `requires_review` is
--     the literal `true`, and the only TypeScript value the insert accepts is a
--     `ValidatedInsight`, which the validation pipeline is the sole constructor
--     of. Three mechanisms, one claim, and
--     `packages/contexts/insights/test/pending-review.test.ts` sabotages each.
--   * `insight_actions.kind` is a closed set of four non-acting members
--     (`insight_actions_kind_is_not_an_action`). There is no `execute`, no
--     `transfer`, no `trade`: they are absent from the CHECK, from the wire
--     enum and from the TypeScript union, so smuggling one requires editing
--     three reviewed files rather than forgetting one guard.
--   * `insight_evidence` cannot hold a row that points at nothing
--     (`insight_evidence_is_citable`). 04 §5.1 -- "every insight must be
--     clickable through to the raw data" -- is a NOT NULL disjunction here, and
--     the *resolution* of the ref against the snapshot we actually sent is the
--     validator's step 5.
--
-- ---------------------------------------------------------------------------
-- `input_digest` is on the run and on every insight, and that is not redundant
-- ---------------------------------------------------------------------------
--
-- 08 §4.4 requires the digest of the snapshot we sent to be recorded. It is
-- stored twice on purpose. `advisor_runs.input_digest` answers "what did this
-- run see?"; `insights.input_digest` answers "what did *this insight* stand on
-- when it was first proposed?" -- and those diverge the moment an upsert
-- refreshes an existing row from a later run. Keeping only the run's would mean
-- an insight from March, still on screen in June, pointing at June's snapshot;
-- keeping only the insight's would lose the digest of a run that proposed
-- nothing, which is exactly the run somebody investigates.
--
-- The snapshot itself is deliberately **not** stored. It is the most sensitive
-- object this application constructs -- every balance, every budget line, a
-- list of the user's vendors -- and keeping a copy per run per advisor would
-- turn an in-memory assembly into a durable archive of exactly the thing 08
-- §4.2 exists to minimise. The digest plus the deterministic builder is what
-- makes the snapshot reproducible instead of retained.
--
-- ---------------------------------------------------------------------------
-- The dismissal ladder is a constraint, not a convention
-- ---------------------------------------------------------------------------
--
-- 02-phase-2-dispatch.md §6 question 4: "cooldown 30 days after one dismissal,
-- 90 after two, permanent after three". `insight_dismissals` holds one row per
-- *finding* -- `(user_id, advisor_id, insight_key)`, with no `period`, because
-- the period moves every month and a cooldown that expired with it would ask
-- the same question again on the 1st.
--
-- Two CHECKs carry the ladder's shape:
--
--   insight_dismissals_permanent_has_no_date   permanent rows have no expiry
--   insight_dismissals_permanent_is_earned     permanent implies >= 3 dismissals
--
-- The second is the interesting one. It makes "permanent" unreachable except by
-- the route the product describes: a snooze sets `suppressed_until` and never
-- touches `dismiss_count`, so no amount of snoozing can silence a finding
-- forever, and a bug that set `permanent = TRUE` on the first dismissal fails
-- the insert rather than quietly hiding a finding for good.
--
-- ---------------------------------------------------------------------------
-- Kill switches 1-3 (08 §4.6)
-- ---------------------------------------------------------------------------
--
-- Level 1 is `ADVISORS_ENABLED`, which is configuration and has no table.
-- Levels 2 and 3 are columns on `advisors`:
--
--   enabled           the user's switch, per advisor, defaulting to FALSE --
--                     an advisor that has just been registered has not yet been
--                     turned on, which is the safe direction for a row that can
--                     be inserted by an API call.
--   quarantined_at    the circuit breaker, tripped by the app after five
--                     consecutive failed runs or one run the validator mostly
--                     refused, and cleared only by a human. It does not decay:
--                     an advisor that recovered on its own after five bad
--                     nights is an advisor nobody looked at.
--
-- `advisors_quarantine_has_reason` keeps the two quarantine columns in step, so
-- a quarantined advisor always carries the sentence an operator needs.
--
-- ---------------------------------------------------------------------------
-- No foreign keys into another context's tables (decision D8/D25)
-- ---------------------------------------------------------------------------
--
-- `insights` names no `transaction_id`, no `merchant_id`, no `budget_line_id`.
-- An insight's link back to the data is its `source_ref` -- a path into the
-- snapshot -- and `insight_evidence.source_ref` is text for that reason rather
-- than out of laziness. A FK would make the insight feed unable to be rebuilt
-- after a re-categorisation, would let a DELETE in `@ctx/ledger` cascade into a
-- review queue, and would hand this context read access to tables it does not
-- own. The refs are opaque and are resolved by the API at render time.

-- ---------------------------------------------------------------------------
-- advisors -- the registry, and kill switches 2 and 3
-- ---------------------------------------------------------------------------

CREATE TABLE advisors (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The stable, human-readable id an insight is attributed to and upserted on.
  -- Lowercase, dotted: `builtin.subscriptions.price_increase`.
  advisor_id            TEXT        NOT NULL
                                    CHECK (advisor_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  version               TEXT        NOT NULL CHECK (length(btrim(version)) > 0),
  kind                  TEXT        NOT NULL
                                    CHECK (kind IN ('builtin', 'local_model', 'external')),
  -- The wire major (08 §4.4), a single integer. The artefact version
  -- (`ADVISOR_CONTRACT_VERSION`, '1.0.0') is a property of the published files
  -- and deliberately does not appear on a row.
  contract_version      INTEGER     NOT NULL CHECK (contract_version >= 1),
  display_name          TEXT        NOT NULL CHECK (length(btrim(display_name)) > 0),
  purpose               TEXT        NOT NULL CHECK (length(btrim(purpose)) > 0),
  -- The manifest as registered, verbatim. Stored whole because it is the
  -- artefact a human reviewed: reconstructing it from the columns below would
  -- produce something that is *equivalent* rather than something that is *it*.
  manifest              JSONB       NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  requires_scopes       TEXT[]      NOT NULL DEFAULT '{}',
  max_severity          TEXT        NOT NULL DEFAULT 'notable'
                                    CHECK (max_severity IN ('info', 'notable', 'warning', 'urgent')),
  deterministic         BOOLEAN     NOT NULL DEFAULT FALSE,
  produces_impact       BOOLEAN     NOT NULL DEFAULT FALSE,
  narrates_only         BOOLEAN     NOT NULL DEFAULT FALSE,
  egress_allowlist      TEXT[]      NOT NULL DEFAULT '{}',

  -- Kill switch 2: the user's, per advisor. FALSE until somebody turns it on.
  enabled               BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Kill switch 3: the breaker.
  quarantined_at        TIMESTAMPTZ,
  quarantine_reason     TEXT        CHECK (quarantine_reason IS NULL
                                           OR quarantine_reason IN ('consecutive_failures',
                                                                    'rejection_rate',
                                                                    'manual')),
  consecutive_failures  INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_run_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisors_quarantine_has_reason CHECK (
    (quarantined_at IS NULL) = (quarantine_reason IS NULL)
  ),
  -- 08 §4.3 reserves `deterministic` for advisors that are provably rule-based.
  -- The pipeline refuses the claim to anything whose kind is not `builtin`;
  -- this is the same sentence in DDL, so a row written by any path carries it.
  CONSTRAINT advisors_deterministic_is_builtin CHECK (
    NOT deterministic OR kind = 'builtin'
  ),
  -- Neither a builtin nor a local model has a network path, so an allow-list on
  -- one is either dead configuration or somebody's plan.
  CONSTRAINT advisors_egress_needs_network CHECK (
    kind = 'external' OR cardinality(egress_allowlist) = 0
  )
);

CREATE UNIQUE INDEX advisors_user_advisor_idx ON advisors (user_id, advisor_id);
CREATE INDEX advisors_user_enabled_idx ON advisors (user_id) WHERE enabled;

COMMENT ON TABLE advisors IS
  'Registered advisors: the manifest a human reviewed, plus kill switches 2 (enabled) and 3 (quarantined_at). Level 1 is ADVISORS_ENABLED and is configuration.';
COMMENT ON COLUMN advisors.enabled IS
  'Kill switch 2. Defaults FALSE: a newly registered advisor has not been turned on.';
COMMENT ON COLUMN advisors.quarantined_at IS
  'Kill switch 3. Set by the breaker, cleared only by a human; it does not decay.';

-- ---------------------------------------------------------------------------
-- snapshot_grants -- which scopes the user gave which advisor
-- ---------------------------------------------------------------------------
--
-- One row per (advisor, scope). A revocation sets `revoked_at` rather than
-- deleting, because "when did I stop letting it read my transactions?" is a
-- question a privacy-facing screen has to answer and a DELETE erases.
--
-- The per-kind ceiling (08 §4.2: `transactions.raw` is never granted to an
-- `external` advisor) is *not* a constraint here. It is applied by
-- `SnapshotBuilder.effectiveScopes` on the way out, so a grant row that becomes
-- illegitimate because an advisor's kind changed stops taking effect without
-- anybody having to find and delete it. The schema records what the user said;
-- the builder decides what that can mean.

CREATE TABLE snapshot_grants (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id            TEXT        NOT NULL,
  scope                 TEXT        NOT NULL CHECK (scope IN (
                                      'networth.summary', 'cash.summary', 'cashflow.monthly',
                                      'budgets.status', 'recurring.list', 'goals.list',
                                      'risk.profile', 'market.watchlist', 'holdings.aggregate',
                                      'holdings.detail', 'transactions.summary',
                                      'transactions.raw', 'institutions.names')),
  -- A scope the catalogue marks `requiresPerRunConsent` needs an answer per run
  -- rather than a standing grant. Recorded here so the UI can show which grants
  -- are standing and which will ask again.
  per_run_consent       BOOLEAN     NOT NULL DEFAULT FALSE,
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT snapshot_grants_revoked_after_granted CHECK (
    revoked_at IS NULL OR revoked_at >= granted_at
  )
);

CREATE UNIQUE INDEX snapshot_grants_user_advisor_scope_idx
  ON snapshot_grants (user_id, advisor_id, scope);
CREATE INDEX snapshot_grants_live_idx
  ON snapshot_grants (user_id, advisor_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE snapshot_grants IS
  'What the user granted each advisor. The per-kind ceiling is applied by SnapshotBuilder, not here: the schema records the answer, the builder decides what it can mean.';

-- ---------------------------------------------------------------------------
-- advisor_runs -- one row per invocation, including the refused ones
-- ---------------------------------------------------------------------------
--
-- A run that a kill switch refused is still a run and still gets a row, with
-- `status = 'refused'` and the switch that did it. That is the difference
-- between "advisors are off" being observable and being inferred from an
-- absence of rows -- and an absence of rows is also what a broken scheduler
-- looks like.

CREATE TABLE advisor_runs (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id            TEXT        NOT NULL,
  advisor_version       TEXT,
  trigger               TEXT        NOT NULL
                                    CHECK (trigger IN ('schedule', 'event', 'manual', 'backfill')),
  trigger_event_type    TEXT,
  status                TEXT        NOT NULL
                                    CHECK (status IN ('started', 'completed', 'failed', 'refused')),
  -- Which kill switch refused it, when one did.
  refusal               TEXT        CHECK (refusal IS NULL OR refusal IN (
                                      'advisors_disabled', 'module_disabled',
                                      'advisor_disabled', 'advisor_quarantined')),
  -- sha256 of the canonical JSON of the snapshot we sent. NULL on a refused run
  -- because a refused run never built one -- which is the point of refusing
  -- before the build rather than after it.
  input_digest          TEXT        CHECK (input_digest IS NULL
                                           OR input_digest ~ '^sha256:[0-9a-f]{64}$'),
  granted_scopes        TEXT[]      NOT NULL DEFAULT '{}',
  emitted_scopes        TEXT[]      NOT NULL DEFAULT '{}',
  proposed_count        INTEGER     NOT NULL DEFAULT 0 CHECK (proposed_count >= 0),
  accepted_count        INTEGER     NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count        INTEGER     NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  -- `[{ step, reason, index, key, detail }]`. The per-step rejection detail,
  -- kept because "advisor X keeps failing step 7" is the question this table
  -- exists to answer and a count cannot.
  rejections            JSONB       NOT NULL DEFAULT '[]'
                                    CHECK (jsonb_typeof(rejections) = 'array'),
  error_code            TEXT,
  duration_ms           INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  correlation_id        UUID        NOT NULL,
  causation_id          UUID,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisor_runs_refused_has_reason CHECK (
    (status = 'refused') = (refusal IS NOT NULL)
  ),
  CONSTRAINT advisor_runs_finished_shape CHECK (
    (status = 'started') = (finished_at IS NULL)
  ),
  -- A refused run built no snapshot; a completed one always did.
  CONSTRAINT advisor_runs_refused_sent_nothing CHECK (
    status <> 'refused' OR (input_digest IS NULL AND proposed_count = 0)
  ),
  CONSTRAINT advisor_runs_counts_add_up CHECK (
    accepted_count + rejected_count <= proposed_count
  )
);

CREATE INDEX advisor_runs_user_advisor_idx
  ON advisor_runs (user_id, advisor_id, started_at DESC);
CREATE INDEX advisor_runs_failed_idx
  ON advisor_runs (user_id, started_at DESC) WHERE status = 'failed';

COMMENT ON TABLE advisor_runs IS
  'One row per invocation, refused ones included. input_digest is what we sent; the snapshot itself is never stored (08 §4.2).';
COMMENT ON COLUMN advisor_runs.rejections IS
  'Per-insight rejection detail by pipeline step. A count cannot answer "which step does this advisor keep failing?".';

-- ---------------------------------------------------------------------------
-- insights -- the review queue
-- ---------------------------------------------------------------------------
--
-- Upserted on `(user_id, advisor_id, key, period)`. A nightly re-run of a
-- finding that is still true updates the row -- `last_proposed_at`, a refreshed
-- impact, a new run id -- and does not insert a second one, which is what
-- `'a nightly re-run updates the row rather than inserting'` asserts. The
-- period is part of the key so that last month's "dining is over budget" stays
-- a separate, historical row rather than being overwritten by this month's.

CREATE TABLE insights (
  id                        UUID        PRIMARY KEY,
  user_id                   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id                TEXT        NOT NULL,
  advisor_version           TEXT        NOT NULL,
  -- The run that most recently proposed it. Not a FK cascade target for
  -- deletion: pruning old runs must not delete a user's review queue.
  run_id                    UUID        REFERENCES advisor_runs (id) ON DELETE SET NULL,
  key                       TEXT        NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  period                    TEXT        NOT NULL CHECK (period ~ '^[A-Za-z0-9_-]{1,32}$'),
  type                      TEXT        NOT NULL CHECK (type ~ '^[A-Za-z0-9_.-]{1,64}$'),
  severity                  TEXT        NOT NULL
                                        CHECK (severity IN ('info', 'notable', 'warning', 'urgent')),
  -- TRUE when the manifest's ceiling lowered what the advisor asked for. Kept
  -- so "this advisor keeps trying to shout" has an answer (08 §4.4).
  severity_clamped          BOOLEAN     NOT NULL DEFAULT FALSE,
  title                     TEXT        NOT NULL CHECK (length(btrim(title)) > 0),
  summary_md                TEXT        NOT NULL CHECK (length(summary_md) <= 2000),
  confidence                NUMERIC(7,6) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  confidence_basis          TEXT        NOT NULL
                                        CHECK (confidence_basis IN ('deterministic', 'heuristic', 'model')),
  horizon                   TEXT        NOT NULL
                                        CHECK (horizon IN ('immediate', 'this_period', 'next_quarter',
                                                           'this_year', 'long_term')),

  -- There is no `requires_review` column. The wire field is the literal `true`,
  -- so a column would hold one value forever; what it *means* is this:
  --
  -- Four states, and `expired` is deliberately not one of them. An insight
  -- whose `expires_at` has passed is still a proposal nobody answered, so it
  -- stays `pending_review` and the feed hides it by comparing the timestamp.
  -- Adding an `expired` status would need a `reviewed_at` to satisfy the
  -- constraint below, and writing a review timestamp for a review that never
  -- happened is how an audit column stops meaning anything.
  status                    TEXT        NOT NULL DEFAULT 'pending_review'
                                        CHECK (status IN ('pending_review', 'accepted',
                                                          'dismissed', 'snoozed')),

  impact_annualized_minor   BIGINT,
  impact_one_time_minor     BIGINT,
  impact_currency           CHAR(3),
  impact_basis              TEXT        NOT NULL DEFAULT '',
  impact_derivation_id      TEXT,
  -- `[{ id, expression, inputs, value, note }]` as the advisor declared them,
  -- beside the values *we* computed. Stored so the UI's "how was this
  -- computed?" line is the arithmetic that was actually checked.
  derivations               JSONB       NOT NULL DEFAULT '[]'
                                        CHECK (jsonb_typeof(derivations) = 'array'),
  caveats                   JSONB       NOT NULL DEFAULT '[]'
                                        CHECK (jsonb_typeof(caveats) = 'array'),

  input_digest              TEXT        NOT NULL
                                        CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  first_proposed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_proposed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at               TIMESTAMPTZ,
  expires_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Nothing leaves `pending_review` without a recorded review. An advisor
  -- cannot produce one of these -- it has no way to set `status` and no way to
  -- set `reviewed_at` -- so the only writer of a non-pending row is the user's
  -- own action through `insight_feedback`.
  CONSTRAINT insights_reviewed_has_timestamp CHECK (
    (status = 'pending_review') = (reviewed_at IS NULL)
  ),
  CONSTRAINT insights_impact_is_paired CHECK (
    (impact_annualized_minor IS NULL AND impact_one_time_minor IS NULL)
      = (impact_currency IS NULL)
  ),
  CONSTRAINT insights_proposal_order CHECK (last_proposed_at >= first_proposed_at)
);

CREATE UNIQUE INDEX insights_identity_idx
  ON insights (user_id, advisor_id, key, period);
CREATE INDEX insights_feed_idx
  ON insights (user_id, status, severity, last_proposed_at DESC);
CREATE INDEX insights_advisor_idx ON insights (user_id, advisor_id);

COMMENT ON TABLE insights IS
  'The review queue. status starts pending_review and no advisor field maps onto it; the wire schema has no status property at all (08 §4.3).';
COMMENT ON COLUMN insights.status IS
  'pending_review until a human acts. insights_reviewed_has_timestamp keeps the transition honest.';
COMMENT ON COLUMN insights.input_digest IS
  'The snapshot this insight stood on when it was last proposed. The snapshot itself is never stored.';

-- ---------------------------------------------------------------------------
-- insight_evidence -- what each claim points at
-- ---------------------------------------------------------------------------

CREATE TABLE insight_evidence (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  insight_id            UUID        NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
  -- Position in the advisor's own array, so the panel renders in the order the
  -- argument was made rather than in whatever order the rows come back.
  position              INTEGER     NOT NULL CHECK (position >= 0),
  kind                  TEXT        NOT NULL
                                    CHECK (kind IN ('metric', 'transaction', 'series',
                                                    'budget_line', 'external')),
  label                 TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
  -- What the advisor said is there. Checked against what the ref resolved to
  -- before this row exists (validator step 5), never trusted afterwards.
  value                 TEXT,
  -- `snapshot:cash_summary.accounts[0].balance.minor` or
  -- `external:https://...`. Text, and deliberately not a foreign key: see the
  -- header on decision D8/D25.
  source_ref            TEXT        CHECK (source_ref IS NULL
                                           OR source_ref ~ '^(snapshot:|external:https://)'),
  -- What the ref actually resolved to, as we rendered it. Stored so the
  -- evidence panel can show what we sent after the snapshot is gone.
  resolved_display      TEXT,
  -- The normalised https URL, for an external row that passed the advisor's own
  -- egress allow-list. Never a scheme other than https.
  href                  TEXT        CHECK (href IS NULL OR href ~ '^https://'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 04 §5.1: "every insight must be clickable through to the raw data". A row
  -- with neither a ref nor a link is not evidence.
  CONSTRAINT insight_evidence_is_citable CHECK (
    source_ref IS NOT NULL OR href IS NOT NULL
  )
);

CREATE UNIQUE INDEX insight_evidence_position_idx ON insight_evidence (insight_id, position);
CREATE INDEX insight_evidence_user_idx ON insight_evidence (user_id, insight_id);

COMMENT ON TABLE insight_evidence IS
  'One row per citation. source_ref is a path into the snapshot we sent; the validator refuses an insight whose ref does not resolve.';

-- ---------------------------------------------------------------------------
-- insight_actions -- proposals, and none of them acts
-- ---------------------------------------------------------------------------

CREATE TABLE insight_actions (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  insight_id            UUID        NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
  position              INTEGER     NOT NULL CHECK (position >= 0),
  -- The four non-acting members of 08 §4.3, and only those. `execute`,
  -- `transfer` and `trade` are not excluded by policy -- they are absent from
  -- this CHECK, from the wire enum and from the TypeScript union.
  kind                  TEXT        NOT NULL,
  label                 TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
  rationale_md          TEXT        NOT NULL DEFAULT '' CHECK (length(rationale_md) <= 1000),
  url                   TEXT        CHECK (url IS NULL OR url ~ '^https://'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT insight_actions_kind_is_not_an_action CHECK (
    kind IN ('suggest_only', 'open_url', 'create_goal_draft', 'create_rule_draft')
  ),
  CONSTRAINT insight_actions_url_is_for_links CHECK (
    kind = 'open_url' OR url IS NULL
  )
);

CREATE UNIQUE INDEX insight_actions_position_idx ON insight_actions (insight_id, position);

COMMENT ON TABLE insight_actions IS
  'Proposed actions. insight_actions_kind_is_not_an_action is the SQL half of "there is no value an advisor can return that causes an action" (08 §4.3).';

-- ---------------------------------------------------------------------------
-- insight_feedback -- what the user did, as an append-only log
-- ---------------------------------------------------------------------------
--
-- Append-only because the dismissal ladder is counted from it and because "why
-- is this hidden?" must be answerable. An UPDATE-in-place design would make a
-- third dismissal indistinguishable from a first one that was edited.

CREATE TABLE insight_feedback (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  insight_id            UUID        NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
  advisor_id            TEXT        NOT NULL,
  insight_key           TEXT        NOT NULL,
  action                TEXT        NOT NULL
                                    CHECK (action IN ('accept', 'dismiss', 'snooze', 'reopen')),
  -- A short, optional "not relevant" / "wrong" from the UI. Ranking will use
  -- the rate, not the text.
  reason                TEXT        CHECK (reason IS NULL OR length(reason) <= 240),
  snooze_until          TIMESTAMPTZ,
  correlation_id        UUID        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT insight_feedback_snooze_has_date CHECK (
    (action = 'snooze') = (snooze_until IS NOT NULL)
  )
);

CREATE INDEX insight_feedback_insight_idx ON insight_feedback (insight_id, created_at);
CREATE INDEX insight_feedback_finding_idx
  ON insight_feedback (user_id, advisor_id, insight_key, created_at);

COMMENT ON TABLE insight_feedback IS
  'Append-only log of accept/dismiss/snooze/reopen. The dismissal ladder is counted from it.';

-- ---------------------------------------------------------------------------
-- insight_dismissals -- the cooldown ladder's state
-- ---------------------------------------------------------------------------
--
-- One row per *finding* -- `(user_id, advisor_id, insight_key)` and no period.
-- See the header: a cooldown keyed on the period would expire with the month.

CREATE TABLE insight_dismissals (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id            TEXT        NOT NULL,
  insight_key           TEXT        NOT NULL,
  dismiss_count         INTEGER     NOT NULL DEFAULT 0 CHECK (dismiss_count >= 0),
  -- NULL means "not currently suppressed" *or* "permanently suppressed"; the
  -- flag below distinguishes them, and the CHECKs keep them from disagreeing.
  suppressed_until      TIMESTAMPTZ,
  permanent             BOOLEAN     NOT NULL DEFAULT FALSE,
  last_action           TEXT        CHECK (last_action IS NULL
                                           OR last_action IN ('dismiss', 'snooze', 'reopen')),
  last_action_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Permanent has no expiry: there is no date to wait for, so no clock change,
  -- timezone bug or backfill can resurrect it.
  CONSTRAINT insight_dismissals_permanent_has_no_date CHECK (
    NOT permanent OR suppressed_until IS NULL
  ),
  -- Permanent is *earned*, three dismissals deep. A snooze never touches
  -- dismiss_count, so no amount of snoozing reaches this rung, and a bug that
  -- set permanent on the first dismissal fails the write.
  CONSTRAINT insight_dismissals_permanent_is_earned CHECK (
    NOT permanent OR dismiss_count >= 3
  )
);

CREATE UNIQUE INDEX insight_dismissals_finding_idx
  ON insight_dismissals (user_id, advisor_id, insight_key);
CREATE INDEX insight_dismissals_live_idx
  ON insight_dismissals (user_id)
  WHERE permanent OR suppressed_until IS NOT NULL;

COMMENT ON TABLE insight_dismissals IS
  'The 30/90/permanent ladder, one row per finding (no period). insight_dismissals_permanent_is_earned puts the third rung in SQL.';
COMMENT ON COLUMN insight_dismissals.permanent IS
  'Reachable only at three dismissals. A snooze never advances dismiss_count.';
