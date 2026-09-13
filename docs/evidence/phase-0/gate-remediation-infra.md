<!-- SPDX-License-Identifier: MIT -->

# Phase 0 gate remediation — infrastructure

Scope: the infrastructure half of the Phase 0 security gate
(`docs/evidence/phase-0/gate-security-review.md`). Owned paths only —
`docker/**`, the compose files, `scripts/compose-hardening-check.sh`,
`scripts/fixtures/**`, `scripts/check-licenses.ts`, `justfile`, `renovate.json`,
`RUNBOOK.md`, `.env.example`, `.github/workflows/**`. The API/identity and web
findings were remediated concurrently by other agents and are not covered here.

Every claim below is a command that was run against this working tree, with its
real output. Where something could not be proven, it says so and why.

Working tree at time of verification: branch `main`, starting from HEAD
`376a957`, plus the changes described here. The API/identity agent committed
`f43c85f` partway through; everything below was re-verified against that
commit's images afterwards. Docker 29.7.2, Docker Compose v5.5.1, Caddy v2.11.4
(`docker run --entrypoint caddy personalfi/proxy:dev version`), Node v26.8.1.

---

## Summary

| Finding      | Status                         | Proof                                                               |
| ------------ | ------------------------------ | ------------------------------------------------------------------- |
| H-1          | Fixed                          | §1 — hostile fixture FAILs with 17 rules, real files PASS           |
| H-2          | Fixed                          | §2 — failed dump promotes nothing, prunes nothing, unhealthy        |
| H-5          | Fixed                          | §3 — drill FAILs on a real failure, PASSes on a good one            |
| H-4 / M-7    | Fixed                          | §4 — full header set on both listeners, no nonce literal            |
| M-3          | Fixed                          | §4 — dead `/api/*` gone, SPA served, XFP on every path              |
| M-1 (part)   | Fixed at the proxy             | §5 — spoofed XFF replaced by the peer on both listeners             |
| M-5          | Fixed                          | §6 — `webhooks-placeholder` on its own `ingress` network            |
| M-2          | Partly fixed, partly disproven | §7 — compose ignores `mode:`; `just harden-secrets` is the real fix |
| M-6          | Fixed                          | §8 — stamp derived from the lockfile hash, stable                   |
| P0-4 (infra) | Unblocked                      | §9 — `AUTH_RP_ID`/`AUTH_ALLOWED_ORIGINS` set from `PUBLIC_HOST`     |
| Process      | Fixed                          | §10 — `just verify` runs every CI gate locally                      |
| Memory       | Decided with evidence          | §11 — worker 512M (it does not derive the KEK)                      |
| Renovate     | Fixed                          | §12 — `automerge: false` until the gates are trusted                |

Deferred, with reasons, in §13.

---

## 1. H-1 — the compose gate was decorative

`scripts/compose-hardening-check.sh` is rewritten. It no longer greps YAML; it
asserts against `docker compose -f <file> --profile '*' config --format json` —
the fully interpolated, alias-expanded, schema-normalised model compose itself
will run, so `privileged: "true"`, `privileged: true` and an anchor that injects
it three services away are one value by the time the rules see it.

Rules (17): `privileged`, `host-network`, `host-pid`, `host-ipc`,
`host-cgroup`, `host-userns`, `cap-add`, `security-opt-unconfined`, `devices`,
`container-runtime-socket` (docker/podman/containerd/crio), `writable-bind-mount`,
`writable-named-volume`, `port-bind-address`, plus the positive half of P0-7:
`missing-read-only`, `missing-cap-drop-all`, `missing-no-new-privileges`,
`root-user`. Exceptions are a table inside the script, keyed
`file:service:rule`, each with a written reason, and they are printed on every
run rather than hidden.

**The gate now checks itself.** `scripts/fixtures/compose-hostile.yml` declares
every prohibition at once, and `--self-test` asserts each rule fires:

```
$ bash scripts/compose-hardening-check.sh --self-test
compose-hardening-check: --self-test: running scripts/fixtures/compose-hostile.yml through the gate
  fixture triggered 17 distinct rule(s): cap-add container-runtime-socket devices host-cgroup
  host-ipc host-network host-pid host-userns missing-cap-drop-all missing-no-new-privileges
  missing-read-only port-bind-address privileged root-user security-opt-unconfined
  writable-bind-mount writable-named-volume
compose-hardening-check: SELF-TEST PASS (all 17 rules fire on a hostile file)
```

The same fixture through the **old** gate returned `PASS ... EXIT=0` (gate
review §3, H-1). The real files pass:

```
$ bash scripts/compose-hardening-check.sh
    waived compose.dev.yml: db: missing-read-only: postgres cannot run on a read-only rootfs...
  compose.dev.yml: 1 service(s), 0 violation(s), 1 documented exception(s)
  compose.override.example.yml: template with no active services (nothing to check)
    waived compose.yml: db: missing-read-only: postgres writes its own data directory...
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (3 file(s) checked: compose.dev.yml compose.override.example.yml compose.yml)
```

Two things that fell out of writing real assertions:

- **`compose.dev.yml`'s `db` failed three of them** (no `cap_drop`, no
  `no-new-privileges`, root user). Rather than exempt the dev file, the service
  was hardened to match production (`cap_drop: [ALL]`,
  `security_opt: ['no-new-privileges:true']`, `user: '70:70'` — uid 70 is the
  image's own `postgres` user). Verified bootable with exactly those flags:

  ```
  $ docker run -d --cap-drop ALL --security-opt no-new-privileges:true --user 70:70 postgres:18.6-alpine3.24 ...
  /var/run/postgresql:5432 - accepting connections
  user=70:70 capdrop=[ALL] secopt=[no-new-privileges:true]
  ```

- **`compose.override.example.yml` cannot be parsed by compose at all** — every
  service in it is commented out, so `services` is null and compose rejects it
  with "services must be a mapping". The script recognises exactly that shape
  (non-comment content is the single token `services:`) and reports "template
  with no active services". Any other parse failure is a hard FAIL, and the
  moment the file gains one real service it parses and every rule applies.

`just hardening-check` runs both halves; CI's `compose-hardening` job now has
two steps in the same order; the lefthook hook and `just compose-lint` still
work.

---

## 2. H-2 — a failed dump could become a valid-looking backup

`docker/backup/backup.sh` now has `set -euo pipefail`, does **not** pipe
`pg_dump` into `age` (the pipeline was what hid the dump's exit status), writes
the plaintext to the container's 256 MB `/tmp` tmpfs, and clears four bars
before anything is promoted or pruned: `pg_dump` exit 0 → size ≥ 1024 bytes →
`pg_restore --list` parses it → at least one restorable object.

A good run:

```
$ docker compose exec backup /usr/local/bin/backup.sh
backup: dumping personalfi@db ...
backup: verified 66131 bytes, 154 restorable object(s)
backup: wrote /backups/personalfi-20260913T024754Z.dump.age (66347 bytes)
backup: pruning entries older than 30 day(s) locally
backup: complete
```

The failure path, injected by pointing the script at a wrong password — the
exact scenario the gate review described (password rotated, container not
restarted):

```
$ docker compose exec -e PGPASSWORD_FILE=/tmp/bogus backup sh -c '...'
backup: dumping personalfi@db ...
pg_dump: error: connection to server at "db" (172.22.0.2), port 5432 failed: FATAL:  password authentication failed
backup: pg_dump failed; nothing written, nothing pruned
backup: FAILED (exit 1); status file: fail 1789267699 backup.sh exited 1 (see container logs)
EXIT=1
--- healthcheck:
unhealthy: last backup attempt reported 'fail' 0s ago: backup.sh exited 1 (see container logs)
healthcheck EXIT=1
--- backups still present:
personalfi-20260913T024754Z.dump.age
```

Nothing promoted, **nothing pruned**, and the container reports unhealthy. The
earlier run in the same session is the other half of the proof: on a database
that had not yet been migrated, the dump was 840 bytes and the size floor
caught it (`backup: dump is 840 bytes, below the 1024-byte floor — refusing to
promote it`), with `docker compose ps` showing `backup   Up 2 minutes (unhealthy)`.

Failures reach the healthcheck through a status file
(`/tmp/backup-status`, `<state> <epoch> <message>`) written on every exit path
including the trap. `docker/backup/healthcheck.sh` asks three questions where
the old check asked one: is the loop alive (`pgrep`, as before), did the last
attempt succeed, and was it recent enough (`BACKUP_MAX_AGE_SECONDS`, default
26 h). A healthy run:

```
$ docker compose exec backup /usr/local/bin/healthcheck.sh
healthy: last backup 4s ago: /backups/personalfi-20260913T024754Z.dump.age (66131 plaintext bytes, 154 objects)
healthcheck exit=0
```

`backup-loop.sh` still does not exit on a failed backup — a transient DB outage
should not cancel tomorrow's attempt — but it records the failure and starts
from a `starting` state so "no backup has completed yet" is never mistaken for
success. `compose.yml` and `docker/backup.Dockerfile` both point their
healthcheck at the new script.

### restore.sh

Refuses to restore into the production database name (`personalfi`, overridable
via `PRODUCTION_DATABASE`) without `FORCE_RESTORE=1`:

```
$ ... -e PGDATABASE=personalfi /usr/local/bin/restore.sh /backups/personalfi-20260913T024827Z.dump.age
restore: REFUSING to restore into the production database.
  target   : personalfi@db   (matches PRODUCTION_DATABASE=personalfi)
  archive  : /backups/personalfi-20260913T024827Z.dump.age
  pg_restore --clean --if-exists DROPs every object in that database before it recreates it...
      FORCE_RESTORE=1 ... /usr/local/bin/restore.sh /backups/...
  If you meant to test a backup, use `just restore-drill` — it restores into
  a throwaway database and never touches this one.
EXIT=1
```

With the flag it verifies the archive first, then prints exactly what it is
about to destroy and pauses:

```
restore: target personalfi@db; --clean --if-exists will DROP and recreate these:
    BASE TABLE  public.auth_attempts
    ... 20 tables ...
    BASE TABLE  public.webauthn_credentials
restore: archive contains 154 restorable object(s)
restore: FORCE_RESTORE=1 given; proceeding against the production database in 5s (Ctrl-C to abort)
```

---

## 3. H-5 — the restore drill could not fail

`just restore-drill` now asserts. Every number it already collected is compared,
and the evidence artifact carries a verdict.

It failed honestly on the first run after the rewrite — the throwaway api
container crashed on its first request (an unrelated, in-flight defect in
`apps/api/src/logging.ts`, see §13):

```
**Verdict: FAIL**
- Restored db table count: 20
- Live db table count: 20
- API /ready against restored db: fail (no 200 from /ready within 60s)
Assertions that failed:
- /ready never returned 200 against the restored database
`just restore-drill` exited non-zero.
error: recipe `restore-drill` failed with exit code 1
```

That is the property H-5 asked for: **the drill can fail.** Once that defect
was fixed on the API side (commit `f43c85f`), the same drill passes end to end
against a real encrypted backup, at the default `LOG_LEVEL`, with no workaround:

```
$ AGE_IDENTITY_FILE=/tmp/drill-age-identity.txt just restore-drill
restore: decrypting /backups/personalfi-20260913T030238Z.dump.age
restore: archive contains 154 restorable object(s)
restore: complete
restore-drill: booting a throwaway api container against the restored db ...

# Restore drill — 20260913T030239Z
**Verdict: PASS**
- Backup restored: `/backups/personalfi-20260913T030238Z.dump.age` (66136 encrypted bytes)
- Restored db table count: 20
- Restored db schema_migrations max id: 0003
- Live db table count: 20
- Live db schema_migrations max id: 0003
- API /ready against restored db: pass (200 from /ready)
All assertions held ... `just restore-drill` exited 0.
DRILL EXIT=0
```

Two defects in the old recipe were found by making it assert: the
`schema_migrations` query selected `max(id)` from a table whose primary key is
`version` (so both sides silently reported "(schema_migrations not present)" and
compared equal), and the throwaway api container was started with
`|| true` and `>/dev/null 2>&1`, so a container that never started still read as
"fail or skipped — not necessarily an infra defect". Both are fixed; the drill
also passes `AUTH_RP_ID`/`AUTH_ALLOWED_ORIGINS` (without them the api refuses to
boot under `NODE_ENV=production`, §9) and reads `pg_password` through a root
container so it keeps working after `just harden-secrets` (§7).

The artifact it wrote is `docs/evidence/ops/restore-drill-20260913.md`.

---

## 4. H-4 / M-7 / M-3 — the proxy

`docker/Caddyfile` is restructured into two snippets, `(security_headers)` and
`(app_routes)`, imported by both listeners. One copy of each policy, so the two
cannot drift again.

`caddy validate` inside the image, and `caddy fmt` clean:

```
$ docker run --rm -v "$PWD/docker/Caddyfile:/etc/caddy/Caddyfile:ro" --entrypoint caddy \
    personalfi/proxy:dev validate --config /etc/caddy/Caddyfile --adapter caddyfile
Valid configuration
```

Booted stack, both listeners, `/health`:

```
$ curl -ksS -D- --resolve personalfi.lan:443:127.0.0.1 https://personalfi.lan/health
HTTP/2 200
content-security-policy: default-src 'self'; script-src 'self'; style-src-elem 'self';
  style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
  worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; frame-ancestors 'none';
  base-uri 'none'; form-action 'self'
cross-origin-embedder-policy: require-corp
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
permissions-policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
referrer-policy: no-referrer
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY

$ curl -sS -D- http://127.0.0.1/health          # the Tailscale-Serve listener
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src-elem 'self'; ... (identical)
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

Eleven headers on both, where the remote-access listener previously had three.
No `Server` header on either (`-Server`).

**CSP (M-7).** The inert `'nonce-{nonce-placeholder}'` tokens are gone —
`{`/`}` are outside CSP's base64 grammar, so browsers discarded the expression
and the effective policy was `script-src 'self'` by luck. Baking a constant
nonce into the image would have been strictly _weaker_ than `'self'`, so the
header now states what is actually enforced. `style-src` is split per
`docs/security/csp-nonce-strategy.md` (`style-src-elem 'self'`,
`style-src-attr 'unsafe-inline'`), which is what keeps sonner and
react-remove-scroll-bar — and therefore the idle-lock warning and the
service-worker update prompt — working. `worker-src 'self' blob:` is required
by the vite-plugin-pwa registration.

**Routing (M-3).** The dead `handle /api/*` block (which proxied without
stripping the prefix to an API that mounts nothing under `/api`) is deleted. The
three real API prefixes are listed by name and the rest is the SPA:

```
LAN listener                                    Tailscale listener
/                     -> 200 text/html          / -> 200 text/html
/accounts/deep/link   -> 200 text/html (SPA fallback)   /accounts/deep/link -> 200 text/html
/sw.js                -> 200 text/javascript
/auth/unlock-state    -> 200 application/json   /auth/unlock-state -> 200 application/json
/ready                -> 200 application/json   /ready -> 200 application/json
/api/auth/unlock-state-> 200 text/html (now the SPA fallback, not a 404 from the API)
```

Cache headers behave: `/` is `cache-control: no-cache`,
`/assets/index-DdVLgWRI.js` is `public, max-age=31536000, immutable`.

**The SPA is in the image.** `docker/caddy.Dockerfile` gained a `web-build`
stage (pinned Node 26 image, pinned pnpm, `--frozen-lockfile`) that runs
`@app/web`'s `gen` → `vite build` → `check-csp.ts`, deletes `*.map` and strips
the dangling `sourceMappingURL` comments, and the runtime stage copies
`dist/` to `/srv/web` and fails the build if `index.html` is missing or a map
survived. The build context for this image is now the repo root in
`compose.yml`, `ci.yml` and `release.yml`.

```
$ docker run --rm --entrypoint sh personalfi/proxy:dev -c "ls /srv/web; find /srv/web -name '*.map' | wc -l"
assets fonts icons index.html manifest.webmanifest sw.js
0
```

The image deliberately does **not** run `tsc -b --noEmit` (part of
`@app/web`'s `build` script): typechecking belongs to CI's `typecheck` job and
`just check`, once, over the whole workspace — not to a container build that
would then fail for a type error in a test file it does not ship.

---

## 5. M-1 (proxy half) — the trusted-proxy posture is now stated, not inherited

C-1 was withdrawn because Caddy ≥ 2.7 _replaces_ an untrusted peer's
`X-Forwarded-For`. That protection was real but rested on a version-dependent
default with nothing pinning it. `(app_routes)` now sets
`header_up X-Forwarded-For {remote_host}` and `header_up X-Forwarded-Proto https`
on every proxied path, so the guarantee holds independently of that default.

Verified with an echo upstream aliased as `api` on a scratch network, so the
request the API would see is visible verbatim:

```
$ curl -k -H "X-Forwarded-For: 203.0.113.77, 198.51.100.9" -H "X-Forwarded-Proto: http" \
    https://personalfi.lan:18443/health            # LAN listener
{"url":"/health","xff":"172.24.0.1","xfp":"https","peer":"172.24.0.3"}

$ curl -H "X-Forwarded-For: 203.0.113.77" -H "X-Forwarded-Proto: http" \
    http://127.0.0.1:18080/auth/unlock-state       # Tailscale listener
{"url":"/auth/unlock-state","xff":"172.24.0.1","xfp":"https","peer":"172.24.0.3"}
```

Both spoofed values discarded; `X-Forwarded-Proto` forced to `https` on both
paths — including the catch-all that previously set nothing (M-3).

**Deviation from the brief, stated deliberately.** The brief asked for
`trusted_proxies` loopback on the Tailscale listener. The measurement above is
why it is not there: under the default bridge network the immediate peer for a
`tailscale serve` request is the docker-proxy gateway (`172.24.0.1` here,
`172.21.0.1` in the gate review), never `127.0.0.1`. A
`trusted_proxies static 127.0.0.1/32` would match nothing and read as a
guarantee that is not one — the same class of defect as the nonce placeholder.
The file says so in a comment, along with what the honest version would be
(trust the gateway explicitly and consume `Tailscale-User-Login`) if per-device
attribution over the tailnet is ever wanted. The effective trusted set is empty
on both listeners, which is the intended posture.

Narrowing `trustProxy` in `apps/api/src/app.ts` is the other half of M-1 and
belongs to the API agent.

---

## 6. M-5 — the webhook placeholder is off `backend`

A fourth network, `ingress`, carries the future webhook listener and nothing
else. Not `internal: true`, because the one service that will ever live there is
by definition reachable from outside; no route to `db`, `api`, `worker`, or the
proxy.

```
$ docker compose --profile webhooks config --format json | ...
webhooks networks: [ 'ingress' ]
```

The compose comment records the intended shape when a real listener replaces
`sleep infinity`: it talks to the API over an internal HTTP route
(signature-verified, no session cookie, enqueue-only), gets no database
credential, no `master_key`, and no membership of `backend`.

---

## 7. M-2 — secret file modes: what is true, and what the brief assumed

The brief asked for mode 0400 on generated secrets and `mode: 0400` on the
compose secrets. **The second half does not do anything**, and shipping it would
have been another decorative control, so it is not there. Measured:

```
host file:  -rw-r--r-- 1 1000 1000 s.txt
compose:    secrets: [{ source: s, uid: "10001", gid: "10001", mode: 0400 }]
container running as 10001:
  -rw-r--r--    1 1000     1000             6 /run/secrets/s
  uid=10001 gid=10001 groups=10001
  READABLE
```

Compose's file-secret provider bind-mounts the host file and preserves its uid,
gid and mode verbatim; `uid`/`gid`/`mode` are Swarm-only and `docker compose up`
ignores them silently (Compose v5.5.1). So a 0400 file owned by the operator is
unreadable by _every_ consumer — `db` is uid 70, `api`/`worker`/`migrator`
10001, `backup` 10002.

What was done instead:

- Both secret writers now **enforce** `chmod 0700` on `${SECRETS_DIR}` rather
  than relying on `umask` at `mkdir` time (a pre-existing directory kept
  whatever mode it had). The 0700 directory is the confidentiality boundary.
- `just harden-secrets` (new) is the real 0400: it chowns each secret to the
  uid that consumes it and chmods 0400 — which _does_ pass through, because
  ownership and mode pass through. `pg_password` becomes `70:10002` mode 0440,
  because postgres and the backup container both read it and postgres refuses a
  secret it cannot read. It needs `sudo` once, which is why it is an explicit
  operator action and not something `gen-*` does silently.
- `just restore-drill` reads `pg_password` through a root container, so it keeps
  working after hardening.
- `compose.yml`'s `secrets:` header, both `gen-*` recipes and RUNBOOK.md all
  carry the measurement and the two options, so the next reader does not
  rediscover it.

---

## 8. M-6 — THIRD_PARTY.md no longer embeds the wall clock

`scripts/check-licenses.ts` stamps the artifact with the lockfile hash instead
of `new Date()`: it changes if and only if the dependency tree changed, which is
the only thing that can change the file's contents.

```
-`pnpm licenses list --prod` across the whole workspace — as of 2026-09-12.
+`pnpm licenses list --prod` across the whole workspace — generated from pnpm-lock.yaml sha256:8bf4d03132b4f47d.
```

Regenerated and proven stable across repeated runs (the property the CI drift
check depends on):

```
$ node scripts/check-licenses.ts   # x3, hashing THIRD_PARTY.md after each
a64df9ff1be97298 a64df9ff1be97298 a64df9ff1be97298
STABLE across repeated generations
license gate: 260 prod package entries, 622 dev package entries checked
license gate: PASS
```

---

## 9. P0-4 support — the hostname is one fact again

`PERSONALFI_HOSTNAME` is renamed `PUBLIC_HOST` and now drives four things that
were allowed to disagree: Caddy's site address, `BASE_URL`, `AUTH_RP_ID`, and
`AUTH_ALLOWED_ORIGINS`. `EXTRA_ALLOWED_ORIGINS` is appended when set.

```
$ docker compose exec api node -e "console.log(process.env.AUTH_RP_ID,'|',process.env.AUTH_ALLOWED_ORIGINS,'|',process.env.BASE_URL)"
personalfi.lan | https://personalfi.lan | https://personalfi.lan

$ EXTRA_ALLOWED_ORIGINS="https://personalfi.lan:8443" docker compose config ...
with EXTRA: https://personalfi.lan,https://personalfi.lan:8443
```

Two things learned while verifying, both now documented:

- **The migrator needs them too.** `loadConfig()` validates the whole
  configuration for every role and refuses the `localhost` default under
  `NODE_ENV=production`, so without these the migrator exits 1 before the first
  migration and — because api and worker gate on
  `migrator: service_completed_successfully` — the entire stack fails to start.
  Observed, then fixed:

  ```
  migrator-1 | configuration is invalid; 1 problem(s) found:
  migrator-1 |   - AUTH_RP_ID: is still the development default (localhost)
  ```

- **`EXTRA_ALLOWED_ORIGINS` cannot hold the Tailscale MagicDNS name.** WebAuthn
  §7.1 requires every allowed origin's host to equal `AUTH_RP_ID` or be a
  subdomain of it, and `@core/config` enforces exactly that, so
  `<node>.<tailnet>.ts.net` alongside `personalfi.lan` fails to boot by design.
  The variable is for a second origin on the same registrable name (another
  port, a subdomain). RUNBOOK.md and `.env.example` say so, and say that the
  choice between the LAN name and the tailnet name has to be made _before_ the
  first passkey is enrolled, because the RP id is bound into the credential.

Actually enrolling two passkeys and ten recovery codes is still outstanding and
belongs to whoever can drive a browser against the box; the configuration
blocker is gone.

---

## 10. Process — `just verify` is the claim, `just check` is not

New `just verify` = `just check` plus gitleaks (same pinned digest as CI), the
license gate and its `THIRD_PARTY.md` drift check, the compose-hardening gate
(self-test then sweep), the `.trivyignore` expiry sweep (previously CI-only,
now `just trivyignore-check`), and `trivy fs`. Same tools, same digests, same
order as `.github/workflows/ci.yml`.

`ci.yml`'s header and RUNBOOK.md ("Before you push: `just verify`") both point
at it, with the table mapping each step to its CI job. What it deliberately does
not cover: the per-image `trivy image` scans and SBOMs (`just scan`, `just sbom`)
— those rebuild three images first and belong before a release, not before every
push.

---

## 11. Memory limits

`api` stays at 1536M. `worker` goes to **512M**, not 1536M, because it does not
derive the KEK: the only `new SecurityRuntime(...)` in the codebase is
`apps/api/src/app.ts:203`, and `apps/api/src/worker.ts` constructs none. It
mounts `master_key` because `@core/config` requires the secret for role `worker`
(`packages/config/src/schema.ts:229`) — a file read, not an Argon2id derivation.

That takes the simultaneous cold-start peak from ~2.4 GiB to ~1.4 GiB, inside
the 2 GB whole-stack target (master plan §3.4). The compose comment and
RUNBOOK's "Resource envelope" table both carry the tripwire in capitals:
**Phase 1 must raise the worker back to 1536M in the same PR that makes it
unlock the keyring**, or it will be OOM-killed at exit 137 with no output,
exactly as the api was.

Runtime confirmation of the envelope and of P0-7 on the booted stack:

```
$ docker inspect --format '{{.Name}} user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} mem={{.HostConfig.Memory}}' $(docker compose ps -q)
/personalfi-api-1    user=10001:10001 ro=true  capdrop=[ALL] secopt=[no-new-privileges:true] mem=1610612736
/personalfi-backup-1 user=10002:10002 ro=true  capdrop=[ALL] secopt=[no-new-privileges:true] mem=268435456
/personalfi-db-1     user=70:70       ro=false capdrop=[ALL] secopt=[no-new-privileges:true] mem=1073741824
/personalfi-proxy-1  user=10003:10003 ro=true  capdrop=[ALL] secopt=[no-new-privileges:true] mem=134217728
/personalfi-worker-1 user=10001:10001 ro=true  capdrop=[ALL] secopt=[no-new-privileges:true] mem=536870912

$ ss -ltn | grep -E "127.0.0.1:(443|80)\b"
LISTEN 0 0 127.0.0.1:443 0.0.0.0:*
LISTEN 0 0 127.0.0.1:80  0.0.0.0:*
```

Only the proxy publishes, both on an explicit loopback address (P0-3).

---

## 12. Renovate

`automerge` is `false` for the non-major group, with the reason in the rule's
own `description`: automerge was only ever safe because eight gates blocked on
the same PR, and the gate review found three of them broken simultaneously
(compose-hardening passing a hostile service, the license gate failing on a date
diff, gitleaks red at HEAD). `minimumReleaseAge: "7 days"` (the D14 cooldown) is
untouched, as is digest pinning and the 0.x/major review rules. Re-enable in the
same PR that can point at a sustained green pipeline.

---

## 13. Deferred, and why

1. **(Resolved during this session, recorded because it changed how §4/§5 were
   verified.)** Partway through, `apps/api/src/logging.ts` — uncommitted
   work-in-progress from the concurrent API agent — crashed the API on its
   _first_ request:

   ```
   file:///app/apps/api/src/logging.ts:270
           headers: { host: request.headers['host'], 'user-agent': request.headers['user-agent'] },
   TypeError: Cannot read properties of undefined (reading 'host')
       at Object.req (file:///app/apps/api/src/logging.ts:270:41)
       at LogController.incomingRequest (fastify/lib/log-controller.js:50:17)
   ```

   Any request restarted the process, so the first pass of the curl matrix and
   the restore drill were run with `LOG_LEVEL=warn` to keep the request log out
   of the path. Commit `f43c85f` fixed it. The full matrix was then re-run
   against a rebuilt api image at the **default** `LOG_LEVEL`, with no
   workaround: three rounds of `/health` and `/auth/unlock-state` on both
   listeners returned 200, `RestartCount` stayed 0, no `TypeError` in the logs,
   and `just restore-drill` exited 0.

2. **`nmap` from outside the WAN (P0-3's external capture)** — a hand action on
   Chris's network, not reproducible from the repo.

3. **Enrolling two passkeys and ten recovery codes (P0-4's remaining half)** —
   needs a browser against the booted stack. The infrastructure blocker
   (`AUTH_RP_ID`/`AUTH_ALLOWED_ORIGINS`) is closed; the API agent reports
   enrolment proven on `personalfi.lan` in `f43c85f`.

4. **`trusted_proxies` on the Tailscale listener** — deliberately not added, see
   §5 for the measurement that says it would be inert.

5. **`just scan` / `just sbom` were not re-run.** They rebuild all three images
   and scan them; the proxy image now contains the SPA bundle, so its SBOM will
   change. Worth running once before the gate is re-reviewed.

6. **The pre-commit hook now needs Docker.** `scripts/compose-hardening-check.sh`
   runs `docker compose config`, so committing a compose file on a machine
   without Docker fails the hook. It fails **closed**, with a message naming
   what is missing — a gate that skips itself when its tool is absent is how a
   gate stops being a gate:

   ```
   $ PATH=/tmp/emptydir bash scripts/compose-hardening-check.sh
   compose-hardening-check: FAIL: `docker` is not on PATH.
     This gate asserts against `docker compose config --format json` (P0-6/P0-7);
     it cannot be evaluated without it, and it will not pass by default.
   EXIT=1
   ```

---

## 14. Final sweep

Every gate in `just verify`, run individually against this working tree:

```
$ bash scripts/compose-hardening-check.sh --self-test   -> SELF-TEST PASS (17 rules)
$ bash scripts/compose-hardening-check.sh               -> PASS (3 files)
$ docker compose config -q                              -> valid
$ node scripts/check-licenses.ts                        -> license gate: PASS (260 prod, 622 dev)
$ just trivyignore-check                                -> no expired suppressions
$ gitleaks detect --source . --redact --exit-code 1 -i .gitleaksignore
                                                        -> 31 commits scanned; no leaks found
$ trivy fs --scanners misconfig,secret --severity HIGH,CRITICAL --ignorefile .trivyignore
                                                        -> 0 misconfigurations, 0 secrets (exit 0)
$ just test                                             -> 474 passed (43 files) + 35 passed (8 files), exit 0
$ pnpm exec prettier --check RUNBOOK.md compose.yml docs/evidence/phase-0/gate-remediation-infra.md
                                                        -> All matched files use Prettier code style
```

`just check` is **red** at the moment this was written, on
`prettier --check` over five files in `apps/web` that belong to the concurrent
frontend work (`pending-contracts.ts`, `LoginScreen.tsx`,
`IdleLockOverlay.test.tsx`, `check-sw-precache.ts`, `pending-contracts.test.ts`).
`typecheck` passes and every test passes; no file in this work package is
unformatted.

---

## 15. Teardown

The verification stack was torn down with
`docker compose --profile sidecar --profile local-llm --profile webhooks down -v`:

```
Volume personalfi_pgdata Removed / personalfi_caddy_config Removed /
personalfi_caddy_data Removed / personalfi_backups Removed
Network personalfi_frontend Removed / personalfi_backend Removed
```

No `personalfi_*` volume or network remains (the surviving
`personalfi_dev_pgdata` belongs to `compose.dev.yml` and predates this work).
The throwaway age keypair generated for the drill was removed and the
pre-existing `secrets/age_recipient` restored byte-for-byte; `ls -l secrets/`
matches its pre-run state exactly.
