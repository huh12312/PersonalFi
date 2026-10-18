// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

/** WP 2.11 exit test: `e2e/category-filter.spec.ts` → `'the category filter survives a reload via the URL'`. */
test('the category filter survives a reload via the URL', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Transactions' })
    .click();
  await expect(page).toHaveURL(/\/transactions$/);
  await expectNoAxeViolations(page, 'transactions (before filtering)');

  // `exact`: the dev-only router devtools list a route button, "Open match details for /_app/categories/$categoryId"
  // (WP 10.14), whose name contains "category" too.
  await page.getByRole('button', { name: 'Category', exact: true }).click();
  // WP 10.14: the option carries its (aria-hidden) category icon; the checkbox's accessible name is the name alone.
  await page.getByRole('checkbox', { name: 'Coffee Shops' }).check();
  // Base UI's popover closes on outside click; press Escape instead so the
  // assertion below is about the URL, not popover dismissal mechanics.
  await page.keyboard.press('Escape');

  await expect(page).toHaveURL(/categoryIds.*cat_dining_coffee/);
  await expect(page.getByRole('button', { name: 'Coffee Shops' })).toBeVisible();

  await page.reload();

  // The filter round-tripped through the URL (`validateSearch`) — no reset
  // to "no filter" on reload, and no separate persistence layer needed.
  await expect(page.getByRole('button', { name: 'Coffee Shops' })).toBeVisible();
  await expect(page).toHaveURL(/categoryIds.*cat_dining_coffee/);

  await expectNoAxeViolations(page, 'transactions (category filter applied, after reload)');
});
