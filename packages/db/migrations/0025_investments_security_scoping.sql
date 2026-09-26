-- SPDX-License-Identifier: MIT
-- 0025_investments_security_scoping: two Phase 3 gate conditions that share
--                                     this wave's one free migration slot
--                                     (docs/plan/04-phase-4-dispatch.md §3
--                                     "WP 4.12"; 0022-0024 are reserved for
--                                     other Phase 4 work packages).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Part 1 — C-14 (§4.1(d) of the Phase 3 gate): a holding's security
-- structurally cannot belong to another user
-- ---------------------------------------------------------------------------
--
-- `holdings.security_id`, `cost_basis_lots.security_id`,
-- `investment_transactions.security_id` and `prices.security_id` were each a
-- bare `REFERENCES securities (id)` — proof only that the row exists
-- *somewhere*, not that it belongs to the same user as the row naming it.
-- `apps/api/test/db/investments-routes.test.ts`'s
-- `'a holding whose security belongs to another user is visible to neither'`
-- planted exactly that shape by raw SQL and found the read-path predicates
-- (`readHoldings`'s `WHERE h.user_id` and `JOIN securities ... AND s.user_id`)
-- independently sufficient — proof the *query* is safe, not that the *data*
-- is impossible. A composite foreign key makes it impossible: Postgres
-- itself now refuses the INSERT/UPDATE this migration's own test used to
-- perform successfully.
--
-- `securities` needs a UNIQUE (user_id, id) target first — Postgres requires
-- the referenced columns of a composite FK to be covered by a unique
-- constraint, and `id` alone (already the PRIMARY KEY) does not cover the pair.

ALTER TABLE securities
  ADD CONSTRAINT securities_user_id_id_uniq UNIQUE (user_id, id);

ALTER TABLE holdings
  ADD CONSTRAINT holdings_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

ALTER TABLE cost_basis_lots
  ADD CONSTRAINT cost_basis_lots_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

-- `investment_transactions.security_id` is nullable (a cash sweep, a fee and
-- a deposit are real investment transactions with no security behind them —
-- 0014's own header). Postgres's default MATCH SIMPLE means a composite FK
-- is satisfied whenever *any* referencing column is NULL, so a security-less
-- transaction is untouched by this constraint. `ON DELETE SET NULL
-- (security_id)` — the column-scoped form (Postgres 15+) — nulls only
-- `security_id`, matching the single-column FK already on this column
-- exactly; nulling `user_id` too (the unscoped form's behaviour) would
-- violate its own NOT NULL constraint the moment a security cascade-deletes
-- ahead of that transaction row's own `user_id`-CASCADE deletion.
ALTER TABLE investment_transactions
  ADD CONSTRAINT investment_transactions_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id)
    ON DELETE SET NULL (security_id);

ALTER TABLE prices
  ADD CONSTRAINT prices_security_belongs_to_user
    FOREIGN KEY (user_id, security_id) REFERENCES securities (user_id, id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT holdings_security_belongs_to_user ON holdings IS
  'A holding''s security must belong to the same user (Phase 3 gate C-14, §4.1(d)): cross-user reference is now structurally impossible, not merely predicate-deep.';
COMMENT ON CONSTRAINT cost_basis_lots_security_belongs_to_user ON cost_basis_lots IS
  'Same rule as holdings_security_belongs_to_user (Phase 3 gate C-14).';
COMMENT ON CONSTRAINT investment_transactions_security_belongs_to_user ON investment_transactions IS
  'Same rule as holdings_security_belongs_to_user (Phase 3 gate C-14); NULL security_id (a cash sweep) is untouched by MATCH SIMPLE.';
COMMENT ON CONSTRAINT prices_security_belongs_to_user ON prices IS
  'Same rule as holdings_security_belongs_to_user (Phase 3 gate C-14).';

-- ---------------------------------------------------------------------------
-- Part 2 — C-2 (G3-14, HIGH): a watch-only wallet's holding may report a
-- quantity with no institution-asserted value
-- ---------------------------------------------------------------------------
--
-- `@connector/walletrpc` had no price source and, through the Phase 3 gate,
-- refused a non-zero balance's `syncHoldings` outright rather than ever write
-- a row with no institution value — which is why a funded watch-only wallet
-- could never become a holding at all. `ProviderHoldingFact.value` is now
-- `Money | null` (`@connector/port`), and `institution_value_minor` must
-- follow: it is the institution's own assertion (see the column's comment in
-- `0014_lots.sql`), never a computation, and a wallet's provider makes no
-- such assertion. `currency` stays NOT NULL — `@ctx/investments`'
-- `DEFAULT_HOLDING_CURRENCY` is written in its place, and nothing reads it
-- for market value: `valueHoldings` prices every holding from the price
-- ladder (`prices`, keyed on `security_id`), never from this column.

ALTER TABLE holdings
  ALTER COLUMN institution_value_minor DROP NOT NULL;

ALTER TABLE holdings_snapshots
  ALTER COLUMN institution_value_minor DROP NOT NULL;

COMMENT ON COLUMN holdings.institution_value_minor IS
  'What the institution says the position is worth. An assertion, timestamped by as_of_date, never a number we computed. NULL means the provider made no such assertion (Phase 3 gate C-2) — never a fabricated zero.';
COMMENT ON COLUMN holdings_snapshots.institution_value_minor IS
  'Same rule as holdings.institution_value_minor (Phase 3 gate C-2).';

-- ---------------------------------------------------------------------------
-- Part 3 — C-2, continued: the staging table a holding fact lands in
-- *before* resolution must accept the same NULL value
-- ---------------------------------------------------------------------------
--
-- `@ctx/connections`' `connection_sync_facts` (migration 0018) is where every
-- adapter's raw `ProviderHoldingFact` is persisted first, and its own
-- `connection_sync_facts_holding_is_a_position` CHECK required
-- `value_minor IS NOT NULL AND value_currency IS NOT NULL` for `kind =
-- 'holding'` — written before any adapter could report a holding with no
-- fiat value at all. Left unchanged, this CHECK would refuse the wallet's
-- own holding fact at the staging step, before `@ctx/investments`' resolver
-- or `holdings` table (Parts 1-2 above) ever saw it. The other four
-- properties a "position" still requires (`provider_security_id`,
-- `quantity`, `as_of`) are unchanged — only the value pair is now optional,
-- and `(value_minor IS NULL) = (value_currency IS NULL)` keeps the same
-- "a minor amount with no currency is not a Money" rule this table's other
-- CHECKs already state for cost basis, fees and the rest.

ALTER TABLE connection_sync_facts
  DROP CONSTRAINT connection_sync_facts_holding_is_a_position;

ALTER TABLE connection_sync_facts
  ADD CONSTRAINT connection_sync_facts_holding_is_a_position CHECK (
    kind <> 'holding'
    OR (provider_security_id IS NOT NULL
        AND quantity IS NOT NULL
        AND (value_minor IS NULL) = (value_currency IS NULL)
        AND as_of IS NOT NULL)
  );

COMMENT ON CONSTRAINT connection_sync_facts_holding_is_a_position ON connection_sync_facts IS
  'A holding is a position: it has a security, a quantity and an as_of, or it is not a holding. value_minor/value_currency may both be NULL (Phase 3 gate C-2) — a provider with no fiat value of its own, never a minor amount with no currency.';
