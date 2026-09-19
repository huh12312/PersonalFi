-- SPDX-License-Identifier: MIT
-- 0011_notifications: channels, rules, the delivery outbox and its attempt log
--                     (WP 2.4, 08 §4.5, decisions D5, D6, D7).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- ---------------------------------------------------------------------------
-- What this schema is, and what makes it different from the others
-- ---------------------------------------------------------------------------
--
-- Every other context in this repository writes rows. This one *leaves the
-- machine*. `notification_channels` is the first table in PersonalFi whose
-- contents become a destination for an outbound connection, and a destination
-- is a user-supplied string. 02-phase-2-dispatch.md §5 states the consequence
-- plainly: "an SSRF here reaches `db:5432` and the container metadata
-- endpoint."
--
-- So the columns below are shaped by one question -- *what can a row make the
-- worker connect to?* -- and three answers are enforced here in SQL rather than
-- only in TypeScript, because a control that lives in one language is a control
-- with one place to forget it:
--
--   * `scheme` is a closed set, and the set depends on `kind`
--     (`notification_channels_scheme_matches_kind`). There is no plaintext
--     `http` for ntfy and no cleartext SMTP: the only values that exist are
--     `https`, `smtps` and `smtp+starttls`.
--   * `destination_host` is stored *in the clear* and `destination_port`
--     beside it, so "what may this deployment talk to?" is answerable with one
--     SELECT by an operator who does not hold the passphrase. Neither is a
--     secret -- the allow-list they are checked against is operator
--     configuration.
--   * `enabled` cannot be true without `verified_at`
--     (`notification_channels_enabled_is_verified`). 02-phase-2-dispatch.md §6
--     question 3's default is "ntfy self-hosted topic and SMTP both built,
--     both disabled until configured"; this is that sentence as a constraint
--     rather than as a default somebody can pass `true` past.
--
-- The rest -- the literal-IP refusal, the private/link-local/loopback/metadata
-- ranges, the DNS re-check against the *resolved* address, the refusal to
-- follow a redirect, the bounded body, the timeouts -- cannot be expressed in
-- DDL and lives in `packages/contexts/notifications/src/egress.ts`, which is
-- the only file in the package that may open a socket. Each refusal has a test
-- and each test was sabotaged once and observed red
-- (docs/evidence/phase-2/wp2.4-notifications.md §3).
--
-- ---------------------------------------------------------------------------
-- The channel config is sealed, and nothing derived from it is not
-- ---------------------------------------------------------------------------
--
-- Decision D5: "row-level encryption of provider secrets, exchange keys, LLM
-- keys, and channel configs is P0". `sealed_config` is a `SecretBox` storage
-- envelope (`version || key_id || nonce || ciphertext+tag`), sealed under a
-- per-record DEK with the AAD `personalfi/v1|notification_channels|
-- sealed_config|<channel id>|<key version>`, exactly as
-- `connections.sealed_credentials` is. Two properties follow and both are
-- asserted in `test/db/custody.test.ts`:
--
--   * the bytes cannot be lifted into another channel row -- the AAD names the
--     row, so the Poly1305 tag stops verifying;
--   * the bytes cannot be opened by another account holder's box -- the DEK is
--     a per-user `encryption_keys` row and `SecretBox.open` refuses a key it
--     does not own, before any cipher runs.
--
-- What is deliberately *not* inside the envelope is the host, the port and the
-- scheme. Putting them there would mean the egress guard could not run without
-- the KEK, so a locked instance would either refuse to explain itself or would
-- have to trust an unchecked destination; and it would make the allow-list
-- unauditable. The ntfy access token, the SMTP username and the SMTP password
-- are the secrets, and they are the things inside.
--
-- ---------------------------------------------------------------------------
-- At-most-once is a UNIQUE index, and coalescing is a second one
-- ---------------------------------------------------------------------------
--
-- 08 §4.5: "the consumer inserts into `notification_outbox` (idempotent via
-- `dedupeKey`)" and "Digest mode coalesces by `groupKey` within a window so a
-- 2,000-transaction backfill produces one notification, not 2,000 -- this is
-- enforced by the outbox, not by each rule remembering to do it."
--
-- Both sentences are indexes here, not code:
--
--   notification_outbox_dedupe_idx  UNIQUE (user_id, dedupe_key)
--   notification_outbox_group_idx   UNIQUE (user_id, channel_id, group_key,
--                                           group_window_start)
--                                   WHERE group_key IS NOT NULL
--
-- `dedupe_key` is scoped to `user_id` rather than globally unique. A globally
-- unique key would be marginally stronger against a bug in key construction
-- and materially weaker in operation: two account holders can legitimately
-- derive the same key for the same public fact ("Chase needs reconnection"),
-- and a global index would silently deliver that to whoever inserted first and
-- to nobody else. A duplicate notification is an annoyance; a dropped one is
-- the failure this whole table exists to prevent.
--
-- The window bounds live on the outbox row rather than on the rule, which is
-- what "enforced by the outbox, not by each rule" means concretely: the
-- coalescing key is `(channel, group_key, window_start)` and a second event in
-- the same window collides with an existing row and increments `group_count`.
-- A rule cannot opt out of it, and two different rules writing the same
-- `group_key` into the same window coalesce together.
--
-- ---------------------------------------------------------------------------
-- Quiet hours hold; they never drop
-- ---------------------------------------------------------------------------
--
-- A notification suppressed during quiet hours is still a notification. There
-- is no `status = 'dropped'` below and no DELETE on the hold path: the row goes
-- to `status = 'held'` with `held_reason = 'quiet_hours'` and `not_before` set
-- to the next instant at which the local wall clock reads the window's end in
-- `notification_rules.timezone`. `test/db/quiet-hours.test.ts` asserts that
-- across a DST boundary, where "add nine hours" and "the next 07:00 local" are
-- an hour apart and only one of them is right.
--
-- `quiet_hours_enabled` must be FALSE on a `P0_SAFETY` rule
-- (`notification_rules_p0_ignores_quiet_hours`). 02-phase-2-dispatch.md §6
-- question 3's default reserves immediate delivery for the P0-safety class --
-- overdraft, duplicate charge, missed debt payment -- and a row that claims
-- both "wake me for this at any hour" and "hold this until 07:00" is a
-- contradiction the schema should not be able to hold.
--
-- ---------------------------------------------------------------------------
-- Dead letters stay visible
-- ---------------------------------------------------------------------------
--
-- `delivery_attempts` is append-only and one row per attempt, so the backoff
-- ladder and the reason each rung failed survive the notification reaching
-- `dead`. 08 §4.5 wants "a dead-letter state visible in the UI"; a `dead` row
-- with its attempts still attached is what makes that view worth opening, and
-- `outcome = 'refused'` with a `refusal_code` is how an egress refusal reads
-- differently from a mail server being down.
--
-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
--
-- No money crosses this schema: a notification carries a rendered body, and the
-- figures inside it were formatted by the context that owned them. There is
-- therefore no `*_minor` column here and no `CHAR(3)` currency -- inventing one
-- to match a convention this table does not need would be worse than saying so.
-- Every instant is `TIMESTAMPTZ`; the quiet-hours bounds are `INTEGER` minutes
-- from local midnight rather than `TIME`, because they are read against a named
-- IANA zone and a `TIME` column invites somebody to compare it with `now()`.
-- No `REAL`/`DOUBLE PRECISION`/`FLOAT` anywhere (`migrate.test.ts` bans them).

-- ---------------------------------------------------------------------------
-- notification_channels
-- ---------------------------------------------------------------------------

CREATE TABLE notification_channels (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                    TEXT        NOT NULL CHECK (kind IN ('ntfy', 'smtp')),
  display_name            TEXT        NOT NULL CHECK (length(btrim(display_name)) > 0),
  -- Not a secret, and in the clear on purpose: this is the column an operator
  -- greps to answer "what can this deployment connect to?" without the KEK.
  destination_host        TEXT        NOT NULL
                                      CHECK (length(btrim(destination_host)) > 0
                                             AND destination_host = lower(destination_host)
                                             AND destination_host !~ '[|/\\@ ]'),
  destination_port        INTEGER     NOT NULL CHECK (destination_port BETWEEN 1 AND 65535),
  -- The scheme allow-list, as a closed set. There is no cleartext member.
  scheme                  TEXT        NOT NULL
                                      CHECK (scheme IN ('https', 'smtps', 'smtp+starttls')),
  -- The SecretBox envelope. 41 bytes of header (version + key id + nonce) plus
  -- a 16-byte tag, so anything at or below 57 bytes cannot be a sealed value.
  sealed_config           BYTEA       NOT NULL CHECK (octet_length(sealed_config) > 57),
  -- Both channel kinds ship disabled; see the CHECK below.
  enabled                 BOOLEAN     NOT NULL DEFAULT FALSE,
  verified_at             TIMESTAMPTZ,
  verify_failure_code     TEXT,
  last_delivery_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_channels_scheme_matches_kind CHECK (
    (kind = 'ntfy' AND scheme = 'https')
    OR (kind = 'smtp' AND scheme IN ('smtps', 'smtp+starttls'))
  ),
  -- "Both built, both disabled until configured" (§6 Q3), as a constraint. A
  -- channel becomes enabled only after `verify()` -- the "send test" action --
  -- has actually reached it, which is also what stops a typo'd host from
  -- sitting in the outbox retry ladder for five attempts.
  CONSTRAINT notification_channels_enabled_is_verified CHECK (
    NOT enabled OR verified_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX notification_channels_user_name_idx
  ON notification_channels (user_id, display_name);
CREATE INDEX notification_channels_user_enabled_idx
  ON notification_channels (user_id) WHERE enabled;

COMMENT ON TABLE notification_channels IS
  'One outbound destination. The config is sealed (D5); the host, port and scheme are not, so the egress allow-list is auditable without the KEK.';
COMMENT ON COLUMN notification_channels.sealed_config IS
  'SecretBox envelope over the channel secrets (ntfy token, SMTP username and password). AAD: personalfi/v1|notification_channels|sealed_config|<id>|<key version>.';
COMMENT ON COLUMN notification_channels.destination_host IS
  'Checked against the operator allow-list on every send, never trusted because it is stored. Literal IPs are refused before a row is ever written.';
COMMENT ON COLUMN notification_channels.enabled IS
  'False until verify() has succeeded. The CHECK, not the default, is what enforces it.';

-- ---------------------------------------------------------------------------
-- notification_rules
-- ---------------------------------------------------------------------------

CREATE TABLE notification_rules (
  id                       UUID        PRIMARY KEY,
  user_id                  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_id               UUID        NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  name                     TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  -- `<context>.<EventName>`, the same wire contract `defineEvent` validates.
  -- A bare UUID rather than a foreign key into anything: an event type is a
  -- string on a wire, not a row (decision D8).
  event_type               TEXT        NOT NULL
                                       CHECK (event_type ~ '^[a-z][a-z0-9_]*\.[A-Za-z][A-Za-z0-9]*$'),
  -- Declarative predicates over the event payload, evaluated by
  -- src/conditions.ts. An object, never an expression: a rule language with an
  -- eval in it is a second egress surface.
  conditions               JSONB       NOT NULL DEFAULT '{}'
                                       CHECK (jsonb_typeof(conditions) = 'object'),
  delivery_class           TEXT        NOT NULL
                                       CHECK (delivery_class IN ('P0_SAFETY', 'PROMPT', 'DIGEST')),
  digest_cadence           TEXT        CHECK (digest_cadence IN ('DAILY', 'WEEKLY')),
  -- The *user's* zone, never the container's TZ. Quiet hours and the digest
  -- window are both computed in it.
  timezone                 TEXT        NOT NULL CHECK (length(btrim(timezone)) > 0),
  quiet_hours_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Minutes from local midnight. 1320 = 22:00, 420 = 07:00 (§6 Q3's default).
  quiet_hours_start_minute INTEGER     NOT NULL DEFAULT 1320
                                       CHECK (quiet_hours_start_minute BETWEEN 0 AND 1439),
  quiet_hours_end_minute   INTEGER     NOT NULL DEFAULT 420
                                       CHECK (quiet_hours_end_minute BETWEEN 0 AND 1439),
  enabled                  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_rules_digest_has_cadence CHECK (
    (delivery_class = 'DIGEST') = (digest_cadence IS NOT NULL)
  ),
  -- §6 Q3: "immediate delivery only for the P0-safety class". A rule that is
  -- both P0 and quiet-hours-held is a contradiction, so it cannot be stored.
  CONSTRAINT notification_rules_p0_ignores_quiet_hours CHECK (
    delivery_class <> 'P0_SAFETY' OR quiet_hours_enabled = FALSE
  ),
  CONSTRAINT notification_rules_quiet_window_is_real CHECK (
    NOT quiet_hours_enabled OR quiet_hours_start_minute <> quiet_hours_end_minute
  )
);

CREATE UNIQUE INDEX notification_rules_user_name_idx ON notification_rules (user_id, name);
CREATE INDEX notification_rules_event_idx
  ON notification_rules (user_id, event_type) WHERE enabled;
CREATE INDEX notification_rules_channel_idx ON notification_rules (channel_id);

COMMENT ON TABLE notification_rules IS
  'Event type -> channel, with conditions, a delivery class and quiet hours in the user''s zone. The digest *window* is not here: coalescing is the outbox''s job (08 §4.5).';
COMMENT ON COLUMN notification_rules.quiet_hours_start_minute IS
  'Minutes from local midnight in `timezone`. Wraps past midnight when start > end, which 22:00-07:00 does.';
COMMENT ON COLUMN notification_rules.delivery_class IS
  'P0_SAFETY delivers immediately and ignores quiet hours; PROMPT delivers but is held during them; DIGEST is coalesced into a window.';

-- ---------------------------------------------------------------------------
-- notification_outbox
-- ---------------------------------------------------------------------------

CREATE TABLE notification_outbox (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_id              UUID        NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  -- NULL for a "send test": a verification has no rule behind it. SET NULL
  -- rather than CASCADE on delete, because deleting a rule must not erase the
  -- history of what it already sent.
  rule_id                 UUID        REFERENCES notification_rules (id) ON DELETE SET NULL,
  dedupe_key              TEXT        NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  group_key               TEXT,
  group_window_start      TIMESTAMPTZ,
  group_window_end        TIMESTAMPTZ,
  -- How many facts this one row now stands for. 2,000 after a backfill.
  group_count             INTEGER     NOT NULL DEFAULT 1 CHECK (group_count >= 1),
  delivery_class          TEXT        NOT NULL
                                      CHECK (delivery_class IN ('P0_SAFETY', 'PROMPT', 'DIGEST')),
  priority                TEXT        NOT NULL DEFAULT 'normal'
                                      CHECK (priority IN ('low', 'normal', 'high')),
  title                   TEXT        NOT NULL CHECK (length(btrim(title)) > 0),
  body_md                 TEXT        NOT NULL,
  deep_link               TEXT,
  actions                 JSONB       NOT NULL DEFAULT '[]'
                                      CHECK (jsonb_typeof(actions) = 'array'),
  status                  TEXT        NOT NULL DEFAULT 'pending'
                                      CHECK (status IN (
                                        'pending', 'held', 'sending', 'delivered', 'failed', 'dead')),
  held_reason             TEXT        CHECK (held_reason IS NULL
                                             OR held_reason IN ('quiet_hours', 'digest_window')),
  attempt_count           INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts            INTEGER     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  -- The single knob the hold path and the backoff ladder both turn. A held
  -- notification is a pending one with a later `not_before`; nothing is deleted.
  not_before              TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_event_id         UUID,
  source_event_type       TEXT,
  correlation_id          UUID        NOT NULL,
  queued_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at            TIMESTAMPTZ,
  dead_at                 TIMESTAMPTZ,
  last_failure_code       TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_outbox_delivered_shape CHECK (
    (status = 'delivered') = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT notification_outbox_dead_shape CHECK (
    (status = 'dead') = (dead_at IS NOT NULL)
  ),
  CONSTRAINT notification_outbox_held_shape CHECK (
    (status = 'held') = (held_reason IS NOT NULL)
  ),
  CONSTRAINT notification_outbox_group_shape CHECK (
    (group_key IS NULL
      AND group_window_start IS NULL
      AND group_window_end IS NULL
      AND group_count = 1)
    OR (group_key IS NOT NULL
      AND group_window_start IS NOT NULL
      AND group_window_end IS NOT NULL
      AND group_window_end > group_window_start)
  ),
  CONSTRAINT notification_outbox_digest_is_grouped CHECK (
    delivery_class <> 'DIGEST' OR group_key IS NOT NULL
  )
);

-- At-most-once. The whole of 08 §4.5's "idempotent via dedupeKey".
CREATE UNIQUE INDEX notification_outbox_dedupe_idx ON notification_outbox (user_id, dedupe_key);
-- Coalescing, enforced by the outbox rather than by each rule.
CREATE UNIQUE INDEX notification_outbox_group_idx
  ON notification_outbox (user_id, channel_id, group_key, group_window_start)
  WHERE group_key IS NOT NULL;
-- The drain's claim query.
CREATE INDEX notification_outbox_due_idx
  ON notification_outbox (not_before, id) WHERE status IN ('pending', 'held');
-- The dead-letter view 08 §4.5 asks for.
CREATE INDEX notification_outbox_dead_idx
  ON notification_outbox (user_id, dead_at DESC) WHERE status = 'dead';
CREATE INDEX notification_outbox_user_queued_idx
  ON notification_outbox (user_id, queued_at DESC);

COMMENT ON TABLE notification_outbox IS
  'One row per notification that will be sent, at most once. Dedupe and digest coalescing are both UNIQUE indexes here, so no rule can forget either.';
COMMENT ON COLUMN notification_outbox.dedupe_key IS
  'Derived from the fact, not from the event id, so two events stating the same fact collide. UNIQUE per user.';
COMMENT ON COLUMN notification_outbox.group_count IS
  'Facts coalesced into this row. A 2,000-transaction backfill leaves one row with group_count = 2000.';
COMMENT ON COLUMN notification_outbox.not_before IS
  'Quiet-hours holds and delivery backoff both move this forward. Nothing on either path deletes a row.';

-- ---------------------------------------------------------------------------
-- delivery_attempts
-- ---------------------------------------------------------------------------

CREATE TABLE delivery_attempts (
  id                      UUID        PRIMARY KEY,
  user_id                 UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  notification_id         UUID        NOT NULL
                                      REFERENCES notification_outbox (id) ON DELETE CASCADE,
  attempt                 INTEGER     NOT NULL CHECK (attempt >= 1),
  channel_kind            TEXT        NOT NULL CHECK (channel_kind IN ('ntfy', 'smtp', 'fake')),
  outcome                 TEXT        NOT NULL
                                      CHECK (outcome IN (
                                        'delivered', 'retryable', 'permanent', 'refused')),
  -- Set exactly when the egress guard said no. This is the column the refusal
  -- matrix in the evidence note is built from, and it is why "we refused to
  -- connect" does not read like "their mail server was down".
  refusal_code            TEXT,
  http_status             INTEGER     CHECK (http_status IS NULL
                                             OR http_status BETWEEN 100 AND 599),
  -- A short, already-redacted description. Never a provider response body and
  -- never a URL with credentials in it.
  detail                  TEXT        CHECK (detail IS NULL OR length(detail) <= 500),
  duration_ms             INTEGER     CHECK (duration_ms IS NULL OR duration_ms >= 0),
  next_attempt_at         TIMESTAMPTZ,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT delivery_attempts_refusal_has_code CHECK (
    (outcome = 'refused') = (refusal_code IS NOT NULL)
  ),
  CONSTRAINT delivery_attempts_retryable_has_next CHECK (
    outcome <> 'retryable' OR next_attempt_at IS NOT NULL
  ),
  CONSTRAINT delivery_attempts_terminal_has_no_next CHECK (
    outcome = 'retryable' OR next_attempt_at IS NULL
  )
);

CREATE UNIQUE INDEX delivery_attempts_notification_attempt_idx
  ON delivery_attempts (notification_id, attempt);
CREATE INDEX delivery_attempts_user_idx ON delivery_attempts (user_id, created_at DESC);
CREATE INDEX delivery_attempts_refused_idx
  ON delivery_attempts (user_id, refusal_code) WHERE outcome = 'refused';

COMMENT ON TABLE delivery_attempts IS
  'Append-only, one row per attempt. Survives the notification reaching dead, which is what makes the dead-letter view worth opening.';
COMMENT ON COLUMN delivery_attempts.refusal_code IS
  'The egress guard''s verdict: host_not_allowed, scheme_not_allowed, literal_ip, private_address, port_not_allowed, redirect_not_followed, response_too_large, timeout, header_not_allowed, userinfo_in_url, dns_resolution_failed.';
COMMENT ON COLUMN delivery_attempts.outcome IS
  'refused = we would not connect. permanent = they refused us and will again. retryable = try later. Collapsing the first two would hide an SSRF attempt as a flaky mail server.';
