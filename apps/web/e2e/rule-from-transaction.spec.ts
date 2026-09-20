// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

/** WP 2.11 exit test: `e2e/rule-from-transaction.spec.ts` → `'the preview count matches the count after apply'`. */
test('the preview count matches the count after apply', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const api = await installApiMocks(page);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Transactions' })
    .click();
  await page.getByText('Blue Bottle Coffee').first().click();
  const detailSheet = page.getByRole('dialog', { name: 'Blue Bottle Coffee' });
  await expect(detailSheet).toBeVisible();

  await detailSheet.getByRole('button', { name: /always categorize like this/i }).click();
  const ruleDialog = page.getByRole('dialog', { name: 'Always categorize like this' });
  await expect(ruleDialog).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'rule from transaction (before preview)');

  await ruleDialog.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('listbox').getByRole('option', { name: 'Coffee Shops' }).click();

  // The preview is non-negotiable before anything retroactive happens (05
  // §5.4): no apply button exists until a preview has run.
  await expect(ruleDialog.getByRole('button', { name: /apply to/i })).toHaveCount(0);
  await ruleDialog.getByRole('button', { name: 'Preview' }).click();

  const applyButton = ruleDialog.getByRole('button', { name: /apply to \d+ transactions?/i });
  await expect(applyButton).toBeVisible();
  const previewLabel = await applyButton.textContent();
  const previewCount = /apply to (\d+)/i.exec(previewLabel ?? '')?.[1];
  expect(previewCount).not.toBeUndefined();

  await injectAxe(page);
  await expectNoAxeViolations(page, 'rule from transaction (after preview)');

  const [applyResponse] = await Promise.all([
    page.waitForResponse((response) =>
      /\/api\/rules\/.+\/apply$/.test(new URL(response.url()).pathname),
    ),
    applyButton.click(),
  ]);
  await expect(ruleDialog).toBeHidden();

  await expect
    .poll(() => api.lastRuleApplyBody, { message: 'POST /rules/{id}/apply was never sent' })
    .toEqual({ retroactive: true });

  // The exit test's own assertion: the count shown in the UI *before* the
  // click (built from the preview response) is the same number the apply
  // endpoint actually reports afterward.
  const applyBody = (await applyResponse.json()) as { changedCount: number };
  expect(String(applyBody.changedCount)).toBe(previewCount);
});
