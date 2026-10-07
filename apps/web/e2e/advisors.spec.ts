// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';
import { ADVISOR_ID, INPUT_DIGEST, installAdvisorMocks } from './support/mock-advisors.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 5.12 exit tests (`docs/plan/05-phase-5-dispatch.md` §3). `mock-api.ts`
 * (shared, read-only to this package) carries no `/advisors*` handler at
 * all — this file registers its own `page.route` on top of it, the same
 * technique `inbox.spec.ts` uses for its own one-off fixture: Playwright
 * runs route handlers in reverse registration order, so a handler added
 * here after `installApiMocks` runs first and `route.fallback()`s anything
 * it does not recognise back to the shared mock (session, step-up, login).
 *
 * The in-memory store below is this file's own, not a shared support
 * module — no other package reads or writes it.
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
    path: `${screenshotDir(currentEvidenceDir)}wp5.12-${name}.png`,
    fullPage: true,
  });
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openAdvisorManagement(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('link', { name: 'Advisor management' }).click();
  await expect(page).toHaveURL(/\/settings\/advisors$/);
  await expect(page.getByRole('heading', { name: 'Advisor management' })).toBeVisible();
}
async function openAdvisorDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show detail' }).click();
  await expect(page.getByRole('region', { name: 'Local narrator detail' })).toBeVisible();
}

test('granting a scope shows what it yields and what it drops before the step-up', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  const scopeRows = page.getByTestId('scope-row');
  await expect(scopeRows).toHaveCount(3);

  // Rendered on mount, before any grant action — no checkbox has been
  // clicked and no step-up has happened yet (the sabotage this proves
  // against: "yields/drops hidden before step-up").
  const perRunRow = page.getByTestId('scope-row').filter({ hasText: 'transactions.raw' });
  await expect(perRunRow).toContainText('Every raw transaction row, including merchant free text.');
  await expect(perRunRow).toContainText('Nothing — this is the widest transaction scope.');
  await expect(perRunRow).toContainText('Consented per run only');

  // Now grant it, which does cross the step-up ceremony.
  await perRunRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save grants' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Granted:' })).toBeVisible();
});

test('the payload preview shows the exact bytes the model would receive, and approval comes before the first run', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  const untrustedBlock = page.getByTestId('untrusted-block');
  await expect(untrustedBlock).toContainText('cash.low_balance');
  await expect(untrustedBlock).toContainText('Checking balance is low this week');

  // Approval is offered, and is not yet granted — "before the first run".
  await expect(page.getByRole('button', { name: 'Approve this payload' })).toBeVisible();
  await expect(page.getByText('Approved for this exact payload shape')).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve this payload' }).click();
  await expect(page.getByText('Approved for this exact payload shape')).toBeVisible();
});

test('the run inspector shows the input digest and marks a verified payload', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  await page.getByTestId('run-row').filter({ hasText: 'run_done' }).click();
  await expect(page.getByTestId('input-digest')).toHaveText(INPUT_DIGEST);
  const mark = page.getByTestId('verified-mark');
  await expect(mark).toContainText('Verified');
  await expect(mark).not.toContainText('Not verified');
});

test('an in-flight local-model run can be cancelled from the inspector', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  // The live run is selected by default (most recent).
  await expect(page.getByTestId('run-detail')).toContainText('started');
  const cancelButton = page.getByTestId('cancel-run-button');
  await expect(cancelButton).toBeVisible();

  await cancelButton.click();

  await expect(page.getByTestId('run-detail')).toContainText('cancelled');
  await expect(page.getByTestId('cancellation-level')).toContainText('Level 4 (this run)');
  await expect(page.getByTestId('cancel-run-button')).toHaveCount(0);
});

test('levels 1 and 2 show their real state in words', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);

  // Read from the api, not guessed: the holder's module flag is OFF and the
  // kind flag is ON with no model configured — neither is "the last write".
  const moduleWords = page.getByTestId('module-state-words');
  await expect(moduleWords).toContainText(
    'Level 1 is off, so no advisor runs: you have switched the insights module off',
  );
  await expect(moduleWords).not.toContainText('ADVISORS_ENABLED is false');
  const moduleSwitch = page.getByRole('switch', { name: /Insights module/ });
  await expect(moduleSwitch).not.toBeChecked();

  const kindWords = page.getByTestId('kind-state-words');
  await expect(kindWords).toContainText('Level 2 is on but nothing can run');
  await expect(kindWords).toContainText('no model configured');

  // The holder's half of level 1 turns on from the screen (a step-up), and
  // the words are re-read from the api afterwards.
  await moduleSwitch.click();
  await expect(moduleWords).toContainText('Level 1 is on: the operator allows advisors');
  await expect(moduleSwitch).toBeChecked();

  await page.getByRole('button', { name: 'Disable local_model' }).click();
  await expect(kindWords).toContainText('Level 2 is off: the local_model flag is off');
});

test('the consent screen marks which scopes the advisor requests, and shows the history', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  const store = await installAdvisorMocks(page, state);
  store.grantEvents = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      advisorId: ADVISOR_ID,
      scope: 'cash.summary',
      event: 'granted',
      perRunConsent: false,
      stepUpSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      occurredAt: '2026-06-01T06:00:00.000Z',
    },
  ];

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  await expect(page.getByTestId('requested-summary')).toContainText(
    'requests 2 of the 3 scopes listed',
  );
  const unrequested = page.getByTestId('scope-row').filter({ hasText: 'risk.profile' });
  await expect(unrequested.getByTestId('scope-requested')).toContainText(
    'Not requested by this advisor',
  );
  await expect(unrequested.getByRole('checkbox')).toBeDisabled();

  await expect(page.getByTestId('grant-event')).toContainText('Granted cash.summary — ');
  await expect(page.getByTestId('grant-event')).toContainText('sign-in session aaaaaaaa');
});

test('the advisor management screen is axe clean in both themes', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectNoAxeViolations(page, `advisor management (${theme})`);
    await shoot(page, `advisor-management-${theme}`);

    await page.getByTestId('run-row').filter({ hasText: 'run_done' }).click();
    await expectNoAxeViolations(page, `advisor management, run detail (${theme})`);
    await shoot(page, `run-inspector-${theme}`);
  }
});
