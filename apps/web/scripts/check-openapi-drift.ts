#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * CI-friendly drift check for the generated OpenAPI client.
 *
 * `src/api/generated` is gitignored (it is a pure function of
 * `packages/contracts/openapi/openapi.json` — Appendix A of
 * docs/research/05-frontend-architecture.md). That means nothing stops the
 * committed *source* (feature code that imports from it) from silently
 * drifting out of sync with a contract change that landed without anyone
 * running `pnpm gen`. This script regenerates into a throwaway directory and
 * fails if that differs from what's on disk in `src/api/generated` — the
 * same signal a "did you forget to regenerate" check gives for any other
 * codegen step (migrations, Prisma, protobuf, ...).
 *
 * Run directly (Node 26 strips types, no build step — docs/CONVENTIONS.md):
 *   node scripts/check-openapi-drift.ts
 * or via `pnpm --filter @app/web gen:check`.
 *
 * WP 2.12 fix (docs/plan/02-phase-2-dispatch.md §2, wp1.6-ui.md §2): this used
 * to generate into an OS temp directory (`mkdtemp(tmpdir())`). The
 * `@hey-api/client-fetch` plugin's `runtimeConfigPath` option
 * (`openapi-ts.shared.mjs`) is a path resolved relative to the process's
 * `cwd()` into an absolute path, and hey-api then computes `client.gen.ts`'s
 * import of it as a path *relative to the output directory*. An OS temp
 * directory (`/tmp/personalfi-openapi-XXXXXX`) is nowhere near this repo, so
 * that relative-path computation produced a nonsense import
 * (`'../../home/chris/Projects/PersonalFi/apps/web/src/api/client-runtime-config.ts'`)
 * that differed from the committed file's `'../client-runtime-config.ts'` on
 * every single run, regardless of whether the contract had actually drifted —
 * confirmed by hand: generating into the OS temp dir and into a sibling of
 * `src/api/generated` from the *same* `openapi.json` produced byte-identical
 * output except for that one import line. The fix is to generate into a
 * throwaway directory that sits at the exact same depth in this tree as the
 * real output (a sibling of `src/api/generated`, i.e. also directly under
 * `src/api/`), so the relative path hey-api computes to
 * `client-runtime-config.ts` is identical either way. `.gitignore` already
 * ignores `src/api/generated`; the sibling is prefixed `.` and removed in a
 * `finally` regardless of outcome, same as the old `tmpdir()`-based cleanup.
 */
import { createClient } from '@hey-api/openapi-ts';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiConfig } from '../openapi-ts.shared.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const apiDir = join(webRoot, 'src', 'api');
const committedDir = join(apiDir, 'generated');

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full));
    }
  }
  if (await exists(root)) await walk(root);
  return out.sort();
}

async function main(): Promise<void> {
  // A sibling of `committedDir` (both direct children of `src/api/`), never
  // an OS temp directory — see the header comment for why the depth has to
  // match exactly.
  const tempDir = await mkdtemp(join(apiDir, '.openapi-drift-check-'));
  try {
    await createClient(buildOpenApiConfig(tempDir));

    const [committedFiles, freshFiles] = await Promise.all([
      listFilesRecursive(committedDir),
      listFilesRecursive(tempDir),
    ]);

    const problems: string[] = [];

    if (!(await exists(committedDir))) {
      problems.push(
        `${relative(webRoot, committedDir)} does not exist. Run \`pnpm --filter @app/web gen\`.`,
      );
    }

    const committedSet = new Set(committedFiles);
    const freshSet = new Set(freshFiles);

    for (const file of freshFiles) {
      if (!committedSet.has(file)) problems.push(`missing (would be generated): ${file}`);
    }
    for (const file of committedFiles) {
      if (!freshSet.has(file)) problems.push(`stale (no longer generated): ${file}`);
    }
    for (const file of freshFiles.filter((f) => committedSet.has(f))) {
      const [fresh, committed] = await Promise.all([
        readFile(join(tempDir, file), 'utf8'),
        readFile(join(committedDir, file), 'utf8'),
      ]);
      if (fresh !== committed) problems.push(`out of date: ${file}`);
    }

    if (problems.length > 0) {
      console.error('OpenAPI client is out of sync with packages/contracts/openapi/openapi.json:');
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error('\nRun `pnpm --filter @app/web gen` and commit the result.');
      process.exitCode = 1;
      return;
    }

    console.log(
      `OK — src/api/generated matches the current OpenAPI contract (${committedFiles.length} files).`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
