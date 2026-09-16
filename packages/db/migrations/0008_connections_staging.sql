-- SPDX-License-Identifier: MIT
-- 0008_connections_staging: durable staging for the process-local connectors
--                            (decision D-5, gate-security-review.md §8.11).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- The gap this closes
-- ---------------------------------------------------------------------------
--
-- `ManualConnector` and `CsvImportConnector` (packages/connectors/{manual,csv})
-- never write to the database -- that is the whole point of the `Connector`
-- port. Until this migration, the rows they hand the orchestrator lived in a
-- plain in-process `Map`, which meant three things were true at once:
--
--   1. A user-triggered sync after an api restart failed: the store had
--      forgotten the connection existed at all.
--   2. The worker could never sync a Manual or CSV connection, because it is a
--      *different process* with its own, empty, `Map`. `PROCESS_LOCAL_PROVIDERS`
--      (apps/api/src/domain.ts) papered over this by excluding both providers
--      from the nightly fan-out (gate-security-review.md N-7) -- correct given
--      the constraint, but a mitigation, not a fix.
--   3. A CSV import staged between the upload request and its own inline sync
--      was one process crash away from vanishing.
--
-- `connection_staged_facts` is that missing table, owned by `@ctx/connections`
-- (the adapters still own no table -- see packages/connectors/{manual,csv}/OWNERSHIP.md).
-- It is a durable mirror of exactly the shape the two adapters used to hold in
-- memory: an append-only per-connection log of transaction events, plus the two
-- pieces of "current state" (the account list, the balance list) a provider like
-- Plaid gets for free from its own API and a user-owned adapter has to be told.
--
-- ---------------------------------------------------------------------------
-- Shape: three kinds of row sharing one sequence
-- ---------------------------------------------------------------------------
--
-- `kind` partitions the table into two behaviours, not three:
--
--   * `account` / `balance` -- **state**, last write wins. One row per
--     `(connection_id, kind, provider_account_id)`, upserted the way
--     `ManualStore.append()`'s `accounts`/`balances` maps always were. There is
--     nothing to "consume": `StagingStore.accounts()`/`.balances()` just read
--     the current rows, every call, exactly as the in-memory maps did.
--   * `transaction_added` / `transaction_modified` / `transaction_removed` --
--     **log**, append-only, never updated, never deleted. `seq` is the cursor
--     `ManualConnector`/`CsvImportConnector` already hand the orchestrator
--     (`entriesAfter(after, limit)` is `WHERE connection_id = $1 AND seq > $2
--     AND kind IN (...) ORDER BY seq LIMIT $3`), so the cursor contract the
--     conformance suite already checks -- idempotent, monotonic, resumable --
--     holds by construction: a page is a slice of an immutable prefix, and the
--     same cursor twice reads the same rows twice. This is also why there is no
--     separate "consumed" column: consuming a row by deleting or flagging it
--     would break "the same cursor twice is the same page twice", which the
--     port's own contract (packages/connectors/port/src/connector.ts) requires.
--     The cursor *is* the consumption marker.
--
-- `seq` is one `BIGSERIAL` shared by every kind, not one counter per
-- connection: `domain_events` (migration 0003) sets the precedent for
-- "BIGSERIAL as a total order, filtered per scope in the WHERE clause", and a
-- second counter table buys nothing a partial index over one table does not
-- already give.
--
-- ---------------------------------------------------------------------------
-- The dedupe key is `provider_transaction_id`, not `fingerprint`
-- ---------------------------------------------------------------------------
--
-- The gate asked for facts "keyed by (user, connection, fingerprint)", and
-- `user_id`/`connection_id`/`fingerprint` are exactly the columns every
-- transaction row carries. But the *uniqueness* constraint that stops a
-- re-imported file from staging its rows twice is deliberately
-- `(connection_id, provider_transaction_id)` and not `(connection_id,
-- fingerprint)`: `fingerprint` is `sha256(account, date, amount, description)`
-- with no `occurrence` term, so two genuinely identical transactions on the
-- same day -- "two coffees at the same shop" -- share one fingerprint and two
-- different `provider_transaction_id`s (packages/connectors/csv/src/import.ts's
-- `occurrence` exists for precisely this). A unique index on fingerprint would
-- silently drop the second coffee at staging time. `provider_transaction_id` is
-- what `CsvImportConnector`'s in-memory `seen` set already deduplicated on, so
-- the partial unique index below is that same rule, made durable.
--
-- ---------------------------------------------------------------------------
-- No float, ever
-- ---------------------------------------------------------------------------
--
-- Every monetary field a staged fact carries -- a transaction's `amount`, a
-- balance's `current`/`available`/`limit` -- gets its own `*_minor BIGINT` +
-- `*_currency CHAR(3)` pair, exactly like `account_balances` (migration 0004)
-- and `connections` (migration 0005). `fact` is JSONB for everything else a
-- `ProviderTransactionFact`/`ProviderAccountFact` carries (dates, names, the
-- verbatim `raw` payload) -- never a number a ledger balance depends on, so
-- `packages/db/test/migrate.test.ts`'s float ban has a real column to check and
-- a stray float cannot hide inside the blob.

CREATE TABLE connection_staged_facts (
  -- Total order across every row this table will ever hold, shared by every
  -- kind (see header). Not the primary key's only job: it is also the value
  -- `entriesAfter`/`highestSeq` read and the value the adapters hand the
  -- orchestrator as their opaque cursor, stringified.
  seq                      BIGSERIAL   PRIMARY KEY,
  -- App-generated (UUIDv7), so a caller can name the row it just inserted
  -- without a second round trip for `seq`.
  id                       UUID        NOT NULL UNIQUE,
  user_id                  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id            UUID        NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  kind                     TEXT        NOT NULL
                                       CHECK (kind IN (
                                         'account', 'balance',
                                         'transaction_added', 'transaction_modified', 'transaction_removed'
                                       )),
  provider_account_id      TEXT        NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
  -- Populated for every transaction kind; NULL for `account`/`balance`.
  provider_transaction_id  TEXT,
  -- Populated for `transaction_added`/`transaction_modified`; NULL for a
  -- removal (`ProviderTransactionRef` carries no fact) and for account/balance
  -- state rows.
  fingerprint              TEXT,
  amount_minor             BIGINT,
  amount_currency          CHAR(3),
  -- `balance` only: `ProviderBalanceFact.available`. NULL is a real value here
  -- (the provider did not state one), not "unknown".
  available_minor          BIGINT,
  available_currency       CHAR(3),
  -- `balance` only: `ProviderBalanceFact.limit`. A magnitude, stays positive.
  limit_minor              BIGINT,
  limit_currency           CHAR(3),
  -- `balance` only: `ProviderBalanceFact.asOf`.
  as_of                    TIMESTAMPTZ,
  -- Everything else the fact carries that is not money and not one of the
  -- columns above: dates, names, the verbatim provider payload, or (for
  -- `kind = 'account'`) the whole `ProviderAccountFact`.
  fact                     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT connection_staged_facts_transaction_has_ptid CHECK (
    kind NOT IN ('transaction_added', 'transaction_modified', 'transaction_removed')
    OR provider_transaction_id IS NOT NULL
  ),
  CONSTRAINT connection_staged_facts_fact_has_amount CHECK (
    kind NOT IN ('transaction_added', 'transaction_modified')
    OR (amount_minor IS NOT NULL AND amount_currency IS NOT NULL AND fingerprint IS NOT NULL)
  ),
  CONSTRAINT connection_staged_facts_balance_has_amount CHECK (
    kind <> 'balance' OR (amount_minor IS NOT NULL AND amount_currency IS NOT NULL)
  )
);

-- The cursor read: "this connection's transaction log, after this position."
-- `entriesAfter`/`highestSeq` both filter `kind IN (...)` in application code;
-- the index still covers them because `connection_id, seq` is their whole
-- WHERE/ORDER BY, and the kind filter is a cheap re-check on an already narrow
-- row set.
CREATE INDEX connection_staged_facts_connection_seq_idx
  ON connection_staged_facts (connection_id, seq);

-- Idempotent staging: importing the same file, or replaying the same manual
-- batch, twice must not grow the log. Scoped to `transaction_added` only --
-- see the header note on why this is not `fingerprint` -- because a
-- `transaction_modified`/`transaction_removed` legitimately targets the same
-- `provider_transaction_id` again later (a user editing, then re-editing, a
-- manual entry).
CREATE UNIQUE INDEX connection_staged_facts_added_dedup_idx
  ON connection_staged_facts (connection_id, provider_transaction_id)
  WHERE kind = 'transaction_added';

-- Account/balance state: one row per account per kind, upserted.
CREATE UNIQUE INDEX connection_staged_facts_state_idx
  ON connection_staged_facts (connection_id, kind, provider_account_id)
  WHERE kind IN ('account', 'balance');

CREATE INDEX connection_staged_facts_user_idx ON connection_staged_facts (user_id);

COMMENT ON TABLE connection_staged_facts IS
  'Durable staging for the process-local connectors (Manual, CSV/OFX/QIF) -- decision D-5. Owner: @ctx/connections.';
COMMENT ON COLUMN connection_staged_facts.seq IS
  'Total order across every kind. The cursor ManualConnector/CsvImportConnector hand the orchestrator, stringified.';
COMMENT ON COLUMN connection_staged_facts.fact IS
  'Everything the fact carries that is not money: never a value a ledger balance depends on.';
