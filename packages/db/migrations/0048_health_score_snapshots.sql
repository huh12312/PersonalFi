-- SPDX-License-Identifier: MIT
-- 0048_health_score_snapshots: the financial health score, once a day (WP 10.12, V5 of the visual
--                              programme; docs/research/10-visual-design-notes.md §3 V5).
--
-- Forward-only and expand-only: one new @ctx/insights table; nothing altered, nothing dropped,
-- nothing backfilled. References only `users`. Immutable once merged.
--
-- `health_scores` (0033) stays exactly as it is: one row per ISO week, written with the Brief.
-- This table is the daily series the Health screen draws its history from -- the SAME score
-- (`health/score.ts#computeHealthScore`, unchanged), computed by the 04:10 `insights.health_snapshot`
-- job or on demand when the holder opens /health and today's row is missing. Never backfilled: a day
-- nobody computed has no row, and the screen says so rather than inventing one.
--
-- `pillars` is one JSON object per health component, six exactly, scored or withheld: a scored one
-- carries its value, band, weight, score and the inputs it was built from; a withheld one carries
-- the reason and what would unlock it. A withheld pillar is never a zero.

CREATE TABLE health_score_snapshots (
  id           UUID         PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The holder's calendar day (their display time zone), not a UTC date.
  as_of_date   DATE         NOT NULL,
  -- 0-100, the weighted average over the scored pillars. NULL exactly when every pillar is withheld.
  score        NUMERIC(5,2) CHECK (score >= 0 AND score <= 100),
  pillars      JSONB        NOT NULL
                            CONSTRAINT health_score_snapshots_six_pillars
                            CHECK (jsonb_typeof(pillars) = 'array' AND jsonb_array_length(pillars) = 6),
  computed_at  TIMESTAMPTZ  NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- A score exists exactly when at least one pillar was scored: never a score over nothing,
  -- never a missing score beside a scored pillar.
  CONSTRAINT health_score_snapshots_score_requires_pillar CHECK (
    (score IS NULL) = (NOT jsonb_path_exists(pillars, '$[*] ? (@.status == "scored")'))
  )
);

-- The idempotency boundary: one snapshot per holder per day.
CREATE UNIQUE INDEX health_score_snapshots_user_date_idx
  ON health_score_snapshots (user_id, as_of_date);

COMMENT ON TABLE health_score_snapshots IS
  'One row per (user, day), inserted once and never updated: the health score (health/score.ts, unchanged) and its six pillars with their inputs. Written by the 04:10 insights.health_snapshot job or on demand by GET /insights/health. Never backfilled (WP 10.12).';
COMMENT ON COLUMN health_score_snapshots.score IS
  '0-100 over the scored pillars only. NULL exactly when every pillar is withheld -- never a score over zero pillars.';
COMMENT ON COLUMN health_score_snapshots.pillars IS
  'Six objects, one per health component: status scored (value, band, weight, score, inputs) or withheld (reason, unlock). Values are decimal strings or {minor,currency}, never JSON numbers.';
