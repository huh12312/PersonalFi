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

/**
 * gate-remediation-2.md finding 4: this suite used to assert the theme
 * toggle flipped `data-theme` on `<html>` at `/`, back when `/` rendered the
 * dashboard directly. Once the `/_app` auth guard started bouncing an
 * unauthenticated visitor to `/login` (see the module doc above), that test
 * silently stopped covering anything a real browser does — `TopBar`, the
 * toggle's usual home, never mounts on `/login`. Restored here against
 * `LoginScreen`'s own minimal toggle (src/features/auth/LoginScreen.tsx's
 * `ThemeToggle`), which this dev server can actually reach without an API.
 *
 * gate-security-review-2.md R-8: the restored version of this test only
 * asserted the post-click attribute matched `/light|dark/`, which is true
 * whether or not the click did anything — a no-op click, a throwing
 * handler, or `ThemeToggle` being deleted entirely (leaving whatever
 * `data-theme` boot sets) would all still pass. Capturing the value before
 * the click and asserting the post-click value *differs* is the only
 * version of this assertion that a broken toggle can fail.
 */
test('the theme toggle on the login screen flips data-theme on <html>', async ({ page }) => {
  await page.goto('/login');
  const html = page.locator('html');
  // The default preference is 'system' (src/lib/theme.ts), which *removes*
  // `data-theme` rather than setting it — so `before` may legitimately be
  // `null`, not `/light|dark/`. The click always resolves to an explicit
  // 'light' or 'dark' (LoginScreen.tsx's `ThemeToggle` flips the *resolved*
  // theme), so the meaningful assertion is "the attribute is now light/dark
  // AND it changed", not "the attribute was already light/dark before".
  const before = await html.getAttribute('data-theme');

  await page.getByRole('button', { name: /theme/i }).click();

  await expect(html).toHaveAttribute('data-theme', /light|dark/);
  const after = await html.getAttribute('data-theme');
  expect(after).not.toBe(before);
});
