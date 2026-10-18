// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installBudgetMocks } from './support/mock-budget.ts';
import { setTheme } from './support/axe.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools } from './support/sweep.ts';

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
    // WP 10.11: both on the V1 status quartets (danger / warning wash, border and text).
    await expect(cashBadge).toHaveClass(/bg-status-danger-bg/);
    await expect(creditBadge).toHaveClass(/bg-status-warning-bg/);
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
    // WP 10.10: a band is a filled ribbon (its box is the band, so no `force: true` is needed any more) and a
    // pointer target; the keyboard reaches the same drill-through through the chart's table, one link per flow.
    await page.getByRole('button', { name: /View as table.*Cash flow/ }).click();
    await expect(page.getByRole('link', { name: /groceries.*, view transactions/i })).toHaveCount(
      1,
    );
    const band = page.locator('[data-flow="income->groceries"]');
    await expect(band).toHaveCount(1);
    await band.click();

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

test.describe('budget meters, Left to budget and variability (WP 10.11)', () => {
  test('Left to budget is the server’s; group and row meters carry the pace tick and their state in words', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBudgetMocks(page);
    await loginAndReachBudget(page);

    const card = page.getByRole('region', { name: 'Left to budget' });
    await expect(visibleAmount(page, 'ready-to-assign-amount')).toHaveText('+$1,000.00');
    await expect(card.getByText('Income not yet given to a category')).toBeVisible();
    await expect(visibleAmount(page, 'ltb-budgeted-expenses')).toHaveText('$1,750.00');
    await expect(page.getByTestId('ltb-rollover')).toContainText('rolled over from last period');

    // Spending: budgeted 1,775.00 (25.00 rolled over), spent 1,665.00 at day 15 of 30 — ahead of pace.
    const spending = page.getByRole('region', { name: 'Spending' });
    const header = spending.locator('[role="meter"][data-meter-size="md"]');
    await expect(header).toHaveAttribute('data-meter-state', 'ahead');
    await expect(header.locator('[data-meter-tick]')).toHaveAttribute('data-meter-tick', '0.5000');
    await expect(spending.getByText('Ahead of pace').first()).toBeVisible();
    // Rows: Dining over, Groceries withheld ("no amount set", no bar).
    await expect(page.getByRole('meter', { name: 'Dining: spent of budget' })).toHaveAttribute(
      'data-meter-state',
      'over',
    );
    const groceries = page.locator('li', { hasText: 'Groceries' });
    await expect(groceries.getByText('no amount set')).toBeVisible();
    await expect(groceries.getByRole('meter')).toHaveCount(0);
    await expect(page.getByTestId('budget-pace')).toContainText('day 15 of 30');

    await expectNoAxeViolations(page, 'budget screen (meters)');
  });

  test('By variability: sections with totals; classifying the suggested category moves it and updates Fixed', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const state = await installBudgetMocks(page);
    await loginAndReachBudget(page);

    await page.getByRole('button', { name: 'By variability' }).click();
    await expect(page).toHaveURL(/\/budget\?view=variability$/);
    await expect(page.getByRole('button', { name: 'By variability' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(visibleAmount(page, 'variability-total-fixed')).toHaveText('$1,500.00');
    await expect(page.getByTestId('variability-total-fixed')).toContainText(
      'Budgeted fixed expenses',
    );

    const unclassified = page.getByRole('region', { name: 'Unclassified' });
    const utilities = unclassified.getByRole('group', { name: 'Classify Utilities' });
    await expect(unclassified.getByTestId('variability-suggested')).toHaveCount(1);
    await expect(
      unclassified.locator('li', { hasText: 'Utilities' }).getByTestId('variability-suggested'),
    ).toBeVisible();
    // Suggested, not applied: nothing pressed, nothing written.
    await expect(utilities.getByRole('button', { name: 'Fixed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(state.lastCategoryPatchBody).toBeNull();

    await expectNoAxeViolations(page, 'budget screen (by variability)');

    await utilities.getByRole('button', { name: 'Fixed' }).click();
    await expect(visibleAmount(page, 'variability-total-fixed')).toHaveText('$1,725.00');
    expect(state.lastCategoryPatchBody).toEqual({ variability: 'fixed' });
    await expect(page.getByTestId('variability-suggested')).toHaveCount(0);
    const fixed = page.getByRole('region', { name: 'Fixed' });
    await expect(
      fixed
        .getByRole('group', { name: 'Classify Utilities' })
        .getByRole('button', { name: 'Fixed' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      fixed.locator('[role="meter"][data-meter-size="md"] [data-meter-tick]'),
    ).toHaveCount(1);

    // Back returns to By group.
    await page.goBack();
    await expect(page.getByRole('button', { name: 'By group' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.11 evidence: the budget by group and by variability, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(180_000);
    await installFakeWebAuthnAssertion(page);
    await installBudgetMocks(page);
    await loginAndReachBudget(page);
    for (const [width, height] of [
      [1280, 2000],
      [390, 3400],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const [name, path] of [
        ['by-group', '/budget'],
        ['by-variability', '/budget?view=variability'],
      ] as const) {
        await page.goto(path);
        await hideDevtools(page);
        await expect(page.getByRole('region', { name: 'Left to budget' })).toBeVisible();
        await expect(page.locator('[data-meter-tick]').first()).toBeVisible();
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.screenshot({
            path: `${screenshotDir(evidenceDir)}wp10.11-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
            fullPage: true,
          });
        }
      }
    }
  },
);
