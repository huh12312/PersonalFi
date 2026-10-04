// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installRecurringInsightsMocks } from './support/mock-recurring-insights.ts';

/**
 * WP 2.10 exit tests (02-phase-2-dispatch.md §3): the recurring candidate
 * queue and the insight feed's evidence panel, against
 * `support/mock-recurring-insights.ts` (this WP's own mock module — see its
 * header for why it does not reuse `support/mock-api.ts`).
 *
 * Every list lookup below is scoped through `getByRole('list', { name })`
 * rather than a bare `getByRole('listitem')` — the sidebar and bottom-tab
 * navigation (`app/shell/Sidebar.tsx`/`BottomTabs.tsx`) render their own
 * `<li>` rows on every screen, and an unscoped `listitem` query matches
 * those too.
 */

async function login(page: Page): Promise<void> {
  // `src/app/App.tsx` always renders `TanStackRouterDevtoolsPanel` (not the
  // collapsible-button variant) in dev mode, as a fixed sibling of
  // `#app-content` — the same panel `e2e/support/axe.ts`'s own header notes
  // axe has to scope away from. On a long feed with several evidence panels
  // expanded, that fixed panel can visually cover a button lower on the
  // page, and unlike axe's DOM query, a real Playwright click respects
  // actionability (nothing may occlude the target). Hiding it here is a
  // test-only style override — nothing about the app under test changes.
  // `addInitScript` (not `addStyleTag`) so the override survives this
  // suite's one `page.reload()` too, not just the first navigation.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '#root > *:not(#app-content) { display: none !important; }';
      document.head.appendChild(style);
    });
  });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function goToRecurring(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Recurring' })
    .click();
  await expect(page).toHaveURL(/\/recurring$/);
  // Settles the route swap before anything asserts absence/presence of
  // dashboard-only content — `_app.tsx`'s `<Outlet>` swap and this
  // component's own first paint are both synchronous, but the tablist only
  // exists once `RecurringScreen` itself has actually mounted.
  await expect(page.getByRole('tablist', { name: 'Recurring sections' })).toBeVisible();
}

async function goToInsights(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Insights' })
    .click();
  await expect(page).toHaveURL(/\/insights$/);
  // WP 5.14: this used to wait for a `tablist` named "Insights sections" —
  // dead since WP 5.12 moved the advisor-settings tab out to its own
  // `/settings/advisors` screen (`InsightsScreen.tsx`'s own header: "this
  // screen no longer mounts it"), which is exactly what made the wait fail
  // 100% of the time rather than flake: the element it waited for no longer
  // exists, in any run, under any load. Every test that calls this helper
  // installs mock data with at least one insight, so `RecurringScreen`'s own
  // settled-mount signal (`goToRecurring`, above) has a direct analogue
  // here: the feed's own `<ul aria-label="Insights">` list.
  await expect(page.getByRole('list', { name: 'Insights' })).toBeVisible();
}

function candidatesList(page: Page) {
  return page.getByRole('list', { name: 'Recurring candidates awaiting a decision' });
}

function seriesList(page: Page) {
  return page.getByRole('list', { name: 'Confirmed and detected recurring series' });
}

function insightsList(page: Page) {
  return page.getByRole('list', { name: 'Insights' });
}

/**
 * Direct-child insight cards only. Once a card's evidence panel is
 * expanded, it renders its own nested `<ul>`s (evidence rows, actions) whose
 * `<li>`s also carry `role="listitem"` — a bare `.getByRole('listitem')`
 * against the outer list would start matching those too, and a `.nth(n)`
 * index computed before any panel opened silently drifts once one does.
 */
function insightCards(page: Page) {
  return insightsList(page).locator('> li');
}

test('rejecting a candidate removes it and it does not return after a re-detect', async ({
  page,
}) => {
  await installRecurringInsightsMocks(page);
  await login(page);
  await goToRecurring(page);

  await expect(page.getByText('Needs your confirmation')).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'recurring (candidates)');

  const gymRow = candidatesList(page)
    .getByRole('listitem')
    .filter({ hasText: 'Merchant merch_gy' });
  await gymRow.getByRole('button', { name: 'Reject' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/This is permanent/)).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'recurring (reject dialog)');
  await dialog.getByRole('button', { name: 'Reject permanently' }).click();

  await expect(gymRow).toHaveCount(0);

  // A re-detect is a server-side consumer pass (proven at the unit/db level
  // by wp2.3-recurring.md's `lifecycle.test.ts`); what this browser-level
  // test can prove is the UI's own contract — a full reload re-fetches the
  // candidate queue from scratch, and the rejected candidate still does not
  // come back, because the mock's own state (this suite's stand-in for the
  // permanent `NOT_RECURRING` override) never re-adds it.
  await page.reload();
  await expect(page.getByText('Needs your confirmation')).toBeVisible();
  await expect(candidatesList(page).getByText('Merchant merch_gy')).toHaveCount(0);
});

test('confirming a candidate moves it into the confirmed series list', async ({ page }) => {
  await installRecurringInsightsMocks(page);
  await login(page);
  await goToRecurring(page);

  const netflixRow = candidatesList(page)
    .getByRole('listitem')
    .filter({ hasText: 'Merchant merch_ne' });
  await expect(netflixRow).toBeVisible();
  await netflixRow.getByRole('button', { name: 'Confirm' }).click();

  await expect(netflixRow).toHaveCount(0);
  await page.getByRole('tab', { name: 'Subscriptions & bills' }).click();
  await expect(seriesList(page).getByText('Merchant merch_ne')).toBeVisible();
});

test('every insight in the feed opens an evidence panel whose links resolve to real transactions', async ({
  page,
}) => {
  await installRecurringInsightsMocks(page);
  await login(page);
  await goToInsights(page);

  await expect(page.getByText('A subscription went up in price')).toBeVisible();
  await expect(page.getByText('Possible duplicate charge')).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'insights (feed)');

  const cards = insightCards(page);
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const toggle = card.getByRole('button', { name: 'View evidence panel' });
    await toggle.click();
    const panel = card.getByTestId('evidence-panel');
    await expect(panel).toBeVisible();
    // The provenance strip and at least one evidence row are present on
    // every card's panel — the §5 exit criterion's "every recommendation
    // renders a full evidence panel".
    await expect(panel.getByText('Advisor', { exact: true })).toBeVisible();
    await injectAxe(page);
    await expectNoAxeViolations(page, `insights (evidence panel ${String(index)})`);
  }

  // The duplicate-charge insight's evidence value ($54.00) must equal the
  // real transaction's own amount once the evidence link is followed — the
  // number on the evidence row was never invented independently of the
  // transaction it cites.
  const duplicateCard = cards.filter({ hasText: 'Possible duplicate charge' });
  const evidenceValue = await duplicateCard.getByTestId('evidence-value').innerText();
  expect(evidenceValue).toBe('$54.00');

  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/transactions'),
    duplicateCard.getByRole('link', { name: 'View transaction' }).click(),
  ]);
  await expect(page).toHaveURL(/\/transactions\?q=CafeSprocket/);
  const body = (await response.json()) as { items: Array<{ amount: { minor: string } }> };
  expect(body.items).toHaveLength(2);
  // $54.00 in minor units, matching the evidence row exactly.
  expect(body.items[0]!.amount.minor).toBe('-5400');
  await expect(page.getByText('CafeSprocket Coffee').first()).toBeVisible();
  await injectAxe(page);
  await expectNoAxeViolations(page, 'transactions (from evidence link)');
});

test('no insight renders an action that performs a transfer', async ({ page }) => {
  await installRecurringInsightsMocks(page);
  await login(page);
  await goToInsights(page);

  await expect(page.getByText('A subscription went up in price')).toBeVisible();

  const cards = insightCards(page);
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const toggle = cards.nth(index).getByRole('button', { name: 'View evidence panel' });
    await toggle.click();
  }

  // No button anywhere on the page performs, or is labelled as, a transfer —
  // the four `proposed_actions` kinds (`suggest_only`, `open_url`,
  // `create_goal_draft`, `create_rule_draft`) never include one, and this
  // asserts the rendered page agrees.
  await expect(page.getByRole('button', { name: /transfer/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /transfer/i })).toHaveCount(0);
});

test('dismissing an insight captures a reason and shows the cooldown notice', async ({ page }) => {
  await installRecurringInsightsMocks(page);
  await login(page);
  await goToInsights(page);

  const priceCard = insightCards(page).filter({ hasText: 'A subscription went up' });
  await priceCard.getByRole('button', { name: 'Dismiss' }).click();

  const dialog = page.getByRole('dialog');
  await injectAxe(page);
  await expectNoAxeViolations(page, 'insights (dismiss dialog)');
  // WP 5.14: this used to click a preset literally named "Not useful" — WP
  // 5.11 replaced the dialog's three free-text presets with 07 §8.3's seven
  // `reasonCode`s (`DismissReasonDialog.tsx`) concurrently with this WP's own
  // work, and no preset named "Not useful" survived the rewrite. This test
  // never asserted which reason was chosen, only that dismissing captures
  // one, so any valid option proves the same thing; "True, but I don't care
  // about this" (`DONT_CARE`) is the closest match to the original intent.
  await dialog.getByRole('radio', { name: "True, but I don't care about this" }).click();
  await dialog.getByRole('button', { name: 'Dismiss' }).click();

  const notice = page.getByTestId('cooldown-notice');
  await expect(notice).toContainText('Dismissed');
  await expect(priceCard).toHaveCount(0);
  await injectAxe(page);
  await expectNoAxeViolations(page, 'insights (after dismissal)');
});
