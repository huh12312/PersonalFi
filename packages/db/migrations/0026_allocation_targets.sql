-- SPDX-License-Identifier: MIT
-- 0026_allocation_targets: the other half of the 3.10a ruling -- a stored
--                           target allocation and a security tag, so I1 and
--                           I5 have a field to read (WP 4.7;
--                           docs/plan/04-phase-4-dispatch.md §3 "WP 4.7";
--                           docs/evidence/phase-3/wp3.10a-snapshot-readers.md
--                           §7.2; 07 I1, I5).
--
-- Numbered 0026, not the 0023 originally assigned: `security_tags`' composite
-- FK to `securities (user_id, id)` needs the UNIQUE (user_id, id) constraint
-- `0025_investments_security_scoping.sql` adds by ALTER TABLE, and migrations
-- apply in filename order. 0023 landed first in dispatch, but 0025 (WP 4.12,
-- a different wave) reached `main` first and is immutable; a fresh-database
-- apply of 0023 before 0025 existed failed with "no unique constraint
-- matching given keys for referenced table securities". Renumbered above that
-- dependency rather than duplicating the constraint here.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Two tables, both owned by @ctx/investments -- not @ctx/planning
-- ---------------------------------------------------------------------------
--
--   allocation_targets   one row per user x asset class: the stored target
--                        weight `driftAgainstTargets` (src/analytics/drift.ts,
--                        WP 3.3) already takes as an argument.
--   security_tags        one row per user x security x tag: the holder's own
--                        claim, e.g. "this position is my employer's stock".
--
-- 08 §1.6's arrows point down: @ctx/investments may import @ctx/planning's
-- types nowhere, and @ctx/planning may read investments' published readers.
-- `risk_profile` (@ctx/planning, WP 4.1, migration 0020) *suggests* a target
-- set from the questionnaire's answers; this table is the one the drift
-- analytic actually reads, and it is Investments' because drift is an
-- investments analytic and `GET /investments/drift` is an investments route.
-- Putting the stored set in Planning would have investments reaching *up* for
-- a number its own route needs on every call -- the arrow this migration would
-- have violated if it had landed in `packages/contexts/planning/`.
--
-- ---------------------------------------------------------------------------
-- allocation_targets: a set, and what "unset" means
-- ---------------------------------------------------------------------------
--
-- A user's target *set* is every row with their `user_id`, one per asset
-- class. There is no default row and no seed: zero rows means "unset", and
-- `wp3.9-routes.md` §8 Q9 forbids treating that as an implied 60/40 -- `GET
-- /investments/drift` suppresses instead. `src/targets.ts`'s
-- `setAllocationTargets` refuses to write a set that does not sum to 1.0
-- (within the same hundredth-of-a-point tolerance `drift.ts` already uses),
-- replacing the whole set in one transaction so "the set" is never read
-- half-written. `target_weight` is a ratio in [0,1] and `band_pct` is
-- percentage points, matching `src/analytics/types.ts`'s `Ratio`
-- (`RATIO_SCALE` 10) and `Points` (`POINTS_SCALE` 4) precisions exactly, so a
-- stored target and a computed drift are never compared at two different
-- scales. `band_pct` defaults to `5.0000` -- 07 I1's absolute five-point band
-- (`DRIFT_BAND_POINTS` in `drift.ts`) -- so a user who sets a weight without
-- opinion about the band gets the rule's own default, not a wider silent one.
--
-- `asset_class` is checked against the same twelve values
-- `packages/contexts/investments/schema/securities.ts`'s `ASSET_CLASSES`
-- exports; the two lists are asserted equal in `test/targets.test.ts` so they
-- cannot drift apart the way a column CHECK and a domain rule otherwise would.
--
-- ---------------------------------------------------------------------------
-- security_tags: set explicitly, never inferred
-- ---------------------------------------------------------------------------
--
-- 07 I5, verbatim: an employer is never inferred. `employer_stock` is
-- therefore a tag the holder attaches themselves through one function
-- (`src/tags.ts`'s `setSecurityTag`) and there is no heuristic writer anywhere
-- in this context -- `test/tags.test.ts`'s structural test greps the whole
-- package for one. `watchlist` travels on the same table because both are "the
-- holder's own claim about a security" and a second table for a second tag
-- would just be this table with a different name.
--
-- The foreign key is composite -- `(user_id, security_id) REFERENCES
-- securities (user_id, id)` -- following `0025_investments_security_scoping.sql`'s
-- convention exactly (Phase 3 gate C-14): a bare `REFERENCES securities (id)`
-- proves the security exists *somewhere*, not that it belongs to the same
-- user tagging it, and this table would otherwise let one user's row tag
-- another user's security. One tag per (user, security, tag): a position can
-- carry `employer_stock` and `watchlist` at once, and setting the same tag
-- twice is idempotent rather than a second row.
--
-- ---------------------------------------------------------------------------
-- No float, and every rate is a decimal string
-- ---------------------------------------------------------------------------
--
-- `target_weight` is NUMERIC(11,10) and `band_pct` is NUMERIC(8,4); both are
-- read back by node-postgres as decimal *strings*
-- (`packages/db/src/types.ts` leaves NUMERIC alone on purpose), matching
-- `Ratio`/`Points`. `migrate.test.ts` bans REAL/DOUBLE PRECISION/FLOAT/MONEY
-- across every migration regardless.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does not do
-- ---------------------------------------------------------------------------
--
-- No idle-cash table. Dwell is derived from `holdings_snapshots` (daily since
-- migration 0014) by `src/dwell.ts`, and the earmark it is compared against is
-- `@ctx/planning`'s `cash_earmarks` (migration 0020) -- read only at the
-- composition root's `createInsightsInvestmentsPort`, which is the one place
-- allowed to read both contexts (08 §1.3 #9), and only as an amount handed in
-- as a parameter. This migration adds no column and no table for that reason:
-- there is nothing left to store.

-- ---------------------------------------------------------------------------
-- allocation_targets
-- ---------------------------------------------------------------------------

CREATE TABLE allocation_targets (
  id            UUID           PRIMARY KEY,
  user_id       UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  asset_class   TEXT           NOT NULL CHECK (asset_class IN (
                                  'US_EQUITY', 'INTL_DEV_EQUITY', 'EM_EQUITY', 'US_BOND',
                                  'INTL_BOND', 'TIPS', 'REAL_ESTATE', 'COMMODITY', 'CRYPTO',
                                  'CASH', 'OTHER', 'UNCLASSIFIED')),

  -- A ratio in [0,1], `Ratio`-scale (10 places). The *set's* sum-to-1.0 rule
  -- is enforced in `src/targets.ts` before the transaction commits, not here:
  -- a CHECK sees one row at a time and cannot see the set.
  target_weight NUMERIC(11,10) NOT NULL CHECK (target_weight >= 0 AND target_weight <= 1),

  -- Percentage points, `Points`-scale (4 places). 07 I1's absolute band.
  band_pct      NUMERIC(8,4)   NOT NULL DEFAULT 5.0000 CHECK (band_pct > 0),

  set_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- One target per asset class per user -- this is what makes "the set" a
-- well-defined thing to sum and to replace atomically.
CREATE UNIQUE INDEX allocation_targets_user_asset_class_uniq
  ON allocation_targets (user_id, asset_class);

COMMENT ON TABLE allocation_targets IS
  'A user''s stored target allocation, one row per asset class. Zero rows means unset (wp3.9-routes.md §8 Q9): GET /investments/drift suppresses rather than assuming 60/40. Owner: @ctx/investments (WP 4.7) -- drift is an investments analytic, not a planning one.';
COMMENT ON COLUMN allocation_targets.band_pct IS
  '07 I1''s absolute drift band in percentage points, defaulting to the rule''s own 5-point default (DRIFT_BAND_POINTS in src/analytics/drift.ts).';

-- ---------------------------------------------------------------------------
-- security_tags
-- ---------------------------------------------------------------------------

CREATE TABLE security_tags (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  security_id   UUID        NOT NULL,

  tag           TEXT        NOT NULL CHECK (tag IN ('employer_stock', 'watchlist')),

  set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK, 0025's convention: a tag cannot name a security belonging to
  -- another user. `securities_user_id_id_uniq` (0025) is the unique target a
  -- composite FK needs.
  CONSTRAINT security_tags_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX security_tags_user_security_tag_uniq
  ON security_tags (user_id, security_id, tag);
CREATE INDEX security_tags_user_security_idx
  ON security_tags (user_id, security_id);

COMMENT ON TABLE security_tags IS
  'The holder''s own tag on a security -- employer_stock, watchlist. Set explicitly only; 07 I5 forbids inferring an employer, and src/tags.ts is the one writer (test/tags.test.ts greps for a second). Owner: @ctx/investments (WP 4.7).';
COMMENT ON CONSTRAINT security_tags_security_belongs_to_user ON security_tags IS
  'A tag''s security must belong to the same user (0025''s C-14 convention): cross-user tagging is structurally impossible, not merely predicate-deep.';
