// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

/**
 * Boots the real dev server (no API — see playwright.config.ts) and asserts
 * the app frame renders. Not a feature test — a proof that routing, the
 * shell, Tailwind, and the self-hosted font/icons all come together in an
 * actual browser, which happy-dom's Vitest suite can't prove.
 *
 * This used to assert the dashboard rendered at `/`. Since gate-remediation-
 * web.md M-3/M-8 added `/_app`'s `beforeLoad` auth guard, and this dev
 * server has no API behind it to authenticate against, `/` now — correctly
 * — bounces to `/login` before anything under `/_app` (including the
 * dashboard) ever mounts. That redirect, and the login screen it lands on,
 * is what this suite can actually prove in this environment; the real
 * dashboard render is `src/app/router.test.tsx`'s job (happy-dom, with a
 * mocked authenticated session).
 */
test('an unauthenticated visitor is redirected to /login', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login/);
  await expect(page).toHaveTitle('PersonalFi');
  await expect(page.getByRole('heading', { name: 'Sign in to PersonalFi' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
});

test('the login screen switches to the recovery-code fallback', async ({ page }) => {
  await page.goto('/login');

  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();

  const recoveryInput = page.getByLabel('Recovery code');
  await expect(recoveryInput).toBeVisible();
  // gate-remediation-web.md's recovery-code fix: masked like a password, not
  // plain text, since it's a bearer secret typed into the DOM.
  await expect(recoveryInput).toHaveAttribute('type', 'password');
});
