-- SPDX-License-Identifier: MIT
-- 0002_identity: key custody, passkeys, TOTP, recovery codes, sessions,
--                rate limiting, lockout, and the security event log.
--
-- Forward-only. Immutable once merged: the runner checksums this file.
-- Destructive changes use expand -> backfill -> contract across releases.
--
-- Owners: `encryption_keys` belongs to @core/secretbox (the cryptography
-- chokepoint); everything else belongs to @ctx/identity. No `pgcrypto`: every
-- ciphertext in this schema is produced in the application, so the database never
-- sees a key (03 §2.1, §6.1).

-- ---------------------------------------------------------------------------
-- users: the column WP 0.1 flagged.
-- ---------------------------------------------------------------------------
--
-- Every period boundary in the app -- budget months, "today", digest windows, the
-- daily snapshot seal -- is computed in the user's zone, never the container's
-- TZ (04 §2.4). Without this column the first budget month boundary silently
-- becomes UTC's.
ALTER TABLE users
  ADD COLUMN display_timezone TEXT NOT NULL DEFAULT 'UTC'
    CHECK (length(btrim(display_timezone)) > 0 AND display_timezone !~ '[|]');

COMMENT ON COLUMN users.display_timezone IS
  'IANA zone, e.g. America/Los_Angeles. Validated in the application against Intl; Postgres has no IANA type.';

-- ---------------------------------------------------------------------------
-- encryption_keys: the keyring. Owner: @core/secretbox.
-- ---------------------------------------------------------------------------
--
-- One table, three kinds of row (03 §2.4 -- "build the keyring on day one;
-- retrofitting it is a migration nightmare"):
--
--   kind='kek'    scope='kek'                 wrapped_key = a sealed constant used
--                                             only to verify the passphrase;
--                                             salt and params are set.
--   kind='dek'    scope='<table>:<row uuid>'  a per-record DEK sealed under the KEK.
--   kind='epoch'  scope='<table>.<column>'    a bulk DEK sealed under the KEK,
--                                             rotated by bumping version.
--
-- The KEK itself is never stored in any form.
CREATE TABLE encryption_keys (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('kek', 'dek', 'epoch')),
  scope       TEXT        NOT NULL CHECK (length(scope) > 0),
  version     INTEGER     NOT NULL CHECK (version >= 1),
  -- Storage envelope: version(1) || key_id(16) || nonce(24) || ciphertext+tag.
  -- Zero length is the crypto-shredded state left by destroying a record key.
  wrapped_key BYTEA       NOT NULL,
  kek_version INTEGER     NOT NULL CHECK (kek_version >= 1),
  salt        BYTEA       CHECK (salt IS NULL OR length(salt) = 32),
  params      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ,
  -- A KEK row is useless without its salt and parameters; a DEK row must not
  -- carry them, because a DEK is not derived from anything.
  CONSTRAINT encryption_keys_kek_has_kdf CHECK (
    (kind = 'kek' AND salt IS NOT NULL AND params IS NOT NULL)
    OR (kind <> 'kek' AND salt IS NULL AND params IS NULL)
  )
);

CREATE UNIQUE INDEX encryption_keys_scope_version_key
  ON encryption_keys (user_id, kind, scope, version);

-- The hot path: "which key opens this scope right now?".
CREATE INDEX encryption_keys_active_scope_idx
  ON encryption_keys (user_id, kind, scope, version DESC)
  WHERE retired_at IS NULL;

COMMENT ON TABLE encryption_keys IS
  'Envelope-encryption keyring: KEK generations, per-record DEKs, epoch DEKs. Owner: @core/secretbox.';
COMMENT ON COLUMN encryption_keys.wrapped_key IS
  'Self-describing envelope: version(1)||key_id(16)||nonce(24)||ciphertext+tag. XChaCha20-Poly1305.';

-- ---------------------------------------------------------------------------
-- webauthn_credentials: passkeys. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- 03 §3.2: resident keys, userVerification required, attestation none, ES256 and
-- EdDSA only. Two credentials minimum -- one passkey on one phone is a
-- self-inflicted denial of service -- which the API nags about rather than
-- enforcing in SQL, because a CHECK that blocks enrolling the *first* credential
-- would be a delightful bootstrap deadlock.
CREATE TABLE webauthn_credentials (
  id               UUID        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id    BYTEA       NOT NULL UNIQUE,
  public_key       BYTEA       NOT NULL,
  -- Authenticator signature counter. A counter that goes backwards means a cloned
  -- authenticator; the application refuses the assertion and logs it.
  sign_count       BIGINT      NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports       TEXT[]      NOT NULL DEFAULT '{}',
  aaguid           TEXT,
  backup_eligible  BOOLEAN     NOT NULL DEFAULT false,
  backed_up        BOOLEAN     NOT NULL DEFAULT false,
  device_type      TEXT        NOT NULL DEFAULT 'singleDevice'
                               CHECK (device_type IN ('singleDevice', 'multiDevice')),
  friendly_name    TEXT        NOT NULL CHECK (length(btrim(friendly_name)) > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ
);

CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);

COMMENT ON TABLE webauthn_credentials IS
  'Enrolled passkeys. Public keys only -- there is no shared secret to steal. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- webauthn_challenges: one-shot challenges. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- Server-side rather than in a signed cookie: a challenge must be single-use, and
-- single-use is a DELETE, not a cookie attribute. user_id is nullable because a
-- discoverable-credential login starts before we know who is logging in -- which
-- is the point of usernameless auth for a one-user app.
CREATE TABLE webauthn_challenges (
  id         UUID        PRIMARY KEY,
  user_id    UUID        REFERENCES users (id) ON DELETE CASCADE,
  challenge  TEXT        NOT NULL CHECK (length(challenge) >= 16),
  purpose    TEXT        NOT NULL CHECK (purpose IN ('registration', 'authentication', 'step_up')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges (expires_at);

COMMENT ON TABLE webauthn_challenges IS
  'Pending WebAuthn challenges, single-use and short-lived. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- totp_secrets: the secondary factor. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- 03 §3.3: RFC 6238, SHA-1 for authenticator-app compatibility, 6 digits, 30 s,
-- +/-1 step skew. The seed is a credential and is sealed with SecretBox like any
-- other (P0-1 applies to it): the column is BYTEA holding an envelope, never text.
-- `last_used_step` kills replay of a code inside its own window.
CREATE TABLE totp_secrets (
  id             UUID        PRIMARY KEY,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sealed_secret  BYTEA       NOT NULL,
  digits         SMALLINT    NOT NULL DEFAULT 6 CHECK (digits BETWEEN 6 AND 8),
  period_seconds SMALLINT    NOT NULL DEFAULT 30 CHECK (period_seconds BETWEEN 15 AND 120),
  algorithm      TEXT        NOT NULL DEFAULT 'SHA1' CHECK (algorithm IN ('SHA1', 'SHA256', 'SHA512')),
  last_used_step BIGINT,
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live TOTP enrolment per user. An unconfirmed one may sit beside it while
-- the QR code is on screen.
CREATE UNIQUE INDEX totp_secrets_confirmed_key
  ON totp_secrets (user_id) WHERE confirmed_at IS NOT NULL;

COMMENT ON TABLE totp_secrets IS
  'TOTP enrolment. sealed_secret is a SecretBox envelope, never a readable seed. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- recovery_codes: the break-glass path. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- Ten single-use codes, Argon2id-hashed, shown exactly once (03 §3.2). Without
-- them a lost phone means rebuilding from backup.
CREATE TABLE recovery_codes (
  id         UUID        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT        NOT NULL CHECK (code_hash LIKE '$argon2id$%'),
  -- Groups the ten codes minted together, so regenerating replaces a whole set.
  batch_id   UUID        NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX recovery_codes_unused_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

COMMENT ON TABLE recovery_codes IS
  'Single-use recovery codes, Argon2id-hashed. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- registration_tokens: first-passkey enrolment. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- `just bootstrap-user` mints one and prints a link. It is the only way to enrol
-- a credential on a box with no credentials, so it is single-use, short-lived,
-- and hashed at rest like any other bearer token.
CREATE TABLE registration_tokens (
  id         UUID        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash BYTEA       NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

COMMENT ON TABLE registration_tokens IS
  'One-time passkey-enrolment tokens. SHA-256 of the token, never the token. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- sessions: opaque server-side sessions with refresh rotation. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- Opaque tokens, not JWTs (03 §3.4): a single-user app has zero need for
-- stateless verification, and server-side sessions give instant revocation.
--
-- One row per *generation*. A refresh rotates: the presented row is stamped
-- `superseded_by` and a new row joins the same `family_id`. Presenting a refresh
-- token whose row is already superseded or revoked is the cookie-theft signal, and
-- kills the whole family. That is why generations are rows rather than an
-- UPDATE -- an UPDATE would destroy the evidence that detection depends on.
CREATE TABLE sessions (
  id                  UUID        PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id           UUID        NOT NULL,
  -- SHA-256 of the bearer token. The raw token exists only in the cookie.
  access_token_hash   BYTEA       NOT NULL UNIQUE CHECK (length(access_token_hash) = 32),
  refresh_token_hash  BYTEA       NOT NULL UNIQUE CHECK (length(refresh_token_hash) = 32),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 15 min idle, bumped on each authenticated request.
  idle_expires_at     TIMESTAMPTZ NOT NULL,
  -- 8 h absolute for this generation, never extended past family_expires_at.
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  -- The family's hard stop: 8 h, or 14 days for an explicitly trusted device.
  family_expires_at   TIMESTAMPTZ NOT NULL,
  trusted_device      BOOLEAN     NOT NULL DEFAULT false,
  -- Step-up: set by a fresh WebAuthn assertion, five minutes of privilege.
  fresh_until         TIMESTAMPTZ,
  auth_method         TEXT        NOT NULL
                                  CHECK (auth_method IN ('webauthn', 'totp', 'recovery_code', 'bootstrap')),
  superseded_by       UUID        REFERENCES sessions (id) ON DELETE SET NULL,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT,
  ip                  INET,
  -- Hashed, not stored: the UA string is a fingerprint and belongs in no log.
  user_agent_hash     BYTEA       CHECK (user_agent_hash IS NULL OR length(user_agent_hash) = 32)
);

CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_user_live_idx ON sessions (user_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE sessions IS
  'Opaque sessions. One row per refresh generation; reuse of a superseded refresh token kills the family. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- auth_attempts: rate limiting that survives a restart. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- In Postgres, not in memory (03 §3.4, P0-14): an in-memory counter resets on
-- restart, and "restart the container" is a trivially exploitable bypass on a box
-- the attacker can already reach. Fixed windows, one row per (bucket, subject,
-- window) -- a sliding-window log would be more accurate and would also mean a
-- row per request, which is the wrong trade for one user.
CREATE TABLE auth_attempts (
  bucket       TEXT        NOT NULL CHECK (length(bucket) > 0),
  -- The rate-limit subject: an IP, or 'user:<uuid>'. Never a credential.
  subject      TEXT        NOT NULL CHECK (length(subject) > 0),
  window_start TIMESTAMPTZ NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  user_id      UUID        REFERENCES users (id) ON DELETE CASCADE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, subject, window_start)
);

CREATE INDEX auth_attempts_window_idx ON auth_attempts (window_start);

COMMENT ON TABLE auth_attempts IS
  'Persistent fixed-window rate-limit counters. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- auth_lockouts: consecutive-failure lockout. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- Ten consecutive failures -> 15 minutes, doubling, capped at 24 h (03 §3.4). The
-- cap matters: a permanent lockout on a single-user self-hosted app is a
-- self-inflicted denial of service with no support desk to call.
CREATE TABLE auth_lockouts (
  bucket               TEXT        NOT NULL CHECK (length(bucket) > 0),
  subject              TEXT        NOT NULL CHECK (length(subject) > 0),
  consecutive_failures INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  lock_level           INTEGER     NOT NULL DEFAULT 0 CHECK (lock_level >= 0),
  locked_until         TIMESTAMPTZ,
  user_id              UUID        REFERENCES users (id) ON DELETE CASCADE,
  first_failure_at     TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, subject)
);

COMMENT ON TABLE auth_lockouts IS
  'Consecutive-failure lockout with exponential backoff, capped. Survives restart. Owner: @ctx/identity.';

-- ---------------------------------------------------------------------------
-- security_events: the audit trail. Owner: @ctx/identity.
-- ---------------------------------------------------------------------------
--
-- Written from one helper so that "was this logged?" has a single answer (P1-10).
-- `detail` is JSONB and is the one place a future field could smuggle a secret
-- into storage; the writer strips anything credential-shaped before it lands here.
CREATE TABLE security_events (
  id              UUID        PRIMARY KEY,
  user_id         UUID        REFERENCES users (id) ON DELETE SET NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT        NOT NULL CHECK (length(kind) > 0),
  outcome         TEXT        NOT NULL CHECK (outcome IN ('success', 'failure', 'blocked')),
  detail          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip              INET,
  user_agent_hash BYTEA       CHECK (user_agent_hash IS NULL OR length(user_agent_hash) = 32),
  correlation_id  TEXT
);

CREATE INDEX security_events_occurred_idx ON security_events (occurred_at DESC);
CREATE INDEX security_events_kind_idx ON security_events (kind, occurred_at DESC);

COMMENT ON TABLE security_events IS
  'Auth, lockout, credential lifecycle, step-up and session revocation events. Owner: @ctx/identity.';
