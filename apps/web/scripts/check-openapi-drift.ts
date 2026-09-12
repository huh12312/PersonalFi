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
 */
import { createClient } from '@hey-api/openapi-ts';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenApiConfig } from '../openapi-ts.shared.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const committedDir = join(webRoot, 'src', 'api', 'generated');

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
  const tempDir = await mkdtemp(join(tmpdir(), 'personalfi-openapi-'));
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
      console.error(
        'OpenAPI client is out of sync with packages/contracts/openapi/openapi.json:',
      );
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
