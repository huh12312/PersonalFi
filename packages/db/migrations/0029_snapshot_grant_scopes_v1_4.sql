-- SPDX-License-Identifier: MIT
-- 0029_snapshot_grant_scopes_v1_4: `snapshot_grants.scope` accepts the two
--                                  scopes advisor contract 1.4.0 added
--                                  (WP 5.7; 08 §4.2, decision D22).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists
-- ---------------------------------------------------------------------------
--
-- WP 5.7 added `transactions.anomalies` and `fees.summary` to `ADVISOR_SCOPES`
-- — S1 and S5 need an exact amount and a per-category baseline
-- `transactions.raw`'s band could not give them, and the fee hunter needs a
-- by-type and by-account breakdown `transactions.summary` does not carry —
-- and bumped the advisor contract to 1.4.0 (strictly additive over 1.3.0, WP
-- 4.9's `plan.projection`). A scope the contract publishes and this CHECK
-- does not list is a scope no advisor can ever read: `grantScopes` would fail
-- with `23514`, which is exactly what 0019 was written to stop happening
-- again. `apps/api/test/phase3-registration.test.ts` parses the latest
-- `snapshot_grants_scope_check` out of these files and fails the build when
-- the two lists disagree, and WP 4.8's consent route refuses an unpublished
-- scope before the database does — this is the third layer, and the last.
--
-- **05-phase-5-dispatch.md §4's non-negotiable rule:** 0029 is the only Phase
-- 5 migration tied to a contract bump, and it ships in the same commit as
-- 1.4.0 — `apps/api/test/phase3-registration.test.ts` fails the build if the
-- two are split across commits.
--
-- References only 0012-era `insights`/`advisors` objects (`snapshot_grants`
-- itself, and the constraint 0019 named on it) — no new table, so this widens
-- a CHECK and nothing else; `packages/db/test/migrate.test.ts`'s per-migration
-- attribution block needs only that one line (WP 5.9 owns that file this
-- wave — recorded in the evidence for the orchestrator to add).
--
-- The numbering: 0029 was reserved for this widening at dispatch
-- (05-phase-5-dispatch.md §4), the highest migration at the time being 0028
-- (WP 5.1's advisor run control, Wave A). Migrations 0030–0033 belong to WP
-- 5.9, 5.3, 5.6 and 5.8 respectively and none of them touches
-- `snapshot_grants_scope_check`, so this remains the latest declaration
-- regardless of landing order — the same "no reference to a higher-numbered
-- object, and no two packages in one wave create objects the other
-- references" rule 0024's header states.
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
    'transactions.anomalies', 'fees.summary'));

COMMENT ON CONSTRAINT snapshot_grants_scope_check ON snapshot_grants IS
  'The published advisor scopes (contract 1.4.0). Widened by a new migration per contract minor that adds a scope; apps/api/test/phase3-registration.test.ts checks this list against ADVISOR_SCOPES.';
