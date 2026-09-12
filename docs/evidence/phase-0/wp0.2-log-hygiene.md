# WP 0.2 evidence — no secret in a log line

**P0 item 12** (master plan §4): _"No token or account number in logs; CI test
greps captured sandbox-sync logs."_

Phase 0 has no sync yet, so the equivalent surface is a real boot with a real
passphrase and a real one-time enrolment token.

## The test

`apps/api/test/db/log-hygiene.test.ts` (project `api-db`) **spawns
`apps/api/src/main.ts` as a child process** against a scratch database, captures
its stdout and stderr, drives traffic through it, sends `SIGTERM`, and greps
everything it printed.

Spawning rather than building the app in-process is the test, not an
inconvenience:

- the leak this control exists to prevent is a secret reaching _the log_, and the
  log is a file descriptor, not an object a test can substitute;
- `main.ts` is where the passphrase is handled — read from a file, revealed once,
  fed to Argon2id — and an in-process harness skips exactly the file where a
  `console.log(config)` would do the damage;
- the same run produces the other half of P0-2's evidence, the startup line
  showing the KDF parameters and duration.

Both secrets are deliberately distinctive strings
(`pfi-log-hygiene-kek-Zq7Z4rW2xN8vB1kD6mH0-do-not-use`, and a 43-character
base64url enrolment token), so a negative assertion cannot pass by accident.

### Traffic the boot is subjected to

| Request                                                                     | Why                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                               | The ordinary line                                                                                                |
| `GET /auth/unlock-state`                                                    | Mints the CSRF cookie; reports key custody                                                                       |
| `POST /auth/register/options` with the **real** enrolment token in the body | The token travels in a request body, is redeemed, and produces a WebAuthn challenge — three chances to be logged |
| `POST /auth/login/verify` with a junk assertion                             | The failure path, where error objects get logged                                                                 |
| `GET /ready`                                                                | Touches the database                                                                                             |
| `SIGTERM`                                                                   | Shutdown, which is where the KEK is zeroed                                                                       |

### Assertions

| Assertion                                                                                                                       | Guards against                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The capture contains `configuration loaded`, `Server listening at`, `/auth/register/options` and `shutting down`, and is > 2 KB | A vacuous pass against an empty log                                                             |
| The KEK passphrase is absent — whole, and in every 12-character fragment                                                        | A truncating logger                                                                             |
| The enrolment token is absent — whole, and in its first 16 characters                                                           | The body-logging that request loggers do by default                                             |
| No `postgres://` URL and no literal `DATABASE_URL` appears                                                                      | The database password; `DATABASE_URL` is stripped from the public config object by construction |
| No `"cookie"`, `"set-cookie"` or `__Host-pfi_csrf=` appears                                                                     | Session tokens via header logging                                                               |
| `secretsPresent` lists `master_key` and `database_url` **by name only**                                                         | "Is the passphrase mounted?" must still be answerable                                           |
| `key custody: unlocked`, `"kdf":"argon2id"`, `memoryKiB`, `timeCost`, `durationMs`, `kekVersion` are present                    | P0-2's _"startup log shows KDF params and duration"_                                            |
| A `correlationId` UUID appears on request lines                                                                                 | An unreconstructable failure at 03:15                                                           |
| The bootstrap command's own stdout **does** contain the token, and the API log does not                                         | That the one-time print is by design, and confined to it                                        |

## Why it holds

Four independent mechanisms, in the order a secret would meet them:

1. **`Redacted<T>` (`@core/config`).** A secret is boxed at load and only
   `reveal()` unwraps it. `master_key` is revealed in exactly one place —
   `SecurityRuntime.#doInitialise`, straight into the KDF — and is never assigned
   to a field, never placed on `config`, and never returned.
2. **`DATABASE_URL` is removed from the public config object.** `describeConfig`
   cannot print it because it is not there; `PublicEnvironmentConfig` omits it at
   the type level.
3. **The pino request serialiser** keeps only `id`, `method`, `url` and two
   headers (`host`, `user-agent`). No body, no cookies, no `authorization`.
4. **`REDACTED_PATHS` (`apps/api/src/logging.ts`)** is the second line of defence:
   ~35 credential- and PII-shaped paths censored at any depth, asserted by
   `apps/api/test/app.test.ts`.

And in the database, the same posture: `security_events.detail` is scrubbed
against a deliberately over-broad deny-list before insert
(`packages/contexts/identity/src/security-events.ts`), because a JSONB column is
the one place a future field could smuggle a token into storage that is not
envelope-encrypted — and unlike a log line, it is never rotated away. The user
agent is stored as a SHA-256 digest, never as a string.

## The one place a secret is printed

`just bootstrap-user` prints the enrolment token to stdout, once. That is the
whole design: it is stored only as a SHA-256 digest, so a leaked database dump
contains no working link, and the operator running the command on the host is the
trust boundary. The token travels in the URL **fragment**
(`.../enrol#token=…`), which a browser never sends to a server — so it cannot
land in Caddy's access log, in a `Referer` header, or in a proxy cache the way a
query parameter would.

## Reproducing

```bash
just db-up
DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_wp02 \
  pnpm exec vitest run --project api-db
```

## Not yet covered

- **Provider sync logs.** There is no connector until Phase 1. The same test file
  is where a captured Plaid sandbox sync transcript belongs, and P0-12 is not
  fully closed until it is there.
- **Account numbers.** `REDACTED_PATHS` already covers `account_number`,
  `routing_number`, `iban` and friends, but nothing produces one yet, so the
  assertion above is about tokens only.
