-- SPDX-License-Identifier: MIT
-- 0003_platform
--
-- Forward-only. Immutable once merged: the runner checksums this file.
-- Destructive changes use expand -> backfill -> contract across releases.
--
-- The platform substrate (WP 0.3, decision D7): a transactional outbox, its
-- consumer bookkeeping, a Postgres-backed job queue, a cron table, and the boot
-- config record. Owner of every table below: @core/platform.
--
-- Three properties this file exists to guarantee:
--
--   1. An event and the data that justifies it commit together or not at all.
--      There is no publish path that does not take a transaction handle.
--   2. `seq` order is commit order. A bigserial alone does NOT give that — two
--      concurrent writers can take 5 and 6 and commit in the other order, and a
--      consumer that has read 6 would then never see 5. `append_domain_event`
--      takes a transaction-scoped advisory lock before consuming the sequence,
--      so the sequence cannot be handed out to a transaction that commits after
--      one holding a higher value. Gaps (from rollbacks) are fine; inversions
--      are not, and this is the cheapest way to be sure there are none.
--   3. Nothing depends on LISTEN/NOTIFY arriving. The triggers below are a
--      latency optimisation; the pump's fallback poll is the mechanism.

-- ---------------------------------------------------------------------------
-- The event log
-- ---------------------------------------------------------------------------

CREATE TABLE domain_events (
  -- Total order. BIGSERIAL rather than IDENTITY because nextval() is called
  -- explicitly by append_domain_event() under the ordering lock.
  seq            BIGSERIAL   PRIMARY KEY,
  -- UUIDv7, generated app-side. Stable across replay, so it is the natural
  -- idempotency key for a consumer.
  id             UUID        NOT NULL UNIQUE,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  aggregate_type TEXT        NOT NULL CHECK (length(btrim(aggregate_type)) > 0),
  aggregate_id   UUID,
  -- Dotted and namespaced by context: 'ledger.TransactionsUpserted'.
  event_type     TEXT        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*\.[A-Za-z][A-Za-z0-9]*$'),
  -- Payload schema version. Consumers upcast old versions at read time.
  event_version  INTEGER     NOT NULL DEFAULT 1 CHECK (event_version >= 1),
  -- Ids and small facts only. NEVER a full entity: a replay must reflect
  -- today's data, not resurrect a stale snapshot.
  payload        JSONB       NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Ties a whole sync run together, across HTTP, jobs, and events.
  correlation_id UUID        NOT NULL,
  -- The event or command that caused this one.
  causation_id   UUID,
  -- Deleting user data rewrites payloads to 'purged' rather than deleting rows,
  -- so the log keeps its ordering and its shape without keeping the facts.
  redaction      TEXT        NOT NULL DEFAULT 'none' CHECK (redaction IN ('none', 'pii', 'purged'))
);

COMMENT ON TABLE domain_events IS
  'Append-only transactional outbox (decision D7). Owner: @core/platform.';
COMMENT ON COLUMN domain_events.seq IS
  'Total order AND commit order: append_domain_event() serialises sequence assignment.';
COMMENT ON COLUMN domain_events.payload IS
  'Thin: ids and small facts. Consumers re-read current state through the owning context.';

-- The pump's read: one consumer, a type filter, seq ascending.
CREATE INDEX domain_events_type_seq_idx ON domain_events (event_type, seq);
-- "Reconstruct this sync run."
CREATE INDEX domain_events_correlation_idx ON domain_events (correlation_id);
-- "Everything that happened to this account."
CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_type, aggregate_id, seq);
CREATE INDEX domain_events_user_seq_idx ON domain_events (user_id, seq);

-- The append function. Application code calls this and nothing else: keeping the
-- ordering lock inside the function means there is no way to insert an event
-- that bypasses it, including from psql during an incident.
CREATE FUNCTION append_domain_event(
  p_id             UUID,
  p_user_id        UUID,
  p_aggregate_type TEXT,
  p_aggregate_id   UUID,
  p_event_type     TEXT,
  p_event_version  INTEGER,
  p_payload        JSONB,
  p_occurred_at    TIMESTAMPTZ,
  p_correlation_id UUID,
  p_causation_id   UUID,
  p_redaction      TEXT
-- Column names deliberately prefixed: a RETURNS TABLE column is an OUT variable
-- in plpgsql, and `seq`/`recorded_at` would then shadow the columns of the very
-- table being written.
) RETURNS TABLE (out_seq BIGINT, out_recorded_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq BIGINT;
  v_recorded_at TIMESTAMPTZ;
BEGIN
  -- 0x5046455654534551 = ASCII 'PFEVTSEQ'. Transaction-scoped: released at
  -- COMMIT or ROLLBACK, never leaked. Distinct from the migration lock.
  PERFORM pg_advisory_xact_lock(5784387008488228177);
  v_seq := nextval('domain_events_seq_seq');
  INSERT INTO domain_events (
    seq, id, user_id, aggregate_type, aggregate_id, event_type, event_version,
    payload, occurred_at, correlation_id, causation_id, redaction
  ) VALUES (
    v_seq, p_id, p_user_id, p_aggregate_type, p_aggregate_id, p_event_type, p_event_version,
    p_payload, p_occurred_at, p_correlation_id, p_causation_id, p_redaction
  )
  RETURNING domain_events.recorded_at INTO v_recorded_at;
  RETURN QUERY SELECT v_seq, v_recorded_at;
END;
$$;

COMMENT ON FUNCTION append_domain_event IS
  'The only sanctioned way to publish. Serialises sequence assignment so seq order is commit order.';

-- Wake the pump immediately. Delivered at COMMIT, so a listener never sees a
-- notification for an event it cannot read. Statement-level: one wake per batch.
CREATE FUNCTION notify_domain_events() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('personalfi_domain_events', '');
  RETURN NULL;
END;
$$;

CREATE TRIGGER domain_events_notify
  AFTER INSERT ON domain_events
  FOR EACH STATEMENT EXECUTE FUNCTION notify_domain_events();

-- ---------------------------------------------------------------------------
-- Consumer bookkeeping
-- ---------------------------------------------------------------------------

-- Global, not user-scoped: an offset is a property of this deployment's pump,
-- not of the account holder. It is not exported and not restored with user data.
CREATE TABLE event_consumer_offsets (
  -- Versioned by convention: 'budgeting.actuals@v3'. Bumping the version and
  -- resetting last_seq to 0 is the whole read-model rebuild procedure.
  consumer_name TEXT        PRIMARY KEY CHECK (length(btrim(consumer_name)) > 0),
  last_seq      BIGINT      NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  status        TEXT        NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'paused', 'replaying', 'failed')),
  -- Dead-letter detail: where it stopped and why. A failed consumer stops; it
  -- never skips, because a skipped event is a silently wrong read model.
  failed_seq      BIGINT,
  failed_event_id UUID,
  failed_error    TEXT,
  failed_count    INTEGER     NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  retry_after     TIMESTAMPTZ,
  last_event_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE event_consumer_offsets IS
  'One row per consumer: how far it has read and whether it is healthy. Global. Owner: @core/platform.';

-- The bookkeeping half of idempotency. The other half is structural: handlers
-- recompute a deterministic function of current state wherever they can. This
-- table is for the handlers that cannot (sending a notification, calling out).
CREATE TABLE processed_events (
  consumer_name TEXT        NOT NULL,
  event_id      UUID        NOT NULL REFERENCES domain_events (id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_seq     BIGINT      NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

COMMENT ON TABLE processed_events IS
  'Delivery receipts. Written in the same transaction as the handler, so a duplicate delivery is a no-op. Owner: @core/platform.';

CREATE INDEX processed_events_consumer_seq_idx ON processed_events (consumer_name, event_seq);

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind           TEXT        NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- "Do not queue this twice." Webhook + schedule + a user clicking refresh is
  -- three concurrent syncs of one connection, which is how cursor state rots.
  dedupe_key     TEXT,
  -- "Do not run two of these at once." Weaker than dedupe: others may queue.
  singleton_key  TEXT,
  priority       INTEGER     NOT NULL DEFAULT 100,
  run_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts       INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts   INTEGER     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  locked_by      TEXT,
  locked_at      TIMESTAMPTZ,
  -- A lock alone is not enough: one `docker kill` mid-sync leaves a job
  -- 'running' forever. The reaper reclaims anything whose heartbeat is stale.
  heartbeat_at   TIMESTAMPTZ,
  correlation_id UUID        NOT NULL,
  causation_event_id UUID,
  last_error     JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

COMMENT ON TABLE jobs IS
  'Postgres-backed work queue claimed with FOR UPDATE SKIP LOCKED. Owner: @core/platform.';
COMMENT ON COLUMN jobs.dedupe_key IS
  'Unique among queued-or-running jobs. Re-enqueueing returns the existing job id.';
COMMENT ON COLUMN jobs.singleton_key IS
  'At most one running job per key, across every worker. Others queue rather than being dropped.';

-- The predicate is exactly what enqueueJob names in its ON CONFLICT arbiter, so
-- Postgres can infer this index. NULL dedupe keys are distinct under a unique
-- index, so a job without one never collides.
CREATE UNIQUE INDEX jobs_dedupe_active_idx
  ON jobs (dedupe_key)
  WHERE status IN ('pending', 'running');

-- The claim query's index: pending work, oldest and highest priority first.
CREATE INDEX jobs_claim_idx
  ON jobs (priority, run_after, created_at)
  WHERE status = 'pending';

CREATE INDEX jobs_running_singleton_idx
  ON jobs (singleton_key)
  WHERE status = 'running' AND singleton_key IS NOT NULL;

-- The reaper's index.
CREATE INDEX jobs_heartbeat_idx ON jobs (heartbeat_at) WHERE status = 'running';

CREATE INDEX jobs_kind_status_idx ON jobs (kind, status);
CREATE INDEX jobs_correlation_idx ON jobs (correlation_id);

CREATE FUNCTION notify_jobs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('personalfi_jobs', '');
  RETURN NULL;
END;
$$;

-- Deliberately NOT `AFTER UPDATE`: a running job heartbeats every 15 seconds, and
-- a statement-level notify on every update would wake every idle worker four
-- times a minute per in-flight job. Only two things make new work runnable: an
-- insert, and a retry moving a row back to 'pending'.
CREATE TRIGGER jobs_notify
  AFTER INSERT ON jobs
  FOR EACH STATEMENT EXECUTE FUNCTION notify_jobs();

CREATE TRIGGER jobs_requeued_notify
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending')
  EXECUTE FUNCTION notify_jobs();

-- One row per attempt. This is the observability surface: "what happened?" for a
-- failed nightly sync is answered here, not from a log file that has rotated.
CREATE TABLE job_runs (
  id             UUID        PRIMARY KEY,
  job_id         UUID        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  attempt        INTEGER     NOT NULL CHECK (attempt >= 1),
  worker_id      TEXT        NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  -- 'abandoned' is what the reaper records for a worker that was killed.
  outcome        TEXT        CHECK (outcome IN ('succeeded', 'failed', 'abandoned')),
  duration_ms    INTEGER,
  error          JSONB,
  correlation_id UUID        NOT NULL,
  UNIQUE (job_id, attempt)
);

COMMENT ON TABLE job_runs IS
  'Per-attempt job history, including attempts abandoned by a killed worker. Owner: @core/platform.';

CREATE INDEX job_runs_job_idx ON job_runs (job_id, attempt);
CREATE INDEX job_runs_started_idx ON job_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Scheduler
-- ---------------------------------------------------------------------------

-- Cron in a table rather than in code, because the user must be able to see and
-- change the nightly sync time, and because a missed window (the box was off)
-- must be detected and run once rather than forty times.
CREATE TABLE schedules (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name           TEXT        NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  cron           TEXT        NOT NULL CHECK (length(btrim(cron)) > 0),
  -- IANA zone. The user's, never the container's TZ: a budget month boundary
  -- computed in UTC is a whole class of off-by-one-day bugs.
  timezone       TEXT        NOT NULL DEFAULT 'UTC' CHECK (length(btrim(timezone)) > 0),
  job_kind       TEXT        NOT NULL,
  job_payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  -- Nightly syncs from every self-hosted instance at exactly 03:15 is a
  -- thundering herd against a provider. Spread them.
  jitter_seconds INTEGER     NOT NULL DEFAULT 0 CHECK (jitter_seconds >= 0),
  last_run_at    TIMESTAMPTZ,
  next_run_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE schedules IS
  'User-visible cron table, evaluated by whichever worker holds the scheduler advisory lock. Owner: @core/platform.';

CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;

-- ---------------------------------------------------------------------------
-- Boot record
-- ---------------------------------------------------------------------------

-- One row per *distinct* effective configuration, not per boot: "what changed?"
-- after a behaviour shift is a diff between two rows, and the table stays tiny.
-- Global: this is the process's configuration, not the account holder's data.
CREATE TABLE config_snapshots (
  id            UUID        PRIMARY KEY,
  role          TEXT        NOT NULL CHECK (role IN ('api', 'worker', 'migrator', 'cli')),
  -- SHA-256 over the canonical JSON of the payload.
  hash          TEXT        NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  -- describeConfig(): non-secrets only, secrets reduced to a list of names.
  payload       JSONB       NOT NULL,
  app_version   TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  boot_count    INTEGER     NOT NULL DEFAULT 1 CHECK (boot_count >= 1),
  UNIQUE (role, hash)
);

COMMENT ON TABLE config_snapshots IS
  'Non-secret effective config per role, deduplicated by hash. Global. Owner: @core/platform.';

CREATE INDEX config_snapshots_last_seen_idx ON config_snapshots (last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Feature flags
-- ---------------------------------------------------------------------------

-- The table was created by 0001 and claimed by @core/db as a placeholder. WP 0.3
-- splits the platform role out into @core/platform, which is where the flag
-- service lives, so the claim and the Drizzle definition move with it. No DDL
-- change: only the owner in OWNERSHIP.md.
COMMENT ON TABLE feature_flags IS
  'Per-user overrides for progressive module rollout. Defaults live in code; a row here overrides one. Owner: @core/platform.';

-- Invalidate the in-memory flag cache on every writer, not just the one that
-- made the change. Without this, toggling a module in the UI takes effect on the
-- api process and not on the worker, which is a confusing half-enabled state.
CREATE FUNCTION notify_feature_flags() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('personalfi_feature_flags', '');
  RETURN NULL;
END;
$$;

CREATE TRIGGER feature_flags_notify
  AFTER INSERT OR UPDATE OR DELETE ON feature_flags
  FOR EACH STATEMENT EXECUTE FUNCTION notify_feature_flags();
