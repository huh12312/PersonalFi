// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { scanBothThemes } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installAccountMocks, IRA } from './support/mock-accounts.ts';
import { installPlanMocks } from './support/mock-plan.ts';

/**
 * WP 9.2's e2e exit test (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.2"):
 * `'the holder sets an account's tax treatment by keyboard and the plan says its
 * projection is stale'`, axe-clean in both themes.
 *
 * ## The mocks
 *
 * `support/mock-plan.ts` answers the session and every plan route; `support/mock-accounts.ts` (moved out of
 * this file by WP 9.8 so the sweep can reuse it) layers the handful of account routes the new screens read
 * on top of it (`page.route` handlers registered later win, and `route.fallback()` hands everything else
 * down).
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('account overrides (WP 9.2)', () => {
  test("the holder sets an account's tax treatment by keyboard and the plan says its projection is stale", async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const { puts } = await installAccountMocks(page);
    await login(page);

    // --- the account, as the provider describes it --------------------------------
    await page.goto(`/accounts/${IRA}`);
    await expect(page.getByRole('heading', { name: 'Rollover', level: 2 })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'How your plan treats this account' }),
    ).toBeVisible();
    // The effective value and where it came from: the provider's own subtype.
    await expect(page.getByText(/Now: Tax-deferred .* — from Plaid: ira/u)).toBeVisible();
    await scanBothThemes(page, 'account settings');

    // --- set it by keyboard: focus, arrow, tab, enter ------------------------------
    const tax = page.getByLabel('Tax treatment');
    await tax.focus();
    await expect(tax).toBeFocused();
    // Options: provider default, Taxable, Tax-deferred, Roth, HSA — three steps down is Roth.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowDown');
    await expect(tax).toHaveValue('ROTH');
    // Role, Valued by, then Save.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('Tab');
    const save = page.getByRole('button', { name: 'Save settings' });
    await expect(save).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    expect(puts).toEqual([{ taxTreatment: 'ROTH', role: null, valuation: null }]);
    // Now it says the holder set it.
    await expect(page.getByText(/Now: Roth \(tax-free\) — set by you/u)).toBeVisible();

    // --- the plan says its projection is stale ------------------------------------
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plan' })
      .click();
    await expect(page).toHaveURL(/\/plan/);
    const stale = page.getByTestId('projection-stale-notice');
    await expect(stale).toBeVisible();
    await expect(stale).toContainText('This projection is out of date');
    await expect(stale).toContainText('Rollover: tax treatment was default, now Roth (tax-free)');
    // O-2: the plan also names every account it does not count — never as zero.
    const unvalued = page.getByTestId('unvalued-accounts-notice');
    await expect(unvalued).toContainText('Not counted:');
    await expect(unvalued).toContainText('Typed brokerage (no priced holdings)');
    await expect(unvalued).toContainText('not counted as zero');
    await scanBothThemes(page, 'plan with a stale projection');

    // Nothing recomputed by itself: only the explicit ask clears it.
    await page.getByRole('button', { name: 'Recompute with my current settings' }).click();
    await expect(stale).toBeHidden();
  });
});
