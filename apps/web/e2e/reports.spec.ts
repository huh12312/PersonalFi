// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { visit } from './support/sweep.ts';

/**
 * WP 10.15 (V8): the Reports screen draws its saved reports through the block renderer — Spending and Income as
 * `stacked-bars` blocks, Budget vs. actual as a `table` block — from `GET /reports/blocks/*` (mocked by
 * `support/mock-budget.ts` with the API's own builders, `src/test-support/block-fixtures.ts`). The Sankey stays a
 * bespoke component and is no block.
 */
test.describe('WP 10.15 reports through blocks', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await installSweepMocks(page);
  });

  test('spending is a stacked-bars block; a segment drills to its transactions; its table lists the figures', async ({
    page,
  }) => {
    await visit(page, '/reports');
    const spending = page.locator('[data-block-kind="stacked-bars"]').first();
    await expect(spending).toBeVisible();
    await expect(
      spending.getByRole('group', { name: 'Spending by category and month' }),
    ).toBeVisible();
    await spending.getByRole('button', { name: /View as table/ }).click();
    const table = spending.getByRole('table');
    await expect(table).toContainText('Groceries');
    await expect(table).toContainText('$60.00');
    await expect(table).toContainText('$75.00');
    await expectNoAxeViolations(page, 'reports (spending blocks)');

    await spending.getByRole('link', { name: /Groceries, 2026-08, .*view transactions/ }).click();
    await expect(page).toHaveURL(/\/transactions\?/);
    expect(new URL(page.url()).searchParams.get('categoryIds')).toContain('cat_groceries');
  });

  test('budget vs. actual is a table block: names open the category, overspend as badges', async ({
    page,
  }) => {
    await visit(page, '/reports');
    await page.getByRole('tab', { name: 'Budget vs. actual' }).click();
    const table = page.locator('[data-block-kind="table"]').getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText([
      'Category',
      'Assigned',
      'Activity',
      'Available',
      'Overspend',
      'Transactions',
    ]);
    await expect(table.getByRole('rowheader', { name: 'Groceries' })).toBeVisible();
    await expectNoAxeViolations(page, 'reports (budget vs actual block)');
    await table.getByRole('link', { name: 'Groceries', exact: true }).click();
    await expect(page).toHaveURL(/\/categories\/cat_groceries$/);
  });

  test('income with no activity says so; the Sankey stays bespoke', async ({ page }) => {
    await visit(page, '/reports');
    await page.getByRole('tab', { name: 'Income' }).click();
    await expect(page.getByText('No activity in this window.')).toBeVisible();
    await page.getByRole('tab', { name: 'Cash flow' }).click();
    await expect(page.getByTestId('open-in-cash-flow')).toBeVisible();
    await expect(page.getByRole('tabpanel').locator('[data-block-kind]')).toHaveCount(0);
  });
});
