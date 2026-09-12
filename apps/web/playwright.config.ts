// SPDX-License-Identifier: MIT
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config, scoped to `e2e/`. The single smoke test here boots the
 * Vite dev server and asserts the app frame renders — no API, no database,
 * no docker-compose stack (05-frontend-architecture.md §9 reserves the full
 * demo-seeded-backend E2E suite, MSW-mocked network, and CDP virtual
 * authenticator passkey flows for a later work package; this is WP 0.5's
 * proof that the shell itself boots in a real browser).
 */
const isCI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5183',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite dev --port 5183 --strictPort',
    url: 'http://localhost:5183',
    reuseExistingServer: !isCI,
    timeout: 30_000,
  },
});
