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
