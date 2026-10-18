// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

import { setTheme } from './support/axe.ts';
import { installCategoryMocks } from './support/mock-categories.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 10.14 (V7): the category detail screen at `/categories/:id` and the category editor. The whole app's mocks
 * (`installSweepMocks`) with the category layer over them (`mock-categories.ts`: the Cash Flow hub's categories, a
 * stateful `PATCH /categories/{id}`, a small ledger filtered by category and month). "Today" is 17 March 2026.
 */

function search(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

async function openGroceries(page: Page): Promise<void> {
  await visit(page, '/categories/cat_groceries');
  await expect(page.getByRole('heading', { name: 'Groceries', level: 2 })).toBeVisible();
}

function grid(page: Page) {
  return page.getByRole('grid', { name: 'Transactions' });
}

test.describe('WP 10.14 category detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await installSweepMocks(page);
  });

  test('a Cash Flow breakdown row opens its category: icon, name, kind, variability, the sentence', async ({
    page,
  }) => {
    await installCategoryMocks(page);
    await visit(page, '/cash-flow?tab=spending');
    const list = page
      .getByTestId('cash-flow-breakdowns')
      .getByRole('region', { name: 'Expenses by category' });
    await expect(list.locator('[data-category-icon="cat_groceries"]')).toHaveText('🛒');
    await list.getByRole('link', { name: /Groceries/ }).click();
    await expect(page).toHaveURL(/\/categories\/cat_groceries$/);
    await expect(page.getByRole('heading', { name: 'Groceries', level: 2 })).toBeVisible();
    await expect(page).toHaveTitle('Category · PersonalFi');
    const header = page.getByTestId('category-header');
    await expect(header.locator('[data-category-icon]')).toHaveText('🛒');
    await expect(header).toContainText('Top-level category · Expense');
    await expect(page.getByTestId('category-variability-chip')).toHaveText('Flexible');
    await expect(page.getByTestId('category-hero-amount')).toContainText('−$210.00');
    await expect(page.getByTestId('category-comparison')).toHaveText(
      'So far this month, $146.67 less than your average month of $356.67.',
    );
    // The dashed average line and its label; the current month hatched; the two zero months as stubs.
    await expect(page.getByTestId('category-average-line')).toHaveAttribute(
      'data-average-minor',
      '35667',
    );
    await expect(page.getByTestId('category-average-line')).toContainText('Avg $356.67');
    await expect(page.locator('[data-current="true"] [data-column-bar]')).toHaveAttribute(
      'fill',
      /^url\(#category-hatch-/,
    );
    await expect(page.locator('[data-zero-stub]')).toHaveCount(2);
    // This month's transactions are beneath, and only this month's.
    await expect(page.getByTestId('category-transactions-heading')).toHaveText(
      'Transactions in March 2026',
    );
    await expect(grid(page).getByRole('row')).toHaveCount(2);
    await expect(grid(page)).toContainText('Farmers Market');
  });

  test('selecting a month by keyboard filters the transactions beneath; a press selects too', async ({
    page,
  }) => {
    await installCategoryMocks(page);
    await openGroceries(page);
    const slider = page.getByRole('slider', { name: 'Groceries by month: choose a month' });
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/month=2026-02/);
    await expect(slider).toHaveAttribute('aria-valuenow', '12');
    await expect(page.getByTestId('category-history-announcement')).toHaveText(
      'February 2026: $390.00 spent; $33.33 more than your average month of $356.67.',
    );
    await expect(page.getByTestId('category-readout')).toContainText(
      'February 2026: $390.00 spent',
    );
    await expect(page.getByTestId('category-transactions-heading')).toHaveText(
      'Transactions in February 2026',
    );
    await expect(grid(page).getByRole('row')).toHaveCount(2);
    await expect(grid(page)).toContainText('Bulk Barn');
    await expect(grid(page)).not.toContainText('Farmers Market');

    // A zero month is a zero, and says so.
    await page.keyboard.press('Home');
    await expect(page).toHaveURL(/month=2025-03/);
    for (let n = 0; n < 2; n += 1) await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/month=2025-05/);
    await expect(page.getByTestId('category-readout')).toContainText('May 2025: no spend');
    await expect(page.getByText('No transactions match these filters')).toBeVisible();

    // A press on a column selects its month.
    const january = page.locator('[data-month="2026-01"] [data-column-bar]');
    const box = (await january.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page).toHaveURL(/month=2026-01/);
    await expect(grid(page).getByRole('row')).toHaveCount(1);

    // "See transactions" is the old drill-through, for the selected month.
    await page.getByTestId('category-see-transactions').click();
    await expect(page).toHaveURL(/\/transactions\?/);
    expect(search(page).get('from')).toBe('2026-01-01');
    expect(search(page).get('to')).toBe('2026-01-31');
    expect(search(page).get('categoryIds')).toContain('cat_groceries');
  });

  test('the table lists every month, the zero months as "No spend"', async ({ page }) => {
    await installCategoryMocks(page);
    await openGroceries(page);
    await page.getByRole('button', { name: /View as table/ }).click();
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(14);
    await expect(rows.nth(3)).toContainText('May 2025');
    await expect(rows.nth(3)).toContainText('No spend');
    await expect(rows.nth(13)).toContainText('March 2026 (so far)');
  });

  test('edit the icon and the hue, and see them on the Transactions screen', async ({ page }) => {
    const mocks = await installCategoryMocks(page);
    await openGroceries(page);
    await page.getByRole('button', { name: 'Edit Groceries' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit Groceries' });
    await expect(dialog).toBeVisible();
    // The displayed default is not a choice: no icon is checked yet.
    await expect(
      dialog.getByRole('radiogroup', { name: 'Icon' }).locator('[aria-checked="true"]'),
    ).toHaveCount(0);
    const field = dialog.getByLabel('Or type one emoji');
    await field.fill('ab');
    await expect(dialog.getByRole('alert')).toContainText('Enter exactly one emoji');
    await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await field.fill('🥑');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    // The swatches: a radio group named by hue; the current one is checked; arrows move and select.
    const green = dialog.getByRole('radio', { name: 'Green' });
    await expect(green).toHaveAttribute('aria-checked', 'true');
    await green.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByRole('radio', { name: 'Teal' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await dialog.getByRole('radio', { name: 'Pink' }).click();
    await expect(dialog.getByRole('radio', { name: 'Pink' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    expect(mocks.patches).toEqual([{ emoji: '🥑', hue: 'pink' }]);

    const icon = page.getByTestId('category-header').locator('[data-category-icon]');
    await expect(icon).toHaveText('🥑');
    await expect(icon).toHaveAttribute('style', /--chart-event-bg-pink/);

    await visit(page, '/transactions');
    const row = page.locator('[data-transaction-id="txn_g_mar_1"]');
    await expect(row.locator('[data-category-icon="cat_groceries"]')).toHaveText('🥑');
    await expect(row.locator('[data-category-icon="cat_groceries"]')).toHaveAttribute(
      'style',
      /--chart-event-bg-pink/,
    );
    await expect(row).toContainText('Groceries');
  });

  test('with reduced motion the columns do not grow', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 1100 });
    await installSweepMocks(page);
    await installCategoryMocks(page);
    await openGroceries(page);
    await expect(page.locator('[data-column-bar]').first()).toBeVisible();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await context.close();
  });

  test('without reduced motion the columns grow once from the baseline', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installCategoryMocks(page);
    await page.addInitScript(() => {
      const original = Element.prototype.animate;
      (window as unknown as { grown: number }).grown = 0;
      Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
        if (this.hasAttribute('data-column-bar'))
          (window as unknown as { grown: number }).grown += 1;
        return original.apply(this, args);
      };
    });
    await openGroceries(page);
    await expect(page.locator('[data-column-bar]').first()).toBeVisible();
    // Thirteen months, two of them zero: eleven columns.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { grown: number }).grown))
      .toBe(11);
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.14 evidence: the category screen with a month selected, and the editor, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(180_000);
    await installSweepMocks(page);
    await installCategoryMocks(page);
    for (const [width, height] of [
      [1280, 1500],
      [390, 2400],
    ] as const) {
      await page.setViewportSize({ width, height });
      await visit(page, '/categories/cat_groceries?month=2026-02');
      await hideDevtools(page);
      await expect(page.getByTestId('category-average-line')).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.14-category-detail-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
      await page.getByRole('button', { name: 'Edit Groceries' }).click();
      await expect(page.getByRole('dialog', { name: 'Edit Groceries' })).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.14-category-editor-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
      await page.keyboard.press('Escape');
    }
  },
);
