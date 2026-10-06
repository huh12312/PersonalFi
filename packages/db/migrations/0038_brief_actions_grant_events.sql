-- SPDX-License-Identifier: MIT
-- 0038_brief_actions_grant_events: a published Brief records its action (CF-24),
--                                  and every consent change is a row nobody
--                                  overwrites (O-9)
--                                  (docs/plan/09-phase-9-dispatch.md §3 "WP 9.6",
--                                   §2b CF-24, Phase 5 gate O-9).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only, as every Phase 9 migration must be (09 §4 "Every Phase 9
-- migration is expand-only -- no contract steps on a live soak"): one nullable
-- column and one new table. Nothing is altered in place, dropped or rewritten.
--
-- References only objects 0002_identity.sql, 0012_insights.sql and
-- 0032_advisory_briefs.sql created (`users`, `advisory_brief_items`) or objects
-- this file creates. It names nothing a higher-numbered migration creates, and
-- 0035 (WP 9.2, this wave) and this file never reference each other (09 §4's
-- rule for two packages in one wave).
--
-- ---------------------------------------------------------------------------
-- advisory_brief_items.primary_action  (CF-24)
-- ---------------------------------------------------------------------------
--
-- 0032's header: "a Brief is a record of what was said, not a view over what is
-- currently true" -- and it snapshots the title, summary, impact and evidence
-- at publish time for that reason. The item's action was left behind: it lives
-- in `insight_actions`, which `insights`' nightly upsert deletes and re-inserts
-- (`store.ts`), so last week's Brief could show this week's suggested next step.
-- This column is the missing snapshot: the item's first proposed action, as the
-- Brief said it, written once at publish and never updated.
--
-- Nullable, with no backfill. Every Brief published before this migration has
-- NULL, and the app reads NULL as "no action recorded" -- never as "the live
-- insight's action", which is exactly the read-through the Brief exists to
-- refuse. (The source rows for those weeks are gone or changed; inventing an
-- action for them would put words in last week's mouth.)
--
-- The shape is the four fields the app's own `insight_actions` row carries and
-- the Brief ever displayed, and the same two rules 0012 enforces on that table:
-- the kind is one of the four non-acting members of 08 §4.3 (there is no value
-- here that can name an action that does something), and a URL belongs to a
-- link and only to a link, `https://` only. A CHECK cannot hold a subquery, so
-- the key set is checked with the jsonb operators -- builtins, which resolve
-- under any search_path (F-94-6: no function is created here, so nothing in
-- this file can be missing under pg_restore's empty one).

ALTER TABLE advisory_brief_items
  ADD COLUMN primary_action JSONB;

ALTER TABLE advisory_brief_items
  ADD CONSTRAINT advisory_brief_items_primary_action_shape CHECK (
    primary_action IS NULL OR (
          jsonb_typeof(primary_action) = 'object'
      AND primary_action ?& ARRAY['kind', 'label', 'rationaleMd', 'url']
      AND (primary_action - 'kind' - 'label' - 'rationaleMd' - 'url') = '{}'::jsonb
      AND primary_action ->> 'kind' IN
            ('suggest_only', 'open_url', 'create_goal_draft', 'create_rule_draft')
      AND jsonb_typeof(primary_action -> 'label') = 'string'
      AND length(btrim(primary_action ->> 'label')) > 0
      AND jsonb_typeof(primary_action -> 'rationaleMd') = 'string'
      AND length(primary_action ->> 'rationaleMd') <= 1000
      AND (
            (primary_action ->> 'kind' = 'open_url'
              AND jsonb_typeof(primary_action -> 'url') = 'string'
              AND primary_action ->> 'url' ~ '^https://')
         OR (primary_action ->> 'kind' <> 'open_url'
              AND jsonb_typeof(primary_action -> 'url') = 'null')
      )
    )
  );

COMMENT ON COLUMN advisory_brief_items.primary_action IS
  'CF-24. The item''s first proposed action as `{kind, label, rationaleMd, url}`, snapshotted at publish time and never updated -- a Brief is a record of what was said. NULL: published before 0038 (the app reads "no action recorded"), never a live read of insight_actions.';

-- ---------------------------------------------------------------------------
-- snapshot_grant_events  (O-9)
-- ---------------------------------------------------------------------------
--
-- `snapshot_grants` holds the state of a consent: one row per (user, advisor,
-- scope), UPDATED on revoke and again on re-grant ("Re-granting a revoked scope
-- clears the revocation and re-stamps the grant date", `store.ts`). That is the
-- right shape for "what may this advisor read right now" and the wrong one for
-- "what did I consent to, and when did I change my mind": after a grant, a
-- revoke and a re-grant the table holds one row whose dates say only the last
-- thing that happened. The Phase 4 gate's O-9 asked for the history.
--
-- One row per change, appended in the same transaction as the change it
-- records:
--
--   * `granted`    -- the scope had never been granted to this advisor.
--   * `revoked`    -- a live grant was withdrawn.
--   * `re_granted` -- a revoked scope was granted again.
--
-- Nothing is recorded when a call changes nothing (granting a live grant;
-- revoking an already-revoked one).
--
-- Append-only, enforced where a bug in a caller cannot get past it: the UPDATE
-- trigger below refuses every update, so "never overwritten" is a property of
-- the table and not of the code that currently writes it. (DELETE is left to
-- `ON DELETE CASCADE` from `users` alone -- the one way a holder's rows leave.
-- A DELETE trigger would turn that into an error.)
--
-- `step_up_session_id` is the session whose fresh WebAuthn assertion authorised
-- the change (D21: a standing grant is credential-access-class consent, so the
-- route needs one). A plain UUID with no foreign key, on purpose: sessions
-- expire and are pruned, and a consent record must outlive the session it names
-- -- the reference answers "which sign-in did this", not "does that row exist".
-- NULL only for a change made outside a request (a test, a future migration of
-- data); the consent route always supplies it.
--
-- `scope` is a format check and not a copy of `snapshot_grants_scope_check`'s
-- list: that list is widened by a migration each time the advisor contract adds
-- a scope (0019, 0024, 0029), and a second copy here would be a second place to
-- forget. The history's job is to record what was changed, not to police the
-- vocabulary -- `snapshot_grants` already did, in the same transaction.

CREATE TABLE snapshot_grant_events (
  id                   UUID        PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  advisor_id           TEXT        NOT NULL
                                   CHECK (advisor_id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  scope                TEXT        NOT NULL
                                   CHECK (scope ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  event                TEXT        NOT NULL
                                   CHECK (event IN ('granted', 'revoked', 're_granted')),
  -- What the grant said about per-run consent at the time of the event.
  per_run_consent      BOOLEAN     NOT NULL,
  step_up_session_id   UUID,
  occurred_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The history read: one advisor's events for one holder, newest first.
CREATE INDEX snapshot_grant_events_advisor_idx
  ON snapshot_grant_events (user_id, advisor_id, occurred_at DESC, id DESC);

CREATE FUNCTION snapshot_grant_events_are_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'snapshot_grant_events % is a record of a consent change and may never be updated (O-9)',
    OLD.id
    USING ERRCODE = '23514',
          CONSTRAINT = 'snapshot_grant_events_are_append_only';
END;
$$;

CREATE TRIGGER snapshot_grant_events_are_append_only
  BEFORE UPDATE ON snapshot_grant_events
  FOR EACH ROW
  EXECUTE FUNCTION snapshot_grant_events_are_append_only();

COMMENT ON TABLE snapshot_grant_events IS
  'O-9. Append-only history of consent: one row per grant, revoke and re-grant of a scope to an advisor, written in the same transaction as the change to snapshot_grants. Never updated (trigger). Owner: @ctx/insights.';
COMMENT ON COLUMN snapshot_grant_events.step_up_session_id IS
  'The session whose fresh step-up assertion authorised the change (D21). No foreign key: the record outlives the session. NULL only for a change made outside a request.';
