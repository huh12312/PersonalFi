// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * gate-security-review.md F-3/C-2, §6 condition C-2's last bullet: "make sure
 * [the CSP e2e] now asserts the Plaid-enabled and Plaid-disabled variants
 * independently of the Caddyfile text, i.e. against an expected policy string
 * committed in the test."
 *
 * `csp.spec.ts` (and, before it, `e2e/csp-static-server.mjs`) deliberately
 * *derives* the policy it tests under from `docker/Caddyfile` — that was the
 * Phase 0 R-1 fix, closing a gap where the test asserted nothing about
 * whether the Caddyfile's policy was any good. But a control that only ever
 * compares an artifact to itself cannot catch a bug *in that artifact* — the
 * exact shape gate-security-review.md's own §0/§6 names as the recurring
 * failure mode in this repo. The Plaid toggle (the `map {$PLAID_ENABLED...}`
 * blocks in `docker/Caddyfile`'s `(security_headers)` snippet) is new
 * surface where that would bite immediately: a broken `map`, a typo'd env var
 * name, or a dropped `frame-src` would still "derive cleanly" from whatever
 * the file happens to say.
 *
 * So this file does the opposite of `csp-static-server.mjs`: it runs the
 * *real* `docker/Caddyfile` through the *real* `caddy` binary (the same
 * pinned image `docker/caddy.Dockerfile` ships,
 * `caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648`),
 * once with `PLAID_ENABLED` unset and once with it `true`, and asserts the
 * emitted `Content-Security-Policy`/`Cross-Origin-Embedder-Policy` headers
 * against the two policy strings committed below — not against anything
 * re-read from the Caddyfile at test time. If a future edit breaks the
 * Plaid-enabled branch (or accidentally widens the Plaid-disabled one), the
 * emitted header no longer matches the committed string and this fails,
 * independent of what the Caddyfile's own text says about itself.
 *
 * Not part of the `csp` Playwright project (`csp.spec.ts` /
 * `csp-static-server.mjs`, port 5184): this needs `docker`, not a Vite build,
 * and asserts on raw HTTP headers rather than in-browser CSP violation
 * events, so it gets its own project (`csp-plaid`, see `playwright.config.ts`)
 * with no `webServer` — it manages its own Caddy container per test.
 */

const CADDY_IMAGE =
  'caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CADDYFILE_PATH = join(REPO_ROOT, 'docker', 'Caddyfile');

const EXPECTED_CSP_PLAID_DISABLED =
  "default-src 'self'; script-src 'self'; script-src-elem 'self'; frame-src 'self'; " +
  "style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; " +
  "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// gate-security-review.md §8.4 (F-5). Two directives changed after the re-gate
// drove the REAL `openPlaidLink()` in a real browser against this policy:
//
//   * `style-src-elem` carries `'unsafe-inline' https://cdn.plaid.com` — Link
//     injects an inline `<style>`, and under `style-src-elem 'self'` the frame
//     loaded with an empty body. This is the one CSP violation that did fire.
//   * COEP is `unsafe-none`, not `credentialless`. `credentialless` relaxes
//     COEP for no-cors *subresources* (which is why the CDN script loaded) and
//     NOT for nested *documents*: a cross-origin iframe must itself send COEP,
//     and `cdn.plaid.com` sends none, so `link.html` was
//     `net::ERR_BLOCKED_BY_RESPONSE` — silently, because a COEP block emits no
//     `securitypolicyviolation` event. The previous remediation's probe read
//     "no violation + onload fired" as success; it was the signature of a
//     silent block.
//
// Both are Plaid-enabled only; the disabled policy above is unchanged.
const EXPECTED_CSP_PLAID_ENABLED =
  "default-src 'self'; script-src 'self'; script-src-elem 'self' https://cdn.plaid.com; " +
  "frame-src 'self' https://cdn.plaid.com; " +
  "style-src-elem 'self' 'unsafe-inline' https://cdn.plaid.com; style-src-attr 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://cdn.plaid.com " +
  "https://sandbox.plaid.com https://production.plaid.com; worker-src 'self' blob:; " +
  "manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const EXPECTED_COEP_PLAID_DISABLED = 'require-corp';
const EXPECTED_COEP_PLAID_ENABLED = 'unsafe-none';

/** A minimal static root so Caddy's `app_routes` catch-all has something to serve at `/`. */
function writeStaticFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'csp-plaid-fixture-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>fixture</body></html>');
  return dir;
}

interface RunningCaddy {
  readonly name: string;
  readonly port: number;
}

/** Starts a real Caddy container against the real `docker/Caddyfile`, plain-HTTP listener only. */
function startCaddy(plaidEnabled: boolean, staticRoot: string): RunningCaddy {
  // Not cryptographic — this only needs to avoid a same-run `docker run
  // --name` collision between the two test cases below, not resist guessing.
  // Reuses `writeStaticFixture`'s own `mkdtempSync` randomness (its basename)
  // rather than a second random source.
  const name = `csp-plaid-probe-${staticRoot.split('/').pop() ?? Date.now()}`;
  // Port 0 lets the OS pick a free ephemeral port; `docker port` reads back
  // whatever it chose, avoiding a fixed-port collision between the two tests
  // below if they ever ran concurrently.
  execFileSync('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    ...(plaidEnabled ? ['-e', 'PLAID_ENABLED=true'] : []),
    '-v',
    `${CADDYFILE_PATH}:/etc/caddy/Caddyfile:ro`,
    '-v',
    `${staticRoot}:/srv/web:ro`,
    '-p',
    '127.0.0.1::8080',
    CADDY_IMAGE,
    'caddy',
    'run',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ]);
  const portMapping = execFileSync('docker', ['port', name, '8080/tcp']).toString().trim();
  const port = Number(portMapping.split(':').pop());
  if (!Number.isFinite(port)) {
    throw new Error(
      `csp-plaid.spec.ts: could not parse a port from 'docker port' output: ${portMapping}`,
    );
  }
  return { name, port };
}

function stopCaddy(caddy: RunningCaddy): void {
  execFileSync('docker', ['stop', caddy.name]);
}

/** Caddy needs a moment after `docker run -d` before it's actually accepting connections. */
async function waitForCaddy(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`);
      await response.text();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `csp-plaid.spec.ts: Caddy never became reachable on port ${String(port)}: ${String(lastError)}`,
  );
}

for (const [label, plaidEnabled, expectedCsp, expectedCoep] of [
  [
    'Plaid disabled (PLAID_ENABLED unset)',
    false,
    EXPECTED_CSP_PLAID_DISABLED,
    EXPECTED_COEP_PLAID_DISABLED,
  ],
  [
    'Plaid enabled (PLAID_ENABLED=true)',
    true,
    EXPECTED_CSP_PLAID_ENABLED,
    EXPECTED_COEP_PLAID_ENABLED,
  ],
] as const) {
  test(`docker/Caddyfile emits the committed CSP/COEP policy: ${label}`, async () => {
    const staticRoot = writeStaticFixture();
    const caddy = startCaddy(plaidEnabled, staticRoot);
    try {
      await waitForCaddy(caddy.port);
      const response = await fetch(`http://127.0.0.1:${String(caddy.port)}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBe(expectedCsp);
      expect(response.headers.get('cross-origin-embedder-policy')).toBe(expectedCoep);
    } finally {
      stopCaddy(caddy);
    }
  });
}
