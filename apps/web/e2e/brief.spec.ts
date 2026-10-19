// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import {
  briefItem,
  buildBrief,
  COMPUTED_EFFECT,
  HEALTH_SCORE_RESULT,
  installBriefMocks,
} from './support/mock-brief.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools } from './support/sweep.ts';

/**
 * WP 5.11's exit tests for the Brief screen (and 9.6's additions). The mock is `support/mock-brief.ts`
 * (moved out of this file by WP 9.8 so the sweep can layer it): one `page.route('**\/*')` handler,
 * in-memory state, no live `apps/api`, no database.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

async function shoot(page: Page, evidenceDir: string | undefined, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(evidenceDir)}wp5.11-${name}.png`,
    fullPage: true,
  });
}
async function loginAndReachBrief(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Brief' })
    .click();
  await expect(page).toHaveURL(/\/brief/);
  await expect(page.getByRole('heading', { name: "This week's Brief" })).toBeVisible();
}

test.describe('Brief screen (WP 5.11)', () => {
  test('the Brief shows at most five actions, each with a dollar figure and a retirement effect or a stated reason it has none', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const items = Array.from({ length: 7 }, (_, index) =>
      briefItem({
        id: String(index),
        position: index,
        title: `Ranked action ${String(index)}`,
        annualizedImpact: { minor: String(100_00 - index), currency: 'USD' },
        retirementEffect:
          index === 6
            ? { kind: 'not_computable', reason: 'no baseline plan to project against' }
            : COMPUTED_EFFECT,
      }),
    );
    await installBriefMocks(page, { brief: buildBrief({ items }) });
    await loginAndReachBrief(page);

    const cards = page.getByTestId('brief-item-card');
    await expect(cards).toHaveCount(5);

    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      await expect(card.getByTestId('brief-item-impact')).toContainText('$');
      const effect = card.getByTestId('retirement-effect');
      await expect(effect).toBeVisible();
      const text = (await effect.textContent()) ?? '';
      expect(/Retire \d+ years? earlier|Not computable:/.test(text)).toBe(true);
    }

    await shoot(page, evidenceDir, 'five-cards');
  });

  test('the AI-assisted badge appears from the real response shape', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    // The api's actual shape (WP 9.6 item 3): status, the badge flag, whether
    // this deployment shows narration text, and the text itself.
    const narrated = briefItem({
      id: '1',
      narration: {
        status: 'narrated',
        aiAssisted: true,
        textShown: true,
        summaryMd: 'Fee hunter found $720 you could get back this year.',
      },
    });
    await installBriefMocks(page, { brief: buildBrief({ items: [narrated] }) });
    await loginAndReachBrief(page);

    await expect(
      page.getByText('Fee hunter found $720 you could get back this year.'),
    ).toBeVisible();
    await expect(page.getByText('AI-assisted wording')).toBeVisible();
    await expect(page.getByTestId('narration-template-text')).not.toBeVisible();

    await page.getByRole('button', { name: 'See the template wording' }).click();
    const template = page.getByTestId('narration-template-text');
    await expect(template).toBeVisible();
    await expect(template).toContainText(
      'You paid $720 in avoidable fees over the last twelve months.',
    );

    await shoot(page, evidenceDir, 'narration-badge');
  });

  test('WP 10.6: the badge names the provider and model that wrote the wording, in light and in dark', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const narrated = briefItem({
      id: '1',
      narration: {
        status: 'narrated',
        aiAssisted: true,
        textShown: true,
        summaryMd: 'Fee hunter found $720 you could get back this year.',
        narratedBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      },
    });
    const withheld = briefItem({
      id: '2',
      position: 1,
      title: 'Withheld wording',
      narration: {
        status: 'narrated',
        aiAssisted: true,
        textShown: false,
        summaryMd: null,
        narratedBy: { provider: 'ollama', model: 'qwen2.5:7b-instruct-q4_K_M' },
      },
    });
    await installBriefMocks(page, { brief: buildBrief({ items: [narrated, withheld] }) });
    await loginAndReachBrief(page);

    await expect(page.getByText('Narrated by Anthropic claude-sonnet-5-5')).toBeVisible();
    await expect(page.getByTestId('narration-withheld')).toContainText(
      'Narrated by the local model qwen2.5:7b-instruct-q4_K_M',
    );
    await expect(page.getByText('AI-assisted wording', { exact: true })).toHaveCount(0);
    await hideDevtools(page);

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `Brief › narration badge naming its narrator (${theme})`);
      await page.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.6-brief-badge-${theme}.png`,
        fullPage: true,
      });
    }
  });

  test('while the deployment withholds narration text (R-2) the built-in wording stays and the page says so', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const withheld = briefItem({
      id: '1',
      narration: { status: 'narrated', aiAssisted: true, textShown: false, summaryMd: null },
    });
    await installBriefMocks(page, { brief: buildBrief({ items: [withheld] }) });
    await loginAndReachBrief(page);

    await expect(
      page.getByText('You paid $720 in avoidable fees over the last twelve months.'),
    ).toBeVisible();
    await expect(page.getByTestId('narration-withheld')).toContainText(
      'exists and is not shown yet',
    );
    await expect(page.getByRole('button', { name: 'See the template wording' })).toHaveCount(0);
  });

  test('a published item shows the action it was published with, and an older Brief says none was recorded (CF-24)', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const recorded = briefItem({
      id: '1',
      primaryAction: {
        kind: 'open_url',
        label: 'Open the fee-free account page',
        rationaleMd: 'Moves the fees away.',
        url: 'https://example.com/accounts',
      },
    });
    const older = briefItem({ id: '2', position: 1, primaryAction: null });
    await installBriefMocks(page, { brief: buildBrief({ items: [recorded, older] }) });
    await loginAndReachBrief(page);

    const actions = page.getByTestId('brief-item-action');
    await expect(actions).toHaveCount(2);
    await expect(actions.nth(0)).toContainText(
      'Suggested next step: Open the fee-free account page',
    );
    await expect(actions.nth(1)).toContainText('No action recorded');
  });

  test('a week with nothing material says so plainly', async ({ page, evidenceDir }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, { brief: buildBrief({ items: [], nothingMaterial: true }) });
    await loginAndReachBrief(page);

    await expect(page.getByText('Nothing material this week')).toBeVisible();
    await expect(page.getByTestId('brief-item-card')).toHaveCount(0);

    await shoot(page, evidenceDir, 'nothing-material');
  });

  // WP 10.12: the health section is a link to /health (the gauge, the pillars and the history live there); here,
  // the week's stored score and the way there.
  test("the health section names the week's score and links to Financial health", async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, { healthScoreStatus: 200, healthScore: HEALTH_SCORE_RESULT });
    await loginAndReachBrief(page);

    // WP 10.15: the health card is the Brief's overview blocks' last group, its score an `info` block.
    await expect(page.locator('[data-block-id="brief-health-score"]')).toContainText(
      'This week’s score72.5 / 100',
    );
    await expect(page.getByRole('link', { name: 'Open Financial health' })).toHaveAttribute(
      'href',
      '/health',
    );
    await expect(page.getByTestId('health-component-row')).toHaveCount(0);

    await shoot(page, evidenceDir, 'health-score');
  });

  test('a health score not yet computed reads as "not computed yet", not as an error', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, { healthScoreStatus: 404 });
    await loginAndReachBrief(page);

    await expect(page.locator('[data-block-id="brief-health-score"]')).toContainText(
      'Not computed yet',
    );
    await expect(page.getByRole('link', { name: 'Open Financial health' })).toBeVisible();
  });

  test('dismissing asks for one of seven reasons and the code reaches the API', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const mocks = await installBriefMocks(page, {
      brief: buildBrief({ items: [briefItem({ id: '1' })] }),
    });
    await loginAndReachBrief(page);

    await page.getByTestId('brief-item-card').getByRole('button', { name: 'Dismiss' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(7);

    await dialog.getByRole('radio', { name: "True, but I can't act on it" }).click();
    await dialog.getByRole('button', { name: 'Dismiss' }).click();

    await expect(dialog).not.toBeVisible();
    expect(mocks.reviewedBodies).toContainEqual({
      action: 'dismiss',
      reasonCode: 'NOT_ACTIONABLE',
      reason: null,
    });

    await shoot(page, evidenceDir, 'dismiss-reasons');
  });

  test('axe reports no violations on the Brief screen, in light and in dark', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, {
      brief: buildBrief({
        items: [
          // Every state WP 9.6 added to the card, so axe scans each of them in both themes.
          briefItem({
            id: '1',
            narration: {
              status: 'narrated',
              aiAssisted: true,
              textShown: true,
              summaryMd: 'Fee hunter found $720 you could get back this year.',
            },
            primaryAction: {
              kind: 'open_url',
              label: 'Open the fee-free account page',
              rationaleMd: 'Moves the fees away.',
              url: 'https://example.com/accounts',
            },
          }),
          briefItem({
            id: 'withheld',
            position: 1,
            narration: { status: 'narrated', aiAssisted: true, textShown: false, summaryMd: null },
          }),
          briefItem({
            id: 'pending',
            position: 2,
            narration: { status: 'pending', aiAssisted: false, textShown: false, summaryMd: null },
          }),
          briefItem({
            id: 'attn',
            section: 'attention',
            severity: 'urgent',
            title: 'A payment looks like it will be missed',
            annualizedImpact: null,
            oneTimeImpact: null,
            score: null,
            retirementEffect: { kind: 'not_computable', reason: 'no dollar figure' },
          }),
        ],
      }),
      healthScoreStatus: 200,
      healthScore: HEALTH_SCORE_RESULT,
    });
    await loginAndReachBrief(page);

    await setTheme(page, 'light');
    await expectNoAxeViolations(page, 'Brief screen (light)');
    await shoot(page, evidenceDir, 'brief-light');

    await setTheme(page, 'dark');
    await expectNoAxeViolations(page, 'Brief screen (dark)');
    await shoot(page, evidenceDir, 'brief-dark');
  });
});
