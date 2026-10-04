-- SPDX-License-Identifier: MIT
-- 0033_health_scores: the financial health score's persistence (WP 5.8;
--                      05-phase-5-dispatch.md §3 WP 5.8, §4; 09 ADV-7, §4
--                      benchmark row 20; TRD-6).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- References only `users` (0012-era, through `@ctx/identity`) or objects this
-- file creates -- 05 §4's ordering rule. In particular this table does NOT
-- reference `advisory_briefs`/`advisory_brief_items` (0032, WP 5.6): the two
-- packages land in the same wave, and "two packages in one wave never create
-- objects the other references" (05 §4) holds exactly because this file has
-- no foreign key toward either of them. The score is computed alongside the
-- Brief by the weekly job, not stored as a child of it.
--
-- ---------------------------------------------------------------------------
-- What this schema is for
-- ---------------------------------------------------------------------------
--
-- One row per (user, ISO week): `health/score.ts#computeHealthScore`'s
-- result, stored whole and never re-derived on read -- the same posture
-- `advisory_brief_items.retirement_effect` takes toward
-- `RetirementImpactAnswer` (0032's own header). `components` and `excluded`
-- are JSONB arrays mirroring `HealthScoreResult.components` /
-- `.excluded` exactly: each computable component's value, band, weight,
-- score and direction of travel against the previous stored week; each
-- excluded component's name and reason. A component is **never** scored as
-- zero for lack of data -- it is named in `excluded` instead -- so
-- `health_scores_six_components_named` below is a database-level guarantee
-- of 09 ADV-7's own rule, not only an application one: every row names all
-- six components, computed or excluded, with no third option.
--
-- `overall` is NULL exactly when every component is excluded (no data at
-- all to score) -- `health_scores_overall_requires_components` pins that
-- pairing the same way `advisory_brief_items_score_matches_factors` pins
-- score/scoreFactors in 0032.

CREATE TABLE health_scores (
  id             UUID         PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- ISO 8601 week-numbering date, `YYYY-Www` (e.g. `2026-W40`). Weeks 01-53.
  -- Same pattern as `advisory_briefs.iso_week` (0032) -- deliberately not a
  -- foreign key into it; the two tables are computed together, not linked.
  iso_week       TEXT         NOT NULL
                              CHECK (iso_week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
  -- 0-100, the weighted average over the computable components only. NULL
  -- when every component is excluded -- never a score over zero components.
  overall        NUMERIC(5,2) CHECK (overall >= 0 AND overall <= 100),
  -- `HealthComponentResult[]`: `{ component, value, band, weight, score,
  -- direction }` per computable component, in `HEALTH_COMPONENT_IDS` order.
  -- `value` is a decimal string or `{minor, currency}` -- never a JSON
  -- number (docs/CONVENTIONS.md; `scripts/check-numeric-boundaries.ts`).
  components     JSONB        NOT NULL DEFAULT '[]'
                              CHECK (jsonb_typeof(components) = 'array'),
  -- `HealthExcludedComponent[]`: `{ component, reason }` per excluded
  -- component -- named, never silently dropped and never scored as zero.
  excluded       JSONB        NOT NULL DEFAULT '[]'
                              CHECK (jsonb_typeof(excluded) = 'array'),
  computed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- 09 ADV-7: "it decomposes into named components ... no opaque single
  -- number" -- mechanised as "every row names exactly six components,
  -- computed or excluded, never fewer and never a seventh".
  CONSTRAINT health_scores_six_components_named CHECK (
    jsonb_array_length(components) + jsonb_array_length(excluded) = 6
  ),
  -- A component with no data is excluded and named, never scored as zero
  -- (05 §3 WP 5.8's own exit test) -- the database-level half of it: an
  -- overall figure can exist only when at least one component was
  -- computable, and an overall figure never appears with zero computable
  -- components either.
  CONSTRAINT health_scores_overall_requires_components CHECK (
    (overall IS NULL) = (jsonb_array_length(components) = 0)
  )
);

-- The idempotency boundary: one score per holder per week. Also what
-- "direction of travel against the previous stored week" reads backward
-- from -- `previousComponentScoresFor` looks up `(user_id, previousIsoWeek)`
-- against this exact index.
CREATE UNIQUE INDEX health_scores_user_week_idx
  ON health_scores (user_id, iso_week);

COMMENT ON TABLE health_scores IS
  'One row per (user, ISO week), inserted once and never updated. health/score.ts#computeHealthScore''s result, stored whole: never re-derived on read (WP 5.8).';
COMMENT ON COLUMN health_scores.overall IS
  '0-100, the weighted average over computable components only. NULL exactly when every component is excluded -- never a score over zero components.';
COMMENT ON COLUMN health_scores.components IS
  'HealthComponentResult[]: component, value (a decimal string or {minor,currency}, never a JSON number), band, weight, score and direction of travel against the previous stored week.';
COMMENT ON COLUMN health_scores.excluded IS
  'HealthExcludedComponent[]: a component with no data, named with its reason -- never scored as zero.';
