// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 10.10: the Cash Flow hub at `/cash-flow`. The whole app's mocks (`installSweepMocks`, which layers
 * `mock-cash-flow.ts` over the budget layer's Reports mocks), so the Flow and Categories displays read the same
 * bodies Reports' own spec drives. "Today" is 17 March 2026.
 */

function search(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

test.describe('WP 10.10 Cash Flow hub', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await installSweepMocks(page);
  });

  test('the nav reaches it under Money, between Transactions and Budget', async ({ page }) => {
    await visit(page, '/');
    const money = page.getByRole('navigation').first();
    const labels = await money.getByRole('link').allInnerTexts();
    const at = (label: string) => labels.findIndex((text) => text.trim() === label);
    expect(at('Cash flow')).toBeGreaterThan(at('Transactions'));
    expect(at('Cash flow')).toBeLessThan(at('Budget'));
    await money.getByRole('link', { name: 'Cash flow' }).click();
    await expect(page).toHaveURL(/\/cash-flow$/);
    await expect(page.getByRole('heading', { name: 'Cash flow', level: 2 })).toBeVisible();
  });

  test('the strip, so far: income, expenses, net, the savings rate withheld with its reason; the comparison in money', async ({
    page,
  }) => {
    await visit(page, '/cash-flow');
    const strip = page.getByTestId('cash-flow-strip');
    await expect(strip.locator('[data-figure="income"]')).toContainText('Income so far');
    await expect(strip.locator('[data-figure="income"]')).toContainText('$5,200.00');
    await expect(strip.locator('[data-figure="expenses"]')).toContainText('−$1,512.50');
    await expect(strip.locator('[data-figure="net"]')).toContainText('+$3,687.50');
    await expect(page.getByTestId('savings-rate-withheld')).toContainText('once the month is over');
    await expect(page.getByTestId('cash-flow-notes')).toContainText(
      'March 2026 so far, through 2026-03-17',
    );
    await expect(page.getByTestId('cash-flow-notes')).toContainText(
      'EUR is not included (never converted)',
    );
    const comparison = page.getByTestId('cash-flow-comparison');
    await expect(comparison).toContainText(
      /Expenses: \$[\d,.]+ (more|less) than last month at this point \(\$1,512\.50 against \$[\d,.]+\)\./,
    );
    await comparison.getByRole('button', { name: 'vs 12-month average' }).click();
    await expect(page).toHaveURL(/compare=average/);
    await expect(comparison).toContainText(
      'your average over the 11 months with transactions at this point',
    );
    await comparison.getByRole('button', { name: 'vs same month last year' }).click();
    await expect(page.getByTestId('comparison-withheld')).toHaveText(
      'No comparison: March 2025 has no transactions.',
    );
  });

  test('Display by: Flow is the Sankey, Bars is income and expenses with a net line; the tabs offer their own', async ({
    page,
  }) => {
    await visit(page, '/cash-flow');
    await expect(page.getByRole('button', { name: 'Flow', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel(/Cash flow sankey diagram/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Bars', exact: true }).click();
    await expect(page).toHaveURL(/display=bars/);
    const bars = page.getByTestId('cash-flow-bars');
    await expect(bars).toBeVisible();
    await expect(bars).toHaveAttribute(
      'aria-label',
      /March 2026: income \$5,200\.00, expenses \$1,512\.50, net \$3,687\.50 so far\./,
    );
    await expect(bars.locator('[data-series="income"]')).toHaveCount(12);
    await expect(bars.locator('[data-series="expenses"]')).toHaveCount(12);
    await expect(bars.locator('[data-series="net"]')).toHaveCount(1);
    await expect(page.getByTestId('cash-flow-legend')).toContainText('Net cash flow');

    await page.getByRole('tab', { name: 'Spending' }).click();
    await expect(page).toHaveURL(/tab=spending/);
    // Flow is the Cash flow tab's; Spending falls back to its own first display, Bars.
    await expect(page.getByRole('button', { name: 'Flow', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bars', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('cash-flow-bars').locator('[data-series="income"]')).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Categories', exact: true }).click();
    await expect(page.getByLabel('Spending by category and month').first()).toBeVisible();
    await expect(page.getByTestId('cash-flow-strip').locator('[data-figure]')).toHaveCount(1);
  });

  test('the stepper: back a month, across the year boundary by quarter, "This month" resets, no stepping past today', async ({
    page,
  }) => {
    await visit(page, '/cash-flow');
    const period = page.getByTestId('cash-flow-period');
    await expect(period).toHaveText('March 2026');
    await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await expect(period).toHaveText('February 2026');
    await expect(page).toHaveURL(/period=2026-02/);
    // February has no income: the rate is withheld for that reason, and the figures are no longer "so far".
    await expect(page.getByTestId('savings-rate-withheld')).toHaveText(
      'No income this month, so there is no rate to work out.',
    );
    await expect(page.getByTestId('cash-flow-strip')).not.toContainText('so far');
    await page.getByRole('button', { name: 'This month' }).click();
    await expect(period).toHaveText('March 2026');
    expect(search(page).has('period')).toBe(false);

    await page.getByRole('button', { name: 'Quarter', exact: true }).click();
    await expect(period).toHaveText('Q1 2026');
    await page.getByRole('button', { name: 'Previous quarter' }).click();
    await expect(period).toHaveText('Q4 2025');
    await expect(page).toHaveURL(
      /timeframe=quarter&period=2025-Q4|period=2025-Q4.*timeframe=quarter/,
    );
    await expect(
      page.getByTestId('cash-flow-strip').locator('[data-figure="savings-rate"]'),
    ).toContainText('%');
    await page.getByRole('button', { name: 'Year', exact: true }).click();
    await expect(period).toHaveText('2026');
    expect(search(page).has('period')).toBe(false);
  });

  test('breakdowns: by category with the tail folded, by group, by merchant; a row drills to the filtered list', async ({
    page,
  }) => {
    await visit(page, '/cash-flow?tab=spending');
    const breakdowns = page.getByTestId('cash-flow-breakdowns');
    const list = breakdowns.getByRole('region', { name: 'Expenses by category' });
    await expect(list.getByRole('listitem')).toHaveCount(13);
    await expect(list.getByRole('listitem').last()).toContainText('Other (2 categories)');
    await expect(list.getByRole('listitem').first()).toContainText('Rent');
    await breakdowns.getByRole('button', { name: 'By merchant' }).click();
    await expect(page).toHaveURL(/breakdown=merchant/);
    const merchants = breakdowns.getByRole('region', { name: 'Expenses by merchant' });
    await expect(merchants).toContainText('Corner Grocery');
    await expect(merchants.getByRole('link', { name: /No merchant/ })).toHaveCount(0);
    await breakdowns.getByRole('button', { name: 'By group' }).click();
    await expect(breakdowns.getByRole('region', { name: 'Expenses by group' })).toContainText(
      'Home',
    );

    await breakdowns.getByRole('button', { name: 'By category' }).click();
    await list.getByRole('link', { name: /Groceries/ }).click();
    await expect(page).toHaveURL(/\/transactions\?/);
    const landed = search(page);
    expect(landed.get('from')).toBe('2026-03-01');
    expect(landed.get('to')).toBe('2026-03-31');
    expect(landed.get('categoryIds')).toContain('cat_groceries');

    await page.goBack();
    await expect(page).toHaveURL(/\/cash-flow\?tab=spending/);
    await page
      .getByTestId('cash-flow-breakdowns')
      .getByRole('button', { name: 'By merchant' })
      .click();
    await page
      .getByRole('region', { name: 'Expenses by merchant' })
      .getByRole('link', { name: /Corner Grocery/ })
      .click();
    await expect(page).toHaveURL(/\/transactions\?/);
    expect(search(page).get('merchantIds')).toContain('merch_grocer');
    await expect(page.getByRole('button', { name: 'Remove merchant filter' })).toBeVisible();
  });

  test('the URL round-trips: a deep link restores tab, display, timeframe, period, breakdown and comparison', async ({
    page,
  }) => {
    await visit(
      page,
      '/cash-flow?tab=income&display=categories&timeframe=quarter&period=2025-Q4&breakdown=merchant&compare=year_ago',
    );
    await expect(page.getByRole('tab', { name: 'Income' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Categories', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Quarter', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('cash-flow-period')).toHaveText('Q4 2025');
    await expect(page.getByRole('button', { name: 'By merchant' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'vs same quarter last year' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByLabel('Income by category and month').first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('cash-flow-period')).toHaveText('Q4 2025');
    // A bad value falls back to the default instead of failing the route.
    await visit(page, '/cash-flow?tab=nonsense&timeframe=month&period=2026-Q1');
    await expect(page.getByRole('tab', { name: 'Cash flow' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('cash-flow-period')).toHaveText('March 2026');
    await expectNoAxeViolations(page, 'cash flow hub');
  });

  test('Reports links to the hub from its cash-flow tab', async ({ page }) => {
    await visit(page, '/reports');
    await page.getByRole('tab', { name: 'Cash flow' }).click();
    await page.getByTestId('open-in-cash-flow').click();
    await expect(page).toHaveURL(/\/cash-flow$/);
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.10 evidence: the hub, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(180_000);
    await installSweepMocks(page);
    const shots = [
      ['cash-flow-flow', '/cash-flow', 'Cash flow sankey diagram'],
      ['cash-flow-bars', '/cash-flow?display=bars', null],
      [
        'spending-categories',
        '/cash-flow?tab=spending&display=categories',
        'Spending by category and month',
      ],
    ] as const;
    for (const [width, height] of [
      [1280, 2300],
      [390, 3600],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const [name, path, label] of shots) {
        await visit(page, path);
        await hideDevtools(page);
        if (label === null) await expect(page.getByTestId('cash-flow-bars')).toBeVisible();
        else await expect(page.getByLabel(label).first()).toBeVisible();
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.screenshot({
            path: `${screenshotDir(evidenceDir)}wp10.10-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
          });
        }
      }
    }
  },
);
