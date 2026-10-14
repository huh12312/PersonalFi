// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { installSweepMocks } from './support/mock-sweep.ts';
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
  const journey = await begin(page, 'investments', '/investments');

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
