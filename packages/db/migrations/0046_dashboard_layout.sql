-- SPDX-License-Identifier: MIT
-- 0046_dashboard_layout: the order and visibility of the dashboard's widgets,
--                        per holder (WP 10.9; docs/research/10-visual-design-notes-
--                        visual-analysis.md §3 V2, Monarch's
--                        Customize screen).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one nullable column with a named CHECK. Nothing is dropped,
-- renamed or narrowed, no row is touched, and every row valid before this
-- migration is valid after it (each one's layout is NULL). References only
-- `users`, which is 0001/0002's and @ctx/identity's.
--
-- ---------------------------------------------------------------------------
-- The field
-- ---------------------------------------------------------------------------
--
--   dashboard_layout  a JSON array, in display order, of
--                     {"id": "<widget id>", "visible": true|false}.
--                     NULL = the product's default order, everything shown.
--
-- Why on `users`: it is the one per-holder preferences row this schema has
-- (it already carries display_timezone); narrator_settings is the narrator's
-- own and no other settings table exists. Like display_timezone it is not in
-- the export (registry.ts exempts `users`: the bundle is scoped to an
-- already-known holder) -- recorded in docs/evidence/phase-10/
-- wp10.9-dashboard-widgets.md.
--
-- The CHECK holds the shape the database can see cheaply (an array, at most 32
-- entries); the widget ids and the uniqueness of each are the route's
-- (apps/api/src/routes/dashboard.ts, a zod enum), because the list of widgets
-- grows with the product and a CHECK naming them would need a migration per
-- widget. A stored id the product no longer knows is dropped on read, and a
-- widget the stored array does not name is appended, shown.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE users
  ADD COLUMN dashboard_layout JSONB
    CONSTRAINT users_dashboard_layout_is_array
      CHECK (
        dashboard_layout IS NULL
        OR (jsonb_typeof(dashboard_layout) = 'array'
            AND jsonb_array_length(dashboard_layout) <= 32)
      );

COMMENT ON COLUMN users.dashboard_layout IS
  'The dashboard''s widget order and visibility (WP 10.9): a JSON array of {"id", "visible"} in display order. NULL = the default layout. Not exported (users is exempt).';
