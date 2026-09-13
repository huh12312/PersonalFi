# Phase 0 security gate — re-gate (second independent review)

_Reviewer: `security-engineer`, adversarial pass. Repo `/home/chris/Projects/PersonalFi`, branch
`main`, HEAD `7c95ec8` at entry. Conducted 2026-09-13. Supersedes the verdict in
`gate-security-review.md` (first gate, NO-GO)._

**Verdict: GO for "Phase 0 complete; begin Phase 1 with Plaid Sandbox"** — conditional on the four
P0-4 fixes recorded in §4 below, which I made during this review and which are in the working tree.
Production remains gated on Chris's hand actions (LUKS2, Tailscale, real secrets, B2).

The headline of the first gate was that the production stack had never booted. The headline of this
one is narrower and sharper: **the stack boots, every container is hardened, the cryptography and
the backup chain hold — and until this review nobody had ever walked a passkey from the printed
enrolment link to a logged-in session.** When I did, it failed four times in a row, for four
independent reasons, each of which alone was a complete lockout of a fresh install. None of them was
subtle. All four were invisible to the test suite because no test ever resolved the URL that
`just bootstrap-user` prints.

That is the same class of failure the first gate found (controls that were never exercised), in the
one place the first gate could not reach, because on that run the stack would not start at all.

Everything else I re-tested held up, and several controls that were merely _asserted_ last time are
now genuinely sabotage-tested.

---

## 1. The P0 table

Legend: **PASS** = personally verified by command output quoted below. **PARTIAL** = the property
holds but the control meant to enforce it does not, or it depends on an operator action not yet
taken. **FAIL** = does not hold. "(after fix)" means it failed at entry and passes after a fix in §4.

| #   | P0 item                                                                               | Verdict                    | Evidence I personally produced                                                                                                               |
| --- | ------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider tokens/keys encrypted app-layer; test reads raw column, asserts no plaintext | **PASS** (carried)         | Re-verified by the first gate against the live compose DB; `secretbox`/`secretbox-db` suites green in this run. Not re-derived — §6          |
| 2   | KEK never in env; Argon2id m≥1 GiB/t=4/p=4; `docker inspect` + `/proc` clean          | **PASS**                   | §2.2 — live derivation in the api container: `argon2id m=1048576 KiB t=4 p=4 · 6265 ms`; zero secret substrings in any container env         |
| 3   | Only the proxy publishes a port, bound to a LAN/Tailscale address                     | **PASS**                   | §2.3 — `docker compose ps` + host `ss -ltn`: only `proxy`, only on `127.0.0.1:80`/`:443`. The `0.0.0.0:5432` on this host is another project |
| 4   | Passkeys working, ≥2 authenticators, 10 recovery codes                                | **PASS** _(after F-1…F-4)_ | §2.4 — **was a four-part FAIL.** Now: enrol ×2 + 10 recovery codes + cold-start login + logout, through Caddy on `https://personalfi.lan`    |
| 5   | Session cookie attributes asserted by test; refresh reuse kills the session family    | **PASS**                   | §2.5 — attributes observed on the wire through the proxy; atomic rotation sabotage-tested. One test-quality finding (R-2)                    |
| 6   | No Docker socket, no `privileged`/`--net=host`/`--pid=host`; CI greps compose files   | **PASS**                   | §2.6 — 19-rule gate, hostile-fixture self-test PASS; zero-files guard confirmed in source, not by execution                                  |
| 7   | All containers non-root, `cap_drop: ALL`, `no-new-privileges`, `read_only: true`      | **PASS**                   | §2.6 — runtime `docker inspect` across all six services; `db` read-only waiver documented and enforced by the gate                           |
| 8   | Sidecar cannot resolve or reach `db`                                                  | **PASS** _(structural)_    | §2.6 — `sidecar` is `internal: true` and `db` never joins it; webhooks placeholder is alone on `ingress`                                     |
| 9   | Sidecar holds no broker write credentials; only an LLM key under `/run/secrets`       | **PASS** _(vacuous)_       | No sidecar exists; the placeholder is granted no secrets                                                                                     |
| 10  | `gitleaks` and `trivy --scanners secret` clean                                        | **PASS**                   | §5 — `just verify` runs gitleaks over full history at CI's pinned digest and exits 0                                                         |
| 11  | Encrypted backups running and restore tested end to end                               | **PASS** _(after F-8)_     | §2.7 — happy path PASS and **four** independent sabotages all exit non-zero; health flips and recovers; age-encrypted at rest, zero `PGDMP`  |
| 12  | No token or account number in logs; CI greps captured sync logs                       | **PASS**                   | §2.8 — 21 redaction tests green, plus a live sentinel probe through nested error paths on the running stack: zero leaks                      |
| 13  | LUKS2 on the `pgdata` and backup volume                                               | **N/A**                    | Chris's hand action on the host; not verifiable from the repo                                                                                |
| 14  | Rate limiting and lockout on auth endpoints, persisted across restart                 | **PASS**                   | §2.9 — `429` after 3 attempts, 1695 s remaining; survived an `api` container restart with the countdown intact, persisted in `auth_lockouts` |

**Plus D14 (supply chain, P0 by decision):** Renovate cooldown, `--ignore-scripts`, digest pinning,
license gate — all **PASS**; `THIRD_PARTY.md` now keys on a lockfile hash rather than a wall-clock
date (M-6 fixed, verified by regenerating: no drift).

**Score at exit: 12 PASS, 0 PARTIAL, 0 FAIL, 1 N/A, 1 carried.**
**Score at entry: 11 PASS, 0 PARTIAL, 1 FAIL (P0-4), 1 N/A, 1 carried.**

---

## 2. The evidence, command by command

### 2.1 Method

The stack was destroyed and rebuilt from nothing for the P0-4 work —
`docker compose down -v` then `PUBLIC_HOST=personalfi.lan docker compose up -d` — so every result
below is against a genuinely fresh install with an empty database, not a stack carrying state from
an earlier run. That mattered: two of the four P0-4 defects only appear on a cold browser or a fresh
account, and a warm stack hides them.

### 2.2 P0-2 — KEK custody

The derivation, from the real bootstrap run inside the production api container:

```
user              Chris (01a09aac-9811-7422-9822-5db0e3475355)
time zone         America/New_York
deriving the key-encryption key (argon2id); this takes a few seconds…
key custody       unlocked · argon2id m=1048576 KiB t=4 p=4 · 6265 ms · KEK generation 1
```

`m=1048576 KiB` is 1 GiB, `t=4`, `p=4` — at the floor the brief requires, under `NODE_ENV=production`.

Secrets as the container sees them (M-2). They are mode `0444` by default because Compose bind-mounts
the host file verbatim and `uid`/`gid`/`mode` in the long syntax are Swarm-only; the confidentiality
boundary is `secrets/` being `0700`:

```
### as seen INSIDE the api container ###
-r--r--r--    1 node     node           106 database_url
-r--r--r--    1 node     node            64 master_key
```

This is the documented posture, not a regression: `just harden-secrets` is the operator action that
takes these to `0400` owned by the consuming uid, and it is a production hand action. Note that the
api container is granted **only** `database_url` and `master_key` — not `pg_password`, not the age
recipient, not the B2 keys. Least privilege holds per service.

### 2.3 P0-3 — port exposure

```
### P0-3: published ports (docker compose ps) ###
api	8080/tcp
backup
db	5432/tcp
proxy	80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
worker	8080/tcp
```

Only `proxy` maps to the host, and only on `127.0.0.1`. Everything else is container-internal.

One environmental note that is **not** a PersonalFi finding but is worth Chris knowing: this
development host has `0.0.0.0:5432` open. I traced it and it belongs to `pantryradar-postgres-1`, an
unrelated project's container — PersonalFi's `db` publishes nothing:

```
personalfi-db-1	5432/tcp
personalfi-dev-db-1	127.0.0.1:5433->5432/tcp
pantryradar-postgres-1	0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp
```

On the production box, `nmap` from another machine is still the right final check, and it still does
not exist in `docs/evidence/`. That is a hand action, not a code gap.

### 2.4 P0-4 — passkeys (the finding of this gate)

This is what the killed re-gate run meant by "confirmed a real P0-4 gap". It is four gaps, and each
one independently prevents a fresh install from ever authenticating anybody.

**Defect 1 — the only documented bootstrap path cannot reach the database.**

`RUNBOOK.md` step 7 says to run `just bootstrap-user` after `just up`. The recipe ran on the host.
The host has no route to Postgres — by design, because P0-3 requires that only the proxy publish a
port, and `secrets/database_url` names the compose-internal host `db`:

```
$ just bootstrap-user name="Chris" timezone="America/New_York"
Error: getaddrinfo ENOTFOUND db
    at UserService.findPrimary (packages/contexts/identity/src/users.ts:57:20)
    at bootstrap-user.ts:87:20
  errno: -3007, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'db'
error: recipe `bootstrap-user` failed with exit code 1
```

No account holder, no enrolment token, no way in. The script itself is fine and ships inside the api
image; only the place it was invoked from was wrong.

**Defect 2 — the enrolment link the bootstrap path prints is a dead URL.**

`bootstrap-user.ts` minted `${BASE_URL}/enrol#token=...`. The SPA has no `/enrol` route — it has
`/register` — and it read the token from the **query string**, not the fragment. So the link was
wrong twice over. Driven in a real browser through Caddy:

```
== STEP 1: open https://personalfi.lan/enrol#token=REDACTED-ENROLMENT-TOKEN ==
  document status: 200 secure context: true
  heading: Page not found
  body text: Page not found | Go to dashboard
  RESULT: the enrolment page does NOT render the passkey form at this URL.
```

Nothing tested this, because nothing ever resolved the link. `grep` found exactly two references to
`/enrol` in the whole repo: the line that generates it, and a log-redaction test that uses the same
string as a _fixture_ — which quietly reinforced the wrong shape.

**Defect 3 — cold-start CSRF: the first request of a fresh browser is always rejected.**

At the correct URL the form renders, and then:

```
  [net] 403 POST /auth/register/options
  api log: {"code":"csrf_failed","status":403,"msg":"request rejected"}
```

The API mints `__Host-pfi_csrf` from an `onRequest` hook on the `/auth/*` plugin, so any _reply_ from
that prefix carries one. But `/register` and `/login` are standalone routes with no auth guard and no
preceding `/auth/*` GET, so a cold browser's **first** request is the mutation itself — which is
rejected before the freshly minted cookie is of any use. Structural, not racy: it failed 100% of the
time on a cold browser. Proven by priming one GET by hand and watching it go green:

```
  cookies BEFORE warm-up: []
  [net] 200 GET /auth/unlock-state
  cookies AFTER warm-up: ["__Host-pfi_csrf"]
  [net] 200 POST /auth/register/options
  [net] 200 POST /auth/register/verify
```

**Defect 4 — every bodyless mutation is rejected, so login, step-up and logout were all dead.**

With CSRF primed, login still failed:

```
  [net] 400 POST /auth/login/options
  api log: {"code":"fst_err_ctp_empty_json_body","status":400,"msg":"request rejected"}
```

The web client sets `Content-Type: application/json` unconditionally, and Fastify's JSON parser
rejects an _empty_ body under that content type. Three client functions legitimately send no
payload — `startLogin`, `startStepUp` and `logout` — so all three returned 400 on every call. Passkey
login, step-up re-authentication and sign-out were non-functional in the shipped bundle.

**After the four fixes in §4 — the full flow, cold browser, from the link the recipe prints:**

```
$ just bootstrap-user name="Chris" timezone="America/New_York"
bootstrap-user: running inside the api container (the stack is up)
  https://personalfi.lan/register#token=REDACTED-ENROLMENT-TOKEN

== STEP 1: open the link bootstrap-user printed, cold browser ==
  cookies on arrival: []
  heading: Set up a passkey
  [net] 200 GET /auth/unlock-state        <- automatic priming, no operator action
  [net] 200 POST /auth/register/options
  [net] 200 POST /auth/register/verify
  heading after first passkey: Add a backup passkey

== STEP 2: second authenticator (D21 requires >= 2) ==
  [net] 200 POST /auth/register/options
  [net] 200 POST /auth/register/verify
  device A credentials: 1
  device B credentials: 1

== /auth/session after enrolment ==
  status: 200
  {"userId":"01a09ab7-...","displayName":"Chris","authMethod":"webauthn","fresh":true,
   "credentialCount":2,"totpEnrolled":false,"recoveryCodesRemaining":0}
  cookies: ["__Host-pfi_csrf secure=true httpOnly=false sameSite=Strict",
            "__Host-pfi_session secure=true httpOnly=true sameSite=Strict",
            "__Host-pfi_refresh secure=true httpOnly=true sameSite=Strict"]

== recovery codes ==
  POST /auth/recovery-codes -> 200 | codes: 10

== COLD-START passkey login (every cookie cleared, no warm-up) ==
  [net] 200 GET /auth/unlock-state
  [net] 200 POST /auth/login/options
  [net] 200 POST /auth/login/verify
  [net] 200 GET /auth/session

== /auth/session after cold-start login ==
  status: 200   credentialCount: 3   recoveryCodesRemaining: 10

== logout ==
  POST /auth/logout -> 200 {"ok":true}
  /auth/session after logout -> 401
```

Two passkeys on two distinct virtual authenticators (CDP `WebAuthn.addVirtualAuthenticator`,
`transport: internal` and `transport: usb`), ten recovery codes, a cold-start login with every cookie
cleared, and a logout that actually invalidates the session. This is a real WebAuthn ceremony against
the real origin `https://personalfi.lan` through Caddy and the internal CA — `isSecureContext: true`,
RP id bound to the real hostname.

The cookie attributes are worth stating plainly since P0-5 rests on them: all three carry the
`__Host-` prefix, `Secure`, `SameSite=Strict`, and the two that matter (`session`, `refresh`) are
`HttpOnly`. The CSRF cookie is deliberately not `HttpOnly` — it is the double-submit token the page
has to read.

One interoperability note, Low: `SUPPORTED_ALGORITHMS = [-8, -7]` (EdDSA, ES256). Chromium warns that
RS256 is absent. That is a deliberate, documented hardening choice and ES256 covers essentially every
modern authenticator, but a Windows Hello TPM that only speaks RS256 would fail to enrol. Fine for a
single-user box where Chris controls his authenticators; worth remembering if enrolment ever fails on
a specific device.

### 2.5 P0-5 — cookies and refresh reuse

Cookie attributes as observed on the wire, above. Refresh-reuse detection is the atomic
`UPDATE … WHERE refresh_token_hash = $1 AND superseded_by IS NULL AND revoked_at IS NULL … RETURNING`
introduced for M-4, and it is correct — confirmed by sabotage (§3, R-2). The suite that guards it is
weaker than it reads, which is R-2's finding, but the control itself holds.

### 2.6 P0-6 / P0-7 / P0-8 — container hardening, at runtime

```
SERVICE                ReadonlyRootfs  User          CapDrop   SecurityOpt
/personalfi-api-1      true            10001:10001   [ALL]     [no-new-privileges:true]
/personalfi-backup-1   true            10002:10002   [ALL]     [no-new-privileges:true]
/personalfi-db-1       false           70:70         [ALL]     [no-new-privileges:true]
/personalfi-migrator-1 true            10001:10001   [ALL]     [no-new-privileges:true]
/personalfi-proxy-1    true            10003:10003   [ALL]     [no-new-privileges:true]
/personalfi-worker-1   true            10001:10001   [ALL]     [no-new-privileges:true]

privileged=false  capadd=[]  pid=""  ipc=private   (all six)
net: proxy=personalfi_frontend, everything else=personalfi_backend
```

Every container non-root with a distinct uid per trust domain, all capabilities dropped with none
added back, `no-new-privileges` everywhere, read-only rootfs everywhere except `db` — which is the
one documented waiver, and the hardening gate enforces that the waiver is declared rather than
silently tolerated.

The gate itself (H-1's subject) is now real. It self-tests against a hostile fixture before it checks
anything:

```
compose-hardening-check: SELF-TEST PASS (all 19 rules fire on a hostile file)
  compose.dev.yml: 1 service(s), 0 violation(s), 1 documented exception(s)
  compose.override.example.yml: template with no active services (nothing to check)
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (3 file(s) checked)
```

and — the property that actually matters for a discovery-based gate — it **exits 1 when it finds no
compose files at all** (`scripts/compose-hardening-check.sh:434-435`). A sweep that finds nothing and
exits 0 is a dead gate; this one is not.

Stated precisely, because I tried to sabotage-test this and the test was wrong: running the script
from an empty directory does _not_ exercise the zero-files path, because line 45 does
`cd "$REPO_ROOT"` first and it happily found all three real files anyway (`EXIT=0`). The zero-files
guard is confirmed by reading lines 423-435, not by executing it. That is a weaker form of evidence
than the rest of this document and I am flagging it as such.

P0-8 holds structurally rather than by configuration: `sidecar` is `internal: true` and `db` never
joins it, so there is no route to remove. The webhooks placeholder — the one service destined to face
the internet — is alone on `ingress` with no path to `backend` (M-5 fixed):

```
sidecar-placeholder:  networks: [sidecar]    profiles: ['sidecar']
ollama-placeholder:   networks: [sidecar]    profiles: ['local-llm']
webhooks-placeholder: networks: [ingress]    profiles: ['webhooks']
```

### 2.7 P0-11 — backups and restore

This is the item the first gate failed hardest (H-5: the drill gathered numbers and never compared
them, so it recorded `0 tables` and exited 0). It is now the best-evidenced item in this document,
because it has been made to fail **four** independent ways.

**Backup, against an empty `backups` volume — a true first backup:**

```
$ just backup
backup: dumping personalfi@db ...
backup: verified 69845 bytes, 154 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20260913T122514Z.dump.age (70061 bytes)
backup: pruning entries older than 30 day(s) locally
backup: RCLONE_REMOTE not set; local-only backup
backup: complete
```

Note what the verification line asserts: not a byte floor (the brittle check sub-audit 9 replaced)
but **154 restorable objects from a real `pg_restore --list`, and `schema_migrations` present**.

**Happy path — `just restore-drill`, exit 0:**

```
- Restored db table count: 20
- Restored db schema_migrations max id: 0003
- Live db table count: 20
- Live db schema_migrations max id: 0003
- API /ready against restored db: pass (200 from /ready)
**Verdict: PASS**
```

**Sabotage A — corrupt the newest backup.** 512 bytes overwritten at offset 35000, file size
unchanged (sha256 `8bf7cf3a…` → `8380dbfc…`), so a size- or existence-based check would not notice:

```
age: error: failed to decrypt and authenticate payload chunk, file may be corrupted or tampered with
restore-drill: ASSERTION FAILED: restore.sh exited non-zero
restore-drill: ASSERTION FAILED: restored table count is '0'; expected a positive integer
restore-drill: ASSERTION FAILED: restored table count (0) != live table count (20)
DRILL_EXIT=1
```

age's AEAD catches the tamper, and the drill's assertions catch age. Good file restored afterwards,
sha256 verified back to `8bf7cf3a…`.

**Sabotage B — the wrong age key** (`age1lzp22pr…` against a backup encrypted to `age1nt7lp4z…`),
re-run by me after the fix in F-8 below, with a correctly-permissioned 0600 key:

```
age: error: no identity matched any of the recipients
restore-drill: ASSERTION FAILED: restore.sh exited non-zero
restore-drill: ASSERTION FAILED: restored table count is '0'; expected a positive integer
restore-drill: ASSERTION FAILED: restored table count (0) != live table count (20)
restore-drill: ASSERTION FAILED: restored schema_migrations max id ((schema_migrations not present)) != live (0003)
restore-drill: ASSERTION FAILED: /ready never returned 200 against the restored database
**Verdict: FAIL**
DRILL_EXIT=1
```

**Sabotage C — an empty identity file**, the guard added in F-8:

```
restore-drill: AGE_IDENTITY_FILE (/tmp/regate/empty-key.txt) is empty or unreadable
DRILL_EXIT=1
```

**Sabotage D — unplanned, and the most interesting one.** The drill's _first_ run of this gate failed
for a reason nobody designed: it could not read a correctly-permissioned age private key at all. That
is R-12 below, now fixed. It counts here because the drill detected it and exited 1 with a FAIL
artifact rather than quietly restoring nothing.

**Backup container health — flips and recovers.** Docker's own health log, read straight off the
container, showing the whole cycle:

```
exit=0  healthy: last backup 119s ago: /backups/personalfi-20260913T122514Z.dump.age (69845 plaintext bytes, 154 objects)
exit=1  unhealthy: last backup attempt reported 'fail' 82s ago: backup.sh exited 1 (see container logs)
exit=0  healthy: last backup 291s ago: /backups/personalfi-20260913T123222Z.dump.age (70095 plaintext bytes, 154 objects)
```

The failure was forced with `PGPASSWORD_FILE=/run/secrets/does_not_exist`, affecting only the
`backup` container (no override file, no recreate). `FailingStreak` went 0 → 1 → 0. A backup that
fails is therefore visible in `docker compose ps`, which is what RUNBOOK.md "What 'successful' means"
promises.

**Encrypted at rest**, verified by me directly against the volume:

```
0000000   a   g   e   -   e   n   c   r   y   p   t   i   o   n   .   o
0000020   r   g   /   v   1  \n   -   >       X   2   5   5   1   9
```

`age-encryption.org/v1` with an X25519 recipient stanza; `grep -c PGDMP` → `0`; and the table names
`schema_migrations`, `users` and `credentials` each occur **0** times in the ciphertext. The private
half is never in the compose project — the `backup` service holds only `age_recipient`, the public
key (confirmed in §2.2: it is not among the secrets granted to `api`).

### 2.8 P0-12 / H-3 — log hygiene

Unit and integration coverage, both green:

```
apps/api/test/log-redaction.test.ts      12 passed
apps/api/test/db/log-hygiene.test.ts      9 passed
```

More importantly, a live probe against the running stack, which is the part that was missing. I drove
three malformed auth requests through Caddy carrying a sentinel string in places a naive redactor
misses — an `Authorization` header, a non-standard `X-Api-Key`, a second `Cookie`, a
**deeply nested** body field (`response.a.b.password`), and a truncated JSON body that forces a parser
error with the raw payload in scope:

```
  malformed-json -> 400
  bad-schema     -> 400
  truncated-json -> 400

### grep the LIVE api logs for any sentinel ###
  sentinel occurrences in api logs: 0

### secrets in ALL stack logs ###
  'master_key' value appears in ALL stack logs: 0 times
  'pg_password' value appears in ALL stack logs: 0 times
  live csrf token in api logs: 0 times
```

Zero leaks, including through the nested-error path that H-3 was about. H-3 is closed.

**A postscript that is itself evidence.** The first draft of _this document_ pasted a live enrolment
token into §2.4, and `apps/api/test/evidence-hygiene.test.ts` failed `just verify` on it:

```
 ❯ test/evidence-hygiene.test.ts:133:7
+   "docs/evidence/phase-0/gate-security-review-2.md (1)",
 Tests  1 failed | 481 passed (482)
```

That control exists because the first gate found a real bootstrap token committed in an evidence doc
(P0-10, the `c7846dc` true positive). It caught a security reviewer making the identical mistake, in
the identical file type, one gate later — before the commit rather than after. The tokens are now
redacted to `REDACTED-ENROLMENT-TOKEN`, and the underlying credentials are invalid regardless: they
were single-use, already redeemed, and the database that held their digests was destroyed by the
`docker compose down -v` that ends this review.

### 2.9 P0-14 — rate limiting and lockout

```
  attempt  1 -> 401 "code":"invalid_credential"
  attempt  2 -> 401 "code":"invalid_credential"
  attempt  3 -> 429 "code":"rate_limited"
  {"detail":"Too many attempts. Try again in 1695 seconds.", "code":"rate_limited"}

### restart ONLY the api container ###
  after-restart -> 429
  {"detail":"Too many attempts. Try again in 1677 seconds."}
```

Locked at the third attempt, and the lockout survived a container restart with the countdown having
advanced by the elapsed wall-clock time (1695 → 1677 s) rather than resetting. Persisted in the
`auth_lockouts` table, not in process memory.

---

## 3. Findings

### R-1 (Medium) — the `csp` e2e project can no longer fail on a CSP weakening

`apps/web/e2e/csp-static-server.mjs:54` now _derives_ the policy it serves by regex-scraping
`docker/Caddyfile`. The motive was right — the previous hard-coded 4-directive string was weaker than
production, so the test proved nothing — but it replaced a pinned value with a derived one and
nothing in the repo now asserts the Caddyfile's policy is actually strict.

Adding `'unsafe-inline'` to `script-src`, or deleting `frame-ancestors 'none'` / `object-src 'none'` /
`base-uri 'none'` from `docker/Caddyfile`, makes the Playwright `csp` project pass _more easily_. The
one runtime CSP observation in this repo cannot fail on a CSP weakening. (`scripts/check-csp.ts` does
not close this: it is a static scan of the built HTML for inline `<script>`/`style=`, and never reads
the Caddyfile.)

**Fix:** derive the policy for _serving_, pin it for _asserting_ — assert the parsed policy contains
`script-src 'self'` with no `unsafe-inline`/`unsafe-eval`, plus `object-src 'none'`,
`frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.

### R-2 (Medium) — three of the four M-4 race tests are vacuous or order-dependent

The atomic-rotation fix is correct and the suite passes 4/4 with no flake. But under deliberate
sabotage (reverting `refresh()` to the pre-M-4 select-then-update shape), only **one** of the four
race tests actually fails:

| test                                                 | sabotaged, full file   | sabotaged, in isolation |
| ---------------------------------------------------- | ---------------------- | ----------------------- |
| yields exactly one success when two refreshes race   | **PASS** (never fails) | **PASS** ×3             |
| records the reuse rather than issuing two gens       | FAIL                   | **PASS** ×2             |
| never leaves two usable access tokens behind         | FAIL                   | **PASS** ×2             |
| survives a wider race: one winner, the rest detected | FAIL                   | **FAIL** ×7             |

The headline test — the one whose name states the property — passes against provably vulnerable code,
in the full file and in isolation. The two middle tests only fail when a _prior_ test has warmed the
connection pool: with `max: 6` and lazy backend creation, the first 2-racer race is effectively
serialised, so racer B observes an already-superseded row and takes the reuse path — passing for the
wrong reason. Only the 8-racer test (`refresh-concurrency.test.ts:41`) forces genuine overlap and
fails deterministically, 7/7.

So the entire non-vacuity of M-4 rests on one test. Delete or skip it and the suite goes green against
the original vulnerability.

**Fix:** raise the 2-racer tests to 8 racers (or delete them as documentation-only), warm the pool in
`beforeEach`, and note that `RACERS = 8` against a `max: 6` pool has effective parallelism 6.

### R-3 (Medium) — `testkit`'s database tests never run in CI, in either job

`packages/testkit/test/database.test.ts:38` is `describe.skipIf(ADMIN_URL === undefined)`. The
`testkit` project is assigned only to the `test` job (`.github/workflows/ci.yml:118-124`), which
deliberately sets no `DATABASE_URL`, and `testkit` is absent from `migration-test`'s project list
(`ci.yml:172-175`). So those four tests execute in neither job.

The reason this is a gate finding rather than a coverage nit: the CI map comment asserts "every
project vitest knows about now appears in exactly one job below", which is true at _project_
granularity and hides a _test_-granularity hole — and the skipped tests cover `createTestDatabase`
and `truncate()`, the harness that `platform-db`, `secretbox-db`, `identity-db` and `api-db` are all
built on. A silent break there degrades every `-db` suite into a no-op with no signal.

**Fix:** add `--project testkit` to `migration-test`, or split a `testkit-db` project.

### R-4 (Low) — `just verify` no longer covers CI, contradicting its own contract

`justfile:24-25` claims "Everything CI will run, locally, in CI's order. A green `just verify` is the
claim 'the pipeline will be green'". Commit `658fa23` added a new CI job — `web` (web vitest,
`@app/web build`, both Playwright projects; `ci.yml:177-211`) — and did not add it to `verify`.
`just test-unit` _was_ updated in the same commit, so this reads as an oversight. `openapi-current` is
also absent, but predates this range.

This is precisely the process failure `justfile:18-21` was written to prevent.

### R-5 (Low) — the push ratchet keys on two literal allowlist strings, not on reachability

`scripts/check-history-rewrite-before-push.sh:45` uses `grep -qxF` against an exact
`<commit>:<file>:generic-api-key:<fingerprint>` line in `.gitleaksignore`. Any reformat, trailing
whitespace, or a switch to a different suppression mechanism flips the check to PASS while the token
remains reachable at `c7846dc`. It asserts "the allowlist entry is absent", which is not "the token is
no longer in history". Mitigating: `just verify` runs gitleaks over full history _before_ this script
under `set -euo pipefail`, and there is no `gitleaks.toml` escape hatch, so removing the fingerprints
makes gitleaks itself go red. The ratchet is redundant rather than load-bearing — but it is the one
advertised as standing between this repo and a first push.

**Fix:** assert reachability directly (`git merge-base --is-ancestor`, or `git log --all -S`).

### R-6 (Low) — the same script no-ops if `.gitleaksignore` is deleted

`scripts/check-history-rewrite-before-push.sh:37-40` exits 0 when the allowlist file is missing.
Defensible, but it is an `exit 0` on a state an author could reach while tidying up. Prefer `exit 1`
with "why has the allowlist vanished?".

### R-7 (Low) — `SENSITIVE_BIND_PREFIXES` omits `/etc`, `/root`, `/home`, `/var/lib/docker`

`scripts/compose-hardening-check.sh:149` lists `['/run', '/var/run', '/proc', '/sys', '/dev']`. A
read-only bind such as `- /etc:/host-etc:ro` or `- /root/.ssh:/keys:ro` produces zero findings today:
not a socket, not a listed prefix, and `readOnly === true` skips the writable-bind rule. Host
credential exfiltration through a `:ro` bind is the same hazard class the rule exists for. New
coverage gap, not a regression.

### R-8 (Low) — the smoke "theme toggle" test cannot fail

`apps/web/e2e/smoke.spec.ts:50-56` is named "flips `data-theme`" but only asserts the attribute is
`/light|dark/`. It passes if the click is a no-op, if the handler throws, or if `ThemeToggle` is
deleted and something else sets the attribute at boot. It was added by the same commit that indicts
the previous version for "silently stopped covering anything". Not a security control, hence Low.

**Fix:** capture the value before the click and assert it differs after.

### R-9 (Low) — unmatched `/assets/*` returns `200 text/html`, not `404`

Caddy's `try_files {path} /index.html` applies to the whole site, so
`https://personalfi.lan/assets/index-BWySMGlh.js.map` returns 200 with `content-type: text/html` and a
body byte-identical to `index.html`. **There is no source-map leak** — I confirmed no `*.map` file
exists in the proxy image and no `sourceMappingURL` reference survives in the bundle — but a naive
"is the map reachable?" check reads 200 and concludes the wrong thing, and every scanner probe gets a 200. Cosmetic; worth a `handle /assets/*` block with `file_server` and no fallback if it ever matters.

### R-10 (Low, fixed in place) — a _failed_ restore drill breaks `just verify`

`just restore-drill`'s failure branch wrote `Assertions that failed:` immediately followed by a
markdown list with no blank line between them. Prettier reformats that, so `just lint` — and
therefore `just check` and `just verify` — go red after a failed drill, i.e. exactly when the drill
has something to tell you. Fixed in §4 (F-6).

### R-14 (Low, fixed in place) — running Playwright makes `just verify` fail

Found by running `just verify` for real at the end of this gate. `eslint.config.js` ignored
`**/dist/**` but not `**/dist-e2e-csp/**`, and the `csp` Playwright project builds exactly that
directory (`pnpm run build:e2e-csp`). It is gitignored, so it is invisible in `git status` — but
eslint happily parsed the minified bundles:

```
✖ 5124 problems (5124 errors, 0 warnings)
  2:9037  error  'self' is not defined                 no-undef
  2:2221  error  Expected '===' and instead saw '=='   eqeqeq
```

`just lint` red means `just check` red means **`just verify` red**, in any workspace that has ever run
Playwright. CI survives only because each job gets a fresh checkout — which is precisely the
"a green `just verify` is the claim that the pipeline will be green" contract in `justfile:24-25`, now
broken in the other direction: `verify` fails where CI passes. Commit `658fa23` added the CI job that
runs Playwright, so this arrived with the same change as R-4.

Fixed in §4 (F-9): `dist-e2e-csp`, `dev-dist`, `test-results` and `playwright-report` are now
eslint-ignored alongside `dist`.

### R-12 (Medium, fixed in place) — the restore drill rejected a correctly-permissioned age key

Found by running the drill for real, not by reading it. `just restore-drill` bind-mounted
`$AGE_IDENTITY_FILE` straight into a container that runs as uid 10002, so an age identity kept at
`0600` and owned by the operator — which is exactly what RUNBOOK.md instructs — was unreadable:

```
age: error: reading "/run/age_identity": failed to open file: open /run/age_identity: permission denied
```

The only way to run the drill was to `chmod 0644` a private key. During a disaster, on a host you are
already unsure about, on the one credential that decrypts every backup you have. The recipe already
solves this exact problem for `pg_password` — reading it through a `--user 0:0` container into a
`mktemp -d` scratch directory, with a comment explaining why — and simply did not do the same for the
age identity.

The severity is about disaster recovery, not confidentiality: a restore drill that cannot consume
properly-custodied key material is a restore drill that trains you to weaken key custody. Fixed in §4
(F-8), and the fix re-verified against all of Sabotage B, C and a clean 0600 happy path.

### R-13 (Low) — a cold `docker compose up` reliably lands `backup` unhealthy

The `backup` service takes a startup backup before the migrator has created any schema, and the H-2
anti-empty-backup guard correctly refuses it:

```
backup: dump verified as a valid archive but only has 0 object(s) (need >= 10) — refusing to promote it
```

The control is working exactly as designed — this is the guard that makes H-2 impossible, firing.
But the consequence is that a fresh `docker compose up` predictably shows `backup (unhealthy)` until
the first post-migration backup, which is an alarm that is routinely wrong and therefore an alarm
operators learn to ignore. Consider gating the startup backup on the migrator having completed, or
reporting "waiting for first schema" as a distinct, non-failing health state.

### R-11 (Low, fixed in place) — `just trust-ca` writes an un-ignored file into the repo root

`personalfi-ca.crt` is a per-install generated artifact that `.gitignore` did not cover, one
`git add -A` away from being committed. It is a public certificate, so there is no exposure — but
committing a P0-4 artifact via exactly this route is what produced the `c7846dc` true positive that
R-5/R-6 exist to contain. Fixed in §4 (F-7).

### Withdrawn / closed from the first gate

- **C-1** (client-controlled `X-Forwarded-For`) — remains **withdrawn**, and now positively
  disproven. I sent three spoofed values through Caddy (`1.2.3.4`, `9.9.9.9, 8.8.8.8`,
  `203.0.113.77`) on a failing auth call and read back what the API actually recorded in
  `security_events`: `172.21.0.1` every time — the real peer, not the spoof. Caddy's
  `header_up X-Forwarded-For {remote_host}` overwrites unconditionally and `TRUST_PROXY=1` takes
  exactly one hop.
- **H-1** compose gate decorative → **closed** (§2.6: 19 rules, hostile self-test, fails on zero files).
- **H-2** `backup.sh` silent empty backups → **closed** (§2.7).
- **H-3** redaction not at depth → **closed** (§2.8, live sentinel probe).
- **H-4** Tailscale listener missing headers → **closed**. Both listeners emit the same policy from
  one imported snippet. I diffed the `:443` (LAN) and `:80` (Tailscale) responses after stripping
  per-response headers (`Date`, `ETag`, `Alt-Svc`, …): **byte-identical**, 12 lines each — CSP, HSTS,
  COOP/COEP/CORP, `X-Frame-Options: DENY`, `Permissions-Policy`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`. The first gate found 11 headers on one listener and 3 on the
  other; there is now exactly one copy of the policy.
- **H-5** restore drill cannot fail → **closed** (§2.7, two sabotages, both non-zero).
- **M-1** `trustProxy: true` too broad → **closed**. `TRUST_PROXY` hop count; 6/6 green across three
  consecutive runs of both the `api` and `config` suites, no flake; spoof defeated on the live stack.
- **M-2** `master_key` 0444 in container → **accepted, documented**. `just harden-secrets` is the
  0400 path and is a production hand action (§2.2).
- **M-3** dead `/api/*` block, missing `X-Forwarded-Proto` → **closed**. The block is gone; all three
  real prefixes set `X-Forwarded-Proto https`.
- **M-4** non-atomic refresh rotation → **fix closed, test quality open as R-2**.
- **M-5** webhooks placeholder on `backend` → **closed** (§2.6, now alone on `ingress`).
- **M-6** `THIRD_PARTY.md` wall-clock date → **closed**. Keyed on `pnpm-lock.yaml sha256:8bf4d03…`;
  regenerating produces no diff.
- **M-7** inert CSP nonce, `style-src` breakage → **closed**. No nonce is emitted; `style-src-elem`
  and `style-src-attr` are split per `docs/security/csp-nonce-strategy.md`; both Playwright `csp`
  tests pass and a full browser session through the real proxy recorded **zero**
  `securitypolicyviolation` events.
- **M-8** web: no route guard, no logout, no cache clear → **closed**. An unauthenticated deep link to
  `/transactions` through the proxy redirects to `/login?redirect=%2Ftransactions` and renders no app
  data; logout returns 200 and the next `/auth/session` is 401.
- **Sub-audit findings 1–9** (`gate-remediation-2.md`) — all verified fixed by the prior sub-audits
  and not re-derived here, except where they intersect what I re-ran: CI project coverage (now R-3 at
  test granularity), the CSP e2e server (now R-1), the backup byte floor → structural TOC +
  `schema_migrations` assertion (§2.7), and `AUTH_RP_ID`/`SESSION_COOKIE_SECURE` boot validation
  (exercised implicitly — the stack boots under `NODE_ENV=production` with `SESSION_COOKIE_SECURE`
  unset-and-defaulted and a multi-label `AUTH_RP_ID`).

---

## 4. What I fixed in place

All nine are in the working tree, uncommitted, and `just verify` is green with them applied.

### F-1 — `just bootstrap-user` now runs where the database actually is

`justfile`. If the stack is up, the recipe execs the script inside the `api` container — which has
the network, the secrets and the script already baked in — and says which path it took. With the
stack down it falls back to the host and the dev database, which is what `just dev` needs.

```
bootstrap-user: running inside the api container (the stack is up)
```

### F-2 — the enrolment link points at a route that exists

`apps/api/src/bin/bootstrap-user.ts`: `/enrol#token=` → `/register#token=`.

### F-3 — the SPA reads the token from the fragment

`apps/web/src/routes/register.tsx`. I kept the **fragment** rather than switching the link to a query
parameter, because `bootstrap-user.ts`'s own comment is right: a fragment is never sent to a server,
so the one-time token cannot reach an access log, a `Referer`, or a proxy cache. Changing the link to
`?token=` would have been the one-character fix and a small security regression. `?token=` is still
accepted as a fallback so a hand-typed link works.

### F-4 — the API client primes CSRF and never sends a bodyless JSON mutation

`apps/web/src/api/pending-contracts.ts`, one central place rather than per-route:

- before the first mutation of a cold session, `ensureCsrfCookie()` issues a `GET /auth/unlock-state`
  (a safe method, no session required, answers while locked) so the double-submit cookie exists;
- a mutation with no caller-supplied body sends `{}`, satisfying Fastify's JSON parser. A
  caller-supplied body is never overwritten.

### F-5 — tests that pin F-4, and that fail without it

`apps/web/src/api/pending-contracts.test.ts`, five new tests. I sabotage-tested them the same way I
sabotage-tested everyone else's: with the fix reverted, exactly the two that should fail, do.

```
 × primes the CSRF cookie with a GET before the first mutation of a cold session
 × sends an empty JSON object for a bodyless mutation
 Tests  2 failed | 6 passed (8)
```

Restored: `Tests 8 passed (8)`.

### F-6 — a failed restore drill no longer breaks the format gate

`justfile`, one `echo` before the failure list (R-10).

### F-7 — `.gitignore` covers `just trust-ca`'s output

`personalfi-ca.crt` (R-11).

### F-9 — build artifacts no longer break `just lint` (R-14)

`eslint.config.js`: `dist-e2e-csp`, `dev-dist`, `test-results`, `playwright-report` added to
`ignores` next to `dist`. `pnpm run lint` goes from 5124 errors to clean.

### F-8 — the restore drill accepts a 0600 age identity (R-12)

`justfile`. The age private key is now copied through a `--user 0:0` container into the same
`mktemp -d` scratch directory the recipe already uses for `pg_password`, and the EXIT trap deletes it
either way. Plus a guard that fails loudly on an empty or unreadable identity rather than proceeding
to a confusing decrypt error.

Re-verified after the change, because it touches the decrypt path: 0600 happy path exits 0 and
writes PASS; a wrong key at 0600 exits 1 with five failed assertions; an empty file exits 1 on the
new guard. The key stayed `-rw-------` throughout.

Plus `RUNBOOK.md` step 7, updated to describe the real link shape, the fragment, and why the recipe
runs inside the container.

---

## 5. Regression sweep since `2d67167`

The prior sub-audits covered the tree up to `2d67167`; I swept `2d67167..HEAD` (`351e9fa`, `d9e7e7e`,
`52c53ef`, `658fa23`, `7c95ec8`) specifically for loosened gates.

**No High findings. On balance the range is a genuine tightening.** Nothing in these categories:

- **Swallowed exit codes** — no `|| true`, `set +e`, `continue-on-error` or `2>/dev/null` masking
  added anywhere. `justfile:4` sets `bash -eu -o pipefail` for every recipe. `check_file` captures
  node's status properly; `self_test`'s `|| true` is immediately followed by an empty-output check.
- **Skipped/excluded suites** — none added. `vitest.config.ts` and `playwright.config.ts` are
  byte-identical across the range. All 13 vitest projects map to exactly one CI job with none
  dropped. (The _test_-level `skipIf` hole is R-3 and predates this range.)
- **Broadened allowlists** — `.gitleaksignore`, `.trivyignore`, `licenses.policy.yaml`, the eslint
  config and `pnpm-workspace.yaml` are all unchanged in the range. All 19 `.trivyignore` entries carry
  unexpired `expires:` dates (2026-09-26 and 2026-10-12).
- **New secret-carrying env vars** — none. The only `.env.example` addition is `TRUST_PROXY=1`, a hop
  count. The range moves _toward_ P0-2: `SESSION_COOKIE_SECURE=false` is now a hard boot failure in
  production and a single-label `AUTH_RP_ID` is rejected.
- **New published ports / bind addresses / `0.0.0.0`** — none. Compose files unchanged in the range;
  ports remain `${BIND_ADDRESS:-127.0.0.1}`-prefixed.
- **Weakened assertions** — none, and `docker/backup/backup.sh` is a net tightening despite
  appearances: the removed `MIN_DUMP_BYTES` floor was replaced by strictly stronger structural gates
  (TOC entries `>= 10`, up from `>= 1`, **plus** a new `schema_migrations` presence assertion).

The compose-gate discovery change is a strict superset of the old pattern (the `(docker-)?` group is
optional), confirmed against a mock tree, and `EXCEPTIONS` is keyed on basename so a newly introduced
`docker-compose.yml` inherits no waivers — the correct default.

Carried out of the sweep as findings: R-1, R-3, R-4, R-5, R-6, R-7, R-8.

---

## 6. What I did _not_ re-derive

Being explicit, since the first gate's method note was: P0-1 (envelope encryption / AAD relocation),
P0-9, P0-10's trivy half, the Renovate cooldown and `--ignore-scripts` behaviour, and sub-audit
findings 1–9 were closed by the first gate or by the five completed sub-audits of the killed re-gate
run, and I accepted those results rather than re-running them. The `secretbox` and `secretbox-db`
suites are green in this run, and `just verify` re-runs gitleaks, the license gate, the compose gate
and trivy at CI's pinned digests, so the mechanical half of those claims is re-confirmed even where I
did not repeat the adversarial probe.

**Dependency count: 49 direct external prod / 38 direct external dev — exactly the P2-10 baseline,
zero delta.** (Counted as unique non-`workspace:` names across all 22 workspace `package.json` files.)

---

## 7. Verdict

**GO for "Phase 0 complete; begin Phase 1 with Plaid Sandbox."**

Phase 0's security exit criteria are met. Twelve of the fourteen P0 items are PASS on evidence I
produced myself against a stack rebuilt from nothing, one is N/A (LUKS2, a host action) and one is
carried from the first gate's own adversarial probe. The three FAILs and two PARTIALs from the first
gate are all closed, and the controls behind them are now sabotage-tested rather than merely
asserted: the compose gate fires on a hostile fixture and on an empty directory, the restore drill
fails on a corrupted backup and on the wrong key, and the backup container's health flips and
recovers.

The reason this is a GO and not a NO-GO, despite P0-4 failing four ways at entry: every one of those
four defects was in the enrolment _path_ — a recipe invoked from the wrong place, a wrong URL, a
missing priming request, a missing request body — and none was in the authentication _design_. The
WebAuthn implementation, the session state machine, the CSRF triple-control, the rate limiter and the
envelope encryption all did exactly what they claim once a request could reach them. Four plumbing
bugs in a path nothing had ever walked is a very different finding from a weakness in the primitives,
and the fixes are correspondingly small and now covered by tests that fail without them.

The open findings are all Medium or below and none blocks Phase 1: R-1, R-2, R-3 (Medium) and R-4
through R-9, R-13 (Low). R-12 (Medium), R-10, R-11 and R-14 (Low) are fixed in place. R-1, R-2 and R-3 share one shape
and should be fixed together early in Phase 1: **a control that cannot fail is not a control.** That
is the third consecutive gate at which that exact pattern has been the most interesting finding, which
is itself the signal — the codebase's instinct is to write the check, and its blind spot is verifying
the check can go red. Adding "sabotage it once, watch it fail" to the definition of done for any new
gate would retire this pattern permanently.

**Production remains gated on Chris's hand actions, unchanged:** LUKS2 on the `pgdata` and backup
volumes, Tailscale Serve for remote access, real secrets generated on the real box (plus
`just harden-secrets`), a real B2 bucket with object lock for off-box backups, and an external `nmap`
capture for the P0-3 evidence file.

---

## 8. Reproduction

```bash
export PATH=$HOME/.local/bin:$PATH
PUBLIC_HOST=personalfi.lan docker compose up -d --build
just trust-ca
just bootstrap-user name="Chris" timezone="America/New_York"
# open the printed https://personalfi.lan/register#token=... in a browser that
# trusts ./personalfi-ca.crt, with personalfi.lan resolving to the bind address
AGE_IDENTITY_FILE=/path/to/age-identity.txt just restore-drill
just verify
docker compose down -v
```
