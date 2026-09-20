// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** WP 2.11 exit test: `e2e/splits.spec.ts` → `'a split that does not sum to the parent cannot be saved'`. */
test('a split that does not sum to the parent cannot be saved', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);
  await login(page);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Transactions' })
    .click();
  await page.getByText('Blue Bottle Coffee').first().click();
  const detailSheet = page.getByRole('dialog', { name: 'Blue Bottle Coffee' });
  await expect(detailSheet).toBeVisible();

  await detailSheet.getByRole('button', { name: /split/i }).click();
  const splitDialog = page.getByRole('dialog', { name: 'Split this transaction' });
  await expect(splitDialog).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'split editor');

  // Two lines are seeded evenly ($6.25 / $6.25 for the $12.50 transaction) —
  // balanced from the start, so Save is enabled.
  await expect(splitDialog.getByText('Balanced')).toBeVisible();
  const saveButton = splitDialog.getByRole('button', { name: /save splits/i });
  await expect(saveButton).toBeEnabled();

  // Change the first line so the two lines no longer sum to the parent.
  const amountInputs = splitDialog.getByLabel(/amount$/i);
  await amountInputs.first().fill('3');

  await expect(splitDialog.getByText(/unallocated/)).toBeVisible();
  await expect(saveButton).toBeDisabled();

  // Restoring balance (via "Split evenly") re-enables Save — the invariant
  // is live, not a one-time validation on submit.
  await splitDialog.getByRole('button', { name: 'Split evenly' }).click();
  await expect(splitDialog.getByText('Balanced')).toBeVisible();
  await expect(saveButton).toBeEnabled();

  await injectAxe(page);
  await expectNoAxeViolations(page, 'split editor (unbalanced then rebalanced)');
});
