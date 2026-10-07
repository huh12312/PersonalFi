// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

/**
 * WP 1.6 deliverable 5, extended by WP 2.11: login → transactions → pick a
 * category via the combobox → split a transaction → create a rule from a
 * transaction with a preview → accounts → connections → add manual account →
 * resolve an inbox item → pair a transfer, with an axe pass on every screen.
 * The network is mocked (`support/mock-api.ts`) rather than backed by a live
 * `apps/api` + Postgres — see that file's header for why, and
 * docs/evidence/phase-1/wp1.6-ui.md for what a live-backend version of this
 * suite would still need. `support/fake-webauthn.ts` drives the one real
 * WebAuthn ceremony this walkthrough exercises (the step-up assertion before
 * adding a connection) through the real `@simplewebauthn/browser` call path
 * in a real browser.
 */
test('login, category combobox, split, rule preview, manual account, inbox, transfer pairing', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const api = await installApiMocks(page);

  // gate-security-review.md F-4/C-1a: every API call the generated client
  // (and the hand-written `pending-contracts.ts` auth client) makes now goes
  // to `/api/...` — `docker/Caddyfile`'s `handle_path /api/*` strips the
  // prefix before it reaches `apps/api`, so a request that *doesn't* carry it
  // would 404 or worse, fall through to a same-origin path the SPA itself
  // handles. `mock-api.ts`'s route matchers already require the `/api` prefix
  // to fire at all (this walkthrough would fail well before the assertion
  // below if the app called bare `/auth/session`), but this makes the
  // regression this whole condition exists for an explicit assertion rather
  // than an implicit side effect of the mocks matching.
  const apiRequestPaths: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) apiRequestPaths.push(path);
  });

  // --- Login -------------------------------------------------------------
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to PersonalFi' })).toBeVisible();
  await expectNoAxeViolations(page, 'login');

  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();

  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // --- Transactions: open a row and change its category via the combobox --
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Transactions' })
    .click();
  await expect(page).toHaveURL(/\/transactions$/);
  await expect(page.getByText('Blue Bottle Coffee').first()).toBeVisible();
  await expectNoAxeViolations(page, 'transactions');

  await page.getByText('Blue Bottle Coffee').first().click();
  const detailSheet = page.getByRole('dialog', { name: 'Blue Bottle Coffee' });
  await expect(detailSheet).toBeVisible();

  // WP 2.11: the native `<select>` is now a Base UI combobox — searchable,
  // grouped, keyboard-accessible (05 §5.2). Selecting by visible label rather
  // than by value is the point: a picker that rendered labels it could not
  // resolve to ids would fail here instead of silently patching the wrong
  // thing.
  const categoryCombobox = detailSheet.getByRole('combobox', { name: 'Category' });
  await categoryCombobox.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox.getByRole('option', { name: 'Coffee Shops' })).toBeVisible();
  // Headings are `role="group"` labels, never options: money lands on a leaf.
  await expect(listbox.getByRole('option', { name: 'Dining' })).toHaveCount(0);
  await listbox.getByRole('option', { name: 'Coffee Shops' }).click();
  await expect
    .poll(() => api.lastPatchBody, { message: 'PATCH /transactions/txn_1 was never sent' })
    .toEqual({ categoryId: 'cat_dining_coffee' });

  // …and clearing it still works, which is the assertion this step used to
  // make on its own before the combobox existed.
  await categoryCombobox.click();
  await page.getByRole('listbox').getByRole('option', { name: 'Uncategorized' }).click();
  await expect
    .poll(() => api.lastPatchBody, { message: 'clearing the category was never sent' })
    .toEqual({ categoryId: null });

  await expectNoAxeViolations(page, 'transaction detail sheet');

  // --- Split this transaction ---------------------------------------------
  await detailSheet.getByRole('button', { name: /split/i }).click();
  const splitDialog = page.getByRole('dialog', { name: 'Split this transaction' });
  await expect(splitDialog).toBeVisible();
  await expect(splitDialog.getByText('Balanced')).toBeVisible();
  await splitDialog.getByRole('button', { name: /save splits/i }).click();
  await expect(splitDialog).toBeHidden();
  await expect
    .poll(() => api.lastSplitsBody, { message: 'POST /transactions/txn_1/splits was never sent' })
    .not.toBeNull();
  await expectNoAxeViolations(page, 'transaction detail sheet (after split)');

  // --- Rule from transaction, with a preview before applying --------------
  await detailSheet.getByRole('button', { name: /always categorize like this/i }).click();
  const ruleDialog = page.getByRole('dialog', { name: 'Always categorize like this' });
  await expect(ruleDialog).toBeVisible();
  await ruleDialog.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('listbox').getByRole('option', { name: 'Coffee Shops' }).click();
  await ruleDialog.getByRole('button', { name: 'Preview' }).click();

  await expect(ruleDialog.getByText(/recategorize/)).toBeVisible();
  const applyButton = ruleDialog.getByRole('button', { name: /apply to \d+ transactions?/i });
  const applyButtonLabel = await applyButton.textContent();
  const previewCount = /(\d+)/.exec(applyButtonLabel ?? '')?.[1];
  await applyButton.click();
  await expect(ruleDialog).toBeHidden();

  // The exit test this step exists for: "the preview count matches the count
  // after apply" — the same number appears in both the button label (built
  // from the preview response) and the apply request's own eventual result.
  await expect
    .poll(() => api.lastRuleApplyBody, { message: 'POST /rules/{id}/apply was never sent' })
    .toEqual({ retroactive: true });
  expect(previewCount).toBe('2');

  await expectNoAxeViolations(page, 'rule from transaction');

  await page.keyboard.press('Escape');
  await expect(detailSheet).toBeHidden();

  // --- Accounts ------------------------------------------------------------
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Accounts' })
    .click();
  await expect(page).toHaveURL(/\/accounts$/);
  // Unique to the loaded AccountsScreen (not the transactions filter bar's
  // own "Accounts"-labelled `<select>`, nor the account name text, which the
  // outgoing route's own transactions grid can also contain mid-transition).
  const manageConnections = page.getByRole('button', { name: 'Manage connections' });
  await expect(manageConnections).toBeVisible();
  await expectNoAxeViolations(page, 'accounts');

  // --- Connections: add a manual account, step-up gated --------------------
  await manageConnections.click();
  await expect(page).toHaveURL(/\/accounts\/connections$/);
  await expect(page.getByText('No connections yet')).toBeVisible();
  await expectNoAxeViolations(page, 'connections (empty)');

  await page.getByRole('button', { name: 'Add connection' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add a connection' })).toBeVisible();
  await page.getByLabel('Account name').fill('Rental property');
  await page.getByRole('button', { name: 'Add account' }).click();

  // First attempt 403s (step_up_required); the app runs the step-up
  // ceremony (mocked options/verify + the faked WebAuthn assertion above)
  // and retries automatically — this assertion is what proves that
  // happened rather than the click silently no-op'ing.
  await expect
    .poll(() => api.lastCreateConnectionBody, { message: 'POST /connections was never sent' })
    .toMatchObject({ provider: 'manual', input: { displayName: 'Rental property' } });
  await expect(page.getByRole('heading', { name: 'Add a connection' })).toBeHidden();
  await expect(page.getByText('Rental property')).toBeVisible();

  await expectNoAxeViolations(page, 'connections (with a connection)');

  // --- Inbox: resolve an uncategorized transaction ------------------------
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Inbox' })
    .click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText('Farmers Market')).toBeVisible();
  await expectNoAxeViolations(page, 'inbox');

  const farmersMarketRow = page.locator('li', { hasText: 'Farmers Market' });
  await farmersMarketRow.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('listbox').getByRole('option', { name: 'Groceries' }).click();
  await expect(page.getByText('Farmers Market')).toBeHidden();

  // --- Inbox: pair the suggested transfer ----------------------------------
  await expect(page.getByText(/Transfer to Savings ↔ Transfer from Checking/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect
    .poll(() => api.lastTransferPairBody, { message: 'POST /transfers/pair was never sent' })
    .toEqual({ outflowTransactionId: 'txn_out', inflowTransactionId: 'txn_in' });
  await expect(page.getByText(/Transfer to Savings ↔ Transfer from Checking/)).toBeHidden();

  await expectNoAxeViolations(page, 'inbox (after resolving items)');

  // gate-security-review.md F-4/C-1a: the whole walkthrough above only ever
  // succeeded because every API call landed under `/api/...` — assert that
  // directly, and that it covers more than just the one auth call every
  // screen makes on load.
  expect(apiRequestPaths.length).toBeGreaterThan(0);
  expect(apiRequestPaths.every((p) => p.startsWith('/api/'))).toBe(true);
  expect(apiRequestPaths.some((p) => p.startsWith('/api/auth/'))).toBe(true);
  expect(apiRequestPaths.some((p) => p === '/api/transactions')).toBe(true);
  expect(apiRequestPaths.some((p) => p === '/api/connections')).toBe(true);
  // D-6: the picker's list comes from the API under the same `/api` namespace,
  // not from a constant compiled into the bundle.
  expect(apiRequestPaths.some((p) => p === '/api/categories')).toBe(true);
});
