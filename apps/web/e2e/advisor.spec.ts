// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import {
  ADVISOR_CONSENT_SHA,
  ADVISOR_CONSENT_TEXT,
  ADVISOR_COMPLETED_WORDING,
  ADVISOR_COST_MISSING_WORDS,
  ADVISOR_FINDING_ID,
  ADVISOR_FINDING_PREGATHERED,
  ADVISOR_FINDING_QUESTION,
  ADVISOR_FINDING_TITLE,
  ADVISOR_LOCAL_BADGE,
  ADVISOR_LOOKED_AT_LINE,
  ADVISOR_OUT_OF_SCOPE_QUESTION,
  ADVISOR_OUT_OF_SCOPE_WORDS,
  ADVISOR_QUESTION,
  ADVISOR_QUESTIONS,
  ADVISOR_RESTATEMENT,
  ADVISOR_UNAVAILABLE_WORDS,
  completedSession,
  seededAdvisorHistory,
  type AdvisorMockOptions,
} from './support/mock-advisor.ts';
import {
  buildBrief,
  installBriefMocks,
  PROGRESS_SESSION_ID,
  PROGRESS_WORDING,
  talkThroughBriefItems,
  WORKED_ON_TITLE,
} from './support/mock-brief.ts';
import { installSweepMocks, type SweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * WP 11.5d, the Advisor (advisor mode): the functional journeys over route mocks only (`support/mock-advisor.ts`,
 * layered on the whole-app mocks) - start a session, answer the clarifying questions, read the options with their
 * costs, pick one, follow the plan's links, see what is followed in the Brief; a refusal at the trade-offs step; the
 * unavailable state and its way to Advisor management; the advisor's own hosted consent tick-box. No model, no
 * network.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

async function openAdvisor(page: Page, options: AdvisorMockOptions = {}): Promise<SweepMocks> {
  const mocks = await installSweepMocks(page, { advisor: options });
  await visit(page, '/advisor');
  await hideDevtools(page);
  await expect(page.getByLabel('Your question')).toBeVisible();
  return mocks;
}

/** Types into the box and starts with Enter. */
async function start(page: Page, question: string): Promise<void> {
  const box = page.getByLabel('Your question');
  await box.fill(question);
  await box.press('Enter');
}

const SLOW = { timeout: 15_000 } as const;

/** Starts a session and answers its clarifying questions: the walk then runs to the pick. */
async function startAndAnswer(page: Page): Promise<void> {
  await start(page, ADVISOR_QUESTION);
  await expect(page.getByTestId('advisor-clarify')).toBeVisible(SLOW);
  await page.getByLabel(ADVISOR_QUESTIONS[0]!).fill('Six months');
  await page.getByLabel(ADVISOR_QUESTIONS[1]!).fill('By spring');
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('Advisor (WP 11.5d)', () => {
  test('the sidebar has Advisor right after Ask, and the screen carries the disclaimer, the engine badge, the examples and the history', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const mocks = await installSweepMocks(page);
    await visit(page, '/');
    await hideDevtools(page);
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const links = await nav.getByRole('link').allInnerTexts();
    expect(links.indexOf('Advisor')).toBe(links.indexOf('Ask') + 1);
    await nav.getByRole('link', { name: 'Advisor', exact: true }).click();
    await expect(page).toHaveURL(/\/advisor$/u);
    await expect(page).toHaveTitle('Advisor · PersonalFi');
    await expect(page.getByRole('heading', { name: 'Advisor', level: 2 })).toBeVisible();
    await expect(page.getByTestId('advisor-disclaimer')).toContainText(
      'Not investment, tax, or legal advice.',
    );
    await expect(page.getByTestId('advisor-engine-badge')).toHaveText(ADVISOR_LOCAL_BADGE);
    await expect(page.getByTestId('advisor-engine')).toHaveAttribute('data-egress', 'local');
    await expect(page.getByTestId('advisor-engine-egress')).toContainText('local model');
    await expect(page.getByTestId('advisor-examples').getByRole('button')).toHaveCount(3);
    await expect(page.getByTestId('advisor-history-item')).toHaveCount(5);

    // An example fills the box and nothing is sent.
    await page
      .getByTestId('advisor-examples')
      .getByRole('button', { name: 'How could I build up my emergency fund faster?' })
      .click();
    await expect(page.getByLabel('Your question')).toHaveValue(ADVISOR_QUESTION);
    expect(mocks.advisor.bodies).toEqual([]);
  });

  test('start -> clarify -> answers -> options with costs -> pick -> plan with in-app links -> tracked in the Brief', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const mocks = await openAdvisor(page);
    // Reading the screen asked nothing of a model.
    expect(mocks.advisor.calls).toEqual(['GET /api/advisor/sessions']);

    await start(page, ADVISOR_QUESTION);
    const live = page.getByTestId('advisor-live');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toContainText('Restating your question…', SLOW);

    // The clarify step: the restatement, two labelled questions, the assumed defaults.
    const session = page.getByTestId('advisor-session');
    await expect(session).toHaveAttribute('data-state', 'clarifying', SLOW);
    await expect(page.getByTestId('advisor-restatement')).toHaveText(ADVISOR_RESTATEMENT);
    await expect(page.getByTestId('advisor-answer')).toHaveCount(2);
    await expect(page.getByTestId('advisor-assumed')).toContainText(
      'Assumed: Monthly essentials — $3,100.00',
    );
    await expect(session).toBeFocused();
    await expect(page.getByTestId('advisor-session-badge')).toHaveText(ADVISOR_LOCAL_BADGE);
    await page.getByLabel(ADVISOR_QUESTIONS[0]!).fill('Six months');
    await page.getByLabel(ADVISOR_QUESTIONS[1]!).fill('By spring');
    await page.getByRole('button', { name: 'Continue' }).click();

    // The working steps, each said in the live region, then the options.
    await expect(live).toContainText('Gathering your figures…', SLOW);
    await expect(live).toContainText('Setting out the options…', SLOW);
    await expect(live).toContainText('Working out what each option costs…', SLOW);
    await expect(session).toHaveAttribute('data-state', 'awaiting_pick', SLOW);
    await expect(session).toBeFocused();
    expect(mocks.advisor.bodies.map((b) => b.call)).toEqual(['start', 'answers']);
    expect(mocks.advisor.bodies[1]).toEqual({
      call: 'answers',
      body: { answers: ['Six months', 'By spring'] },
    });

    // Every card sets its gains beside its costs.
    const cards = page.getByTestId('advisor-option');
    await expect(cards).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const card = cards.nth(index);
      await expect(card.getByTestId('advisor-option-gains')).toContainText('Gains');
      await expect(card.getByTestId('advisor-option-costs')).toContainText('Costs');
      await expect(card.getByTestId('advisor-option-costs').locator('dt')).not.toHaveCount(0);
    }
    await expect(cards.first().getByTestId('advisor-option-costs')).toContainText('$250.00');
    await expect(cards.first().getByTestId('advisor-option-gains')).toContainText('9 months');
    await expect(page.getByTestId('advisor-looked-at-line')).toHaveText(ADVISOR_LOOKED_AT_LINE);
    await expect(page.getByTestId('advisor-withheld')).toHaveText(
      'Playbook pages not yet reviewed were not used: 1',
    );

    // Pick the first.
    await cards.first().getByRole('button', { name: 'Pick this option' }).click();
    await expect(live).toContainText('Writing the steps…', SLOW);
    await expect(session).toHaveAttribute('data-state', 'tracked', SLOW);
    expect(mocks.advisor.bodies[2]).toEqual({ call: 'pick', body: { optionId: 'o1' } });
    await expect(page.getByTestId('advisor-option')).toHaveCount(0);

    // The plan: an ordered list, each step an in-app link.
    const steps = page.getByTestId('advisor-plan-step');
    await expect(steps).toHaveCount(3);
    await expect(page.getByTestId('advisor-plan').locator('ol')).toHaveCount(1);
    await expect(steps.nth(0).getByRole('link', { name: 'Goals' })).toHaveAttribute(
      'href',
      '/goals',
    );
    await expect(steps.nth(1).getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'href',
      '/accounts',
    );
    await expect(steps.nth(2).getByRole('link', { name: 'Plan' })).toHaveAttribute('href', '/plan');

    // What is followed, with the Brief link; the rubric line is evidence only.
    const tracked = page.getByTestId('advisor-tracked');
    await expect(tracked.getByTestId('advisor-tracked-baseline')).toContainText(
      'When you picked it: 2.0 months',
    );
    await expect(tracked.getByTestId('advisor-tracked-latest')).toHaveText(/Not checked yet/u);
    await expect(page.getByTestId('advisor-judge-line')).toHaveText(
      'Rubric check: 2 of 3 criteria met',
    );
    await expect(page.getByTestId('advisor-tokens')).toContainText('Tokens used: 5,400 of 8,000');
    await expect(page.getByTestId('advisor-close')).toHaveCount(0);
    // The history gained the session.
    await expect(page.getByTestId('advisor-history-item')).toHaveCount(6);

    await steps.nth(0).getByRole('link', { name: 'Goals' }).click();
    await expect(page).toHaveURL(/\/goals$/u);
    await page.goBack();
    await expect(page.getByTestId('advisor-disclaimer')).toBeVisible();
  });

  test('the tracked state links to the Brief', async ({ page }) => {
    await openAdvisor(page);
    await page.getByTestId('advisor-history-item').nth(2).click();
    const tracked = page.getByTestId('advisor-tracked');
    await expect(tracked).toBeVisible();
    const link = tracked.getByRole('link', { name: 'See it in the Brief' });
    await expect(link).toHaveAttribute('href', '/brief');
    await link.click();
    await expect(page).toHaveURL(/\/brief$/u);
  });

  test('a session that ends refused at the trade-offs step says so in words, with the class small, and shows no option', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openAdvisor(page, { outcome: 'refused' });
    await startAndAnswer(page);
    const session = page.getByTestId('advisor-session');
    await expect(session).toHaveAttribute('data-state', 'refused', SLOW);
    await expect(page.getByTestId('advisor-state-heading')).toHaveText('Refused');
    await expect(page.getByTestId('advisor-message')).toHaveText(ADVISOR_COST_MISSING_WORDS);
    await expect(page.getByTestId('advisor-refusal-class')).toHaveText(
      'Stopped at the trade-offs step: tradeoffs.cost_missing',
    );
    await expect(page.getByTestId('advisor-option')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Pick this option/u })).toHaveCount(0);
    await expect(page.getByTestId('advisor-disclaimer')).toBeVisible();
  });

  test('an out-of-scope question is answered at once with a real link to the nearest screen', async ({
    page,
  }) => {
    const mocks = await openAdvisor(page, { outcome: 'unanswerable' });
    await start(page, ADVISOR_OUT_OF_SCOPE_QUESTION);
    const session = page.getByTestId('advisor-session');
    await expect(session).toHaveAttribute('data-state', 'unanswerable');
    await expect(page.getByTestId('advisor-message')).toHaveText(ADVISOR_OUT_OF_SCOPE_WORDS);
    await expect(page.getByTestId('advisor-session-badge')).toHaveCount(0);
    const link = session.getByRole('link', { name: 'Investments' });
    await expect(link).toHaveAttribute('href', '/investments');
    expect(mocks.advisor.calls.filter((c) => c.startsWith('GET /api/advisor/sessions/'))).toEqual(
      [],
    );
    await link.click();
    await expect(page).toHaveURL(/\/investments$/u);
  });

  test('unavailable: the box is disabled and the way to Advisor management is a real link', async ({
    page,
  }) => {
    await openAdvisor(page, {
      availability: {
        state: 'unavailable',
        reason: 'payload_not_approved',
        step: 'clarify',
        message: ADVISOR_UNAVAILABLE_WORDS,
      },
      engine: null,
    });
    const notice = page.getByTestId('advisor-unavailable');
    await expect(page.getByTestId('advisor-unavailable-message')).toHaveText(
      ADVISOR_UNAVAILABLE_WORDS,
    );
    await expect(page.getByTestId('advisor-disclaimer')).toBeVisible();
    await expect(page.getByLabel('Your question')).toBeDisabled();
    await expect(page.getByTestId('advisor-submit')).toBeDisabled();
    const link = notice.getByRole('link', { name: 'Advisor management' });
    await expect(link).toHaveAttribute('href', '/settings/advisors');
    await link.click();
    await expect(page).toHaveURL(/\/settings\/advisors$/u);
  });

  test('a 409 because another session is going says so and keeps the text', async ({ page }) => {
    await openAdvisor(page, { outcome: 'in_flight' });
    await start(page, 'And another question?');
    await expect(page.getByTestId('advisor-error')).toContainText('still being worked on');
    await expect(page.getByLabel('Your question')).toHaveValue('And another question?');
  });

  test('a going session can be closed, and says it was', async ({ page }) => {
    test.setTimeout(60_000);
    const mocks = await openAdvisor(page, { hold: 'gathering' });
    await startAndAnswer(page);
    await expect(page.getByTestId('advisor-live')).toContainText('Gathering your figures…', SLOW);
    await page.getByRole('button', { name: 'Close this session' }).click();
    await expect(page.getByTestId('advisor-session')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.getByTestId('advisor-state-heading')).toHaveText('Session closed');
    await expect(page.getByRole('button', { name: 'Close this session' })).toHaveCount(0);
    expect(mocks.advisor.bodies.at(-1)).toEqual({ call: 'cancel', body: null });
  });

  test('history: picking an earlier session shows it, and its "I looked at" item expands to its figures', async ({
    page,
  }) => {
    await openAdvisor(page);
    await page.getByTestId('advisor-history-item').first().click();
    const session = page.getByTestId('advisor-session');
    await expect(session).toHaveAttribute('data-state', 'awaiting_pick');
    await expect(page.getByTestId('advisor-option')).toHaveCount(2);
    const toggle = session.getByRole('button', { name: /Emergency fund runway/u });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(session.getByTestId('advisor-figures')).toContainText('Cash set aside');
    await expect(session.getByTestId('advisor-figures')).toContainText('$6,200.00');
    await expect(session.getByRole('link', { name: 'Financial health' })).toHaveAttribute(
      'href',
      '/health',
    );

    await page.getByTestId('advisor-history-item').nth(1).click();
    await expect(session).toHaveAttribute('data-state', 'clarifying');
    await expect(page.getByTestId('advisor-clarify')).toBeVisible();
    await page.getByTestId('advisor-history-item').nth(3).click();
    await expect(session).toHaveAttribute('data-state', 'refused');
  });

  test('Advisor management: the hosted consent is unticked, shows the api’s text, and ticking names its sha256 after the passkey step-up', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installFakeWebAuthnAssertion(page);
    const mocks = await installSweepMocks(page);
    await visit(page, '/settings/advisors');
    await hideDevtools(page);
    const card = page.getByTestId('advisor-consent');
    await expect(
      card.getByRole('heading', { name: 'Advisor sessions on a hosted provider' }),
    ).toBeVisible();
    await expect(card.getByTestId('advisor-consent-text')).toHaveText(ADVISOR_CONSENT_TEXT);
    await expect(card.getByTestId('advisor-consent-version')).toContainText('2026-10-v1');
    await expect(card.getByTestId('advisor-consent-default')).toContainText(
      'Unticked, the advisor runs on the local model',
    );
    const box = card.getByRole('checkbox', { name: ADVISOR_CONSENT_TEXT });
    await expect(box).not.toBeChecked();

    await box.click();
    await expect(box).toBeChecked(SLOW);
    expect(mocks.advisor.stepUpsAsked).toBe(1);
    expect(mocks.advisor.writes).toEqual([
      { hostedConsent: true, consentTextSha256: ADVISOR_CONSENT_SHA },
    ]);
    await expect(card.getByRole('status')).toContainText('Recorded.');

    const provider = card.getByLabel('Hosted provider for the advisor');
    await expect(provider.locator('option')).toHaveText([
      'Same as the narrator',
      'OpenAI',
      'OpenRouter',
      'Anthropic',
    ]);
    await provider.selectOption('openrouter');
    await expect(card.getByRole('status')).toContainText('Provider saved.', SLOW);
    expect(mocks.advisor.writes.at(-1)).toEqual({ hostedProvider: 'openrouter' });

    await box.click();
    await expect(box).not.toBeChecked(SLOW);
    expect(mocks.advisor.writes.at(-1)).toEqual({ hostedConsent: false });
  });

  test('the engine badge says the hosted provider is in use, under the advisor’s own consent', async ({
    page,
  }) => {
    await openAdvisor(page, {
      engine: {
        provider: 'anthropic',
        providerName: 'Anthropic',
        model: 'anthropic:claude-sonnet-5-5',
        egress: 'hosted',
        hostedConsented: true,
        hostedFallback: null,
      },
    });
    await expect(page.getByTestId('advisor-engine-badge')).toHaveText(
      'Runs on Anthropic claude-sonnet-5-5',
    );
    await expect(page.getByTestId('advisor-engine')).toHaveAttribute('data-egress', 'hosted');
    await expect(page.getByTestId('advisor-engine-egress')).toContainText('hosted provider');
  });

  // The screenshots the work package's evidence doc cites: written only when PLAYWRIGHT_EVIDENCE_DIR names the
  // evidence directory; otherwise into the gitignored test-results directory.
  test('WP 11.5d evidence: advisor clarify, options, plan and refused, light and dark, at 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(300_000);
    for (const [name, outcome, stopAt] of [
      ['clarify', 'walk', 'clarifying'],
      ['options', 'walk', 'awaiting_pick'],
      ['plan', 'walk', 'tracked'],
      ['refused', 'refused', 'refused'],
    ] as const) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.setViewportSize({ width: 1280, height: 1100 });
      await openAdvisor(page, { outcome });
      await start(page, ADVISOR_QUESTION);
      const session = page.getByTestId('advisor-session');
      await expect(session).toHaveAttribute('data-state', 'clarifying', SLOW);
      await expect(page.getByTestId('advisor-clarify')).toBeVisible(SLOW);
      if (stopAt !== 'clarifying') {
        await page.getByLabel(ADVISOR_QUESTIONS[0]!).fill('Six months');
        await page.getByLabel(ADVISOR_QUESTIONS[1]!).fill('By spring');
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(session).toHaveAttribute(
          'data-state',
          stopAt === 'tracked' ? 'awaiting_pick' : stopAt,
          SLOW,
        );
      } else {
        await page.getByLabel(ADVISOR_QUESTIONS[0]!).fill('Six months');
      }
      if (stopAt === 'tracked') {
        await page
          .getByRole('button', { name: /Pick this option/u })
          .first()
          .click();
        await expect(session).toHaveAttribute('data-state', 'tracked', SLOW);
      }
      if (stopAt === 'awaiting_pick') {
        await page.getByRole('button', { name: /Emergency fund runway/u }).click();
        await expect(page.getByTestId('advisor-figures')).toBeVisible();
      }
      await session.focus();
      for (const [width, height] of [
        [1280, 1100],
        [390, 2400],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.waitForTimeout(600);
          await page.screenshot({
            path: `${screenshotDir(evidenceDir)}wp11.5d-advisor-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
          });
        }
      }
    }
  });
});

const COMPLETED_ID = '0190d000-0000-7000-8000-0000000000c1';

/** The whole-app mocks with the 2026-W43 Brief on top: one finding to talk through, one plan being followed. */
async function openBrief(page: Page, advisor: AdvisorMockOptions = {}): Promise<SweepMocks> {
  const mocks = await installSweepMocks(page, { advisor });
  await installBriefMocks(page, {
    standalone: false,
    brief: buildBrief({ isoWeek: '2026-W43', items: talkThroughBriefItems() }),
  });
  await visit(page, '/brief');
  await hideDevtools(page);
  await expect(page.getByTestId('brief-item-card')).toHaveCount(3);
  return mocks;
}

test.describe('The Brief and the advisor meet (WP 11.5e)', () => {
  test('"Talk this through" on a Brief item opens the advisor about that finding, once, and a refresh does not post again', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const mocks = await openBrief(page);
    const cards = page.getByTestId('brief-item-card');
    // Only the cash finding offers it; the plan being followed and the spending finding do not.
    await expect(cards.nth(0).getByRole('link', { name: 'Talk this through' })).toHaveAttribute(
      'href',
      `/advisor?finding=${ADVISOR_FINDING_ID}&week=2026-W43`,
    );
    await expect(cards.nth(1).getByRole('link', { name: 'Talk this through' })).toHaveCount(0);
    await expect(cards.nth(2).getByRole('link', { name: 'Talk this through' })).toHaveCount(0);
    expect(mocks.advisor.bodies).toEqual([]);

    await cards.nth(0).getByRole('link', { name: 'Talk this through' }).click();
    await expect(page).toHaveURL(/\/advisor\?session=0190d000-/u, SLOW);
    expect(mocks.advisor.bodies).toEqual([
      {
        call: 'start',
        body: { origin: { insightId: ADVISOR_FINDING_ID, briefWeek: '2026-W43' } },
      },
    ]);

    // The origin header, and what was gathered first, above the question the api built from the finding.
    await expect(page.getByTestId('advisor-origin-line')).toHaveText(
      `About: ${ADVISOR_FINDING_TITLE}, from the Brief of week 43 of 2026`,
    );
    await expect(page.getByTestId('advisor-pregathered')).toHaveText(ADVISOR_FINDING_PREGATHERED);
    await expect(page.getByRole('heading', { name: ADVISOR_FINDING_QUESTION })).toBeVisible();
    await expect(page.getByTestId('advisor-session')).toHaveAttribute(
      'data-state',
      'clarifying',
      SLOW,
    );
    await expect(page.getByTestId('advisor-clarify')).toBeVisible(SLOW);

    // A refresh opens the same session and posts nothing.
    await page.reload();
    await hideDevtools(page);
    await expect(page.getByTestId('advisor-origin-line')).toBeVisible(SLOW);
    expect(mocks.advisor.bodies.filter((entry) => entry.call === 'start')).toHaveLength(1);
    await expect(page).toHaveURL(/\/advisor\?session=0190d000-/u);
  });

  test('a finding that has no week (from an insight card) is about the finding alone', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const mocks = await installSweepMocks(page);
    await visit(page, `/advisor?finding=${ADVISOR_FINDING_ID}`);
    await hideDevtools(page);
    await expect(page.getByTestId('advisor-origin-line')).toHaveText(
      `About: ${ADVISOR_FINDING_TITLE}`,
      SLOW,
    );
    expect(mocks.advisor.bodies).toEqual([
      { call: 'start', body: { origin: { insightId: ADVISOR_FINDING_ID } } },
    ]);
  });

  test('the progress item shows the server’s wording, what it came from and what is being worked on, and "Open the plan" leads to the session', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const mocks = await openBrief(page);
    const card = page.getByTestId('brief-item-card').nth(1);
    const box = card.getByTestId('brief-progress');
    await expect(box).toContainText('Plan you picked');
    await expect(box.getByTestId('brief-progress-wording')).toHaveText(PROGRESS_WORDING);
    await expect(box.getByTestId('brief-progress-origin')).toHaveText(
      `From the finding “${WORKED_ON_TITLE}”`,
    );
    await expect(box.getByTestId('brief-progress-worked-on')).toContainText(
      `Being worked on: “${WORKED_ON_TITLE}”`,
    );
    await box.getByRole('link', { name: 'Open the plan' }).click();
    await expect(page).toHaveURL(new RegExp(`/advisor\\?session=${PROGRESS_SESSION_ID}$`, 'u'));
    await expect(page.getByTestId('advisor-session')).toHaveAttribute('data-state', 'tracked');
    await expect(page.getByTestId('advisor-tracked-wording')).toContainText(
      'when you picked this plan on 2026-10-28',
    );
    await expect(page.getByTestId('advisor-tracked-picked')).toHaveText('Picked on 2026-10-28');
    // Opening a session reads; it asks nothing of a model.
    expect(mocks.advisor.bodies).toEqual([]);
  });

  test('a completed session reads as reached and is no longer followed', async ({ page }) => {
    test.setTimeout(60_000);
    const mocks = await installSweepMocks(page, {
      advisor: { sessions: [completedSession(COMPLETED_ID), ...seededAdvisorHistory()] },
    });
    await visit(page, `/advisor?session=${COMPLETED_ID}`);
    await hideDevtools(page);
    const session = page.getByTestId('advisor-session');
    await expect(session).toHaveAttribute('data-state', 'completed');
    const box = page.getByTestId('advisor-tracked');
    await expect(box.getByTestId('advisor-tracked-wording')).toHaveText(ADVISOR_COMPLETED_WORDING);
    await expect(box.getByTestId('advisor-tracked-target')).toHaveText('Target: 6.0 months');
    await expect(box.getByTestId('advisor-tracked-reached')).toHaveText(
      "Reached: the plan's target is met; this plan is no longer followed.",
    );
    await expect(page.getByTestId('advisor-close')).toHaveCount(0);
    await expect(page.getByTestId('advisor-history')).toContainText('Target reached');
    expect(mocks.advisor.bodies).toEqual([]);
  });

  for (const [problemName, words] of [
    ['not_found', 'That finding could not be found'],
    ['not_supported', 'does not take up this kind of finding'],
    ['not_granted', 'not been approved for the advisor'],
    ['brief_unknown', 'That Brief could not be found'],
  ] as const) {
    test(`a finding the api turns away (${problemName}) is said in words, and a refresh does not retry`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const mocks = await installSweepMocks(page, { advisor: { originProblem: problemName } });
      await visit(page, `/advisor?finding=${ADVISOR_FINDING_ID}&week=2026-W43`);
      await hideDevtools(page);
      await expect(page.getByRole('alert').filter({ hasText: words })).toBeVisible(SLOW);
      await expect(page).toHaveURL(/\/advisor$/u);
      expect(mocks.advisor.bodies).toHaveLength(1);
      await expect(page.getByLabel('Your question')).toBeEnabled();
    });
  }

  test('axe reports no violations on the Brief with a talk-through link and a progress card, or on the advisor opened from a finding, in light and dark', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openBrief(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `Brief › talk through and progress (${theme})`);
    }
    await page
      .getByTestId('brief-item-card')
      .nth(0)
      .getByRole('link', { name: 'Talk this through' })
      .click();
    await expect(page.getByTestId('advisor-clarify')).toBeVisible(SLOW);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `Advisor › opened from a finding (${theme})`);
    }
  });

  // The screenshots the work package's evidence doc cites: written only when PLAYWRIGHT_EVIDENCE_DIR names the
  // evidence directory; otherwise into the gitignored test-results directory.
  test('WP 11.5e evidence: the advisor opened from a finding, and the Brief with the plan being followed, light and dark, at 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(300_000);
    const shoot = async (name: string, tall: number): Promise<void> => {
      for (const [width, height] of [
        [1280, 1100],
        [390, tall],
      ] as const) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await page.waitForTimeout(600);
          await page.screenshot({
            path: `${screenshotDir(evidenceDir)}wp11.5e-brief-advisor-${name}-${theme}-${String(width)}.png`,
            animations: 'disabled',
          });
        }
      }
    };

    await page.setViewportSize({ width: 1280, height: 1100 });
    await openBrief(page);
    await expect(page.getByTestId('brief-progress')).toBeVisible();
    await shoot('progress', 2600);

    // Follow the link: the advisor screen of the pre-gathered session.
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page
      .getByTestId('brief-item-card')
      .nth(0)
      .getByRole('link', { name: 'Talk this through' })
      .click();
    await expect(page.getByTestId('advisor-origin-line')).toBeVisible(SLOW);
    await expect(page.getByTestId('advisor-clarify')).toBeVisible(SLOW);
    await page.getByTestId('advisor-session').focus();
    await shoot('origin', 2400);
  });
});
