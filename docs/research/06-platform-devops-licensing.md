# Platform / DevOps / Licensing Memo — PersonalFi

**Author:** DevOps-Platform panel seat
**Date:** 2026-09-10
**Scope:** container strategy, compose topology, ingress, data ops, CI/CD, observability, licensing, sidecar upgrades, DX
**Audience:** Chris (single operator, Arch Linux x86_64, Docker 29)

> Verification note: every version/tag/license claim below was checked against upstream on
> **2026-09-10**. Time-sensitive claims carry inline citations. Anything not cited is a design
> opinion, not a fact.

---

## 0. Executive verdict (read this if you read nothing else)

1. **Alpine: yes, with one carve-out.** Alpine 3.24 is current stable (3.24.0 released 2026-06-09,
   3.24.1 on 2026-06-13, ~2 years of support → mid-2028) and every image we actually own — proxy,
   API, worker, adapter, migrator, backup — runs on it cleanly. The carve-out is the **Vibe-Trading
   sidecar**, which we do not own and should not force onto musl.
2. **Skip Redis.** Postgres 18 + pg-boss is enough for a one-user job queue. One fewer daemon, one
   fewer credential, one fewer backup surface.
3. **Skip public ingress entirely by default.** LAN + Caddy internal CA. Remote access via Tailscale
   Serve. Use Plaid **polling** (`/transactions/sync`) as the primary path so there is no public
   attack surface at all; webhooks are an optional profile.
4. **License gate is a hard CI failure on GPL/AGPL/SSPL in the runtime dependency tree.** Vibe-Trading
   itself is MIT, so the copyleft risk we feared does not materialize — but we keep the
   network-boundary isolation anyway, for upgrade-blast-radius reasons rather than license reasons.

---

## 1. Container strategy

### 1.1 Base image decisions

| Component | Base | Why | Size target (compressed) |
|---|---|---|---|
| Reverse proxy | `caddy:2.11.2-alpine` | official, Alpine, ACME+internal CA built in | ~20 MB |
| API (TypeScript) | `node:26.8.2-alpine3.24` | current `26-alpine` resolves here | ≤ 90 MB |
| API (if Go chosen) | build on `golang:1.25-alpine`, ship on `alpine:3.24` | static-ish musl binary | ≤ 20 MB |
| Worker | **same image as API**, different `command` | zero extra bytes, zero version skew | +0 MB |
| Postgres | `postgres:18.4-alpine` | 18-alpine actively published (pushed 2026-09-08) | ~60 MB |
| Migrator | same image as API, one-shot | no drift between app and schema | +0 MB |
| Backup/restore | `alpine:3.24` + `postgresql18-client`, `age`, `rclone` | tiny, auditable | ≤ 35 MB |
| Vibe-Trading adapter (ours) | `python:3.14.7-alpine3.24` | thin shim, pure-Python deps only | ≤ 60 MB |
| Vibe-Trading (upstream) | **not Alpine** — upstream image or `python:3.14-slim` | see §1.3 | 600 MB–1.5 GB |

Sources for tags: [node on Docker Hub](https://hub.docker.com/_/node),
[python on Docker Hub](https://hub.docker.com/_/python),
[postgres on Docker Hub](https://hub.docker.com/_/postgres),
[caddy on Docker Hub](https://hub.docker.com/_/caddy),
[Alpine 3.24.0 release](https://alpinelinux.org/posts/Alpine-3.24.0-released.html).

### 1.2 The musl minefield — concrete, not hand-wavy

**Node native modules.**

- `better-sqlite3` — musl prebuilds exist but **historically lag the glibc ones by months**,
  especially on `linuxmusl-arm64`; the v12/Node 24 cycle is the documented example
  ([WiseLibs/better-sqlite3#1382](https://github.com/WiseLibs/better-sqlite3/issues/1382),
  [#1384](https://github.com/WiseLibs/better-sqlite3/issues/1384)). If we pick SQLite, we must be
  willing to compile from source in the builder stage. Force the target explicitly:
  `npm_config_target_libc=musl`.
- `argon2` (node-argon2) — node-gyp build; needs `build-base python3` in the builder stage. **Prefer
  `@node-rs/argon2`** (napi-rs, ships `linux-x64-musl` / `linux-arm64-musl` prebuilds) and sidestep
  the whole problem. If you must use `argon2`, compile it in the builder and copy only
  `node_modules` forward.
- `sharp` — fine on musl. `@img/sharp-libvips-linuxmusl-x64` is published and sharp auto-selects it;
  for cross-builds use `npm install --cpu=x64 --os=linux --libc=musl sharp`
  ([sharp install docs](https://sharp.pixelplumbing.com/install/)). The classic
  `'linux-x64' binaries cannot be used on the 'linuxmusl-x64' platform` error is purely a symptom of
  `npm ci` having run on a glibc host and the `node_modules` being copied into Alpine — **never bind
  mount or COPY a host `node_modules` into a container.**

**Python wheels.** `musllinux_1_2` wheels are now routine for the numeric core (numpy, pandas,
pyarrow, cryptography, pydantic-core, orjson). The long tail is where it bites: one obscure
transitive dep without a musllinux wheel turns a 40-second build into a 20-minute `gcc` marathon,
or a hard failure. Two rules:

- Our **adapter** stays on Alpine because we control its dependency list and keep it to
  `httpx + pydantic + structlog`. All three have musllinux wheels.
- Anything with an uncontrolled dependency closure (i.e. Vibe-Trading, which pulls LangChain and
  broker SDKs) does **not** go on Alpine. See [pythonspeed's base image
  analysis](https://pythonspeed.com/articles/base-image-python-docker-images/) and
  [rpep.dev on the Alpine/Python antipattern](https://rpep.dev/posts/alpine-python-antipattern/) for
  the general case.

**glibc-compat is a trap.** `apk add gcompat` / `libc6-compat` papers over symbol lookups but leaves
you with subtly different `dlopen`, DNS resolution, and threading behaviour. If a component needs
glibc, **give it glibc** — do not shim it.

**musl allocator.** musl's malloc is slower than glibc's under multithreaded allocation churn. For a
single user this is irrelevant. Noted only so nobody rediscovers it and panics.

### 1.3 When Alpine is the wrong call, and the escape hatch

Alpine is the wrong call when **the dependency closure is not ours to control**. That is exactly one
service: Vibe-Trading.

Escape-hatch ladder, in order of preference:

1. **Use upstream's own published image**, pinned by digest. Vibe-Trading ships a `Dockerfile` and
   `docker-compose.yml` ([HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)). Lowest
   maintenance.
2. **`python:3.14-slim` (Debian)** if we must build it ourselves from `pip install vibe-trading-ai`.
   Boring, works, ~2x the bytes, who cares — it is profile-gated and rarely pulled.
3. **Wolfi / `cgr.dev/chainguard/wolfi-base`** as a "glibc but minimal and low-CVE" middle ground.
   Caveat worth knowing before you build a workflow on it: since 2023-08-16 the **free public
   Chainguard catalog only serves `:latest` and `:latest-dev`** — versioned tags are a paid tier
   ([Chainguard policy post](https://www.chainguard.dev/unchained/important-updates-for-chainguard-images-public-catalog-users)).
   `:latest`-only is incompatible with our pin-everything policy unless we pin the digest and accept
   manual bumps. **Recommendation: keep Wolfi as a documented option, do not adopt it now.**

This honours the Alpine preference where it costs us nothing (8 of 9 images) and spends the exception
budget exactly once, on the service whose churn we do not control.

### 1.4 Hardening baseline (applies to every image we build)

- **Pinned base by digest.** `FROM node:26.8.2-alpine3.24@sha256:...`. Renovate maintains the digest
  (§5.6). Tags are mutable; digests are not.
- **Non-root `USER`.** Explicit numeric UID/GID (`10001:10001`), not a name — numeric survives
  `--read-only` and makes volume ownership reasoning possible. The `node` image already has
  `node` at 1000; we create our own to avoid collisions with host UID 1000.
- **`read_only: true` rootfs** on every service, with `tmpfs` for `/tmp` and any runtime dir.
- **`cap_drop: [ALL]`**, `security_opt: [no-new-privileges:true]`.
- **`tini`** as PID 1 (`apk add --no-cache tini`, `ENTRYPOINT ["/sbin/tini","--"]`). Node 26 handles
  SIGTERM reasonably but will not reap adopted zombies; Python/uvicorn definitely needs it. Alpine
  ships `tini` in main, so no extra download. (`dumb-init` is equivalent; pick one, ours is `tini`.)
- **`HEALTHCHECK`** in the Dockerfile *and* `healthcheck` in compose (compose wins; Dockerfile one is
  for people running `docker run` by hand).
- **Multi-arch `linux/amd64,linux/arm64`** via buildx. Costs nothing today, saves a migration the day
  a Pi 5 or an Apple Silicon box shows up.
- **Reproducible builds:** `SOURCE_DATE_EPOCH` from the commit timestamp,
  `--build-arg BUILDKIT_INLINE_CACHE=1`, `rewrite-timestamp=true` on the buildx exporter, lockfiles
  committed (`pnpm-lock.yaml` / `uv.lock`), `npm ci --frozen-lockfile` / `uv sync --frozen`. Verify
  quarterly by building the same commit twice and diffing image digests.

### 1.5 Dockerfile sketch (Node/TS API + worker, one image)

```dockerfile
# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT

ARG NODE_IMAGE=node:26.8.2-alpine3.24@sha256:REPLACE_WITH_REAL_DIGEST
ARG ALPINE_IMAGE=alpine:3.24@sha256:REPLACE_WITH_REAL_DIGEST

# ---------- deps: resolve + build native modules against musl ----------
FROM ${NODE_IMAGE} AS deps
RUN apk add --no-cache build-base python3 libc-dev
ENV npm_config_target_libc=musl
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/ packages/
RUN --mount=type=cache,target=/pnpm-store,sharing=locked \
    corepack enable && \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --filter @personalfi/api...

# ---------- build: typecheck + bundle ----------
FROM deps AS build
COPY . .
RUN pnpm --filter @personalfi/api build && \
    pnpm deploy --filter @personalfi/api --prod --legacy /out && \
    # strip build-only junk that survives --prod
    find /out/node_modules -name "*.ts" -o -name "*.map" -delete

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini && \
    addgroup -g 10001 -S app && \
    adduser  -u 10001 -S -G app -H -s /sbin/nologin app
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    TZ=UTC
COPY --from=build --chown=root:root /out ./
USER 10001:10001
EXPOSE 8080
# rootfs is read-only at runtime; everything writable is a tmpfs or a volume
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/server.js"]        # worker overrides: ["node","dist/worker.js"]

LABEL org.opencontainers.image.source="https://github.com/chris/personalfi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="personalfi-api"
```

Notes on the sketch: the builder installs `build-base` so `better-sqlite3`/`argon2` can compile if a
musl prebuild is missing, but **none of that toolchain reaches the runtime layer**. `pnpm deploy
--prod` produces a self-contained tree so we never copy a dev `node_modules`. `COPY --chown=root:root`
plus `USER 10001` means the app cannot modify its own code — belt and braces with `read_only: true`.

---

## 2. Compose topology

### 2.1 Service inventory and network segmentation

Three networks, and the segmentation is the security control that matters most here:

- **`edge`** — Caddy only, plus whatever Caddy proxies to. Bridge, published ports bound to
  `127.0.0.1` or the LAN IP, never `0.0.0.0` by accident.
- **`backend`** — `internal: true`. api, worker, db, migrator, backup. No route off-box.
- **`sidecar`** — `internal: true`. adapter + vibe-trading (+ ollama). **db is not on this network**,
  so the sidecar literally cannot reach Postgres even if it is fully compromised. The adapter is the
  only member of both `backend` and `sidecar`, and it is our code.

Egress note: `internal: true` blocks outbound too. The API needs outbound HTTPS for Plaid/Coinbase,
so the API sits on `backend` **and** a fourth `egress` network that is a normal (non-internal)
bridge. The db never touches `egress`. Vibe-Trading needs outbound for LLM APIs — give it `egress`
only if you are using a cloud LLM; if you run Ollama locally, keep it fully internal.

### 2.2 Proxy: Caddy, not Traefik

Caddy wins for this deployment: `tls internal` gives a working local CA in one directive, the
Caddyfile is ~15 lines vs. a label soup, and there is no need for Traefik's dynamic
service-discovery when the service list is static and hand-written. Traefik's advantage (auto-discover
containers by label) is a solution to a problem a single-user compose file does not have.

One Caddy gotcha for containers: **Caddy tries to install its root CA into the system trust store and
fails as a non-root user in a container** ([Caddy docs](https://caddyserver.com/docs/caddyfile/directives/tls)).
That is fine — we extract `/data/caddy/pki/authorities/local/root.crt` from the volume and install it
on Chris's Arch box and phone once. Make target: `make trust-ca`.

### 2.3 Queue: no Redis

pg-boss on Postgres 18. Cron scheduling, retries with exponential backoff, singleton keys, archiving,
and a maintained migration path — all the things a nightly-sync app needs, using `SKIP LOCKED` and
`LISTEN/NOTIFY`. A single-user app will never see the ~100–200 jobs/sec ceiling where Postgres queues
start to hurt. (pg-boss v12 is current as of mid-2026; verify the exact minor at implementation time.)
Graphile Worker is the reasonable alternative if the team wants jobs enqueued from inside SQL
transactions. **Redis/Valkey is not justified** — it would exist only to hold a queue we already have
a home for, while adding a second stateful service to back up.

### 2.4 Secrets

Ranked for this threat model (single operator, laptop-adjacent box, git repo that may go public):

1. **`sops` + `age` for secrets at rest in the repo** → decrypted by `make up` into
   `./secrets/*.txt` (gitignored, mode 0600) → mounted as **Docker Compose file secrets** at
   `/run/secrets/*`. This gives you encrypted-in-git, plaintext-only-in-tmpfs, and no secrets in
   `docker inspect`.
2. Compose `secrets:` without sops — fine, but then the plaintext files live unencrypted on disk and
   are trivially left out of backups by accident.
3. **`env_file` — last resort.** Environment variables leak into `docker inspect`, into child process
   environments, into crash dumps, and into any library that logs `process.env`. Use env vars only
   for non-secret config (`LOG_LEVEL`, `PGHOST`, feature flags).

Rule: **every secret is read from a file path**, and the app takes `PLAID_SECRET_FILE=/run/secrets/plaid_secret`,
never `PLAID_SECRET`. Same for the DB password and the age backup key.

### 2.5 `docker-compose.yml` sketch

```yaml
# SPDX-License-Identifier: MIT
# docker compose up -d                      -> core (proxy, api, worker, db)
# docker compose --profile sidecar up -d    -> + vibe-trading adapter + upstream
# docker compose --profile local-llm up -d  -> + ollama
# docker compose --profile metrics up -d    -> + prometheus scrape target
# docker compose --profile remote up -d     -> + tailscale

x-common: &common
  restart: unless-stopped
  init: false                    # we ship tini ourselves
  read_only: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  logging:
    driver: "local"              # not json-file: local driver compresses + rotates properly
    options: { max-size: "10m", max-file: "5" }
  environment:
    TZ: UTC

x-app-image: &app-image
  image: ghcr.io/chris/personalfi-api:${PERSONALFI_VERSION:?set in .env}

networks:
  edge:     {}
  backend:  { internal: true }
  sidecar:  { internal: true }
  egress:   {}                   # outbound-capable, db never joins this

volumes:
  pgdata:       {}
  caddy_data:   {}
  caddy_config: {}
  backups:      {}
  ts_state:     {}
  ollama:       {}

secrets:
  pg_password:    { file: ./secrets/pg_password.txt }
  plaid_secret:   { file: ./secrets/plaid_secret.txt }
  app_enc_key:    { file: ./secrets/app_enc_key.txt }
  backup_age_key: { file: ./secrets/backup_age_key.txt }

services:

  proxy:
    <<: *common
    image: caddy:2.11.2-alpine@sha256:REPLACE
    ports:
      - "192.168.1.50:443:443"     # LAN IP only, never 0.0.0.0
      - "192.168.1.50:80:80"
    networks: [edge]
    volumes:
      - ./infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    tmpfs: ["/tmp:size=16m,mode=1777,noexec,nosuid,nodev"]
    depends_on:
      api: { condition: service_healthy }
    deploy:
      resources: { limits: { cpus: "0.50", memory: 128M } }

  api:
    <<: [*common, *app-image]
    command: ["node","dist/server.js"]
    networks: [edge, backend, egress]
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
      PGHOST: db
      PGUSER: personalfi
      PGDATABASE: personalfi
      PGPASSWORD_FILE: /run/secrets/pg_password
      PLAID_SECRET_FILE: /run/secrets/plaid_secret
      APP_ENC_KEY_FILE: /run/secrets/app_enc_key
      ADAPTER_URL: http://adapter:8000     # empty when sidecar profile is off
    secrets: [pg_password, plaid_secret, app_enc_key]
    tmpfs: ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"]
    depends_on:
      db:       { condition: service_healthy }
      migrator: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 3s
      start_period: 20s
      retries: 3
    deploy:
      resources: { limits: { cpus: "2.0", memory: 768M } }

  worker:
    <<: [*common, *app-image]
    command: ["node","dist/worker.js"]
    networks: [backend, egress]
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
      PGHOST: db
      PGUSER: personalfi
      PGDATABASE: personalfi
      PGPASSWORD_FILE: /run/secrets/pg_password
      APP_ENC_KEY_FILE: /run/secrets/app_enc_key
      PLAID_SECRET_FILE: /run/secrets/plaid_secret
    secrets: [pg_password, plaid_secret, app_enc_key]
    tmpfs: ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"]
    depends_on:
      db:       { condition: service_healthy }
      migrator: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD","node","dist/worker-health.js"]   # checks pg-boss heartbeat row
      interval: 60s
      timeout: 5s
      start_period: 30s
      retries: 3
    deploy:
      resources: { limits: { cpus: "1.0", memory: 512M } }

  migrator:
    <<: [*app-image]
    command: ["node","dist/migrate.js"]
    restart: "no"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    networks: [backend]
    environment:
      PGHOST: db
      PGUSER: personalfi
      PGDATABASE: personalfi
      PGPASSWORD_FILE: /run/secrets/pg_password
    secrets: [pg_password]
    tmpfs: ["/tmp:size=16m"]
    depends_on:
      db: { condition: service_healthy }

  db:
    <<: *common
    image: postgres:18.4-alpine@sha256:REPLACE
    networks: [backend]            # no edge, no egress, no sidecar
    user: "70:70"                  # alpine postgres uid/gid
    environment:
      POSTGRES_USER: personalfi
      POSTGRES_DB: personalfi
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
      POSTGRES_INITDB_ARGS: "--data-checksums"
      PGDATA: /var/lib/postgresql/data/pgdata
    secrets: [pg_password]
    volumes:
      - pgdata:/var/lib/postgresql/data
    tmpfs:
      - /tmp:size=64m
      - /run/postgresql:size=64m,uid=70,gid=70
    shm_size: 256m
    command:
      - postgres
      - -c=max_connections=40
      - -c=shared_buffers=256MB
      - -c=wal_level=replica
      - -c=log_min_duration_statement=500
    healthcheck:
      test: ["CMD-SHELL","pg_isready -U personalfi -d personalfi"]
      interval: 10s
      timeout: 5s
      start_period: 30s
      retries: 5
    deploy:
      resources: { limits: { cpus: "2.0", memory: 1G } }

  backup:
    <<: *common
    image: ghcr.io/chris/personalfi-backup:${PERSONALFI_VERSION}
    networks: [backend, egress]
    environment:
      PGHOST: db
      PGUSER: personalfi
      PGDATABASE: personalfi
      PGPASSWORD_FILE: /run/secrets/pg_password
      AGE_RECIPIENTS_FILE: /run/secrets/backup_age_key
      RETENTION_DAYS: "30"
      RCLONE_REMOTE: ${RCLONE_REMOTE:-}        # empty = local disk only
    secrets: [pg_password, backup_age_key]
    volumes:
      - backups:/backups
    tmpfs: ["/tmp:size=256m"]
    depends_on:
      db: { condition: service_healthy }
    deploy:
      resources: { limits: { cpus: "0.50", memory: 256M } }

  # ---------- optional: vibe-trading ----------
  adapter:                          # OUR code. the only member of both networks.
    <<: *common
    profiles: ["sidecar"]
    image: ghcr.io/chris/personalfi-vt-adapter:${PERSONALFI_VERSION}
    networks: [backend, sidecar]    # NOT egress
    environment:
      VT_UPSTREAM_URL: http://vibe-trading:8000
      VT_PINNED_VERSION: "0.1.15"
      LOG_LEVEL: info
    tmpfs: ["/tmp:size=32m"]
    healthcheck:
      test: ["CMD","python","-c","import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=2).status==200 else 1)"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
    deploy:
      resources: { limits: { cpus: "0.50", memory: 256M } }

  vibe-trading:                     # UPSTREAM. pinned by digest. no db, no backend.
    <<: *common
    profiles: ["sidecar"]
    image: ghcr.io/hkuds/vibe-trading:0.1.15@sha256:REPLACE
    read_only: false                # upstream not audited for read-only rootfs; revisit
    networks: [sidecar, egress]     # drop egress if using local ollama only
    environment:
      VIBE_TRADING_MODE: api
      ANTHROPIC_API_KEY_FILE: /run/secrets/anthropic_key
    tmpfs: ["/tmp:size=512m"]
    deploy:
      resources: { limits: { cpus: "2.0", memory: 2G } }

  ollama:
    <<: *common
    profiles: ["local-llm"]
    image: ollama/ollama:0.12-rc@sha256:REPLACE   # NOT alpine upstream; accepted exception
    read_only: false
    networks: [sidecar]
    volumes: [ollama:/root/.ollama]
    deploy:
      resources: { limits: { cpus: "6.0", memory: 12G } }

  tailscale:
    <<: *common
    profiles: ["remote"]
    image: tailscale/tailscale:v1.90@sha256:REPLACE
    hostname: personalfi
    cap_drop: []                    # needs NET_ADMIN
    cap_add: [NET_ADMIN, NET_RAW]
    networks: [edge]
    environment:
      TS_AUTHKEY_FILE: /run/secrets/ts_authkey
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
      TS_EXTRA_ARGS: "--advertise-tags=tag:personalfi"
    volumes:
      - ts_state:/var/lib/tailscale
      - ./infra/tailscale/serve.json:/config/serve.json:ro
    tmpfs: ["/tmp:size=32m"]
```

Compose notes:

- `deploy.resources.limits` **is** honoured by `docker compose up` in Compose v2 (non-swarm) — it maps
  to cgroup limits. The `deploy.replicas`/`placement` keys are the swarm-only ones.
- `logging.driver: local` rather than `json-file`: the local driver compresses and rotates without
  the unbounded-growth footgun.
- `depends_on` with `service_completed_successfully` on `migrator` is the whole migration story — no
  init-container framework needed.
- `restart: unless-stopped` everywhere except `migrator` (`no`) so a migration failure is loud instead
  of a crash loop.

### 2.6 Volume permissions on Alpine

Use **named volumes, not bind mounts**, for all stateful paths. The `postgres` image's entrypoint
chowns `PGDATA` to uid 70 on first init; Docker copies the image's ownership into an empty named
volume, so this Just Works. Bind mounts inherit host ownership (Chris's uid 1000) and then a
container running as uid 70 or 10001 cannot write — the single most common "why won't my Alpine
container start" cause. The only bind mounts in the file above are `:ro` config files.

If a bind mount is ever unavoidable: `chown -R 10001:10001 ./thatdir` on the host, and document the
UID in `.env.example`.

---

## 3. Ingress

### 3.1 Default posture: LAN only

- Caddy binds to the LAN IP explicitly (`192.168.1.50:443:443`), not `0.0.0.0`. Docker's
  `iptables` integration cheerfully punches through UFW/firewalld, so **do not rely on the host
  firewall** to keep a `0.0.0.0` publish private.
- TLS via **Caddy's internal CA** (`tls internal`). Real certificates, real hostname
  (`personalfi.lan`), no ACME, no public DNS, no rate limits. One-time root CA install on each client.

```caddyfile
# infra/caddy/Caddyfile
{
	admin off
	email chris@thebrutus.org
}

personalfi.lan {
	tls internal
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options    "nosniff"
		X-Frame-Options           "DENY"
		Referrer-Policy           "no-referrer"
		Content-Security-Policy   "default-src 'self'; img-src 'self' data:; connect-src 'self'"
		-Server
	}

	handle /api/* {
		reverse_proxy api:8080
	}
	handle {
		reverse_proxy api:8080        # SPA served by the API, or root_fs the dist/
	}
}
```

If you ever want a real publicly-trusted cert for the LAN name (so phones do not need the CA
installed), use **Let's Encrypt with the DNS-01 challenge** on a domain you own
(`personalfi.thebrutus.org` → `A 192.168.1.50`). That requires the Caddy DNS-provider plugin, which
means a custom Caddy build — `FROM caddy:2.11.2-builder-alpine` → `xcaddy build --with
github.com/caddy-dns/cloudflare`. Worth it only if the CA-install step is genuinely annoying.

### 3.2 Remote access: Tailscale Serve

**Recommended.** Tailscale sidecar with `network_mode` or a shared network + `TS_SERVE_CONFIG`
pointing at Caddy. Serve (not Funnel) keeps it on the tailnet — authenticated at the WireGuard layer
by device identity, zero public exposure, works from phone and laptop anywhere.

Critical operational detail: **`TS_STATE_DIR` must be on a persistent volume** or the node
re-registers as a new machine on every restart and you accumulate zombie devices
([Tailscale Docker guide](https://tailscale.com/blog/docker-tailscale-guide),
[runtimeterror's Serve sidecar writeup](https://runtimeterror.dev/tailscale-serve-docker-compose-sidecar/)).
Also set a tailnet ACL tag so the node is scoped, and layer app auth on top — Serve is a transport
control, not an authorization system.

Comparison:

| Option | Verdict |
|---|---|
| **Tailscale Serve** | **Chosen.** No public surface, device-identity auth, 5-minute setup, ~20 MB RAM. |
| Tailscale **Funnel** | Only if a public webhook path is genuinely required (§3.3). Enable per-path, never for the whole app. |
| Cloudflare Tunnel | Works, but terminates TLS at Cloudflare — a third party sees plaintext bank data. **Reject for this app.** |
| Raw WireGuard | Fine, more manual (key distribution, NAT traversal, MagicDNS-equivalent). Tailscale is WireGuard with the annoying parts solved. |

### 3.3 Plaid webhooks: recommend polling, gate webhooks behind a profile

**Primary recommendation: poll `/transactions/sync` on a pg-boss cron schedule** (every 4–6 hours,
plus on-demand from the UI). For one user's accounts, the latency difference between "new transaction
appears within 4 hours" and "within 30 seconds" is worth exactly zero, and it buys us **no public
ingress at all**.

Note that even Plaid's own guidance treats webhooks as a hint, not a data channel: the
`SYNC_UPDATES_AVAILABLE` / `DEFAULT_UPDATE` webhook tells you to go call `/transactions/sync`, and
Plaid explicitly warns that webhooks can be lost if you are down past the retry window, so you need
polling as a fallback regardless ([Plaid transactions webhooks](https://plaid.com/docs/transactions/webhooks/)).
**If polling is mandatory as a fallback anyway, make it the only path and delete the attack surface.**

If webhooks are later wanted, the minimal-exposure design:

1. A **separate Caddy site block** exposed via Tailscale **Funnel** (or a Cloudflare Tunnel restricted
   to one hostname), routing **only** `POST /webhooks/plaid` — everything else returns 404.
2. Verify the `Plaid-Verification` **JWT** against Plaid's JWK before touching the body
   ([Plaid webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/)). Use a
   maintained JOSE library; do not hand-roll ES256 verification.
3. Rate-limit the path in Caddy, cap body size (`request_body max_size 64KB`).
4. The handler does nothing but validate, write an idempotency-keyed row, and enqueue a pg-boss job.
   **No business logic on the public path.**
5. Keep it behind `--profile webhooks` so the default deployment has no public listener.

---

## 4. Data ops

### 4.1 Postgres backups

**pgBackRest is overkill.** For a single-user database that will plausibly stay under a few GB, the
right answer is:

- **Nightly `pg_dump -Fc`** (custom format, compressed, restorable table-by-table), run by a pg-boss
  cron job that `exec`s in the backup container — or simpler, a `systemd` timer on the host calling
  `docker compose run --rm backup`.
- **Encrypt with `age`** immediately, before the file touches any non-local disk:
  `pg_dump -Fc | age -r age1... > personalfi-$(date -u +%Y%m%dT%H%M%SZ).dump.age`.
  Use an **age recipient public key** so the backup container holds only the public half — the
  private key lives in Chris's password manager and on a paper/offline copy. A backup container that
  cannot decrypt its own backups is a meaningful ransomware mitigation.
- **Destinations:** `backups` volume (local, 30-day retention) + optional `rclone` push to B2 or S3.
  B2 with object-lock/versioning if you want immutability. `RCLONE_REMOTE` empty = local only.
- **WAL archiving: not initially.** It exists to shrink RPO below one day. For personal finance,
  losing at most one day of *derived* data (the source of truth is still at Plaid/Coinbase and can be
  re-synced) is acceptable. Revisit if manual data entry becomes significant — at that point add
  `archive_command` piping WAL through `age` to the same destination, or move to Litestream-style
  continuous replication.

### 4.2 Restore drills as a make target — non-negotiable

```make
restore-drill:  ## prove the newest backup actually restores (runs in a throwaway container)
	@bash scripts/restore-drill.sh
```

`scripts/restore-drill.sh`: spins an ephemeral `postgres:18.4-alpine` on a scratch volume, decrypts
the newest `.age` with the private key, `pg_restore`s into it, runs a fixed assertion query set
(`SELECT count(*) FROM transactions;`, latest `schema_migrations` version, a checksum over a
deterministic subset), prints a PASS/FAIL, and destroys the container. **Wire this into a monthly
`systemd` timer that writes its result into the app's own sync-run table so an untested backup shows
up as a red card on the dashboard.** An untested backup is a rumour.

### 4.3 SQLite alternative

If the panel lands on SQLite instead of Postgres: **Litestream v0.5.x**, which is a materially better
tool than the 0.3 series people remember — it replaced the old snapshot+WAL model with TXID-based
**LTX** files that compact into a hierarchy, so a point-in-time restore now pulls roughly a dozen
files instead of thousands, and it **dropped CGO** (now `modernc.org/sqlite`), which means a truly
static binary that drops into an Alpine image with no musl drama
([Fly blog: Litestream v0.5.0](https://fly.io/blog/litestream-v050-is-here/),
[litestream.io](https://litestream.io/)).

Tradeoff to state plainly: SQLite + Litestream gives a **simpler** stack (no db container, continuous
replication, sub-second RPO) but costs the pg-boss queue (you would need a SQLite-native queue or
in-process scheduling), Postgres's `numeric` type discipline, and concurrent-writer headroom. For a
finance app where `numeric(19,4)` correctness matters, **Postgres remains the recommendation**;
Litestream is the documented fallback if operational simplicity wins.

### 4.4 Migrations

One-shot compose service (`migrator` above), same image as the app, `restart: no`, gated by
`depends_on: {condition: service_completed_successfully}`. Forward-only migrations with an explicit
`down` written but never auto-run. The migrator takes a **different, higher-privilege DB role** than
the API — the API's role should not own tables or have DDL rights. `make migrate-new name=...`,
`make migrate-status`.

---

## 5. CI/CD — GitHub Actions

### 5.1 Job list

| # | Job | Runs on | Gate |
|---|---|---|---|
| 1 | `lint` — eslint/biome + `ruff` + `shellcheck` + `hadolint` (Dockerfiles) + `actionlint` | PR + push | blocking |
| 2 | `typecheck` — `tsc --noEmit`, `mypy`/`pyright` on adapter | PR + push | blocking |
| 3 | `test-unit` — vitest/pytest, coverage floor 70% on `packages/core` | PR + push | blocking |
| 4 | `test-integration` — Postgres 18 service container, migrations up, repo tests | PR + push | blocking |
| 5 | `secrets-scan` — gitleaks on full history (`--redact`) | PR + push | blocking |
| 6 | `license-scan` — §5.4, fails on GPL/AGPL/SSPL | PR + push | **blocking** |
| 7 | `build` — buildx, `linux/amd64,linux/arm64`, GHA cache, SBOM+provenance attestations | PR (no push) + main (push) | blocking |
| 8 | `sbom` — syft → SPDX-JSON + CycloneDX, uploaded as artifact and attached to release | main + tags | non-blocking |
| 9 | `vuln-scan` — trivy image scan, `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`; grype as a second opinion (non-blocking) | main + tags + nightly | blocking on main |
| 10 | `sign` — cosign keyless (OIDC→Fulcio→Rekor) + `actions/attest-build-provenance` | tags only | blocking |
| 11 | `contract-test-sidecar` — §8, runs adapter against pinned Vibe-Trading | PR touching adapter + nightly | blocking on adapter PRs |
| 12 | `release` — semantic tag `vX.Y.Z` → changelog, GHCR push of `:X.Y.Z`, `:X.Y`, `:latest`, digest recorded | tags only | blocking |
| 13 | `renovate-validate` — `renovate-config-validator` | PR touching `renovate.json` | blocking |
| 14 | `nightly-freshness` — rebuild `main` image from scratch (no cache) + rescan; catches base-image CVEs between releases | schedule | notify only |

Permissions: every job starts from `permissions: {contents: read}`; only `build`/`sign`/`release`
escalate to `packages: write`, `id-token: write`, `attestations: write`. All third-party actions
pinned to a **commit SHA**, not a tag.

### 5.2 Build & cache

```yaml
- uses: docker/setup-buildx-action@<sha>
- uses: docker/build-push-action@<sha>
  with:
    platforms: linux/amd64,linux/arm64
    cache-from: type=gha,scope=${{ github.workflow }}-${{ matrix.image }}
    cache-to:   type=gha,mode=max,scope=${{ github.workflow }}-${{ matrix.image }}
    provenance: mode=max
    sbom: true
    push: ${{ github.event_name != 'pull_request' }}
    build-args: |
      SOURCE_DATE_EPOCH=${{ steps.meta.outputs.created_epoch }}
    outputs: type=image,rewrite-timestamp=true
```

`arm64` builds run under QEMU emulation and are slow for native-module compilation. If the Node build
crosses ~10 minutes, split into a matrix with `ubuntu-24.04-arm` runners and merge with
`docker buildx imagetools create`.

Docker 29 makes verification easy locally: it added `GET /images/{name}/attestations` for in-toto
statements (SLSA provenance, SPDX SBOM) and an `Identity` field on inspect showing verified signature
info ([Docker Engine 29 release notes](https://docs.docker.com/engine/release-notes/29/)). So
`make verify-image` can check provenance on Chris's box without pulling extra tooling.

### 5.3 Signing

Do **both**, they answer different questions:

- `actions/attest-build-provenance` → SLSA provenance attestation stored in GitHub's attestation
  store, verified with `gh attestation verify`. Answers *"what built this?"*
- `cosign sign --yes` keyless (ambient GHA OIDC → Fulcio short-lived cert → Rekor transparency log).
  Answers *"is this the artifact that workflow produced?"* and is verifiable by anyone with cosign
  and no GitHub account.

Verification command in the Makefile so it is actually run:

```
cosign verify ghcr.io/chris/personalfi-api:$(V) \
  --certificate-identity-regexp '^https://github.com/chris/personalfi/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### 5.4 License scan — the policy, stated precisely

**Allowlist (runtime dependencies only):**
`MIT`, `MIT-0`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `ISC`, `0BSD`, `Unlicense`, `CC0-1.0`,
`Python-2.0`, `PSF-2.0`, `Zlib`, `BlueOak-1.0.0`.

**Allowed with review (`MPL-2.0`, `EPL-2.0`, `CDDL-1.1`, `LGPL-*`):** file-level/weak copyleft. These
are compatible with shipping an MIT app **as long as we do not modify their source and do not
statically link them into our binary**. For a Node/Python app consuming them as separate npm/PyPI
packages, MPL-2.0 is genuinely fine — the reciprocity is per-file and we ship their files unmodified.
Policy: **MPL-2.0 allowed, recorded in `THIRD_PARTY.md`, and flagged in the PR with a comment, not a
failure.** LGPL requires relinking rights; since we never statically link, also fine, but it gets a
human look.

**Hard fail (build stops):** `GPL-1.0+`, `GPL-2.0*`, `GPL-3.0*`, `AGPL-1.0*`, `AGPL-3.0*`, `SSPL-1.0`,
`BUSL-1.1`, `Elastic-2.0`, `Commons-Clause`, `CC-BY-NC-*`, `UNKNOWN`/unparseable.

Note that `UNKNOWN` fails. A dependency with no declared license is not "probably fine" — it is
all-rights-reserved by default.

**devDependencies are exempt from the copyleft rules** (we do not distribute them) but **not** from
the `UNKNOWN` rule, and a GPL devDependency still gets logged so nobody accidentally promotes it to a
runtime dep later.

**Tooling (belt and braces, two independent implementations):**

- `license-checker-rspack` / `license-checker` with `--onlyAllow` for the npm tree, and `pip-licenses
  --fail-on "GPL;AGPL;LGPL;SSPL;EUPL"` for the Python tree. Fast, runs on every PR.
- **`trivy fs --scanners license --license-full`** as the cross-ecosystem second opinion; it maps to
  the SPDX list and catches licenses embedded in vendored files that manifest-readers miss.
- **`scancode-toolkit`** on a **quarterly** schedule only — it is thorough (reads actual file
  headers, not just manifests) and correspondingly slow. Not a per-PR gate.
- Output of record: the **syft SBOM** — `syft ... -o spdx-json` is what we archive per release, and
  `THIRD_PARTY.md` is generated from it, so the attribution file can never drift from the lockfile.

The policy itself lives in `licenses.policy.yaml` at the repo root and is consumed by all of the
above, so there is one list, not four.

### 5.5 Vuln scanning thresholds

`trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`. `--ignore-unfixed` matters:
Alpine's security tracker frequently lists CVEs with no available fix, and failing the build on
something you cannot act on trains people to add blanket ignores. Suppressions go in `.trivyignore`
**with an expiry date and a one-line justification**, and CI fails if any entry is past expiry.

### 5.6 Renovate

```jsonc
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", ":dependencyDashboard", "helpers:pinGitHubActionDigests"],
  "timezone": "America/New_York",
  "schedule": ["* 0-6 * * 1"],           // Monday overnight, one batch
  "prConcurrentLimit": 3,
  "dependencyDashboardApproval": false,
  "packageRules": [
    { "matchUpdateTypes": ["minor", "patch"],
      "matchCurrentVersion": "!/^0/",
      "groupName": "all non-major dependencies",
      "automerge": true,
      "automergeType": "pr",
      "platformAutomerge": true },
    { "matchUpdateTypes": ["major"], "dependencyDashboardApproval": true },
    { "matchDatasources": ["docker"], "pinDigests": true },
    { "matchPackageNames": ["node"], "allowedVersions": "/^26\\./" },
    { "matchPackageNames": ["postgres"], "allowedVersions": "/^18\\./",
      "dependencyDashboardApproval": true },   // major PG = manual, needs dump/restore
    { "matchManagers": ["custom.regex"], "matchPackageNames": ["HKUDS/Vibe-Trading"],
      "groupName": "vibe-trading upstream",
      "automerge": false,
      "labels": ["sidecar", "needs-contract-test"] }
  ],
  "customManagers": [
    { "customType": "regex",
      "managerFilePatterns": ["/^docs/compat/vibe-trading\\.yaml$/"],
      "matchStrings": ["pinned_version:\\s*\"(?<currentValue>.*?)\""],
      "depNameTemplate": "HKUDS/Vibe-Trading",
      "datasourceTemplate": "github-releases" }
  ],
  "vulnerabilityAlerts": { "enabled": true, "schedule": ["at any time"], "labels": ["security"] },
  "lockFileMaintenance": { "enabled": true, "schedule": ["* 0-6 1 * *"] }
}
```

Auto-merge of grouped minors is safe **only because** jobs 1–9 are blocking. If the test suite is
weak, turn auto-merge off — an automerged bad patch at 3 a.m. on a finance app is not a fun morning.

### 5.7 `make dev`

Dev compose overlay (`compose.dev.yaml`) with: source bind-mounted, `tsx watch` / `uvicorn --reload`,
`read_only: false`, Postgres port published to `127.0.0.1:5432` for a GUI client, seeded demo data,
and `NODE_ENV=development`. A `.devcontainer/devcontainer.json` pointing at the same compose file so
VS Code users get the identical environment. `make dev` = `docker compose -f compose.yaml -f
compose.dev.yaml --profile dev up --build`.

---

## 6. Observability — deliberately small

The failure mode here is building a SaaS control plane for one person. The discipline: **if it does
not change what Chris does on a Tuesday morning, it does not get deployed.**

**Ship:**

1. **Structured JSON logs** (pino / structlog) to stdout, `local` log driver with rotation. A
   **redaction allowlist, not a denylist** — the logger serializes only explicitly-permitted fields,
   so a new field containing an access token cannot leak by default. Hard-redact `access_token`,
   `public_token`, `link_token`, `account_number`, `routing_number`, `authorization`, `cookie`,
   `set-cookie`, and anything matching `/(secret|passwd|password|token|key)/i`. Log **account IDs, not
   balances**; log transaction counts, not amounts.
2. **`/healthz`** (process is alive, no dependencies checked — used by Docker/compose) and
   **`/readyz`** (DB reachable, migrations at expected version, pg-boss responsive — used by
   `depends_on` and by the dashboard). Keep them distinct; conflating them causes restart storms
   when the DB blips.
3. **A sync-run dashboard inside the app itself.** One page: last run per connector, status, duration,
   rows added/updated, error message, next scheduled run, last successful backup, last restore-drill
   result. This is 200 lines of app code and it replaces Grafana entirely for this use case — and
   unlike Grafana, it is there when you are already looking at the app.
4. **Job history table** (pg-boss gives you most of this free via its archive) with a retention policy.

**Profile-gated, off by default:**

5. `--profile metrics` → `/metrics` Prometheus endpoint on an internal-only port, plus a
   `prom/prometheus` + `grafana` pair in the same profile. Turn it on for a week when you are chasing
   something, turn it off after. Do not run it permanently.

**Error tracking:** **none initially.** Errors are (a) in the structured logs and (b) surfaced on the
sync dashboard with the last N failures. If that proves insufficient, **GlitchTip** is the right
self-hosted choice (Sentry-SDK-compatible, far lighter than self-hosted Sentry) — but it is a
Postgres + Redis + web + worker stack, i.e. it would roughly double the footprint of the thing it is
monitoring. Add it only after a real "I wish I had the stack trace" moment.

**No tracing.** A single-user app with three services does not need distributed tracing. Structured
logs with a `request_id` correlation field cover it.

---

## 7. Licensing plan

### 7.1 Our license

- `LICENSE` at repo root: **MIT**, `Copyright (c) 2026 Chris <chris@thebrutus.org>`.
- **SPDX headers** on every source file: `// SPDX-License-Identifier: MIT`. Enforced by a
  `pre-commit` hook (`reuse lint` or a small script). Cheap now, painful to retrofit.
- Consider full **REUSE 3.x** compliance (`LICENSES/MIT.txt`, `REUSE.toml` for assets that cannot
  carry headers). It is ~30 minutes of setup and makes every downstream license question answerable
  by a tool instead of by reading files.
- `package.json` / `pyproject.toml`: `"license": "MIT"`.
- OCI label on every image: `org.opencontainers.image.licenses="MIT"`.

### 7.2 THIRD_PARTY / NOTICE

- `THIRD_PARTY.md` **generated from the syft SBOM** in CI, committed, and CI fails if regenerating it
  produces a diff. This guarantees attribution matches the actual lockfile.
- A `NOTICE` file is only *required* by Apache-2.0 §4(d) if an upstream dependency ships one. Generate
  `NOTICE` by concatenating any upstream `NOTICE` files found in the dependency tree — script it,
  because doing it by hand means it will be wrong.
- Ship both files **inside the image** at `/app/THIRD_PARTY.md` so a distributed container is
  self-documenting.

### 7.3 Vibe-Trading's license — resolved

**HKUDS/Vibe-Trading is MIT licensed** — "MIT License", "Copyright (c) 2026 Vibe-Trading Contributors"
([LICENSE](https://github.com/HKUDS/Vibe-Trading/blob/main/LICENSE), verified 2026-09-10). Latest
release at time of writing is **v0.1.15 (2026-09-09)**; it requires **Python 3.11+**, installs as
`pip install vibe-trading-ai`, exposes a **FastAPI server** (plus CLI / web UI / Electron / MCP
modes), and needs **LLM API credentials** (Anthropic/OpenAI/compatible, or local via Ollama)
([repo](https://github.com/HKUDS/Vibe-Trading)).

**Consequences:**

- There is **no copyleft contamination risk**. MIT-on-MIT is clean. We could legally vendor it.
- **We still isolate it across a network boundary** — for entirely non-legal reasons: it is a
  fast-moving `0.x` research-adjacent project (551 commits, 35 contributors, sub-1.0 versioning) with
  a heavy transitive dependency closure that we do not want in our lockfile, our SBOM, our vuln-scan
  results, or our upgrade cadence. Network isolation converts "their dependency bump breaks our
  build" into "their container fails its healthcheck and the sidecar profile goes dark."
- Its **transitive dependencies still need their own audit** — MIT at the top says nothing about what
  LangChain and the broker SDKs pull in. Because it runs in a separate image, **its dependency tree is
  explicitly out of scope for our license gate**, and `THIRD_PARTY.md` will say so in one sentence:
  *"The optional `vibe-trading` sidecar is a separately-licensed upstream project (MIT) distributed as
  its own container image; its dependencies are not part of PersonalFi's dependency tree."*
- Its **`0.x` version scheme means no SemVer guarantees**. Pin hard (§8).

**Standing policy, independent of Vibe-Trading:** any future sidecar whose license is copyleft ships
as a **separate image, communicating only over the network, never linked or vendored**, and we
document that PersonalFi remains MIT. Under both GPL and AGPL, separate processes communicating over
a network interface are generally understood as independent works — but the conservative posture
(separate image, no vendoring, documented) is what makes that argument easy rather than arguable.

### 7.4 CLA vs DCO

**DCO.** Add `Signed-off-by` enforcement via the DCO GitHub App, a `CONTRIBUTING.md` section, and
`git commit -s`. Rationale: a CLA requires the project to be an entity that can hold assigned rights
and adds friction that will deter the two drive-by PRs this project will ever receive. DCO is a
lightweight attestation that the contributor has the right to submit, which is exactly the assurance
needed for an MIT project with no relicensing ambitions.

`CONTRIBUTING.md` covers: DCO sign-off, the license allowlist (so a PR adding an AGPL dep is rejected
with a pointer rather than an argument), conventional-commit format, `make check` before pushing, and
a note that **no PR may add a dependency that touches credential handling without a security review**.

### 7.5 Trademark note

Add to `README.md` and `NOTICE`:

> PersonalFi is an independent, unaffiliated project. "Plaid" is a trademark of Plaid Inc.;
> "Coinbase" is a trademark of Coinbase, Inc. These names are used solely to identify the third-party
> services with which this software interoperates (nominative fair use). This project is not
> endorsed by, sponsored by, or affiliated with these companies.

Practical rules: **do not** name the project or the repo something like `plaid-sync`; **do not** use
their logos in the README or the UI beyond a plain-text service name (logo files carry separate
trademark *and* copyright restrictions, and Plaid's brand guidelines govern Link's UI); **do** name
integration packages descriptively (`@personalfi/connector-plaid`, not `@plaid/...` — never publish
under an org namespace you do not control).

---

## 8. Sidecar upgrade strategy

The sidecar updates on its own cadence, at `0.x`, with no SemVer promise. Five mechanisms, in order of
importance:

### 8.1 Pin by image digest, not tag

```yaml
image: ghcr.io/hkuds/vibe-trading:0.1.15@sha256:<digest>
```

The tag is documentation for humans; the digest is what Docker resolves. A retagged `0.1.15` cannot
silently change under us. If upstream does not publish images, we build from
`vibe-trading-ai==0.1.15` (a `pip` pin, plus a hash-pinned `requirements.txt` generated by
`uv pip compile --generate-hashes`) and publish to **our** GHCR as
`ghcr.io/chris/personalfi-vibe-trading:0.1.15`.

### 8.2 The adapter image is the contract

`ghcr.io/chris/personalfi-vt-adapter` is **ours**, MIT, Alpine, ~60 MB, and contains a thin shim that:

- translates our stable internal API (`POST /v1/analyze`, `GET /v1/positions`) to whatever upstream
  currently exposes,
- normalizes and **validates** responses through Pydantic models we own, so a shape change upstream
  becomes a clean 502 with a clear error rather than corrupt data in our DB,
- enforces timeouts, retries with jitter, and a circuit breaker,
- **strips anything resembling a credential or instruction from the upstream response before it
  reaches our code** — this is an LLM-driven component, so treat its output as untrusted input,
- exposes `/healthz` that checks upstream liveness **and** version, and reports a version mismatch as
  unhealthy.

The adapter is the only thing our API knows about. Upstream's API can churn freely; the blast radius
is one file.

### 8.3 Contract tests in CI

`tests/contract/test_vibe_trading.py` runs against the **pinned upstream image** (as a GHA service
container or via `docker compose --profile sidecar`), asserting:

- every endpoint the adapter calls exists and returns the expected schema,
- error shapes for the failure paths we handle,
- the version string upstream reports matches `pinned_version`,
- a golden-file check on one representative response payload.

Runs on: PRs touching the adapter, **and nightly against upstream `latest`** — so we learn that
upstream broke the contract *before* Renovate proposes the bump, as an informational failure rather
than a surprise.

### 8.4 Renovate watches the upstream repo

The `customManagers` regex entry in §5.6 makes Renovate track `HKUDS/Vibe-Trading` GitHub releases and
open a PR against `docs/compat/vibe-trading.yaml` when a new tag lands. `automerge: false`, labelled
`needs-contract-test`. The PR triggers the contract-test job against the *new* version, so the PR
itself tells you whether the upgrade is safe.

### 8.5 Compatibility matrix file

`docs/compat/vibe-trading.yaml` — machine-readable (Renovate parses it) and human-readable:

```yaml
# SPDX-License-Identifier: MIT
upstream:
  repo: HKUDS/Vibe-Trading
  license: MIT                      # verified 2026-09-10
  image: ghcr.io/hkuds/vibe-trading
pinned_version: "0.1.15"
pinned_digest: "sha256:REPLACE"
pinned_on: "2026-09-10"
adapter_contract_version: 1
matrix:
  - upstream: "0.1.15"
    adapter: "1.x"
    status: supported
    contract_tests: pass
    notes: "current pin; FastAPI /api/v1 surface"
  - upstream: "0.1.14"
    adapter: "1.x"
    status: supported
    contract_tests: pass
  - upstream: ">=0.2.0"
    adapter: null
    status: untested
    notes: "0.x minor bumps may break the API surface; requires contract-test run before pinning"
rollback: "revert pinned_digest, docker compose --profile sidecar up -d --force-recreate adapter vibe-trading"
```

**Rollback is a one-liner because nothing else depends on it.** The sidecar is profile-gated; if it is
broken, `docker compose --profile sidecar down` and the rest of the app is completely unaffected. That
property is the entire reason for the architecture.

---

## 9. Developer experience

### 9.1 Repo layout

```
personalfi/
├── LICENSE                       # MIT
├── LICENSES/MIT.txt              # REUSE
├── NOTICE                        # generated
├── THIRD_PARTY.md                # generated from syft SBOM, CI-verified
├── README.md
├── CONTRIBUTING.md               # DCO, license allowlist, commit format
├── SECURITY.md
├── licenses.policy.yaml          # single source of truth for the license gate
├── Justfile                      # or Makefile
├── .env.example
├── .editorconfig
├── .gitleaks.toml
├── .pre-commit-config.yaml
├── .trivyignore                  # entries require expiry + justification
├── renovate.json
├── compose.yaml
├── compose.dev.yaml
├── pnpm-workspace.yaml
├── apps/
│   ├── api/                      # TS API + worker + migrator (one image)
│   └── web/                      # SPA, built into apps/api/public
├── packages/
│   ├── core/                     # domain logic, money type, no I/O
│   ├── connector-plaid/
│   └── connector-coinbase/
├── services/
│   ├── vt-adapter/               # Python, uv, our MIT shim
│   └── backup/                   # alpine + pg client + age + rclone
├── infra/
│   ├── caddy/Caddyfile
│   └── tailscale/serve.json
├── scripts/
│   ├── restore-drill.sh
│   ├── gen-third-party.sh
│   └── trust-ca.sh
├── docs/
│   ├── research/
│   ├── runbooks/                 # restore, rotate-credentials, upgrade-postgres
│   └── compat/vibe-trading.yaml
└── .github/workflows/
```

**pnpm workspaces** for the TS side, **uv** for `services/vt-adapter` (its own `pyproject.toml` +
`uv.lock`). Do not try to unify them under one tool — two lockfiles is honest; a Bazel-shaped
abstraction over two ecosystems for one developer is not.

### 9.2 Justfile targets

```
just dev              # compose up with hot reload + seeded demo data
just check            # lint + typecheck + test + license-scan, same as CI
just test             # unit + integration
just up / down / logs
just migrate-new name=add_holdings
just migrate          # run migrator one-shot
just seed / just demo # demo mode: synthetic accounts, no real credentials
just backup           # manual encrypted backup now
just restore-drill    # prove the newest backup restores
just trust-ca         # extract Caddy root CA + install into host trust store
just verify-image V=1.2.3   # cosign verify + docker attestation check
just sbom             # regenerate SBOM + THIRD_PARTY.md
just secrets-init     # generate age keypair, scaffold ./secrets/*.txt
just compat           # print the vibe-trading compatibility matrix
```

Justfile over Makefile: no tab/`.PHONY` archaeology, built-in `--list`, and native parameter passing.
If Make is preferred for ubiquity, the target list is identical.

### 9.3 Pre-commit hooks

```yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks          # THE important one
    hooks: [{ id: gitleaks }]
  - repo: https://github.com/pre-commit/pre-commit-hooks
    hooks:
      - { id: check-added-large-files, args: ["--maxkb=512"] }
      - { id: check-merge-conflict }
      - { id: end-of-file-fixer }
      - { id: trailing-whitespace }
      - { id: detect-private-key }
      - { id: check-yaml }
  - repo: local
    hooks:
      - { id: reuse-lint,   name: SPDX headers,   entry: reuse lint, language: system, pass_filenames: false }
      - { id: biome,        name: biome,          entry: pnpm biome check --write, language: system }
      - { id: ruff,         name: ruff,           entry: uv run ruff check --fix, language: system }
      - { id: hadolint,     name: hadolint,       entry: hadolint, language: system, files: 'Dockerfile' }
      - { id: compose-lint, name: compose config, entry: docker compose config -q, language: system, pass_filenames: false }
```

`gitleaks` runs both pre-commit **and** in CI over full history. A personal finance repo that leaks a
Plaid production secret is the worst realistic outcome of this project, and it is the one failure mode
that a hook can genuinely prevent.

### 9.4 `.env.example` and demo mode

`.env.example` contains **no secrets**, only non-sensitive config and a pointer to
`just secrets-init` for the `./secrets/*.txt` files. It documents the container UIDs (`10001` app,
`70` postgres) and the LAN bind IP, because those are the two things that break on a fresh machine.

**Demo mode** (`DEMO_MODE=true`) uses a synthetic connector generating plausible fake accounts and
transactions, with the real Plaid/Coinbase clients hard-disabled at construction time. This makes the
project cloneable and runnable by a stranger in one command — which is the whole point of publishing
it MIT — without them needing credentials, and gives us a deterministic fixture set for screenshots
and integration tests.

### 9.5 `.editorconfig`

```ini
root = true
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2
[*.py]
indent_size = 4
[Makefile]
indent_style = tab
[*.md]
trim_trailing_whitespace = false
```

---

## 10. Open questions for the panel

1. **TS or Python for the API?** This memo assumes TS (pnpm/pg-boss). If Python wins, the adapter
   merges into the API and the sidecar isolation argument gets *stronger*, not weaker (shared
   ecosystem = more temptation to vendor; resist it).
2. **Postgres or SQLite?** Memo recommends Postgres for `numeric` discipline; §4.3 has the
   Litestream fallback fully specced if simplicity wins.
3. **Webhooks at all?** Memo recommends polling-only. Someone should explicitly own the decision to
   keep the public surface at zero.
4. **Does Ollama actually get used?** If Vibe-Trading will run against a cloud LLM, drop the
   `local-llm` profile and ~12 GB of RAM budget.
5. **Backup destination.** Local-only is one house fire from total loss. B2 with object lock is ~$1/mo
   for this data volume. Recommend enabling it.

## 11. Sources

- [node — Docker Hub](https://hub.docker.com/_/node) · [python — Docker Hub](https://hub.docker.com/_/python) · [postgres — Docker Hub](https://hub.docker.com/_/postgres) · [caddy — Docker Hub](https://hub.docker.com/_/caddy)
- [Alpine 3.24.0 released](https://alpinelinux.org/posts/Alpine-3.24.0-released.html) · [Alpine EOL dates](https://endoflife.date/alpine-linux)
- [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) · [its LICENSE (MIT)](https://github.com/HKUDS/Vibe-Trading/blob/main/LICENSE)
- [better-sqlite3 #1382 (musl prebuilds)](https://github.com/WiseLibs/better-sqlite3/issues/1382) · [#1384](https://github.com/WiseLibs/better-sqlite3/issues/1384)
- [sharp installation docs](https://sharp.pixelplumbing.com/install/) · [@img/sharp-libvips-linuxmusl-x64](https://www.npmjs.com/package/@img/sharp-libvips-linuxmusl-x64)
- [The best Docker base image for your Python application (Feb 2026)](https://pythonspeed.com/articles/base-image-python-docker-images/) · [Alpine/Python antipattern](https://rpep.dev/posts/alpine-python-antipattern/)
- [Chainguard public catalog policy](https://www.chainguard.dev/unchained/important-updates-for-chainguard-images-public-catalog-users)
- [Docker Engine 29 release notes](https://docs.docker.com/engine/release-notes/29/) · [docker buildx build reference](https://docs.docker.com/reference/cli/docker/buildx/build/)
- [Litestream v0.5.0 (Fly blog)](https://fly.io/blog/litestream-v050-is-here/) · [litestream.io](https://litestream.io/)
- [Plaid: transactions webhooks](https://plaid.com/docs/transactions/webhooks/) · [Plaid: webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/)
- [Tailscale + Docker guide](https://tailscale.com/blog/docker-tailscale-guide) · [Tailscale Serve compose sidecar](https://runtimeterror.dev/tailscale-serve-docker-compose-sidecar/) · [ScaleTail: Serve vs Funnel](https://mintlify.wiki/tailscale-dev/ScaleTail/configuration/serve-vs-funnel)
- [Caddy tls directive](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Trivy license scanning](https://oneuptime.com/blog/post/2026-01-30-trivy-license-scanning/view) · [License compliance testing](https://oneuptime.com/blog/post/2026-01-30-license-compliance-testing/view)
- [Sigstore keyless signing with GHA OIDC](https://www.qcecuring.com/blog/sigstore-cosign-keyless-github-actions) · [actions/attest-build-provenance](https://github.com/actions/attest-build-provenance)
- [Renovate configuration options](https://docs.renovatebot.com/configuration-options/)
