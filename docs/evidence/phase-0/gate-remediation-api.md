# Phase 0 gate remediation — API and identity

Remediation of the API/identity findings from
[`gate-security-review.md`](gate-security-review.md): **P0-10** (§2.8), **P0-4**
(§2.4), **H-3**, **M-1**, **M-4**, plus the OpenAPI `servers` defect the web
audit found and a new Argon2-versus-cgroup boot check.

Scope owned here: `apps/api/**`, `packages/config/**`,
`packages/contexts/identity/**`, `packages/secretbox/**`,
`packages/contracts/**`, `.gitleaksignore`. Infrastructure (compose, Caddy,
`justfile`, RUNBOOK) and `apps/web` were remediated concurrently by other agents
and are reported separately.

Every fix below was verified to **fail before and pass after**, by restoring the
`HEAD` version of the source file and re-running the new test. Those transcripts
are quoted per finding.

---

## Summary

| Finding           | Status | Guarding test                                                                                                                                                        |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-10             | Fixed  | `apps/api/test/evidence-hygiene.test.ts` — _"finds no token in any committed markdown"_                                                                              |
| P0-4              | Fixed  | `packages/config/src/load.test.ts` — _"the passkey configuration boot check (P0-4)"_ (8 cases) + `packages/contexts/identity/test/webauthn-config.test.ts` (6 cases) |
| H-3               | Fixed  | `apps/api/test/log-redaction.test.ts` (12 cases)                                                                                                                     |
| M-1               | Fixed  | `apps/api/test/app.test.ts` — _"trustProxy is a hop count, not a blanket trust (M-1)"_ (4 cases)                                                                     |
| M-4               | Fixed  | `packages/contexts/identity/test/refresh-concurrency.test.ts` (6 cases)                                                                                              |
| OpenAPI `servers` | Fixed  | `apps/api/test/app.test.ts` — _"serves the OpenAPI document with a relative server URL"_                                                                             |
| Argon2 vs memory  | Added  | `packages/config/src/memory.test.ts` (11 cases)                                                                                                                      |

Two defects were found **in the remediation itself** while verifying it, and are
written up in §8 because both are more instructive than the fixes.

---

## 1. P0-10 — the committed enrolment token

**Finding.** `docs/evidence/phase-0/wp0.2-summary.md:96,98` carried a live
single-use bootstrap enrolment token. gitleaks reported 4 findings at `HEAD`.

**Fix, three parts.**

_Working tree._ Both occurrences replaced with
`EXAMPLE-ENROLMENT-TOKEN-REDACTED-NOT-A-REAL-VALUE`, plus a note in the document
explaining what was removed and why, so the redaction does not read as a typo.

_The credential itself._ The token was minted against the scratch database
`personalfi_wp02` and had never been redeemed:

```
$ docker exec personalfi-dev-db-1 psql -U personalfi -d personalfi_wp02 \
    -tAc "SELECT id, expires_at, used_at FROM registration_tokens ORDER BY created_at"
01a096b6-564d-77e8-a361-bfaf566516a5|2026-09-12 18:42:07.181+00|
                                     ^ expiry matches the leaked token   ^ used_at IS NULL
```

Dropped and recreated, so the row the token would be validated against no longer
exists in any database:

```
$ docker exec ... psql -c "DROP DATABASE personalfi_wp02 WITH (FORCE)"   DROP DATABASE
$ docker exec ... psql -c "CREATE DATABASE personalfi_wp02 OWNER personalfi"  CREATE DATABASE
$ docker exec ... psql -d personalfi_wp02 -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
0
```

_History._ `git filter-repo` is **not installed** on this machine
(`git: 'filter-repo' is not a git command`), so the two historical occurrences
are recorded as commit-pinned fingerprints in `.gitleaksignore`, under a comment
that states plainly that they are **true positives, remediated** — not false
positives — and why the value is dead. There is no remote and nothing has ever
been pushed, so the history is still local and cheap to rewrite; installing
`filter-repo` and scrubbing before first push remains the preferred endgame and
is flagged as deferred (§9).

The two pre-existing findings (`csrf.test.ts:45`, `secret-box.test.ts:25`) are
genuine false positives — a test fixture constant and a deliberately
Plaid-shaped fixture whose shape is the point of the P0-1 assertion — and got
reviewed fingerprints with stated reasons, as the file's own header requires.

**Result — run byte-identical to `.github/workflows/ci.yml:168-171`:**

```
$ docker run --rm -v "$PWD:/repo" -w /repo \
    zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9 \
    detect --source . --redact --exit-code 1 -i .gitleaksignore
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

2:53AM INF 31 commits scanned.
2:53AM INF scanned ~2829249 bytes (2.83 MB) in 1.8s
2:53AM INF no leaks found
EXIT=0
```

**The test, and why it is not just a second gitleaks.** gitleaks caught the
enrolment token but **missed a second live value** in the tree — a real
`__Host-pfi_csrf` cookie in `gate-security-review.md:187` — because gitleaks
matches rules about _providers_, and these are the application's own tokens.
`apps/api/test/evidence-hygiene.test.ts` detects the shape this codebase actually
mints (32 random bytes, base64url, 43 chars) _adjacent to a credential word_.

Shape alone is not enough: a support-article URL slug in
`docs/research/01-aggregation-plaid.md` matches it exactly, and entropy does not
separate them (the slug scores 4.19 bits/char against a measured floor of 4.10
for real tokens over 200 000 samples). Requiring a nearby credential word
(`token`, `set-cookie`, `bearer`, …) gives zero false positives in this
repository and flags all four real occurrences.

**Fails before / passes after:**

```
$ git show HEAD:docs/evidence/phase-0/wp0.2-summary.md      | detector -> flagged 2
$ git show HEAD:docs/evidence/phase-0/gate-security-review.md | detector -> flagged 2
$ working tree -> 0
```

---

## 2. P0-4 — passkeys silently enrolling nothing

**Finding.** `AUTH_RP_ID=localhost` / `AUTH_ALLOWED_ORIGINS=http://localhost:8080`
on a stack serving `https://personalfi.lan`. Both defaulted; compose set neither.
CSRF 403'd every mutation from the real origin, and `localhost` is not a
registrable suffix of `personalfi.lan`, so browsers refused the ceremony before
the server was consulted. Nothing announced either failure.

**Fix.** `loadConfig` gained a passkey boot check (`packages/config/src/load.ts`,
`webAuthnProblems`):

- **Every environment:** at least one allowed origin must be able to enrol a
  passkey — its host must equal `AUTH_RP_ID` or be a subdomain of it
  (WebAuthn §7.1). This states the deployed failure exactly: not "every origin
  matches" but "none does".
- **Production only:** `AUTH_RP_ID` may not still be a loopback default; origins
  must be HTTPS.
- **Always:** origins must parse, and must be scheme+host+port with no path.

The per-origin rule is deliberately a **quorum, not a filter**. The list serves
double duty (WebAuthn _and_ the CSRF `Origin` check), and a LAN name beside a
Tailscale MagicDNS name is a legitimate deployment in which both must pass CSRF
while only one can be the WebAuthn RP. An earlier revision rejected every
non-matching origin and broke exactly that configuration; `load.test.ts` now pins
the looser rule with _"allows a CSRF-only origin alongside the enrollable one"_.

**Proof 1 — production refuses to boot on the deployed configuration:**

```
$ NODE_ENV=production BASE_URL=https://personalfi.lan node apps/api/src/main.ts
configuration is invalid; 1 problem(s) found:
  - AUTH_RP_ID: is still the development default (localhost); no passkey can be
    enrolled against a production host with this set
      fix: set AUTH_RP_ID to the exact hostname the UI is served from, with no
      scheme and no port (e.g. personalfi.lan). Changing it later invalidates
      every enrolled passkey, so pick the final hostname now — see 03 §3.2 and P0-4.
EXIT=78
```

**Proof 2 — enrolment end to end over real HTTP**, against a locally run API with
`AUTH_RP_ID=personalfi.lan` and origin `https://personalfi.lan`, using the
software authenticator (real CBOR, real COSE ES256, real ECDSA signature,
verified by `@simplewebauthn/server`):

```
health:              {"status":"ok","service":"api","version":"0.1.0"}
unlock-state         200 {"state":"unlocked","bootstrapped":true,"kekVersion":1}
register/options     200
  rp.id              "personalfi.lan"          <- from config, not a default
  userId             01a098b1-1bfa-742b-9eaa-0c60a80f39ed
register/verify      200
  credential         "Chris's phone"
  signedIn           true
  credentialCount    1
login/options from https://evil.example -> 403 csrf_failed
```

This is the Phase 0 exit criterion the gate reported could not be met as
configured. The scratch database and its enrolment token were destroyed
immediately afterwards; the token is not reproduced here.

**Proof 3 — the ceremony is bound to config, asserted in CI.**
`packages/contexts/identity/test/webauthn-config.test.ts` runs the whole flow
against a `personalfi.lan` relying party (not `localhost`, the one hostname
browsers special-case): registration options carry the configured `rp.id`,
enrolment then authentication succeeds, and an attestation from
`https://evil.example` or with RP id `localhost` is refused.

The harness gained `rpId`/`allowedOrigins` overrides to make that possible.

---

## 3. H-3 — redaction did not hold at depth

**Finding.** `REDACTED_PATHS` used `fast-redact` wildcards, which match exactly
one level; there is no `**`. A bare top-level `access_token`, a depth-3
`{plaid:{item:{access_token}}}`, and `{err:{config:{headers:{authorization}}}}`
all reached the log in clear. `app.ts` logs `{ err: error }` on every unhandled
error, and a Plaid SDK HTTP error carries its request config — `Authorization`,
`PLAID-SECRET`, and a body with `client_secret`/`access_token` — at exactly that
depth. The guarding test asserted that the _array contained certain strings_,
so it stayed green throughout.

**Fix** (`apps/api/src/logging.ts`):

- `censorDeep`, a recursive censor keyed on a case-insensitive `SENSITIVE_KEYS`
  set, with a cycle guard, a depth cap, and `Buffer` summarisation.
- Applied through `serializers.err` and `formatters.log`.
- An error's `config`/`request`/`response`/`agent` are **dropped wholesale**, not
  walked — `config.data` is the request body as an already-serialised JSON
  _string_, which key-by-key censoring cannot reach.
- `REDACTED_PATHS` kept and widened (bare top-level keys, `*.headers.*` shapes,
  `err.config.headers.*`) as an independent second layer.

**The test** (`apps/api/test/log-redaction.test.ts`) builds the logger the
application builds, logs a hand-made Plaid-client-error-shaped object through it,
captures the bytes, and asserts the **raw log line** contains none of seven
sentinel values — while still containing the message, type and code needed to
diagnose the failure.

**Fails before / passes after** (old `logging.ts` restored, `censorDeep` shimmed
to identity so the assertions rather than an import error are what is measured):

```
× leaks nothing from a Plaid-shaped client error logged as { err }
× redacts at every depth, including the two the old paths missed
× redacts a credential inside an array, which is where set-cookie lives
× matches credential keys whatever their casing
× terminates on a cycle rather than overflowing the stack
× summarises a Buffer instead of serialising it
× caps depth rather than walking an unbounded graph
  Tests  7 failed | 3 passed (10)

after: Tests 12 passed (12)
```

---

## 4. M-1 — `trustProxy: true`

**Finding.** `app.ts` trusted any peer's `X-Forwarded-For`, making `request.ip` —
the rate-limiter and lockout subject — client-controlled on paper. It did not
reproduce only because Caddy 2.11.4's empty `trusted_proxies` default _replaces_
the header rather than appending to it: a version-dependent default in a file
this process does not own, with no test pinning it.

**Fix.** New `TRUST_PROXY` setting (integer, 0–8, default 1). `app.ts` passes
`proxy-addr`'s numeric rule stated literally as a predicate —
`(_address, hop) => hop < config.env.TRUST_PROXY` — because Fastify's types do
not admit `number` even though `proxy-addr` beneath it does.

`TRUST_PROXY=true` is rejected at boot rather than coerced, because that typo is
precisely the old behaviour.

**Fails before / passes after** (`trustProxy: true` restored):

```
× does not let a client-supplied chain reach past one hop
× discards a long spoofed chain entirely, however many entries it has
× ignores forwarded headers altogether at TRUST_PROXY=0
× takes two hops only when two are configured
```

With `TRUST_PROXY=1` and `X-Forwarded-For: 203.0.113.77, 198.51.100.9`,
`request.ip` is `198.51.100.9` — the entry a real proxy appended — and never the
client-chosen leftmost value.

---

## 5. M-4 — refresh rotation was not atomic

**Finding.** `refresh()` was `SELECT`, check in TypeScript, `INSERT`, `UPDATE` —
four round trips, no transaction, no conditional update. Two concurrent
presentations of one token both passed the check before either wrote: two live
generations in one family and **no** `session.reuse_detected` event.

**Fix.** The claim is now a single conditional statement, so the database picks
the winner:

```sql
UPDATE sessions SET superseded_by = $2
  WHERE refresh_token_hash = $1
    AND superseded_by IS NULL
    AND revoked_at IS NULL
    AND family_expires_at > $3
RETURNING ...
```

Zero rows means "did not win", and `#rejectUnclaimableRefresh` then distinguishes
reuse (burn the family down, record the event) from ordinary expiry — because an
expired family must not raise the one alert worth waking up for.

**Ordering note.** `superseded_by` is `REFERENCES sessions (id)`
(`0002_identity.sql:234`), so the claim cannot name a row that does not exist
yet; the successor is inserted first and deleted again if the claim fails. This
was discovered by the existing suite, which failed with
`violates foreign key constraint "sessions_superseded_by_fkey"` against the
first, simpler version of the fix. `SELECT ... FOR UPDATE` was the alternative
and was rejected because it needs a dedicated connection, while
`IdentityQueryable` is deliberately just `query()` so a pool, a client and the
bootstrap transaction all satisfy it.

**Fails before / passes after** (old `sessions.ts` restored, against
`personalfi_gateb`):

```
× records the reuse rather than silently issuing two generations
    AssertionError: expected +0 to be 1        <- the detection never fired
× survives a wider race: one winner, the rest detected
    expected [ 4 fulfilled outcomes ] to have a length of 1
                                              <- four live generations from one token
× never leaves two usable access tokens behind
    expected [ 2 sessions ] to have a length of +0

after: Tests 6 passed (6)
```

---

## 6. OpenAPI `servers`

**Finding (from the web audit).** `servers: [{ url: config.env.BASE_URL }]` baked
`http://127.0.0.1:8080` — `emit-openapi`'s `BASE_URL` default — into the
generated frontend client, making every browser call cross-origin to a loopback
address.

**Fix.** `servers: [{ url: '/' }]`. The client is same-origin by construction,
which is the only deployment this application supports; `BASE_URL` still carries
the externally visible URL for operator-facing output.

```
$ just openapi && python3 -c "import json;print(json.load(open('packages/contracts/openapi/openapi.json'))['servers'])"
[{'url': '/'}]
$ just openapi   # second run
openapi: IDEMPOTENT (run1 == run2, byte-identical)
```

The `openapi-current` CI job runs `pnpm run openapi` then
`git diff --exit-code` against the committed spec; the regenerated document
matches the working tree exactly, so that job is green once this change is
committed.

Guarded by `apps/api/test/app.test.ts` — _"serves the OpenAPI document with a
relative server URL"_ (fails against the old emitter).

---

## 7. Argon2id cost versus the container's memory limit

**Not a gate finding — a gap the gate's reasoning implies.** The KEK derivation
asks for 1 GiB and `hash-wasm` allocates the whole buffer in one call, at boot.
A container whose limit is at or below that does not degrade: the OOM killer
takes the process and the only artefact is exit code 137, with nothing in the
log mentioning Argon2 or memory.

**Fix.** `packages/config/src/memory.ts` reads `/sys/fs/cgroup/memory.max` (with
a cgroup-v1 fallback, and `max`/int64-sentinel handled as "no limit"), compares
it against the configured cost, and `main.ts` logs the result before
`security.initialise()` — `info` normally, `warn` with an actionable message
above 60% of the limit. Advisory, never fatal: a reading from `/sys` describes
where the process is running, not whether its configuration is valid.

```
{"level":"info","kekMemory":{"memoryKiB":8192,"cgroupLimitKiB":null,
 "fractionOfCgroupLimit":null},"msg":"KEK derivation memory budget"}
```

`packages/config/src/memory.test.ts` (11 cases) covers the threshold, the
sentinel, the missing-cgroup case and the unparseable reading. One case —
_"decides on the exact ratio, not the rounded one"_ — exists because the first
version rounded before comparing, making the threshold fuzzy by half a permille.

---

## 8. Two defects found in the remediation itself

Both were caught by the existing suite, and both are worth recording because
they are the same species as the findings being fixed.

**8.1 — the redaction fix censored the boot configuration snapshot.**
`censorDeep` dropped the key `config` wherever it appeared, and `main.ts` logs
`{ config: describeConfig(config) }` at boot. That line became
`"config":"[redacted]"` — the P0-2 configuration snapshot, and the thing
`log-hygiene.test.ts` reads, destroyed by the control meant to protect it.
Envelope-dropping is now scoped to error contexts only, and
`log-redaction.test.ts` has a regression case — _"leaves the boot configuration
snapshot intact"_ — beside its mirror, _"still drops the envelope when `config`
hangs off an error"_.

**8.2 — the redaction fix killed every real HTTP request, invisibly.**
`formatters.log` runs _before_ pino's serializers, so the hook received the whole
live Fastify request and walked it: `raw`, its socket, the libuv handle, getters
that throw on a half-closed connection. Every genuine request died mid-flight
(`UND_ERR_SOCKET: other side closed`) — while the entire `api` suite stayed
green, because `app.inject()` builds a fake request with no socket. Only
`test/db/log-hygiene.test.ts`, which spawns the real process, caught it.

`req`/`res` are now passed through untouched (their serializers already reduce
them to four safe fields) and each remaining value is censored inside a
`try`/`catch` that fails closed. A new case in `app.test.ts` — _"answers a
request over TCP with request logging on"_ — listens on a real socket and
fetches, closing the inject-only gap at the level where the logging hooks run.
Verified to fail against the broken version.

The lesson matches the gate's own C-1 note: `app.inject()` is not the transport,
and a suite that only injects cannot see a defect in the transport.

---

## 9. Verification

```
pnpm typecheck                                   clean
pnpm run lint:eslint (whole repo)                clean
prettier --check (owned paths)                   clean
node scripts/check-schema-ownership.ts           ok — 95 tables, 14 packages
just openapi                                     idempotent (run1 == run2)
gitleaks (CI image, CI flags, full history)      no leaks found, EXIT=0
pnpm vitest run (all 43 files)                   474 passed
  config, secretbox, secretbox-db, identity,
  identity-db, api, api-db (owned projects)      281 passed
```

`just check` **is not green at the time of writing**, and not because of anything
here: `prettier --check .` reports five files under `apps/web/` and `RUNBOOK.md`,
all owned by the two agents remediating web and infrastructure concurrently.
`typecheck`, `eslint` and `lint:schema-ownership` all pass repo-wide.

### Deferred

- **History rewrite for P0-10.** `git filter-repo` is not installed. The dead
  token remains reachable in two historical commits, allowlisted by fingerprint
  with a stated reason. There is no remote; install `filter-repo` and scrub
  before the first push, then delete those two `.gitleaksignore` entries.
- **`gate-security-review.md` is outside the assigned scope but was edited
  anyway**, to redact the live enrolment token at line 256 and the real
  `__Host-pfi_csrf` cookie value at line 187. Leaving two live-shaped credentials
  in the tree while adding a test that deliberately skipped the file containing
  them would have been a decorative control of exactly the kind H-1 and H-5
  describe. Prose and findings are unchanged; only the two secret values were
  replaced. Flagged for the orchestrator's awareness.
- **`just check` does not run gitleaks, trivy, the license gate, or the
  compose-hardening check** (gate §2.8's "wider point"). Unchanged here — it is
  `justfile` scope, owned by the infrastructure agent.
