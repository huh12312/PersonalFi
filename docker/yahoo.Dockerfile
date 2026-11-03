# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT
#
# The yahoo sidecar (WP 12.6, D33; docs/research/14 §3): Yahoo Finance through
# yfinance, as an OPT-IN component. Never started by a plain `docker compose
# up`: it runs only under `--profile yahoo`, and the worker speaks to it only
# when the operator set YAHOO_FINANCE_ENABLED=true AND the holder ticked the
# consent in Settings -> Market data (RUNBOOK "Yahoo Finance").
#
# Build context is `docker/` (as for the backup image): this image needs
# docker/yahoo/ and nothing else from the repository.
#
# What is in it, and why nothing else:
#   * the Python base by digest (the index, so both architectures are pinned);
#   * yfinance and its whole transitive closure from docker/yahoo/requirements.txt,
#     every package pinned by version AND by the sha256 of every wheel it may
#     install (`--require-hashes --no-deps --only-binary=:all:`: an unlisted
#     package, version or file, or anything that would need a compiler, fails
#     the build), with the yfinance version checked again after install;
#   * docker/yahoo/server.py (standard library + yfinance) and its healthcheck;
#   * pip itself is removed once the install is done: nothing installs at
#     runtime, and the scanner has one fewer package to report.
# Non-root (uid 10004), read-only root filesystem in compose (yfinance's
# caches go to /tmp, a tmpfs there), no shell needed at runtime: the
# entrypoint and the healthcheck are exec-form Python.

# The newest stable CPython (3.15.2, 2026-10-26) on alpine 3.24, by the
# multi-arch index digest. Renovate proposes the bump; a bump re-runs the
# requirements procedure in docker/yahoo/requirements.txt's header, because
# compiled wheels are per CPython minor.
ARG PYTHON_IMAGE=python:3.15.2-alpine3.24@sha256:20a82dbc2783112ddb91d1534603f802d222a3e63e593cd002eb2ac534e70211

FROM ${PYTHON_IMAGE} AS runtime

# Must equal the yfinance line in docker/yahoo/requirements.txt; both are
# checked below, so a bump that changes one and not the other fails the build.
ARG YFINANCE_VERSION=1.7.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore

# `apk upgrade` takes the current build of every base package (06 §5.5; apk
# versions are not pinned — the G-22 rule — and trivy is the control on what
# arrives). The user is the fourth of the stack's fixed uids: api/worker
# 10001, backup 10002, proxy 10003, yahoo 10004.
RUN apk upgrade --no-cache && \
    addgroup -g 10004 -S yahoo && \
    adduser -u 10004 -S -G yahoo -H -D -s /sbin/nologin yahoo

# The hashed install, then the pin check, then pip goes. Bytecode is compiled
# here (pip's default) so the read-only runtime never tries to write it.
RUN --mount=type=bind,source=yahoo/requirements.txt,target=/run/requirements.txt \
    set -eu && \
    grep -qx "yfinance==${YFINANCE_VERSION} \\\\" /run/requirements.txt || \
      { echo "yahoo: requirements.txt does not pin yfinance==${YFINANCE_VERSION}" >&2; exit 1; } && \
    python -m pip install --require-hashes --no-deps --only-binary=:all: -r /run/requirements.txt && \
    python -m pip check && \
    got="$(python -c 'import yfinance; print(yfinance.__version__)')" && \
    [ "$got" = "${YFINANCE_VERSION}" ] || \
      { echo "yahoo: yfinance imports as '$got', expected '${YFINANCE_VERSION}'" >&2; exit 1; } && \
    python -m pip uninstall --yes pip && \
    rm -rf /root/.cache

# The directory first, 0755: a COPY --chmod into a directory it creates gives
# the directory the files' mode too, and a 0644 /app is one the runtime user
# cannot enter (found by the first run of the built image, WP 12.6 §3).
RUN install -d -o root -g root -m 0755 /app
COPY --chown=root:root --chmod=644 yahoo/server.py yahoo/healthcheck.py /app/
RUN python -m compileall -q /app && \
    su -s /bin/sh nobody -c 'test -x /app && test -r /app/server.py && test -r /app/healthcheck.py'

USER 10004:10004
WORKDIR /tmp
EXPOSE 8000/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-I", "/app/healthcheck.py"]

ENTRYPOINT ["python", "-I", "/app/server.py"]

LABEL org.opencontainers.image.title="personalfi-yahoo" \
      org.opencontainers.image.description="PersonalFi yahoo sidecar: Yahoo Finance through yfinance, opt-in, unofficial, best effort; speaks only to query1/query2.finance.yahoo.com (WP 12.6)" \
      org.opencontainers.image.source="https://github.com/huh12312/PersonalFi" \
      org.opencontainers.image.url="https://github.com/huh12312/PersonalFi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/python:3.15.2-alpine3.24"
