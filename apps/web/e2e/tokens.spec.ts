// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { TOKENS } from '../src/styles/tokens.ts';
import { CHART_FILL_ORDER } from '../src/styles/tokens/fills.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 10.8: the kitchen sink's "Tokens" section, in its light and its dark panel. The functional test proves the
 * browser resolves every role from the generated `tokens.css` — including inside a nested `data-theme` subtree,
 * which is the case a var()-chained alias would have got wrong — by comparing each swatch's computed colour to
 * the generated TS object. The evidence test writes `wp10.8-tokens-{light,dark}.png` when
 * `PLAYWRIGHT_EVIDENCE_DIR` is set (see `recurring-insights.spec.ts`'s note on `evidenceDir`).
 */
const THEMES = ['light', 'dark'] as const;

function rgb(hex: string): string {
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${String(n(1))}, ${String(n(3))}, ${String(n(5))})`;
}

test.describe('WP 10.8 tokens', () => {
  test('every chart fill and event role in both panels is the generated value', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/dev/kitchen-sink');
    const galleries = page.getByTestId('token-gallery');
    await expect(galleries).toHaveCount(2);
    for (const [index, theme] of THEMES.entries()) {
      const gallery = galleries.nth(index);
      const values = await gallery.evaluate(
        (root, names) => names.map((name) => getComputedStyle(root).getPropertyValue(name).trim()),
        [
          ...CHART_FILL_ORDER.map((hue) => `--chart-fill-${hue}`),
          ...CHART_FILL_ORDER.map((hue) => `--chart-event-fg-${hue}`),
          '--bg-primary',
          '--status-success-text',
        ],
      );
      const expected = [
        ...CHART_FILL_ORDER.map((hue) => TOKENS[theme][`--chart-fill-${hue}`]),
        ...CHART_FILL_ORDER.map((hue) => TOKENS[theme][`--chart-event-fg-${hue}`]),
        TOKENS[theme]['--bg-primary'],
        TOKENS[theme]['--status-success-text'],
      ];
      expect(values).toEqual(expected);
      // And a painted swatch, not only the custom property: the first fill's computed background.
      const firstSwatch = gallery.locator('li span[aria-hidden="true"]').first();
      await expect(firstSwatch).toHaveCSS(
        'background-color',
        rgb(TOKENS[theme]['--chart-fill-green']),
      );
    }
  });
});

const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

evidenceTest(
  'WP 10.8 evidence: the Tokens section, light and dark',
  async ({ page, evidenceDir }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/dev/kitchen-sink');
    const galleries = page.getByTestId('token-gallery');
    await expect(galleries).toHaveCount(2);
    for (const [index, theme] of THEMES.entries()) {
      const section = galleries.nth(index).locator('xpath=..');
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.8-tokens-${theme}.png`,
        animations: 'disabled',
      });
    }
  },
);
