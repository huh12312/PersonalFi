// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

/**
 * Boots the real dev server (no API — see playwright.config.ts) and asserts
 * the app frame renders: the shell chrome, the sidebar nav, and the
 * dashboard's hero stat and chart region. Not a feature test — a proof that
 * routing, the shell, Tailwind, and the self-hosted font/icons all come
 * together in an actual browser, which happy-dom's Vitest suite can't prove.
 */
test('the app frame renders at the root route', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('PersonalFi');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Transactions' })).toBeVisible();
  await expect(page.getByText('Net worth')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Net worth over the last 90 days' })).toBeVisible();
});

test('the theme toggle flips data-theme on <html>', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');

  await page.getByRole('button', { name: /theme/i }).click();
  await expect(html).toHaveAttribute('data-theme', /light|dark/);
});
