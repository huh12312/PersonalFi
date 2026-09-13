#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * gate-remediation-web.md I-1: source maps must never ship when the SPA is
 * served. `vite.config.ts` sets `build.sourcemap: 'hidden'` deliberately —
 * maps are still emitted (CI/error-triage tooling wants them) but the built
 * JS carries no `//# sourceMappingURL` comment, so a browser never fetches
 * one from a page load alone. That is not the same guarantee as "the file
 * isn't there": `hidden` still writes every `*.map` into `dist/`, and
 * `dist/` is exactly the tree that becomes the served artifact (the Docker
 * image, in production) unless something removes them first. A visitor who
 * guesses or scrapes the URL (`index-<hash>.js.map` is a predictable
 * sibling of `index-<hash>.js`) would otherwise get the deobfuscated source.
 *
 * Run directly (Node 26 strips types) after `vite build`: this is wired into
 * `pnpm run build` between `vite build` and the CSP/precache checks below,
 * so every artifact those checks and `docker build` see is already map-free.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

async function findMapFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.map')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function main(): Promise<void> {
  try {
    await stat(distDir);
  } catch {
    console.error(`${relative(process.cwd(), distDir)} does not exist. Run \`vite build\` first.`);
    process.exitCode = 1;
    return;
  }

  const mapFiles = await findMapFiles(distDir);
  await Promise.all(mapFiles.map((file) => rm(file)));

  console.log(
    mapFiles.length > 0
      ? `Removed ${mapFiles.length} source map(s) from ${relative(process.cwd(), distDir)}.`
      : `OK — no source maps found under ${relative(process.cwd(), distDir)}.`,
  );
}

await main();
