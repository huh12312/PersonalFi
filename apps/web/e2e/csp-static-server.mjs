#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * A tiny `node:http` static file server, built for exactly one job: serve
 * `dist-e2e-csp/` (built by `pnpm run build:e2e-csp`) with the *exact*
 * production `Content-Security-Policy` header Caddy sends
 * (`docker/Caddyfile`), so `csp.spec.ts` can drive a real Chromium against a
 * real production-shaped build under the real policy and fail on any
 * `securitypolicyviolation` event.
 *
 * Not `vite preview`: that server doesn't let us attach an arbitrary
 * response header, and reaching for a full reverse proxy (Caddy itself, or
 * an npm static-server package) to serve a handful of files under a fixed
 * header would be a dependency and a docker dependency this repo doesn't
 * otherwise need for its test suite. `node:http` plus `node:fs` is enough.
 *
 * Launched by Playwright's `webServer` (playwright.config.ts) — Playwright
 * owns the process lifecycle (start before tests, kill after), so nothing
 * here needs to handle its own shutdown beyond what SIGTERM/SIGINT already
 * do by default.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist-e2e-csp');
const port = 5184;

/**
 * The exact policy the security-gate remediation brief specifies and Caddy
 * ships in production: `script-src 'self'` (no inline scripts — verified
 * separately by `scripts/check-csp.ts`), `style-src-elem 'self'` split from
 * `style-src-attr 'unsafe-inline'` (docs/security/csp-nonce-strategy.md —
 * React's `style` prop and visx's inline SVG fills need the attribute
 * carve-out; no library gets to inject a `<style>` *element* at runtime),
 * and `connect-src 'self'` (the generated client and pending-contracts.ts
 * both talk same-origin only — gate-remediation-web.md M-2).
 */
const CONTENT_SECURITY_POLICY =
  "script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'";

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

async function resolveExistingFile(pathname) {
  // `join` collapses `..` segments against `distDir` rather than escaping
  // it, so a request for `/../../etc/passwd` resolves to (and 404s against)
  // a path still rooted under `distDir`.
  const candidate = join(distDir, pathname);
  if (!candidate.startsWith(distDir)) return null;
  try {
    const stats = await stat(candidate);
    return stats.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
    // SPA fallback: any path that isn't a real built file (a client-side
    // route like `/dev/kitchen-sink`, or `/login`) is served `index.html` so
    // the router — not this server — decides what renders.
    const filePath = (await resolveExistingFile(url.pathname)) ?? join(distDir, 'index.html');

    try {
      const body = await readFile(filePath);
      res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
      res.setHeader('Content-Type', CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream');
      res.writeHead(200);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  })();
});

server.listen(port, () => {
  process.stdout.write(
    `csp-static-server: serving ${distDir} on http://localhost:${String(port)}\n`,
  );
});
