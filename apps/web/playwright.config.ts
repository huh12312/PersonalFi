// SPDX-License-Identifier: MIT
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config, scoped to `e2e/`. Four independent suites, two
 * `webServer`s:
 *
 *   - `smoke.spec.ts` (project `chromium`) boots the Vite dev server and
 *     asserts the app frame renders — no API, no database, no
 *     docker-compose stack (05-frontend-architecture.md §9 reserves the
 *     full demo-seeded-backend E2E suite for a later work package; this is
 *     WP 0.5's proof that the shell itself boots in a real browser).
 *   - `app-walkthrough.spec.ts` (project `chromium`, same dev server, WP 1.6)
 *     walks login → transactions → edit a category → accounts → connections
 *     → add a manual account, with an axe pass per screen. The network is
 *     mocked (`e2e/support/mock-api.ts`) rather than backed by a live
 *     `apps/api` + Postgres — see that file's header for why. Also asserts
 *     (gate-security-review.md F-4/C-1a) that every API call the app makes
 *     goes to `/api/...`.
 *   - `csp.spec.ts` (project `csp`, gate-remediation-web.md H-3/M-1) builds
 *     the app in `e2e-csp` mode and serves the result behind the *exact*
 *     production `Content-Security-Policy` header via
 *     `e2e/csp-static-server.mjs`, then fails on any
 *     `securitypolicyviolation` event. This is the one check in this repo
 *     that can observe a *runtime* CSP violation — `scripts/check-csp.ts`
 *     is a static regex over the built HTML shell and cannot (see that
 *     file's header for the full list of what it can't see).
 *   - `csp-plaid.spec.ts` (project `csp-plaid`, gate-security-review.md
 *     F-3/C-2) runs the real `docker/Caddyfile` through a real `caddy`
 *     container, once with `PLAID_ENABLED` unset and once `true`, and
 *     asserts the emitted CSP/COEP headers against policy strings committed
 *     in the test — not re-derived from the Caddyfile, unlike `csp.spec.ts`
 *     and `csp-static-server.mjs` (deliberately: see that file's own header).
 *     No browser page, no `webServer` of its own — it manages its own Caddy
 *     container per test and talks to it with plain `fetch`.
 *
 * Playwright starts and tears down both `webServer`s regardless of which
 * project's tests are selected; running the full `playwright test` suite is
 * therefore self-contained (no server left running afterward). `csp-plaid`
 * starts and stops its own Caddy container per test, independent of both.
 */
const isCI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /(smoke|app-walkthrough)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5183' },
    },
    {
      name: 'csp',
      testMatch: /csp\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5184' },
    },
    {
      // No browser fixture requested by any test in this file, so no
      // `devices[...]`/`baseURL` is needed — it only calls `docker` and
      // `fetch`. Needs `docker` on PATH and a daemon it can talk to.
      name: 'csp-plaid',
      testMatch: /csp-plaid\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'pnpm exec vite dev --port 5183 --strictPort',
      url: 'http://localhost:5183',
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
    {
      // Rebuilds every run (an `e2e-csp`-mode artifact, never the shipped
      // `dist/`) so the CSP suite always exercises the current source, not a
      // stale local build left over from a previous `pnpm run build:e2e-csp`.
      command: 'pnpm run build:e2e-csp && node e2e/csp-static-server.mjs',
      url: 'http://localhost:5184',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
