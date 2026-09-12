# syntax=docker/dockerfile:1.19
# SPDX-License-Identifier: MIT
#
# One image for api, worker, and migrator (D13/D14, 06 §1.5). Node 26 strips
# types and runs TypeScript directly (docs/CONVENTIONS.md: "There is no build
# step"), so unlike the memo's sketch there is no `pnpm --filter build` stage.
#
# Why this isn't a `pnpm deploy --prod` image, despite the memo sketch saying so:
# `pnpm deploy` physically copies workspace packages (@core/kernel, @core/config,
# @core/db, @core/contracts) into node_modules/, and Node 26 *refuses* to
# type-strip any .ts file whose resolved path is under a node_modules directory
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — a deliberate guard against
# executing transformed third-party code, verified empirically against this
# exact image during WP 0.4). A normal `pnpm install --filter-prod=@app/api...`
# instead symlinks workspace packages straight to their source directories
# (`apps/api/node_modules/@core/config -> ../../../../packages/config`), whose
# resolved path has no node_modules segment at all — identical to how
# `node apps/api/src/main.ts` already runs in development. So the image
# preserves the monorepo's relative directory layout instead of flattening it:
# that layout is exactly what makes the symlinks (and therefore type-stripping)
# work unmodified.
#
# `--filter-prod=@app/api...` + `--prod` together are what keep the monorepo
# root's devDependencies — Vite, and therefore Vite's MPL-2.0 `lightningcss` —
# and the ten unrelated workspace packages (apps/web, the eleven bounded
# contexts) out of this image entirely. Verified: `pnpm licenses list --prod`
# against the resulting tree contains no MPL/LGPL/GPL entries (docs/evidence).

ARG NODE_IMAGE=node:26.8.2-alpine3.24@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868

# ---------- deploy: install only @app/api's production dependency closure ----------
FROM ${NODE_IMAGE} AS deploy
# build-base/python3/libc-dev exist so a native dep with no musl prebuild can
# compile in this stage (06 §1.2); none of this toolchain reaches runtime.
RUN apk add --no-cache build-base python3 libc-dev
ENV npm_config_target_libc=musl
# corepack ships unbundled as of Node 26; install pnpm the same pinned way CI
# does, rather than lean on corepack or a third-party action.
RUN npm install --global pnpm@12.4.1

WORKDIR /app
# The lockfile spans all 18 workspace projects, so pnpm needs every
# package.json present to resolve it — hence the full-repo COPY — but
# `--filter-prod=@app/api...` (select @app/api and only the workspace projects
# its *production* dependency graph touches) plus `--prod` (skip
# devDependencies everywhere) together materialize node_modules for exactly
# five projects: @app/api, @core/kernel, @core/config, @core/db,
# @core/contracts. Nothing else in the workspace is installed.
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --filter-prod=@app/api...

# Strip everything not needed to run: other workspace packages entirely (their
# source was only needed so pnpm could resolve the lockfile above), tests,
# dev-only config files inside the packages we keep. What remains is exactly
# apps/api + the four @core/* packages + their resolved node_modules.
RUN rm -rf apps/web packages/contexts scripts docs .github \
           compose.dev.yml eslint.config.js vitest.config.ts \
           tsconfig.json tsconfig.base.json .editorconfig \
           .prettierrc.json .prettierignore .npmrc && \
    find apps/api packages/kernel packages/config packages/db packages/contracts \
      -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + && \
    find apps/api packages/kernel packages/config packages/db packages/contracts \
      -name '*.test.ts' -delete && \
    find packages/kernel packages/config packages/db packages/contracts \
      -name 'OWNERSHIP.md' -delete && \
    rm -f packages/db/drizzle.config.ts

COPY docker/entrypoint.mjs ./entrypoint.mjs

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
# `apk upgrade` (not a version pin): CVE-2026-14456 (OpenSSL DoS, fixed
# upstream in 3.5.8-r0) postdates this base image's last build but is already
# in Alpine 3.24's index — verified with `trivy image` during WP 0.4. Revisit
# once a Renovate-proposed base-image digest bump makes this redundant.
RUN apk add --no-cache tini && \
    apk upgrade --no-cache libssl3 libcrypto3 && \
    addgroup -g 10001 -S app && \
    adduser -u 10001 -S -G app -H -D -s /sbin/nologin app

WORKDIR /app
ENV NODE_ENV=production \
    TZ=UTC \
    ROLE=api \
    NODE_OPTIONS="--enable-source-maps"

# The pruned deploy tree keeps the monorepo's relative layout (apps/api,
# packages/kernel, packages/config, packages/db, packages/contracts,
# node_modules) so every workspace symlink baked in by `pnpm install` above
# still resolves correctly at this identical depth.
COPY --from=deploy --chown=root:root /app ./

# Ships THIRD_PARTY.md so a distributed container is self-documenting (06
# §7.2), regenerated by `just licenses` and expected to exist before building.
COPY THIRD_PARTY.md LICENSE ./

USER 10001:10001
EXPOSE 8080

# Compose's `healthcheck:` wins in production; this one is for anyone running
# `docker run` by hand (06 §1.4). Node has global fetch; no curl/wget needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# rootfs is read-only at runtime (compose `read_only: true`); everything
# writable is a tmpfs or a named volume. tini is PID 1 so SIGTERM is handled
# and adopted zombies are reaped; entrypoint.mjs runs in-process (no shell,
# no child_process.spawn) and dispatches on ROLE — see that file for why.
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/entrypoint.mjs"]
# Role is chosen entirely by the ROLE env var (see entrypoint.mjs), not by
# overriding CMD, so an explicit empty CMD replaces the base image's own
# default (`["node"]`) rather than have it appended as a stray argument.
CMD []

LABEL org.opencontainers.image.title="personalfi-api" \
      org.opencontainers.image.description="PersonalFi API / worker / migrator (Node 26, TypeScript run directly, ROLE-selected at runtime)" \
      org.opencontainers.image.source="https://github.com/chris/personalfi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="PersonalFi" \
      org.opencontainers.image.base.name="docker.io/library/node:26.8.2-alpine3.24"
