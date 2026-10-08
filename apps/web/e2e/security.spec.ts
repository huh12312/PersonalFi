// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { scanBothThemes, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';
import { SESSION_PHONE, installSecurityMocks } from './support/mock-security.ts';

/**
 * WP 9.14: the sessions / sign-in-methods screen for WP 9.11's `GET/DELETE /auth/sessions` and
 * `DELETE /auth/totp`, with its step-up journey, axe-clean in both themes.
 *
 * The mock refuses every gated call with `403 step_up_required` until the passkey ceremony has run, so the
 * assertions on `calls` prove the order the screen actually used: refused, ceremony, retried.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('Settings › Security (WP 9.14)', () => {
  test('the holder lists sessions and signs one out, steps up once, and every state is axe-clean in both themes', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const security = await installSecurityMocks(page);
    await login(page);

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Signed-in sessions' })).toBeVisible();
    // Opening the tab asks the server for nothing that needs a passkey.
    expect(security.calls).toEqual([]);
    await scanBothThemes(page, 'settings › security (before the passkey check)');

    // --- list: refused, passkey ceremony, retried ----------------------------------------------
    await page.getByRole('button', { name: 'Show my sessions' }).click();
    const list = page.getByRole('list', { name: 'Signed-in sessions' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByText('This session', { exact: true })).toBeVisible();
    expect(security.calls).toEqual([
      'GET /api/auth/sessions',
      'POST /api/auth/step-up/verify',
      'GET /api/auth/sessions',
    ]);
    await scanBothThemes(page, 'settings › security (sessions listed)');

    // --- sign one out, by keyboard -------------------------------------------------------------
    const phone = list.getByRole('button', { name: /Sign out the passkey session/ });
    await phone.focus();
    await expect(phone).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('That session was signed out.')).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(2);
    expect(security.sessions.map((entry) => entry.familyId)).not.toContain(SESSION_PHONE);
    // The assertion is still fresh, so no second ceremony.
    expect(security.calls.filter((call) => call.includes('step-up'))).toHaveLength(1);

    // --- sign every other one out --------------------------------------------------------------
    await page.getByRole('button', { name: 'Sign out every other session' }).click();
    await expect(page.getByText('1 other session was signed out.')).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Sign out every other session' })).toBeDisabled();
    await scanBothThemes(page, 'settings › security (after signing the others out)');
  });

  test('the holder removes the authenticator code through a confirmation, by keyboard, dark theme included', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const security = await installSecurityMocks(page);
    await login(page);

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(page.getByText('Set up')).toBeVisible();

    const remove = page.getByRole('button', { name: 'Remove authenticator code' });
    await expect(remove).toBeEnabled();
    await remove.focus();
    await page.keyboard.press('Enter');

    // The destructive confirmation, scanned in both themes (CF-9 was this surface in dark).
    const dialog = page.getByRole('dialog', { name: 'Remove the authenticator code?' });
    await expect(dialog).toBeVisible();
    await scanBothThemes(page, 'settings › security › remove authenticator code (dialog)');

    // Escape cancels and puts focus back where it was.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    expect(security.calls).toEqual([]);

    await page.keyboard.press('Enter');
    await setTheme(page, 'dark');
    await dialog.getByRole('button', { name: 'Remove it' }).click();

    await expect(
      page.getByText('The authenticator code was removed. It can no longer sign in.'),
    ).toBeVisible();
    expect(security.calls).toEqual([
      'DELETE /api/auth/totp',
      'POST /api/auth/step-up/verify',
      'DELETE /api/auth/totp',
    ]);
    await expect(page.getByText('Not set up')).toBeVisible();
    await expect(remove).toBeDisabled();
    await scanBothThemes(page, 'settings › security (authenticator code removed)');
  });

  test('the holder creates recovery codes by keyboard: shown once, saved, gone, in both themes', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installApiMocks(page);
    const security = await installSecurityMocks(page);
    await login(page);

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(page.getByText(/You have 10 unused\./)).toBeVisible();

    const open = page.getByRole('button', { name: 'Replace my recovery codes' });
    await open.focus();
    await page.keyboard.press('Enter');
    // Opening asks for nothing; the explicit button does, behind the passkey check.
    expect(security.calls).toEqual([]);
    const create = page.getByRole('button', { name: 'Create new recovery codes' });
    await create.focus();
    await page.keyboard.press('Enter');

    const list = page.getByRole('list', { name: 'Your recovery codes' });
    await expect(list.getByRole('listitem')).toHaveCount(10);
    await expect(list.getByText('PFI-1000-K7Q2-X9WD')).toBeVisible();
    expect(security.calls).toEqual([
      'POST /api/auth/recovery-codes',
      'POST /api/auth/step-up/verify',
      'POST /api/auth/recovery-codes',
    ]);
    await scanBothThemes(page, 'settings › security › recovery codes shown');

    const done = page.getByRole('button', { name: 'Done' });
    await expect(done).toBeDisabled();
    await page.getByRole('checkbox', { name: 'I have saved these codes somewhere safe' }).check();
    await expect(done).toBeEnabled();
    await done.focus();
    await page.keyboard.press('Enter');

    await expect(list).toBeHidden();
    await expect(page.getByText('PFI-1000-K7Q2-X9WD')).toHaveCount(0);
    await expect(
      page.getByText('Your new recovery codes are active. The old ones no longer work.'),
    ).toBeVisible();
    await scanBothThemes(page, 'settings › security (after saving the codes)');
  });
});
