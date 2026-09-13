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
 * gate-remediation-web.md M-1 — what this script cannot see, on purpose:
 * it is a static regex over the HTML shell `vite build` writes once, at
 * build time. It cannot and does not:
 *
 *   - execute any JavaScript, so it never observes what the *running* app
 *     does after hydration — a library injecting a `<style>` tag at runtime
 *     (H-3: sonner, `react-remove-scroll-bar`) produces zero bytes in
 *     `dist/*.html` and is invisible here;
 *   - see a real `Content-Security-Policy` header at all — Caddy emits that,
 *     not this build, so a policy drifting out of sync with what the app
 *     actually needs (the inverse of H-3) is also outside this script's
 *     reach;
 *   - catch a `connect-src`, `img-src`, or any other directive violation —
 *     it only ever looked at `script-src`-shaped inline `<script>`s and
 *     `style`-attribute-shaped markup.
 *
 * The only check in this repo that closes that gap is
 * `apps/web/e2e/csp.spec.ts`: a real Chromium instance, served the built
 * `dist/` behind the exact production `Content-Security-Policy` header, that
 * fails on any `securitypolicyviolation` event while exercising a toast and
 * a dialog. Keep both — this one is cheap, fast, and part of every `vite
 * build`; that one is the only one that can actually observe a runtime
 * violation, and needs a browser to do it.
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
// HTML comments — stripped before scanning. `index.html`'s own source
// comments document *why* there's no inline `<script>`, and the prose
// necessarily contains the literal string `<script>` to say so; scanning
// comment text for that pattern is a false positive, not a CSP violation
// (browsers never execute markup inside `<!-- -->`).
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

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
    const rawHtml = await readFile(file, 'utf8');
    const html = rawHtml.replace(HTML_COMMENT_PATTERN, '');
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

  console.log(
    `OK — ${htmlFiles.length} HTML file(s) under dist/ have no inline <script> or style=.`,
  );
}

await main();
