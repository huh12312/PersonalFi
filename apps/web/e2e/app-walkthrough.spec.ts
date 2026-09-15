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
});
