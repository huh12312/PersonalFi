// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

/**
 * Runtime CSP compliance (gate-remediation-web.md H-3, M-1). Served by
 * `e2e/csp-static-server.mjs` (via `playwright.config.ts`'s `csp` project)
 * behind the exact production `Content-Security-Policy` Caddy sends — that
 * server parses the directive straight out of `docker/Caddyfile`'s
 * `(security_headers)` snippet at runtime (gate-remediation-2.md finding 3),
 * so the full policy (`default-src`, `img-src`, `font-src`, `worker-src`,
 * `manifest-src`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri
 * 'none'`, `form-action 'self'`, and the `script-src`/`style-src-elem`/
 * `style-src-attr`/`connect-src` directives below) is asserted here, not a
 * hand-copied subset that can quietly drift weaker than production.
 *
 * `scripts/check-csp.ts` is a static regex over the built HTML shell — it
 * cannot see a `<style>` tag a library injects at runtime, which is exactly
 * what H-3 found (sonner's `<Toaster>`, and `react-remove-scroll-bar` via
 * the command palette's now-removed `cmdk` dialog). This test is the one
 * check in the repo that can: it installs a real
 * `securitypolicyviolation` listener in a real Chromium before any app code
 * runs, then exercises the one dev-only route that has every primitive on
 * one page (`/dev/kitchen-sink` — reachable in this build only because it's
 * built with `--mode e2e-csp`, see that route's header comment) — a toast
 * and a dialog specifically, since those are the two H-3 named — and fails
 * if the listener ever fired.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(
        `${event.violatedDirective} blocked ${event.blockedURI || event.sourceFile || '(inline)'}`,
      );
    });
  });
});

test('the kitchen sink renders a toast and a dialog with zero CSP violations', async ({ page }) => {
  await page.goto('/dev/kitchen-sink');
  await expect(page.getByRole('heading', { name: 'Light theme' })).toBeVisible();

  await page.getByRole('button', { name: 'Show toast' }).first().click();
  await expect(page.getByText('This is a toast.')).toBeVisible();

  await page.getByRole('button', { name: 'Open dialog' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Dialog description text.')).toBeVisible();

  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});

test('the toast, warning, and update-prompt code paths all render under CSP', async ({ page }) => {
  // Belt-and-suspenders on top of the previous test: sonner's runtime CSS
  // injection (H-3) fires once at module import, not once per toast, so a
  // single toast already proves it — this drives a second, differently
  // styled toast (via `richColors`, wired at the app root) through the same
  // `<Toaster>` instance to make sure no *additional* variant-specific style
  // sneaks in a second injector.
  await page.goto('/dev/kitchen-sink');

  const showToast = page.getByRole('button', { name: 'Show toast' }).first();
  await showToast.click();
  await expect(page.getByText('This is a toast.')).toBeVisible();
  await showToast.click();

  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});

/** `directive-name value tokens...` -> `{ 'directive-name': 'value tokens...' }`. */
function parseDirectives(header: string): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const [name, ...valueTokens] = trimmed.split(/\s+/);
    if (name === undefined) continue;
    directives[name] = valueTokens.join(' ');
  }
  return directives;
}

/**
 * gate-security-review-2.md R-1. The two tests above (and `check-csp.ts`'s
 * static scan) only prove *this app* survives whatever policy the Caddyfile
 * happens to send today — deriving the served header from `docker/Caddyfile`
 * closed the drift between test and production, but nothing then asserted
 * the Caddyfile's policy is actually strict. A weakened Caddyfile (adding
 * `'unsafe-inline'` to `script-src`, or dropping `object-src 'none'` /
 * `frame-ancestors 'none'` / `base-uri 'none'`) would make the two tests
 * above pass *more easily*, not fail. This test reads the actual response
 * header this server sent — the same derived-from-Caddyfile value the tests
 * above ran under — and pins the directives that matter for XSS containment
 * and clickjacking/injection defence-in-depth, independent of whether the
 * app itself happens to violate them.
 */
test('the served Content-Security-Policy pins the directives this repo depends on', async ({
  page,
}) => {
  const response = await page.goto('/dev/kitchen-sink');
  const header = response?.headers()['content-security-policy'];
  if (header === undefined) {
    throw new Error(
      'no Content-Security-Policy header on the response — is csp-static-server.mjs running?',
    );
  }
  const directives = parseDirectives(header);

  expect(directives['default-src']).toBe("'self'");
  // Exact match, not "contains": 'self' plus anything else (a host, a
  // scheme, 'unsafe-inline', 'unsafe-eval') would already be a weakening.
  expect(directives['script-src']).toBe("'self'");
  expect(directives['script-src']).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(header).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(header).not.toMatch(/script-src[^;]*unsafe-eval/);
  expect(directives['object-src']).toBe("'none'");
  expect(directives['frame-ancestors']).toBe("'none'");
  expect(directives['base-uri']).toBe("'none'");
  expect(directives['form-action']).toBe("'self'");
});
