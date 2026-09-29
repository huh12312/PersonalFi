-- SPDX-License-Identifier: MIT
-- 0034_securities_composite_fks: G4-23 (Phase 4 security gate,
--                                 docs/evidence/phase-4/gate-security-review.md
--                                 §4.1(g) — "the five bare `REFERENCES
--                                 securities (id)` made composite" — and §6
--                                 row C-14's G4-23 clause). Carried by
--                                 docs/plan/05-phase-5-dispatch.md WP 5.13.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- The five that stayed bare
-- ---------------------------------------------------------------------------
--
-- `0025_investments_security_scoping.sql` made four references composite
-- (`holdings`, `cost_basis_lots`, `investment_transactions`, `prices`) and
-- `0026_allocation_targets.sql` a fifth (`security_tags`) — both against the
-- `securities_user_id_id_uniq UNIQUE (user_id, id)` constraint 0025 added.
-- Five more `REFERENCES securities (id)` from migrations 0013/0014 were never
-- touched by either — a bare single-column FK proves the row exists
-- *somewhere*, never that it belongs to the same user as the row naming it,
-- exactly the gap 0025's header describes:
--
--   * `security_identifiers.security_id` (0013) — an identifier's own
--     security must be the same user's, or a probe with another user's
--     `security_id` and a fabricated FIGI could attach itself to a security
--     it does not own.
--   * `security_overlay.security_id` (0013) — a user-authored classification
--     override (07 §4.3 rung 1, "always wins, never re-derived") must target
--     the same user's security, or one holder's override could silently
--     apply to another's row.
--   * `holdings_snapshots.security_id` (0014) — the daily allocation record;
--     same shape as `holdings` itself, which 0025 already closed.
--   * `basis_method_elections.security_id` (0014) — a lot-selection election
--     (FIFO/LIFO/HIFO/...) naming another user's security would be inert (no
--     lot of theirs could ever match), but "inert" is not "impossible", and
--     `docs/CONVENTIONS.md`'s composite-FK convention (0020's rule, restated
--     by 0025) does not carve out an exception for "probably harmless".
--   * `securities.merged_into_id` (0013) — self-referencing: the resolver's
--     merge ("two rows turn out to be one asset") must target another row of
--     the *same* user's securities, never merge one holder's security into
--     another's.
--
-- Every one of the five NOT NULL columns above (all but `merged_into_id`,
-- which is nullable by design — most securities are never merged) is
-- `ON DELETE CASCADE` in its own table already; the composite version keeps
-- that behaviour unchanged and only narrows *which* row may be referenced.
-- `merged_into_id` carried no `ON DELETE` clause in 0013 (default `NO
-- ACTION`) and keeps that too — a security not user-scoped enough to be
-- merge-deletable is not this migration's concern.
--
-- Same convention as 0025: a plain `ALTER TABLE ... ADD CONSTRAINT`, no
-- `NOT VALID`. Postgres validates every existing row against the new
-- constraint as it adds it, so a pre-existing cross-user reference (none is
-- known to exist — nothing before this migration could write one through any
-- route this codebase exposes) would fail the migration loudly rather than
-- ship unenforced. Every table below was created at or before 0014 and the
-- unique target (`securities_user_id_id_uniq`) at 0025, so this migration
-- references nothing that postdates it — 05 §3's rule ("no Phase 5 migration
-- references an object a higher-numbered one creates").

ALTER TABLE security_identifiers
  ADD CONSTRAINT security_identifiers_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

ALTER TABLE security_overlay
  ADD CONSTRAINT security_overlay_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

ALTER TABLE holdings_snapshots
  ADD CONSTRAINT holdings_snapshots_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

ALTER TABLE basis_method_elections
  ADD CONSTRAINT basis_method_elections_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

-- Self-referencing: the merge target must be the same user's security. No
-- `ON DELETE` clause, matching 0013's original single-column FK exactly.
ALTER TABLE securities
  ADD CONSTRAINT securities_merge_target_belongs_to_user
    FOREIGN KEY (user_id, merged_into_id) REFERENCES securities (user_id, id);

COMMENT ON CONSTRAINT security_identifiers_security_belongs_to_user ON security_identifiers IS
  'An identifier''s security must belong to the same user (Phase 4 gate G4-23): cross-user reference is now structurally impossible, not merely predicate-deep.';
COMMENT ON CONSTRAINT security_overlay_security_belongs_to_user ON security_overlay IS
  'Same rule as security_identifiers_security_belongs_to_user (Phase 4 gate G4-23).';
COMMENT ON CONSTRAINT holdings_snapshots_security_belongs_to_user ON holdings_snapshots IS
  'Same rule as security_identifiers_security_belongs_to_user (Phase 4 gate G4-23).';
COMMENT ON CONSTRAINT basis_method_elections_security_belongs_to_user ON basis_method_elections IS
  'Same rule as security_identifiers_security_belongs_to_user (Phase 4 gate G4-23).';
COMMENT ON CONSTRAINT securities_merge_target_belongs_to_user ON securities IS
  'A security may only be merged into another security of the same user (Phase 4 gate G4-23).';
