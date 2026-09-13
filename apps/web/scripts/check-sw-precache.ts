#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * gate-remediation-web.md L-3: `/dev/kitchen-sink` redirects away outside
 * `import.meta.env.DEV` (src/routes/dev.kitchen-sink.tsx), so it is dead
 * code in a production build — but `vite-plugin-pwa`'s `injectManifest`
 * glob would otherwise happily precache that chunk onto every visitor's
 * disk regardless (`vite.config.ts`'s `injectManifest.globIgnores` is the
 * actual fix; this is the check that it stayed effective). Static analysis
 * of `dist/sw.js` rather than `vite.config.ts`'s config object, because the
 * config expressing an intent and the built artifact honouring it are two
 * different claims — this repo's own pattern (`check-csp.ts` checks
 * `dist/*.html`, not `vite.config.ts`, for the same reason).
 *
 * Run directly (Node 26 strips types) after `vite build`: node
 * scripts/check-sw-precache.ts
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');
const swPath = join(distDir, 'sw.js');

async function main(): Promise<void> {
  try {
    await stat(swPath);
  } catch {
    console.error(`${relative(process.cwd(), swPath)} does not exist. Run \`vite build\` first.`);
    process.exitCode = 1;
    return;
  }

  const sw = await readFile(swPath, 'utf8');
  const problems: string[] = [];

  if (sw.includes('dev.kitchen-sink')) {
    problems.push(
      'the precache manifest still references a dev.kitchen-sink chunk — ' +
        "check vite.config.ts's injectManifest.globIgnores.",
    );
  }

  if (problems.length > 0) {
    console.error(`${relative(process.cwd(), swPath)}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK — ${relative(process.cwd(), swPath)}'s precache manifest excludes the dev kitchen-sink chunk.`,
  );
}

await main();
