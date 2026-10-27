// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { scanBothThemes, setTheme } from './support/axe.ts';
import {
  AUTO_CLASSIFIER,
  AUTO_LEARNED,
  AUTO_PLAID,
  CATEGORY_COFFEE,
  CLASSIFIER_LINE,
  installAutoCategoryMocks,
  LEARNED_LINE,
  PICKED,
  PLAID_LINE,
  RULED,
  seedAutoCategorised,
  type AutoCategoryMocks,
} from './support/mock-auto-category.ts';
import { installSweepMocks, type SweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 11.2b (the automatic tiers made effective), against the mocked api (`support/mock-auto-category.ts` over the
 * sweep's mocks): the provenance chip on `/transactions`, in the detail sheet and on `/categories/:id`; its reveal
 * (hover, press, Enter) reading the stored explanation; the Inbox's second queue, "Auto-categorised, unreviewed" -
 * Looks right is the normal pick with the category already there, Change is the normal picker, the switch hides the
 * section for good - and the accessibility of all three screens: axe in both themes with a reveal open, 320 px, 200 %
 * zoom with 1.4.12 text spacing, reduced motion, and the keyboard journey.
 *
 * The evidence screenshots are one test, run alone with `-g "WP 11.2b evidence"` and `PLAYWRIGHT_EVIDENCE_DIR` set
 * to `docs/evidence/phase-11` (unset, they go to the gitignored output directory).
 */
const test = base.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

interface Opened {
  readonly mocks: SweepMocks;
  readonly auto: AutoCategoryMocks;
}

async function open(page: Page, path: string): Promise<Opened> {
  const mocks = await installSweepMocks(page);
  seedAutoCategorised(mocks.api);
  const auto = await installAutoCategoryMocks(page);
  await visit(page, path);
  await hideDevtools(page);
  return { mocks, auto };
}

const gridRow = (page: Page, name: string): Locator =>
  page.getByRole('row').filter({ hasText: name });
const reviewRow = (page: Page, name: string): Locator =>
  page.getByTestId('auto-review-row').filter({ hasText: name });
const chipOf = (scope: Locator): Locator => scope.getByTestId('provenance-chip');

test.describe('WP 11.2b the provenance chip', () => {
  test('/transactions: every automatic placement wears one, a pick or a rule does not, and the reveal reads the stored explanation', async ({
    page,
  }) => {
    const { auto } = await open(page, '/transactions');

    await expect(chipOf(gridRow(page, AUTO_PLAID.name))).toHaveText('Plaid');
    await expect(chipOf(gridRow(page, AUTO_LEARNED.name))).toHaveText('Learned');
    await expect(chipOf(gridRow(page, AUTO_CLASSIFIER.name))).toHaveText('Classifier 92 %');
    await expect(chipOf(gridRow(page, PICKED.name))).toHaveCount(0);
    await expect(chipOf(gridRow(page, RULED.name))).toHaveCount(0);
    // The list reads no explanation for a row it does not need one for.
    expect(auto.explanationBatches.join(',')).not.toContain('txn_auto');

    // Press: the stored line, the tier's headline, and the row behind it is not opened.
    await chipOf(gridRow(page, AUTO_PLAID.name)).click();
    await expect(page.getByTestId('provenance-line')).toHaveText(PLAID_LINE);
    await expect(page.getByTestId('provenance-reveal')).toContainText(
      'From Plaid’s category for this transaction',
    );
    await expect(page.getByRole('dialog', { name: AUTO_PLAID.name })).toHaveCount(0);
    expect(auto.explanationBatches.at(-1)).toBe(AUTO_PLAID.id);

    // Escape closes it and returns focus to the chip.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('provenance-reveal')).toHaveCount(0);
    await expect(chipOf(gridRow(page, AUTO_PLAID.name))).toBeFocused();

    // Keyboard: Enter on the focused chip; "from N confirmations" is read off the stored chain.
    await chipOf(gridRow(page, AUTO_LEARNED.name)).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('provenance-line')).toHaveText(LEARNED_LINE);
    await expect(page.getByTestId('provenance-reveal')).toContainText(
      'Learned from 4 confirmations',
    );
    await expect(page.getByRole('dialog', { name: AUTO_LEARNED.name })).toHaveCount(0);
  });

  test('hover reveals it too', async ({ page }) => {
    await open(page, '/transactions');
    await chipOf(gridRow(page, AUTO_CLASSIFIER.name)).hover();
    await expect(page.getByTestId('provenance-line')).toHaveText(CLASSIFIER_LINE);
    await expect(page.getByTestId('provenance-reveal')).toContainText('Classifier, 92 % confident');
  });

  test('the detail sheet shows it beside the category, and picking a category removes it', async ({
    page,
  }) => {
    const { mocks } = await open(page, '/transactions');
    await gridRow(page, AUTO_LEARNED.name).getByText(AUTO_LEARNED.name).click();
    const sheet = page.getByRole('dialog', { name: AUTO_LEARNED.name });
    await expect(chipOf(sheet)).toHaveText('Learned');

    // A holder's pick wins and wears no chip.
    await sheet.getByRole('combobox', { name: 'Category' }).click();
    await page.getByRole('option', { name: 'Restaurants' }).click();
    await expect
      .poll(() => mocks.api.lastPatchBody)
      .toEqual({ categoryId: 'cat_dining_restaurants' });
    await expect(chipOf(sheet)).toHaveCount(0);
  });

  test('/categories/:id: its transactions wear their chips', async ({ page }) => {
    await open(page, `/categories/${CATEGORY_COFFEE}`);
    await expect(chipOf(gridRow(page, AUTO_PLAID.name))).toHaveText('Plaid');
    await expect(chipOf(gridRow(page, AUTO_LEARNED.name))).toHaveText('Learned');
    await expect(gridRow(page, AUTO_CLASSIFIER.name)).toHaveCount(0);
  });
});

test.describe('WP 11.2b the Inbox', () => {
  test('the queue is the unplaced rows; the automatic ones are the second queue, with their chips', async ({
    page,
  }) => {
    await open(page, '/inbox');
    const queue = page.getByRole('list', { name: 'Review inbox' });
    await expect(queue).toContainText('Blue Bottle Coffee');
    await expect(queue).toContainText('Farmers Market');
    for (const placed of [AUTO_PLAID, AUTO_LEARNED, AUTO_CLASSIFIER, PICKED, RULED]) {
      await expect(queue).not.toContainText(placed.name);
    }

    const section = page.getByTestId('auto-review-section');
    await expect(
      section.getByRole('heading', { name: /Auto-categorised, unreviewed/u }),
    ).toBeVisible();
    await expect(page.getByTestId('auto-review-count')).toHaveText('3');
    await expect(page.getByTestId('auto-review-row')).toHaveCount(3);
    await expect(reviewRow(page, PICKED.name)).toHaveCount(0);
    await expect(reviewRow(page, RULED.name)).toHaveCount(0);
    await expect(chipOf(reviewRow(page, AUTO_PLAID.name))).toHaveText('Plaid');
    await expect(chipOf(reviewRow(page, AUTO_LEARNED.name))).toHaveText('Learned');
    await expect(chipOf(reviewRow(page, AUTO_CLASSIFIER.name))).toHaveText('Classifier 92 %');
  });

  test('Looks right is the normal pick with the category already there; the row leaves and focus moves on', async ({
    page,
  }) => {
    const { mocks } = await open(page, '/inbox');
    await reviewRow(page, AUTO_LEARNED.name)
      .getByRole('button', { name: /^Looks right/u })
      .click();

    await expect.poll(() => mocks.api.lastPatchBody).toEqual({ categoryId: CATEGORY_COFFEE });
    await expect(reviewRow(page, AUTO_LEARNED.name)).toHaveCount(0);
    await expect(page.getByTestId('auto-review-count')).toHaveText('2');
    await expect(
      reviewRow(page, AUTO_CLASSIFIER.name).getByRole('button', { name: /^Looks right/u }),
    ).toBeFocused();
  });

  test('Change opens the normal picker; picking another category is the pick', async ({ page }) => {
    const { mocks } = await open(page, '/inbox');
    const row = reviewRow(page, AUTO_CLASSIFIER.name);
    await row.getByRole('button', { name: /^Change the category/u }).click();
    await expect(row.getByRole('combobox', { name: 'Category' })).toBeFocused();
    await row.getByRole('combobox', { name: 'Category' }).click();
    await page.getByRole('option', { name: 'Coffee Shops' }).click();
    await expect.poll(() => mocks.api.lastPatchBody).toEqual({ categoryId: CATEGORY_COFFEE });
    await expect(reviewRow(page, AUTO_CLASSIFIER.name)).toHaveCount(0);
  });

  test('the switch hides the section, is saved, survives a reload, and brings it back', async ({
    page,
  }) => {
    const { mocks } = await open(page, '/inbox');
    const toggle = page.getByRole('switch', { name: 'Review automatic placements' });
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect.poll(() => mocks.api.inboxPreferences.puts).toEqual([{ showAutoReview: false }]);
    await expect(page.getByTestId('auto-review-off')).toBeVisible();
    await expect(page.getByTestId('auto-review-row')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('auto-review-off')).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Review automatic placements' }),
    ).not.toBeChecked();
    await expect(page.getByTestId('auto-review-row')).toHaveCount(0);

    await page.getByRole('switch', { name: 'Review automatic placements' }).click();
    await expect(page.getByTestId('auto-review-row')).toHaveCount(3);
    expect(mocks.api.inboxPreferences.puts).toEqual([
      { showAutoReview: false },
      { showAutoReview: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Accessibility: /transactions, /inbox, /categories/:id
// ---------------------------------------------------------------------------

const SCREENS = [
  { path: '/transactions', name: '/transactions', reveal: AUTO_PLAID.name },
  { path: '/inbox', name: '/inbox', reveal: AUTO_LEARNED.name },
  { path: `/categories/${CATEGORY_COFFEE}`, name: '/categories/:id', reveal: AUTO_PLAID.name },
] as const;

const REFLOW = { width: 320, height: 640 } as const;
const ZOOM_200 = { width: 640, height: 400 } as const;

const TEXT_SPACING = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

async function revealChip(page: Page, name: string): Promise<void> {
  const scope = page
    .locator(`[role="row"], [data-testid="auto-review-row"]`)
    .filter({ hasText: name });
  await chipOf(scope.first()).click();
  await expect(page.getByTestId('provenance-line')).not.toHaveText(/Loading/u);
}

/** Anything that makes the page scroll sideways at a narrow width (1.4.10). */
async function horizontalProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = document.documentElement.clientWidth;
    for (const el of [
      document.documentElement,
      document.body,
      ...document.querySelectorAll('main, #app-content'),
    ]) {
      if (el.scrollWidth > el.clientWidth + 1) {
        problems.push(
          `${el.tagName.toLowerCase()} scrolls horizontally (${String(el.scrollWidth)} > ${String(el.clientWidth)})`,
        );
      }
    }
    for (const el of document.querySelectorAll(
      '[data-testid="provenance-chip"], [data-testid="auto-review-row"], [data-testid="provenance-reveal"]',
    )) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > vw + 1) {
        problems.push(
          `${el.getAttribute('data-testid') ?? 'element'} runs past the right edge (${String(Math.round(rect.right))} > ${String(vw)})`,
        );
      }
    }
    return problems;
  });
}

async function clippedTextElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel, svg')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const clips =
        ['hidden', 'clip'].includes(style.overflowX) ||
        ['hidden', 'clip'].includes(style.overflowY);
      if (!clips) continue;
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      );
      if (!hasText) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
        out.push(`${el.tagName.toLowerCase()}: "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      }
    }
    return [...new Set(out)];
  });
}

/** Every element whose computed transition or animation has a non-zero duration, and any running animation. */
async function motionOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seconds = (list: string): number[] =>
      list.split(',').map((v) => {
        const t = v.trim();
        return t.endsWith('ms') ? parseFloat(t) / 1000 : parseFloat(t);
      });
    const out: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.closest('.tsqd-parent-container, .TanStackRouterDevtoolsPanel')) continue;
      const style = getComputedStyle(el);
      if (seconds(style.transitionDuration).some((v) => v > 0)) {
        out.push(`${el.tagName.toLowerCase()} transition-duration ${style.transitionDuration}`);
      }
      if (seconds(style.animationDuration).some((v) => v > 0)) {
        out.push(`${el.tagName.toLowerCase()} animation-duration ${style.animationDuration}`);
      }
    }
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (
        timing !== undefined &&
        Number(timing.duration) > 0 &&
        animation.playState === 'running'
      ) {
        out.push(`a running animation of ${String(timing.duration)}ms`);
      }
    }
    return [...new Set(out)].slice(0, 12);
  });
}

test.describe('WP 11.2b accessibility', () => {
  for (const screen of SCREENS) {
    test(`${screen.name}: axe-clean in both themes at 1280 and 320 px, with a reveal open`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, screen.path);
      await scanBothThemes(page, `${screen.name} (chips shown)`);
      await revealChip(page, screen.reveal);
      await scanBothThemes(page, `${screen.name} (reveal open)`);
      await page.keyboard.press('Escape');

      await page.setViewportSize(REFLOW);
      expect(
        await horizontalProblems(page),
        `horizontal overflow at 320 px on ${screen.name}`,
      ).toEqual([]);
      await scanBothThemes(page, `${screen.name} at 320 px`);
      await revealChip(page, screen.reveal);
      expect(await horizontalProblems(page), `reveal overflow at 320 px on ${screen.name}`).toEqual(
        [],
      );
      await scanBothThemes(page, `${screen.name} at 320 px (reveal open)`);
    });

    test.describe(`${screen.name} at 200 % zoom with text spacing`, () => {
      test.use({ viewport: ZOOM_200, deviceScaleFactor: 2 });
      test('nothing is lost', async ({ page }) => {
        test.setTimeout(180_000);
        await open(page, screen.path);
        expect(await horizontalProblems(page), 'horizontal overflow at 200 %').toEqual([]);
        await scanBothThemes(page, `${screen.name} at 200 %`);
        const before = new Set(await clippedTextElements(page));
        await page.addStyleTag({ content: TEXT_SPACING });
        await page.waitForTimeout(100);
        const newlyClipped = (await clippedTextElements(page)).filter((e) => !before.has(e));
        expect(newlyClipped, '1.4.12: text spacing clips text').toEqual([]);
      });
    });

    test.describe(`${screen.name} with reduced motion`, () => {
      test.use({ contextOptions: { reducedMotion: 'reduce' } });
      test('nothing animates, the reveal included', async ({ page }) => {
        test.setTimeout(120_000);
        await open(page, screen.path);
        await revealChip(page, screen.reveal);
        expect(await motionOffenders(page)).toEqual([]);
      });
    });
  }

  test('the keyboard journey on /inbox: the chip is reachable and revealable, Looks right and Change by keys', async ({
    page,
  }) => {
    const { mocks } = await open(page, '/inbox');
    const row = reviewRow(page, AUTO_PLAID.name);
    const chip = chipOf(row);

    // Tab order inside the row: chip, Looks right, Change.
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('provenance-line')).toHaveText(PLAID_LINE);
    await page.keyboard.press('Escape');
    await expect(chip).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: /^Looks right/u })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: /^Change the category/u })).toBeFocused();

    // Looks right by keyboard: the row leaves, focus lands on the next row's Looks right.
    await row.getByRole('button', { name: /^Looks right/u }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => mocks.api.lastPatchBody).toEqual({ categoryId: CATEGORY_COFFEE });
    await expect(reviewRow(page, AUTO_PLAID.name)).toHaveCount(0);
    await expect(
      reviewRow(page, AUTO_LEARNED.name).getByRole('button', { name: /^Looks right/u }),
    ).toBeFocused();

    // The switch is a real switch: Space toggles it.
    const toggle = page.getByRole('switch', { name: 'Review automatic placements' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => mocks.api.inboxPreferences.puts).toEqual([{ showAutoReview: false }]);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test('WP 11.2b evidence: a list with chips, and the Inbox’s new section, light and dark, 1280 and 390', async ({
  page,
  evidenceDir,
}) => {
  test.setTimeout(180_000);
  const dir = screenshotDir(evidenceDir);
  const mocks = await installSweepMocks(page);
  seedAutoCategorised(mocks.api);
  await installAutoCategoryMocks(page);
  for (const [width, height] of [
    [1280, 900],
    [390, 1400],
  ] as const) {
    await page.setViewportSize({ width, height });

    await visit(page, '/transactions');
    await hideDevtools(page);
    const grid = page.getByRole('grid', { name: 'Transactions' });
    await expect(chipOf(gridRow(page, AUTO_CLASSIFIER.name))).toHaveText('Classifier 92 %');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await grid.screenshot({
        path: `${dir}wp11.2b-transactions-chips-${theme}-${String(width)}.png`,
        animations: 'disabled',
      });
    }

    await visit(page, '/inbox');
    await hideDevtools(page);
    const section = page.getByTestId('auto-review-section');
    await expect(page.getByTestId('auto-review-row')).toHaveCount(3);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await section.screenshot({
        path: `${dir}wp11.2b-inbox-auto-review-${theme}-${String(width)}.png`,
        animations: 'disabled',
      });
    }
  }
});
