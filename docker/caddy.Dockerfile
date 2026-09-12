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

ARG CADDY_IMAGE=caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

FROM ${CADDY_IMAGE} AS runtime

RUN apk add --no-cache libcap && \
    setcap -r /usr/bin/caddy && \
    apk del libcap curl c-ares && \
    apk upgrade --no-cache libssl3 libcrypto3 && \
    addgroup -g 10003 -S caddy_app && \
    adduser -u 10003 -S -G caddy_app -H -D -s /sbin/nologin caddy_app && \
    chown -R 10003:10003 /data /config

USER 10003:10003

LABEL org.opencontainers.image.title="personalfi-proxy" \
      org.opencontainers.image.description="Caddy 2 (Alpine), NET_BIND_SERVICE stripped, non-root (WP 0.4 hardening)" \
      org.opencontainers.image.source="https://github.com/chris/personalfi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/caddy:2-alpine"
