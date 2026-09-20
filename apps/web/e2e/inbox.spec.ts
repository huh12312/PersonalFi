// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';

const BULK_COUNT = 20;

function bulkTransaction(index: number) {
  return {
    id: `txn_bulk_${String(index)}`,
    accountId: 'acct_1',
    factId: `fact_bulk_${String(index)}`,
    date: '2026-06-01',
    amount: { minor: String(-(1000 + index)), currency: 'USD' },
    name: `Merchant ${String(index)}`,
    merchantId: null,
    merchantName: `Merchant ${String(index)}`,
    pending: false,
    excluded: false,
    categoryId: null,
    note: null,
    isTransfer: false,
    transferLinkId: null,
    refundOfId: null,
    refundConfidence: null,
    supersededById: null,
    supersededReason: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

/** WP 2.11 exit test: `e2e/inbox.spec.ts` → `'twenty items clear with keyboard only'`. */
test('twenty items clear with keyboard only', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installApiMocks(page);

  // A dedicated, larger `GET /transactions` fixture for this one test —
  // registered *after* `installApiMocks`'s own catch-all, so it runs first
  // (Playwright runs route handlers in reverse registration order) and
  // `route.fallback()`s everything it doesn't care about back to the shared
  // mock (auth, categories, the transfer-suggestion pool).
  const bulkItems = Array.from({ length: BULK_COUNT }, (_, i) => bulkTransaction(i));
  await page.route(
    (url) => url.pathname === '/api/transactions',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const query = new URL(route.request().url()).searchParams;
      if (query.get('uncategorized') === 'true') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: bulkItems,
            nextCursor: null,
            summary: { count: BULK_COUNT, totals: [] },
          }),
        });
      }
      if (query.get('transfers') === 'exclude') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], nextCursor: null, summary: { count: 0, totals: [] } }),
        });
      }
      return route.fallback();
    },
  );

  // The shared mock's transaction store only knows about its own fixture
  // ids (`txn_1`, `txn_2`, …) and 404s a PATCH to any id it has never seen —
  // correctly so, that's what a real API would do too. The bulk fixture
  // above lives only in this test, so its own PATCH route has to answer for
  // it: a bare 200 echoing the category back is enough to let
  // `useTransactionOverlayMutation`'s `onSuccess` fire, which is what
  // resolves the row in the inbox's own local state.
  await page.route(/\/api\/transactions\/txn_bulk_\d+$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON() as { categoryId?: string | null };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...bulkTransaction(0), categoryId: body.categoryId ?? null }),
    });
  });

  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Inbox' })
    .click();
  await expect(page).toHaveURL(/\/inbox$/);

  const list = page.locator('ul[aria-label="Review inbox"]');
  const rows = list.locator('> li');
  await expect(rows).toHaveCount(BULK_COUNT);
  await injectAxe(page);
  await expectNoAxeViolations(page, 'inbox (twenty items)');

  // Establish keyboard focus inside the list once — the same starting point
  // a user already Tab-navigated to from the nav — then clear every item
  // using only the keyboard from there: Tab onto the row's category
  // combobox, arrow down twice to a real category ("Uncategorized" is
  // first and is not a valid resolution — WCAG-legibly so, since clearing an
  // already-uncategorized row to itself is not "resolving" it), Enter to
  // commit. Resolving a row moves focus to whatever slides into its place
  // (`inbox-reducer.ts#resolve`), so the same four keys repeat for every
  // remaining item.
  await rows.first().focus();

  for (let remaining = BULK_COUNT; remaining > 0; remaining -= 1) {
    await expect(rows).toHaveCount(remaining);
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('combobox', { name: 'Category' }).and(page.locator(':focus')),
    ).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }

  await expect(rows).toHaveCount(0);
  await expect(page.getByText("You're all caught up")).toBeVisible();

  await injectAxe(page);
  await expectNoAxeViolations(page, 'inbox (cleared)');
});
