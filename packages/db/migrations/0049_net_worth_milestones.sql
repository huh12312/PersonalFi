-- SPDX-License-Identifier: MIT
-- 0049_net_worth_milestones: a round net-worth figure crossed, once per holder (WP 10.13, V6 of the
--                            visual programme; docs/research/10-visual-design-notes.md §3 V6).
--
-- Forward-only and expand-only: one new @ctx/planning table; nothing altered, nothing dropped, nothing
-- backfilled. References only `users`. Immutable once merged.
--
-- A row is written by the net-worth snapshotter (`snapshot.ts#runSnapshot`, in the same transaction as
-- the day it computed) when the latest day's net worth has crossed a milestone since the previous
-- snapshot day: $10k, $25k, $50k, $100k and then every $100k going up, and the zero line in either
-- direction. The unique constraint is the idempotency boundary -- a milestone is announced once per
-- holder, ever, however often the open day is recomputed or the figure dips and recovers -- and the
-- `planning.NetWorthMilestoneCrossed` event is appended only for a row this statement inserted.
--
-- `dismissed_at` is the holder's "seen it" on the dashboard's one-line notice; the notice never
-- returns once it is set.

CREATE TABLE net_worth_milestones (
  id              UUID         PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The round figure, in minor units of `currency`. 0 is the zero line.
  milestone_minor BIGINT       NOT NULL CHECK (milestone_minor >= 0),
  direction       TEXT         NOT NULL CHECK (direction IN ('up', 'down')),
  -- The base currency of the two days compared (they must agree; a crossing across a base-currency
  -- change is not detected at all).
  currency        CHAR(3)      NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The snapshot day on which the latest figure stood past the milestone.
  crossed_on      DATE         NOT NULL,
  -- The two figures compared, minor units of `currency`: the previous snapshot day's and the latest.
  previous_minor  BIGINT       NOT NULL,
  latest_minor    BIGINT       NOT NULL,
  dismissed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Only the zero line is crossed downwards; every other milestone is a figure reached going up.
  CONSTRAINT net_worth_milestones_down_is_zero_only
    CHECK (direction = 'up' OR milestone_minor = 0),
  -- The figures actually straddle the milestone in the stated direction.
  CONSTRAINT net_worth_milestones_figures_cross
    CHECK (
      (direction = 'up' AND previous_minor < milestone_minor AND latest_minor >= milestone_minor)
      OR (direction = 'down' AND previous_minor >= milestone_minor AND latest_minor < milestone_minor)
    )
);

-- The idempotency boundary: one row per holder per milestone per direction.
CREATE UNIQUE INDEX net_worth_milestones_once_idx
  ON net_worth_milestones (user_id, milestone_minor, direction);

-- The dashboard's read: the holder's milestones not yet dismissed.
CREATE INDEX net_worth_milestones_undismissed_idx
  ON net_worth_milestones (user_id, crossed_on DESC)
  WHERE dismissed_at IS NULL;

COMMENT ON TABLE net_worth_milestones IS
  'A round net-worth figure crossed (10k, 25k, 50k, 100k, then every 100k going up; zero in either direction), once per (user, milestone, direction), written by the snapshotter beside planning.NetWorthMilestoneCrossed (WP 10.13).';
COMMENT ON COLUMN net_worth_milestones.dismissed_at IS
  'Set when the holder dismisses the dashboard notice; the notice never returns after.';
