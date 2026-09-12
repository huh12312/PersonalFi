# WP 0.2 summary — SecretBox, KEK custody, passkeys, TOTP, sessions

Closes the security half of Phase 0: decisions **D5** (key custody) and **D21**
(authentication), and P0 items **1, 2, 4, 5, 12, 14** from the master plan §4.

Three companion files carry the detail; this one is the index, the decision
record, and the list of what is _not_ closed.

- [wp0.2-encryption-at-rest.md](wp0.2-encryption-at-rest.md) — envelope format, AAD, the literal P0-1 assertion
- [wp0.2-argon2-parameters.md](wp0.2-argon2-parameters.md) — the measurement behind m = 1 GiB, and the wasm32 ceiling
- [wp0.2-log-hygiene.md](wp0.2-log-hygiene.md) — the real-boot capture behind P0-12

---

## 1. The P0 checklist

| #      | Requirement                                                                                                                      | Status                     | Evidenced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Provider tokens, exchange keys, LLM keys encrypted app-layer before insert; a test reads the raw column and asserts no plaintext | **green, for what exists** | `packages/secretbox/test/secret-box.test.ts` — _"leaves no plaintext in the column (P0-1 evidence)"_ reads the `bytea` back through the driver **and** through `encode(col,'escape')` (what `psql` prints), asserting absence in UTF-8 and Latin-1, whole and in 8-character fragments. `packages/contexts/identity/test/totp.test.ts` — _"seals the seed before it touches the database (P0-1)"_ does the same at a real call site. See §5.                                                                                                                                                            |
| **2**  | KEK never in env or cleartext on disk; Argon2id m ≥ 1 GiB, t = 4, p = 4                                                          | **green (app side)**       | `packages/config/src/load.test.ts` — _"the KEK Argon2id floor (P0-2)"_: the production floor is enforced at `loadConfig`, every sub-floor parameter is reported at once, and `master_key` has **no** `envFallback` and is fatal when absent. `packages/secretbox/src/kek.test.ts` re-checks the floor inside `SecretBox` and asserts the key is zeroed on `destroy()`/`lock()`/rotation. Measured cost: `docs/evidence/phase-0/wp0.2-argon2-parameters.md`. Container-side (`docker inspect`, `/proc/<pid>/environ`) is WP 0.4 — see §5.                                                                |
| **4**  | Passkeys working, ≥ 2 authenticators, 10 recovery codes                                                                          | **green**                  | `packages/contexts/identity/test/webauthn.test.ts` (23 cases) registers and authenticates against a **real** ES256 software authenticator — real CBOR, real COSE, real DER signatures, verified by `@simplewebauthn/server`, not a stub. _"refuses to remove the last passkey"_ and _"removes a credential once a second one exists"_ pin the ≥ 2 rule. `test/auth-flows.test.ts` — _"mints ten legible single-use codes, hashed at rest"_, _"spends a recovery code exactly once, however the user types it"_.                                                                                         |
| **5**  | Session cookie attributes asserted by test; refresh reuse kills the session family                                               | **green**                  | `apps/api/test/cookies.test.ts` (5 cases) asserts the attributes on the **issuing** path — `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, `Max-Age` on refresh only. `apps/api/test/csrf.test.ts` asserts them on the clearing path and names the `__Host-` prefix. `packages/contexts/identity/test/sessions.test.ts` — _"kills the whole family when a rotated refresh token is replayed"_, _"leaves other families alone when one is burned down"_, _"treats a revoked generation's refresh token as reuse, not expiry"_; `POST /auth/refresh` also drops the cookies on detection. |
| **12** | No token or account number in logs                                                                                               | **green, for what exists** | `apps/api/test/db/log-hygiene.test.ts` (9 cases) spawns `main.ts` as a real child process, drives the enrolment token through a real request, `SIGTERM`s it and greps the captured stdout+stderr. Detail in [wp0.2-log-hygiene.md](wp0.2-log-hygiene.md). The sandbox-sync half waits on Phase 1 — see §5.                                                                                                                                                                                                                                                                                              |
| **14** | Rate limiting and lockout on auth endpoints, persisted across restart                                                            | **green**                  | `packages/contexts/identity/test/rate-limit.test.ts` (16 cases). _"keeps the count when the process restarts (P0-14)"_ spreads five attempts over five separate `RateLimiter` instances — if the counter were in memory each would start from zero — and _"keeps the lockout across a restart"_ does the same for the lockout. A fake here would be exactly the in-memory limiter the control forbids. Also: exponential backoff capped at 24 h, lockout checked before the counter, and an operator release path.                                                                                      |

### Test counts at close

| Project        | Files | Tests | Needs Postgres |
| -------------- | ----- | ----- | -------------- |
| `secretbox`    | 2     | 33    | no             |
| `secretbox-db` | 1     | 24    | yes            |
| `identity`     | 2     | 12    | no             |
| `identity-db`  | 5     | 98    | yes            |
| `api`          | 3     | 25    | no             |
| `api-db`       | 1     | 9     | yes            |
| **total**      | 14    | 201   |                |

Plus `config` (19), which grew the P0-2 floor cases.

```bash
just db-up
DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_wp02 \
  pnpm exec vitest run --project secretbox --project secretbox-db \
    --project identity --project identity-db --project api --project api-db
```

The `*-db` projects each create and drop their own scratch database and skip
themselves entirely when `DATABASE_URL` is unset, so `pnpm test` still works on a
laptop with nothing running.

---

## 2. The Argon2id decision

**m = 1 GiB, t = 4, p = 4, enforced as a floor that follows `NODE_ENV`.**

The measurement, the wasm32 ceiling at 1.75 GiB, and why `hash-wasm` beat
`@node-rs/argon2` and `@noble/hashes` are in
[wp0.2-argon2-parameters.md](wp0.2-argon2-parameters.md). Three things belong
here because they are decisions rather than numbers:

1. **The floor is selected from `NODE_ENV`, never from a setting of its own.** A
   `KEK_RELAX_KDF` flag is a flag that gets flipped in production at 02:00 to make
   a restart faster and then stays flipped. The development floor (8 MiB, t = 2,
   p = 1) is unreachable when `NODE_ENV=production`.
2. **The defaults do not follow `NODE_ENV` — only the floor does.** A developer
   who sets nothing pays the full 6–8 s, so nobody meets the production cost for
   the first time inside a container.
3. **The cost is paid once per boot, not once per login.** That is why the OWASP
   password-storage minimum (19 MiB) is the wrong reference: it is tuned for
   thousands of logins per second, and this derivation happens on `docker compose
up`.

Measured on the dev box during this close, at the shipped defaults:

```
$ DATABASE_URL=…/personalfi_wp02 SECRETS_DIR=… just bootstrap-user name="Chris" timezone="America/New_York"
user created      Chris (01a096b6-345a-71bf-a11a-ba68be59ea22)
time zone         America/New_York
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 8610 ms · KEK generation 1
```

---

## 3. Custody, and the one place a secret is printed

`just bootstrap-user` is the only way into a box with no credentials (D21, P0-4).
It creates the `users` row, **then derives the KEK** — so a missing or wrong
`master_key` is discovered at a prompt with an operator watching rather than at
03:15 mid-sync — and only then mints the one-time enrolment token:

```
Enrol your first passkey within 60 minutes:

  http://127.0.0.1:8080/enrol#token=[REDACTED-BOOTSTRAP-TOKEN]

  token only: [REDACTED-BOOTSTRAP-TOKEN]
  expires:    2026-09-12T18:42:07.181Z
```

Verified against `personalfi_wp02` during this close:

| Claim                                 | Observed                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Stored only as a digest               | `registration_tokens.token_hash` = `2e8204b1e6df…c40944`, which is exactly `sha256(token)`. Nothing recoverable survives in the DB. |
| Expires in an hour                    | `expires_at` − `created_at` = 3600 s                                                                                                |
| Single account holder                 | A second `just bootstrap-user` exits non-zero: _"A user already exists… Pass reissue=true"_                                         |
| The token reaches no log              | `apps/api/test/db/log-hygiene.test.ts` — _"keeps the bootstrap token out of the API log even though the command printed it"_        |
| The event records ids and counts only | `security_events` row: `{"reissue": false, "expiresAt": "…"}`                                                                       |

The token travels in the URL **fragment**, which a browser never sends to a
server — so it cannot reach Caddy's access log, a `Referer` header, or a proxy
cache the way a query parameter would.

On shutdown, `apps/api/src/main.ts` calls `security.destroy()` from the
`SIGTERM`/`SIGINT` handler **after** `app.close()` has drained in-flight
requests, zeroing the KEK and every cached DEK (P0-2).

---

## 4. Libraries

Every direct dependency this package added is **MIT**, matching the project
licence. Full transitive inventory: `THIRD_PARTY.md`.

| Package                  | Version | Licence | Why it, and not the alternative                                                                                                                                                                                             |
| ------------------------ | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hash-wasm`              | 4.12.0  | MIT     | Argon2id. Not `@node-rs/argon2` (a native addon: breaks the musl story for the Alpine image and cannot be audited from the lockfile). Not `@noble/hashes`' Argon2 (~10× slower at 1 GiB, turning a 6 s boot into a minute). |
| `@noble/ciphers`         | 2.4.0   | MIT     | XChaCha20-Poly1305. Audited, zero-dependency, pure JS.                                                                                                                                                                      |
| `@noble/hashes`          | 2.4.0   | MIT     | SHA-256 and HKDF for token digests and DEK derivation.                                                                                                                                                                      |
| `@simplewebauthn/server` | 14.0.0  | MIT     | WebAuthn registration and assertion verification. The reference implementation; a hand-rolled COSE/CBOR verifier is not a thing to hand-roll.                                                                               |
| `otpauth`                | 9.5.2   | MIT     | RFC 6238 TOTP. Verified against the RFC's own Appendix B vectors rather than trusted — `test/totp.test.ts`.                                                                                                                 |
| `@fastify/cookie`        | 11.1.2  | MIT     | Cookie parsing and serialisation. Registered **without a secret**: the session cookie is an opaque 256-bit token whose authority is a row, and signing it would add a second key to protect for no gain.                    |

**Not used, deliberately:** `pgcrypto` (the key would transit the wire protocol,
sit in server memory, and land in `pg_stat_statements`); `bcrypt`/`scrypt` for the
KEK (Argon2id is the current recommendation and the memo's choice); any native
addon anywhere on this path (D13, R7).

The cryptography chokepoint is mechanised: exactly one file —
`packages/secretbox/src/primitives.ts` — may import a cipher, a KDF, a hash or
`node:crypto`. Enforced twice, by `personalfi/layer-imports` and by a
`no-restricted-imports` override in `eslint.config.js`, **including in tests**.
The failure this prevents is not a broken cipher; it is the second call site that
reuses a nonce, drops the AAD, or compares a tag with `===`.

---

## 5. Deviations and what is not closed

### `__Host-` beats path-scoping the refresh cookie — deliberate

03 §3.4 asks for the refresh cookie at `Path=/api/auth/refresh`. `__Host-`
requires `Path=/`. The two cannot both be had, and **`__Host-` wins**: P0-5 names
it explicitly, and path scoping only narrows which of _our own_ requests carry the
cookie — it does not stop another origin from reaching it, whereas `__Host-` does.
The lost defence in depth is bought back by `SameSite=Strict`, the `Origin`
allow-list, and refresh reuse detection. Recorded at the top of
`apps/api/src/auth/cookies.ts`, where anyone changing it will read it first.

### Argon2: `hash-wasm`, not `@node-rs/argon2`

Master plan §3 R7 names `@node-rs/argon2` as the mitigation for the Alpine/musl
risk. WP 0.2 went the other way and removed the native module entirely; the
reasoning is in §4 above and in
[wp0.2-argon2-parameters.md](wp0.2-argon2-parameters.md). The consequence is the
wasm32 memory ceiling of 1.75 GiB, which is enforced at boot rather than
discovered as a `TypedArray` error during a restart.

### Scope: key loss = re-link providers, never = lose the ledger (D5)

Only credentials are sealed in Phase 0. Bulk encryption of memo and description
columns is P2. The `epoch` key policy exists _now_ precisely so that adding it
later is a backfill rather than a schema migration.

### Carried forward

| Item                                                         | Owner                                                                                                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1**, provider tokens specifically                       | No connector exists until Phase 1. The mechanism, the policy (`record`) and the P0-1 assertion are in place and exercised against `totp_secrets`; the Plaid access token is the same call site. |
| **P0-2**, `docker inspect` / `/proc/<pid>/environ` clean     | WP 0.4. The app-side guarantee — `master_key` is a file secret with no `envFallback`, asserted in `load.test.ts` — is what makes the container-side check possible to pass.                     |
| **P0-12**, captured sandbox-sync logs                        | Phase 1. `apps/api/test/db/log-hygiene.test.ts` is where the transcript belongs; the boot-path half is closed.                                                                                  |
| **P0-12**, account numbers                                   | `REDACTED_PATHS` already covers `account_number`, `routing_number`, `iban` and friends, but nothing produces one yet.                                                                           |
| Step-up for Plaid Item add/remove, credential reads, exports | `requireFreshSession` exists and guards the auth settings themselves (P1-2); the other call sites arrive with their features.                                                                   |

---

## 6. Schema

**Migration `0002_identity.sql`** — ten tables, owned by two packages:

| Package           | Tables                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@core/secretbox` | `encryption_keys`                                                                                                                                                       |
| `@ctx/identity`   | `webauthn_credentials`, `webauthn_challenges`, `totp_secrets`, `recovery_codes`, `registration_tokens`, `sessions`, `auth_attempts`, `auth_lockouts`, `security_events` |

`users` lives in `0001_initial.sql` and is claimed by `@ctx/identity`.
`node scripts/check-schema-ownership.ts` verifies that every table is claimed by
exactly one package and that every claimed table exists.

Constraints worth naming, because they are the control rather than a detail:

- `encryption_keys_kek_has_kdf` — a `kek` row must carry a salt and params, a
  `dek`/`epoch` row must not. The keyring cannot hold a half-described key.
- `registration_tokens_token_hash_check` — `length(token_hash) = 32`, so a column
  holding a raw token instead of a digest fails on insert.
- `encryption_keys_salt_check` — `length(salt) = 32`.
