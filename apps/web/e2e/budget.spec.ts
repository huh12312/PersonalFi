// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installBudgetMocks } from './support/mock-budget.ts';

async function loginAndReachBudget(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Budget' })
    .click();
  await expect(page).toHaveURL(/\/budget$/);
}

/**
 * The visible amount only — `Money.tsx` renders both an `aria-hidden`
 * formatted span *and* a `sr-only` spoken-form span in the same element
 * (05-frontend-architecture.md §2.7's screen-reader-friendly amount), so a
 * plain `.textContent` assertion on the wrapper would see both concatenated.
 */
function visibleAmount(page: Page, testId: string) {
  return page.getByTestId(testId).locator('[aria-hidden="true"]');
}

test.describe('budget screen and reports (WP 2.9)', () => {
  test('assigning money moves Ready-to-Assign by exactly that amount', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installBudgetMocks(page);
    await loginAndReachBudget(page);

    const rta = visibleAmount(page, 'ready-to-assign-amount');
    await expect(rta).toHaveText('+$1,000.00');

    await expectNoAxeViolations(page, 'budget screen (before assign)');

    // Groceries starts at $0 assigned — click it, type $50.00, commit with Enter.
    const groceriesRow = page.locator('li', { hasText: 'Groceries' });
    await groceriesRow.getByRole('button', { name: /Assign amount for Groceries/ }).click();
    const input = groceriesRow.getByRole('textbox', { name: /Assign amount for Groceries/ });
    await input.fill('50.00');
    await input.press('Enter');

    // Assigning $50 moves Ready-to-Assign from $1,000.00 to exactly $950.00.
    await expect(rta).toHaveText('+$950.00');

    await expectNoAxeViolations(page, 'budget screen (after assign)');
  });

  test('a credit overspend renders yellow and a cash overspend red', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installBudgetMocks(page);
    await loginAndReachBudget(page);

    const cashBadge = page.getByText('Cash overspend');
    const creditBadge = page.getByText('Credit overspend');
    await expect(cashBadge).toBeVisible();
    await expect(creditBadge).toBeVisible();

    // The CVD-safe cash-vermilion vs. credit-yellow pair (05 §2.2), not
    // colour alone — each badge also carries its own text label.
    await expect(cashBadge).toHaveClass(/bg-money-neg/);
    await expect(creditBadge).toHaveClass(/bg-status-warning/);
  });

  test('rolling a period opens the next one and closes the current', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installBudgetMocks(page);
    await loginAndReachBudget(page);

    await expect(page.getByTestId('period-range')).toContainText('Sep 1, 2026');

    await page.getByRole('button', { name: 'Roll to next period' }).click();
    await page.getByRole('button', { name: 'Roll forward' }).click();

    await expect(page.getByTestId('period-range')).toContainText('Oct 1, 2026');

    await expectNoAxeViolations(page, 'budget screen (after roll)');
  });

  test('clicking a Sankey band lands on the filtered transactions list, and export downloads a bundle', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBudgetMocks(page);
    await loginAndReachBudget(page);

    await page.getByRole('link', { name: /View reports/ }).click();
    await expect(page).toHaveURL(/\/reports$/);

    await expectNoAxeViolations(page, 'reports screen (spending tab)');

    await page.getByRole('tab', { name: 'Cash flow' }).click();
    const link = page.getByRole('link', { name: /Flow from income to groceries/ });
    await expect(link).toHaveCount(1);
    // `force: true`: with a single income→category link, both ends land at
    // the same y (the only node in each column), so `linkHorizontal`'s
    // geometric path is a perfectly flat line — a real, on-screen, thickly
    // *stroked* ribbon (`stroke-width` carries the value, per
    // `sankey-layout.ts`), but `getBoundingClientRect()` measures the vector
    // path itself, not the stroke's painted extent, so its geometric height
    // is exactly 0 and Playwright's actionability check reports "hidden"
    // even though the ribbon is visibly on screen. `force: true` skips that
    // check and clicks the element directly — the assertion that matters
    // (`toHaveURL`, right below) still proves the click actually did
    // something.
    await link.click({ force: true });

    // Drill-through lands on the filtered `/transactions` list, and the one
    // seeded transaction in that category is actually visible there.
    await expect(page).toHaveURL(/\/transactions/);
    await expect(page.getByText('Farmers Market')).toBeVisible();

    await expectNoAxeViolations(page, 'transactions (drill-through landing)');

    // Back to reports for the export action, behind step-up.
    await page.goBack();
    await expect(page).toHaveURL(/\/reports$/);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export my data/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^personalfi-export-.*\.jsonl$/);

    await expectNoAxeViolations(page, 'reports screen (after export)');
  });
});
