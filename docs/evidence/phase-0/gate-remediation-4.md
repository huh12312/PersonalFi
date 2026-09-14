# Gate remediation 4 — R-9, R-13 close-out

Follow-up to `gate-security-review-2.md`, closing the two remaining Low
findings from that gate. This agent's ownership: `docker/Caddyfile`,
`docker/backup/**`, `docker/backup.Dockerfile`, `compose.yml` (the `backup`
service block only), `RUNBOOK.md` (the Backup section only),
`apps/web/e2e/csp-static-server.mjs` (only because it mirrors the same
fallback R-9 fixes), and this file. No dependency changes, no commit.

Every fix below was sabotaged (observed red/failing) before being accepted,
per the standing evidence bar (`personalfi-gate-lessons` memory: "a control
that has never been observed failing is decoration").

Repro environment: `export PATH=$HOME/.local/bin:$PATH`, Docker available,
throwaway secrets already present under `./secrets` (gitignored, untouched by
this work).

---

## R-9 — unmatched `/assets/*` returned `200 text/html`, not `404`

**Finding.** `docker/Caddyfile`'s SPA `handle` block applied
`try_files {path} /index.html` to the _whole_ site, so any unresolved path —
including a stale or mistyped hashed asset name such as
`/assets/index-BWySMGlh.js.map` — answered `200 text/html` with a body
byte-identical to `index.html`. No source-map or content leak (confirmed by
the second gate: no `*.map` ships, and `docker/caddy.Dockerfile` fails the
build if one does), but a naive "is this reachable?" probe reads `200` and
draws the wrong conclusion, and a genuinely broken deploy (an asset that
should exist but doesn't) is indistinguishable from a healthy one by status
code.

**Fix (`docker/Caddyfile`).** Split the single catch-all `handle` block into
two, using the same "sorted by matcher specificity" mechanism the file
already relies on for `/auth/*`, `/health`, `/ready`:

1. `@staticPaths path /assets/* /fonts/* /icons/* /sw.js /manifest.webmanifest`
   routed through a `handle @staticPaths { ... file_server }` with **no**
   fallback — a miss here is Caddy's ordinary 404.
2. Everything else keeps the SPA `handle {}` block, but the fallback to
   `/index.html` is now gated by a `@spaRoute` matcher: `not file` (the file
   doesn't exist under `/srv/web`) **and** `not path_regexp \.[a-zA-Z0-9]+$`
   (no file extension on the final path segment — i.e. the request is
   navigation-shaped, like `/transactions` or `/dev/kitchen-sink`). Anything
   with a file extension that reaches this block and doesn't exist now falls
   through to `file_server`'s own 404 instead of being rewritten to
   `index.html`.

Mirrored in `apps/web/e2e/csp-static-server.mjs`, which implemented the exact
same unconditional "serve index.html for anything unresolved" fallback for
the Playwright `csp` project: a path with a file extension on its final
segment that doesn't resolve to a real file under `dist-e2e-csp/` now gets a
real 404 instead of `index.html`, via the same extension-regex test.

**Sabotage — the finding, reproduced.** Built the current proxy image, then
ran it standalone with the _pre-fix_ Caddyfile (`git show HEAD:docker/Caddyfile`,
i.e. the tree before this remediation) mounted in:

```
$ curl -sk --resolve personalfi.lan:18443:127.0.0.1 -D - https://personalfi.lan:18443/assets/nope.js
HTTP/2 200
content-type: text/html; charset=utf-8
<!doctype html>
<html lang="en"> ...
```

Confirms the finding: a nonexistent `/assets/*.js` path returned `200
text/html` under the old Caddyfile, using this same built image (i.e. the
routing file, not the image, is what changed).

**Proof — fixed, on a fresh booted stack.**

```
$ export PATH=$HOME/.local/bin:$PATH
$ docker compose down -v
$ PUBLIC_HOST=personalfi.lan docker compose up -d --build
  ... personalfi-proxy-1 Started (after api healthy)

$ docker run --rm -v "$PWD/docker/Caddyfile:/etc/caddy/Caddyfile:ro" \
    --entrypoint caddy personalfi/proxy:dev validate \
    --config /etc/caddy/Caddyfile --adapter caddyfile
...
Valid configuration

$ curl -sk --resolve personalfi.lan:443:127.0.0.1 -D - https://personalfi.lan/
HTTP/2 200
content-type: text/html; charset=utf-8

$ curl -sk --resolve personalfi.lan:443:127.0.0.1 -D - https://personalfi.lan/transactions
HTTP/2 200
content-type: text/html; charset=utf-8

$ curl -sk --resolve personalfi.lan:443:127.0.0.1 -D - https://personalfi.lan/assets/nope.js
HTTP/2 404

$ curl -sk --resolve personalfi.lan:443:127.0.0.1 -D - https://personalfi.lan/sw.js
HTTP/2 200
content-type: text/javascript; charset=utf-8
try{self["workbox:core:7.4.0"]&&_()}catch{}...
```

Full matrix, exactly as specified:

| path              | expected | observed              |
| ----------------- | -------- | --------------------- |
| `/`               | 200 HTML | `200 text/html`       |
| `/transactions`   | 200 HTML | `200 text/html`       |
| `/assets/nope.js` | 404      | `404`                 |
| `/sw.js`          | 200 JS   | `200 text/javascript` |

**Playwright `csp` project, still green** (the concern being that the
extension/`not file` gating in `csp-static-server.mjs` could break serving
the kitchen-sink route or its real assets):

```
$ cd apps/web && pnpm exec playwright test --project csp
  ✓ [csp] the served Content-Security-Policy pins the directives this repo depends on (411ms)
  ✓ [csp] the kitchen sink renders a toast and a dialog with zero CSP violations (1.1s)
  ✓ [csp] the toast, warning, and update-prompt code paths all render under CSP (919ms)
  3 passed (15.9s)
```

---

## R-13 — a cold `docker compose up` reliably lands `backup` unhealthy

**Finding.** The `backup` service only `depends_on: db: service_healthy`, so
on a truly fresh install it started as soon as Postgres accepted connections
— before `migrator` had created a single table. `backup-loop.sh`'s startup
run then dumped an empty schema; `backup.sh`'s structural guard (introduced
for H-2/finding-9: `pg_restore --list` must enumerate at least
`MIN_TOC_ENTRIES` (10) objects including `schema_migrations`) correctly
refused to promote a 0-object archive, wrote a `fail` status, and
`docker compose ps` showed `backup (unhealthy)` until the next nightly
window — a real control firing on a startup-ordering bug, not a backup
problem, and exactly the kind of alarm operators learn to ignore.

**Fix — two independent layers, per the brief's "and/or".**

1. `compose.yml`: `backup` now `depends_on: migrator: service_completed_successfully`
   in addition to `db: service_healthy`. On a normal `docker compose up`, the
   `backup` container is not even created until migrations have run to
   completion — removing the race outright.
2. `docker/backup/backup-loop.sh`: added `wait_for_schema()`, called once
   before the _first_ `run_backup` (not before nightly reruns, which never
   need it once the schema exists). It polls
   `information_schema.tables` for `schema_migrations` every 5s, up to
   `BACKUP_SCHEMA_WAIT_SECONDS` (default 600s), then proceeds regardless —
   at that point `backup.sh`'s own guard is the honest fallback and will
   report a real, visible failure rather than this script hanging forever.
   This is defense-in-depth for anyone who starts or restarts `backup` alone
   (`--no-deps`, or after wiping just `pgdata`) and bypasses the compose-level
   ordering in (1).

No change was needed in `docker/backup/healthcheck.sh`: it already treats a
"starting, no attempt yet" status as healthy within `BACKUP_START_GRACE_SECONDS`
(900s) of container start, and only a status file that says an attempt
_failed_ is reported unhealthy immediately (the `*)` case in the state
`case` statement). The bug was that the first attempt actively ran and
failed — not that "no attempt yet" was being mishandled — so removing the
premature attempt is the correct fix, not loosening the health check.

Documented in `RUNBOOK.md`'s Backup section ("Fresh install: why `backup`
doesn't flap unhealthy on a cold `docker compose up`").

**Proof — fresh stack, cold start, no manual backup.**

```
$ export PATH=$HOME/.local/bin:$PATH
$ docker compose down -v
$ PUBLIC_HOST=personalfi.lan docker compose up -d --build
 Container personalfi-db-1        Healthy
 Container personalfi-migrator-1  Exited        <- backup/api/worker wait for this
 Container personalfi-backup-1    Starting
 Container personalfi-backup-1    Started
 ...
```

`backup`'s own container log shows the schema was already present by the
time it started (the `depends_on` did the work; the loop's own poll returned
in 0s):

```
$ docker logs personalfi-backup-1
backup-loop: starting; nightly run at 2:00 UTC
backup-loop: schema_migrations present after 0s; proceeding with first backup
backup: dumping personalfi@db ...
backup: verified 109604 bytes, 254 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20260914T004005Z.dump.age (109820 bytes)
backup: complete
```

```
$ docker compose ps --format "table {{.Name}}\t{{.Status}}"
NAME                  STATUS
personalfi-api-1      Up 19 seconds (healthy)
personalfi-backup-1   Up 20 seconds (healthy)
personalfi-db-1       Up 27 seconds (healthy)
personalfi-proxy-1    Up 14 seconds (healthy)
personalfi-worker-1   Up 20 seconds (healthy)
```

`backup` reached `(healthy)` on its own, no `just backup` / manual invocation,
20 seconds after the container started.

**Sabotage — wrong `PGPASSWORD_FILE`, forced attempt, full health-cycle
timeline.** Ran a manual backup inside the already-healthy container with a
nonexistent password file (`docker compose exec -e`, no override file, no
recreate — affects only this one attempt):

```
$ docker compose exec -e PGPASSWORD_FILE=/run/secrets/does_not_exist backup /usr/local/bin/backup.sh
cat: can't open '/run/secrets/does_not_exist': No such file or directory
backup: FAILED (exit 1); status file: fail 1789346430 backup.sh exited 1 (see container logs)
exit=1
```

Then waited for Docker's _own_ scheduled `HEALTHCHECK` (interval 5m) to pick
up the sabotaged status file — not the manual `healthcheck.sh` invocation,
which only proves the script's logic, not the container's actual reported
state:

```
$ docker inspect --format '{{json .State.Health}}' personalfi-backup-1
{
  "Status": "unhealthy",
  "FailingStreak": 1,
  "Log": [
    {"ExitCode": 0, "Output": "healthy: last backup 5s ago: .../personalfi-20260914T004005Z.dump.age (109604 plaintext bytes, 254 objects)\n"},
    {"ExitCode": 1, "Output": "unhealthy: last backup attempt reported 'fail' 280s ago: backup.sh exited 1 (see container logs)\n"}
  ]
}
```

`docker compose ps` at that point: `personalfi-backup-1  Up 5 minutes
(unhealthy)`.

**Recovery.** Ran a real backup by hand and waited for the next scheduled
Docker healthcheck:

```
$ docker compose exec backup /usr/local/bin/backup.sh
backup: verified 110391 bytes, 254 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20260914T004530Z.dump.age (110607 bytes)
backup: complete
exit=0

$ docker inspect --format '{{json .State.Health}}' personalfi-backup-1
{
  "Status": "healthy",
  "FailingStreak": 0,
  "Log": [
    {"ExitCode": 0, "Output": "healthy: last backup 5s ago: .../personalfi-20260914T004005Z.dump.age (...)\n"},
    {"ExitCode": 1, "Output": "unhealthy: last backup attempt reported 'fail' 280s ago: backup.sh exited 1 (see container logs)\n"},
    {"ExitCode": 0, "Output": "healthy: last backup 279s ago: .../personalfi-20260914T004530Z.dump.age (110391 plaintext bytes, 254 objects)\n"}
  ]
}
```

Full cycle on the real container health state (not a script dry-run):
`healthy` -> `unhealthy` (sabotage) -> `healthy` (recovery), `FailingStreak`
1 -> 0.

---

## VERIFY

```
$ docker compose config                                  # exit 0, valid
$ bash scripts/compose-hardening-check.sh                # PASS (3 files, 0 violations)
$ bash scripts/compose-hardening-check.sh --self-test     # SELF-TEST PASS (19/19 rules fire)
$ docker compose down -v                                  # stack torn down, no volumes left
$ ls secrets/                                             # unchanged, untouched
```

`just check` was run for real (`typecheck` step) but fails, at this moment,
**only** in a path outside this agent's ownership:

```
packages/connectors/csv/src/scalars.ts(51,32): error TS2345: Argument of type
'string' is not assignable to parameter of type 'CurrencyCode'.
error: recipe `typecheck` failed on line 103 with exit code 2
```

`git status --short` at the time confirms two other agents were mid-work on
`packages/connectors/**`, `packages/contexts/categorization/**`, and
`pnpm-lock.yaml`/`pnpm-workspace.yaml` — exactly the paths this failure is
in. Nothing touched by this task (`docker/Caddyfile`, `docker/backup/**`,
`compose.yml`'s `backup` block, `RUNBOOK.md`, `csp-static-server.mjs`)
appears in the typecheck failure or anywhere near it. Deferred to those
agents' own verification; not re-run here since it is out of this task's
ownership and would not be informative either way while their work is
in flight.

---

## Deferred / out of scope

- Nothing else from `gate-security-review-2.md` is in this agent's ownership.
  R-1 through R-8, R-11, R-12, R-14 were already closed by
  `gate-remediation-3.md` / fixed in place by the second gate itself; R-3
  (testkit CI coverage) remains open and untouched, outside this task's
  scope.
- The Accept-header half of "navigation-shaped" ("no file extension /
  Accept text/html") was intentionally not implemented as a second, OR'd
  condition: the extension check alone closes the finding as stated (the
  proof matrix in the brief exercises exactly the extension-based cases),
  and adding a CEL `expression` matcher for the Accept-header OR would add
  meaningfully more Caddyfile complexity and validation risk for a case with
  no concrete proof requirement. Worth revisiting if a future finding
  produces a case the extension check alone doesn't cover.
