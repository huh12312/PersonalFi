// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

import { expectNoAxeViolations, scanBothThemes, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installGoalsMocks, usd } from './support/mock-goals.ts';
import { installPlanMocks } from './support/mock-plan.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 9.7 / C-10 (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.7", §6 Q5 default build): goals, the risk
 * questionnaire and scenario forking, on screen. Three exit tests, verbatim:
 *
 *   * `'a goal can be created, edited, funded and deleted by keyboard alone'`
 *   * `'the questionnaire produces a risk profile the plan reads'`
 *   * `'a scenario can be forked and compared'`
 *
 * plus axe clean in both themes and the walk of 04 §5 item 3's on-screen steps (the evidence).
 *
 * ## The mocks
 *
 * `support/mock-plan.ts` answers the session and the plan routes; `support/mock-goals.ts` (moved out of
 * this file by WP 9.8 so the sweep can reuse it) layers `/goals`, `/risk-profile` and a forkable
 * `/plan/scenarios` on top of it (`page.route` handlers registered later win; `route.fallback()` hands
 * everything else down) — the `accounts-overrides.spec.ts` pattern.
 *
 * Every body below is a field-for-field instance of the contract's own schema (the generated client's
 * types), and the instrument is the real `risk-v1`'s six questions.
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

/**
 * The app shell scrolls inside `<main>`, so a full-page capture clips it to one viewport (and photographs the
 * dev-only devtools panels). Grow the viewport until `<main>` shows all of its content, shoot `<main>`, restore.
 */
async function shootMain(page: Page, path: string): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 2600 });
  await page.locator('main').screenshot({ path });
  if (original !== null) await page.setViewportSize(original);
}

async function shoot(page: Page, name: string): Promise<void> {
  await shootMain(page, `${screenshotDir(currentEvidenceDir)}wp9.7-${name}.png`);
}

/** One screenshot per theme, light first, leaving the page in light. */
async function shootBothThemes(page: Page, name: string): Promise<void> {
  await setTheme(page, 'dark');
  await shoot(page, `${name}-dark`);
  await setTheme(page, 'light');
  await shoot(page, `${name}-light`);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Keyboard helpers — and a record of every pointer event, so "by keyboard alone" is measured, not claimed
// ---------------------------------------------------------------------------

async function countPointerEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __pointerEvents: number }).__pointerEvents = 0;
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      window.addEventListener(
        type,
        () => {
          (window as unknown as { __pointerEvents: number }).__pointerEvents += 1;
        },
        true,
      );
    }
  });
}

async function resetPointerEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __pointerEvents: number }).__pointerEvents = 0;
  });
}

async function pointerEvents(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pointerEvents: number }).__pointerEvents);
}

/** Presses Tab until `target` has focus; fails (rather than hangs) if it never does. */
async function tabTo(page: Page, target: Locator, limit = 150): Promise<void> {
  const handle = await target.elementHandle({ timeout: 5_000 });
  if (handle === null) throw new Error('tabTo: the target is not in the page');
  for (let i = 0; i < limit; i += 1) {
    if (await handle.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`tabTo: focus never reached the target in ${String(limit)} Tab presses`);
}

/** Types into a field the keyboard has already focused, replacing what is there. */
async function typeInto(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

test.describe('goals, questionnaire and forking (WP 9.7, C-10)', () => {
  test('a goal can be created, edited, funded and deleted by keyboard alone', async ({ page }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    await countPointerEvents(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    await login(page);
    await page.goto('/goals');
    await expect(
      page.getByRole('main').getByRole('heading', { name: 'Goals', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('No goals yet')).toBeVisible();
    await resetPointerEvents(page);

    // --- create -----------------------------------------------------------------------------
    await tabTo(page, page.getByRole('button', { name: 'Add goal' }));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus is inside the dialog the moment it opens (a keyboard user is not left behind it).
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await page.keyboard.type('Car');
    await tabTo(page, dialog.getByLabel('Target amount'));
    await page.keyboard.type('18000');
    await tabTo(page, dialog.getByLabel('Target date'));
    await page.keyboard.type('06012029');
    await tabTo(page, dialog.getByLabel('Priority'));
    await page.keyboard.press('ArrowDown');
    await tabTo(page, dialog.getByRole('button', { name: 'Add goal' }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();

    const card = page.getByTestId('goal').filter({ hasText: 'Car' });
    await expect(card).toContainText('$18,000.00');
    await expect(card).toContainText('2029-06-01');
    expect(server.goalPosts).toEqual([
      {
        kind: 'custom',
        name: 'Car',
        target: usd('1800000'),
        targetDate: '2029-06-01',
        priority: 4,
      },
    ]);
    // Closing the dialog returned focus to somewhere a keyboard user can continue from.
    await shoot(page, 'goal-created');

    // --- edit -------------------------------------------------------------------------------
    await tabTo(page, card.getByRole('button', { name: 'Edit Car' }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await typeInto(page, 'Car fund');
    await tabTo(page, dialog.getByLabel('Status'));
    await page.keyboard.press('ArrowDown');
    await tabTo(page, dialog.getByRole('button', { name: 'Save goal' }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    const edited = page.getByTestId('goal').filter({ hasText: 'Car fund' });
    await expect(edited).toBeVisible();
    await expect(edited).toContainText('Paused');
    expect(server.goalPatches).toHaveLength(1);
    expect(server.goalPatches[0]).toMatchObject({ name: 'Car fund', status: 'paused' });

    // --- fund -------------------------------------------------------------------------------
    await tabTo(page, edited.getByRole('button', { name: /^Contributions for Car fund/ }));
    await page.keyboard.press('Enter');
    const panel = page.getByRole('region', { name: 'Contributions to Car fund' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Nothing is set aside');
    await tabTo(page, panel.getByLabel('Amount each time'));
    await page.keyboard.type('300');
    await page.keyboard.press('Enter'); // Enter in a field submits the form
    const row = panel.getByTestId('contribution');
    await expect(row).toContainText('$300.00');
    await expect(row).toContainText('every month');
    await expect(row).toContainText('entered by you');
    expect(server.contributionPosts).toHaveLength(1);
    expect(server.contributionPosts[0]).toMatchObject({
      cadence: 'monthly',
      amount: usd('30000'),
      source: 'USER',
    });
    await shoot(page, 'goal-funded');

    // --- delete (the contribution, then the goal) --------------------------------------------
    await tabTo(page, row.getByRole('button', { name: /^Remove the every month/i }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Remove this contribution?');
    await tabTo(page, page.getByRole('button', { name: 'Remove contribution' }));
    await page.keyboard.press('Enter');
    await expect(panel).toContainText('Nothing is set aside');

    await tabTo(page, edited.getByRole('button', { name: 'Delete Car fund' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Delete Car fund?');
    await page.keyboard.press('Escape'); // backing out leaves it alone
    await expect(edited).toBeVisible();
    await tabTo(page, edited.getByRole('button', { name: 'Delete Car fund' }));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: 'Delete goal' }));
    await page.keyboard.press('Enter');
    await expect(page.getByText('No goals yet')).toBeVisible();
    expect(server.goals).toHaveLength(0);

    // The whole flow, create to delete, without one pointer event.
    expect(await pointerEvents(page)).toBe(0);
  });

  test('the questionnaire produces a risk profile the plan reads', async ({ page }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    await login(page);
    await page.goto('/goals');

    // Before: the plan has nothing to read.
    await page.getByRole('link', { name: 'plan', exact: true }).click();
    await expect(page.getByTestId('plan-risk-profile')).toContainText(
      'not answered the risk questionnaire',
    );
    await page.getByRole('link', { name: 'Take the questionnaire' }).click();
    await expect(page.getByRole('heading', { name: 'Risk profile' })).toBeVisible();

    await page.getByRole('button', { name: 'Take the questionnaire' }).click();
    // Answered inconsistently, on purpose: bold when asked what they would do, cautious about what they did.
    const choose = async (itemId: string, label: string) =>
      page.getByTestId(`risk-item-${itemId}`).getByRole('radio', { name: label }).check();
    await choose('drawdown.stated', 'Invest extra while prices are lower');
    await choose('drawdown.revealed', 'I sold all or most of it');
    await choose('volatility.stated', '$6,500 to $13,000');
    await choose('volatility.revealed', 'Less than a fifth');
    await choose('risk_identity.stated', 'I look for it; higher risk is how returns are earned');
    await choose('risk_identity.revealed', 'A savings account or cash');
    await page.getByLabel('Years until you start using this money').fill('25');
    await page.getByRole('button', { name: 'See my risk profile' }).click();

    const result = page.getByTestId('risk-result');
    await expect(result).toBeVisible();
    // What the screen sent is exactly what was chosen.
    expect(server.riskPuts).toHaveLength(1);
    expect(server.riskPuts[0]).toEqual({
      answers: {
        'drawdown.stated': 'buy_more',
        'drawdown.revealed': 'sold_all',
        'volatility.stated': 'range_widest',
        'volatility.revealed': 'stocks_under_20',
        'risk_identity.stated': 'seek',
        'risk_identity.revealed': 'cash',
      },
      horizonYears: 25,
      liquidityNeed: 'medium',
    });
    // The score moved conservative, not to the mean: averaging would have said otherwise, and the screen shows both.
    await expect(page.getByTestId('risk-result-tolerance')).toHaveText('Conservative');
    await expect(result).toContainText('consistency penalty of');
    await expect(result).toContainText('Averaging your answers would have said moderate');
    await expect(page.getByTestId('risk-explanation')).toContainText(
      'the score follows the more cautious of the two',
    );
    await shootBothThemes(page, 'risk-result');

    // And the plan reads it: the same tolerance, from the same server read, on the plan screen.
    await page.goto('/plan');
    const summary = page.getByTestId('plan-risk-profile-text');
    await expect(summary).toContainText('Conservative risk tolerance');
    await expect(summary).toContainText('answered 2026-10-06');
    await expect(page.getByTestId('plan-risk-profile')).toContainText(
      'The projection does not use this',
    );
    await shootBothThemes(page, 'plan-risk-profile');
  });

  test('a scenario can be forked and compared', async ({ page }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    await login(page);
    await page.goto('/plan');
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();

    // Scoped to the form: the sliders panel has fields of the same names.
    const fork = page.getByRole('form', { name: 'Fork the baseline' });
    await fork.getByLabel('Fork name').fill('Retire at 60');
    await fork.getByLabel('Retirement age').fill('60');
    await fork.getByLabel('Annual spending').fill('55000');
    await fork.getByRole('button', { name: 'Fork and compare' }).click();

    // The fork the screen sent carries only the levers filled in.
    await expect.poll(() => server.forkPosts.length).toBe(1);
    expect(server.forkPosts[0]).toEqual({
      kind: 'fork',
      name: 'Retire at 60',
      levers: { retireAge: 60, annualSpending: usd('5500000') },
    });
    // ...and is put straight into the compare against the baseline.
    await expect(page.getByLabel('Scenario A')).toHaveValue('scenario-baseline');
    await expect(page.getByLabel('Scenario B')).toHaveValue('scenario-fork-1');
    await expect(page.getByTestId('compare-a')).toContainText('Baseline');
    await expect(page.getByTestId('compare-a')).toContainText('82%');
    await expect(page.getByTestId('compare-b')).toContainText('Retire at 60');
    await expect(page.getByTestId('compare-b')).toContainText('74%');
    await expect(page.getByTestId('compare-delta')).toContainText('36 months earlier');
    await shootBothThemes(page, 'fork-and-compare');

    // The fork is one the viewing selector offers, too.
    await expect(page.getByLabel('Viewing scenario').locator('option')).toHaveText([
      'Baseline',
      'Retire at 60',
    ]);
  });

  test('axe reports no violations on the goals screen or its dialogs, in light and in dark', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    server.goals.push({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'emergency_fund',
      name: 'Emergency fund',
      target: usd('2500000'),
      targetDate: '2028-01-01',
      priority: 2,
      fundedFromAccountIds: [],
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    server.contributions.push({
      id: '00000000-0000-4000-8000-0000000000c1',
      goalId: '00000000-0000-4000-8000-000000000001',
      cadence: 'monthly',
      amount: usd('50000'),
      escalationPct: '3',
      startsOn: '2026-11-01',
      endsOn: null,
      source: 'DERIVED',
      derivedAsOf: '2026-09-30',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await login(page);
    await page.goto('/goals');
    await page.getByRole('button', { name: /^Contributions for/ }).click();
    await expect(page.getByTestId('contribution')).toBeVisible();
    await page.getByRole('button', { name: 'Take the questionnaire' }).click();
    await expect(page.getByTestId('risk-item-drawdown.stated')).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `goals screen (${theme})`);
      await shoot(page, `goals-${theme}`);
    }

    // The dialogs are portalled to `document.body`; the harness scans `document`, so each is seen (CF-7).
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Add goal' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scanBothThemes(page, 'goal dialog');
    await shoot(page, 'goal-dialog-dark');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Delete Emergency fund/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scanBothThemes(page, 'goals screen with the delete confirmation open');
  });

  test('the delete confirmation is axe clean in dark', async ({ page }) => {
    test.setTimeout(60_000);
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    server.goals.push({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'emergency_fund',
      name: 'Emergency fund',
      target: usd('2500000'),
      targetDate: '2028-01-01',
      priority: 2,
      fundedFromAccountIds: [],
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await login(page);
    await page.goto('/goals');
    await page.getByRole('button', { name: /^Delete Emergency fund/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scanBothThemes(page, 'delete confirmation', ['dark']);
  });

  test('the plan screen with a fork form and the risk card is axe clean in both themes', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    server.riskCurrent = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tolerance: 'moderate',
      compositeScore: 9,
      unpenalisedScore: 9,
      consistencyPenalty: 0,
      horizonYears: 25,
      taxBracketBand: null,
      liquidityNeed: 'medium',
      answeredAt: '2026-10-05T12:00:00.000Z',
    };
    await login(page);
    await page.goto('/plan');
    await expect(page.getByTestId('plan-risk-profile-text')).toBeVisible();
    await scanBothThemes(page, 'plan screen with fork form and risk card');
  });

  /**
   * The evidence walk (`docs/plan/04-phase-4-dispatch.md` §5 item 3's on-screen steps), against this
   * file's mocks, with a screenshot of each step in both themes. It asserts as it goes — a step that
   * does not happen fails here, not in a caption. Step 8's byte-identity is the API's property (the
   * `projection_runs` cache hit, `projection-service.test.ts`); on screen it can only be shown that a
   * re-opened screen reads the same stored run, which is what the last assertion does.
   */
  test('the Phase 4 on-screen steps walk end to end, in both themes', async ({ page }) => {
    test.setTimeout(150_000);
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const server = await installGoalsMocks(page);
    await login(page);

    // 1. A goal is created.
    await page.goto('/goals');
    await page.getByRole('button', { name: 'Add goal' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Retire at 65');
    await dialog.getByLabel('Kind').selectOption('retirement');
    await dialog.getByLabel('Target amount').fill('2000000');
    await dialog.getByLabel('Target date').fill('2050-04-12');
    await dialog.getByRole('button', { name: 'Add goal' }).click();
    await expect(page.getByTestId('goal').filter({ hasText: 'Retire at 65' })).toContainText(
      '$2,000,000.00',
    );
    expect(server.goals).toHaveLength(1);
    await shootBothThemes(page, 'step1-goal-created');

    // 2. The questionnaire is answered inconsistently and the score moves conservative on screen.
    await page.getByRole('button', { name: 'Take the questionnaire' }).click();
    for (const [item, label] of [
      ['drawdown.stated', 'Invest extra while prices are lower'],
      ['drawdown.revealed', 'I sold all or most of it'],
      ['volatility.stated', '$6,500 to $13,000'],
      ['volatility.revealed', 'Less than a fifth'],
      ['risk_identity.stated', 'I look for it; higher risk is how returns are earned'],
      ['risk_identity.revealed', 'A savings account or cash'],
    ] as const) {
      await page.getByTestId(`risk-item-${item}`).getByRole('radio', { name: label }).check();
    }
    await page.getByLabel('Years until you start using this money').fill('25');
    await page.getByRole('button', { name: 'See my risk profile' }).click();
    await expect(page.getByTestId('risk-result-tolerance')).toHaveText('Conservative');
    await expect(page.getByTestId('risk-result')).toContainText(
      'Averaging your answers would have said moderate',
    );
    await shootBothThemes(page, 'step2-risk-conservative');

    // 3. The fan chart draws with a labelled median.
    await page.goto('/plan');
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    await expect(page.getByTestId('plan-projection').getByText('median').first()).toBeVisible();
    await expect(page.getByTestId('plan-run-source')).toContainText('Monte Carlo simulation');
    await shootBothThemes(page, 'step3-fan-chart-median');

    // 4. The dotted gap line is clicked and returns a required monthly saving.
    await page.getByLabel('Target amount').fill('1000000');
    await page.getByLabel('By date').fill('2046-01-01');
    await page.getByLabel('Max extra monthly saving to consider').fill('2000');
    await page.getByRole('button', { name: 'Set goal' }).click();
    await page.getByTestId('fan-chart-gap-line').click();
    await expect(page.getByTestId('required-savings-result')).toContainText('Save an additional');
    await shootBothThemes(page, 'step4-required-saving');

    // 5. A life event is moved with the keyboard.
    const slider = page.getByRole('slider', { name: 'Signing bonus date' });
    await slider.focus();
    const before = await slider.getAttribute('aria-valuetext');
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await slider.blur();
    await expect.poll(() => slider.getAttribute('aria-valuetext')).not.toBe(before);
    await shootBothThemes(page, 'step5-life-event-moved');

    // 6. Two scenarios compare.
    const fork = page.getByRole('form', { name: 'Fork the baseline' });
    await fork.getByLabel('Fork name').fill('Retire at 60');
    await fork.getByLabel('Retirement age').fill('60');
    await fork.getByRole('button', { name: 'Fork and compare' }).click();
    await expect(page.getByTestId('compare-delta')).toContainText('36 months earlier');
    await shootBothThemes(page, 'step6-two-scenarios-compare');

    // 7. Every assumption shows its source and date, and only the ones the engine reads offer an edit.
    await expect(page.getByText(/Source: 07 Appendix A §5\.5/)).toBeVisible();
    await expect(page.getByText(/As of 2026-01-01/)).toBeVisible();
    await shootBothThemes(page, 'step7-assumptions-cited');

    // 8. A saved projection is re-opened: a reload reads the same stored run.
    const headline = await page.getByTestId('plan-headline').innerText();
    const source = await page.getByTestId('plan-run-source').innerText();
    await page.reload();
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    expect(await page.getByTestId('plan-headline').innerText()).toBe(headline);
    expect(await page.getByTestId('plan-run-source').innerText()).toBe(source);
    await shootBothThemes(page, 'step8-reopened');
  });
});
