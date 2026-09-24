-- SPDX-License-Identifier: MIT
-- 0019_snapshot_grant_scopes_v1_1: `snapshot_grants.scope` accepts the two
--                                  scopes advisor contract 1.1.0 added
--                                  (WP 3.10/3.10a; 08 §4.2, decision D22).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists at all
-- ---------------------------------------------------------------------------
--
-- 0012 declared the scope column with an inline CHECK listing the thirteen
-- scopes advisor contract 1.0.0 published. WP 3.10 bumped the contract to
-- 1.1.0 — a strictly additive minor that added `liabilities.terms` and
-- `market.rates` — and WP 3.10a, writing the first real grant for one of them,
-- hit `23514 snapshot_grants_scope_check`. Every unit test had passed because
-- the enum lives in `@ctx/insights`' `ADVISOR_SCOPES` and the database's copy
-- of it lives here; nothing tied the two together until
-- `apps/api/test/phase3-registration.test.ts` started parsing this CHECK out
-- of the migration files and comparing it to the published enum.
--
-- The list stays explicit rather than becoming a lookup table: a grant is a
-- user's standing consent to a *named* minimisation rule (08 §4.2), and a
-- scope that is not in the published contract must not be grantable at all.
-- Each contract minor that adds scopes ships one of these; the parity test
-- makes forgetting it a build failure rather than a runtime 23514.
--
-- Postgres names an inline column CHECK `<table>_<column>_check`, which is the
-- name the 23514 reported; it is dropped by that name and replaced by an
-- explicitly named constraint so the next widening drops a known name.

ALTER TABLE snapshot_grants
  DROP CONSTRAINT snapshot_grants_scope_check;

ALTER TABLE snapshot_grants
  ADD CONSTRAINT snapshot_grants_scope_check CHECK (scope IN (
    'networth.summary', 'cash.summary', 'cashflow.monthly',
    'budgets.status', 'recurring.list', 'goals.list',
    'risk.profile', 'market.watchlist', 'holdings.aggregate',
    'holdings.detail', 'transactions.summary',
    'transactions.raw', 'institutions.names',
    -- advisor contract 1.1.0 (WP 3.10)
    'liabilities.terms', 'market.rates'));

COMMENT ON CONSTRAINT snapshot_grants_scope_check ON snapshot_grants IS
  'The published advisor scopes (contract 1.1.0). Widened by a new migration per contract minor; apps/api/test/phase3-registration.test.ts checks this list against ADVISOR_SCOPES.';
