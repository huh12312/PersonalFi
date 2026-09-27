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
# The lockfile spans every workspace project, so pnpm needs every package.json
# present to resolve it — hence the full-repo COPY — but
# `--filter-prod=@app/api...` (select @app/api and only the workspace projects
# its *production* dependency graph touches) plus `--prod` (skip
# devDependencies everywhere) together materialize node_modules for only the
# projects @app/api actually needs at runtime. Nothing else is installed.
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --filter-prod=@app/api...

# Strip everything not needed to run: workspace projects outside @app/api's
# production closure (their source was only needed so pnpm could resolve the
# lockfile above), tests, and dev-only config files inside the projects we keep.
#
# The keep-set is **asked of pnpm, not hardcoded**, and that is the whole point
# of this stage. It used to be a literal `rm -rf apps/web packages/contexts ...`
# with a sibling comment naming "exactly five projects". Then `apps/api` grew a
# dependency on `@ctx/identity` (the auth surface) and nobody updated the list,
# so the image shipped an `apps/api` whose very first import — `@ctx/identity`
# from `auth/runtime.ts` — resolved to a symlink into a directory this line had
# just deleted. `docker compose up` produced an api container that exited 78 in
# a restart loop, and because the entrypoint reports any ERR_MODULE_NOT_FOUND in
# the whole import graph as "target does not exist in this image yet", the
# message named `main.ts` rather than the package actually missing. Found by the
# Phase 0 security gate; a hand-maintained list of a computed set will rot again,
# so it is computed.
#
# The DELETE set is computed too, and that is the Phase 1 security gate's fix.
# The loop used to glob `apps/* packages/* packages/contexts/*`, i.e. it knew
# the workspace was exactly two levels deep everywhere except one hardcoded
# nested directory. WP 1.2 then added `packages/connectors/{port,manual,csv,
# plaid}`. `packages/connectors` matched `packages/*`, was not itself a project
# and so never appeared in KEEP, and was deleted whole — taking all four
# connectors with it. The api image had not booted since (`Cannot find package
# '@connector/csv' imported from /app/apps/api/src/domain.ts`, exit 78, restart
# loop) and nothing in CI or `just verify` ever starts the image, so nothing
# said so. Asking pnpm for every workspace project removes the depth assumption
# entirely: a grouping directory is never a project, so it is never a candidate
# for deletion, at any nesting.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    projects() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s)){const r=require("node:path").relative("/app",p.path);if(r)console.log(r)}})'; } && \
    KEEP="$(pnpm list --filter '@app/api...' --depth -1 --prod --json | projects)" && \
    ALL="$(pnpm list -r --depth -1 --json | projects)" && \
    test -n "$KEEP" && test -n "$ALL" && \
    echo "$KEEP" | grep -qx 'apps/api' && \
    printf 'keeping workspace projects:\n%s\n' "$KEEP" && \
    for dir in $ALL; do \
      case "$dir" in /*|*..*) echo "refusing to prune $dir" >&2; exit 1;; esac; \
      [ -d "$dir" ] || continue; \
      echo "$KEEP" | grep -qx "$dir" || rm -rf "$dir"; \
    done && \
    find apps packages -depth -type d -empty -delete 2>/dev/null || true

RUN rm -rf scripts docs .github \
           compose.dev.yml eslint.config.js vitest.config.ts \
           tsconfig.json tsconfig.base.json .editorconfig \
           .prettierrc.json .prettierignore .npmrc && \
    find apps packages \
      -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} + && \
    find apps packages -name '*.test.ts' -delete && \
    find packages -name 'OWNERSHIP.md' -delete && \
    rm -f packages/db/drizzle.config.ts

COPY docker/entrypoint.mjs ./entrypoint.mjs

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
# `apk upgrade` (not a version pin): CVE-2026-14456 (OpenSSL DoS, fixed
# upstream in 3.5.8-r0) postdates this base image's last build but is already
# in Alpine 3.24's index — verified with `trivy image` during WP 0.4. Revisit
# once a Renovate-proposed base-image digest bump makes this redundant.
#
# `age` (WP 4.12b, C-5; G3-4): `GET /export?encrypt=true` shells out to it
# (`apps/api/src/reports/export/bundle.ts`'s `encryptWithAge`) and this image
# never carried it — the route's own `AgeUnavailableError` refusal was honest
# (503, no plaintext downgrade) but the branch was permanent. Pinned to the
# exact apk build, not just the Alpine release, the same way
# `docker/backup.Dockerfile` already pins it — same base image
# (`alpine:3.24`), so the same version is available in this index; verified
# against Alpine 3.24's main index at implementation time (2026-09-27). No
# Renovate coverage for apk packages (06 §5.6); see RUNBOOK.md for the manual
# bump procedure.
RUN apk add --no-cache tini age=1.3.1-r6 && \
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
