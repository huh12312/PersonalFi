-- SPDX-License-Identifier: MIT
-- 0056_snapshot_grant_scopes_v1_8: `snapshot_grants.scope` accepts the scope
--                                  advisor contract 1.8.0 added
--                                  (WP 11.2; 11 §3.1, §4, 08 §4.2).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- WP 11.2 added `transactions.residue` to `ADVISOR_SCOPES`: per uncategorised
-- row the classifier's own features (normalised payee tokens, MCC family, PFC
-- primary, amount bucket, account kind, direction, day bucket) -- never the
-- memo, an account id or the raw descriptor -- which `categorize.suggest`
-- sends to the local model. A scope the contract publishes and this CHECK does
-- not list is a scope no grant can hold (`23514`, the failure 0019 was written
-- to stop); `apps/api/test/phase3-registration.test.ts` parses the latest
-- CHECK across these files and fails when the two lists disagree. Same shape
-- as 0054: expand-only, a widened CHECK and nothing else; every row the old
-- CHECK admitted the new one admits too.

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
    'categorization.rule_candidates',
    -- advisor contract 1.8.0 (WP 11.2)
    'transactions.residue'));

COMMENT ON CONSTRAINT snapshot_grants_scope_check ON snapshot_grants IS
  'The published advisor scopes (contract 1.8.0). Widened by a new migration per contract minor that adds a scope; apps/api/test/phase3-registration.test.ts checks this list against ADVISOR_SCOPES.';
