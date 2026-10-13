-- SPDX-License-Identifier: MIT
-- 0042_account_overrides_management: who manages an investment account --
--                                    an advisor, a robo-advisor, or the
--                                    holder themselves -- as one more field
--                                    of the holder's overlay (WP 10.3;
--                                    docs/evidence/phase-10/
--                                    wp10.3-investment-activity-performance.md).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- Expand-only: one nullable column with a CHECK, and the row-not-empty CHECK
-- re-declared **wider** (it now also accepts a row whose only field is
-- `management`). Nothing is dropped from the data, no column is renamed or
-- narrowed, and every row valid before this migration is valid after it --
-- the same widening shape 0029 used for `snapshot_grants_scope_check`
-- (Postgres has no ALTER for a CHECK expression, so a widening is a DROP and
-- an ADD of the same name, in this one transaction). References only
-- `account_overrides`, which is 0035's.
--
-- ---------------------------------------------------------------------------
-- The field
-- ---------------------------------------------------------------------------
--
--   management  advisor | robo_advisor | self_directed. NULL = unclassified:
--               the holder has not said, and nothing infers it -- a provider
--               knows the institution, not who chooses the trades.
--
-- It is the holder's claim about their own account, like `role`, and it
-- moves no projection: `@ctx/planning`'s staleness reads tax_treatment, role
-- and valuation only, and `overrideFingerprint` digests those three, so a
-- stored projection does not read stale when only `management` changes. What
-- reads it is `GET /investments/performance?management=` and
-- `GET /investments/performance/by-management`, which group accounts by it.
--
-- The value list is a CHECK and is asserted equal to the TypeScript constant
-- `MANAGEMENT_STYLES` (`packages/contexts/ledger/schema/account-overrides.ts`)
-- by `packages/contexts/ledger/test/db/account-overrides.test.ts`, as 0035's
-- three lists are.
--
-- No function is created here, so nothing needs schema qualification under
-- pg_restore's empty search_path (0040).

ALTER TABLE account_overrides
  ADD COLUMN management TEXT
    CONSTRAINT account_overrides_management_check
    CHECK (management IN ('advisor', 'robo_advisor', 'self_directed'));

ALTER TABLE account_overrides
  DROP CONSTRAINT account_overrides_not_empty;

ALTER TABLE account_overrides
  ADD CONSTRAINT account_overrides_not_empty
    CHECK (tax_treatment IS NOT NULL OR role IS NOT NULL OR valuation IS NOT NULL
           OR management IS NOT NULL);

COMMENT ON COLUMN account_overrides.management IS
  'Who manages the account: advisor | robo_advisor | self_directed. NULL = unclassified (the holder has not said; never inferred). Groups GET /investments/performance/by-management. Moves no projection. WP 10.3.';
