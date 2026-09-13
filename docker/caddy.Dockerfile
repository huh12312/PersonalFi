# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT
#
# Thin wrapper around the upstream Caddy image, added during WP 0.4 hardening
# to close the one P0-7 gap the original compose.yml left open and documented
# as "revisit once verified": upstream `caddy:2-alpine` runs as root and its
# `caddy` binary carries a `cap_net_bind_service=ep` file capability (verified
# with `getcap` against this exact digest). That capability is what breaks
# `cap_drop: [ALL]` + `security_opt: [no-new-privileges:true]` together —
# `no-new-privileges` refuses to let `execve` apply a file capability to a
# process with an empty permitted set, so the container exits with
# "operation not permitted" the instant both flags are on and the binary
# still carries it (verified empirically while building this WP).
#
# The fix is not "add back NET_BIND_SERVICE": this proxy never binds a
# privileged port in the first place (container ports 8443/8080, both
# unprivileged — see Caddyfile header and compose.yml's port mapping). So the
# capability is dead weight; strip it, then run as a real non-root user.
#
# Named volumes (`caddy_data`, `caddy_config` in compose.yml) are initialized
# from whatever this image has at /data and /config the first time they're
# created, ownership included — chowning here is what makes the *volume*
# writable by 10003:10003 on first boot, not just the image layer.
#
# Also drops `curl` and `c-ares` (WP 0.4 evidence: `trivy image` against the
# unmodified upstream base found 23 HIGH alpine-package CVEs, the majority in
# curl/libcurl and its c-ares resolver — CVE-2026-11352/-11586/-12064/-5773/
# -6276/-8286/-8458/-8925/-8927/-9547/-33630 among them). Neither is linked
# into the `caddy` binary itself (`ldd /usr/bin/caddy` shows no dependency on
# either) and nothing in this stack invokes `curl`: compose.yml's healthcheck
# uses `wget`, which ships in busybox and stays. `apk del` removes the
# packages and their CVEs from the image entirely rather than suppressing
# them; `libssl3`/`libcrypto3` are upgraded in place for the same reason
# (CVE-2026-14456, fixed upstream in 3.5.8-r0, already in Alpine's index for
# this base image's release even though the base layer itself still ships
# 3.5.7-r0).
#
# What this cannot fix: 17 HIGH findings in `usr/bin/caddy` itself (`trivy
# image`'s `gobinary` scanner — stale golang.org/x/net etc. baked into
# upstream's compiled binary at their last build). That requires an upstream
# rebuild, not an Alpine package operation; tracked in .trivyignore with an
# expiry, not silently accepted. Renovate watches this image's digest, so a
# fixed upstream build becomes a routine bump when it exists.

# Build context is the REPO ROOT (compose.yml / ci.yml pass `context: .`), not
# `docker/`, because this image now also serves the SPA: `apps/web` is built in
# the first stage below and its `dist/` is baked in at /srv/web. Before the
# Phase 0 security gate the proxy had nothing to serve and Caddy's catch-all
# reverse-proxied "everything else" to the API, which answered 404 — the app
# had no frontend in front of it at all.

ARG CADDY_IMAGE=caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
ARG NODE_IMAGE=node:26.8.2-alpine3.24@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868

# ---------- web: build apps/web into a static bundle ----------
# Deliberately built here rather than copied from the host: `apps/web/dist` is
# gitignored, so a host-built bundle would make the image depend on whatever
# the last developer happened to have in their working tree. The pinned pnpm
# version matches CI and docker/api.Dockerfile; `--ignore-scripts` is the
# repo-wide default (.npmrc), so no dependency runs a postinstall here either.
FROM ${NODE_IMAGE} AS web-build
RUN npm install --global pnpm@12.4.1
WORKDIR /app
COPY . .
# devDependencies are required (vite, tailwind, the OpenAPI codegen) and never
# reach the runtime stage: only `dist/` is copied out. `--filter @app/web...`
# keeps the API's own dependency closure out of this stage.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter '@app/web...'
# The three steps of `@app/web`'s `build` script that produce the artifact —
# `gen` (the OpenAPI client, gitignored so it must be generated here), `vite
# build`, and `check-csp.ts`, which fails the build on an inline
# `<script>`/`style="..."` in the emitted HTML and is therefore what makes the
# `script-src 'self'` in docker/Caddyfile honest rather than hopeful.
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
    pnpm --filter '@app/web' exec node scripts/check-csp.ts && \
    find apps/web/dist -name '*.map' -delete && \
    find apps/web/dist -type f \( -name '*.js' -o -name '*.css' \) \
      -exec sed -i -E '/[#@][[:space:]]*sourceMappingURL=/d' {} + && \
    test -f apps/web/dist/index.html

# ---------- runtime ----------
FROM ${CADDY_IMAGE} AS runtime

RUN apk add --no-cache libcap && \
    setcap -r /usr/bin/caddy && \
    apk del libcap curl c-ares && \
    apk upgrade --no-cache libssl3 libcrypto3 && \
    addgroup -g 10003 -S caddy_app && \
    adduser -u 10003 -S -G caddy_app -H -D -s /sbin/nologin caddy_app && \
    chown -R 10003:10003 /data /config

# The SPA, read-only to the runtime user: the proxy container has
# `read_only: true` and never writes here. `docker/Caddyfile` serves this with
# `root * /srv/web` + `file_server` + a `try_files ... /index.html` fallback.
COPY --from=web-build --chown=root:root --chmod=755 /app/apps/web/dist /srv/web

# Fails the build rather than shipping an image whose bundle is missing or
# whose source maps leaked back in.
RUN test -f /srv/web/index.html && \
    [ -z "$(find /srv/web -name '*.map' -print -quit)" ]

USER 10003:10003

LABEL org.opencontainers.image.title="personalfi-proxy" \
      org.opencontainers.image.description="Caddy 2 (Alpine) serving apps/web, NET_BIND_SERVICE stripped, non-root (WP 0.4 hardening)" \
      org.opencontainers.image.source="https://github.com/chris/personalfi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/caddy:2-alpine"
