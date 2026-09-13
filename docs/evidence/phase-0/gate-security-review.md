# Phase 0 security gate — independent review

_Reviewer: `security-engineer`, adversarial pass. Repo `/home/chris/Projects/PersonalFi`, branch
`main`, HEAD `a0adccd` at entry. Conducted 2026-09-12._

**Verdict: NO-GO for "Phase 0 complete."** Of the fourteen P0 items, four FAIL and two are PARTIAL
(the property holds but the control meant to enforce it does not). The headline is not a subtle
cryptographic flaw — it is that **the production compose stack had never successfully booted**, so
every P0 item whose evidence is "inspect the running container" had never been observed at all. `docker compose up` produced no API on a clean box until the fixes in
§4 of this document. Everything downstream of that (passkey login over TLS, the restore drill, the
container-hardening capture) was recorded against a stack in `Created` or `Exited` state.

The cryptography itself is the strongest part of this codebase. `SecretBox`, the AAD design, the
session state machine, the rate limiter and the log-hygiene boot test are careful, well-reasoned
work that survived adversarial probing. The failures are all at the seams: compose wiring, image
assembly, and gates that were written but never run.

A note on method, because it changed three conclusions. Every load-bearing claim below was
re-derived by running a command, not by reading a prior evidence document. That caught two
blocking defects the prose asserted were fine, and it also **overturned one Critical finding**
(§3, C-1) that static reading had made look certain.

---

## 1. The P0 table

Legend: **PASS** = personally verified by command output quoted below. **PARTIAL** = the property
holds but the control that is supposed to enforce it does not. **FAIL** = does not hold today.

| #   | P0 item                                                                                        | Verdict                                  | Evidence I personally produced                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider tokens/keys encrypted app-layer; a test reads the raw column and asserts no plaintext | **PASS**                                 | §2.1 — canary sealed through the real `SecretBox` against the **live compose database**, raw `bytea` read back three ways, canary absent in all; AAD relocation rejected on all three axes                                                                                      |
| 2   | KEK never in env; Argon2id m≥1 GiB/t=4/p=4; `docker inspect` and `/proc/<pid>/environ` clean   | **PASS** _(after fix F-3)_               | §2.2 — zero secret substrings in `.Config.Env` and `/proc/1/environ` for api/worker/db; boot log `memoryKiB:1048576 timeCost:4 parallelism:4 floorMemoryKiB:1048576 durationMs:6284` under `NODE_ENV=production`. **Was FAIL**: container SIGKILLed (exit 137) deriving the KEK |
| 3   | Only the proxy publishes a port, bound to a LAN/Tailscale address; external `nmap` saved       | **PARTIAL**                              | §2.3 — only `proxy` publishes, both on `127.0.0.1`; host `ss -ltn` agrees. No external `nmap` capture exists in `docs/evidence/`                                                                                                                                                |
| 4   | Passkeys working, ≥2 authenticators, 10 recovery codes                                         | **FAIL**                                 | §2.4 — `compose.yml` sets neither `AUTH_RP_ID` nor `AUTH_ALLOWED_ORIGINS`; the api container runs as `localhost` / `http://localhost:8080` while `BASE_URL=https://personalfi.lan`. Reproduced a `403 csrf_failed` on the real origin                                           |
| 5   | Session cookie attributes asserted by test; refresh reuse kills the session family             | **PASS**                                 | §2.5 — attributes observed on the wire; `cookies.test.ts` and `sessions.test.ts` are substantive. One TOCTOU noted (M-4)                                                                                                                                                        |
| 6   | No Docker socket, no `privileged`/`--net=host`/`--pid=host`; CI greps compose files            | **PARTIAL**                              | The property holds in all three compose files. The gate that enforces it does not — see H-1                                                                                                                                                                                     |
| 7   | All containers non-root, `cap_drop: ALL`, `no-new-privileges`, `read_only: true`               | **PASS** _(after fixes F-1…F-3)_         | §2.6 — runtime `docker inspect` across all five running services. Previously unverifiable; the prior evidence doc says so honestly                                                                                                                                              |
| 8   | Sidecar cannot resolve or reach `db`                                                           | **PASS**                                 | §2.7 — from `personalfi_sidecar`: `db` NXDOMAIN, `db:5432` unreachable, `api:8080` unreachable, no egress                                                                                                                                                                       |
| 9   | Sidecar holds no broker write credentials; only an LLM key under `/run/secrets`                | **PASS** _(vacuous)_                     | No sidecar exists; the placeholder is granted no secrets                                                                                                                                                                                                                        |
| 10  | `gitleaks` and `trivy --scanners secret` clean                                                 | **FAIL**                                 | §2.8 — gitleaks run **exactly as CI runs it** exits 1 with 4 leaks, including a real bootstrap enrolment token committed in an evidence doc. trivy secret: clean                                                                                                                |
| 11  | Encrypted backups running and restore tested end to end                                        | **FAIL**                                 | §2.9 — the committed drill records `Restored db table count: 0`, `Live db table count: 0`, `/ready: fail` — and exited 0                                                                                                                                                        |
| 12  | No token or account number in logs; CI greps captured sync logs                                | **PASS** for what exists; **latent gap** | §2.10 — the boot-capture test is real and proves the passphrase, bootstrap token, DB URL and cookies stay out. But `REDACTED_PATHS` does not do what it claims at depth (H-3)                                                                                                   |
| 13  | LUKS2 on the `pgdata` and backup volume                                                        | **N/A**                                  | Chris's hand action on the host; not verifiable from the repo                                                                                                                                                                                                                   |
| 14  | Rate limiting and lockout on auth endpoints, persisted across restart                          | **PASS**                                 | §2.11 — drove the threshold, observed `429`, restarted the container, still `429 locked_out` with 869 s remaining                                                                                                                                                               |

**Plus D14 (supply chain, P0 by decision):** Renovate 7-day cooldown — **PASS** (global, all
datasources, not bypassed by `vulnerabilityAlerts`). `--ignore-scripts` — **PASS** (verified: a
forced 995-package reinstall ran zero build scripts; `allowBuilds` lists three entries, all
`false`). License gate — **PASS today**, but see M-6: it fails tomorrow on a date diff. Digest
pinning — **PASS** (every action pinned to a 40-char SHA; every base image by digest).

**Score: 7 PASS, 2 PARTIAL, 4 FAIL, 1 N/A.** Three of the seven PASSes only became true during
this review.

---

## 2. The evidence, command by command

### 2.1 P0-1 — no plaintext in the raw column

Not the unit test: a fresh probe run **against the live compose database**, using the real
`SecretBox` and the real keyring unlocked with the real `master_key`.

```
unlock: unlocked
{
 "bytes length": 111,
 "utf8 contains canary": false,
 "latin1 contains canary": false,
 "psql escape contains canary": false,
 "hex contains canary-hex": false,
 "any 8-char fragment present": false,
 "envelope version byte": 1,
 "roundtrip decrypts": true
}
first 48 bytes hex: 0101a096eaf577700eb60b1da0bc337ece2d67ab5cf78278a8f146755e97d18b94bc71522f45f15deadb1b8969bf3ff2
AAD row relocation:    rejected (decrypt_failed)
AAD column relocation: rejected (decrypt_failed)
AAD table relocation:  rejected (decrypt_failed)
```

The canary was read back through the driver, through `encode(sealed,'escape')` (what `psql`
prints), and through `encode(sealed,'hex')`. Absent in every representation, whole and in every
8-character fragment. The three relocation attempts are the AAD-completeness check asked for in
the brief: the same ciphertext bytes presented under a different `rowId`, a different `column`,
and a different `table` all fail closed with an indistinguishable error.

### 2.2 P0-2 — KEK custody

```
### docker inspect .Config.Env, secret substrings ###
/personalfi-api-1     : 0
/personalfi-backup-1  : 0
/personalfi-db-1      : 0
/personalfi-proxy-1   : 0
/personalfi-worker-1  : 0

### /proc/1/environ ###
api    : 0 secret substrings
worker : 0 secret substrings
db     : 0 secret substrings
```

Non-vacuity — the full environment of the api container, showing it is populated and that the
passphrase genuinely is not in it:

```
PATH=... HOSTNAME=0178c65f874c LOG_LEVEL=info HTTP_HOST=0.0.0.0 HTTP_PORT=8080
BASE_URL=https://personalfi.lan SECRETS_DIR=/run/secrets ROLE=api TZ=UTC
NODE_ENV=production NODE_VERSION=26.8.2 NODE_OPTIONS=--enable-source-maps HOME=/home/app
```

And the derivation itself, from the real boot log under `NODE_ENV=production`:

```json
{
  "kek": {
    "kdf": "argon2id",
    "memoryKiB": 1048576,
    "timeCost": 4,
    "parallelism": 4,
    "floorMemoryKiB": 1048576,
    "durationMs": 6284
  },
  "kekVersion": 1,
  "msg": "key custody: unlocked"
}
```

This is the P0-2 evidence line the plan asks for, and **this review is the first time it has been
produced from a container** rather than from a unit test.

### 2.3 P0-3 — port exposure

```
proxy  ... {127.0.0.1 8080 80 tcp} {127.0.0.1 8443 443 tcp}
api    [{ 8080 0 tcp}]      <- container-internal EXPOSE only, not published
worker [{ 8080 0 tcp}]      <- ditto
db     [{ 5432 0 tcp}]      <- ditto
backup []

$ ss -ltn | grep -E ":(443|80) "
LISTEN 0 0 127.0.0.1:443 0.0.0.0:*
LISTEN 0 0 127.0.0.1:80  0.0.0.0:*
```

Exactly one service publishes, and only to loopback. The `nmap` artifact P0-3 names is absent
from `docs/evidence/`; with `BIND_ADDRESS` defaulting to `127.0.0.1` an external scan is
trivially empty, but the item asks for the capture and it does not exist.

### 2.4 P0-4 — passkeys (FAIL)

```
$ docker compose exec api node -e "console.log({RP_ID:process.env.AUTH_RP_ID,
    ORIGINS:process.env.AUTH_ALLOWED_ORIGINS, BASE_URL:process.env.BASE_URL})"
{ "BASE_URL": "https://personalfi.lan" }        <- RP_ID and ORIGINS are undefined
```

Confirmed in the api's own boot log: `"AUTH_RP_ID":"localhost"`,
`"AUTH_ALLOWED_ORIGINS":"http://localhost:8080"`. `compose.yml:149-157` sets neither.

Reproduced consequence — a request from the origin the stack actually serves:

```
$ curl -k https://personalfi.lan/auth/login/verify -H "Origin: https://personalfi.lan" ...
HTTP/2 403
{"code":"csrf_failed","detail":"This request did not originate from an allowed origin."}
```

Two independent breakages from one omission. `AUTH_ALLOWED_ORIGINS` feeds the CSRF `Origin`
allow-list, so **every mutation from the real origin is rejected**. `AUTH_RP_ID` feeds WebAuthn,
and `localhost` is not a registrable suffix of `personalfi.lan`, so the browser refuses the
ceremony before the server is even consulted. No passkey has ever been enrolled through this
stack, and the Phase 0 exit criterion — "`docker compose up` on a clean box yields a passkey
login over TLS in under 60 s" — cannot be met as configured.

I did not fix this: the correct values depend on Chris's chosen hostname and on whether the
Tailscale MagicDNS name is also an allowed origin. That is a deployment decision, not a defect
with one obvious answer.

### 2.5 P0-5 — cookies and refresh reuse

On the wire, unauthenticated:

```
set-cookie: __Host-pfi_csrf=EXAMPLE-CSRF-COOKIE-REDACTED-NOT-A-REAL-VALUE; Path=/; Secure; SameSite=Strict
```

`Secure`, `Path=/`, no `Domain` — the three things `__Host-` requires. `httpOnly` is
deliberately absent on this one cookie only, correctly, because double-submit needs the page to
read it; it authenticates nothing. `apps/api/test/cookies.test.ts` asserts the attributes on the
**set** path for all three cookies, which is the path that matters.

`packages/contexts/identity/test/sessions.test.ts:275-330` proves reuse detection properly: a
replayed refresh token revokes the whole family with reason `refresh_token_reuse`, writes a
`session.reuse_detected` event per replay, and a revoked generation's token is treated as reuse
rather than as expiry. The design deliberately does not let step-up freshness survive rotation —
`sessions.ts:235-237` — which is the right call and is commented as such.

### 2.6 P0-7 — hardening flags, at runtime

```
SERVICE                  READONLY  CAPDROP  SECOPT                    USER
/personalfi-api-1        true      [ALL]    [no-new-privileges:true]  10001:10001
/personalfi-backup-1     true      [ALL]    [no-new-privileges:true]  10002:10002
/personalfi-db-1         false     [ALL]    [no-new-privileges:true]  70:70
/personalfi-proxy-1      true      [ALL]    [no-new-privileges:true]  10003:10003
/personalfi-worker-1     true      [ALL]    [no-new-privileges:true]  10001:10001
```

`db`'s `read_only: false` is correct and scoped — Postgres must write its data directory, which
is a named volume plus two tmpfs mounts. `migrator` declares the same three flags explicitly at
`compose.yml:214-216` and completed successfully (`Exited (0)`).

The prior evidence document is honest that these were inspected in `Created` state. They have now
been inspected while running, which is a different claim.

### 2.7 P0-8 — sidecar isolation

From a throwaway container attached to `personalfi_sidecar`:

```
resolve db      : NXDOMAIN
tcp db:5432     : unreachable
tcp api:8080    : unreachable
egress 1.1.1.1  : blocked (internal:true)
```

Structural, not filtered — `db` is only on `backend`, and `sidecar` is `internal: true`. This is
the cleanest-passing item on the list. Caveat in M-5: `webhooks-placeholder` sits on `backend`,
contradicting the comment directly above it.

### 2.8 P0-10 — secret scanning (FAIL)

Run with the pinned image and the ignore file, byte-identical to `.github/workflows/ci.yml:168-171`:

```
$ docker run --rm -v "$PWD:/repo" -w /repo \
    zricethezav/gitleaks:v8.30.0@sha256:691af3c7... \
    detect --source . --redact --exit-code 1 -i .gitleaksignore
EXIT=1
INF 28 commits scanned.
WRN leaks found: 4
```

The four:

| File:line                                       | Rule              | Assessment                                            |
| ----------------------------------------------- | ----------------- | ----------------------------------------------------- |
| `apps/api/test/csrf.test.ts:45`                 | `generic-api-key` | False positive — a test fixture constant              |
| `packages/secretbox/test/secret-box.test.ts:25` | `plaid-api-token` | False positive — a synthetic Plaid-shaped fixture     |
| `docs/evidence/phase-0/wp0.2-summary.md:96`     | `generic-api-key` | **Real.** A live bootstrap enrolment token, committed |
| `docs/evidence/phase-0/wp0.2-summary.md:98`     | `generic-api-key` | **Real.** The same token, `token only:` line          |

The committed token is redacted here as `EXAMPLE-ENROLMENT-TOKEN-REDACTED`, expiring `2026-09-12T18:42:07Z`,
from a throwaway local database — so the practical risk is nil. The hygiene failure is not nil:
this is exactly the class of artifact P0-10 exists to keep out of the repository, and it is sitting
in the evidence directory that is supposed to demonstrate the control working.

The two fixtures need reviewed `.gitleaksignore` fingerprints with a stated reason (the file's own
header demands that format). The token needs scrubbing from the doc, not an ignore entry.

**The wider point: CI is red at HEAD and nobody noticed, because `just check` does not run
gitleaks, trivy, the license gate, or the compose-hardening check.** Those are CI-only jobs. A
green `just check` was being read as a green pipeline.

### 2.9 P0-11 — backups and restore (FAIL)

The committed drill artifact, `docs/evidence/ops/restore-drill-20260912.md`, records its own
failure:

```
- Restored db table count: 0
- Live db table count: 0
- API /ready against restored db: fail or skipped — ... not necessarily an infra defect
```

Zero tables restored, zero tables in the live database, API could not come up — and
`just restore-drill` exited 0 and wrote this as evidence that P0-11 is done. `justfile:244-299`
reads `RESTORED_TABLES` and `LIVE_TABLES` and then only _prints_ them; there is no comparison and
no non-zero exit. The API boot step ends in `|| true` and a failure is recorded as prose.

`Live db table count: 0` is itself the tell — it is consistent with everything else in this
review. The stack never booted, so the migrator never ran, so there was nothing to back up.

This compounds with H-2: `docker/backup/backup.sh:14` is `set -eu` with no `pipefail`, and the
dump is a pipeline into `age`. `age` succeeds on empty stdin, so a failed `pg_dump` produces a
well-formed ~200-byte encrypted file, `mv`s it into place, logs it as a success, and then line 38
prunes backups older than the retention window. A password rotation without a container restart
silently converts every nightly backup into an empty file and then deletes the last good one,
while the healthcheck — which only checks that the loop process exists — reports healthy
throughout.

### 2.10 P0-12 — log hygiene

`apps/api/test/db/log-hygiene.test.ts` is genuinely good work: it boots `main.ts` as a real child
process against a real database, captures both pipes, exercises an unauthenticated GET, a POST
carrying the enrolment token, and a failed login, and then asserts absence of the passphrase (whole
and in 12-char sliding fragments), the enrolment token, any `postgres://` URL, and any cookie
echo — with an explicit non-vacuity guard so the negatives cannot pass against an empty log.
For the secrets that exist in Phase 0, P0-12 holds.

The latent gap is `REDACTED_PATHS`. `apps/api/src/logging.ts:23` says "Provider and session
credentials, **at any depth**". pino's `fast-redact` wildcard matches exactly one level.
Demonstrated:

```
{"plaid":{"access_token":"[redacted]"},"msg":"depth2"}                         <- redacted
{"plaid":{"item":{"access_token":"DEPTH3_TOKEN"}},"msg":"depth3"}              <- LEAKED
{"a":{"b":{"c":{"secret":"DEPTH4_SECRET"}}},"msg":"depth4"}                    <- LEAKED
{"access_token":"DEPTH1_TOKEN","msg":"depth1-top-level"}                       <- LEAKED
{"err":{"config":{"headers":{"authorization":"Bearer LEAK"}}},"msg":"err"}     <- LEAKED
```

The last line is the one that matters. `apps/api/src/app.ts:162` logs `{ err: error }` on every
unhandled error, and an HTTP-client error from the Plaid SDK carries its request config —
including `Authorization` and the request body with `client_secret` / `access_token` — at exactly
that depth. Nothing in Phase 0 makes such a call, so this is not live today. Phase 1 makes it live
on day one.

`apps/api/test/app.test.ts:188` does not catch this: it asserts that `REDACTED_PATHS` _contains_
certain strings, which is a test of the list rather than of the redaction.

### 2.11 P0-14 — rate limiting and lockout

Drove the `webauthn` bucket past its threshold, then restarted the container:

```
attempts 4..11 -> 401 401 401 401 401 401 401 429

before restart: fails=0 level=1 locked_until=2026-09-12 18:55:23.681+00
$ docker compose restart api
after  restart: fails=0 level=1 locked_until=2026-09-12 18:55:23.681+00

$ curl ... /auth/login/verify
HTTP=429
{"code":"locked_out","detail":"Too many attempts. Try again in 869 seconds."}
```

Threshold engaged at the tenth failure, the backoff level escalated, the lockout is a Postgres
row, it survived a container restart, and the next attempt after the restart was still refused
with the remaining time. This is P0-14 exactly as specified, and it is the item whose
implementation I'd hold up as the model for the rest.

---

## 3. Threat-model spot checks

Ordered by severity. Everything here is beyond the fourteen-item checklist.

### C-1 — WITHDRAWN: client-controlled `X-Forwarded-For` (the finding that did not survive testing)

I am recording this one in full because it is the most instructive result of the review.

Static reading makes a Critical look certain. `apps/api/src/app.ts:87` sets `trustProxy: true`,
which is trust-everything. `auth-flows.ts:426-428` keys the rate limiter and the lockout on
`ip:${context.ip}`, and `context.ip` is `request.ip` (`routes/auth.ts:170`). `docker/Caddyfile`
contains no `trusted_proxies` directive and no `header_up X-Forwarded-For` — the only two
`header_up` lines in the file set `X-Forwarded-Proto`. The textbook conclusion is that a client
sets `X-Forwarded-For: <random>` per request, gets a fresh rate-limit subject every time, and the
persisted limiter and lockout never fire. A parallel reviewer reached exactly that conclusion and
rated it Critical.

It does not reproduce:

```
$ for ip in 203.0.113.77 198.51.100.9 192.0.2.44; do
    curl -k https://personalfi.lan/auth/login/verify -H "X-Forwarded-For: $ip" ... ; done
401 401 401

auth_attempts:  webauthn | ip:172.21.0.1 | attempts=3
auth_lockouts:  webauthn | ip:172.21.0.1 | fails=3
security_events: auth.webauthn.failure | ip=172.21.0.1   (x3)
```

All three spoofed values were discarded; the subject is the real peer address. Cause: Caddy
**v2.11.4** (confirmed: `docker exec personalfi-proxy-1 caddy version`). Since Caddy 2.7,
`reverse_proxy` only _appends_ to an inbound `X-Forwarded-For` when the immediate peer is listed
in `trusted_proxies` — which defaults to empty. Otherwise it **replaces** the header with the
peer address. The empty default is the protection.

So the control holds. What remains is real but much smaller, and is recorded as M-1.

The lesson for the orchestrator: two reviewers reading the same four files concluded Critical, and
the conclusion was wrong. Proxy header semantics are version-dependent defaults, not properties you
can read off a config file.

### H-1 — `compose-hardening-check.sh` passes a maximally hostile service (P0-6's gate is decorative)

`scripts/compose-hardening-check.sh:49-52`. The regexes for `network_mode: host` and `pid: host`
are written as `.host.` — requiring a literal character on each side of `host` — so they match only
the _quoted_ spelling and miss the canonical unquoted form. The `privileged` pattern anchors on
bare `true` and misses `"true"`. The socket pattern hardcodes `/var/run/docker.sock` and misses
`/run/docker.sock`.

Demonstrated end-to-end against a scratch compose file declaring `network_mode: host`, `pid: host`,
`ipc: host`, `privileged: "true"`, `seccomp:unconfined`, `cap_add: [SYS_ADMIN]`,
`/run/docker.sock` mounted, `/:/host:rw`, and `ports: ['0.0.0.0:443:8443']`:

```
compose-hardening-check: PASS (1 file(s) checked: compose.yml)
EXIT=0
```

Every single one of P0-6's prohibitions, present simultaneously, and the gate returns success.
This script is both the CI `compose-hardening` job and a lefthook pre-commit hook, so **both**
enforcement points are blind.

Not checked at all, beyond the broken four: `ipc: host`, `cgroup: host`, `userns_mode: host`,
`cap_add`, `security_opt: seccomp/apparmor:unconfined`, `devices:`, per-service presence of
`read_only`/`cap_drop`/`no-new-privileges`/non-root `user:`, **port bindings to `0.0.0.0` or a
bare `"443:8443"`** (the one control `compose.yml`'s own header leans on hardest), writable bind
mounts, and `/run/podman/podman.sock`.

Today's compose files genuinely satisfy P0-6 — I verified that separately. The finding is that
nothing would notice if they stopped. Recommend replacing the grep with
`docker compose config --format json | jq` assertions, which can also check the positive
properties rather than only the negative ones.

### H-2 — `backup.sh` has no `pipefail`; a failed dump becomes a valid-looking empty backup

`docker/backup/backup.sh:14,32-35,38`. Covered in §2.9. Concrete sequence: pg password rotates
without a `backup` container restart → 30 nights of 215-byte "successful" backups → night 31's
retention prune deletes the last real one → total silent loss of the ledger, with the healthcheck
green throughout. One-word fix (`set -euo pipefail`; busybox ash supports it) plus a size/format
assertion before the `mv`.

### H-3 — `REDACTED_PATHS` does not redact at depth, and the test that guards it is tautological

§2.10. Latent until Phase 1, at which point `app.ts:162`'s `log.error({ err })` on a Plaid SDK
error is a direct P0-12 violation. The fix is not just more wildcard paths — `fast-redact` has no
`**` — but a custom `err` serialiser that strips `config`/`request`/`response` before pino sees
them, plus depth-0 entries for the bare key names. Whatever the fix, the test must assert on real
pino output rather than on the contents of the array.

### H-4 — the Tailscale listener ships no CSP, HSTS, or framing headers

`docker/Caddyfile:82-98`. The `:8443` LAN block sets eleven security headers. The `:8080` block —
which the file's own header at line 16 documents as _the remote-access path_
(`tailscale serve --https=443 http://127.0.0.1:8080`) — sets three: `X-Content-Type-Options`,
`Referrer-Policy`, `-Server`.

Missing on the remote path: `Content-Security-Policy`, `Strict-Transport-Security`,
`X-Frame-Options`, `frame-ancestors`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, `base-uri`,
`form-action`.

Tailscale Serve passes headers through verbatim, so every remote session runs with no CSP and no
framing protection. An injected script that `connect-src 'self'` blocks on the LAN can exfiltrate
balances to an attacker origin over Tailscale. Fix is mechanical: lift the header block into a
Caddy snippet and `import` it into both site blocks.

### H-5 — the restore drill cannot fail

§2.9. `justfile:244-299` gathers the numbers that would prove or disprove a successful restore and
then never compares them. The only control capable of catching H-2 is structurally incapable of
returning non-zero. Needs `[ "$RESTORED_TABLES" -eq "$LIVE_TABLES" ] || exit 1`, a non-zero exit on
`/ready` failure, and a floor assertion that the restored table count is greater than zero.

### M-1 — `trustProxy: true` is broader than the deployment

The residue of C-1. `app.ts:87` trusts _any_ peer's forwarding headers. It is safe today only
because Caddy 2.11.4's empty `trusted_proxies` default strips them first. That is an undocumented,
version-dependent dependency with no test pinning it: a Caddy config that ever adds
`trusted_proxies`, a future service placed on the `frontend` network, or a debugging session that
publishes the api port would each silently re-open the full finding. Narrow `trustProxy` to the
proxy's address or subnet, and add `header_up X-Forwarded-For {remote_host}` in Caddy so the
guarantee is stated rather than inherited.

### M-2 — `/run/secrets/master_key` is mode 0444 inside the container

Observed: `-r--r--r-- 1 node node 64 /run/secrets/master_key`. `justfile:147` runs
`chmod 0444` on the generated secrets immediately after setting `umask 077`, and
`packages/config/src/schema.ts:208` and `.env` both document 0400. Every process in the api
container can read the KEK passphrase regardless of uid. The container runs a single uid today, so
impact is low; the deviation from the documented posture is real and was introduced deliberately by
that `chmod`.

### M-3 — Caddy's `/api/*` block is dead, and the live path sets no `X-Forwarded-Proto`

`docker/Caddyfile:62-66` proxies `/api/*` to `api:8080` **without stripping the prefix**, and the
API mounts routes at `/auth/*` with no `/api` prefix. Verified:

```
GET /api/auth/unlock-state -> 404 route_not_found
GET /auth/unlock-state     -> 200
```

So every real request lands on the catch-all at line 70, which is the only block that does **not**
set `header_up X-Forwarded-Proto https`. Two consequences: the `/api/*` block is dead code that
looks load-bearing, and `request.protocol` is `http` for every request the API actually serves.
Nothing depends on that today (`SESSION_COOKIE_SECURE` is config-driven), but it is a trap for the
first thing that does.

### M-4 — refresh rotation is select-then-update, not atomic

`packages/contexts/identity/src/sessions.ts:200-245`. `refresh()` `SELECT`s the row, checks
`superseded_by IS NULL AND revoked_at IS NULL`, then `INSERT`s the new generation and `UPDATE`s
the old one — in separate statements with no transaction and no conditional update. Two concurrent
presentations of the same refresh token can both pass the check before either writes, yielding two
live generations in one family and **no** `session.reuse_detected` event.

The file's header calls reuse detection "the single highest-value detection in the system," and it
is right. An attacker holding a stolen refresh cookie who races the legitimate client evades the
one control designed to catch exactly that. Fix: make the claim the atomic operation —
`UPDATE sessions SET superseded_by = $new WHERE id = $1 AND superseded_by IS NULL AND revoked_at
IS NULL RETURNING id` — and treat zero rows as reuse.

### M-5 — `webhooks-placeholder` is on `backend`, contradicting its own comment

`compose.yml:350` versus the comment at `:313-316`, which states these placeholders "never reach
`backend` (db) or `frontend`." `sidecar-placeholder` and `local-llm-placeholder` honour that;
`webhooks-placeholder` does not. It is also the one placeholder destined to become an
internet-reachable service. When a real listener replaces the `sleep infinity`, an RCE in it
reaches Postgres directly with no pivot.

### M-6 — `THIRD_PARTY.md` embeds the wall-clock date, so the license gate fails tomorrow

`scripts/check-licenses.ts:231` renders `new Date().toISOString().slice(0,10)` into the artifact;
CI regenerates it and runs `git diff --exit-code`. The committed file reads "as of 2026-09-12".
Every PR from tomorrow onward fails on a one-line date diff regardless of whether the lockfile
changed. The fastest path out is deleting the drift check, which removes the control. Derive the
date from the lockfile hash, or drop it.

### M-7 — CSP nonce is an inert literal, and `style-src` will break the SPA

`docker/Caddyfile:55` emits `'nonce-{nonce-placeholder}'`. Nothing substitutes it — the Caddyfile's
own comment at :44-45 concedes the tooling is "tracked, not yet wired." `{` and `}` are outside the
CSP base64 grammar, so browsers discard the source expression and the effective policy is
`script-src 'self'`, which is fail-safe by luck. The hazard is the obvious fix: baking a constant
value into the image makes the nonce public and strictly _weaker_ than `'self'` alone. Recommend
deleting the nonce tokens until per-request generation exists.

Separately, `style-src 'self'` with no `style-src-attr` split will break two runtime `<style>`
injectors present in the built bundle (sonner, and `react-remove-scroll-bar` via Base UI Dialog).
Both the idle-lock warning and the service-worker update prompt are toasts, so the security-relevant
failures are: the only pre-lock warning renders unstyled, and the only mechanism for accepting a new
frontend bundle breaks. `docs/security/csp-nonce-strategy.md:32` already specifies the correct
policy (`style-src-attr 'unsafe-inline'`); the deployed Caddyfile does not match it.

### M-8 — `apps/web`: no route guard, no logout, no cache clear on lock

Three related gaps, none exploitable today because every screen is a placeholder, all of which
become real the moment a financial endpoint is wired:
`apps/web/src/routes/_app.tsx:12-17` has no `beforeLoad` guard and `useSessionQuery` has zero call
sites; `useLogoutMutation` has zero call sites and there is no sign-out control; and
`IdleLockOverlay` never calls `queryClient.clear()`, while `query-client.ts:8` sets
`refetchOnWindowFocus: true` — so a locked session would keep refetching balances behind the
overlay. Also `sw.ts:34` guards `/api/` while every real call is `/auth/` (M-3's other half), so
the "no financial data in the Cache API" rule matches nothing.

To be explicit about one thing the brief asked: **the client-side idle lock is decorative.** It is
a `position: fixed` div; it is bypassable by deleting the node, by reloading, or by calling the API
directly. That is _acceptable_ — it is a shoulder-surfer control and the real boundary is the
server's 15-minute idle expiry — but it must never be described to a user as a security boundary.

### Clean passes worth recording

Probed adversarially and found sound:

- **Cipher and chokepoint.** XChaCha20-Poly1305 via `@noble/ciphers`; `aead_seal`/`aead_open` take
  a mandatory (not optional) AAD; `aeadOpen` returns `null` on every failure mode so a wrong KEK,
  a wrong AAD and a truncated buffer are one answer. 24-byte random nonces, so no counter
  discipline is needed. The one-file chokepoint with an ESLint deny elsewhere is the right shape.
- **Wrong KEK fails closed.** `SecretBox.unlock` verifies a sealed constant _before_ installing the
  key and wipes the derived bytes on mismatch, so a bad passphrase leaves the holder locked rather
  than unlocked-with-a-useless-key.
- **KEK exposure paths.** The key lives in one `Uint8Array` behind `KekHolder`, reachable only via
  `use()`; there is no getter; `toJSON`, `toString` and the Node inspect hook all return
  `[KekHolder]`. It is never placed on `config`. `Redacted<T>` is frozen and covers the same three
  serialisation paths. `describeConfig` spreads only `PublicEnvironmentConfig`, from which
  `DATABASE_URL` has been destructured out. `reveal()` is called in exactly one place and feeds
  the KDF directly.
- **WebAuthn.** `residentKey: 'required'` + `userVerification: 'required'` + `requireUserVerification`
  on both verify paths; RS256 (-257) deliberately absent; origin verified against the config
  allow-list; RP ID pinned; challenges stored in a table with a 5-minute TTL and burned by
  `UPDATE ... RETURNING ... FOR UPDATE SKIP LOCKED`, so two concurrent requests cannot claim the
  same one; counter regression rejected with the correct `storedCounter > 0n` exemption for
  always-zero platform authenticators; credential-ID uniqueness enforced before insert;
  `excludeCredentials` populated; the last passkey cannot be removed. The client takes its
  challenge from the server response and never generates one.
- **TOTP replay.** `last_used_step` is persisted and `step <= lastUsedStep` is refused, so a code
  cannot be replayed inside its own window; `window: 1` and no wider.
- **Session fixation.** Every login mints a fresh family and fresh random tokens; no caller-supplied
  identifier is ever adopted. Not possible.
- **CSRF hook ordering.** `assertCsrf` is registered at the root in `app.ts:154`, so it covers every
  future router rather than the auth routes alone; safe methods short-circuit on a `Set.has`. Three
  layered controls (`Sec-Fetch-Site`, `Origin` allow-list, double-submit) with an explicit
  fail-closed branch when neither browser signal is present, and the token comparison hashes both
  sides first so `constantTimeEqual` sees fixed-length inputs.
- **Bootstrap token.** 32 CSPRNG bytes, SHA-256 at rest, 1-hour TTL, single-use enforced by
  `UPDATE ... WHERE used_at IS NULL ... RETURNING`. Brute force is infeasible independent of rate
  limiting.
- **Entrypoint injection.** `ROLE` only indexes a literal map with an explicit `undefined` check
  and `exit 78`; `import()` can receive one of three hardcoded paths. No shell, no `spawn`, no
  `eval`.
- **SQL.** Every statement in `secretbox`, `identity` and `platform` is parameterised. No string
  interpolation of user input anywhere I read. `assertIanaZone` even rejects `|`, the AAD
  separator, on a user-controlled timezone string — that is genuinely thoughtful defence.
- **Error taxonomy.** `toProblemError`'s default arm flattens everything to
  `401 invalid_credential`, so "no such credential", "bad signature" and "spent recovery code" are
  indistinguishable. Paired with a 250 ms failure-latency floor.
- **Unauthenticated surface.** Exactly `/health`, `/ready`, `/auth/unlock-state`, and the `/auth/*`
  login and registration POSTs. Everything else 401s. No Swagger UI is served — `/documentation`,
  `/documentation/json`, `/openapi.json`, `/swagger.json` all 404. `/health` and `/ready` expose
  only operational metadata (version, migration status, queue depths); no PII.
- **Frontend token handling.** Zero `sessionStorage`, zero `indexedDB`, no cookie written from JS,
  no token on a global. The only `localStorage` keys are theme, hide-amounts, and sidebar collapse.
  The only `document.cookie` read is the CSRF token, which is JS-readable by design. Zero
  `console.*` calls. Zero `dangerouslySetInnerHTML`, `eval`, `new Function`, `innerHTML`. No
  third-party origins: no CDN, no fonts, no analytics, no Sentry; the font is self-hosted.
- **Supply chain.** `ignore-scripts=true` in `.npmrc`, `allowBuilds` with all three entries
  `false`, and a forced 995-package reinstall confirmed to run zero build scripts with
  `pendingBuilds: []`. Every GitHub Action pinned to a 40-character SHA; every base image and
  container tool pinned by digest. No `pull_request_target`; no untrusted interpolation into any
  `run:` block; `permissions: contents: read` at workflow level; `persist-credentials: false` on
  every checkout; zero `continue-on-error`. Renovate's 7-day `minimumReleaseAge` is global and is
  not bypassed by `vulnerabilityAlerts`. The license gate scans prod and dev, fails on `UNKNOWN` in
  both, and evaluates deny before allow.

---

## 4. What I fixed in place

Four changes, all minimal, all with a guarding test or a reproducible command. `just check` is
green: **430 tests passing** (418 + 12), up from 428 — the two new ones are F-1's regression tests.

### F-1 — `master_key` was required for every role, so the migrator could not boot

`packages/config/src/schema.ts`, `packages/config/src/load.ts`.

`SECRET_SPECS` marked `master_key` `required: true` unconditionally. `compose.yml:226` grants the
migrator `secrets: [database_url]` only — correctly, since it applies DDL and never unwraps a DEK.
So `loadConfig()` threw before the first migration and the container exited non-zero. Because
`api` and `worker` both gate on `migrator: service_completed_successfully`, the entire stack never
started.

Observed before the fix:

```
migrator-1 | configuration is invalid; 1 problem(s) found:
migrator-1 |   - secret:master_key: is missing
```

Changed `required: boolean` to `requiredForRoles: readonly ROLE[]`, set to `['api','worker','cli']`.
The alternative — mounting the passphrase into the migrator — would hand the key that opens every
provider credential to a container with no use for it, so it was rejected.

**Guarded by** two new tests in `packages/config/src/load.test.ts`:
`'starts the migrator with only the secrets compose grants it (no master_key)'` and
`'still refuses to start api, worker or cli without the passphrase'`. The pre-existing
`'accepts every role the entrypoint ... can produce'` test did not catch this because its
`secretsFrom` helper supplies `master_key` by default — it only ever asserted against a secrets
directory richer than the one the migrator actually gets.

### F-2 — the api image pruned `@ctx/identity`, which the API imports on its first line

`docker/api.Dockerfile`, `docker/entrypoint.mjs`.

The deploy stage ran `rm -rf ... packages/contexts ...` against a hardcoded list, with a comment
asserting the production closure is "exactly five projects." `apps/api` has since grown
dependencies on `@core/platform`, `@core/secretbox` and `@ctx/identity`. The image therefore
shipped an `apps/api` whose first import chain — `auth/runtime.ts` → `@ctx/identity` — resolved to
a symlink into a directory that line had just deleted:

```
api-1 | entrypoint: ROLE=api target "./apps/api/src/main.ts" does not exist in this image yet.

$ docker run --entrypoint node personalfi/api:dev -e "import('/app/apps/api/src/main.ts')..."
CODE: ERR_MODULE_NOT_FOUND
MSG:  Cannot find package '@ctx/identity' imported from /app/apps/api/src/auth/runtime.ts
```

Replaced the hardcoded prune with a keep-set **asked of pnpm**, since a hand-maintained list of a
computed set will rot the same way again:

```
keeping workspace projects:
apps/api  packages/config  packages/kernel  packages/contracts
packages/db  packages/platform  packages/secretbox  packages/contexts/identity
```

Also fixed `entrypoint.mjs`, which reported _any_ `ERR_MODULE_NOT_FOUND` in the whole import graph
as "the target does not exist." That wrong answer cost a full rebuild cycle to disprove; it now
checks whether the target actually exists and otherwise prints what Node failed to resolve.

**Guarded by** the build itself: the `RUN` step asserts the keep-set is non-empty and contains
`apps/api`, and fails the build otherwise. A booted, healthy api container is the end-to-end proof.

### F-3 — the api and worker memory limits were below the Argon2id floor, so the KEK derivation was OOM-killed

`compose.yml:181` (768M → 1536M) and `:209` (512M → 1536M).

`KEK_ARGON2_MEMORY_KIB` defaults to 1 GiB and `KEK_ARGON2_FLOORS.production` _requires_ ≥1 GiB, so
the derivation cannot be made to fit. Measured against the exact compose limits:

```
--memory=768m   exit=137   <no output: process killed>     (api's limit)
--memory=512m   exit=137   <no output: process killed>     (worker's limit)
--memory=1200m  exit=0     RESULT: DERIVED ok in 6723 ms
```

Exit 137 is SIGKILL from the kernel OOM killer. Because `/auth/unlock-state` initialises the
keyring lazily, **an unauthenticated GET was a remote kill switch for the API** — I reproduced the
restart loop, observing `RestartCount` climb on each request.

After the fix, the same endpoint returns `{"state":"unlocked","bootstrapped":true,"kekVersion":1}`
and the boot log carries the P0-2 evidence line.

**Flagged for the orchestrator, not decided by me:** 1536M is a _limit_, not a reservation, and the
1 GiB is a boot-time spike. But api and worker both derive the KEK, so a simultaneous cold start
peaks near 2.4 GiB against the "whole stack under 2 GB RAM" target in plan §3.4. If that target is
hard, the lever is `KEK_ARGON2_MEMORY_KIB` and the production floor — a security parameter — or
staggering the two derivations. That is a decision above a reviewer's pay grade; I left a comment
in `compose.yml` saying so.

### Verification after all four

```
$ bash scripts/compose-hardening-check.sh   -> PASS
$ docker compose config -q                  -> valid
$ just check                                -> EXIT=0
   Test Files  38 passed (38)   Tests  418 passed (418)
   Test Files   4 passed  (4)   Tests   12 passed  (12)
```

The compose stack was torn down with `docker compose --profile sidecar --profile local-llm down -v`;
no `personalfi_*` networks or volumes remain.

---

## 5. What remains for the orchestrator

Blocking the GO, in the order I would fix them:

1. **P0-4 / config** — set `AUTH_RP_ID` and `AUTH_ALLOWED_ORIGINS` in `compose.yml`, then actually
   enrol two passkeys and generate ten recovery codes through the booted stack. Needs Chris's
   hostname decision and a call on whether the Tailscale MagicDNS name is a second allowed origin.
   _Until this is done nobody has ever logged into this application._
2. **P0-11 / backups** — H-2 (`pipefail` + verify before `mv`) and H-5 (make the drill assert), then
   re-run the drill against a migrated database and replace the evidence artifact showing non-zero
   table counts on both sides.
3. **P0-10 / gitleaks** — scrub the enrolment token from `docs/evidence/phase-0/wp0.2-summary.md:96,98`
   and add reviewed `.gitleaksignore` fingerprints for the two test fixtures. Then confirm the CI
   job is green, because it is red at HEAD.
4. **H-1 / compose-hardening-check** — the P0-6 gate currently passes a privileged, host-networked,
   Docker-socket-mounting service. Rewrite against `docker compose config --format json`.
5. **H-3 / log redaction** — fix before the first Plaid call, not after.
6. **H-4 / Caddy headers** — factor the header block into a snippet imported by both site blocks.
7. **M-4 / refresh TOCTOU** — make the supersede an atomic conditional update.
8. **M-6 / THIRD_PARTY.md date** — fix before it trains everyone to delete the drift gate.
9. **M-1, M-2, M-3, M-5, M-7, M-8** as capacity allows; none block Phase 1 start, all should close
   before v0.9's external review.

Process observation worth more than any single finding: **`just check` does not run gitleaks,
trivy, the license gate, or the compose-hardening check.** Those are CI-only. A green `just check`
was being read as a green pipeline, and CI has been red at HEAD. Either add a `just ci` that runs
the full set locally, or make the phase-gate checklist require a green Actions run rather than a
green `just check`.

---

## 6. Dependency-count baseline (for P2-10)

Recorded so the budget has a number to measure drift against.

| Metric                                                            | Count    |
| ----------------------------------------------------------------- | -------- |
| Workspace projects (lockfile `importers`)                         | **22**   |
| Lockfile `packages:` entries                                      | **993**  |
| Lockfile `snapshots:` entries                                     | **668**  |
| Packages materialised by `pnpm install --frozen-lockfile --force` | **995**  |
| Real package directories under `node_modules/.pnpm`               | **1013** |
| **Direct production dependencies, deduped, external**             | **49**   |
| Direct production dependencies including workspace-internal       | 50       |
| **Direct devDependencies, deduped, external**                     | **38**   |
| License-gate package entries, prod                                | 260      |
| License-gate package entries, dev                                 | 622      |

The 49 external production dependencies:

`@base-ui-components/react`, `@fastify/cookie`, `@fastify/swagger`, `@hey-api/client-fetch`,
`@hookform/resolvers`, `@noble/ciphers`, `@noble/hashes`, `@simplewebauthn/browser`,
`@simplewebauthn/server`, `@tanstack/react-query`, `@tanstack/react-router`,
`@tanstack/react-table`, `@tanstack/react-virtual`, `@visx/axis`, `@visx/brush`, `@visx/curve`,
`@visx/event`, `@visx/gradient`, `@visx/group`, `@visx/responsive`, `@visx/scale`, `@visx/shape`,
`@visx/tooltip`, `class-variance-authority`, `clsx`, `cmdk`, `cron-parser`, `d3-array`, `d3-scale`,
`d3-shape`, `d3-time-format`, `date-fns`, `decimal.js`, `drizzle-orm`, `fastify`,
`fastify-type-provider-zod`, `hash-wasm`, `lucide-react`, `openapi-types`, `otpauth`, `pg`, `pino`,
`react`, `react-dom`, `react-hook-form`, `sonner`, `tailwind-merge`, `uuid`, `zod`

Note for anyone reading the budget later: the **api runtime image ships far fewer** than 49, because
`api.Dockerfile` installs with `--prod --filter-prod=@app/api...`, which excludes the entire
React/visx/d3 frontend tree. The 49 is the workspace-wide direct count.

No package carries a license or provenance concern. The gate's `denyPackages` list does contain
four entries (`ofxtools`, `fuzzywuzzy`, `python-Levenshtein`, `beancount`) that are PyPI packages
and can never match an npm scan, and its matching is exact rather than prefix — so `beancount`
misses `beancount-parser` and `Levenshtein` misses the npm-realistic `js-levenshtein` /
`fastest-levenshtein` / `leven`. `hyperformula` is the only deny-list entry that can actually fire.
Worth tightening, not blocking.

---

## 7. Verdict

### NO-GO on "Phase 0 complete: safe to begin Phase 1"

Four P0 items are FAIL and two are PARTIAL. The decisive one is P0-4: **no passkey has ever been
enrolled through this stack**, because the compose file does not configure the WebAuthn RP ID or
the CSRF origin allow-list. Phase 0's exit criterion — "`docker compose up` on a clean box yields
a passkey login over TLS in under 60 s" — is not met, and the v0.1 rung of the release ladder is
not reached. P0-11 compounds it: the committed restore-drill evidence records a drill that
restored zero tables and could not boot an API, and reported success.

None of this is a design failure. The architecture is sound and the security-critical code is
better than most of what I review. It is an integration failure — compose wiring, image assembly,
and four gates that were written but never executed — and it is a few days of work, not a rethink.

### Conditional GO on creating Plaid **Sandbox** credentials, now

Sandbox carries no real financial data, no real account access, and no money movement, and it does
not consume any of the ten Production Item slots. The P0 checklist exists to gate _Production_
credentials, and the plan is explicit that Sandbox signup runs in parallel with Phase 0. Nothing in
this review makes creating Sandbox credentials risky. Doing it now unblocks Phase 1 preparation
while the six items above are closed.

Condition: Sandbox credentials must be delivered through the existing Docker-secret path and
`SecretBox`, never through an environment variable — the same rule as every other credential.

### NO-GO on Plaid **Production** credentials, and that remains true after the fixes above

Production additionally requires the four hand actions that are Chris's alone and that no agent can
perform or verify from this repository:

- **LUKS2** on the `pgdata` and backup volumes (P0-13) — the at-rest layer beneath everything
  `SecretBox` does.
- **Tailscale** HTTPS + MagicDNS with a bland node name (it appears in CT logs), and
  `tailscale serve`, never `funnel`.
- **Real secrets** — a high-entropy `master_key` from `systemd-creds`, replacing the throwaway
  development values currently in `./secrets/`, and a real `age` recipient keypair whose private
  half never enters the compose project.
- **Backblaze B2** bucket with object lock, and the first successful off-site upload.

Recommended sequence: close items 1–3 of §5 → re-run this gate's runtime checks → create Sandbox
credentials and begin Phase 1 → complete the four hand actions → close items 4–6 → only then
request Production.

---

_Method note: every command in this document was run against HEAD plus the four fixes in §4, on a
stack booted from `compose.yml` with throwaway secrets and torn down with `docker compose down -v`
afterwards. Where a prior evidence document and a command disagreed, the command won — which is how
F-1, F-2, F-3 and the withdrawal of C-1 were all found._
