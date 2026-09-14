-- SPDX-License-Identifier: MIT
-- 0006_categorization: the Categorization & Rules bounded context — the taxonomy,
--                      the provider-category and MCC mapping layers, merchant
--                      profiles, user rules, the assignment ledger with its
--                      provenance, and the local classifier's corpus.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this file
-- and refuses to start if it ever changes. Destructive changes use
-- expand -> backfill -> contract across releases.
--
-- Owner of every table below: @ctx/categorization. See that package's OWNERSHIP.md.
--
-- ---------------------------------------------------------------------------
-- The four ideas this schema exists to encode
-- ---------------------------------------------------------------------------
--
-- 1. **Our taxonomy, their codes, a mapping layer between.** Risk R13 is "Plaid
--    taxonomy changes retroactively shift history". `categories` holds keys and
--    labels we wrote; `provider_category_map` translates Plaid's PFC v2 codes
--    into them. A Plaid revision edits the map and nothing else, so a budget
--    from March still means in December what it meant in March. 02 section 4.4
--    is also why the labels are ours: Plaid's CSV carries no license grant, so
--    the *structure* is a blueprint and none of their prose is in this database.
--
-- 2. **A decision is a row with provenance, not a column.** `category_assignments`
--    records which of the six tiers decided, how confident it was, which rule
--    fired, and the full chain of what every other tier said — including the
--    ones that abstained. 04 section 5.2 requires the winning stage be recorded
--    "so the UI can explain itself"; this goes further and records the losers,
--    because "why *not* the rule I wrote?" is the harder question and the one a
--    user actually asks.
--
-- 3. **History is kept, exactly one row is current.** A partial unique index
--    (`WHERE is_current`) makes that an invariant of the database rather than a
--    convention of the application — the consumer may run on two workers, and
--    uniqueness enforced in application code is uniqueness that holds until the
--    day it matters. Keeping the superseded rows is what makes the accuracy
--    measurement in docs/evidence/phase-1/wp1.4-categorization.md possible at
--    all: it compares what the engine decided against what the user confirmed,
--    and an in-place UPDATE destroys the left-hand side of that comparison.
--
-- 4. **Cross-context references are opaque, and deliberately not foreign keys.**
--    `category_assignments.transaction_id`, `merchant_profiles.ledger_merchant_id`
--    and `rules.created_from_transaction_id` all point into @ctx/ledger. None is
--    a REFERENCES clause, and that is the same decision @ctx/ledger made in the
--    other direction with `transactions.user_category_id` ("Opaque on purpose …
--    a foreign key here would be Ledger reaching into another context's table").
--    Decision D8 and `pnpm lint:schema-ownership` are what that protects, and the
--    referential integrity given up is bought back by reacting to the ledger's
--    own events plus a sweep for orphans.

-- ---------------------------------------------------------------------------
-- categories: the chart of categories, per user.
-- ---------------------------------------------------------------------------
--
-- Per user even for the system taxonomy (decision D6, taken seriously): ~150
-- rows each, once, in exchange for "rename a category" being an UPDATE rather
-- than a global mutation plus a per-user override table that every read would
-- then have to consult.
--
-- Two identifiers for one thing, on purpose. `key` ('dining.coffee') is stable
-- forever and is what rules, the PFC map and the classifier speak, so a rule
-- written in 2026 still means the same category in 2029. `id` is what a foreign
-- key points at, including @ctx/ledger's opaque `transactions.user_category_id`.
--
-- Exactly two levels. A third is a rabbit hole with no bottom and every report in
-- 07 section 3 groups on level one or level two; the CHECK below is what keeps
-- that true, since `parent_id` alone would permit any depth.
CREATE TABLE categories (
  id           UUID        PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id    UUID        REFERENCES categories (id) ON DELETE CASCADE,
  key          TEXT        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
  label        TEXT        NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  description  TEXT        NOT NULL DEFAULT '',
  kind         TEXT        NOT NULL
                           CHECK (kind IN ('income', 'expense', 'transfer', 'investment', 'other')),
  icon         TEXT        NOT NULL DEFAULT 'circle',
  sort         INTEGER     NOT NULL DEFAULT 0,
  is_system    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Archived, never deleted: a category with three years of history behind it
  -- cannot be removed without orphaning those rows or rewriting them, and
  -- rewriting history to tidy a picklist is how a ledger stops being trusted.
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A parent is a parent: exactly two levels, enforced rather than assumed.
  CONSTRAINT categories_two_levels CHECK (
    (parent_id IS NULL AND key !~ '\.') OR (parent_id IS NOT NULL AND key ~ '\.')
  ),
  CONSTRAINT categories_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX categories_user_key_idx ON categories (user_id, key);
CREATE INDEX categories_user_parent_idx ON categories (user_id, parent_id, sort);

COMMENT ON TABLE categories IS
  'The user-facing chart of categories, seeded from our own taxonomy. Owner: @ctx/categorization.';
COMMENT ON COLUMN categories.key IS
  'Stable identity. Rules, the PFC map and the classifier all speak keys, so renaming a label never breaks them.';
COMMENT ON COLUMN categories.kind IS
  'What this category does to an aggregate. transfer and investment count in neither spend nor income totals.';

-- ---------------------------------------------------------------------------
-- provider_category_map: Plaid PFC v2 -> our keys.
-- ---------------------------------------------------------------------------
--
-- Seeded with all 18 primary and 127 detailed PFC v2 codes (counts verified
-- against the published taxonomy on 2026-09-13, matching 01 section 5.4's
-- 2026-09-10 check). **Codes only.** Plaid's per-row descriptions are not here,
-- paraphrased or otherwise: 02 section 4.4 found no license grant on that
-- document. The `category_id` each code points at is ours.
--
-- It duplicates `src/pfc-map.ts` on purpose. The constant is what the engine
-- reads on the hot path; the table is what makes the mapping user-editable, so a
-- user who thinks a code belongs somewhere else says so once instead of writing
-- a rule. `source = 'user'` marks a row the seeding path must never overwrite.
CREATE TABLE provider_category_map (
  id               UUID        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL DEFAULT 'plaid',
  taxonomy_version TEXT        NOT NULL DEFAULT 'v2',
  primary_code     TEXT        NOT NULL CHECK (primary_code ~ '^[A-Z][A-Z_]*$'),
  -- NULL is the primary-only fallback row, used when `detailed` is absent or is
  -- a code this version does not know.
  detailed_code    TEXT        CHECK (detailed_code IS NULL OR detailed_code ~ '^[A-Z][A-Z_]*$'),
  category_id      UUID        NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  source           TEXT        NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'user')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT so the primary-only row (detailed_code IS NULL) can be
-- upserted by ON CONFLICT. Without it, Postgres treats every NULL as distinct
-- and re-seeding would insert a second fallback row for every primary, which is
-- exactly the idempotence the seeding test asserts.
CREATE UNIQUE INDEX provider_category_map_code_idx
  ON provider_category_map (user_id, provider, taxonomy_version, primary_code, detailed_code)
  NULLS NOT DISTINCT;

COMMENT ON TABLE provider_category_map IS
  'Provider taxonomy codes to our category keys. The layer that keeps risk R13 from moving budget history. Owner: @ctx/categorization.';

-- ---------------------------------------------------------------------------
-- mcc_codes: ISO 18245 merchant category codes.
-- ---------------------------------------------------------------------------
--
-- 981 rows from `greggles/mcc-codes` (the Unlicense, verified 2026-09-13 — 02
-- section 4.4's "ship verbatim"). The descriptions are that dataset's; the
-- `category_id` mapping is ours.
--
-- Plaid does not send MCC on /transactions/sync, so today this is fed only by a
-- CSV or OFX import that carries one — which is precisely the case where
-- `personal_finance_category` is absent and the classifier has least to work
-- with. It is wired as a classifier *feature*, not as a tier of its own: an MCC
-- says how a merchant registered with its acquirer, not what the user bought.
CREATE TABLE mcc_codes (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mcc         TEXT        NOT NULL CHECK (mcc ~ '^[0-9]{4}$'),
  description TEXT        NOT NULL,
  category_id UUID        NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mcc_codes_user_code_idx ON mcc_codes (user_id, mcc);

COMMENT ON TABLE mcc_codes IS
  'ISO 18245 codes (Unlicense data, greggles/mcc-codes) mapped to our taxonomy. Owner: @ctx/categorization.';

-- ---------------------------------------------------------------------------
-- merchant_profiles: everything about a payee that is not its identity.
-- ---------------------------------------------------------------------------
--
-- @ctx/ledger owns `merchants` and its header says this context "extends this
-- table by migration rather than owning a second one". This is that extension in
-- the only form the ownership check permits: a side table keyed on the ledger's
-- merchant id. Adding a column to `merchants` from a migration in this package
-- is exactly the reach-around `pnpm lint:schema-ownership` exists to stop, and
-- the FK that would buy referential integrity is the coupling decision D8
-- forbids. Orphans are swept by the rebuild job.
--
-- `default_category_id` is the third tier of the decision order and the highest-
-- value automation in the whole context (04 section 5.2: "it makes the app feel
-- like it's learning without any ML"). `user_locked` is 07 section 2.1's
-- "source=USER, which always wins", applied to the category rather than the name.
CREATE TABLE merchant_profiles (
  id                    UUID        PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ledger_merchant_id    UUID        NOT NULL,
  canonical_name        TEXT        NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 200),
  fingerprint           TEXT        NOT NULL,
  descriptor_patterns   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  default_category_id   UUID        REFERENCES categories (id) ON DELETE SET NULL,
  default_support_count INTEGER     NOT NULL DEFAULT 0 CHECK (default_support_count >= 0),
  user_locked           BOOLEAN     NOT NULL DEFAULT FALSE,
  provider_entity_ids   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchant_profiles_patterns_are_array CHECK (jsonb_typeof(descriptor_patterns) = 'array'),
  CONSTRAINT merchant_profiles_entities_are_array CHECK (jsonb_typeof(provider_entity_ids) = 'array'),
  -- A lock with nothing to lock is a setting that silently does nothing.
  CONSTRAINT merchant_profiles_lock_needs_category CHECK (
    user_locked = FALSE OR default_category_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX merchant_profiles_ledger_merchant_idx
  ON merchant_profiles (user_id, ledger_merchant_id);
CREATE INDEX merchant_profiles_fingerprint_idx ON merchant_profiles (user_id, fingerprint);

COMMENT ON TABLE merchant_profiles IS
  'Categorization''s extension of @ctx/ledger''s merchants: canonical name, descriptor corpus, learned default. Owner: @ctx/categorization.';
COMMENT ON COLUMN merchant_profiles.ledger_merchant_id IS
  'Opaque reference into @ctx/ledger.merchants. Not a foreign key, by decision D8.';

-- ---------------------------------------------------------------------------
-- rules: the power feature.
-- ---------------------------------------------------------------------------
--
-- Conditions and actions are JSONB rather than the `rule_conditions` /
-- `rule_actions` child tables this package's OWNERSHIP.md originally sketched.
-- A rule is read whole and written whole — there is no query that wants "rules
-- whose third condition mentions an amount" — so normalising buys a three-way
-- join on the sync path and a window where an edit leaves half a rule. The
-- safety a relational shape would buy is bought instead by the zod schemas in
-- `src/rules/schema.ts`, validated on write *and* on read, which is strictly
-- stronger: they reject an amount range whose minimum exceeds its maximum, and
-- no CHECK spread over two child tables would catch that.
--
-- A rule that fails validation on read is disabled and reported, never thrown:
-- the user's punishment for one bad rule must not be that their sync stops.
CREATE TABLE rules (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                        TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Ascending, lower wins (04 section 5.2). Seeded in tens so a rule can be
  -- inserted between two others without renumbering the list.
  priority                    INTEGER     NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  enabled                     BOOLEAN     NOT NULL DEFAULT TRUE,
  conditions                  JSONB       NOT NULL,
  actions                     JSONB       NOT NULL,
  run_on_sync                 BOOLEAN     NOT NULL DEFAULT TRUE,
  stop_processing             BOOLEAN     NOT NULL DEFAULT FALSE,
  created_from_transaction_id UUID,
  last_applied_at             TIMESTAMPTZ,
  last_applied_count          INTEGER     NOT NULL DEFAULT 0 CHECK (last_applied_count >= 0),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rules_conditions_is_object CHECK (jsonb_typeof(conditions) = 'object'),
  CONSTRAINT rules_actions_is_array CHECK (jsonb_typeof(actions) = 'array'),
  -- A rule with no actions is a rule that does nothing, which is never what the
  -- user meant and is indistinguishable afterwards from one whose actions were
  -- lost in a bad write.
  CONSTRAINT rules_actions_not_empty CHECK (jsonb_array_length(actions) > 0)
);

CREATE INDEX rules_user_priority_idx ON rules (user_id, enabled, priority, id);

COMMENT ON TABLE rules IS
  'User categorisation rules, evaluated in ascending priority. Owner: @ctx/categorization.';
COMMENT ON COLUMN rules.conditions IS
  'Validated by conditionsSchema on write and on read; a rule that fails is disabled, not thrown.';

-- ---------------------------------------------------------------------------
-- rule_runs: what an apply actually did.
-- ---------------------------------------------------------------------------
--
-- A rule that retroactively recategorised 900 transactions is something a user
-- will want to understand, and possibly undo, weeks later. Preview runs are
-- recorded too: a preview count and a later apply count that disagree is exactly
-- the signal that something moved in between, and it is invisible otherwise.
CREATE TABLE rule_runs (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule_id       UUID        NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL CHECK (mode IN ('preview', 'apply')),
  retroactive   BOOLEAN     NOT NULL DEFAULT FALSE,
  matched_count INTEGER     NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  changed_count INTEGER     NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rule_runs_changed_within_matched CHECK (changed_count <= matched_count)
);

CREATE INDEX rule_runs_rule_idx ON rule_runs (rule_id, started_at DESC);

COMMENT ON TABLE rule_runs IS
  'One row per applyRule invocation, preview or real. Owner: @ctx/categorization.';

-- ---------------------------------------------------------------------------
-- category_assignments: the decision, and everything that lost.
-- ---------------------------------------------------------------------------
--
-- See idea 3 in this file's header for why history is kept. The invariant that
-- matters operationally is the partial unique index below: **at most one current
-- assignment per transaction**, enforced by the database because the consumer
-- can run on more than one worker.
--
-- `confidence` is NUMERIC(5,4) rather than DOUBLE PRECISION for the same reason
-- @ctx/ledger's `confidenceColumn` is: the migration gate bans float types across
-- the whole schema rather than adjudicating column by column, and a ban with a
-- growing exception list stops catching the case it was written for.
--
-- `evidence` holds the full decision chain from `decide()`. Stored, not
-- recomputed: a chain recomputed next week reflects next week's rules and next
-- week's model, and would confidently explain a decision made for entirely
-- different reasons.
CREATE TABLE category_assignments (
  id             UUID          PRIMARY KEY,
  user_id        UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  transaction_id UUID          NOT NULL,
  category_id    UUID          NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  source         TEXT          NOT NULL
                               CHECK (source IN ('rule', 'provider', 'classifier', 'user', 'merchant_default')),
  confidence     NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  rule_id        UUID          REFERENCES rules (id) ON DELETE SET NULL,
  evidence       JSONB         NOT NULL DEFAULT '{}'::jsonb,
  decided_at     TIMESTAMPTZ   NOT NULL,
  version        INTEGER       NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_current     BOOLEAN       NOT NULL DEFAULT TRUE,
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- A rule-sourced assignment that names no rule cannot be explained, and an
  -- assignment from any other tier that names one is lying about its provenance.
  CONSTRAINT category_assignments_rule_provenance CHECK (
    (source = 'rule' AND rule_id IS NOT NULL) OR (source <> 'rule' AND rule_id IS NULL)
  )
);

-- The invariant. Partial, so superseded rows are unconstrained and history can
-- grow without bound while "the current category" stays single-valued.
CREATE UNIQUE INDEX category_assignments_current_idx
  ON category_assignments (transaction_id) WHERE is_current;
CREATE UNIQUE INDEX category_assignments_version_idx
  ON category_assignments (transaction_id, version);
CREATE INDEX category_assignments_user_category_idx
  ON category_assignments (user_id, category_id) WHERE is_current;
CREATE INDEX category_assignments_confirmed_idx
  ON category_assignments (user_id, confirmed_at) WHERE confirmed_at IS NOT NULL;
-- The review queue: uncertain, current, oldest first. A partial index because
-- the confident majority is never what that screen asks for.
CREATE INDEX category_assignments_review_idx
  ON category_assignments (user_id, confidence, decided_at)
  WHERE is_current AND confirmed_at IS NULL;

COMMENT ON TABLE category_assignments IS
  'One current row per transaction plus full history, each carrying the tier that decided and why. Owner: @ctx/categorization.';
COMMENT ON COLUMN category_assignments.transaction_id IS
  'Opaque reference into @ctx/ledger.transactions. Not a foreign key, by decision D8.';
COMMENT ON COLUMN category_assignments.evidence IS
  'The decision chain: every tier, including those that abstained and the reason each gave.';

-- ---------------------------------------------------------------------------
-- classifier_examples: the training corpus, as counts.
-- ---------------------------------------------------------------------------
--
-- One row per (feature, category) with a count, not one row per confirmed
-- transaction: training is a GROUP BY over this table, its size is bounded by the
-- vocabulary rather than by history length, and re-training after a thousand new
-- confirmations reads a few thousand small rows instead of joining back into the
-- ledger.
--
-- These counts are a cache. Confirmed assignments are the source of truth, and
-- the rebuild path recomputes from them rather than decrementing here — which is
-- what makes a bug in training fixable by re-running training.
CREATE TABLE classifier_examples (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  feature     TEXT        NOT NULL CHECK (length(feature) BETWEEN 1 AND 200),
  category_id UUID        NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  count       INTEGER     NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX classifier_examples_feature_idx
  ON classifier_examples (user_id, feature, category_id);
CREATE INDEX classifier_examples_category_idx ON classifier_examples (user_id, category_id);

COMMENT ON TABLE classifier_examples IS
  'Feature/category counts derived from confirmed assignments. A cache, rebuildable. Owner: @ctx/categorization.';

-- ---------------------------------------------------------------------------
-- classifier_versions: a trained model, frozen.
-- ---------------------------------------------------------------------------
--
-- Stored whole rather than rebuilt on demand, for reproducibility of an
-- *explanation*: a classifier decision recorded in January was made by January's
-- model, and "why did it think that?" is only answerable if January's model still
-- exists. `category_assignments.evidence` records the version; this is where that
-- version's parameters live.
--
-- Exactly one active row per user, enforced by a partial unique index for the
-- same reason as the assignment invariant above.
CREATE TABLE classifier_versions (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version        INTEGER     NOT NULL CHECK (version >= 0),
  model          JSONB       NOT NULL,
  example_count  INTEGER     NOT NULL DEFAULT 0 CHECK (example_count >= 0),
  category_count INTEGER     NOT NULL DEFAULT 0 CHECK (category_count >= 0),
  is_active      BOOLEAN     NOT NULL DEFAULT FALSE,
  trained_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT classifier_versions_model_is_object CHECK (jsonb_typeof(model) = 'object')
);

CREATE UNIQUE INDEX classifier_versions_user_version_idx ON classifier_versions (user_id, version);
CREATE UNIQUE INDEX classifier_versions_active_idx ON classifier_versions (user_id) WHERE is_active;

COMMENT ON TABLE classifier_versions IS
  'Frozen naive-Bayes models, one active per user, so a past decision stays explainable. Owner: @ctx/categorization.';
