// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

/**
 * WP 1.6 deliverable 5: login → transactions → edit a category → accounts →
 * connections → add manual account, with an axe pass on every screen. The
 * network is mocked (`support/mock-api.ts`) rather than backed by a live
 * `apps/api` + Postgres — see that file's header for why, and
 * docs/evidence/phase-1/wp1.6-ui.md for what a live-backend version of this
 * suite would still need. `support/fake-webauthn.ts` drives the one real
 * WebAuthn ceremony this walkthrough exercises (the step-up assertion before
 * adding a connection) through the real `@simplewebauthn/browser` call path
 * in a real browser.
 */
test('login, edit a transaction category, and add a manual account', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const api = await installApiMocks(page);

  // gate-security-review.md F-4/C-1a: every API call the generated client
  // (and the hand-written `pending-contracts.ts` auth client) makes now goes
  // to `/api/...` — `docker/Caddyfile`'s `handle_path /api/*` strips the
  // prefix before it reaches `apps/api`, so a request that *doesn't* carry it
  // would 404 or worse, fall through to a same-origin path the SPA itself
  // handles. `mock-api.ts`'s route matchers already require the `/api` prefix
  // to fire at all (this walkthrough would fail well before the assertion
  // below if the app called bare `/auth/session`), but this makes the
  // regression this whole condition exists for an explicit assertion rather
  // than an implicit side effect of the mocks matching.
  const apiRequestPaths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) apiRequestPaths.push(path);
  });

  // --- Login -------------------------------------------------------------
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to PersonalFi' })).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'login');

  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();

  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // --- Transactions: open a row and change its category -------------------
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Transactions' })
    .click();
  await expect(page).toHaveURL(/\/transactions$/);
  await expect(page.getByText('Blue Bottle Coffee').first()).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'transactions');

  await page.getByText('Blue Bottle Coffee').first().click();
  await expect(page.getByRole('heading', { name: 'Blue Bottle Coffee' })).toBeVisible();
  await page.getByLabel('Category').selectOption('');
  await expect
    .poll(() => api.lastPatchBody, { message: 'PATCH /transactions/txn_1 was never sent' })
    .toEqual({ categoryId: null });
  await page.keyboard.press('Escape');

  // --- Accounts ------------------------------------------------------------
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Accounts' })
    .click();
  await expect(page).toHaveURL(/\/accounts$/);
  // Unique to the loaded AccountsScreen (not the transactions filter bar's
  // own "Accounts"-labelled `<select>`, nor the account name text, which the
  // outgoing route's own transactions grid can also contain mid-transition).
  const manageConnections = page.getByRole('button', { name: 'Manage connections' });
  await expect(manageConnections).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'accounts');

  // --- Connections: add a manual account, step-up gated --------------------
  await manageConnections.click();
  await expect(page).toHaveURL(/\/accounts\/connections$/);
  await expect(page.getByText('No connections yet')).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'connections (empty)');

  await page.getByRole('button', { name: 'Add connection' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add a connection' })).toBeVisible();
  await page.getByLabel('Account name').fill('Rental property');
  await page.getByRole('button', { name: 'Add account' }).click();

  // First attempt 403s (step_up_required); the app runs the step-up
  // ceremony (mocked options/verify + the faked WebAuthn assertion above)
  // and retries automatically — this assertion is what proves that
  // happened rather than the click silently no-op'ing.
  await expect
    .poll(() => api.lastCreateConnectionBody, { message: 'POST /connections was never sent' })
    .toMatchObject({ provider: 'manual', input: { displayName: 'Rental property' } });
  await expect(page.getByRole('heading', { name: 'Add a connection' })).toBeHidden();
  await expect(page.getByText('Rental property')).toBeVisible();

  await injectAxe(page);
  await expectNoAxeViolations(page, 'connections (with a connection)');

  // gate-security-review.md F-4/C-1a: the whole walkthrough above only ever
  // succeeded because every API call landed under `/api/...` — assert that
  // directly, and that it covers more than just the one auth call every
  // screen makes on load.
  expect(apiRequestPaths.length).toBeGreaterThan(0);
  expect(apiRequestPaths.every((p) => p.startsWith('/api/'))).toBe(true);
  expect(apiRequestPaths.some((p) => p.startsWith('/api/auth/'))).toBe(true);
  expect(apiRequestPaths.some((p) => p === '/api/transactions')).toBe(true);
  expect(apiRequestPaths.some((p) => p === '/api/connections')).toBe(true);
});
