#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Build-time CSP compatibility gate (docs/research/05-frontend-architecture.md
 * §7.3, docs/research/03-security-architecture.md §4.4).
 *
 * The proxy ships a strict, nonce-based `Content-Security-Policy` with no
 * `'unsafe-inline'` on `script-src`. That policy is only honest if the built
 * `dist/` never contains:
 *
 *   1. an inline `<script>` (no `src` attribute) — Vite's module-preload
 *      polyfill is the classic culprit; `build.modulePreload.polyfill =
 *      false` in `vite.config.ts` is what actually prevents it, this script
 *      is the check that it stayed prevented;
 *   2. a `style="..."` attribute baked into the static HTML shell.
 *
 * This does *not* check runtime-injected styles (React's `style` prop,
 * visx's inline SVG fills) — those are a JS-runtime concern covered by the
 * documented `style-src-attr 'unsafe-inline'` carve-out in
 * `docs/security/csp-nonce-strategy.md`, not a static-file concern. Grepping
 * `dist/*.html` is exactly the check the deliverable asks for: the *shell*
 * Vite emits must be clean.
 *
 * Run directly (Node 26 strips types): node scripts/check-csp.ts
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

// A <script> tag (opening tag only) that has no `src="..."` / `src='...'` attribute.
const INLINE_SCRIPT_PATTERN = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi;
// A bare `style="..."` / `style='...'` attribute anywhere in the markup.
const STYLE_ATTRIBUTE_PATTERN = /\sstyle\s*=\s*["'][^"']*["']/gi;

async function findHtmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.html')) out.push(full);
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

  const htmlFiles = await findHtmlFiles(distDir);
  if (htmlFiles.length === 0) {
    console.error(`No .html files found under ${relative(process.cwd(), distDir)}.`);
    process.exitCode = 1;
    return;
  }

  let violations = 0;

  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    const rel = relative(process.cwd(), file);

    for (const match of html.matchAll(INLINE_SCRIPT_PATTERN)) {
      violations += 1;
      console.error(`${rel}: inline <script> without src — ${match[0].slice(0, 120)}`);
    }
    for (const match of html.matchAll(STYLE_ATTRIBUTE_PATTERN)) {
      violations += 1;
      console.error(`${rel}: inline style attribute — ${match[0].trim().slice(0, 120)}`);
    }
  }

  if (violations > 0) {
    console.error(
      `\nCSP check failed: ${violations} violation(s) in ${htmlFiles.length} file(s). ` +
        'See docs/security/csp-nonce-strategy.md.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`OK — ${htmlFiles.length} HTML file(s) under dist/ have no inline <script> or style=.`);
}

await main();
