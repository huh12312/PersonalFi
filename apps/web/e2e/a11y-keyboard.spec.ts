// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { installBudgetCategoryMocks } from './support/mock-budget.ts';
import { installCategoryMocks } from './support/mock-categories.ts';
import {
  installRuleSuggestionMocks,
  RULE_SUGGESTION_INSIGHT_ID,
  SUGGESTED_CATEGORY_KEY,
} from './support/mock-rule-suggestions.ts';
import {
  installCategorySuggestionMocks,
  SUGGESTED_CATEGORY_ID,
  SUGGESTED_MERCHANT,
  SUGGESTED_TRANSACTION_ID,
} from './support/mock-category-suggestions.ts';
import {
  GROCERIES_EXPLANATION,
  SAVINGS_RATE_EXPLANATION,
  explainBody,
  scriptExplanation,
  shownBody,
} from './support/mock-explain.ts';
import {
  buildBrief,
  installBriefMocks,
  NARRATED_OPENING,
  narratedBriefItems,
  PROGRESS_SESSION_ID,
  SHOWN_NARRATION,
  talkThroughBriefItems,
} from './support/mock-brief.ts';
import {
  ADVISOR_FINDING_QUESTION,
  ADVISOR_FINDING_TITLE,
  ADVISOR_QUESTION,
  ADVISOR_QUESTIONS,
} from './support/mock-advisor.ts';
import { ASK_OUT_OF_SCOPE_QUESTION, ASK_QUESTION } from './support/mock-ask.ts';
import {
  EBAY_SUGGESTION_ID,
  EBAY_TXN_IDS,
  PATREON_SUGGESTION_ID,
  PATREON_TXN_ID,
  seedMerchantNames,
} from './support/mock-merchant-names.ts';
import { CONTROL_CHECKS } from './support/mock-narrator.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { installInvestmentsMocks } from './support/mock-investments.ts';
import { assertReadingOrder, Journey } from './support/keyboard.ts';
import { installVirtualPasskey } from './support/virtual-passkey.ts';
import { concretePath, hideDevtools, routePatternsInTree, visit } from './support/sweep.ts';

/**
 * WP 9.8 (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.8" (3)): the core journeys by keyboard alone. Exit test,
 * verbatim: 'each core journey completes by keyboard alone with visible, unobscured focus at every stop'.
 *
 * **This file and `support/keyboard.ts` never touch the pointer.** A structural test below reads both and fails on
 * the pointer APIs, so a journey cannot start working because a click rescued it. Navigation to a screen is
 * `page.goto` (the address bar), everything after it is `page.keyboard`.
 *
 * At every stop `Journey.check` asserts 2.4.7 (a focus indicator is drawn) and 2.4.11 (the focused element is in the
 * viewport and nothing is drawn over its centre or corners — the bottom tab bar, a toast, a scrim); 2.4.3 is
 * asserted two ways: the reading order of a Tab walk through every screen (`assertReadingOrder`) and, in every
 * journey, that closing a dialog returns focus to the control that opened it.
 */

// ---------------------------------------------------------------------------
// Structural: no pointer in this suite
// ---------------------------------------------------------------------------

test.describe('the keyboard suite is free of the pointer', () => {
  // The words are assembled so that this file does not contain what it forbids.
  const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
    ['mouse', new RegExp(['\\.mo', 'use\\b'].join(''))],
    ['click()', new RegExp(['\\.cl', 'ick\\s*\\('].join(''))],
    ['dblclick()', new RegExp(['\\.dbl', 'click\\s*\\('].join(''))],
    ['tap()', new RegExp(['\\.t', 'ap\\s*\\('].join(''))],
    ['hover()', new RegExp(['\\.ho', 'ver\\s*\\('].join(''))],
    ['dragTo()', new RegExp(['\\.drag', 'To\\s*\\('].join(''))],
    ['check()/uncheck() on a locator', new RegExp(['\\)\\.(?:un)?che', 'ck\\s*\\('].join(''))],
    ['setChecked()', new RegExp(['\\.setChe', 'cked\\s*\\('].join(''))],
    ['selectOption()', new RegExp(['\\.selectOp', 'tion\\s*\\('].join(''))],
    ['dispatchEvent()', new RegExp(['\\.dispatch', 'Event\\s*\\('].join(''))],
    ['fill()', new RegExp(['\\.fi', 'll\\s*\\('].join(''))],
    ['focus()', new RegExp(['\\.fo', 'cus\\s*\\(\\s*\\)'].join(''))],
  ];

  test('the journeys and their helper read no pointer API (no mouse, no click())', () => {
    const files = ['a11y-keyboard.spec.ts', 'support/keyboard.ts', 'support/virtual-passkey.ts'];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [name, pattern] of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Mocks the whole app, lands on `path` signed in, and returns the journey for it. */
async function begin(page: Page, name: string, path: string): Promise<Journey> {
  await installSweepMocks(page);
  await visit(page, path);
  await hideDevtools(page); // dev-only third-party chrome: it is not in a production build and has no focus ring of ours
  return new Journey(page, name);
}

const PATTERNS = routePatternsInTree();
const AUTH_ONLY = new Set(['/login', '/register', '/lock', '/unlock']);

// ---------------------------------------------------------------------------
// 1. Every screen, by Tab: visible, unobscured, in reading order (2.4.3, 2.4.7, 2.4.11)
// ---------------------------------------------------------------------------

for (const viewport of [
  { label: '1280 px', width: 1280, height: 800 },
  { label: '320 px', width: 320, height: 640 },
] as const) {
  test.describe(`walking every screen with Tab at ${viewport.label}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const pattern of PATTERNS) {
      test(`route ${pattern}`, async ({ page }) => {
        test.setTimeout(180_000);
        await installSweepMocks(page, { accountSettings: pattern.includes('$') });
        await visit(page, concretePath(pattern));
        await hideDevtools(page);
        const journey = new Journey(page, `${pattern} at ${viewport.label}`);
        const stops = await journey.walk(AUTH_ONLY.has(pattern) ? 15 : 90);
        expect(stops.length, `${pattern}: Tab reached nothing`).toBeGreaterThan(0);
        assertReadingOrder(journey.name, stops);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Passkey login with a virtual authenticator
// ---------------------------------------------------------------------------

test('passkey login completes by keyboard with a virtual authenticator', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await installSweepMocks(page);
  const passkey = await installVirtualPasskey(page, context);

  await page.goto('/login');
  const journey = new Journey(page, 'passkey login');
  await expect(page.getByRole('heading', { name: 'Sign in to PersonalFi' })).toBeVisible();
  // The primary action appears after the WebAuthn availability check resolves; under host load the
  // heading is visible before the button exists, and a Tab loop that starts then walks past the two
  // fallbacks and fails (seen once in the full suite on 2026-10-08, never alone). Wait for the stop.
  await expect(page.getByRole('button', { name: /Sign in with a passkey/ })).toBeVisible();

  // The theme switch is the first stop (it sits above the card); the primary action is next and the two
  // fallbacks follow it in reading order.
  await journey.tabTo(/Sign in with a passkey/, { max: 3 });
  const next = await journey.press('Tab', 'second stop');
  expect(next.name).toMatch(/authenticator code/);
  await journey.press('Tab', 'third stop');
  await journey.press('Shift+Tab', 'back');
  await journey.press('Shift+Tab', 'back to the primary action');
  await passkey.respond(true);
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
  expect(passkey.assertions(), 'the passkey assertion never reached the verify endpoint').toBe(1);
  // Signed in: the skip link is the first stop of the shell.
  const skip = await journey.press('Tab', 'first stop of the shell');
  expect(skip.name).toBe('Skip to main content');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('the TOTP fallback is reachable by keyboard, accepts a paste-shaped value, and signs in', async ({
  page,
}) => {
  await installSweepMocks(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to PersonalFi' })).toBeVisible();
  const journey = new Journey(page, 'totp login');
  await journey.tabTo(/authenticator code instead/);
  await page.keyboard.press('Enter');
  const field = await journey.tabTo(/6-digit authenticator code/, { max: 6 });
  expect(field.tag).toBe('input');
  await journey.type('123456');
  await journey.tabTo(/Verify code/, { max: 4 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// 3. Transactions: filter, split, rule
// ---------------------------------------------------------------------------

test('transactions: filter, open a row, split it, and make a rule — by keyboard', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const journey = await begin(page, 'transactions', '/transactions');

  // Filter: the search field by Tab and typing (it lands in the URL), then a checkbox by Space.
  await journey.tabTo(/^Search$/);
  await journey.type('Blue Bottle');
  await expect(page).toHaveURL(/q=Blue/, { timeout: 8_000 });
  await journey.tabTo(/Uncategorized only/, { max: 14 });
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/uncategorized=true/);
  await expect(page.getByRole('checkbox', { name: /Uncategorized only/ })).toBeChecked();

  // The list is one tab stop (roving); Enter opens the focused row.
  const row = await journey.tabTo(/Blue Bottle/);
  expect(row.role).toBe('row');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Blue Bottle Coffee' });
  await expect(sheet).toBeVisible();
  await journey.settle();
  await journey.check('the sheet has focus');

  // Split: the Split button, Enter, Save with Enter, and the dialog closes.
  await journey.tabTo(/split/i, { max: 12 });
  await page.keyboard.press('Enter');
  const split = page.getByRole('dialog', { name: 'Split this transaction' });
  await expect(split).toBeVisible();
  await journey.settle();
  await journey.check('split dialog open');
  await journey.tabTo(/save splits/i, { max: 20 });
  await page.keyboard.press('Enter');
  await expect(split).toBeHidden();
  await journey.expectFocus(/split/i, 'focus returns to the Split button when its dialog closes');

  // Rule: "Always categorize like this" → category by arrow keys → Preview → Apply.
  await journey.tabTo(/always categorize like this/i, { max: 12 });
  await page.keyboard.press('Enter');
  const rule = page.getByRole('dialog', { name: 'Always categorize like this' });
  await expect(rule).toBeVisible();
  await journey.settle();
  const combobox = await journey.check('rule dialog open');
  expect(combobox.name).toMatch(/Category/);
  await journey.type('Coffee');
  await page.keyboard.press('ArrowDown');
  await journey.check('an option is highlighted by arrow key');
  await page.keyboard.press('Enter');
  await journey.tabTo(/^Preview$/, { max: 6 });
  await page.keyboard.press('Enter');
  await expect(rule.getByText(/recategorize/)).toBeVisible();
  await journey.tabTo(/Apply to \d+ transaction/, { max: 6 });
  await page.keyboard.press('Enter');
  await expect(rule).toBeHidden();
  await journey.expectFocus(
    /always categorize like this/i,
    'focus returns to the rule button when its dialog closes',
  );

  // Escape closes the sheet and focus goes back to the row that opened it.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await journey.expectFocus(/Blue Bottle/, 'focus returns to the transaction row');
  assertReadingOrder(
    'transactions',
    journey.stops.filter((s) => s.region === 'main'),
  );
});

// ---------------------------------------------------------------------------
// 4. Budget: assign money to an envelope
// ---------------------------------------------------------------------------

test('budget: an envelope is edited, committed and left by keyboard', async ({ page }) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'budget', '/budget');
  const readyToAssign = page.getByTestId('ready-to-assign-amount').locator('[aria-hidden="true"]');
  const before = await readyToAssign.textContent();

  await journey.tabTo(/Assign amount for Groceries/, { max: 50 });
  await page.keyboard.press('Enter');
  const field = await journey.check('the amount field takes focus');
  expect(field.tag).toBe('input');
  // 3.3.1/3.3.3: an amount that cannot be read is named in text and the field stays open.
  await page.keyboard.press('Control+A');
  await journey.type('five');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Enter an amount such as 50.00' }),
  ).toBeVisible();
  await journey.check('the field is still focused after a refused amount');
  await page.keyboard.press('Control+A');
  await journey.type('50.00');
  await page.keyboard.press('Enter');
  await expect(readyToAssign).not.toHaveText(before ?? '');
  await journey.expectFocus(
    /Assign amount for Groceries/,
    'focus returns to the envelope button after the amount is committed',
  );

  // Escape backs out of an edit without committing it, and focus is still somewhere sensible.
  await page.keyboard.press('Enter');
  await journey.check('the amount field again');
  const committed = await readyToAssign.textContent();
  await journey.type('999');
  await page.keyboard.press('Escape');
  await expect(readyToAssign).toHaveText(committed ?? '');
  await journey.check('after Escape');
});

// ---------------------------------------------------------------------------
// 4b. Budget (WP 10.11): switch to By variability and classify a category
// ---------------------------------------------------------------------------

test('budget: the view toggle and the classify control by keyboard; focus follows the row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const categories = await installBudgetCategoryMocks(page);
  await visit(page, '/budget');
  await hideDevtools(page);
  const journey = new Journey(page, 'budget-classify');

  await journey.tabTo(/^By variability$/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=variability/);
  await journey.expectFocus(/^By variability$/, 'focus stays on the toggle after the view changes');

  // Fixed buttons in reading order: Rent (Fixed), Groceries (Flexible), Dining and Utilities (Unclassified).
  const groupOfFocus = () =>
    page.evaluate(() => ({
      group: document.activeElement?.closest('[role="group"]')?.getAttribute('aria-label') ?? null,
      section:
        document.activeElement
          ?.closest('[data-variability-section]')
          ?.getAttribute('data-variability-section') ?? null,
    }));
  for (let n = 0; n < 4; n += 1) await journey.tabTo(/^Fixed$/, { max: 40 });
  expect(await groupOfFocus()).toEqual({ group: 'Classify Utilities', section: 'unclassified' });

  await page.keyboard.press('Space');
  await expect.poll(() => categories.patches).toEqual([{ variability: 'fixed' }]);
  await expect.poll(groupOfFocus).toEqual({ group: 'Classify Utilities', section: 'fixed' });
  await journey.expectFocus(/^Fixed$/, 'focus follows the classified row into its new section');
  await expect(page.getByTestId('variability-suggested')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 4c. Financial health (WP 10.12): from the hero to a pillar's detail and back
// ---------------------------------------------------------------------------

test('health: Tab from the hero to a pillar’s See detail, Enter, the detail’s heading; back by keyboard', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'health', '/health');
  await expect(page.getByTestId('health-hero')).toBeVisible();

  // The hero's table toggle comes first, then the pillars in reading order: Emergency fund's See detail.
  await journey.tabTo(/^View as table/, { max: 40 });
  await journey.tabTo(/^See detail — Emergency fund$/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/health\/emergency-fund$/);
  await expect(page.getByRole('heading', { name: 'Emergency fund', level: 2 })).toBeVisible();

  await journey.tabTo(/^Financial health$/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/health$/);
  await expect(page.getByTestId('health-hero')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 5. Brief: accept one item, dismiss another with a reason
// ---------------------------------------------------------------------------

test('Brief: accept, and dismiss with a reason chosen by arrow keys', async ({ page }) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'brief', '/brief');
  await expect(page.getByTestId('brief-item-card').first()).toBeVisible();

  const reviews: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/insights\/[^/]+\/review$/.test(request.url())) {
      reviews.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await journey.tabTo(/^Dismiss$/, { max: 40 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await journey.settle();
  await expect(dialog.getByRole('radio')).toHaveCount(7);
  // The group is one tab stop; arrows move through the reasons.
  await journey.tabTo(/./, { max: 4, type: 'radio' });
  await journey.press('ArrowDown', 'ArrowDown moves to the next reason');
  await journey.press('ArrowDown', 'and the next');
  await journey.tabTo(/^Dismiss$/, { max: 6 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(() => reviews.length, { message: 'Dismiss never reached the API' }).toBe(1);
  expect(reviews[0]).toMatchObject({ action: 'dismiss' });
  expect(reviews[0]?.['reasonCode'], 'a reason was chosen with the arrow keys').toEqual(
    expect.any(String),
  );
  await journey.check('after the dismissal');

  // Accept is the next stop after Dismiss on the same card.
  await journey.tabTo(/^Accept$/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect.poll(() => reviews.length, { message: 'Accept never reached the API' }).toBe(2);
  expect(reviews[1]).toMatchObject({ action: 'accept' });
  await journey.check('after Accept');
});

// ---------------------------------------------------------------------------
// 6. Plan sliders: arrow keys, the alternative to dragging (2.5.7)
// ---------------------------------------------------------------------------

test('plan: every slider moves by arrow keys, Home and End', async ({ page }) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'plan sliders', '/plan');
  await expect(page.getByTestId('goal-sliders')).toBeVisible();

  for (const label of [/Retirement age/, /Annual spending/, /Monthly savings/]) {
    const thumb = await journey.tabTo(label, { max: 80, type: 'range' });
    const read = async (): Promise<number> =>
      Number(await page.evaluate(() => (document.activeElement as HTMLInputElement).value));
    const start = await read();
    await journey.press('ArrowRight', `${thumb.name}: ArrowRight`);
    const right = await read();
    expect(right, `${thumb.name}: ArrowRight did not raise the value`).toBeGreaterThan(start);
    await journey.press('ArrowLeft', `${thumb.name}: ArrowLeft`);
    await journey.press('Home', `${thumb.name}: Home`);
    const home = await read();
    await journey.press('End', `${thumb.name}: End`);
    expect(await read(), `${thumb.name}: End is not above Home`).toBeGreaterThan(home);
  }
});

// ---------------------------------------------------------------------------
// 7. Goals: create, edit, fund and delete
// ---------------------------------------------------------------------------

test('goals: create, edit, fund and delete by keyboard, focus returning each time', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const journey = await begin(page, 'goals', '/goals');
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Goals', exact: true }),
  ).toBeVisible();

  // create
  await journey.tabTo(/^Add goal$/, { max: 40 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await journey.settle();
  const first = await journey.check('the create dialog has focus on its first field');
  expect(first.name).toMatch(/Name/);
  await journey.type('Keyboard car');
  await journey.tabTo(/Target amount/, { max: 8 });
  await journey.type('18000');
  await journey.tabTo(/Target date/, { max: 8 });
  await journey.type('06012029');
  await journey.tabTo(/^Add goal$/, { max: 12 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('goal').filter({ hasText: 'Keyboard car' })).toBeVisible();
  await journey.expectFocus(/Add goal/, 'focus returns to the Add goal button after the dialog');

  // edit
  await journey.tabTo(/^Edit Keyboard car$/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await journey.settle();
  await journey.check('the edit dialog');
  await page.keyboard.press('Control+A');
  await journey.type('Keyboard car fund');
  await journey.tabTo(/^Save goal$/, { max: 12 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('goal').filter({ hasText: 'Keyboard car fund' })).toBeVisible();
  await journey.expectFocus(/Edit Keyboard car fund/, 'focus returns to Edit after the dialog');

  // fund
  await journey.tabTo(/^Contributions for Keyboard car fund/, { max: 6, backwards: true });
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Contributions to Keyboard car fund' });
  await expect(panel).toBeVisible();
  await journey.tabTo(/Amount each time/, { max: 12 });
  await journey.type('300');
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('contribution')).toContainText('$300.00');

  // delete, backing out first
  await journey.tabTo(/^Delete Keyboard car fund$/, { max: 14, backwards: true });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Delete Keyboard car fund?');
  await journey.settle();
  await journey.check('the delete confirmation');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await journey.expectFocus(
    /^Delete Keyboard car fund$/,
    'Escape on the confirmation returns focus to the Delete button',
  );
  await page.keyboard.press('Enter');
  await journey.settle();
  await journey.tabTo(/^Delete goal$/, { max: 6 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('goal').filter({ hasText: 'Keyboard car fund' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 8. An advisor grant, through step-up
// ---------------------------------------------------------------------------

test('advisors: a scope is granted by keyboard, through a real passkey step-up', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const passkey = await installVirtualPasskey(page, context);
  await visit(page, '/settings/advisors');
  await hideDevtools(page);
  const journey = new Journey(page, 'advisor grant');

  await journey.tabTo(/Show detail/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Local narrator detail' })).toBeVisible();

  const row = page.getByTestId('scope-row').filter({ hasText: 'transactions.raw' });
  await expect(row).toContainText('Consented per run only');
  await journey.tabTo(/./, { max: 40, type: 'checkbox' });
  // Walk to the checkbox that belongs to the transactions.raw row.
  for (let n = 0; n < 12; n += 1) {
    const inRow = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="scope-row"]')?.textContent ?? '',
    );
    if (inRow.includes('transactions.raw')) break;
    await journey.press('Tab', 'looking for the transactions.raw checkbox');
  }
  await page.keyboard.press('Space');
  await journey.check('after Space on the scope');
  await journey.tabTo(/^Save grants$/, { max: 12 });
  await passkey.respond(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Granted:' })).toBeVisible();
  expect(passkey.assertions(), 'the grant crossed the passkey step-up').toBeGreaterThan(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// ---------------------------------------------------------------------------
// 9. Settings, the theme switch, the privacy shortcut and the command palette
// ---------------------------------------------------------------------------

test('settings: tabs by arrow keys, the theme and privacy switches, and the command palette', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'settings', '/settings');

  // Tabs: one stop for the list, arrows move, Enter/Space chooses.
  const tab = await journey.tabTo(/Rules|Notifications|Market data|Crypto/, { max: 40 });
  expect(tab.role).toBe('tab');
  await journey.press('ArrowRight', 'ArrowRight moves to the next tab');
  await page.keyboard.press('Enter');
  const selected = page.getByRole('tab', { selected: true });
  await expect(selected).toHaveCount(1);
  await journey.check('the chosen tab keeps focus');

  // The theme switch, from the keyboard (its own button in the top bar).
  const before = await page.evaluate(() => document.documentElement.dataset['theme'] ?? '');
  await journey.tabTo(/Switch to (dark|light) theme/, { max: 40, backwards: true });
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['theme'] ?? ''))
    .not.toBe(before);

  // 2.1.4: the privacy shortcut is a modifier combination (Ctrl/Cmd + Shift + H), never a bare character.
  const privacy = (): Promise<string> =>
    page.evaluate(() => document.documentElement.dataset['privacy'] ?? '');
  const was = await privacy();
  await page.keyboard.press('h');
  expect(await privacy(), 'a bare "h" must not toggle anything (2.1.4)').toBe(was);
  await page.keyboard.press('Control+Shift+H');
  expect(await privacy()).not.toBe(was);
  await page.keyboard.press('Control+Shift+H');
  expect(await privacy()).toBe(was);

  // The command palette: Ctrl+K opens it, typing filters, Enter goes, Escape returns focus to where it was.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await journey.settle();
  await journey.check('the palette has focus');
  await journey.type('Budget');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/budget$/);
  await expect(palette).toBeHidden();
});

test('investments (WP 10.3): the Activity tab by arrow keys, its type filter, and the performance scope — by keyboard', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The sweep answers Activity as an install with no activity (its empty state is swept elsewhere);
  // this journey walks the table, so the screen's own Sandbox-shaped fixture is installed last and wins.
  await installSweepMocks(page);
  await installInvestmentsMocks(page);
  await visit(page, '/investments');
  await hideDevtools(page);
  const journey = new Journey(page, 'investments');

  // The tab list is one stop; arrows move, Enter chooses.
  const tab = await journey.tabTo(/^Holdings$/, { max: 40 });
  expect(tab.role).toBe('tab');
  await journey.press('ArrowRight', 'ArrowRight reaches Activity');
  await journey.expectFocus(/^Activity$/, 'Activity is the second tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Activity', selected: true })).toBeVisible();
  await expect(page.getByTestId('activity-table')).toBeVisible();

  // The type filter: a native select, reached by Tab and changed by arrow keys.
  await journey.tabTo(/^Type/, { max: 20 });
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/activityKind=/);
  await journey.check('the type filter keeps focus after a change');

  // Back to the tab list, across to Performance, and the scope radios by arrow keys.
  // Shift+Tab until the stop is the tab itself: the tab panel is a stop too, and it is
  // also named "Activity" (it is labelled by its tab).
  let back = await journey.press('Shift+Tab', 'Shift+Tab towards the tab list');
  for (let n = 0; n < 20 && back.role !== 'tab'; n += 1) {
    back = await journey.press('Shift+Tab', 'Shift+Tab towards the tab list');
  }
  expect(back).toMatchObject({ role: 'tab', name: 'Activity' });
  for (let n = 0; n < 4 && !/^Performance$/.test(await journey.focusedName()); n += 1) {
    await journey.press('ArrowRight', 'ArrowRight towards Performance');
  }
  await journey.expectFocus(/^Performance$/, 'the arrows reached Performance');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Performance', selected: true })).toBeVisible();
  await journey.tabTo(/^Whole portfolio$/, { max: 40 });
  await journey.press('ArrowDown', 'ArrowDown chooses By management');
  await expect(page).toHaveURL(/scope=management/);
  await expect(page.getByTestId('management-twr-table')).toBeVisible();
  await journey.check('the scope radio keeps focus');
});

test('settings › market data keys (WP 10.4): Tab to a key field, type, save through a real passkey step-up, remove behind the confirmation — by keyboard', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const passkey = await installVirtualPasskey(page, context);
  await visit(page, '/settings');
  await hideDevtools(page);
  const journey = new Journey(page, 'market data keys');
  const fred = page.getByTestId('market-data-key-fred');

  // The tab list is one stop; arrows move through it and Enter chooses.
  await journey.tabTo(/Rules|Notifications|Market data|Crypto/, { max: 40 });
  for (let n = 0; n < 4 && !/Market data/.test(await journey.focusedName()); n += 1) {
    await journey.press('ArrowRight', 'ArrowRight along the tabs');
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expect(fred).toContainText('Not set.');

  // Tiingo (the operator's file) offers nothing to stop on: the first field is FRED's.
  const first = await journey.tabTo(/API key$/, { max: 20 });
  expect(first.name).toBe('FRED API key');
  await journey.type('kbdFredKey0123456789abcdK3yQ'); // gitleaks:allow — synthetic, not a FRED key
  await journey.tabTo(/^Save with passkey$/, { max: 3 });
  await passkey.respond(true);
  await page.keyboard.press('Enter');
  await expect(fred).toContainText('ends in K3yQ', { timeout: 15_000 });
  // Focus comes back to the emptied field, not to the document body.
  await journey.expectFocus(/^FRED API key$/, 'focus returns to the key field after the save');
  await expect(fred.getByLabel('FRED API key')).toHaveValue('');
  expect(passkey.assertions(), 'the save crossed the passkey step-up').toBeGreaterThan(0);

  // Remove: a confirmation first. Escape closes it and focus returns to Remove (2.4.3).
  await journey.tabTo(/^Remove$/, { max: 3 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Remove the stored FRED key?' });
  await expect(dialog).toBeVisible();
  await journey.settle();
  await journey.check('focus is inside the confirmation');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await journey.expectFocus(/^Remove$/, 'Escape returns focus to Remove');
  await expect(fred).toContainText('ends in K3yQ');

  // Again, and confirm by keyboard: the step-up runs, the dialog closes, focus lands on the field.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await journey.settle();
  await journey.tabTo(/^Remove key$/, { max: 4 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(fred).toContainText('Not set.');
  await journey.expectFocus(/^FRED API key$/, 'focus lands on the key field after the removal');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('investments (WP 10.5): Tab to Refresh prices, press it, and the result is in a live region while focus stays on the button — by keyboard', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'investments refresh prices', '/investments');

  const stop = await journey.tabTo(/^Refresh prices$/, { max: 40 });
  expect(stop.tag).toBe('button');
  await page.keyboard.press('Enter');
  const result = page.getByRole('status').filter({ hasText: 'Priced 12 of 13' });
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute('aria-live', 'polite');
  // Disabled while it ran: focus must come back to the button, not fall to the document body (2.4.3).
  await journey.expectFocus(/^Refresh prices$/, 'focus is back on Refresh prices after the run');
  await journey.check('Refresh prices keeps a visible focus ring after the run');

  // The disclosure is a native <details>: Tab to its summary, Enter opens it.
  await journey.tabTo(/^Which holdings were not priced/, { max: 5 });
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'BTC: no CoinGecko key' }),
  ).toBeVisible();

  // A second press is the api's ten-minute 409, said as a sentence, not an alert.
  await journey.tabTo(/^Refresh prices$/, { max: 5, backwards: true });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Try again after' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await journey.expectFocus(/^Refresh prices$/, 'focus is back on Refresh prices after the 409');
});

test('settings › language model (WP 10.16): Tab to Run control checks, press it through a real passkey step-up, focus stays while the checks tick over in a live region, then the results table and a past run’s disclosure — by keyboard', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await installSweepMocks(page);
  const passkey = await installVirtualPasskey(page, context);
  await visit(page, '/settings');
  await hideDevtools(page);
  const journey = new Journey(page, 'control checks');

  // The tab list is one stop; arrows move along it and Enter chooses.
  await journey.tabTo(/^(Rules|Notifications|Market data|Language model|Crypto|Security)$/, {
    max: 40,
  });
  for (let n = 0; n < 6 && !/^Language model$/.test(await journey.focusedName()); n += 1) {
    await journey.press('ArrowRight', 'ArrowRight along the tabs');
  }
  await page.keyboard.press('Enter');
  const section = page.getByTestId('control-checks');
  await expect(section.getByRole('heading', { name: 'Control checks' })).toBeVisible();

  // The cost is read before the button is reached.
  await expect(section.getByTestId('control-checks-cost')).toBeVisible();
  const stop = await journey.tabTo(/^Run control checks$/, { max: 90 });
  expect(stop.tag).toBe('button');
  await passkey.respond(true);
  await page.keyboard.press('Enter');
  const live = section.getByTestId('control-checks-progress');
  await expect(live).toContainText(/checks done\./, { timeout: 15_000 });
  expect(passkey.assertions(), 'the run crossed the passkey step-up').toBeGreaterThan(0);
  // aria-disabled, never disabled: focus stays on the button while the run goes (2.4.3).
  await journey.expectFocus(/^Running control checks…$/, 'focus stays on the button while it runs');
  await expect(live).toHaveText(
    'Control checks finished. Result: Partial: some checks could not run.',
    { timeout: 20_000 },
  );
  await journey.expectFocus(/^Run control checks$/, 'focus is still on the button once it is done');

  // The results table is a scrollable region and a tab stop; then the history's disclosures.
  await journey.tabTo(/^Control checks of .+, scrollable$/, { max: 4 });
  await journey.tabTo(/\(latest\)/, { max: 4 });
  await page.keyboard.press('Enter');
  const history = section.getByTestId('control-checks-history');
  await expect(history.getByRole('table')).toBeVisible();
  // One row per check in the mock's catalogue (derived, so a new check is picked up: seventeen since WP 11.6's merchant_name_substring).
  await expect(history.getByRole('table').locator('tbody tr')).toHaveCount(CONTROL_CHECKS.length);
  await journey.expectFocus(/\(latest\)/, 'focus stays on the opened summary');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// ---------------------------------------------------------------------------
// 10. The soft-lock: its 60 s warning is operable from the keyboard (2.2.1)
// ---------------------------------------------------------------------------

for (const viewport of [
  { label: '1280 px', width: 1280, height: 800 },
  { label: '320 px', width: 320, height: 640 },
] as const) {
  test(`soft-lock at ${viewport.label}: a key press extends the session, an idle one locks, a passkey unlocks`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.clock.install();
    await installSweepMocks(page);
    const passkey = await installVirtualPasskey(page, context);
    await visit(page, '/budget');
    await hideDevtools(page);
    const journey = new Journey(page, `soft-lock at ${viewport.label}`);
    const minutes = (n: number): number => n * 60_000;

    // 14 minutes idle: the warning toast appears — and it covers nothing a keyboard user is on.
    await page.clock.runFor(minutes(14) + 5_000);
    const warning = page.getByText('You’ll be locked out soon due to inactivity.');
    await expect(warning).toBeVisible();
    // Judged while the toast is up. (Any key also counts as activity, so this walk extends the session on its own
    // first stop; the toast is checked on that first frame by the 2.4.11 sampling in `check`.)
    await journey.press('Tab', 'the first Tab while the warning is showing');

    // The press was activity: the warning is gone, and time well past the original limit does not lock.
    await expect(warning).toBeHidden();
    await page.clock.runFor(minutes(5));
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // Left alone for the full 15 minutes: the lock, with focus inside it and the passkey as the way back.
    await page.clock.runFor(minutes(16));
    const lock = page.getByRole('alertdialog', { name: 'PersonalFi is locked' });
    await expect(lock).toBeVisible();
    // Focus is moved into the lock, and Tab cannot leave it for the covered app behind the scrim (2.4.11).
    await journey.expectFocus(/^Unlock$/, 'focus moves to Unlock when the lock appears');
    for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
      const stop = await journey.press(key, `${key} inside the lock`);
      expect(stop.name, `${key} left the lock for "${stop.name}"`).toBe('Unlock');
    }
    await passkey.respond(true);
    await page.keyboard.press('Enter');
    await expect(lock).toBeHidden({ timeout: 15_000 });
    expect(passkey.assertions()).toBeGreaterThan(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
}

// ---------------------------------------------------------------------------
// 11. The add-wallet form (wp5.14 item 26): reached, filled and submitted by keyboard, both chains
// ---------------------------------------------------------------------------

test('add wallet: Crypto tab, chain by arrow keys, Etherscan note, address, step-up, submit — by keyboard', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const passkey = await installVirtualPasskey(page, context);
  await visit(page, '/settings');
  await hideDevtools(page);
  const journey = new Journey(page, 'add wallet');

  // The tab list is one stop; arrows move through it and Enter chooses.
  await journey.tabTo(/Rules|Notifications|Market data|Crypto/, { max: 40 });
  for (let n = 0; n < 4 && !/Crypto/.test(await journey.focusedName()); n += 1) {
    await journey.press('ArrowRight', 'ArrowRight along the tabs');
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /wallet \(watch-only\)/ })).toBeVisible();

  await journey.tabTo(/^Chain$/, { max: 12 });
  await expect(page.getByText(/Etherscan API key/)).toHaveCount(0);
  await journey.press('ArrowDown', 'the chain select moves to Ethereum');
  await expect(page.getByText(/Etherscan API key/)).toBeVisible();
  await journey.tabTo(/^Address$/, { max: 4 });
  await journey.type('0x00000000219ab540356cBB839Cbe05303d7705Fa');
  await journey.tabTo(/^Add wallet$/, { max: 6 });
  await passkey.respond(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Wallet added/)).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('dashboard (WP 10.9): Customize by keyboard — hide a widget with Space, move one with Enter, focus kept, Escape returns to the button', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'dashboard customize', '/');
  const order = () =>
    page
      .getByTestId('dashboard-grid')
      .locator('[data-grid-widget]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-grid-widget') ?? ''));

  await journey.tabTo(/^Customize$/, { max: 40 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Customize the dashboard' });
  await expect(dialog).toBeVisible();
  await journey.settle();
  await journey.check('the dialog has focus');

  await journey.tabTo(/^Show Goals$/, { max: 30 });
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('switch', { name: 'Show Goals' })).not.toBeChecked();
  await expect.poll(order).not.toContain('goals');

  await journey.tabTo(/^Move Spending pace up$/, { max: 30 });
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await order())[0]).toBe('spending-pace');
  // At the top the up button is disabled; focus moves to its sibling rather than falling to the page.
  await journey.expectFocus(/^Move Spending pace down$/, 'focus stays on the moved widget’s row');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await journey.expectFocus(/^Customize$/, 'focus returns to Customize when the dialog closes');
});

// ---------------------------------------------------------------------------
// WP 10.13: the net-worth chart and the milestone notice, by keyboard
// ---------------------------------------------------------------------------

test('dashboard (WP 10.13): dismiss the milestone notice, Tab to the net-worth chart, scrub with arrows, Home, End and Escape; the hero follows; open the full history and close it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const journey = await begin(page, 'net worth', '/');
  const card = page.locator('[data-widget="net-worth"]');
  const tile = card.locator('[data-stat-tile]').first();

  await journey.tabTo(/^Dismiss/, { max: 40 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('net-worth-milestone')).toHaveCount(0);

  const slider = await journey.tabTo(/^Net worth by account type: choose a week/, { max: 40 });
  expect(slider.name).toMatch(/choose a week/);
  const latest = (await tile.textContent()) ?? '';
  await journey.press('ArrowLeft', 'ArrowLeft selects the week before the latest');
  await expect(card.getByTestId('net-worth-hero-selection')).toBeVisible();
  await expect(tile).not.toHaveText(latest);
  await expect(card.getByTestId('net-worth-announcement')).toContainText('net worth');
  await journey.press('Home', 'Home selects the first week');
  await expect(card.getByTestId('net-worth-slider')).toHaveAttribute('aria-valuenow', '1');
  await journey.press('End', 'End selects the latest week');
  await journey.press('Escape', 'Escape releases the selection');
  await expect(card.getByTestId('net-worth-hero-selection')).toHaveCount(0);
  await expect(tile).toHaveText(latest);

  await journey.tabTo(/^View full history$/, { max: 10 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Net worth over time' });
  await expect(dialog).toBeVisible();
  await journey.tabTo(/^Net worth by account type: choose a week/, { max: 30 });
  await journey.press('ArrowLeft', 'ArrowLeft in the full history');
  await expect(dialog.getByTestId('net-worth-hero-selection')).toBeVisible();
  await page.keyboard.press('Escape'); // releases the selection
  await page.keyboard.press('Escape'); // closes the dialog
  await expect(dialog).toBeHidden();
  await journey.expectFocus(
    /^View full history$/,
    'focus returns to the trigger when the dialog closes',
  );
});

// ---------------------------------------------------------------------------
// WP 10.14: the category screen and its editor, by keyboard
// ---------------------------------------------------------------------------

test('category (WP 10.14): Tab to the month chart, select months with arrows, Home and End, the list follows; Edit, a swatch by arrows, an icon, Save; focus returns to Edit', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const mocks = await installCategoryMocks(page);
  await visit(page, '/categories/cat_groceries');
  await hideDevtools(page);
  const journey = new Journey(page, 'category');
  const slider = await journey.tabTo(/^Groceries by month: choose a month$/, { max: 40 });
  expect(slider.name).toMatch(/choose a month/);
  await journey.press('ArrowLeft', 'ArrowLeft selects the month before this one');
  await expect(page).toHaveURL(/month=2026-02/);
  await expect(page.getByTestId('category-transactions-heading')).toHaveText(
    'Transactions in February 2026',
  );
  await expect(page.getByTestId('category-history-announcement')).toContainText('February 2026');
  await journey.press('Home', 'Home selects the oldest month');
  await expect(page).toHaveURL(/month=2025-03/);
  await journey.press('End', 'End selects this month');
  await expect(page).toHaveURL(/month=2026-03/);

  await journey.tabTo(/^Edit Groceries$/, { backwards: true, max: 10 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit Groceries' });
  await expect(dialog).toBeVisible();
  // The icon grid and the swatches are one Tab stop each (radio groups); arrows move and select.
  const icon = await journey.tabTo(/^💰$/, { max: 20 });
  expect(icon.name.length).toBeGreaterThan(0);
  await journey.press('ArrowRight', 'ArrowRight picks the next icon');
  await expect(
    dialog.getByRole('radiogroup', { name: 'Icon' }).locator('[aria-checked="true"]'),
  ).toHaveCount(1);
  await journey.tabTo(
    /^(Teal|Green|Red|Orange|Yellow|Cyan|Purple|Indigo|Lime|Mint|Pink|Brown|Sky)$/,
    { max: 10 },
  );
  await journey.press('ArrowRight', 'ArrowRight picks the next hue');
  await journey.tabTo(/^Save changes$/, { max: 15 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await journey.expectFocus(/^Edit Groceries$/, 'focus returns to Edit when the editor closes');
  expect(mocks.patches).toHaveLength(1);
  expect(Object.keys(mocks.patches[0]!).sort()).toEqual(['emoji', 'hue']);
});

// ---------------------------------------------------------------------------
// WP 11.1: a rule suggestion in the Inbox, by keyboard
// ---------------------------------------------------------------------------

test('inbox: Tab to a rule suggestion’s Create rule, keep the suggested category, save; focus lands in the queue', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const mocks = await installRuleSuggestionMocks(page);
  await visit(page, '/inbox');
  await hideDevtools(page);
  const journey = new Journey(page, 'inbox rule suggestion');
  const suggestion = page.getByTestId('rule-suggestion');
  await expect(suggestion.getByTestId('rule-suggestion-merchant')).toHaveText("Trader Joe's");

  // Escape first: nothing is created, and focus goes back to the button that opened the dialog.
  await journey.tabTo(/^Create rule$/, { max: 60 });
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Always categorize like this' });
  await expect(dialog).toBeVisible();
  await journey.settle();
  await journey.check('the rule dialog, pre-filled');
  await expect(dialog.getByRole('combobox', { name: 'Category' })).toHaveValue('Groceries');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await journey.expectFocus(/^Create rule$/, 'Escape returns focus to Create rule');
  expect(mocks.ruleCreates).toEqual([]);

  // Again, keeping the suggested category: Preview creates the rule, Just save the rule closes the dialog.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await journey.settle();
  // Tab passes the Category combobox (left on the suggested Groceries) on its way to Preview.
  await journey.tabTo(/^Preview$/, { max: 8 });
  await expect(dialog.getByRole('combobox', { name: 'Category' })).toHaveValue('Groceries');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => mocks.ruleCreates.map((create) => create.body['categoryKey']))
    .toEqual([SUGGESTED_CATEGORY_KEY]);
  await expect
    .poll(() => mocks.reviews)
    .toEqual([{ insightId: RULE_SUGGESTION_INSIGHT_ID, body: { action: 'accept' } }]);
  await journey.tabTo(/^Just save the rule$/, { max: 8 });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('rule-suggestion')).toHaveCount(0);

  // The suggestion (and the button that opened the dialog) is gone: focus is on the review queue's current row.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('ul[aria-label="Review inbox"]') !== null,
      ),
    )
    .toBe(true);
  await journey.check('after saving the rule, in the review queue');
});

// ---------------------------------------------------------------------------
// WP 11.2: the model's category suggestion, by keyboard
// ---------------------------------------------------------------------------

test('inbox: Tab to the suggestion’s Confirm, Enter files it; focus lands on the next row of the queue', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const mocks = await installCategorySuggestionMocks(page);
  await visit(page, '/inbox');
  await hideDevtools(page);
  const journey = new Journey(page, 'inbox model suggestion, Confirm');
  const row = page
    .getByRole('list', { name: 'Review inbox' })
    .locator('> li')
    .filter({ hasText: SUGGESTED_MERCHANT });
  await expect(row.getByTestId('suggestion-chip')).toBeVisible();

  await journey.tabTo(/^Confirm Coffee Shops$/, { max: 60 });
  await page.keyboard.press('Enter');
  await expect
    .poll(() => mocks.patches)
    .toEqual([
      { transactionId: SUGGESTED_TRANSACTION_ID, body: { categoryId: SUGGESTED_CATEGORY_ID } },
    ]);
  await expect(row).toHaveCount(0);
  // The row (and the button) is gone: focus is on the review queue's current row, not the document body.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.matches('ul[aria-label="Review inbox"] > li[tabindex="0"]') ===
          true,
      ),
    )
    .toBe(true);
  await journey.check('after Confirm, on the next row of the queue');
});

test('inbox: Not this by keyboard; the chip goes and focus stays on its row', async ({ page }) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const mocks = await installCategorySuggestionMocks(page);
  await visit(page, '/inbox');
  await hideDevtools(page);
  const journey = new Journey(page, 'inbox model suggestion, Not this');
  const row = page
    .getByRole('list', { name: 'Review inbox' })
    .locator('> li')
    .filter({ hasText: SUGGESTED_MERCHANT });
  await expect(row.getByTestId('suggestion-chip')).toBeVisible();

  await journey.tabTo(/^Not this$/, { max: 60 });
  await page.keyboard.press('Enter');
  await expect.poll(() => mocks.rejects).toEqual([SUGGESTED_TRANSACTION_ID]);
  await expect(row.getByTestId('suggestion-chip')).toHaveCount(0);
  await expect(row).toBeFocused();
  await journey.check('after Not this, on the same row');
  expect(mocks.patches).toEqual([]);
});

test('transactions: Tab to the chip’s Confirm, Enter files it without opening the row; focus is on the row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installSweepMocks(page);
  const mocks = await installCategorySuggestionMocks(page);
  await visit(page, '/transactions');
  await hideDevtools(page);
  const journey = new Journey(page, 'transactions model suggestion');
  const row = page.locator(`[role="row"][data-transaction-id="${SUGGESTED_TRANSACTION_ID}"]`);
  await expect(row.getByTestId('suggestion-chip')).toBeVisible();

  await journey.tabTo(/^Confirm Coffee Shops$/, { max: 60 });
  await page.keyboard.press('Enter');
  await expect
    .poll(() => mocks.patches)
    .toEqual([
      { transactionId: SUGGESTED_TRANSACTION_ID, body: { categoryId: SUGGESTED_CATEGORY_ID } },
    ]);
  await expect(row.getByTestId('suggestion-chip')).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await journey.check('after Confirm, on the row');
});

// ---------------------------------------------------------------------------
// WP 11.6: a merchant display-name suggestion, by keyboard
// ---------------------------------------------------------------------------

test('transactions: Tab to the name chip’s Accept, Enter renames the merchant’s rows without opening one; focus is on the row, the confirmation is announced', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const mocks = await installSweepMocks(page);
  seedMerchantNames(mocks.api, { mode: 'suggested' });
  await visit(page, '/transactions');
  await hideDevtools(page);
  const journey = new Journey(page, 'transactions merchant name, Accept');
  const row = page.locator(`[role="row"][data-transaction-id="${EBAY_TXN_IDS[0]}"]`);
  await expect(row.getByTestId('merchant-name-chip')).toBeVisible();

  await journey.tabTo(/^Accept the name Ebay$/, { max: 60 });
  await journey.check('on the first Accept');
  // The name is the control's own: Dismiss follows Accept in the tab order, and is reachable.
  await page.keyboard.press('Tab');
  await journey.expectFocus(/^Dismiss the name Ebay$/, 'Dismiss follows Accept');
  await page.keyboard.press('Shift+Tab');
  await journey.expectFocus(/^Accept the name Ebay$/, 'Shift+Tab returns to Accept');

  await page.keyboard.press('Enter');
  await expect.poll(() => mocks.api.merchantNames.accepts).toEqual([EBAY_SUGGESTION_ID]);
  await expect(page.getByTestId('merchant-name-status')).toHaveText(
    'Renamed 2 transactions to Ebay.',
  );
  await expect(row.getByTestId('merchant-name-chip')).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await journey.check('after Accept, on the row');
});

test('transactions: Dismiss on the name chip by keyboard records it; the chip goes and focus is on the row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const mocks = await installSweepMocks(page);
  seedMerchantNames(mocks.api, { mode: 'suggested' });
  await visit(page, '/transactions');
  await hideDevtools(page);
  const journey = new Journey(page, 'transactions merchant name, Dismiss');
  const row = page.locator(`[role="row"][data-transaction-id="${PATREON_TXN_ID}"]`);
  await expect(row.getByTestId('merchant-name-chip')).toBeVisible();

  await journey.tabTo(/^Dismiss the name Patreon Membership$/, { max: 80 });
  await page.keyboard.press('Enter');
  await expect.poll(() => mocks.api.merchantNames.dismisses).toEqual([PATREON_SUGGESTION_ID]);
  await expect(row.getByTestId('merchant-name-chip')).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await journey.check('after Dismiss, on the row');
  expect(mocks.api.merchantNames.accepts).toEqual([]);
});

// ---------------------------------------------------------------------------
// WP 11.3: "Explain this", by keyboard
// ---------------------------------------------------------------------------

for (const [where, kind, id, name, text] of [
  [
    '/insights',
    'insight',
    'insight_groceries',
    /^Explain this — Groceries has been running higher than usual$/u,
    GROCERIES_EXPLANATION,
  ],
  [
    '/health/savings-rate',
    'health_pillar',
    'savings_rate',
    /^Explain this — Savings rate$/u,
    SAVINGS_RATE_EXPLANATION,
  ],
] as const) {
  test(`WP 11.3 ${where}: Tab to Explain this, Enter asks; the live region says Explaining…; focus lands on the explanation and Tab goes on from it`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const mocks = await installSweepMocks(page);
    scriptExplanation(mocks.explain, kind, id, {
      post: explainBody(kind, id, 'computing'),
      computingReads: 2,
      result: shownBody(kind, id, text),
    });
    await visit(page, where);
    await hideDevtools(page);
    const journey = new Journey(page, `WP 11.3 ${where} Explain this`);
    await journey.tabTo(name, { max: 80 });
    await page.keyboard.press('Enter');
    const live = page.getByTestId('explain-live').filter({ hasText: 'Explaining…' });
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('role', 'status');
    // Busy, the button keeps focus (aria-disabled, never disabled): nothing drops to the body.
    await journey.expectFocus(name, 'the busy button keeps focus');
    const explanation = page.getByTestId('explanation');
    await expect(explanation).toBeFocused({ timeout: 15_000 });
    await expect(explanation.getByTestId('explanation-text')).toHaveText(text);
    await journey.check('on the explanation');
    // Tab goes on from the explanation: to the next stop after it, or — the last card on the page — round to the
    // skip link. Never back to a stop before it, never the body.
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => {
        const box = document.querySelector('[data-testid="explanation"]');
        const active = document.activeElement;
        if (box === null || active === null || active === document.body) return false;
        if ((box.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
          return true;
        return active.textContent?.trim() === 'Skip to main content';
      }),
    ).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// WP 11.4: the Brief's own wording, by keyboard
// ---------------------------------------------------------------------------

test('WP 11.4 /brief: with "Your week" and the narration shown, the Tab walk keeps its reading order and gains no stop', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The route walk's own viewport (section 1): at the default 720 px the sidebar's last stops sit below its fold.
  await page.setViewportSize({ width: 1280, height: 800 });
  const walk = async (narration: Record<string, unknown> | null): Promise<string[]> => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await installSweepMocks(page);
    if (narration !== null) {
      await installBriefMocks(page, {
        standalone: false,
        brief: buildBrief({ items: narratedBriefItems(), opening: NARRATED_OPENING, narration }),
      });
    } else {
      await installBriefMocks(page, {
        standalone: false,
        brief: buildBrief({ items: narratedBriefItems(), opening: NARRATED_OPENING }),
      });
    }
    await visit(page, '/brief');
    await hideDevtools(page);
    await expect(page.getByTestId('brief-opening')).toBeVisible();
    const journey = new Journey(
      page,
      `WP 11.4 /brief ${narration === null ? 'unavailable' : 'shown'}`,
    );
    const stops = await journey.walk(90);
    assertReadingOrder(journey.name, stops);
    return stops.map((stop) => JSON.stringify(stop));
  };
  const without = await walk(null);
  await expect(page.getByTestId('brief-recap')).toHaveCount(0);
  const withWording = await walk(SHOWN_NARRATION);
  await expect(page.getByTestId('brief-recap')).toBeVisible();
  expect(withWording.length).toBe(without.length);
});

// ---------------------------------------------------------------------------
// WP 11.5c: Ask PersonalFi, by keyboard
// ---------------------------------------------------------------------------

/** A name matched as a whole, whatever punctuation it holds. */
function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
}

test('WP 11.5c /ask: Tab to the box, type, send with Enter, reach the answer, open and close an evidence item, then reach the nearest-screen link of an out-of-scope question', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const mocks = await installSweepMocks(page);
  await visit(page, '/ask');
  await hideDevtools(page);
  const journey = new Journey(page, 'WP 11.5c /ask');

  // The box, by Tab; the question typed; Enter sends it (Shift+Enter would start a new line).
  await journey.tabTo(/^Your question$/, { max: 40 });
  await journey.type(ASK_QUESTION);
  await expect(page.getByTestId('ask-count')).toContainText(`${String(ASK_QUESTION.length)} / 500`);
  await journey.press('Enter', 'Enter sends the question and focus stays on the box');
  await expect(page.getByTestId('ask-live')).toContainText(
    'Turning your question into calculations…',
    {
      timeout: 15_000,
    },
  );

  // The answer lands and takes focus; the live region keeps the outcome for a screen reader.
  await expect(page.getByTestId('ask-answer')).toHaveAttribute('data-state', 'shown', {
    timeout: 20_000,
  });
  await journey.expectFocus(exactly(ASK_QUESTION), 'focus lands on the answer');
  await expect(page.getByTestId('ask-live')).toHaveText('The answer is ready.');

  // The next stop is the first "I looked at" item: Enter opens it, Space closes it, Enter opens it again.
  const item = await journey.tabTo(/^Contribution room \(2026, IRA\)$/, { max: 6 });
  expect(item.tag).toBe('button');
  const toggle = page.getByRole('button', { name: /^Contribution room/u });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await journey.press('Enter', 'Enter opens the item');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('ask-figures')).toContainText('$2,500.00');
  await journey.press('Space', 'Space closes it');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await journey.press('Enter', 'Enter opens it again');
  // The item's screen link comes next.
  await journey.tabTo(/^Accounts$/, { max: 4 });

  // An out-of-scope question: back to the box (Shift+Tab), ask, and the nearest screen is a link in the Tab order.
  mocks.ask.options = { ...mocks.ask.options, outcome: 'unanswerable' };
  await journey.tabTo(/^Your question$/, { backwards: true, max: 30 });
  await journey.type(ASK_OUT_OF_SCOPE_QUESTION);
  await journey.press('Enter', 'Enter sends the out-of-scope question');
  await expect(page.getByTestId('ask-answer')).toHaveAttribute('data-state', 'unanswerable', {
    timeout: 20_000,
  });
  await journey.expectFocus(exactly(ASK_OUT_OF_SCOPE_QUESTION), 'focus lands on the answer');
  await journey.tabTo(/^Investments$/, { max: 4 });
  await journey.press('Enter', 'Enter follows the nearest-screen link');
  await expect(page).toHaveURL(/\/investments$/u);
});

// ---------------------------------------------------------------------------
// WP 11.5d: the Advisor, by keyboard
// ---------------------------------------------------------------------------

test('WP 11.5d /advisor: Tab to the box, start a session, answer the clarifying questions, pick an option, and reach a plan link, all by keyboard', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await installSweepMocks(page);
  await visit(page, '/advisor');
  await hideDevtools(page);
  const journey = new Journey(page, 'WP 11.5d /advisor');
  const session = page.getByTestId('advisor-session');

  // The box, by Tab; the question typed; Enter starts the session (Shift+Enter would start a new line).
  await journey.tabTo(/^Your question$/, { max: 40 });
  await journey.type(ADVISOR_QUESTION);
  await expect(page.getByTestId('advisor-count')).toContainText(
    `${String(ADVISOR_QUESTION.length)} / 500`,
  );
  await journey.press('Enter', 'Enter starts the session and focus stays on the box');
  await expect(page.getByTestId('advisor-live')).toContainText('Restating your question…', {
    timeout: 15_000,
  });

  // The clarify form lands and takes focus; its two boxes are the next stops, then Continue.
  await expect(session).toHaveAttribute('data-state', 'clarifying', { timeout: 20_000 });
  await expect(page.getByTestId('advisor-clarify')).toBeVisible();
  await journey.expectFocus(exactly(ADVISOR_QUESTION), 'focus lands on the session');
  await journey.tabTo(exactly(ADVISOR_QUESTIONS[0]!), { max: 6 });
  await journey.type('Six months');
  await journey.tabTo(exactly(ADVISOR_QUESTIONS[1]!), { max: 3 });
  await journey.type('By spring');
  await journey.tabTo(/^Continue$/, { max: 3 });
  await journey.press('Enter', 'Enter sends the answers');

  // The options land and take focus; the first card's pick button is reachable, Enter picks.
  await expect(session).toHaveAttribute('data-state', 'awaiting_pick', { timeout: 30_000 });
  await journey.expectFocus(exactly(ADVISOR_QUESTION), 'focus lands on the options');
  await expect(page.getByTestId('advisor-live')).toHaveText('The options are ready.');
  await journey.tabTo(/^Pick this option: Raise the monthly transfer to savings$/, { max: 8 });
  await journey.press('Enter', 'Enter picks the option');

  // The plan lands and takes focus; its first link is the next stop, Enter follows it.
  await expect(session).toHaveAttribute('data-state', 'tracked', { timeout: 30_000 });
  await journey.expectFocus(exactly(ADVISOR_QUESTION), 'focus lands on the plan');
  await journey.tabTo(/^Goals$/, { max: 4 });
  await journey.tabTo(/^Accounts$/, { max: 2 });
  await journey.tabTo(/^Plan$/, { max: 2 });
  await journey.tabTo(/^See it in the Brief$/, { max: 2 });
  await journey.tabTo(/^Goals$/, { backwards: true, max: 4 });
  await journey.press('Enter', 'Enter follows the plan link');
  await expect(page).toHaveURL(/\/goals$/u);
});

test('WP 11.5e /brief to /advisor: Tab to "Talk this through", Enter, the advisor opens about that finding with its origin header, and Tab goes on into the session; "Open the plan" leads to a followed plan', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await installSweepMocks(page);
  await installBriefMocks(page, {
    standalone: false,
    brief: buildBrief({ isoWeek: '2026-W43', items: talkThroughBriefItems() }),
  });
  await visit(page, '/brief');
  await hideDevtools(page);
  await expect(page.getByTestId('brief-item-card')).toHaveCount(3);
  const journey = new Journey(page, 'WP 11.5e /brief -> /advisor');

  // The link is a real link, reached by Tab among the card's own controls.
  const stop = await journey.tabTo(/^Talk this through$/, { max: 40 });
  expect(stop.role === 'link' || stop.tag === 'a', 'it is a link').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/advisor\?session=0190d000-/u, { timeout: 15_000 });
  await expect(page.getByTestId('advisor-origin-line')).toHaveText(
    `About: ${ADVISOR_FINDING_TITLE}, from the Brief of week 43 of 2026`,
  );
  await expect(page.getByTestId('advisor-pregathered')).toBeVisible();
  await expect(page.getByTestId('advisor-clarify')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: ADVISOR_FINDING_QUESTION })).toBeVisible();

  // Focus is somewhere visible on the new screen, and the session's own controls are the next stops.
  await journey.tabTo(exactly(ADVISOR_QUESTIONS[0]!), { max: 30 });
  await journey.tabTo(exactly(ADVISOR_QUESTIONS[1]!), { max: 3 });
  await journey.tabTo(/^Continue$/, { max: 3 });

  // The other way: the progress card's "Open the plan" by keyboard.
  await visit(page, '/brief');
  await hideDevtools(page);
  await expect(page.getByTestId('brief-progress')).toBeVisible();
  const second = new Journey(page, 'WP 11.5e /brief -> Open the plan');
  await second.tabTo(/^Open the plan$/, { max: 60 });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/advisor\\?session=${PROGRESS_SESSION_ID}$`, 'u'));
  await expect(page.getByTestId('advisor-tracked-wording')).toBeVisible({ timeout: 15_000 });
  await second.tabTo(/^See it in the Brief$/, { max: 60 });
});
