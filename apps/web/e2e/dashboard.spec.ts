// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

import { setTheme } from './support/axe.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 10.9: the dashboard as widgets. The whole app's mocks (`installSweepMocks`, which layers
 * `mock-dashboard.ts`'s layout and spending pace over every feature's own fixtures), so each widget reads the
 * bodies its own screen's spec drives. The layout lives in the mock's closure, so a reload re-reads what was saved —
 * the persistence a holder sees.
 */

function gridOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId('dashboard-grid')
    .locator('[data-grid-widget]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-grid-widget') ?? ''));
}

test.describe('WP 10.9 dashboard', () => {
  test('the spending pace renders: the sentence, three series, today, the table', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installSweepMocks(page);
    await visit(page, '/');
    const widget = page.locator('[data-widget="spending-pace"]');
    await expect(widget.getByRole('heading', { name: 'Spending pace' })).toBeVisible();
    await expect(widget.getByTestId('pace-sentence')).toContainText("You've spent $43.00");
    await expect(widget.getByTestId('pace-sentence')).toContainText(
      'By this day last month you had spent $90.00',
    );
    await expect(widget.getByTestId('pace-sentence')).toContainText('less than last month');
    const chart = widget.getByTestId('pace-chart');
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute(
      'aria-label',
      /\$43\.00 spent through day 17\. By day 17 last month, \$90\.00\./,
    );
    for (const series of ['this-month', 'last-month', 'average']) {
      await expect(chart.locator(`[data-series="${series}"]`)).toHaveCount(1);
    }
    await expect(chart.getByTestId('pace-today-dot')).toHaveCount(1);

    await widget.getByRole('button', { name: /View as table/ }).click();
    await expect(widget.getByRole('button', { name: /Hide table/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const table = widget.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(32);
    await widget.getByRole('button', { name: /Hide table/ }).click();
    await expect(widget.getByRole('table')).toHaveCount(0);
  });

  test('Customize: a hidden widget and a new order persist across a reload; reset restores the default', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installSweepMocks(page);
    await visit(page, '/');
    await expect.poll(() => gridOrder(page)).toHaveLength(9);
    expect((await gridOrder(page))[0]).toBe('net-worth');

    await page.getByRole('button', { name: 'Customize' }).click();
    const dialog = page.getByRole('dialog', { name: 'Customize the dashboard' });
    await dialog.getByRole('switch', { name: 'Show Investments' }).click();
    await dialog.getByRole('button', { name: 'Move Spending pace up' }).click();
    await expect(dialog.getByText('Saved.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await expect.poll(() => gridOrder(page)).not.toContain('investments');
    await page.reload();
    await expect.poll(() => gridOrder(page)).toHaveLength(8);
    const reloaded = await gridOrder(page);
    expect(reloaded.slice(0, 2)).toEqual(['spending-pace', 'net-worth']);
    expect(reloaded).not.toContain('investments');
    await expect(page.locator('[data-widget="investments"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Customize' }).click();
    await dialog.getByRole('button', { name: 'Reset to default' }).click();
    await expect(dialog.getByText('The default layout.')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect
      .poll(() => gridOrder(page))
      .toEqual([
        'net-worth',
        'spending-pace',
        'budgets',
        'upcoming',
        'to-review',
        'goals',
        'investments',
        'top-insights',
        'financial-health',
      ]);
  });

  test('the grid is one column on a phone, two at tablet width, three on a desktop', async ({
    page,
  }) => {
    await installSweepMocks(page);
    for (const [width, columns] of [
      [390, 1],
      [900, 2],
      [1280, 3],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await visit(page, '/');
      const count = await page
        .getByTestId('dashboard-grid')
        .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
      expect(count, `${String(width)} px`).toBe(columns);
    }
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.9 evidence: the dashboard, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(120_000);
    await installSweepMocks(page);
    // Tall viewports rather than `fullPage`: the shell scrolls inside `#app-content`, which a full-page capture of the
    // document does not unroll.
    for (const [width, height] of [
      [1280, 2000],
      [390, 2900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await visit(page, '/');
      await hideDevtools(page);
      await expect(page.getByTestId('pace-chart')).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.9-dashboard-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
    }
  },
);
