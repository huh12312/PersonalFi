// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installPlanMocks } from './support/mock-plan.ts';

/**
 * WP 4.10's five named exit tests, verbatim from
 * `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10", plus axe clean on both
 * themes and the evidence screenshots. Against `support/mock-plan.ts` (this
 * work package's own mock module — `mock-api.ts` and
 * `app-walkthrough.spec.ts` are off-limits per the dispatch).
 */

const SCREENSHOT_DIR = fileURLToPath(
  new URL('../../../docs/evidence/phase-4/screenshots/', import.meta.url),
);

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}wp4.10-${name}.png`, fullPage: true });
}

async function loginAndReachPlan(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Plan' })
    .click();
  await expect(page).toHaveURL(/\/plan/);
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
}

/** `src/lib/theme.ts`'s own two effects: the stored preference and `data-theme` on `<html>` — the same helper `investments.spec.ts`/`networth.spec.ts` use. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function fillGoal(
  page: Page,
  target: string,
  date: string,
  maxMonthly: string,
): Promise<void> {
  const targetInput = page.getByLabel('Target amount');
  await targetInput.fill(target);
  await page.getByLabel('By date').fill(date);
  const maxMonthlyInput = page.getByLabel('Max extra monthly saving to consider');
  await maxMonthlyInput.fill(maxMonthly);
  await page.getByRole('button', { name: 'Set goal' }).click();
}

test.describe('plan screen (WP 4.10)', () => {
  test('the median band is labelled "median" in words and not only by position', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    // Both the on-chart label and the legend swatch say "median" in words.
    const medianLabels = page.getByText('median', { exact: true });
    await expect(medianLabels.first()).toBeVisible();
    expect(await medianLabels.count()).toBeGreaterThanOrEqual(2);

    await shoot(page, 'fan-chart-median');
  });

  test('clicking the dotted gap line renders a required monthly saving, and an unreachable gap names its constraint instead', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    // A reachable goal: $1,000,000 by 2046, a $2,000/mo ceiling.
    await fillGoal(page, '1000000', '2046-01-01', '2000');
    const gap = page.getByTestId('fan-chart-gap-line');
    await expect(gap).toBeVisible();
    await gap.click();

    const result = page.getByTestId('required-savings-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Save an additional');
    await expect(result).not.toContainText('unreachable');
    await shoot(page, 'required-savings-required');

    // Now an unreachable goal: $10,000,000 by next year, same ceiling.
    await fillGoal(page, '10000000', '2027-01-01', '2000');
    await page.getByTestId('fan-chart-gap-line').click();

    const unreachable = page.getByTestId('required-savings-unreachable');
    await expect(unreachable).toBeVisible();
    await expect(unreachable).toContainText('unreachable');
    await expect(unreachable).toContainText('ceiling falls short');
    // Never a number that implies a solved monthly figure — the literal
    // "required" phrasing, and (sabotage-resistant to a rewording) no real
    // `Money` component render at all inside the unreachable block
    // (`Money.tsx` marks every one with `.money-sensitive`; the
    // constraint's own server-authored `detail` prose, which legitimately
    // quotes the ceiling in words, is plain text and carries no such class).
    await expect(page.getByText('Save an additional')).not.toBeVisible();
    expect(await unreachable.locator('.money-sensitive').count()).toBe(0);
    await shoot(page, 'required-savings-unreachable');
  });

  test('a life event can be moved with the keyboard alone', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    const slider = page.getByRole('slider', { name: 'Signing bonus date' });
    await expect(slider).toBeVisible();
    const before = await slider.getAttribute('aria-valuetext');

    await slider.focus();
    const patchResponse = page.waitForResponse(
      (response) =>
        /\/api\/plan\/life-events\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'PATCH',
    );
    // A real browser translates repeated ArrowRight presses on a focused
    // native `<input type="range">` into value changes with no pointer
    // event anywhere in this test — the WCAG 2.5.7 property under test.
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await slider.blur();
    await patchResponse;

    const after = await slider.getAttribute('aria-valuetext');
    expect(after).not.toBe(before);
    await shoot(page, 'life-event-keyboard-move');
  });

  test('every assumption shows its source and its as-of date without a click', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    // No click anywhere before these assertions — visible on first paint.
    await expect(page.getByText(/Source: 07 Appendix A §5\.5/)).toBeVisible();
    await expect(page.getByText(/As of 2026-01-01/)).toBeVisible();
    await expect(page.getByText(/Source: SSA 2026 COLA notice/)).toBeVisible();
    await expect(page.getByText(/As of 2025-10-15/)).toBeVisible();
    // No collapsed disclosure anywhere *inside the assumptions panel itself*
    // — scoped there rather than to the whole page because `FanChart`'s own
    // "View as table" toggle is a real `aria-expanded="false"` disclosure
    // for the chart's data table, an unrelated feature this assertion must
    // not flag.
    const panel = page.getByTestId('assumptions-panel');
    expect(await panel.locator('details').count()).toBe(0);
    expect(await panel.getByRole('button', { expanded: false }).count()).toBe(0);

    await shoot(page, 'assumptions-panel');
  });

  test('two scenarios render side by side with the success-probability delta', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    await page.getByLabel('Scenario A').selectOption('scenario-baseline');
    await page.getByLabel('Scenario B').selectOption('scenario-fork-retire-early');

    const compareA = page.getByTestId('compare-a');
    const compareB = page.getByTestId('compare-b');
    await expect(compareA).toContainText('Baseline');
    await expect(compareA).toContainText('82%');
    await expect(compareB).toContainText('Retire at 62');
    await expect(compareB).toContainText('74%');

    const delta = page.getByTestId('compare-delta');
    await expect(delta).toContainText('Δ success probability');
    await expect(delta).toContainText('36 months earlier');

    await shoot(page, 'scenario-compare');
  });

  test('axe reports no violations on the plan screen, in light and in dark', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);
    // Set a goal and choose both compare scenarios first, so the axe pass
    // covers the gap-line button, the required-savings panel and the
    // scenario-compare grid, not just the screen's resting state.
    await fillGoal(page, '1000000', '2046-01-01', '2000');
    await page.getByTestId('fan-chart-gap-line').click();
    await expect(page.getByTestId('required-savings-result')).toBeVisible();
    await page.getByLabel('Scenario A').selectOption('scenario-baseline');
    await page.getByLabel('Scenario B').selectOption('scenario-fork-retire-early');
    await expect(page.getByTestId('compare-delta')).toBeVisible();

    await setTheme(page, 'light');
    await injectAxe(page);
    await expectNoAxeViolations(page, 'plan screen (light)');
    await shoot(page, 'plan-light');

    await setTheme(page, 'dark');
    await injectAxe(page);
    await expectNoAxeViolations(page, 'plan screen (dark)');
    await shoot(page, 'plan-dark');
  });
});
