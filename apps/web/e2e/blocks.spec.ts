// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { setTheme } from './support/axe.ts';
import { installCategoryMocks } from './support/mock-categories.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 10.15 (V8): the block kit's gallery on `/dev/kitchen-sink`, the Brief drawn through blocks with the narration
 * badge, and the evidence screenshots (the gallery, the Brief, an insight card with mentions), light and dark at
 * 1280 and 390. Run the screenshot test alone with `-g "WP 10.15 evidence"`.
 */
test.describe('WP 10.15 blocks', () => {
  test('the gallery draws every kind in both themes; an unknown kind is a visible row, never dropped', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await installSweepMocks(page);
    await visit(page, '/dev/kitchen-sink');
    for (const theme of ['light', 'dark'] as const) {
      const gallery = page.locator(`[data-theme="${theme}"] [data-testid="blocks-gallery"]`);
      await expect(gallery).toBeVisible();
      const kinds = await gallery
        .locator('[data-block-kind]')
        .evaluateAll((nodes) => [
          ...new Set(nodes.map((node) => node.getAttribute('data-block-kind'))),
        ]);
      // The gallery's unknown kind (`merchants-list`) is drawn too — as its "Unsupported block" row.
      expect(new Set(kinds.filter((kind) => kind !== 'merchants-list'))).toEqual(
        new Set([
          'text',
          'info',
          'money',
          'horizontal-bars',
          'pie',
          'stacked-bars',
          'sparkline-row',
          'meter',
          'net-worth',
          'transactions-list',
          'table',
          'badge',
          'cta',
          'divider',
          'group',
        ]),
      );
      await expect(gallery.getByTestId('block-unsupported').first()).toContainText(
        'Unsupported block',
      );
      await expect(gallery.getByTestId('block-withheld').first()).toBeVisible();
    }
  });

  test('the Brief renders its overview blocks and each card’s blocks', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await installSweepMocks(page);
    await visit(page, '/brief');
    await expect(page.locator('[data-block-id="brief-week"]')).toBeVisible();
    await expect(page.locator('[data-block-id="brief-health-score"]')).toBeVisible();
    const cards = page.getByTestId('brief-item-card');
    await expect(cards.first()).toBeVisible();
    await expect(
      cards.first().locator('[data-block-kind="text"], [data-block-kind="money"]').first(),
    ).toBeVisible();
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.15 evidence: the Blocks gallery, the Brief and an insight card with mentions, light and dark, at 1280 and 390',
  async ({ page, evidenceDir }) => {
    test.setTimeout(240_000);
    await installSweepMocks(page);
    await installCategoryMocks(page);
    for (const [width, height] of [
      [1280, 1400],
      [390, 2400],
    ] as const) {
      await page.setViewportSize({ width, height });

      await visit(page, '/dev/kitchen-sink');
      await hideDevtools(page);
      for (const theme of ['light', 'dark'] as const) {
        // The kitchen sink draws a light panel then a dark one; the page's own theme does not matter here.
        const gallery = page.getByTestId('blocks-gallery').nth(theme === 'light' ? 0 : 1);
        await gallery.scrollIntoViewIfNeeded();
        // `ParentSize` measures after a debounce; shoot once every plot has drawn.
        await expect(gallery.getByTestId('net-worth-stacked-plot')).toBeVisible();
        await expect(gallery.getByTestId('stacked-bars-plot')).toBeVisible();
        await page.waitForTimeout(500);
        await gallery.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.15-blocks-gallery-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }

      await visit(page, '/brief');
      await hideDevtools(page);
      await expect(page.getByTestId('brief-item-card').first()).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.15-brief-${theme}-${String(width)}.png`,
          animations: 'disabled',
          fullPage: true,
        });
      }

      await visit(page, '/insights');
      await hideDevtools(page);
      const card = page
        .getByRole('list', { name: 'Insights' })
        .locator('> li')
        .filter({ hasText: 'has been running higher than usual' });
      await expect(card.getByTestId('insight-context-line')).toHaveText('About Groceries');
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await card.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.15-insight-card-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
    }
  },
);
