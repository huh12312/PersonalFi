-- SPDX-License-Identifier: MIT
-- 0032_advisory_briefs: the Weekly Advisory Brief's persistence (WP 5.6;
--                        05-phase-5-dispatch.md §3 WP 5.6, §4; 07 §3.2/§7.3;
--                        09 ADV-1, S1).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- References only objects 0012_insights.sql created (`insights`, `users`) or
-- objects this file creates -- 05 §4's ordering rule, so a fresh install
-- applying 0032 before any other Phase 5 number converges. Nothing here
-- references `advisors`, `advisor_runs`, `insight_feedback` or any object a
-- higher-numbered Phase 5 migration creates (0033 is WP 5.8's).
--
-- ---------------------------------------------------------------------------
-- What this schema is for
-- ---------------------------------------------------------------------------
--
-- A Brief is a record of what was said, not a view over what is currently
-- true. `insights` rows are upserted on their identity -- a nightly re-run can
-- change a finding's evidence, its impact, even its title -- so a Brief that
-- read through to the live `insights`/`insight_evidence` rows would let last
-- week's "why did it say $720?" (07 §7.3) answer itself with this week's
-- numbers. Every field a Brief item displays is therefore snapshotted here at
-- publish time: `advisory_brief_items` carries its own title, summary,
-- severity, confidence, impact and evidence, none of it a foreign key into a
-- row that might later change under it. `insight_id` is kept for the "open the
-- live insight" click-through and nothing else; it is nullable and
-- `ON DELETE SET NULL` for exactly that reason -- the Brief's own record must
-- survive whatever happens to the source row.
--
-- One Brief per ISO week per holder, and immutable once published: the write
-- path this migration is designed around is "insert once, never update", and
-- `advisory_briefs_user_week_idx` is what makes a second publish attempt for
-- the same week a no-op rather than a rewrite (`src/brief/store.ts`'s
-- `publishWeeklyBrief` reads back the existing row on conflict rather than
-- ever issuing an UPDATE).

-- ---------------------------------------------------------------------------
-- advisory_briefs -- one row per (user, ISO week)
-- ---------------------------------------------------------------------------

CREATE TABLE advisory_briefs (
  id                 UUID        PRIMARY KEY,
  user_id            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- ISO 8601 week-numbering date, `YYYY-Www` (e.g. `2026-W40`). Weeks 01-53.
  iso_week           TEXT        NOT NULL
                                 CHECK (iso_week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
  currency           CHAR(3)     NOT NULL,
  -- ADV-1, principle 3: a week with nothing material says so rather than
  -- inventing filler. True exactly when the ranked section is empty --
  -- independent of the attention strip, which is a distinct, urgent-only list.
  nothing_material   BOOLEAN     NOT NULL DEFAULT FALSE,
  -- E11 cold start: under 30 days of advisor history, the Brief names what it
  -- cannot yet assess rather than guessing at a trend it has not observed.
  cold_start         BOOLEAN     NOT NULL DEFAULT FALSE,
  cold_start_note    TEXT        CHECK (cold_start_note IS NULL
                                        OR length(cold_start_note) <= 500),
  -- sha256 over the canonical set of source insights (id, key, period, their
  -- own input_digest) this Brief was assembled from -- "what did this Brief
  -- stand on?", the same question `advisor_runs.input_digest` answers for a run.
  input_digest       TEXT        NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  published_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisory_briefs_cold_start_has_note CHECK (
    (cold_start = FALSE) = (cold_start_note IS NULL)
  )
);

-- The idempotency and immutability boundary: one Brief per holder per week.
-- `publishWeeklyBrief`'s `INSERT ... ON CONFLICT (user_id, iso_week) DO
-- NOTHING` depends on this exact index existing under this exact name.
CREATE UNIQUE INDEX advisory_briefs_user_week_idx
  ON advisory_briefs (user_id, iso_week);
-- What `advisory_brief_items`'s composite FK below needs to reference.
CREATE UNIQUE INDEX advisory_briefs_user_id_idx
  ON advisory_briefs (user_id, id);

COMMENT ON TABLE advisory_briefs IS
  'One row per (user, ISO week), inserted once and never updated. A record of what the Weekly Advisory Brief said, not a view over the live insights (WP 5.6).';
COMMENT ON COLUMN advisory_briefs.input_digest IS
  'sha256 over the canonical set of source insights this Brief was built from -- the Brief''s own answer to "what did it stand on?".';
COMMENT ON COLUMN advisory_briefs.nothing_material IS
  'True when the ranked section is empty. Independent of the attention strip, which may still carry urgent no-dollar findings.';

-- ---------------------------------------------------------------------------
-- advisory_brief_items -- the ≤5 ranked actions and the attention strip
-- ---------------------------------------------------------------------------

CREATE TABLE advisory_brief_items (
  id                       UUID         PRIMARY KEY,
  user_id                  UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  brief_id                 UUID         NOT NULL,
  -- `ranked`: one of the ≤5 dollar-ranked actions. `attention`: an urgent
  -- finding with no dollar figure, shown above the five and never competing
  -- with them for a slot (05 §3 WP 5.6).
  section                  TEXT         NOT NULL CHECK (section IN ('ranked', 'attention')),
  position                 INTEGER      NOT NULL CHECK (position >= 0),
  -- The live insight, for "open this" -- never the source of what is
  -- displayed. SET NULL rather than CASCADE: this row is the Brief's own
  -- record and must survive the source insight being pruned.
  insight_id               UUID         REFERENCES insights (id) ON DELETE SET NULL,
  advisor_id               TEXT         NOT NULL
                                        CHECK (advisor_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  insight_key              TEXT         NOT NULL CHECK (insight_key ~ '^[A-Za-z0-9_.:-]{1,160}$'),
  insight_type              TEXT        NOT NULL CHECK (insight_type ~ '^[A-Za-z0-9_.-]{1,64}$'),
  severity                 TEXT         NOT NULL
                                        CHECK (severity IN ('info', 'notable', 'warning', 'urgent')),
  -- Snapshotted at publish time, per this file's header: a Brief's own text,
  -- never a live read of a row that may have since been upserted.
  title                    TEXT         NOT NULL CHECK (length(btrim(title)) > 0),
  summary_md               TEXT         NOT NULL CHECK (length(summary_md) <= 2000),
  confidence               NUMERIC(7,6) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  horizon                  TEXT         NOT NULL
                                        CHECK (horizon IN ('immediate', 'this_period',
                                                            'next_quarter', 'this_year', 'long_term')),
  -- E11: a finding still live from last week's Brief is marked carried, not new.
  carried                  BOOLEAN      NOT NULL DEFAULT FALSE,
  impact_annualized_minor  BIGINT,
  impact_one_time_minor    BIGINT,
  impact_currency          CHAR(3),
  -- `[{ position, kind, label, value, sourceRef, resolvedDisplay, href }]`,
  -- snapshotted from `insight_evidence` at publish time -- the same reason the
  -- title and summary are copied rather than joined.
  evidence                 JSONB        NOT NULL DEFAULT '[]'
                                        CHECK (jsonb_typeof(evidence) = 'array'),
  -- 07 §3.2's ranking score, without `rank()`'s severity-dominant term (05 §3
  -- WP 5.6). NULL for an attention-strip item: it was never ranked by score.
  score                    NUMERIC(30,6),
  -- `{ effectiveImpactMinor, confidence, actionability, urgency, dismissRate }`
  -- -- the factors `score` was computed from, for "why is this #3?" (07 §7.3
  -- extended to the Brief). NULL exactly when `score` is.
  score_factors            JSONB,
  -- The RetirementImpactPort's answer, whole: `{ kind: 'computed', ... }` or
  -- `{ kind: 'not_computable', reason }`. Never re-derived on read (05 §5's
  -- risk table: "a Brief never shows a retirement effect the engine did not
  -- compute").
  retirement_effect        JSONB        NOT NULL
                                        CHECK (jsonb_typeof(retirement_effect) = 'object'),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT advisory_brief_items_brief_fk
    FOREIGN KEY (user_id, brief_id) REFERENCES advisory_briefs (user_id, id) ON DELETE CASCADE,
  CONSTRAINT advisory_brief_items_score_matches_factors CHECK (
    (score IS NULL) = (score_factors IS NULL)
  ),
  CONSTRAINT advisory_brief_items_impact_is_paired CHECK (
    (impact_annualized_minor IS NULL AND impact_one_time_minor IS NULL)
      = (impact_currency IS NULL)
  )
);

CREATE UNIQUE INDEX advisory_brief_items_position_idx
  ON advisory_brief_items (brief_id, section, position);
CREATE INDEX advisory_brief_items_brief_idx
  ON advisory_brief_items (user_id, brief_id);
-- "Was this finding carried from last week?" -- one week's items looked up by
-- the pair the next week's assembly compares against.
CREATE INDEX advisory_brief_items_finding_idx
  ON advisory_brief_items (user_id, advisor_id, insight_key);

COMMENT ON TABLE advisory_brief_items IS
  'The ≤5 dollar-ranked actions (section=ranked) and the urgent no-dollar attention strip (section=attention) of one advisory_briefs row, fields snapshotted at publish time (WP 5.6).';
COMMENT ON COLUMN advisory_brief_items.retirement_effect IS
  'The RetirementImpactPort''s answer, stored whole: computed (with engineVersion/assumptionsVersion) or not_computable (with its reason). Never recomputed on read.';
COMMENT ON COLUMN advisory_brief_items.score IS
  '07 §3.2''s ranking score without rank()''s severity-dominant term. NULL for an attention-strip item, which is never ranked by score.';
