-- SPDX-License-Identifier: MIT
-- 0005_connections: the Connections bounded context — one row per linked
--                   provider, the provider-account -> ledger-account map, and
--                   the sync-run history that is the observability surface.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this file
-- and refuses to start if it ever changes. Destructive changes use
-- expand -> backfill -> contract across releases.
--
-- Owner of every table below: @ctx/connections. See that package's OWNERSHIP.md.
--
-- ---------------------------------------------------------------------------
-- The three ideas this schema exists to encode
-- ---------------------------------------------------------------------------
--
-- 1. **The cursor is sync state, and it commits with the data it describes.**
--    `connections.transactions_cursor` is advanced in the same transaction that
--    writes the page's rows into the ledger, and in no other. A cursor that
--    committed while its data did not is a permanent, silent gap: the provider
--    will never resend those transactions (01 §5.1). This is why the column
--    lives on the connection rather than in a separate cursor store that a
--    second transaction would have to reach.
--
-- 2. **Provider credentials are ciphertext, bound to their row.** The AAD is
--    `connections.sealed_credentials` plus this row's id, so a ciphertext lifted
--    out of one row and pasted into another does not decrypt. There is no
--    plaintext column, no "encrypted_at" flag, and no code path that stores a
--    token any other way: `@core/secretbox` is the only encryption path (D5).
--
-- 3. **Account identity survives reconnection.** `connection_accounts` maps a
--    provider's account id to the ledger's account id, permanently. Losing that
--    mapping on a reconnect is the classic way a personal-finance app silently
--    doubles a user's net worth (08 §3.9), so the mapping is a row and not an
--    inference from a name and a mask.
--
-- No foreign key points at `accounts`. The ledger's own `accounts.connection_id`
-- has no FK either, for the symmetric reason stated in migration 0004: a context
-- may not constrain another context's table, and Ledger has no idea Plaid
-- exists.

-- ---------------------------------------------------------------------------
-- connections: one linked provider.
-- ---------------------------------------------------------------------------
--
-- `status` is the four-state machine WP 1.2 needs, which is 04 §4.5's five
-- states with `degraded` folded into `error`. The distinction 04 draws between
-- `degraded` (backing off, will heal itself) and a hard failure is real, but it
-- is *retry* state, and retry state lives in `jobs` where the runner can act on
-- it — duplicating it here would give two answers to "will this retry?".
--
--   active            syncing normally.
--   reauth_required   credentials or consent are gone. Scheduled syncs STOP:
--                     every further call is guaranteed to fail and burns the
--                     rate limit the reconnect will need. Data and cursor are
--                     PRESERVED (08 §3.9: reconnect never deletes data).
--   error             the last run failed for a reason that is not the user's
--                     to fix. The job queue is backing off.
--   disconnected      terminal. The secret is destroyed; the history is kept.
CREATE TABLE connections (
  id                     UUID        PRIMARY KEY,
  user_id                UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Matches `accounts.provider`. 'plaid', 'manual', 'file_import', 'seed'.
  provider               TEXT        NOT NULL CHECK (length(btrim(provider)) > 0),
  -- The provider's own id for this connection: a Plaid item_id, a file name, a
  -- generated id for manual. Its natural key, kept separate from our UUIDv7.
  provider_connection_id TEXT        NOT NULL CHECK (length(btrim(provider_connection_id)) > 0),
  display_name           TEXT        NOT NULL CHECK (length(btrim(display_name)) > 0),
  status                 TEXT        NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active', 'reauth_required', 'error', 'disconnected')),
  -- Envelope from @core/secretbox. NULL when the provider has no credential at
  -- all (manual entry, a file import) — which is different from an empty one,
  -- and the difference is why this is nullable rather than an empty bytea.
  sealed_credentials     BYTEA,
  -- Opaque. We never parse it, never compare two of them, never construct one.
  transactions_cursor    TEXT,
  -- Non-secret, per-connection configuration: a CSV column-mapping profile, the
  -- datasets the user enabled. User data, so it belongs in the backup and the
  -- export (docs/CONVENTIONS.md, "Configuration") rather than in env.
  config                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- What the adapter declared when it linked, so the UI can render the
  -- connection without instantiating a connector.
  capabilities           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at         TIMESTAMPTZ,
  -- The typed error from the last failed run. Kind, condition, provider code,
  -- redacted context. Never a token: `redactedContext` is the adapter's promise
  -- and `REDACTED_PATHS` in apps/api is the second line of defence.
  last_error             JSONB,
  -- When the current non-active status began, for "degraded for 26 hours" and
  -- for the 24h/48h escalation thresholds of 08 §2.4.
  error_since            TIMESTAMPTZ,
  -- Open-banking style time-boxed consent. NULL when consent does not expire.
  consent_expires_at     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A cursor with no credential is fine (manual, file import). A credential with
  -- a disconnected status is not: `disconnect` destroys the secret, and a row
  -- that kept one would be a token nobody is watching any more.
  CONSTRAINT connections_disconnected_has_no_secret
    CHECK (status <> 'disconnected' OR sealed_credentials IS NULL)
);

-- The natural key. Re-linking the same Plaid item must update this row rather
-- than create a second one pointing at the same accounts.
CREATE UNIQUE INDEX connections_provider_key_idx
  ON connections (user_id, provider, provider_connection_id);
CREATE INDEX connections_user_status_idx ON connections (user_id, status);

COMMENT ON TABLE connections IS
  'One linked provider: status, sealed credentials, and the opaque sync cursor. Owner: @ctx/connections.';
COMMENT ON COLUMN connections.transactions_cursor IS
  'Opaque provider token. Advanced ONLY in the transaction that commits the page it describes.';
COMMENT ON COLUMN connections.sealed_credentials IS
  'SecretBox envelope, AAD-bound to (connections, sealed_credentials, id). Never plaintext.';

-- ---------------------------------------------------------------------------
-- connection_accounts: provider account -> ledger account, permanently.
-- ---------------------------------------------------------------------------
--
-- `account_id` is the ledger's `accounts.id` and carries no foreign key, for the
-- reason in this file's header. The uniqueness constraints are what make the
-- mapping trustworthy: one provider account maps to exactly one ledger account,
-- and one ledger account is claimed by at most one connection. Without the
-- second, re-linking an institution through a different provider would attach
-- two connections to one account and both would sync it.
CREATE TABLE connection_accounts (
  id                  UUID        PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id       UUID        NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  provider_account_id TEXT        NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
  -- @ctx/ledger's accounts.id. No FK: a context may not constrain another
  -- context's table (see migration 0004's note on accounts.connection_id).
  account_id          UUID        NOT NULL,
  -- What the provider called it when we last looked. The user's own name for the
  -- account lives on the ledger row; this is provenance, not display.
  provider_name       TEXT        NOT NULL DEFAULT '',
  currency            CHAR(3)     NOT NULL,
  -- Per-account capability set (08 §2.5): a connection may support holdings
  -- while a particular checking account within it does not.
  capabilities        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- The user can stop syncing one account without disconnecting the institution.
  enabled             BOOLEAN     NOT NULL DEFAULT true,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX connection_accounts_provider_key_idx
  ON connection_accounts (connection_id, provider_account_id);
CREATE UNIQUE INDEX connection_accounts_account_idx
  ON connection_accounts (user_id, account_id);
CREATE INDEX connection_accounts_user_idx ON connection_accounts (user_id);

COMMENT ON TABLE connection_accounts IS
  'Provider account id -> ledger account id. Survives reconnection; that is the point. Owner: @ctx/connections.';

-- ---------------------------------------------------------------------------
-- sync_runs: every attempt, successful or not.
-- ---------------------------------------------------------------------------
--
-- 08 §6.3 calls this "the observability surface that matters", and the claim it
-- makes is specific: `Settings -> Connections -> History` renders these rows and
-- "this single feature eliminates most 'why is my balance wrong' debugging". So
-- a row is written for **every attempt**, including the ones that fail before
-- the first page, and it carries the cursor on both sides — `cursor_before` and
-- `cursor_after` together are the audit trail for the one invariant that can
-- lose data silently.
CREATE TABLE sync_runs (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_id  UUID        NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  -- Why this run happened. 'scheduled' is the nightly job; 'manual' is the
  -- refresh button; 'repair' is the sync after a successful reconnect.
  trigger        TEXT        NOT NULL
                             CHECK (trigger IN ('initial', 'scheduled', 'manual', 'backfill', 'repair', 'webhook')),
  -- Which dataset. Split out so a holdings failure does not hide a successful
  -- transactions run on the same connection.
  operation      TEXT        NOT NULL DEFAULT 'transactions'
                             CHECK (operation IN ('transactions', 'balances', 'holdings', 'liabilities')),
  status         TEXT        NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'success', 'partial', 'failed')),
  cursor_before  TEXT,
  cursor_after   TEXT,
  page_count     INTEGER     NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  added_count    INTEGER     NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  modified_count INTEGER     NOT NULL DEFAULT 0 CHECK (modified_count >= 0),
  removed_count  INTEGER     NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  -- How many times the page loop was restarted from the page-1 cursor because
  -- the provider mutated the stream mid-pagination (01 §5.1). Non-zero here is
  -- the signal that an institution is busy, not that we have a bug.
  restart_count  INTEGER     NOT NULL DEFAULT 0 CHECK (restart_count >= 0),
  -- One of the six ConnectorError kinds, and the finer provider condition.
  error_kind     TEXT,
  error_code     TEXT,
  error_detail   JSONB,
  correlation_id UUID        NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),

  -- A finished run says how it finished. A running one has not.
  CONSTRAINT sync_runs_finished_consistently
    CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT sync_runs_failure_has_a_kind
    CHECK (status <> 'failed' OR error_kind IS NOT NULL)
);

-- The history view: newest first, per connection.
CREATE INDEX sync_runs_connection_idx ON sync_runs (connection_id, started_at DESC);
CREATE INDEX sync_runs_user_idx ON sync_runs (user_id, started_at DESC);
-- "Is anything stuck?" — a partial index, because running rows are a handful and
-- finished ones are the rest of the table forever.
CREATE INDEX sync_runs_running_idx ON sync_runs (connection_id) WHERE status = 'running';

COMMENT ON TABLE sync_runs IS
  'One row per sync attempt, success or failure, with counts, timings and the cursor on both sides. Owner: @ctx/connections.';
COMMENT ON COLUMN sync_runs.cursor_before IS
  'The cursor this run started from. With cursor_after, the audit trail for the never-advance-outside-the-write-transaction invariant.';
