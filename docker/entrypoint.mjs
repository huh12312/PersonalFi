#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Single entrypoint for the api image, dispatching on ROLE so that api, worker,
// and migrator all ship as exactly one image (D13, master plan §3.2). Written as
// a Node script rather than a shell script so the runtime stage never depends on
// /bin/sh being present or correct — see the "no shell in the final stage"
// requirement in WP 0.4. The dispatch itself runs `import()` in-process (not a
// child_process.spawn), so the target module keeps this same PID: tini remains
// PID 1, this script is PID 2, and SIGTERM/SIGINT land on the same handlers
// apps/api/src/main.ts already registers. No new process, no signal relaying to
// get wrong.
//
// Usage (see compose.yml): set ROLE=api|worker|migrator on the container. `api`
// is the default so `docker run <image>` with no ROLE does something sane.

const ROLE = process.env.ROLE ?? 'api';

/** @type {Record<string, string>} */
const ENTRYPOINTS = {
  // Paths are relative to WORKDIR /app, which preserves the monorepo's own
  // relative layout (see api.Dockerfile) rather than flattening it — that is
  // what keeps every `@core/*` workspace symlink resolving to a real,
  // non-node_modules path, which is in turn what lets Node's built-in
  // TypeScript loader run these files at all (ERR_UNSUPPORTED_NODE_MODULES_
  // TYPE_STRIPPING otherwise).
  api: './apps/api/src/main.ts',
  // WP 0.3 adds apps/api/src/worker.ts (ROLE=worker); not present on this
  // branch yet. Deliberately referenced here so the image is ready for it —
  // see the module-not-found message below if it runs before that lands.
  worker: './apps/api/src/worker.ts',
  // @core/db's CLI is not part of its public `exports` map (that only exposes
  // the library surface), but the deploy stage keeps the package's real
  // directory intact, so a plain relative path reaches it regardless.
  migrator: './packages/db/src/cli/migrate.ts',
};

const target = ENTRYPOINTS[ROLE];
if (target === undefined) {
  process.stderr.write(
    `entrypoint: unknown ROLE "${ROLE}" (expected one of: ${Object.keys(ENTRYPOINTS).join(', ')})\n`,
  );
  process.exit(78); // EX_CONFIG
}

try {
  await import(target);
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      `entrypoint: ROLE=${ROLE} target "${target}" does not exist in this image yet.\n`,
    );
    process.exit(78);
  }
  throw error;
}
