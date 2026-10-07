// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

/** WP 2.11 exit test: `e2e/notification-settings.spec.ts` → `'a test send reports a real delivery result'`. */
test('a test send reports a real delivery result', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('tab', { name: 'Notifications' }).click();
  await expectNoAxeViolations(page, 'settings (notifications tab, no channels)');

  await page.getByLabel('Name').fill('My phone');
  await page.getByLabel('Topic').fill('personalfi-alerts');
  await page.getByRole('button', { name: 'Add channel' }).click();

  await expect(page.getByText('My phone')).toBeVisible();
  await expectNoAxeViolations(page, 'settings (notifications tab, one channel)');

  const [testResponse] = await Promise.all([
    page.waitForResponse((response) =>
      // `/verify` is the real route (operationId `verifyNotificationChannel`);
      // `/test` was the WP 2.11 stub's guessed path and never existed on the
      // wire, so this predicate matched nothing and timed out on every runner.
      /\/api\/notifications\/channels\/.+\/verify$/.test(new URL(response.url()).pathname),
    ),
    page.getByRole('button', { name: 'Send test' }).click(),
  ]);

  // "A real delivery result" (the exit test's own wording): the button click
  // triggered a real request/response cycle against the mocked route, and
  // the UI renders exactly what that response said, not a canned "sent!"
  // toast the network round trip never touched.
  const body = (await testResponse.json()) as { result: { ok: boolean; message: string } };
  expect(body.result.ok).toBe(true);
  await expect(page.getByText(body.result.message)).toBeVisible();

  await expectNoAxeViolations(page, 'settings (notifications tab, after test send)');
});
