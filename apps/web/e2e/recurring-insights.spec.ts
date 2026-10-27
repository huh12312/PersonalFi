// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installCategoryMocks } from './support/mock-categories.ts';
import {
  EXPLAIN_LOCAL_BADGE,
  EXPLAIN_OFF_WORDS,
  EXPLAIN_REFUSED_WORDS,
  GROCERIES_EXPLANATION,
  explainBody,
  refusedBody,
  scriptExplanation,
  shownBody,
} from './support/mock-explain.ts';
import { installRecurringInsightsMocks } from './support/mock-recurring-insights.ts';
import { installPlanMocks } from './support/mock-plan.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

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
  await expectNoAxeViolations(page, 'recurring (candidates)');

  const gymRow = candidatesList(page)
    .getByRole('listitem')
    .filter({ hasText: 'Merchant merch_gy' });
  await gymRow.getByRole('button', { name: 'Reject' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/This is permanent/)).toBeVisible();
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
  await expectNoAxeViolations(page, 'insights (after dismissal)');
});

// ---------------------------------------------------------------------------
// WP 10.7: the Forward cash flow card (docs/evidence/phase-10/wp10.7-recurring-forecast-view.md)
// ---------------------------------------------------------------------------

/**
 * Layout is the bug this package fixes (three StatTiles drawn on top of one another; an x label cut off at the
 * chart's edge), and happy-dom/jsdom do not lay anything out — every box there is 0 × 0, so a unit test of
 * "these do not overlap" would pass on the broken tile too. These assertions therefore live here, on
 * `boundingBox()` in a real Chromium.
 */
type Box = { x: number; y: number; width: number; height: number };

function overlap(a: Box, b: Box): boolean {
  const e = 0.5;
  return (
    a.x < b.x + b.width - e &&
    b.x < a.x + a.width - e &&
    a.y < b.y + b.height - e &&
    b.y < a.y + a.height - e
  );
}

/** Every pair of tiles (and every pair of their labels and figures) is disjoint; no figure overflows its tile. */
async function tileProblems(page: Page, scope: ReturnType<Page['locator']>): Promise<string[]> {
  const tiles = scope.locator('[data-stat-tile]');
  const count = await tiles.count();
  const problems: string[] = [];
  const boxes: Array<{ tile: Box; label: Box; figure: Box; name: string }> = [];
  for (let n = 0; n < count; n += 1) {
    const tile = tiles.nth(n);
    // Not `isVisible()`: Playwright counts a 0 × 0 box as hidden, and a tile collapsed to 0 px is exactly the
    // failure under test. Only a tile that is not rendered at all (display:none, a closed tab) is skipped.
    const rendered = await tile.evaluate((el) =>
      el.checkVisibility({ visibilityProperty: true, opacityProperty: false }),
    );
    if (!rendered) continue;
    const tileBox = await tile.boundingBox();
    const labelBox = await tile.locator('span').first().boundingBox();
    const figure = tile.locator('[data-stat-figure]');
    const figureBox = await figure.boundingBox();
    const name = (await tile.locator('span').first().innerText()).trim();
    if (tileBox === null || labelBox === null || figureBox === null) {
      problems.push(`${name}: not laid out`);
      continue;
    }
    if (tileBox.width < 100) problems.push(`${name}: ${tileBox.width.toFixed(0)} px wide`);
    // The figure's own content (the `<Money>` span), not the figure block, which is as wide as the tile.
    const overflow = await figure.evaluate((el) => {
      const content = el.firstElementChild ?? el;
      return content.getBoundingClientRect().right - el.getBoundingClientRect().right;
    });
    if (overflow > 1)
      problems.push(`${name}: the figure overflows its tile by ${overflow.toFixed(0)} px`);
    boxes.push({ tile: tileBox, label: labelBox, figure: figureBox, name });
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      for (const part of ['tile', 'label', 'figure'] as const) {
        if (overlap(a[part], b[part]))
          problems.push(`"${a.name}" and "${b.name}" overlap (${part})`);
      }
    }
  }
  return problems;
}

/** Straight to the screen: at 390 px the primary navigation is the bottom tab bar, not the sidebar `goToRecurring` clicks. */
async function openRecurring(page: Page): Promise<void> {
  await page.goto('/recurring');
  await expect(page.getByRole('tablist', { name: 'Recurring sections' })).toBeVisible();
}

function forwardCashFlow(page: Page) {
  return page.getByTestId('forward-cash-flow');
}

function forecastChart(page: Page) {
  return forwardCashFlow(page).getByRole('img', { name: /^Projected cash flow/ });
}

async function routeForecast(page: Page, body: unknown): Promise<void> {
  await page.route('**/api/recurring/forecast*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });

function charge(
  seriesId: string,
  merchantId: string,
  date: string,
  expected: number,
  low = expected,
  high = expected,
) {
  return {
    seriesId,
    streamKey: `${merchantId}:OUTFLOW:USD:0:2026-01-01`,
    merchantId,
    type: 'SUBSCRIPTION',
    cadence: 'MONTHLY',
    sign: expected < 0 ? 'OUTFLOW' : 'INFLOW',
    status: 'ACTIVE',
    userConfirmed: true,
    confidence: 0.95,
    slot: 0,
    date,
    earliest: date,
    latest: date,
    uncertaintyDays: 1,
    expected: usd(expected),
    low: usd(low),
    high: usd(high),
  };
}

/** The screenshot's sandbox: one yearly Uber charge, next due months away, so nothing falls in the window. */
async function routeUberOnly(page: Page): Promise<void> {
  await page.route('**/api/recurring/series*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        series: [
          {
            id: 'series_uber',
            streamKey: 'merch_uber:OUTFLOW:USD:0:2025-03-02',
            merchantId: 'merch_uber',
            state: 'ACTIVE',
            status: 'ACTIVE',
            userConfirmed: true,
            cadence: 'ANNUAL',
            type: 'SUBSCRIPTION',
            sign: 'OUTFLOW',
            confidence: 0.9,
            typicalAmount: usd(-586),
            observedMin: usd(-586),
            observedMax: usd(-586),
            nextDueDate: '2027-03-02',
            firstSeen: '2025-03-02',
            lastSeen: '2026-03-02',
            duplicateNode: null,
            priceChangeEvents: [],
          },
        ],
      }),
    }),
  );
}

test.describe('WP 10.7: the Forward cash flow card', () => {
  for (const width of [1280, 390]) {
    test(`the stat strip's three figures do not overlap at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await installRecurringInsightsMocks(page);
      await login(page);
      await openRecurring(page);
      const strip = page.getByTestId('forecast-stat-strip');
      await expect(strip.locator('[data-stat-tile]')).toHaveCount(3);
      await expect(strip).toContainText('+$815.01');
      expect(await tileProblems(page, strip)).toEqual([]);
    });

    test(`StatTiles in an unsized flex row keep their width at ${String(width)} px (kitchen sink)`, async ({
      page,
    }) => {
      // The Recurring strip is a grid now, which sizes its tiles whatever the tile does; this fixture is the
      // original failure — three tiles in `flex flex-wrap`, the screenshot's +$67,498.00 and two $0.00 — so the
      // StatTile fix itself is what is under test.
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/dev/kitchen-sink');
      const row = page.getByTestId('stat-tile-flex-row').first();
      await expect(row.locator('[data-stat-tile]')).toHaveCount(3);
      await row.scrollIntoViewIfNeeded();
      expect(await tileProblems(page, row)).toEqual([]);
    });

    test(`every axis label sits inside the chart, the last x tick too, at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await installRecurringInsightsMocks(page);
      await login(page);
      await openRecurring(page);
      const svg = forecastChart(page);
      await expect(svg).toBeVisible();
      const frame = (await svg.boundingBox())!;
      const labels = svg.locator('text[data-axis]');
      const count = await labels.count();
      expect(count).toBeGreaterThanOrEqual(4);
      const xLabels = svg.locator('text[data-axis="x"]');
      await expect(xLabels.last()).toHaveText('Jul 1');
      const clipped: string[] = [];
      for (let n = 0; n < count; n += 1) {
        const box = (await labels.nth(n).boundingBox())!;
        const text = await labels.nth(n).textContent();
        if (
          box.x < frame.x - 0.5 ||
          box.y < frame.y - 0.5 ||
          box.x + box.width > frame.x + frame.width + 0.5 ||
          box.y + box.height > frame.y + frame.height + 0.5
        ) {
          clipped.push(
            `"${text ?? ''}" at ${box.x.toFixed(0)}..${(box.x + box.width).toFixed(0)} (chart ${frame.x.toFixed(0)}..${(frame.x + frame.width).toFixed(0)})`,
          );
        }
      }
      expect(clipped).toEqual([]);
      // The $0 baseline is labelled.
      await expect(svg.locator('text[data-axis="y"]', { hasText: /^\$0$/ })).toHaveCount(1);
    });
  }

  test('a mark per expected charge: on its due date, in the readout and in the table', async ({
    page,
  }) => {
    await installRecurringInsightsMocks(page);
    await login(page);
    await openRecurring(page);
    const card = forwardCashFlow(page);
    const svg = forecastChart(page);
    await expect(svg).toHaveAttribute(
      'aria-label',
      'Projected cash flow from Jun 1 to Jul 1: 6 expected charges, expected net −$1,626.99, worst case −$1,664.99.',
    );
    await svg.scrollIntoViewIfNeeded();
    const marks = svg.locator('[data-charge-mark]');
    await expect(marks).toHaveCount(6);
    await expect(svg.locator('[data-charge-mark="in"]')).toHaveCount(1);
    await expect(card.getByTestId('forecast-band')).toHaveCount(1);

    // Two charges on Jun 15: two marks, stacked in the lane at the same x.
    const phone = (await marks.nth(2).boundingBox())!;
    const water = (await marks.nth(3).boundingBox())!;
    expect(Math.abs(phone.x - water.x)).toBeLessThan(1);
    expect(water.y).toBeGreaterThan(phone.y + 4);

    await page.mouse.move(phone.x + phone.width / 2, phone.y + phone.height / 2);
    const readout = page.locator('[data-chart-readout]');
    await expect(readout).toBeVisible();
    await expect(readout).toContainText('Mon, Jun 15');
    await expect(readout).toContainText('−$65.00 Fernwave Mobile');
    await expect(readout).toContainText('−$42.00 Metro Water');
    await page.keyboard.press('Escape');

    await card.getByRole('button', { name: /^View as table/ }).click();
    const table = card.getByRole('table');
    await expect(table.getByRole('row', { name: /^Jun 15 / })).toContainText(
      'Fernwave Mobile −$65.00; Metro Water −$42.00 (−$50.00 to −$36.00)',
    );
    for (const name of [
      'Maple Court Rent −$1,450.00',
      'City Power −$85.00',
      'Card Cashback +$25.00',
      'Spotify −$9.99',
    ]) {
      await expect(table).toContainText(name);
    }
    await expectNoAxeViolations(page, 'recurring (forward cash flow, table open)');
  });

  test('no charge in the window: no line, a statement naming the stream, the strip still populated', async ({
    page,
  }) => {
    await installRecurringInsightsMocks(page);
    await routeForecast(page, {
      from: '2026-10-16',
      to: '2026-11-15',
      currency: 'USD',
      outflow: usd(0),
      inflow: usd(0),
      net: usd(0),
      netLow: usd(0),
      netHigh: usd(0),
      chargeCount: 0,
      charges: [],
    });
    await routeUberOnly(page);
    await login(page);
    await openRecurring(page);
    const card = forwardCashFlow(page);
    await expect(card.getByTestId('forecast-empty')).toContainText(
      'No charges expected in the next 30 days — 1 stream (Uber, yearly) has no due date in this window.',
    );
    // No projection drawn: no chart, no line, no readout to hover.
    await expect(card.locator('svg[role="img"]')).toHaveCount(0);
    await expect(card.locator('[data-charge-mark]')).toHaveCount(0);
    // The strip still says what it knows.
    const strip = page.getByTestId('forecast-stat-strip');
    await expect(strip).toContainText('Safe to spend');
    await expect(strip).toContainText('+$815.01');
    await expect(strip).toContainText('$0.00');
    expect(await tileProblems(page, strip)).toEqual([]);
    await expectNoAxeViolations(page, 'recurring (forward cash flow, empty window)');
  });

  test('every charge fixed: the line is drawn, the band is not, and the card says why', async ({
    page,
  }) => {
    await installRecurringInsightsMocks(page);
    await routeForecast(page, {
      from: '2026-06-01',
      to: '2026-07-01',
      currency: 'USD',
      outflow: usd(-145999),
      inflow: usd(0),
      net: usd(-145999),
      netLow: usd(-145999),
      netHigh: usd(-145999),
      chargeCount: 2,
      charges: [
        charge('series_rent', 'merch_rent', '2026-06-01', -145000),
        charge('series_spotify', 'merch_spotify', '2026-07-01', -999),
      ],
    });
    await login(page);
    await openRecurring(page);
    const card = forwardCashFlow(page);
    await expect(forecastChart(page)).toBeVisible();
    await expect(card.locator('[data-charge-mark]')).toHaveCount(2);
    await expect(card.getByTestId('forecast-band')).toHaveCount(0);
    await expect(card.getByTestId('forecast-band-note')).toHaveText(
      'No band is shaded: every charge in this window has a fixed amount, so nothing is uncertain.',
    );
  });
});

// ---------------------------------------------------------------------------
// WP 10.7 evidence: the card, and every StatTile caller, in both themes at 1280 and 390 px
// ---------------------------------------------------------------------------

/**
 * `evidenceDir` is `playwright.config.ts`'s `PLAYWRIGHT_EVIDENCE_DIR` (C-16, O-3): unset, these write to the
 * gitignored `test-results/evidence-screenshots/`; set to `docs/evidence/phase-10` to write the committed
 * `wp10.7-*.png` on purpose. Each caller is also held to the strip's own rule (no two tiles overlap, no figure
 * overflows its tile), so the pictures are not the only check that the StatTile fix did no harm elsewhere.
 */
const evidenceTest = test.extend<{ evidenceDir: string | undefined }>({
  evidenceDir: [undefined, { option: true }],
});

const THEMES = ['light', 'dark'] as const;

evidenceTest.describe('WP 10.7 evidence', () => {
  for (const width of [1280, 390]) {
    evidenceTest(
      `the Forward cash flow card at ${String(width)} px, both themes`,
      async ({ page, evidenceDir }) => {
        await page.setViewportSize({ width, height: 900 });
        await installRecurringInsightsMocks(page);
        await login(page);
        await openRecurring(page);
        await hideDevtools(page);
        const card = forwardCashFlow(page);
        await expect(forecastChart(page)).toBeVisible();
        for (const theme of THEMES) {
          await setTheme(page, theme);
          await card.screenshot({
            path: `${screenshotDir(evidenceDir)}wp10.7-forecast-${String(width)}-${theme}.png`,
            animations: 'disabled',
          });
        }
        if (width === 1280) {
          // The readout on the busiest day.
          const marks = forecastChart(page).locator('[data-charge-mark]');
          await marks.nth(2).scrollIntoViewIfNeeded();
          const box = (await marks.nth(2).boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await expect(page.locator('[data-chart-readout]')).toBeVisible();
          for (const theme of THEMES) {
            await setTheme(page, theme);
            await card.screenshot({
              path: `${screenshotDir(evidenceDir)}wp10.7-forecast-readout-${theme}.png`,
              animations: 'disabled',
            });
          }
        }
      },
    );
  }

  evidenceTest('the empty window, both themes', async ({ page, evidenceDir }) => {
    await installRecurringInsightsMocks(page);
    await routeForecast(page, {
      from: '2026-10-16',
      to: '2026-11-15',
      currency: 'USD',
      outflow: usd(0),
      inflow: usd(0),
      net: usd(0),
      netLow: usd(0),
      netHigh: usd(0),
      chargeCount: 0,
      charges: [],
    });
    await routeUberOnly(page);
    await login(page);
    await openRecurring(page);
    await hideDevtools(page);
    const card = forwardCashFlow(page);
    await expect(card.getByTestId('forecast-empty')).toBeVisible();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await card.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.7-forecast-empty-${theme}.png`,
        animations: 'disabled',
      });
    }
  });

  const callers: ReadonlyArray<{
    readonly slug: string;
    readonly path: string;
    readonly ready: (page: Page) => Promise<void>;
  }> = [
    { slug: 'dashboard', path: '/', ready: async () => {} },
    { slug: 'accounts', path: '/accounts', ready: async () => {} },
    { slug: 'investments', path: '/investments', ready: async () => {} },
    {
      slug: 'plan-compare',
      path: '/plan',
      ready: async (page) => {
        await page.getByLabel('Scenario A').selectOption('scenario-baseline');
        await page.getByLabel('Scenario B').selectOption('scenario-fork-retire-early');
        await expect(page.getByTestId('compare-delta')).toBeVisible();
      },
    },
    { slug: 'kitchen-sink', path: '/dev/kitchen-sink', ready: async () => {} },
  ];

  for (const caller of callers) {
    for (const width of [1280, 390]) {
      evidenceTest(
        `StatTile caller ${caller.slug} at ${String(width)} px, both themes`,
        async ({ page, evidenceDir }) => {
          evidenceTest.setTimeout(90_000);
          await page.setViewportSize({ width, height: 900 });
          if (caller.slug === 'plan-compare') {
            // The layered sweep mocks answer `/api/plan/scenarios` with the goals fixture's baseline alone; the
            // compare needs the plan fixture's fork too, so the plan screen gets its own spec's mocks.
            await installPlanMocks(page);
            await page.goto('/login');
            await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
            await page.getByLabel('6-digit authenticator code').fill('123456');
            await page.getByRole('button', { name: 'Verify code' }).click();
            await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
            await page.goto(caller.path);
            await expect(page.getByLabel('Scenario A')).toBeVisible();
          } else {
            await installSweepMocks(page);
            await visit(page, caller.path);
          }
          await hideDevtools(page);
          await caller.ready(page);
          const tiles = page.locator('#app-content [data-stat-tile]');
          await expect(tiles.first()).toBeVisible();
          // The kitchen sink draws every section twice (a light and a dark panel); one panel is enough.
          const scope =
            caller.slug === 'kitchen-sink'
              ? page.getByTestId('stat-tile-flex-row').first()
              : page.locator('#app-content');
          if (caller.slug === 'plan-compare') {
            expect(await tileProblems(page, page.getByTestId('compare-a'))).toEqual([]);
            expect(await tileProblems(page, page.getByTestId('compare-b'))).toEqual([]);
          } else {
            expect(await tileProblems(page, scope)).toEqual([]);
          }
          const target =
            caller.slug === 'plan-compare'
              ? page.getByTestId('compare-a').locator('xpath=..')
              : caller.slug === 'kitchen-sink'
                ? scope
                : tiles.first().locator('xpath=..');
          await target.scrollIntoViewIfNeeded();
          for (const theme of THEMES) {
            await setTheme(page, theme);
            // The plan compare and the kitchen-sink row as elements; a screen's tiles with the viewport around them.
            const shot =
              caller.slug === 'plan-compare' || caller.slug === 'kitchen-sink' ? target : page;
            await shot.screenshot({
              path: `${screenshotDir(evidenceDir)}wp10.7-tiles-${caller.slug}-${String(width)}-${theme}.png`,
              animations: 'disabled',
            });
          }
        },
      );
    }
  }
});

/**
 * WP 10.15 (V8): insight cards carry entity mentions, a value line, a bookmark and Helpful / Not helpful. The
 * whole app's mocks (`installSweepMocks`) with the category layer over them, so a mention's category screen exists.
 */
test.describe('WP 10.15 insight cards', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await installSweepMocks(page);
    await installCategoryMocks(page);
  });

  function groceriesCard(page: Page) {
    return page
      .getByRole('list', { name: 'Insights' })
      .locator('> li')
      .filter({ hasText: 'has been running higher than usual' });
  }

  test('a category mention in an insight card opens the category screen', async ({ page }) => {
    await visit(page, '/insights');
    const card = groceriesCard(page);
    await expect(card.getByTestId('insight-value-line')).toContainText('Worth');
    await expect(card.getByTestId('insight-context-line')).toHaveText('About Groceries');
    await card.getByRole('heading', { level: 2 }).getByRole('link', { name: 'Groceries' }).click();
    await expect(page).toHaveURL(/\/categories\/cat_groceries$/);
    await expect(page.getByRole('heading', { name: 'Groceries', level: 2 })).toBeVisible();
  });

  test('a bookmark persists across a reload and the Bookmarked filter keeps only it', async ({
    page,
  }) => {
    await visit(page, '/insights');
    const card = groceriesCard(page);
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) =>
          r.method() === 'POST' && /\/api\/insights\/insight_groceries\/bookmark$/.test(r.url()),
      ),
      card.getByRole('button', { name: 'Bookmark', exact: true }).click(),
    ]);
    expect(request.postDataJSON()).toEqual({ bookmarked: true });
    await expect(card.getByRole('button', { name: 'Bookmarked' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.reload();
    await expect(groceriesCard(page).getByRole('button', { name: 'Bookmarked' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Bookmarked (1)' }).click();
    await expect(page.getByRole('list', { name: 'Insights' }).locator('> li')).toHaveCount(1);
    await expectNoAxeViolations(page, 'insights (bookmarked filter)');
  });

  test('Not helpful asks why with the reason dialog and the answer persists', async ({ page }) => {
    await visit(page, '/insights');
    const card = groceriesCard(page);
    await card.getByRole('button', { name: 'Not helpful' }).click();
    const dialog = page.getByRole('dialog', { name: "Why wasn't this helpful?" });
    await expect(dialog).toBeVisible();
    await expectNoAxeViolations(page, 'insights (not helpful dialog)');
    await dialog.getByLabel('True, but I already knew').check();
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.method() === 'POST' && /\/feedback$/.test(r.url())),
      dialog.getByRole('button', { name: 'Send' }).click(),
    ]);
    expect(request.postDataJSON()).toEqual({ feedback: 'not_helpful', reasonCode: 'ALREADY_KNOW' });
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(groceriesCard(page).getByRole('button', { name: 'Not helpful' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

/**
 * WP 11.3 ("Explain this") on /insights: the whole app's mocks with `mock-explain.ts` scripting the Groceries card
 * (idle → a 202 `computing` → `shown` from the local model) and the price card (`refused`). Rendering only reads;
 * the tap asks; the evidence stays beneath whatever comes back.
 */
test.describe('WP 11.3 Explain this on /insights', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
  });

  function cardOf(page: Page, text: string) {
    return page.getByRole('list', { name: 'Insights' }).locator('> li').filter({ hasText: text });
  }

  test('WP 11.3: idle → computing → shown through a mocked 202 and a polled GET; the badge names the local model', async ({
    page,
  }) => {
    const mocks = await installSweepMocks(page);
    scriptExplanation(mocks.explain, 'insight', 'insight_groceries', {
      post: explainBody('insight', 'insight_groceries', 'computing'),
      computingReads: 2,
      result: shownBody('insight', 'insight_groceries', GROCERIES_EXPLANATION),
    });
    await visit(page, '/insights');
    const card = cardOf(page, 'has been running higher than usual');
    const button = card.getByRole('button', { name: /^Explain this/u });
    await expect(button).toBeVisible();
    await expect(card.getByRole('button', { name: 'View evidence panel' })).toBeVisible();
    // Rendering read every card's state and asked for nothing.
    await expect
      .poll(() => mocks.explain.calls.filter((c) => c.endsWith('/insight_groceries/explain')))
      .toEqual(['GET /api/insights/insight_groceries/explain']);
    expect(mocks.explain.calls.some((c) => c.startsWith('POST'))).toBe(false);

    await button.click();
    await expect(card.getByTestId('explain-live')).toHaveText('Explaining…');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');

    const explanation = card.getByTestId('explanation');
    await expect(explanation.getByTestId('explanation-text')).toHaveText(GROCERIES_EXPLANATION, {
      timeout: 15_000,
    });
    await expect(explanation.getByTestId('explanation-badge')).toHaveText(EXPLAIN_LOCAL_BADGE);
    await expect(explanation.getByText('AI-assisted wording')).toBeVisible();
    await expect(card.getByTestId('insight-evidence')).toBeVisible();
    await expect(card.getByTestId('insight-evidence')).toContainText('$420.00');
    expect(
      mocks.explain.calls.filter((c) => c === 'POST /api/insights/insight_groceries/explain'),
    ).toHaveLength(1);
    // Polling stopped once shown.
    const reads = mocks.explain.calls.length;
    await page.waitForTimeout(2_000);
    expect(mocks.explain.calls).toHaveLength(reads);
  });

  test('WP 11.3: the refused state says so in the api’s words and keeps the panel of facts beneath it', async ({
    page,
  }) => {
    const mocks = await installSweepMocks(page);
    scriptExplanation(mocks.explain, 'insight', 'insight_price', {
      initial: refusedBody('insight', 'insight_price'),
    });
    await visit(page, '/insights');
    const card = cardOf(page, 'A subscription went up in price');
    await expect(card.getByTestId('explanation-refused')).toHaveText(EXPLAIN_REFUSED_WORDS);
    await expect(card.getByTestId('explanation-badge')).toHaveCount(0);
    await expect(card.getByTestId('insight-evidence')).toBeVisible();
    await expect(card.getByTestId('insight-evidence')).toContainText('$18.99');
    expect(mocks.explain.calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  test('WP 11.3: Explain this by keyboard — Enter asks, the live region speaks, focus lands on the explanation', async ({
    page,
  }) => {
    const mocks = await installSweepMocks(page);
    scriptExplanation(mocks.explain, 'insight', 'insight_groceries', {
      post: explainBody('insight', 'insight_groceries', 'computing'),
      computingReads: 1,
      result: shownBody('insight', 'insight_groceries', GROCERIES_EXPLANATION),
    });
    await visit(page, '/insights');
    const card = cardOf(page, 'has been running higher than usual');
    const button = card.getByRole('button', { name: /^Explain this/u });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(card.getByTestId('explain-live')).toHaveText('Explaining…');
    // Busy, the button keeps focus (aria-disabled, never disabled).
    await expect(button).toBeFocused();
    await expect(card.getByTestId('explanation')).toBeFocused({ timeout: 15_000 });
    await expect(card.getByTestId('explanation-text')).toHaveText(GROCERIES_EXPLANATION);
  });

  test('WP 11.3: unavailable (the narrator Off) shows the api’s message and the ways to fix it, no retry', async ({
    page,
  }) => {
    await installSweepMocks(page);
    await visit(page, '/insights');
    const card = cardOf(page, 'has been running higher than usual');
    await card.getByRole('button', { name: /^Explain this/u }).click();
    const box = card.getByTestId('explanation');
    await expect(box).toHaveAttribute('data-explanation-state', 'unavailable');
    await expect(box).toContainText(EXPLAIN_OFF_WORDS);
    await expect(box.getByRole('link', { name: 'Advisor management' })).toHaveAttribute(
      'href',
      '/settings/advisors',
    );
    await expect(box.getByRole('link', { name: 'Settings › Language model' })).toBeVisible();
    await expect(box.getByRole('button')).toHaveCount(0);
  });
});
