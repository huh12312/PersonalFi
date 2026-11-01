# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT
#
# The PersonalFi proxy: Caddy built from source on a patched Go (WP 12.1),
# serving apps/web, non-root, with no file capability.
#
# WHY CADDY IS BUILT HERE AND NOT PULLED. Until WP 12.1 this image was a thin
# wrapper around upstream `caddy:2-alpine` (by digest). The `caddy` binary in
# that image is compiled once per upstream release, so its Go toolchain and Go
# modules are frozen at upstream's build: between 2026-10-10 and 2026-10-28 the
# pinned v2.11.6 gathered six HIGH findings in `usr/bin/caddy` (Go 1.26.8,
# x/net 0.59.0, go-jose/v4 4.1.5 — CVE-2026-78667, -78669, -97031, -111943,
# -56857, -116587), no upstream rebuild cleared them, and .trivyignore snoozed
# them. A published image cannot ship a snooze (docs/research/13 §2.2: Docker
# Hub scans in public), so the `caddy-build` stage below compiles the same
# Caddy release with xcaddy on a Go that carries the fixes, with the vulnerable
# modules raised, and the runtime stage is the alpine base upstream's image is
# built on, plus exactly what upstream adds that this proxy uses.
#
# What a bump looks like (RUNBOOK "The proxy image: Caddy from source"):
# Renovate proposes the golang digest, CADDY_VERSION, XCADDY_VERSION and the
# two module floors from the `# renovate:` comments below; CI's proxy image
# scan (trivy, HIGH/CRITICAL, no snoozes for this image) is the control.
#
# WP 0.4 history, still binding: upstream's binary carried a
# `cap_net_bind_service=ep` file capability, which with compose.yml's
# `cap_drop: [ALL]` + `no-new-privileges:true` makes `execve` fail with
# "operation not permitted". This proxy never binds a privileged port
# (container ports 8443/8080, see docker/Caddyfile), so the capability was
# stripped with `setcap -r`. The binary built below never gets one in the
# first place (xcaddy sets it only under XCADDY_SETCAP=1), so there is nothing
# to strip and libcap never enters the image. The image also never had `curl`
# or `c-ares` (WP 0.4 removed them from upstream's base for 23 HIGH alpine
# findings; nothing here installs them): compose.yml's healthcheck uses
# busybox `wget`.
#
# Named volumes (`caddy_data`, `caddy_config` in compose.yml) are initialized
# from whatever this image has at /data and /config the first time they're
# created, ownership included — chowning here is what makes the *volume*
# writable by 10003:10003 on first boot, not just the image layer.

# Build context is the REPO ROOT (compose.yml / ci.yml pass `context: .`), not
# `docker/`, because this image now also serves the SPA: `apps/web` is built in
# the `web-build` stage below and its `dist/` is baked in at /srv/web. Before the
# Phase 0 security gate the proxy had nothing to serve and Caddy's catch-all
# reverse-proxied "everything else" to the API, which answered 404 — the app
# had no frontend in front of it at all.

# The runtime base: the alpine release upstream caddy:2-alpine v2.11.6 is built
# on (3.23.6), by digest. Renovate proposes the digest/tag bump.
ARG ALPINE_IMAGE=alpine:3.23.6@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
ARG NODE_IMAGE=node:26.8.2-alpine3.24@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868
# The Go toolchain: the newest patch of the line Caddy v2.11.6 is released
# with (go1.26.x). 1.26.10 is the first 1.26 patch that clears all five stdlib
# findings (1.26.9 fixed four; crypto/x509's CVE-2026-111943 needs 1.26.10).
# renovate.json keeps Renovate on the 1.26 line; moving to 1.27 is a decision.
ARG GO_IMAGE=golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308
# Caddy itself: the release the previous upstream pin shipped, so the only
# thing this build changes is the toolchain and two module floors.
# renovate: datasource=go depName=github.com/caddyserver/caddy/v2
ARG CADDY_VERSION=v2.11.6
# xcaddy, by version AND module checksum (the `h1:` sum.golang.org records for
# that version; https://sum.golang.org/lookup/github.com/caddyserver/xcaddy@<v>).
# `go install` already verifies the download against sum.golang.org; pinning
# the sum here as well means a changed GOSUMDB/GOPROXY cannot swap the tool,
# and a version bump without its sum fails the build by name.
# renovate: datasource=go depName=github.com/caddyserver/xcaddy
ARG XCADDY_VERSION=v0.4.7
ARG XCADDY_SUM=h1:WHNm6tqCFXcOxBovXqMzOvNa0W4arbQRxCeNap2S+aU=
# Module floors above what Caddy v2.11.6's go.mod requires (x/net v0.59.0,
# go-jose/v4 v4.1.5). Both are `go get` pins through xcaddy's `--with`, so
# Go's minimum version selection applies: a later Caddy that needs a newer
# version fails the build loudly instead of being silently held back (which a
# go.mod `replace` would do). x/net v0.60.0 fixes CVE-2026-78669 (HTTP/2
# SETTINGS flood); go-jose v4.1.6 fixes CVE-2026-116587 (JWK parsing DoS).
# Both are the minimal fixing releases; drop a floor once CADDY_VERSION's own
# go.mod requires at least it.
# renovate: datasource=go depName=golang.org/x/net
ARG XNET_VERSION=v0.60.0
# renovate: datasource=go depName=github.com/go-jose/go-jose/v4
ARG GOJOSE_VERSION=v4.1.6

# ---------- caddy-build: compile Caddy for the target platform ----------
# Runs on the BUILD platform and cross-compiles (GOOS/GOARCH from buildx's
# TARGETOS/TARGETARCH), so a linux/arm64 image never runs a Go toolchain under
# QEMU. CGO is off, so the binary is static and the cross-compile is exact.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS caddy-build
ARG CADDY_VERSION
ARG XCADDY_VERSION
ARG XCADDY_SUM
ARG XNET_VERSION
ARG GOJOSE_VERSION
ARG TARGETOS
ARG TARGETARCH
# GOTOOLCHAIN=local: never let a go.mod `toolchain` line download a different
# Go than the pinned image's. GOFLAGS=-mod=mod: resolve through go.mod (and
# GOSUMDB) rather than a vendor directory.
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=mod
# xcaddy runs on the build platform, so no GOOS/GOARCH here.
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=go-build,target=/root/.cache/go-build,sharing=locked \
    go install "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" && \
    got="$(go version -m /go/bin/xcaddy | awk '$1 == "mod" { print $3, $4 }')" && \
    if [ "$got" != "${XCADDY_VERSION} ${XCADDY_SUM}" ]; then \
      echo "xcaddy: expected '${XCADDY_VERSION} ${XCADDY_SUM}', got '$got' (update XCADDY_SUM with the version)" >&2; \
      exit 1; \
    fi
# No plugins: the module set is the standard distribution's, pinned in
# docker/caddy-modules.txt and checked against the built binary in the runtime
# stage. The two `--with` lines import packages Caddy already links
# (x/net/http2, go-jose/v4), so they add no Caddy module; they exist only to
# raise the module floors. Flags: upstream's own release flags as read from
# the v2.11.6 binary (`-trimpath`, tags nobadger,nomysql,nopgx, CGO off) plus
# xcaddy's default `-w -s` and an empty build id, so two builds of the same
# inputs are byte-identical (WP 12.1 evidence: an independent build outside
# BuildKit, with empty caches, gave the same sha256).
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,id=go-build,target=/root/.cache/go-build,sharing=locked \
    mkdir -p /out && \
    GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    XCADDY_GO_BUILD_FLAGS="-trimpath -tags=nobadger,nomysql,nopgx -ldflags='-w -s -buildid='" \
    xcaddy build "${CADDY_VERSION}" \
      --output /out/caddy \
      --with "golang.org/x/net/http2@${XNET_VERSION}" \
      --with "github.com/go-jose/go-jose/v4@${GOJOSE_VERSION}"
# What actually got linked, read back from the binary's build info (works on a
# cross-compiled binary; nothing is executed). Fails the build if minimum
# version selection moved any pin, or the target is not what buildx asked for.
RUN go version -m /out/caddy > /out/buildinfo.txt && \
    dep() { awk -v m="$1" '$1 == "dep" && $2 == m { print $3 }' /out/buildinfo.txt; } && \
    setting() { awk -v k="$1" '$1 == "build" && index($2, k "=") == 1 { print substr($2, length(k) + 2) }' /out/buildinfo.txt; } && \
    fail=0 && \
    for pair in \
      "github.com/caddyserver/caddy/v2=${CADDY_VERSION}" \
      "golang.org/x/net=${XNET_VERSION}" \
      "github.com/go-jose/go-jose/v4=${GOJOSE_VERSION}"; do \
      mod="${pair%%=*}"; want="${pair#*=}"; got="$(dep "$mod")"; \
      [ "$got" = "$want" ] || { echo "caddy build: $mod is '$got', expected '$want'" >&2; fail=1; }; \
    done && \
    [ "$(head -n1 /out/buildinfo.txt)" = "/out/caddy: $(go env GOVERSION)" ] || { echo "caddy build: toolchain mismatch" >&2; fail=1; }; \
    [ "$(setting GOOS)" = "${TARGETOS}" ] && [ "$(setting GOARCH)" = "${TARGETARCH}" ] || { echo "caddy build: not ${TARGETOS}/${TARGETARCH}" >&2; fail=1; }; \
    [ "$(setting CGO_ENABLED)" = "0" ] && [ "$(setting -trimpath)" = "true" ] || { echo "caddy build: CGO or trimpath wrong" >&2; fail=1; }; \
    [ "$fail" = 0 ] || { cat /out/buildinfo.txt >&2; exit 1; }

# ---------- web: build apps/web into a static bundle ----------
# On the BUILD platform: the bundle is architecture-independent, so a
# linux/arm64 image reuses the same bytes instead of running pnpm and vite
# under QEMU (WP 12.1).
# Deliberately built here rather than copied from the host: `apps/web/dist` is
# gitignored, so a host-built bundle would make the image depend on whatever
# the last developer happened to have in their working tree. The pinned pnpm
# version matches CI and docker/api.Dockerfile; `--ignore-scripts` is the
# repo-wide default (.npmrc), so no dependency runs a postinstall here either.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web-build
RUN npm install --global pnpm@12.4.1
WORKDIR /app
COPY . .
# devDependencies are required (vite, tailwind, the OpenAPI codegen) and never
# reach the runtime stage: only `dist/` is copied out. `--filter @app/web...`
# keeps the API's own dependency closure out of this stage.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter '@app/web...'
# The steps of `@app/web`'s `build` script that produce the artifact — `gen`
# (the OpenAPI client, gitignored so it must be generated here), `vite build`,
# `check-sw-precache.ts` (gate-remediation-2.md finding 2: asserts the dev
# kitchen-sink route's chunk is excluded from the service worker's precache
# manifest — the exclusion lives in vite.config.ts's injectManifest, this is
# the check that it stayed effective on the artifact actually shipped by this
# image, not just in local `pnpm run build`), and `check-csp.ts`, which fails
# the build on an inline `<script>`/`style="..."` in the emitted HTML and is
# therefore what makes the `script-src 'self'` in docker/Caddyfile honest
# rather than hopeful.
#
# Deliberately NOT the `tsc -b --noEmit` step that `pnpm run build` also runs:
# typechecking is CI's `typecheck` job and `just check`, over the whole
# workspace, once. Repeating it here would make the proxy image fail to build
# for a type error in a test file it does not ship, which is a slow and
# confusing way to learn about a problem `just check` reports in seconds.
#
# Source maps are dropped from the shipped bundle (they de-minify the whole
# app for anyone who reaches the origin) and the now-dangling
# `//# sourceMappingURL=` comments are stripped with them, so the browser does
# not chase a 404 on every file.
RUN pnpm --filter '@app/web' run gen && \
    pnpm --filter '@app/web' exec vite build && \
    pnpm --filter '@app/web' exec node scripts/check-sw-precache.ts && \
    pnpm --filter '@app/web' exec node scripts/check-csp.ts && \
    find apps/web/dist -name '*.map' -delete && \
    find apps/web/dist -type f \( -name '*.js' -o -name '*.css' \) \
      -exec sed -i -E '/[#@][[:space:]]*sourceMappingURL=/d' {} + && \
    test -f apps/web/dist/index.html

# ---------- runtime ----------
# alpine + what upstream caddy:2-alpine adds that this proxy uses:
# ca-certificates (outbound TLS trust) and mailcap (/etc/mime.types, which
# Go's mime package reads for file_server's Content-Type). Not upstream's
# curl or libcap (never needed here, see the header). `apk upgrade` takes the
# current build of every base package (06 §5.5; versions are not pinned, the
# G-22 rule, and trivy is the control on what arrives).
FROM ${ALPINE_IMAGE} AS runtime
ARG CADDY_VERSION

RUN apk upgrade --no-cache && \
    apk add --no-cache ca-certificates mailcap && \
    addgroup -g 10003 -S caddy_app && \
    adduser -u 10003 -S -G caddy_app -H -D -s /sbin/nologin caddy_app && \
    mkdir -p /config/caddy /data/caddy /etc/caddy /srv && \
    chmod 1777 /config/caddy /data/caddy && \
    chown -R 10003:10003 /data /config

# The binary, root-owned and not writable by the runtime user. No file
# capability: built without one (see the header).
COPY --from=caddy-build --chown=root:root --chmod=755 /out/caddy /usr/bin/caddy

# docker/Caddyfile is the configuration compose.yml bind-mounts read-only at
# this path; baked in as well so the image is never without its own config
# (upstream's image carried a welcome-page Caddyfile on :80 that this
# non-root, capability-free proxy could not even bind).
COPY --chown=root:root --chmod=644 docker/Caddyfile /etc/caddy/Caddyfile

# The module-list pin: the binary must report exactly the module set in
# docker/caddy-modules.txt (the standard distribution, no plugins — the set
# upstream's v2.11.6 binary reported). A plugin, or a Caddy bump that adds or
# removes a module, fails the build here with a diff; update the file in the
# same reviewed change. Runs the target binary (under QEMU for a foreign
# platform, which for a Go binary takes a second).
RUN --mount=type=bind,source=docker/caddy-modules.txt,target=/run/caddy-modules.txt \
    set -o pipefail && \
    caddy version | grep "^${CADDY_VERSION} " && \
    caddy list-modules | diff -u /run/caddy-modules.txt -

# The SPA, read-only to the runtime user: the proxy container has
# `read_only: true` and never writes here. `docker/Caddyfile` serves this with
# `root * /srv/web` + `file_server` + a `try_files ... /index.html` fallback.
COPY --from=web-build --chown=root:root --chmod=755 /app/apps/web/dist /srv/web

# Fails the build rather than shipping an image whose bundle is missing or
# whose source maps leaked back in.
RUN test -f /srv/web/index.html && \
    [ -z "$(find /srv/web -name '*.map' -print -quit)" ]

# Upstream caddy:2-alpine's runtime contract, kept so nothing downstream sees a
# difference: XDG dirs (Caddy's data/config locations), /srv as the working
# directory, the same command. EXPOSE names the ports Caddy actually listens
# on here (docker/Caddyfile), not upstream's 80/443/2019.
ENV CADDY_VERSION=${CADDY_VERSION} \
    XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
EXPOSE 8080/tcp 8443/tcp
WORKDIR /srv

USER 10003:10003

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

LABEL org.opencontainers.image.title="personalfi-proxy" \
      org.opencontainers.image.description="Caddy 2 built from source on a patched Go, serving apps/web, non-root, no file capability (WP 0.4, WP 12.1)" \
      org.opencontainers.image.source="https://github.com/chris/personalfi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.23.6"
