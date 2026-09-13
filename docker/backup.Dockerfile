# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT
#
# Backup/restore utility image (D24, 06 §4.1). Tiny and auditable: Alpine plus
# exactly the three tools this needs — postgresql18-client (pg_dump/pg_restore
# matching the server's major version), age (encryption), rclone (optional
# remote push to Backblaze B2 or S3). No Node, no application code.

ARG ALPINE_IMAGE=alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

FROM ${ALPINE_IMAGE} AS runtime

# Versions pinned to the exact apk build (not just the Alpine release) so a
# `just scan` / SBOM diff shows precisely what changed on a bump. Renovate does
# not track apk packages today (06 §5.6 covers npm + Docker + GitHub Actions
# only) — see RUNBOOK.md for the manual bump procedure until that gap is
# closed. Versions verified against Alpine 3.24's main/community index at
# implementation time (2026-09-11); `apk add <pkg>` with no pin will show the
# current version if a rebuild fails here after an index update.
RUN apk add --no-cache \
      tini=0.19.0-r3 \
      postgresql18-client=18.6-r0 \
      age=1.3.1-r6 \
      rclone=1.74.1-r2 \
      tzdata=2026c-r0 \
      libssl3=3.5.8-r0 \
      libcrypto3=3.5.8-r0 && \
    addgroup -g 10002 -S backup && \
    adduser -u 10002 -S -G backup -H -D -s /sbin/nologin backup && \
    mkdir -p /backups && chown 10002:10002 /backups

COPY --chmod=755 backup/backup.sh backup/restore.sh backup/backup-loop.sh \
     backup/healthcheck.sh /usr/local/bin/

USER 10002:10002
WORKDIR /backups
VOLUME ["/backups"]

# Not liveness only. "The loop process is still running" was the whole check
# until the Phase 0 gate (H-2) pointed out that it stays true through thirty
# consecutive failed backups. healthcheck.sh additionally reads the status file
# backup.sh writes on every attempt and fails on a failed or stale one.
# Compose's healthcheck for this service runs the same script; see compose.yml.
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --retries=1 \
  CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/backup-loop.sh"]

LABEL org.opencontainers.image.title="personalfi-backup" \
      org.opencontainers.image.description="pg_dump + age encryption + optional rclone push, nightly loop" \
      org.opencontainers.image.source="https://github.com/chris/personalfi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24"
