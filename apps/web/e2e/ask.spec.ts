// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { setTheme } from './support/axe.ts';
import {
  ASK_ANSWER,
  ASK_IN_FLIGHT_DETAIL,
  ASK_LOCAL_BADGE,
  ASK_LOOKED_AT_LINE,
  ASK_OUT_OF_SCOPE_QUESTION,
  ASK_OUT_OF_SCOPE_WORDS,
  ASK_QUESTION,
  ASK_REFUSED_WORDS,
  ASK_UNAVAILABLE_WORDS,
  type AskMockOptions,
} from './support/mock-ask.ts';
import { installSweepMocks, type SweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 11.5c, Ask PersonalFi (reporting mode): the functional journeys over route mocks only (`support/mock-ask.ts`,
 * layered on the whole-app mocks) - ask, watch the steps, read the answer or the arithmetic; an out-of-scope
 * question and its way to the nearest screen; the unavailable state and its way to Advisor management; the
 * "I looked at" disclosures. No model, no network.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

async function openAsk(page: Page, options: AskMockOptions = {}): Promise<SweepMocks> {
  const mocks = await installSweepMocks(page, { ask: options });
  await visit(page, '/ask');
  await hideDevtools(page);
  await expect(page.getByLabel('Your question')).toBeVisible();
  return mocks;
}

/** Types into the box and sends with Enter. */
async function ask(page: Page, question: string): Promise<void> {
  const box = page.getByLabel('Your question');
  await box.fill(question);
  await box.press('Enter');
}

const SLOW = { timeout: 15_000 } as const;

test.describe('Ask PersonalFi (WP 11.5c)', () => {
  test('the sidebar has Ask after Insights, and the screen carries the disclaimer, the examples and the history', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const mocks = await installSweepMocks(page);
    await visit(page, '/');
    await hideDevtools(page);
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Ask', exact: true })
      .click();
    await expect(page).toHaveURL(/\/ask$/u);
    await expect(page).toHaveTitle('Ask · PersonalFi');
    await expect(page.getByRole('heading', { name: 'Ask PersonalFi', level: 2 })).toBeVisible();
    await expect(page.getByTestId('ask-disclaimer')).toContainText(
      'Not investment, tax, or legal advice.',
    );
    await expect(page.getByTestId('ask-examples').getByRole('button')).toHaveCount(3);
    await expect(page.getByTestId('ask-history-item')).toHaveCount(3);

    // An example fills the box and nothing is sent.
    await page.getByRole('button', { name: 'What did I spend on dining last month?' }).click();
    await expect(page.getByLabel('Your question')).toHaveValue(
      'What did I spend on dining last month?',
    );
    expect(mocks.ask.bodies).toEqual([]);
  });

  test('ask -> pending steps -> shown: the answer, a badge naming provider and model, "AI-assisted wording" and what was looked at', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const mocks = await openAsk(page);
    // Reading the screen asked nothing of a model.
    expect(mocks.ask.calls).toEqual(['GET /api/ask']);

    await ask(page, ASK_QUESTION);
    const live = page.getByTestId('ask-live');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toContainText('Turning your question into calculations…', SLOW);
    await expect(live).toContainText('Running the calculations…', SLOW);
    await expect(live).toContainText('Writing the answer…', SLOW);

    const answer = page.getByTestId('ask-answer');
    await expect(answer).toHaveAttribute('data-state', 'shown', SLOW);
    await expect(page.getByTestId('ask-answer-text')).toHaveText(ASK_ANSWER);
    await expect(page.getByTestId('ask-answer-badge')).toHaveText(ASK_LOCAL_BADGE);
    await expect(page.getByTestId('ask-answer-ai-label')).toHaveText('AI-assisted wording');
    await expect(page.getByTestId('ask-looked-at-line')).toHaveText(ASK_LOOKED_AT_LINE);
    // The answer took focus as it landed; the question box was emptied and the history gained a row.
    await expect(answer).toBeFocused();
    await expect(page.getByLabel('Your question')).toHaveValue('');
    await expect(page.getByTestId('ask-history-item')).toHaveCount(4);
    await expect(page.getByTestId('ask-history-item').first()).toContainText('Answered');
    expect(mocks.ask.bodies).toEqual([{ question: ASK_QUESTION }]);
    expect(mocks.ask.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  test('a draft refused at the narrate step shows the arithmetic without the prose, open', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openAsk(page, { outcome: 'refused' });
    await ask(page, ASK_QUESTION);

    const answer = page.getByTestId('ask-answer');
    await expect(answer).toHaveAttribute('data-state', 'refused', SLOW);
    await expect(page.getByTestId('ask-message')).toHaveText(ASK_REFUSED_WORDS);
    await expect(page.getByTestId('ask-answer-text')).toHaveCount(0);
    await expect(page.getByTestId('ask-answer-badge')).toHaveCount(0);
    await expect(page.getByTestId('ask-looked-at-line')).toHaveText(ASK_LOOKED_AT_LINE);
    // Every figure is on screen without a tap.
    await expect(answer.getByTestId('ask-figures')).toContainText('Room left');
    await expect(answer.getByTestId('ask-figures')).toContainText('$2,500.00');
    await expect(answer.getByTestId('ask-figures')).toContainText('$7,000.00');
  });

  test('an out-of-scope question is answered at once with a real link to the nearest screen', async ({
    page,
  }) => {
    const mocks = await openAsk(page, { outcome: 'unanswerable' });
    await ask(page, ASK_OUT_OF_SCOPE_QUESTION);

    const answer = page.getByTestId('ask-answer');
    await expect(answer).toHaveAttribute('data-state', 'unanswerable');
    await expect(page.getByTestId('ask-message')).toHaveText(ASK_OUT_OF_SCOPE_WORDS);
    await expect(page.getByTestId('ask-answer-badge')).toHaveCount(0);
    const link = answer.getByRole('link', { name: 'Investments' });
    await expect(link).toHaveAttribute('href', '/investments');
    // No read of a session was needed: the 200 carried it all.
    expect(mocks.ask.calls.filter((c) => c.startsWith('GET /api/ask/'))).toEqual([]);
    await link.click();
    await expect(page).toHaveURL(/\/investments$/u);
  });

  test('unavailable: the box is disabled and the way to Advisor management is a real link', async ({
    page,
  }) => {
    await openAsk(page, {
      availability: {
        state: 'unavailable',
        reason: 'payload_not_approved',
        step: 'compile',
        message: ASK_UNAVAILABLE_WORDS,
      },
    });
    const notice = page.getByTestId('ask-unavailable');
    await expect(page.getByTestId('ask-unavailable-message')).toHaveText(ASK_UNAVAILABLE_WORDS);
    await expect(notice).toContainText('ask.compile');
    await expect(notice).toContainText('ask.narrate');
    await expect(page.getByLabel('Your question')).toBeDisabled();
    await expect(page.getByTestId('ask-submit')).toBeDisabled();
    const link = notice.getByRole('link', { name: 'Advisor management' });
    await expect(link).toHaveAttribute('href', '/settings/advisors');
    await link.click();
    await expect(page).toHaveURL(/\/settings\/advisors$/u);
  });

  test('a 409 because a question is already going says so and keeps the text', async ({ page }) => {
    await openAsk(page, { outcome: 'in_flight' });
    await ask(page, 'And another question?');
    await expect(page.getByTestId('ask-error')).toContainText('already being worked on');
    await expect(page.getByLabel('Your question')).toHaveValue('And another question?');
    expect(ASK_IN_FLIGHT_DETAIL).toContain('already');
  });

  test('the counter follows the text and a question over the cap holds the button', async ({
    page,
  }) => {
    const mocks = await openAsk(page);
    const box = page.getByLabel('Your question');
    await expect(page.getByTestId('ask-count')).toHaveText('0 / 500 characters');
    await box.fill('x'.repeat(520));
    await expect(page.getByTestId('ask-count')).toHaveText('520 / 500 characters — over by 20');
    await expect(page.getByTestId('ask-submit')).toHaveAttribute('aria-disabled', 'true');
    await box.press('Enter');
    expect(mocks.ask.bodies).toEqual([]);
    await box.fill('x'.repeat(500));
    await expect(page.getByTestId('ask-submit')).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('history: picking an earlier question shows it, and its "I looked at" items expand to their figures', async ({
    page,
  }) => {
    await openAsk(page);
    await page.getByTestId('ask-history-item').first().click();
    const answer = page.getByTestId('ask-answer');
    await expect(answer).toHaveAttribute('data-state', 'shown');
    await expect(page.getByTestId('ask-answer-text')).toHaveText(ASK_ANSWER);

    const toggle = answer.getByRole('button', { name: /Contribution room \(2026, IRA\)/u });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(answer.getByTestId('ask-figures')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(answer.getByTestId('ask-figures')).toContainText('Contributed so far');
    await expect(answer.getByTestId('ask-figures')).toContainText('$4,500.00');
    await expect(answer.getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'href',
      '/accounts',
    );
    await toggle.click();
    await expect(answer.getByTestId('ask-figures')).toHaveCount(0);

    await page.getByTestId('ask-history-item').nth(1).click();
    await expect(answer).toHaveAttribute('data-state', 'refused');
    await expect(page.getByTestId('ask-message')).toHaveText(ASK_REFUSED_WORDS);
  });

  // The screenshots the work package's evidence doc cites: written only when PLAYWRIGHT_EVIDENCE_DIR names the
  // evidence directory; otherwise into the gitignored test-results directory.
  test('WP 11.5c evidence: Ask answered, refused and out of scope, light and dark, at 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(240_000);
    for (const [name, outcome, question] of [
      ['answered', 'shown', ASK_QUESTION],
      ['refused', 'refused', ASK_QUESTION],
      ['unanswerable', 'unanswerable', ASK_OUT_OF_SCOPE_QUESTION],
    ] as const) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.setViewportSize({ width: 1280, height: 1100 });
      await openAsk(page, { outcome });
      await ask(page, question);
      await expect(page.getByTestId('ask-answer')).toHaveAttribute(
        'data-state',
        /^(shown|refused|unanswerable)$/u,
        SLOW,
      );
      if (outcome === 'shown') {
        await page.getByRole('button', { name: /Contribution room \(2026, IRA\)/u }).click();
        await expect(page.getByTestId('ask-figures')).toBeVisible();
      }
      await page.getByTestId('ask-answer').focus();
      for (const [width, height] of [
        [1280, 1100],
        [390, 2100],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.waitForTimeout(600);
          await page.screenshot({
            path: `${screenshotDir(evidenceDir)}wp11.5c-ask-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
          });
        }
      }
    }
  });
});
