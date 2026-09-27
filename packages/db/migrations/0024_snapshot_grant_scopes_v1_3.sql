-- SPDX-License-Identifier: MIT
-- 0024_snapshot_grant_scopes_v1_3: `snapshot_grants.scope` accepts the one
--                                  scope advisor contract 1.3.0 added
--                                  (WP 4.9; 08 §4.2, decision D22).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists
-- ---------------------------------------------------------------------------
--
-- WP 4.9 added `plan.projection` to `ADVISOR_SCOPES` — the retirement rules R2
-- and R7 need a success probability and a guardrail position, and neither
-- `goals.list` nor `risk.profile` yields one — and bumped the advisor contract
-- to 1.3.0 (strictly additive; 1.2.0 was WP 4.12b's `excluded_currencies`,
-- which added no scope and so needed no migration). A scope the contract
-- publishes and this CHECK does not list is a scope no advisor can ever read:
-- `grantScopes` would fail with `23514`, which is exactly what 0019 was
-- written to stop happening again. `apps/api/test/phase3-registration.test.ts`
-- parses the latest `snapshot_grants_scope_check` out of these files and fails
-- the build when the two lists disagree, and WP 4.8's consent route refuses an
-- unpublished scope before the database does — this is the third layer, and
-- the last.
--
-- `goals.list` and `risk.profile` were already in 0012's list and 0019's, so
-- their WP 4.9 readers needed nothing here.
--
-- The numbering: 0024 was reserved for this widening at dispatch
-- (04-phase-4-dispatch.md §4), and 0025/0026 landed first. The runner applies
-- any version it has not recorded, in lexical order, so an existing database
-- that already holds 0025 and 0026 applies this one next; nothing in it
-- depends on either.
--
-- 0019 replaced the inline column CHECK with this explicitly named
-- constraint, so the drop below names a constraint that is known to exist.

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
    'liabilities.terms', 'market.rates',
    -- advisor contract 1.3.0 (WP 4.9)
    'plan.projection'));

COMMENT ON CONSTRAINT snapshot_grants_scope_check ON snapshot_grants IS
  'The published advisor scopes (contract 1.3.0). Widened by a new migration per contract minor that adds a scope; apps/api/test/phase3-registration.test.ts checks this list against ADVISOR_SCOPES.';
