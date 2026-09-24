-- SPDX-License-Identifier: MIT
-- 0018_connection_sync_facts: the durable handoff between a provider's
--                             investment/liability legs and the contexts that
--                             consume them (WP 3.7; 01 §5.5, 08 §2.5 and §3.4,
--                             decisions D3, D5, D25).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists at all
-- ---------------------------------------------------------------------------
--
-- The phase-3 dispatch records WP 3.7 as **"Migrations. None"**, and that was
-- right about the two things it was counting -- no new context, no new read
-- model. It missed two `CHECK` constraints, and neither can be worked around
-- from TypeScript:
--
--   1. `sync_runs.operation` (migration 0005) is CHECKed against
--      `('transactions', 'balances', 'holdings', 'liabilities')`. The dispatch
--      asks for **three** legs -- `holdings`, `investment_txns` and
--      `liabilities` -- each writing "its own `sync_runs` row with an
--      `operation:`". `investment_txns` is not in that list, so the leg cannot
--      write its row. Folding investment transactions into the `holdings`
--      operation would defeat the whole reason 0005 split the column: a
--      holdings failure would once again hide an investment-transaction
--      failure on the same connection, which is the sentence in 0005's own
--      comment ("Split out so a holdings failure does not hide a successful
--      transactions run").
--
--   2. `@ctx/investments`' lot consumer reads its facts through
--      `InvestmentSyncPort.factsForRun(userId, syncRunId)`
--      (`packages/contexts/investments/src/consumer.ts`), and the pump runs
--      that consumer in a **different transaction, in a different process**
--      from the sync that produced the facts. So the facts have to be durable
--      and addressable by `sync_run_id`. Nothing in the schema could hold
--      them: `connection_staged_facts.kind` (migration 0008) is CHECKed
--      against five transaction/account/balance kinds and carries no
--      `sync_run_id`, `quantity` or `price` column, and the alternatives --
--      `connections.config`, `sync_runs.error_detail`, an event payload -- are
--      each a JSONB column documented for something else, with no natural key
--      and no numeric type. 08 §3.4's "payloads are ids, counts and enums,
--      never rows" is the reason the event itself cannot carry them.
--
-- `0018` was reserved for WP 3.9 with the words "used only if reported
-- necessary". It is reported necessary here, and WP 3.9's dispatch entry says
-- "Migrations. None" unconditionally, so the reservation is spent on the work
-- package that turned out to need it.
--
-- ---------------------------------------------------------------------------
-- One table, and why it is not a log
-- ---------------------------------------------------------------------------
--
--   connection_sync_facts   @ctx/connections -- one row per provider fact
--
-- `connection_staged_facts` (0008) is its sibling and the two are easy to
-- confuse, so the distinction is stated once here and once in the Drizzle
-- file: **staged** facts are *inbound and not yet applied* -- what a
-- process-local connector (Manual, CSV/OFX/QIF) accumulated during `connect()`
-- and has not flushed through `syncTransactions` yet. **Sync** facts are the
-- opposite end: what a *remote* provider leg already observed and recorded, so
-- that a consumer in another context and another process can read it. One is a
-- pending inbox, the other is a published outbox.
--
-- The row is keyed on the **provider's own natural key**, not on the run, and
-- `sync_run_id` is "the run that last observed this fact" rather than "the run
-- that created this row". That is a deliberate choice with a cost and a
-- benefit, and both are worth writing down:
--
--   * The benefit is that the table's size is the size of the portfolio and
--     not the size of the sync history. 01 §5.5 records that there is no
--     `/investments/transactions/sync`, so every nightly run re-fetches the
--     whole 24-month window; a per-run log would write ~500 rows a night
--     forever to restate the same 500 facts. Keyed on
--     `provider_transaction_id`, the second sync of the same window writes
--     zero new rows -- which is also the exact shape of the exit test "two
--     syncs of the same window add no investment transactions", one layer
--     lower down.
--
--   * The cost is that `factsForRun` for an **older** run returns nothing once
--     a newer run has re-observed the same facts. That is the honest answer
--     ("this run's observations have been superseded") and the consumer's
--     contract survives it: `runLotSync` over no facts touches no holding,
--     opens no lot and appends no event. The durable record of an investment
--     transaction is `@ctx/investments`' own `investment_transactions` table,
--     which is upserted on `(user_id, account_id, provider,
--     provider_transaction_id)` and is what a replay rebuilds lots from.
--
-- ---------------------------------------------------------------------------
-- Money, quantity and rate types
-- ---------------------------------------------------------------------------
--
-- D3 is irreversible: no `number` crosses a quantity or a price boundary.
-- `quantity` is `NUMERIC(38,18)` (the kernel's `Quantity`), `price` is
-- `NUMERIC(20,10)` (the kernel's rate column, matching `prices`' sub-cent
-- precision), `apr` is `NUMERIC(9,6)` -- a percentage, exact, and deliberately
-- not money -- and every money value is a `BIGINT` minor-unit column paired
-- with its own `CHAR(3)` currency. There is no `DOUBLE PRECISION` or `REAL`
-- column in this table and `packages/db/test/migrate.test.ts`'s float ban is
-- what keeps it that way.
--
-- The money columns are named for what they hold rather than reused across
-- kinds. A single `amount_minor` meaning "value" for a holding, "amount" for a
-- transaction and "statement balance" for a liability would be three columns'
-- worth of meaning in one, and the first reader to write a `SUM()` over it
-- would be wrong in a way no constraint could catch. 0008 already sets this
-- precedent with its `available_minor`/`limit_minor` pair.
--
-- `fact` JSONB carries everything that is neither money nor a number a
-- valuation depends on: the `SecurityIdentifier` the adapter resolved
-- (`kind`/`value`/`chain`/`mic`), the provider's free-text name/type/subtype,
-- and the verbatim `raw` payload -- so a Phase 4 question has a Phase 3
-- answer. `provider_security_id` sits in its own column rather than inside
-- `fact` because it is half of the holding natural key; it is carried as
-- **evidence and never as identity** (D25), and the security a fact resolves
-- to is decided by `@ctx/investments`' `SecurityResolver` at read time, never
-- here.

-- ---------------------------------------------------------------------------
-- 1. The fourth sync operation
-- ---------------------------------------------------------------------------

ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_operation_check;

ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_operation_check
  CHECK (operation IN ('transactions', 'balances', 'holdings', 'investment_txns', 'liabilities'));

COMMENT ON COLUMN sync_runs.operation IS
  'Which dataset this run fetched. One row per leg per sync, so a holdings failure cannot relabel or hide the transactions delta that already committed.';

-- ---------------------------------------------------------------------------
-- 2. The facts themselves
-- ---------------------------------------------------------------------------

CREATE TABLE connection_sync_facts (
  -- Total order, same role as `connection_staged_facts.seq`: a stable read
  -- order that does not depend on a timestamp two rows can share.
  seq                        BIGSERIAL   PRIMARY KEY,
  -- App-generated (UUIDv7), so a caller can name the row it just wrote.
  id                         UUID        NOT NULL UNIQUE,
  user_id                    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id              UUID        NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  -- The run that **last observed** this fact. See the header: this is a
  -- pointer, not a provenance chain, and it moves on every re-observation.
  sync_run_id                UUID        NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  kind                       TEXT        NOT NULL
                                         CHECK (kind IN ('holding', 'investment_transaction', 'liability')),
  provider_account_id        TEXT        NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
  -- `holding` always; `investment_transaction` when the trade names a security
  -- (a cash sweep, a fee and a deposit are real investment transactions with
  -- no security behind them). NULL for `liability`.
  provider_security_id       TEXT,
  -- `investment_transaction` only: Plaid's `investment_transaction_id`, and
  -- the idempotency key 01 §5.5 names. NULL for the other two kinds.
  provider_transaction_id    TEXT,
  -- `investment_transaction` only, and mandatory there, as it is on every
  -- other fact in the port (08 §2.5). It is what survives a provider rotating
  -- its ids.
  fingerprint                TEXT,

  -- Numbers a valuation depends on. Decimal, never float (D3).
  quantity                   NUMERIC(38,18),
  price                      NUMERIC(20,10),
  -- A percentage as an exact decimal. Not money: 4.25% is not $4.25.
  apr                        NUMERIC(9,6),

  -- `holding`: what the institution says the position is worth. Kept for
  -- **reconciliation only** -- valuation comes from our own `PriceSource`, so
  -- two accounts at two brokerages are comparable (WP 3.7 scope).
  value_minor                BIGINT,
  value_currency             CHAR(3),
  -- `holding`: 01 §5.5 -- fill rates vary wildly and the figure is often
  -- *total* rather than per-share. Carried as reported and treated as the
  -- fallback; WP 3.2 derives basis from transactions wherever it can.
  cost_basis_minor           BIGINT,
  cost_basis_currency        CHAR(3),

  -- `investment_transaction`: house sign convention, negative = money left.
  amount_minor               BIGINT,
  amount_currency            CHAR(3),
  fees_minor                 BIGINT,
  fees_currency              CHAR(3),
  transaction_date           DATE,

  -- `liability`: the APR / statement-balance / minimum-payment /
  -- next-payment-due block WP 2.7's CATALOGUE_GAPS called the highest-value
  -- addition a later phase could make, and which WP 3.10's `liabilities.terms`
  -- scope reads through a composition-root port.
  statement_balance_minor    BIGINT,
  statement_balance_currency CHAR(3),
  minimum_payment_minor      BIGINT,
  minimum_payment_currency   CHAR(3),
  next_payment_due           DATE,

  -- `holding`: when the institution priced it.
  as_of                      TIMESTAMPTZ,

  -- Everything that is neither money nor a number: the SecurityIdentifier, the
  -- provider's names, the verbatim payload.
  fact                       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A holding is a position: it has a security, a quantity and a value, or it
  -- is not a holding. A NULL quantity with a non-NULL value is how a position
  -- silently becomes a number nobody can check.
  CONSTRAINT connection_sync_facts_holding_is_a_position CHECK (
    kind <> 'holding'
    OR (provider_security_id IS NOT NULL
        AND quantity IS NOT NULL
        AND value_minor IS NOT NULL AND value_currency IS NOT NULL
        AND as_of IS NOT NULL)
  ),
  -- Cost basis is optional (that is the whole point of it being a fallback),
  -- but a minor amount with no currency is not a Money and never was.
  CONSTRAINT connection_sync_facts_cost_basis_is_money CHECK (
    (cost_basis_minor IS NULL) = (cost_basis_currency IS NULL)
  ),
  CONSTRAINT connection_sync_facts_fees_are_money CHECK (
    (fees_minor IS NULL) = (fees_currency IS NULL)
  ),
  CONSTRAINT connection_sync_facts_statement_balance_is_money CHECK (
    (statement_balance_minor IS NULL) = (statement_balance_currency IS NULL)
  ),
  CONSTRAINT connection_sync_facts_minimum_payment_is_money CHECK (
    (minimum_payment_minor IS NULL) = (minimum_payment_currency IS NULL)
  ),
  -- An investment transaction without its idempotency key cannot be
  -- de-duplicated, and a re-fetched 24-month window would then double every
  -- lot. 01 §5.5 makes the upsert the only protection there is, so the key is
  -- structural.
  CONSTRAINT connection_sync_facts_investment_transaction_is_identified CHECK (
    kind <> 'investment_transaction'
    OR (provider_transaction_id IS NOT NULL
        AND fingerprint IS NOT NULL
        AND quantity IS NOT NULL
        AND price IS NOT NULL
        AND amount_minor IS NOT NULL AND amount_currency IS NOT NULL
        AND transaction_date IS NOT NULL)
  ),
  -- Every liability column is legitimately NULL -- a card whose APR Plaid did
  -- not report is a real card -- so the only claim left to make structural is
  -- that the *other* kinds' columns stay out of it.
  CONSTRAINT connection_sync_facts_liability_carries_no_position CHECK (
    kind <> 'liability'
    OR (quantity IS NULL AND price IS NULL
        AND value_minor IS NULL AND cost_basis_minor IS NULL
        AND amount_minor IS NULL AND provider_transaction_id IS NULL)
  )
);

-- One position per (connection, account, security). A brokerage that reports
-- the same security twice for one account is restating it, not adding to it.
CREATE UNIQUE INDEX connection_sync_facts_holding_idx
  ON connection_sync_facts (connection_id, provider_account_id, provider_security_id)
  WHERE kind = 'holding';

-- 01 §5.5's idempotency key, as an index. This is the row-level half of the
-- exit test "two syncs of the same window add no investment transactions".
CREATE UNIQUE INDEX connection_sync_facts_investment_transaction_idx
  ON connection_sync_facts (connection_id, provider_transaction_id)
  WHERE kind = 'investment_transaction';

-- One terms block per (connection, account).
CREATE UNIQUE INDEX connection_sync_facts_liability_idx
  ON connection_sync_facts (connection_id, provider_account_id)
  WHERE kind = 'liability';

-- `factsForRun(userId, syncRunId)`: the consumer's whole query.
CREATE INDEX connection_sync_facts_run_idx
  ON connection_sync_facts (sync_run_id, kind);

CREATE INDEX connection_sync_facts_user_idx ON connection_sync_facts (user_id);

COMMENT ON TABLE connection_sync_facts IS
  'What a provider''s holdings / investment-transaction / liability leg observed, keyed on the provider''s natural key and pointing at the run that last saw it. Owner: @ctx/connections.';
COMMENT ON COLUMN connection_sync_facts.sync_run_id IS
  'The run that last observed this fact, not the run that created the row. factsForRun(userId, syncRunId) reads it.';
COMMENT ON COLUMN connection_sync_facts.value_minor IS
  'The institution''s own valuation. Reconciliation only -- our valuation comes from the PriceSource, so accounts are comparable.';
COMMENT ON COLUMN connection_sync_facts.cost_basis_minor IS
  'As reported, and a fallback: 01 5.5 records that fill rates vary and the figure is often total rather than per-share.';
COMMENT ON COLUMN connection_sync_facts.provider_security_id IS
  'The provider''s opaque security id. Evidence, never identity (D25) -- the SecurityResolver decides what this is.';
