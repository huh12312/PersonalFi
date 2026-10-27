-- SPDX-License-Identifier: MIT
-- 0054_snapshot_grant_scopes_v1_7: `snapshot_grants.scope` accepts the scope
--                                  advisor contract 1.7.0 added
--                                  (WP 11.1; 11 §3.1, 08 §4.2).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists
-- ---------------------------------------------------------------------------
--
-- WP 11.1 added `categorization.rule_candidates` to `ADVISOR_SCOPES` — the
-- (merchant, category) pairs the holder keeps confirming by hand, which
-- `builtin.spending.rule_suggestion` turns into "make this a rule?" — and
-- bumped the advisor contract to 1.7.0 (strictly additive over 1.6.0, WP
-- 9.5's narration figure slots, which added no scope). A scope the contract
-- publishes and this CHECK does not list is a scope no advisor can ever read:
-- `grantScopes` would fail with `23514`, the failure 0019 was written to stop.
-- `apps/api/test/phase3-registration.test.ts` parses the latest
-- `snapshot_grants_scope_check` out of these files and fails the build when
-- the two lists disagree; this ships in the same change as 1.7.0 for exactly
-- that reason (05-phase-5-dispatch.md §4's pairing rule, as 0029 followed it).
--
-- Expand-only. References only 0012-era `insights` objects (`snapshot_grants`
-- itself, and the constraint 0019 named on it) — no new table, no new
-- column, so this widens a CHECK and nothing else, and every row the old
-- CHECK admitted the new one admits too. 1.5.0 and 1.6.0 were envelope
-- changes with no scope and needed no widening, so the list below is 0029's
-- plus one member.
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
    'plan.projection',
    -- advisor contract 1.4.0 (WP 5.7)
    'transactions.anomalies', 'fees.summary',
    -- advisor contract 1.7.0 (WP 11.1)
    'categorization.rule_candidates'));

COMMENT ON CONSTRAINT snapshot_grants_scope_check ON snapshot_grants IS
  'The published advisor scopes (contract 1.7.0). Widened by a new migration per contract minor that adds a scope; apps/api/test/phase3-registration.test.ts checks this list against ADVISOR_SCOPES.';
