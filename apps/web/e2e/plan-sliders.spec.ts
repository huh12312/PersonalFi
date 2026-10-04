// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { dragFromTo } from './support/drag.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installPlanSlidersMocks } from './support/mock-plan-sliders.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 4.11's three named exit tests, verbatim from
 * `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.11", plus axe clean on both
 * themes. Against `support/mock-plan-sliders.ts` (this work package's own
 * mock module — `mock-api.ts`, `mock-plan.ts` and `app-walkthrough.spec.ts`
 * are off-limits per the dispatch). Not registered in
 * `apps/web/playwright.config.ts`'s `chromium` `testMatch` — that entry is
 * the orchestrator's (this WP's RULES say so explicitly) — so this file runs
 * by explicit path: `pnpm exec playwright test e2e/plan-sliders.spec.ts
 * --project chromium`.
 *
 * WP 5.14 / C-14's G4-3: same hole as `plan.spec.ts` (its header has the
 * reproduced-red detail) and the same fix — `evidenceDir`, gitignored by
 * default, `market-data.spec.ts`'s mechanism.
 */
interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

let currentEvidenceDir: string | undefined;
test.beforeEach(({ evidenceDir }) => {
  currentEvidenceDir = evidenceDir;
});

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(currentEvidenceDir)}wp4.11-${name}.png`,
    fullPage: true,
  });
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
  await expect(page.getByTestId('goal-sliders')).toBeVisible();
}

/** `src/lib/theme.ts`'s own two effects — the same helper `plan.spec.ts`/`investments.spec.ts` use. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * A real pointer drag on the "Monthly savings" thumb, 160px right of its
 * start — not a single teleporting jump, so Base UI's own drag handling
 * (`onValueChange` while dragging vs `onValueCommitted` on release) fires
 * the way an actual user's drag would. Does not call `mouse.up()` — the
 * caller decides when to release, since test 1 and test 2 assert different
 * things about the moment in between.
 *
 * The panel sits below the fold at the default viewport size, which is
 * exactly the shape `support/drag.ts`'s `dragFromTo` exists to get right —
 * its header has the full "silently dropped, no error" story (05 §2's
 * carry, wp4.11 §7 item 5).
 */
async function beginDraggingMonthlySavings(page: Page): Promise<void> {
  const control = page.getByTestId('slider-monthly-savings-control');
  const thumb = page.getByTestId('slider-monthly-savings-thumb');
  await dragFromTo(page, thumb, control, { dx: 160 });
}

test.describe('plan sliders — the client projection worker (WP 4.11)', () => {
  test('dragging a slider reshapes the bands without a network request', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanSlidersMocks(page);
    await loginAndReachPlan(page);

    const median = page.getByTestId('slider-preview-median');
    await expect(median).toBeVisible();
    const before = (await median.textContent()) ?? '';
    expect(before).not.toBe('');

    // Registered only now: the mount's own automatic 250-path preview (worker-local, no network
    // either) has already resolved above, so this counts exactly the drag's own network activity.
    let apiRequestsDuringDrag = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequestsDuringDrag += 1;
    });

    await beginDraggingMonthlySavings(page);
    // Still mid-drag (no mouse.up() yet) — the bands reshape from the 250-path preview alone.
    await expect(median).not.toHaveText(before);
    expect(apiRequestsDuringDrag).toBe(0);

    await page.mouse.up();
    await shoot(page, 'dragging-reshapes-bands');
  });

  test('releasing the slider refines to full fidelity and the headline stops saying refining', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanSlidersMocks(page);
    await loginAndReachPlan(page);

    const status = page.getByTestId('slider-status');
    await expect(status).toContainText('250');

    await beginDraggingMonthlySavings(page);
    await page.mouse.up();

    // The commit's 5,000-path run is asynchronous — "Refining…" is the transient state, and the
    // headline must stop saying it once the heavier run resolves.
    await expect(status).toContainText('5,000');
    await expect(status).not.toContainText('Refining');
    await shoot(page, 'releasing-refines');
  });

  test('with Worker unavailable the server fallback renders and says so', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    // Simulates a browser with no `Worker` global — installed before any page script runs, so
    // `createProjectionClient`'s own `typeof Worker === 'undefined'` check sees it.
    await page.addInitScript(() => {
      // @ts-expect-error -- test-only override, simulating a browser with no Worker global
      window.Worker = undefined;
    });
    await installPlanSlidersMocks(page);
    await loginAndReachPlan(page);

    // The visible reason ("says so") is the status line; `slider-worker-fallback` is the
    // separate paragraph rendering the *server's* fallback data once it has arrived (both are
    // named in the exit test's own wording: a rendered fallback, and a stated reason).
    const status = page.getByTestId('slider-status');
    await expect(status).toContainText('unavailable');
    const fallback = page.getByTestId('slider-worker-fallback');
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText('Your saved plan');
    await shoot(page, 'worker-unavailable');

    // A lever change now debounces a real re-fetch of the server's projection — "the server
    // fallback renders and says so" names both halves: a visible reason, and an actual request.
    const projectionResponse = page.waitForResponse(
      (response) =>
        /\/api\/plan\/scenarios\/[^/]+\/projections$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'POST',
    );
    // `getByLabel` alone is ambiguous here: the number input's own `<Label htmlFor>` and the
    // slider thumb's `aria-label` are the same text ("Monthly savings") by design (`SliderField.tsx`
    // — one editable value, two controls for it, 05 §5.7's own "an editable number input beside
    // each" slider). The number input is the reliable, non-pointer way to change it in a test.
    await page.getByRole('spinbutton', { name: 'Monthly savings' }).fill('4000');
    await projectionResponse;
  });

  test('axe reports no violations on the goal sliders panel, in light and in dark', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanSlidersMocks(page);
    await loginAndReachPlan(page);

    await expect(page.getByTestId('slider-preview-median')).toBeVisible();

    await setTheme(page, 'light');
    await injectAxe(page);
    await expectNoAxeViolations(page, 'plan sliders (light)');
    await shoot(page, 'sliders-light');

    await setTheme(page, 'dark');
    await injectAxe(page);
    await expectNoAxeViolations(page, 'plan sliders (dark)');
    await shoot(page, 'sliders-dark');
  });
});
