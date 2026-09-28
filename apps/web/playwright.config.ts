// SPDX-License-Identifier: MIT
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config, scoped to `e2e/`. Ten independent suites, two
 * `webServer`s:
 *
 *   - `smoke.spec.ts` (project `chromium`) boots the Vite dev server and
 *     asserts the app frame renders — no API, no database, no
 *     docker-compose stack (05-frontend-architecture.md §9 reserves the
 *     full demo-seeded-backend E2E suite for a later work package; this is
 *     WP 0.5's proof that the shell itself boots in a real browser).
 *   - `app-walkthrough.spec.ts` (project `chromium`, same dev server, WP 1.6,
 *     extended by WP 2.11) walks login → transactions → pick a category via
 *     the combobox → split a transaction → create a rule from a transaction
 *     with a preview → accounts → connections → add a manual account →
 *     resolve an inbox item → pair a transfer, with an axe pass per screen.
 *     The network is mocked (`e2e/support/mock-api.ts`) rather than backed by
 *     a live `apps/api` + Postgres — see that file's header for why. Also
 *     asserts (gate-security-review.md F-4/C-1a) that every API call the app
 *     makes goes to `/api/...`.
 *   - `inbox.spec.ts`, `splits.spec.ts`, `rule-from-transaction.spec.ts`,
 *     `category-filter.spec.ts`, `notification-settings.spec.ts` (project
 *     `chromium`, WP 2.11) each pin one exit test verbatim from
 *     docs/plan/02-phase-2-dispatch.md §3, against the same mocked network.
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
 * *   - `cold-start.spec.ts` (project `cold-start`, WP 3.13, C-6) reproduces
 *     the Phase 2 gate's cold-start CSRF finding (G2-4) against a real
 *     `docker compose down -v` stack with a real CDP virtual authenticator —
 *     no mocks, no dev server. Self-skips unless `COLD_START_BASE_URL`/
 *     `COLD_START_REGISTER_URL` name a live stack; see that file's header for
 *     the exact sequence and the reproduction result.
 *
 * Playwright starts and tears down both `webServer`s regardless of which
 * project's tests are selected; running the full `playwright test` suite is
 * therefore self-contained (no server left running afterward). `csp-plaid`
 * starts and stops its own Caddy container per test, independent of both.
 */
const isCI = process.env['CI'] !== undefined;

/**
 * Test options this config sets and `e2e/cold-start.spec.ts` declares with
 * `test.extend`. Typing `defineConfig` with them is what lets the `cold-start`
 * project's `use` block carry a key Playwright does not know about.
 */
interface ColdStartOptions {
  readonly coldStart: { readonly baseURL?: string; readonly registerURL?: string };
}

/**
 * C-16, O-3 (`gate-security-review.md`: "running `just verify`/Playwright
 * rewrites committed evidence screenshots"). `undefined` (the default) means
 * every evidence-screenshot spec writes to a gitignored output directory
 * instead of the committed one — `e2e/support/screenshot-dir.ts`'s own
 * header explains why the value is read here and handed down as an option
 * rather than read from `e2e/` directly. Set `PLAYWRIGHT_EVIDENCE_DIR` to
 * the real evidence directory to deliberately regenerate the committed set.
 */
interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

export default defineConfig<ColdStartOptions & EvidenceDirOptions>({
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
      testMatch:
        /(smoke|app-walkthrough|inbox|splits|rule-from-transaction|category-filter|notification-settings|recurring-insights|budget|investments|networth|market-data|plan|plan-sliders)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5183',
        // Spread rather than assigned: under `exactOptionalPropertyTypes`
        // an explicit `undefined` is not an absent optional (the same
        // reason `coldStart`'s own `use` block below does this).
        ...(process.env['PLAYWRIGHT_EVIDENCE_DIR'] === undefined
          ? {}
          : { evidenceDir: process.env['PLAYWRIGHT_EVIDENCE_DIR'] }),
      },
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
    {
      // C-6 (docs/evidence/phase-2/gate-security-review.md §5). No
      // `webServer`, same reason as `csp-plaid` above: this project talks to
      // a real `docker compose` stack that `cold-start.spec.ts`'s own header
      // explains how to stand up, not anything Playwright starts.
      // `COLD_START_BASE_URL` (falls back to the compose default,
      // `https://personalfi.lan`) is resolved with `--host-resolver-rules` so
      // the suite needs no `/etc/hosts` entry, and `ignoreHTTPSErrors` stands
      // in for `just trust-ca` so it needs no CA import either. Every test in
      // `cold-start.spec.ts` self-skips when the stack env vars are absent,
      // so this project is a no-op in `just check`/CI.
      name: 'cold-start',
      testMatch: /cold-start\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ignoreHTTPSErrors: true,
        // The spec may not read `process.env` (the repo-wide ban exempts
        // `test/` and this config, not `e2e/`), so the two live-stack URLs are
        // read here and handed to it as test options.
        // Spread rather than assigned: under `exactOptionalPropertyTypes` an
        // explicit `undefined` is not an absent optional.
        coldStart: {
          ...(process.env['COLD_START_BASE_URL'] === undefined
            ? {}
            : { baseURL: process.env['COLD_START_BASE_URL'] }),
          ...(process.env['COLD_START_REGISTER_URL'] === undefined
            ? {}
            : { registerURL: process.env['COLD_START_REGISTER_URL'] }),
        },
        launchOptions: {
          args: [
            `--host-resolver-rules=MAP ${new URL(process.env['COLD_START_BASE_URL'] ?? 'https://personalfi.lan').hostname} 127.0.0.1`,
          ],
        },
      },
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
