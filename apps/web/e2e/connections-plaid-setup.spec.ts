// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { scanBothThemes } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

/**
 * WP 10.1: the holder's own Plaid keys, set up from the Add connection dialog.
 *
 * Inline mocks, in the response shape `apps/api/src/routes/provider-credentials.ts` really sends
 * (`{ configured, source, env, clientIdHint, rotatedAt, productionAllowed }`) and the listing shape
 * `GET /connectors` really sends once Plaid is usable. The shared `mock-api.ts` answers the session and
 * the rest; the routes below are registered after it, so Playwright runs them first and they fall back to
 * it for everything they do not recognise.
 *
 * Plaid Link itself (`cdn.plaid.com`) is not loaded here: the claim is that the Link card *appears* once
 * the keys are saved - no reload, no restart - and the CSP spec owns the script.
 */

const CLIENT_ID = 'e2eclientid0123456789ab'; // gitleaks:allow — synthetic canary, not a Plaid credential
const SECRET = 'e2esecretZq7f8e7d6c5b4a3928170'; // gitleaks:allow — synthetic canary, not a Plaid credential

const MANUAL = {
  provider: 'manual',
  displayName: 'Manual account',
  description: 'An account you maintain yourself.',
  iconKey: 'pencil',
  linkKind: 'manual_entry',
  docsUrl: null,
  capabilities: {
    supports: ['accounts', 'balances', 'transactions'],
    historyWindowDays: 'unbounded',
    minSyncIntervalSeconds: 0,
    refreshBudgetPerDay: null,
    supportsWebhooks: false,
    reconnectFlow: 'none',
    consentWindowDays: null,
    currencies: 'multi',
  },
};

const PLAID = {
  provider: 'plaid',
  displayName: 'Plaid',
  description: 'Link a US bank through Plaid.',
  iconKey: 'bank',
  linkKind: 'provider_hosted',
  docsUrl: null,
  capabilities: { ...MANUAL.capabilities, reconnectFlow: 'provider_hosted' },
};

interface Status {
  configured: boolean;
  source: 'files' | 'stored' | 'none';
  env: 'sandbox' | 'production' | null;
  clientIdHint: string | null;
  rotatedAt: string | null;
  productionAllowed: boolean;
}

interface PlaidMock {
  status: Status;
  fresh: boolean;
  calls: string[];
  putBodies: unknown[];
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function installPlaidCredentialMocks(page: Page, initial: Status): Promise<PlaidMock> {
  const mock: PlaidMock = { status: initial, fresh: false, calls: [], putBodies: [] };
  const stepUpRequired = json(
    { type: 'about:blank', title: 'Forbidden', status: 403, code: 'step_up_required' },
    403,
  );

  await page.route('**/api/connectors', async (route: Route) => {
    const listed = mock.status.configured || mock.status.source === 'files';
    await route.fulfill(json({ connectors: listed ? [MANUAL, PLAID] : [MANUAL] }));
  });
  await page.route('**/api/auth/step-up/verify', async (route: Route) => {
    mock.calls.push('POST /api/auth/step-up/verify');
    mock.fresh = true;
    await route.fulfill(json({ freshUntil: new Date(Date.now() + 300_000).toISOString() }));
  });
  await page.route('**/api/connections/providers/plaid/credentials', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    mock.calls.push(`${method} /api/connections/providers/plaid/credentials`);
    if (method === 'GET') return route.fulfill(json(mock.status));
    if (!mock.fresh) return route.fulfill(stepUpRequired);
    if (method === 'PUT') {
      mock.putBodies.push(request.postDataJSON());
      mock.status = {
        configured: true,
        source: 'stored',
        env: 'sandbox',
        clientIdHint: CLIENT_ID.slice(-4),
        rotatedAt: null,
        productionAllowed: false,
      };
      return route.fulfill(json(mock.status));
    }
    mock.status = {
      configured: false,
      source: 'none',
      env: null,
      clientIdHint: null,
      rotatedAt: null,
      productionAllowed: false,
    };
    return route.fulfill(json(mock.status));
  });
  return mock;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

const activeId = (page: Page): Promise<string> =>
  page.evaluate(() => document.activeElement?.id ?? '');

/**
 * Tab until the focused element satisfies `matches`; fails with where focus went. Two things seen in
 * CI and locally shape it: the dialog's initial focus may already sit on the element wanted (so the
 * check runs before the first press), and a focus move can land a beat after the key (the dialog's
 * focus guards redirect asynchronously), so each press is followed by a short settle poll rather than
 * one synchronous read.
 */
async function tabUntil(
  page: Page,
  describe: string,
  matches: () => Promise<boolean>,
  max = 14,
): Promise<void> {
  const settled = async (): Promise<boolean> => {
    for (let i = 0; i < 5; i += 1) {
      if (await matches()) return true;
      await page.waitForTimeout(40);
    }
    return false;
  };
  if (await settled()) return;
  const trail: string[] = [];
  for (let n = 0; n < max; n += 1) {
    await page.keyboard.press('Tab');
    if (await settled()) return;
    trail.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return 'body';
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
        return `${role}:${name}`;
      }),
    );
  }
  throw new Error(
    `never reached ${describe} in ${String(max)} Tab presses; focus went: ${trail.join(' → ')}`,
  );
}
test('a holder sets up Plaid from the Add connection dialog by keyboard, passes step-up, and the Link flow appears without a reload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);
  const plaid = await installPlaidCredentialMocks(page, {
    configured: false,
    source: 'none',
    env: null,
    clientIdHint: null,
    rotatedAt: null,
    productionAllowed: false,
  });
  await login(page);

  await page.goto('/accounts/connections');
  // A marker that only survives while the document does: a reload would erase it.
  await page.evaluate(() => {
    (window as unknown as { __noReload?: string }).__noReload = 'same document';
  });

  // --- open the dialog with the keyboard --------------------------------------------------------
  await page.getByRole('button', { name: 'Add connection' }).first().focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a connection' });
  await expect(dialog).toBeVisible();
  // The dialog is visible while its connectors are still loading, and the tab list only exists once
  // they have arrived; Tab presses before that never reach it (a flake seen in CI and locally).
  await expect(dialog.getByRole('tablist')).toBeVisible();

  // --- to the Plaid tab: Tab to the tab list, ArrowRight, Enter ----------------------------------
  await tabUntil(
    page,
    'the tab list',
    async () =>
      (await page.evaluate(() => document.activeElement?.getAttribute('role') ?? '')) === 'tab',
  );
  for (let n = 0; n < 3; n += 1) {
    if ((await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('Plaid'))
      break;
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Enter');

  // Set up Plaid: nothing configured, so the tab offers the form, not the Link card.
  const form = dialog.getByRole('form', { name: 'Set up Plaid' });
  await expect(form).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Connect with Plaid' })).toHaveCount(0);
  await expect(form.getByText(/Stored encrypted in this install/)).toBeVisible();
  await expect(form.getByText(/Saving asks for your passkey/)).toBeVisible();
  // Sandbox only: the api said production is not allowed.
  await expect(form.getByRole('radio')).toHaveCount(1);
  await expect(form.getByRole('radio', { name: /Sandbox/ })).toBeChecked();
  await scanBothThemes(page, 'add connection › Plaid › Set up Plaid');

  // --- fill it by keyboard -----------------------------------------------------------------------
  await tabUntil(
    page,
    'the client ID field',
    async () => (await activeId(page)) === 'plaid-client-id',
  );
  await page.keyboard.type(CLIENT_ID);
  await tabUntil(
    page,
    'the secret field',
    async () => (await activeId(page)) === 'plaid-secret',
    4,
  );
  // Paste is allowed; typing stands in for it here (a paste is the same input event to the form).
  await page.keyboard.type(SECRET);
  await expect(form.getByLabel('Plaid secret')).toHaveAttribute('type', 'password');

  // --- save: the first PUT is refused for want of a step-up; the ceremony; the retry --------------
  await tabUntil(page, 'Save and continue', async () =>
    (await page.evaluate(() => document.activeElement?.textContent ?? '')).includes(
      'Save and continue',
    ),
  );
  await page.keyboard.press('Enter');

  // The Link flow appears in the same document: Plaid is now listed and the form is gone.
  await expect(dialog.getByRole('button', { name: 'Connect with Plaid' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByRole('form', { name: 'Set up Plaid' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload)).toBe(
    'same document',
  );

  expect(plaid.calls.filter((call) => !call.startsWith('GET'))).toEqual([
    'PUT /api/connections/providers/plaid/credentials',
    'POST /api/auth/step-up/verify',
    'PUT /api/connections/providers/plaid/credentials',
  ]);
  expect(plaid.putBodies).toEqual([{ clientId: CLIENT_ID, secret: SECRET, env: 'sandbox' }]);

  // Never echoed: not in the page, not in any field.
  expect(await page.content()).not.toContain(SECRET);
  expect(
    await page.evaluate(
      (secret) =>
        [...document.querySelectorAll('input, textarea')].some(
          (el) => (el as HTMLInputElement).value === secret,
        ),
      SECRET,
    ),
  ).toBe(false);
  await expect(dialog.getByText(/client ID ends in/)).toContainText(CLIENT_ID.slice(-4));
  await scanBothThemes(page, 'add connection › Plaid › Link card with stored keys');
});

test('with stored keys the holder removes them from the dialog through a confirmation and the step-up, by keyboard', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);
  const plaid = await installPlaidCredentialMocks(page, {
    configured: true,
    source: 'stored',
    env: 'sandbox',
    clientIdHint: CLIENT_ID.slice(-4),
    rotatedAt: null,
    productionAllowed: false,
  });
  await login(page);
  await page.goto('/accounts/connections');

  await page.getByRole('button', { name: 'Add connection' }).first().focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a connection' });
  await dialog.getByRole('tab', { name: 'Plaid' }).focus();
  await page.keyboard.press('Enter');

  await expect(dialog.getByRole('button', { name: 'Connect with Plaid' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Change' })).toBeVisible();
  await scanBothThemes(page, 'add connection › Plaid › stored keys');

  await dialog.getByRole('button', { name: 'Remove' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText(/does not revoke the keys at Plaid/)).toBeVisible();
  // Nothing has been sent: the confirmation comes first.
  expect(plaid.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(0);
  await scanBothThemes(page, 'add connection › Plaid › confirm remove');

  await dialog.getByRole('button', { name: 'Remove credentials' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('form', { name: 'Set up Plaid' })).toBeVisible({ timeout: 15_000 });
  expect(plaid.calls.filter((call) => !call.startsWith('GET'))).toEqual([
    'DELETE /api/connections/providers/plaid/credentials',
    'POST /api/auth/step-up/verify',
    'DELETE /api/connections/providers/plaid/credentials',
  ]);
});

test("when the operator's files configure Plaid the dialog says so and offers no way to change them", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);
  await installPlaidCredentialMocks(page, {
    configured: true,
    source: 'files',
    env: 'sandbox',
    clientIdHint: null,
    rotatedAt: null,
    productionAllowed: false,
  });
  await login(page);
  await page.goto('/accounts/connections');

  await page.getByRole('button', { name: 'Add connection' }).first().focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a connection' });
  await dialog.getByRole('tab', { name: 'Plaid' }).focus();
  await page.keyboard.press('Enter');

  await expect(
    dialog.getByText(/configured by the operator.s secret files \(Sandbox\)/),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Connect with Plaid' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Change' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await scanBothThemes(page, 'add connection › Plaid › configured by files');
});
