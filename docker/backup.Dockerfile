# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT
#
# Backup/restore utility image (D24, 06 §4.1). Tiny and auditable: Alpine plus
# exactly the three tools this needs — postgresql18-client (pg_dump/pg_restore
# matching the server's major version), age (encryption), rclone (optional
# remote push to Backblaze B2 or S3). No Node, no application code.

# Base digest bumped 2026-10-06 to 3.24.2 (F-94-8): the 3.24.1 base's index no
# longer served the pinned openssl build, and 3.5.7-r0 carries CVE-2026-14456
# (HIGH). This base ships libssl3/libcrypto3 3.5.8-r0. The digest is the pin;
# the packages below are deliberately not (WP 9.11's pin policy, below).
ARG ALPINE_IMAGE=alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# The apk layers below are rebuilt whenever Alpine's package index changes:
# BuildKit checksums these two remote files on every build (an `ADD <url>`),
# and each `apk` RUN bind-mounts the stage, so a cached layer can never again
# hide a package Alpine has since fixed — on 2026-11-03 CI's scan read rclone
# 1.74.1-r3 from a cached layer three days after v3.24/community shipped
# 1.75.2-r0 (CVE-2026-116189, CVE-2026-116191). Nothing from this stage
# reaches the image; the mount is the dependency.
FROM ${ALPINE_IMAGE} AS apk-index
ADD https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz /index/main.tar.gz
ADD https://dl-cdn.alpinelinux.org/alpine/v3.24/community/x86_64/APKINDEX.tar.gz /index/community.tar.gz

FROM ${ALPINE_IMAGE} AS runtime

# Pin policy (WP 9.11, G-22 / F-94-8, ruled from WP 9.10 §6): the BASE IMAGE
# is pinned by digest (above), and apk packages are NOT pinned to an exact
# build. Alpine's index serves only the current build of each package, so an
# `apk add pkg=1.2.3-r0` is a build that expires: the first clean-host
# upgrade-test run could not build v0.1 at all, and HEAD's own pins had
# expired too (a cached layer hid it here and in CI). Exactness bought
# nothing: apk verifies every package's signature with the keys shipped in the
# digest-pinned base, so dropping `=version` gives up no authenticity. What
# arrives is controlled instead by `trivy image` — CI's image job on every push
# and `upgrade-test.yml`'s weekly no-cache build of all three images — and the
# postgres client's major version stays in the package NAME. `apk upgrade`
# takes the index's current openssl (CVE-2026-14456 was fixed in an index
# build the base predated). A digest bump (Renovate) refreshes the base.
# `scripts/upgrade-test/dockerfile-pin-policy.test.ts` holds both halves.
RUN --mount=type=bind,from=apk-index,source=/index,target=/apk-index,readonly \
    apk add --no-cache \
      tini \
      postgresql18-client \
      age \
      rclone \
      tzdata && \
    apk upgrade --no-cache libssl3 libcrypto3 && \
    addgroup -g 10002 -S backup && \
    adduser -u 10002 -S -G backup -H -D -s /sbin/nologin backup && \
    mkdir -p /backups && chown 10002:10002 /backups

# pre-migrate.sh (WP 9.4, CF-3) is the `pre-migrate-backup` one-shot's command:
# one backup.sh run before the migrator, only when migrations are pending
# against a non-empty schema. Same image, same tools, same user.
COPY --chmod=755 backup/backup.sh backup/restore.sh backup/backup-loop.sh \
     backup/healthcheck.sh backup/pre-migrate.sh /usr/local/bin/

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
      org.opencontainers.image.description="PersonalFi backup: pg_dump + age encryption + optional rclone push, nightly loop" \
      org.opencontainers.image.source="https://github.com/huh12312/PersonalFi" \
      org.opencontainers.image.url="https://github.com/huh12312/PersonalFi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24"
