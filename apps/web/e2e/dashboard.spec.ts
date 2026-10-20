// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

import { setTheme } from './support/axe.ts';
import { seedControlCheckRun } from './support/mock-narrator.ts';
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

/**
 * WP 10.16: the backup line says when the GenAI controls were last proven. The narrator layer
 * (`mock-narrator.ts`, through `installApiMocks`) answers `GET /api/narrator/control-checks`; with no run its
 * `lastProven` is null ("controls never proven"), and `seedControlCheckRun` puts a finished one in place.
 */
const BACKUP = 'Last backup 4 h ago · restore drill passed 2026-10-13';

test.describe('WP 10.16 the controls on the backup line', () => {
  test('WP 10.16: "controls never proven" with no run, then "controls proven 2026-10-19" after a passing one', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const mocks = await installSweepMocks(page);
    await visit(page, '/');
    const line = page.getByTestId('backup-status-line');
    await expect(line).toHaveText(`${BACKUP} · controls never proven`);
    await expect(line).toHaveAttribute('data-tone', 'ok');

    seedControlCheckRun(mocks.narrator.controlChecks, {
      finishedAt: '2026-10-19T14:22:09.000Z',
      overall: 'pass',
    });
    await page.reload();
    await expect(line).toHaveText(`${BACKUP} · controls proven 2026-10-19`);
    await expect(line).toHaveAttribute('data-tone', 'ok');
  });

  test('WP 10.16: a failed controls check is a warning in words; a partial one is "partly proven"', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const mocks = await installSweepMocks(page);
    seedControlCheckRun(mocks.narrator.controlChecks, {
      finishedAt: '2026-10-19T14:22:09.000Z',
      overall: 'fail',
    });
    await visit(page, '/');
    const line = page.getByTestId('backup-status-line');
    await expect(line).toHaveAttribute('data-tone', 'warning');
    await expect(line).toContainText('Warning:');
    await expect(line).toContainText('the last controls check failed');
    await expect(line).toContainText(`${BACKUP} · controls check failed 2026-10-19`);

    mocks.narrator.controlChecks.runs = [];
    seedControlCheckRun(mocks.narrator.controlChecks, {
      finishedAt: '2026-10-19T14:22:09.000Z',
      overall: 'partial',
    });
    await page.reload();
    await expect(line).toHaveText(`${BACKUP} · controls partly proven 2026-10-19`);
  });

  test('WP 10.16: when the control-checks route cannot be read the line says nothing about the controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installSweepMocks(page);
    // Registered last, so it runs first: the route answers with a problem.
    await page.route('**/api/narrator/control-checks', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ type: 'about:blank', title: 'Unavailable', status: 503 }),
      }),
    );
    await visit(page, '/');
    const line = page.getByTestId('backup-status-line');
    await expect(line).toHaveText(BACKUP);
    await page.waitForTimeout(500);
    await expect(line).toHaveText(BACKUP);
  });
});

evidenceTest(
  'WP 10.16 evidence: the dashboard backup line with the controls proven, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(120_000);
    const mocks = await installSweepMocks(page);
    seedControlCheckRun(mocks.narrator.controlChecks, {
      finishedAt: '2026-10-19T14:22:09.000Z',
      overall: 'pass',
    });
    for (const [width, height] of [
      [1280, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await visit(page, '/');
      await hideDevtools(page);
      const line = page.getByTestId('backup-status-line');
      await expect(line).toHaveText(`${BACKUP} · controls proven 2026-10-19`);
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await line.scrollIntoViewIfNeeded();
        const box = await line.boundingBox();
        if (box === null) throw new Error('the backup line has no box');
        // The line with the Brief card above it, so it is seen where it sits.
        const top = Math.max(0, box.y - 220);
        await page.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.16-dashboard-ops-line-${theme}-${String(width)}.png`,
          animations: 'disabled',
          clip: {
            x: 0,
            y: top,
            width,
            height: Math.min(height - top, box.y + box.height + 24 - top),
          },
        });
      }
      await setTheme(page, 'light');
    }
  },
);
