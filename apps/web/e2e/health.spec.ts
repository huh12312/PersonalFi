// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

import { setTheme } from './support/axe.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 10.12: Financial health as a gauge and pillars (V5). The whole app's mocks (`installSweepMocks`, which layers
 * `mock-health.ts` through the dashboard layer), so `/health`, a pillar's detail and the dashboard widget read the
 * same `HealthOverview`.
 */

async function openHealth(page: Page): Promise<void> {
  await installSweepMocks(page);
  await visit(page, '/health');
  await expect(page.getByTestId('health-hero')).toBeVisible();
}

test.describe('WP 10.12 financial health', () => {
  test('the hero: the gauge swept once to the score, the tier, the next step, the as-of date, the 30-day change', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHealth(page);
    const hero = page.getByTestId('health-hero');
    const gauge = hero.getByRole('img', { name: 'Financial health score 75 out of 100, Steady' });
    await expect(gauge).toBeVisible();
    await expect(gauge).toHaveAttribute('data-gauge-swept', 'true');
    await expect(hero.getByTestId('health-tier')).toHaveText(/^Steady/u);
    await expect(hero.getByTestId('health-tier-line')).toHaveText(
      'You’re on steady ground. The one thing to do next: save 10% of your income (Savings rate).',
    );
    await expect(hero.getByTestId('health-as-of')).toHaveText('As of Oct 18, 2026');
    await expect(hero.getByTestId('health-delta')).toContainText('Up 5.4 points from 30 days ago');
    await expect(hero.getByTestId('health-history-sparkline')).toBeVisible();

    await hero.getByRole('button', { name: /View as table/u }).click();
    // 36 snapshot days (39 less the three the job missed) plus the header row.
    await expect(hero.getByRole('table').getByRole('row')).toHaveCount(37);
  });

  test('the pillars: six cards, a scored one with its inputs, the withheld one in words and never a number', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHealth(page);
    const grid = page.getByTestId('pillars-grid');
    await expect(grid.locator('[data-pillar]')).toHaveCount(6);
    const columns = await grid.evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length,
    );
    expect(columns).toBe(3);

    const emergency = grid.locator('[data-pillar="emergency_fund_months"]');
    await expect(emergency.getByTestId('pillar-score')).toHaveText('75 / 100');
    await expect(emergency.getByTestId('pillar-inputs')).toContainText('$12,600.00');
    await expect(emergency.getByTestId('living-cover')).toContainText(
      'Your cash covers 6.3 months of living expenses ($2,000.00 a month)',
    );

    const withheld = grid.locator('[data-pillar="diversification"]');
    await expect(withheld).toHaveAttribute('data-pillar-status', 'withheld');
    await expect(withheld.getByText('Not scored')).toBeVisible();
    await expect(withheld.getByTestId('pillar-withheld')).toContainText(
      'To unlock: Link an investment account whose holdings have prices.',
    );
    await expect(withheld.getByTestId('pillar-score')).toHaveCount(0);
    expect(await withheld.innerText()).not.toMatch(/\/ 100|Counts for/u);
  });

  test('a phone gets one pillar per row', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openHealth(page);
    const columns = await page
      .getByTestId('pillars-grid')
      .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(1);
  });

  test('a pillar’s detail: the zone chart from the scoring rules, the ladder, the history, the inputs', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHealth(page);
    await page
      .locator('[data-pillar="emergency_fund_months"]')
      .getByRole('link', { name: /See detail/u })
      .click();
    await expect(page).toHaveURL(/\/health\/emergency-fund$/u);
    await expect(page.getByRole('heading', { name: 'Emergency fund', level: 2 })).toBeVisible();
    const chart = page.getByTestId('zone-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('[data-zone]')).toHaveCount(4);
    await expect(chart.getByTestId('zone-now')).toHaveText('Now: 4.2 months');
    await expect(chart.locator('[data-series="metric"]')).toHaveCount(1);
    await expect(page.getByTestId('pillar-ladder')).toContainText(
      'Good: 3 months to under 6 months',
    );
    await expect(page.getByTestId('pillar-history-sparkline')).toBeVisible();
    await expect(page.getByTestId('living-cover')).toContainText(
      'Fixed categories (3): $1,850.00 a month',
    );
    await page.getByRole('link', { name: 'Financial health' }).first().click();
    await expect(page).toHaveURL(/\/health$/u);
  });

  test('the dashboard widget: the small gauge, the tier, the change; See all opens /health', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installSweepMocks(page);
    await visit(page, '/');
    const widget = page.locator('[data-widget="financial-health"]');
    await expect(widget.getByRole('heading', { name: 'Financial health' })).toBeVisible();
    await expect(widget.locator('[data-score-gauge="sm"]')).toBeVisible();
    await expect(widget.getByTestId('widget-health-tier')).toHaveText('Steady');
    await expect(widget.getByTestId('widget-health-delta')).toHaveText(
      'Up 5.4 points from 30 days ago',
    );
    await widget.getByRole('link', { name: /See all/u }).click();
    await expect(page).toHaveURL(/\/health$/u);
    await expect(page.getByTestId('health-hero')).toBeVisible();
  });

  test('the nav lists Financial health under Overview, after Insights', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installSweepMocks(page);
    await visit(page, '/');
    const nav = page.getByRole('navigation').first();
    const labels = await nav.getByRole('link').allInnerTexts();
    const insights = labels.findIndex((label) => label.trim() === 'Insights');
    expect(labels[insights + 1]?.trim()).toBe('Financial health');
    await nav.getByRole('link', { name: 'Financial health' }).click();
    await expect(page).toHaveURL(/\/health$/u);
    await expect(page).toHaveTitle('Financial health · PersonalFi');
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.12 evidence: the Health screen and a pillar, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(180_000);
    await installSweepMocks(page);
    for (const [width, height] of [
      [1280, 1800],
      [390, 3600],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const [name, path, ready] of [
        ['health', '/health', 'health-hero'],
        ['pillar', '/health/emergency-fund', 'zone-chart'],
      ] as const) {
        await visit(page, path);
        await hideDevtools(page);
        await expect(page.getByTestId(ready)).toBeVisible();
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.waitForTimeout(800);
          await page.screenshot({
            path: `${screenshotDir(evidenceDir)}wp10.12-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
            fullPage: true,
          });
        }
      }
    }
  },
);
