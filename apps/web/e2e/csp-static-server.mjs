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
 * gate-remediation-2.md finding 3: this used to hard-code a 4-directive
 * policy (`script-src`/`style-src-elem`/`style-src-attr`/`connect-src`) that
 * had already drifted from the full policy Caddy actually sends (it is
 * missing `default-src`, `img-src`, `font-src`, `worker-src`,
 * `manifest-src`, `object-src`, `frame-ancestors`, `base-uri`,
 * `form-action`) — a passing `csp` Playwright project was proving the app
 * survives a *weaker* policy than production ships, which is not proof of
 * anything. The policy is now read from `docker/Caddyfile` itself at
 * runtime, so the two cannot drift again: change the Caddyfile and this test
 * server picks it up on its next run with no separate edit.
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

// apps/web/e2e -> apps/web -> apps -> repo root -> docker/Caddyfile.
const caddyfilePath = join(here, '..', '..', '..', 'docker', 'Caddyfile');

/**
 * Parses the `Content-Security-Policy "..."` line out of the
 * `(security_headers)` snippet in `docker/Caddyfile` — the exact string
 * Caddy sends on both listeners (`import security_headers` in that file) —
 * rather than keeping a second, hand-maintained copy of it here.
 */
async function readContentSecurityPolicy() {
  const caddyfile = await readFile(caddyfilePath, 'utf8');
  const match = /^\s*Content-Security-Policy\s+"([^"]*)"\s*$/m.exec(caddyfile);
  if (!match) {
    throw new Error(
      `csp-static-server: could not find a Content-Security-Policy directive in ${caddyfilePath} — ` +
        'has the (security_headers) snippet in docker/Caddyfile changed shape?',
    );
  }
  return match[1];
}

const CONTENT_SECURITY_POLICY = await readContentSecurityPolicy();

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

// R-9 (gate-security-review-2.md): mirrors the `docker/Caddyfile` rule this
// server otherwise diverges from. A path with a file extension on its final
// segment (`/assets/nope.js`) is asset-shaped, not a client-side route, so a
// miss there is a real 404 — only extensionless, navigation-shaped requests
// (`/dev/kitchen-sink`, `/login`) fall back to `index.html`. Before this, any
// unresolved path served `index.html` with a 200 unconditionally, which is
// the same over-broad fallback the Caddyfile had.
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${String(port)}`);
    const existing = await resolveExistingFile(url.pathname);
    const isNavigationShaped = !HAS_EXTENSION.test(url.pathname);
    const filePath = existing ?? (isNavigationShaped ? join(distDir, 'index.html') : null);

    if (filePath === null) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

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
