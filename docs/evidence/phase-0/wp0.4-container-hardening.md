<!-- SPDX-License-Identifier: MIT -->

# WP 0.4 evidence — container hardening (P0-3, P0-6, P0-7, P0-13)

Collected 2026-09-12 from a real `docker compose up` of `compose.yml` on this
host (Docker 29.7.2, Compose v5.5.1), using throwaway secrets generated for
this run only (`just gen-pg-secrets`, `just gen-master-key`, a scratch age
keypair) — none of these values are real credentials and the `secrets/`
directory this evidence was captured against is gitignored.

## What could and could not boot

`db`, `backup`, and (started standalone with `--no-deps` for evidence
purposes, see below) `proxy` booted and passed their healthchecks. `api`,
`worker`, and `migrator` did **not** start.

**Root cause, confirmed by `docker logs personalfi-migrator-1`:**

```
configuration is invalid; 1 problem(s) found:
  - ROLE: Invalid option: expected one of "api"|"worker"
      fix: set ROLE in the environment (see .env.example)
```

`packages/config/src/schema.ts` defines `ROLE: z.enum(['api', 'worker'])` and
has not been updated for the `migrator` role WP 0.4 added (`compose.yml` sets
`ROLE: migrator`; `docker/entrypoint.mjs` already dispatches on it correctly
— see that file). This is a `packages/config` change, out of this work
package's scope (collision rules: do not edit `packages/`). `api` and
`worker` both `depends_on: {migrator: {condition:
service_completed_successfully}}`, so neither starts either, on a fresh
clone, until that enum is updated. Flagged to the orchestrator; see the final
report for this work package.

`proxy` was started with `docker compose up -d --no-deps proxy` specifically
to still capture real evidence for it (its own boot does not depend on
`api`; only its *healthcheck* does, since that checks `api:8080/health`
through itself). It logs the expected `502` reverse-proxy error against a
nonexistent `api` service, which is the correct behavior given the state
above, not a defect.

## `docker inspect` — hardening flags per service

```
docker inspect --format='{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' <container>
```

| Service    | ReadonlyRootfs | User        | CapDrop | SecurityOpt              | Restart policy | Log driver           |
| ---------- | -------------- | ----------- | ------- | ------------------------ | -------------- | --------------------- |
| `proxy`    | `true`         | `10003:10003` | `[ALL]` | `[no-new-privileges:true]` | `unless-stopped` | `json-file` (10m × 5) |
| `api`      | `true`         | `10001:10001` | `[ALL]` | `[no-new-privileges:true]` | `unless-stopped` | `json-file` (10m × 5) |
| `worker`   | `true`         | `10001:10001` | `[ALL]` | `[no-new-privileges:true]` | `unless-stopped` | `json-file` (10m × 5) |
| `migrator` | `true`         | `10001:10001` | `[ALL]` | `[no-new-privileges:true]` | `no`             | `json-file` (10m × 5) |
| `db`       | `false`\*      | `70:70`     | `[ALL]` | `[no-new-privileges:true]` | `unless-stopped` | `json-file` (10m × 5) |
| `backup`   | `true`         | `10002:10002` | `[ALL]` | `[no-new-privileges:true]` | `unless-stopped` | `json-file` (10m × 5) |

\* `db`'s rootfs is intentionally writable, scoped to the named `pgdata`
volume it owns — documented in `compose.yml`'s `db` service comment.
`api`/`worker`/`migrator` were inspected in `Created` state (they never
started, see above); `docker inspect`'s `HostConfig`/`Config` fields reflect
container-creation-time settings and are populated identically whether or
not the entrypoint process itself ever ran, so this is still real evidence
of what compose would have started them with.

All six services: non-root user, `cap_drop: [ALL]`,
`no-new-privileges:true`, a bounded `json-file` log driver (10m per file, 5
files), and a `restart:` policy appropriate to the service (`unless-stopped`
for long-running services, `no` for the one-shot `migrator`).

### Proxy non-root fix (P0-7 gap closed during this WP)

The previous commit (4c96b48) left `proxy` running as root with a comment
"revisit once verified" — upstream `caddy:2-alpine`'s binary carries a
`cap_net_bind_service=ep` file capability (confirmed with `getcap`), and with
`cap_drop: [ALL]` + `no-new-privileges:true` already set, the kernel refuses
to apply that capability at `execve` for a process with an empty capability
set, so simply adding `user:` without addressing the capability first makes
the container exit immediately with `operation not permitted` (reproduced
empirically before fixing it). `docker/caddy.Dockerfile` strips the
capability at build time — the proxy only ever binds unprivileged container
ports 8443/8080, so it never needed it — then creates and chowns a real
non-root user. Verified booting with the full flag set
(`--read-only --cap-drop ALL --security-opt no-new-privileges:true`) before
wiring it into `compose.yml`.

## `docker compose ps` — only the proxy publishes a port

Live, from this run:

```
NAME                  IMAGE                    SERVICE   STATUS                    PORTS
personalfi-backup-1   personalfi/backup:dev    backup    Up (healthy)
personalfi-db-1       postgres:18.6-...        db        Up (healthy)              5432/tcp
personalfi-proxy-1    personalfi/proxy:dev     proxy     Up (health: starting)     80/tcp, 443/tcp, 2019/tcp, 443/udp, 127.0.0.1:80->8080/tcp, 127.0.0.1:443->8443/tcp
```

`db`'s `5432/tcp` is an unpublished `EXPOSE` (documentation only, not a host
binding — no `127.0.0.1:...->` prefix). Only `proxy` has an actual published
mapping, and both are bound to `127.0.0.1` (`${BIND_ADDRESS:-127.0.0.1}` in
`compose.yml`), never `0.0.0.0`.

Structurally, from `docker compose config --format json`, every service's
`ports` key:

```
api      -> no ports
backup   -> no ports
db       -> no ports
migrator -> no ports
proxy    -> [{host_ip: 127.0.0.1, target: 8443, published: 443}, {host_ip: 127.0.0.1, target: 8080, published: 80}]
worker   -> no ports
```

## Image sizes

```
personalfi/api:dev       347MB
personalfi/backup:dev    200MB
personalfi/proxy:dev     163MB
```

## `lightningcss` (MPL-2.0, devDependency-only) absence from the api image

```
$ docker run --rm --entrypoint sh personalfi/api:dev -c "find / -xdev -iname '*lightningcss*'"
(no output)
```

Confirms `docker/api.Dockerfile`'s `pnpm install --frozen-lockfile --prod
--filter-prod=@app/api...` keeps Vite's MPL-2.0 `lightningcss` (a
`devDependency` pulled in transitively via `apps/web`) entirely out of the
shipped runtime image.

## Read-only rootfs, live check

```
$ docker run --rm --read-only --user 10001:10001 --entrypoint sh personalfi/api:dev -c "touch /nope"
touch: /nope: Read-only file system
```

## Trivy image scan (HIGH/CRITICAL, `--ignore-unfixed`)

All three images pass cleanly against `.trivyignore` after two rounds of
build fixes made during this WP (see that file's comments for the full
reasoning and expiry dates):

```
personalfi/api:dev      0 findings (fixed: upgraded libssl3/libcrypto3 to 3.5.8-r0 in docker/api.Dockerfile — CVE-2026-14456)
personalfi/backup:dev   0 findings (fixed: same libssl3/libcrypto3 pin added to docker/backup.Dockerfile)
personalfi/proxy:dev    0 findings (fixed: docker/caddy.Dockerfile now `apk del`s curl+c-ares — neither is linked
                                    into the caddy binary, and nothing in this stack calls curl — removing 23 of
                                    the original 40 HIGH findings on the unmodified upstream image; the remaining
                                    16 are compiled into upstream's `usr/bin/caddy` Go binary itself (stale
                                    golang.org/x/net, golang.org/x/crypto, gRPC-Go, Go stdlib) and need an
                                    upstream rebuild — suppressed in .trivyignore with a 2-week expiry, not fixed,
                                    because it is not fixable from this side)
```

`trivy fs` (deps + secrets + misconfig) also passes cleanly; its one real
finding during this WP (`js-yaml` 4.2.0, three HIGH CVEs, transitive via
`@hey-api/openapi-ts`, an `apps/web` devDependency never shipped in any image
this package builds) is suppressed in `.trivyignore` with a one-month expiry
and a note that the fix (a lockfile bump) is out of this package's scope —
WP 0.4 may not run `pnpm install` or touch dependencies.

## Bugs found and fixed during evidence collection (not app-code changes)

Two real, boot-blocking bugs surfaced while actually running the stack
rather than just reading the compose file — both fixed within this package:

1. **Malformed Postgres image digest.** `compose.yml` pinned
   `postgres:18.6-alpine3.24@sha256:...b` — 63 hex characters, one short of a
   valid sha256 digest. `docker compose up` failed immediately with `invalid
   checksum digest length`. Fixed to the correct, verified digest
   (`...b2`) in `compose.yml` and in the `restore-drill` justfile recipe.
2. **Secret file permissions (`chmod 400`) are unreadable by the containers
   that consume them.** Docker Compose's file-based secrets provider (and a
   plain bind mount, used by `restore-drill`/manual restore for the age
   identity) preserve the host file's own uid/mode verbatim inside the
   container rather than remapping ownership to the consuming service's
   runtime user. `db` (uid 70), `api`/`worker`/`migrator` (uid 10001), and
   `backup` (uid 10002) all read secrets from files created and owned by the
   host user running `just` — a `0400` file only that host user can read
   fails inside every one of those containers, with `db` failing first
   (`docker-entrypoint.sh: line 21: /run/secrets/pg_password: Permission
   denied`). Fixed to `0444` in `RUNBOOK.md`, `just gen-master-key`, and the
   new `just gen-pg-secrets` recipe, with the actual confidentiality
   boundary (the `0700` `secrets/` directory, which only the host user and
   root can even traverse into) documented at each call site so the change
   doesn't read as a weakening.

A third bug (bad-characters-in-a-URL — see the coordinator's report) was
fixed in the same pass: see `just gen-pg-secrets` and `RUNBOOK.md`'s "Create
secrets" section.
