// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installInvestmentsMocks } from './support/mock-investments.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools } from './support/sweep.ts';

/**
 * WP 3.11's exit tests, verbatim from `docs/plan/03-phase-3-dispatch.md` §3,
 * plus an axe pass on every screen in both themes and the evidence
 * screenshots.
 *
 * The network is mocked by `e2e/support/mock-investments.ts` (this work
 * package's own module — `mock-api.ts` and `app-walkthrough.spec.ts` are
 * off-limits to both UI agents in this wave), and the portfolio it serves is
 * the **committed spreadsheet fixture** from WP 3.3.
 */

const EXPECTED_CSV = fileURLToPath(
  new URL(
    '../../../packages/contexts/investments/test/fixtures/allocation-expected.csv',
    import.meta.url,
  ),
);

/**
 * `evidenceDir` arrives as a test option set in `playwright.config.ts`'s
 * `chromium` project (the repo-wide `process.env` ban exempts the config,
 * not `e2e/`). C-16, O-3: a gitignored output directory by default;
 * `PLAYWRIGHT_EVIDENCE_DIR` names the real evidence directory
 * (`docs/evidence/phase-3/screenshots`) for a deliberate regeneration — see
 * `support/screenshot-dir.ts`'s header.
 */
interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

interface ExpectedSlice {
  readonly key: string;
  readonly value: string;
  readonly weight: string;
}

/**
 * The `last_known` / `asset_class` block of
 * `packages/contexts/investments/test/fixtures/allocation-expected.csv`, read
 * from disk at run time rather than re-typed here. A change to the committed
 * fixture moves this assertion with it; a change to the UI's rendering breaks
 * against a file this work package does not own.
 */
function readExpectedAllocation(): { total: string; slices: ExpectedSlice[] } {
  const rows = readFileSync(EXPECTED_CSV, 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('basis,'))
    .map((line) => line.split(','))
    .filter((cells) => cells[0] === 'last_known');

  const totalRow = rows.find((cells) => cells[1] === 'portfolio' && cells[2] === 'TOTAL');
  if (totalRow === undefined)
    throw new Error('allocation-expected.csv has no last_known TOTAL row');

  return {
    total: totalRow[3] ?? '',
    slices: rows
      .filter((cells) => cells[1] === 'asset_class')
      .map((cells) => ({ key: cells[2] ?? '', value: cells[3] ?? '', weight: cells[4] ?? '' })),
  };
}

function asCurrency(decimal: string): string {
  return `$${Number(decimal).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The visible amount only — `Money.tsx` renders an `aria-hidden` formatted
 * span *and* an `sr-only` spoken-form span in the same element, so a plain
 * `textContent` read on the wrapper sees both concatenated
 * (`budget.spec.ts`'s own `visibleAmount` helper, same reason).
 */
function visible(page: Page, testId: string) {
  return page.getByTestId(testId).locator('[aria-hidden="true"]').first();
}

async function loginAndReachInvestments(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Investments' })
    .click();
  await expect(page).toHaveURL(/\/investments/);
  await expect(page.getByRole('heading', { name: 'Investments' })).toBeVisible();
}

async function shoot(page: Page, evidenceDir: string | undefined, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(evidenceDir)}wp3.11-${name}.png`,
    fullPage: true,
  });
}

test.describe('investments screen (WP 3.11)', () => {
  test('the allocation donut totals match the committed spreadsheet fixture', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    const expected = readExpectedAllocation();

    // The header total, straight from `GET /holdings`'s `total`.
    await expect(visible(page, 'portfolio-total')).toHaveText(asCurrency(expected.total));

    await page.getByRole('tab', { name: 'Allocation' }).click();
    const legend = page.getByTestId('allocation-legend');
    await expect(legend).toBeVisible();

    // Every slice of the fixture is on screen at its expected dollar value…
    for (const slice of expected.slices) {
      const row = legend.getByTestId(`allocation-slice-${slice.key}`);
      await expect(row.getByTestId('slice-value').locator('[aria-hidden="true"]')).toHaveText(
        asCurrency(slice.value),
      );
    }
    expect(expected.slices.length).toBeGreaterThan(0);
    await expect(legend.locator('li')).toHaveCount(expected.slices.length);

    // …and the spreadsheet check itself, reproduced from what the browser
    // painted: the slice amounts read back off the page sum to the total the
    // page shows. Parsed out of the rendered text, not out of the fixture.
    const rendered = await legend
      .getByTestId('slice-value')
      .locator('[aria-hidden="true"]')
      .allInnerTexts();
    const sumMinor = rendered.reduce(
      (total, text) => total + Math.round(Number(text.replace(/[$,−]/g, '')) * 100),
      0,
    );
    const totalText = await visible(page, 'portfolio-total').innerText();
    expect(sumMinor).toBe(Math.round(Number(totalText.replace(/[$,−]/g, '')) * 100));
    expect(sumMinor).toBe(Math.round(Number(expected.total) * 100));

    // `% unclassified` is beside the donut, never hidden.
    const unclassified = page.getByTestId('allocation-unclassified');
    await expect(unclassified).toBeVisible();
    await expect(unclassified.getByTestId('unclassified-pct')).toHaveText('1.7%');
  });

  test('a holding with unknown basis renders "unavailable" and not "$0.00"', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    // The aggregated row: BTC's `costBasis` is `null` and its `unrealized`
    // is `{ status: 'unavailable', gain: null, reason: 'basis_unknown' }`.
    const row = page.getByTestId('holding-row-BTC');
    await expect(row).toBeVisible();
    await expect(row.getByText('unavailable').first()).toBeVisible();
    await expect(row.getByText('cost basis unknown').first()).toBeVisible();
    expect(await row.innerText()).not.toContain('$0.00');

    // And the lot behind it, in the per-account detail.
    await page.getByRole('button', { name: 'Coinbase' }).first().click();
    const lotBasis = page.getByTestId('lot-basis-lot-btc-1');
    await expect(lotBasis).toContainText('unavailable');
    expect(await lotBasis.innerText()).not.toContain('$0.00');
    await expect(page.getByText('Transferred in without a basis')).toBeVisible();

    // The whole account panel, not just the two cells: nowhere on this screen
    // does an unknown become a zero.
    const panel = await page.getByTestId('position-BTC').innerText();
    expect(panel).not.toContain('$0.00');
  });

  test('the CoinGecko attribution is present on every investments screen showing a crypto price', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    // `wp3.14-carryovers.md` item 1: `GET /holdings` carries no
    // `attribution` field of its own — `mock-investments.ts` prices BTC
    // (`sec-btc`) with `source: 'coingecko'`, and every screen below derives
    // its obligation from that field per row (holdings, per-account) or from
    // the portfolio-level "does a coingecko-priced holding exist" signal
    // (allocation, performance — 07/`wp3.9-routes.md`'s aggregate routes
    // carry no per-row `source`).
    function assertAttribution(scope: Locator | Page) {
      const attribution = scope.getByTestId('attribution-coingecko');
      return expect(attribution).toHaveText('Data provided by CoinGecko');
    }

    // 1. Holdings table.
    await page.getByRole('tab', { name: 'Holdings' }).click();
    await expect(page.getByTestId('holdings-table')).toBeVisible();
    await assertAttribution(page);
    const holdingsLink = page.getByTestId('attribution-coingecko').getByRole('link');
    await expect(holdingsLink).toHaveAttribute('href', 'https://www.coingecko.com');
    await expectNoAxeViolations(page, 'investments holdings attribution');

    // 2. Per-account detail — the crypto account specifically (a non-crypto
    // account's positions must not carry an obligation that isn't theirs).
    await page.getByRole('button', { name: 'Coinbase' }).first().click();
    await expect(page.getByTestId('position-BTC')).toBeVisible();
    await assertAttribution(page);
    await expectNoAxeViolations(page, 'investments account detail attribution');
    await page.getByRole('button', { name: 'All accounts' }).click();

    // A non-crypto account has no CoinGecko obligation to render.
    await page.getByRole('button', { name: 'Taxable brokerage' }).first().click();
    await expect(page.getByTestId('position-VTI')).toBeVisible();
    await expect(page.getByTestId('attribution-coingecko')).toHaveCount(0);
    await page.getByRole('button', { name: 'All accounts' }).click();

    // 3. Allocation — the CRYPTO slice is a sum over the same coingecko price.
    await page.getByRole('tab', { name: 'Allocation' }).click();
    await expect(page.getByTestId('allocation-legend')).toBeVisible();
    await assertAttribution(page);
    await expectNoAxeViolations(page, 'investments allocation attribution');

    // 4. Performance — TWR/MWR/dollar-gain are computed over the same priced
    // positions.
    await page.getByRole('tab', { name: 'Performance' }).click();
    await expect(page.getByTestId('twr-block')).toBeVisible();
    await assertAttribution(page);
    await expectNoAxeViolations(page, 'investments performance attribution');
  });

  test('a stale price is visibly labeled', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    const row = page.getByTestId('holding-row-OLDCO');
    const badge = row.getByTestId('stale-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('STALE');
    await expect(badge).toHaveAttribute('title', 'Price last observed 2026-09-11');

    // Not colour alone: the label is real text, and it is there for a screen
    // reader too.
    await expect(row.getByText('Price last observed 2026-09-11')).toHaveCount(1);

    // A FRESH price carries no badge, so the badge means something.
    await expect(page.getByTestId('holding-row-VTI').getByTestId('stale-badge')).toHaveCount(0);
  });

  test('drift renders nothing when no target is set', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    await page.getByRole('tab', { name: 'Drift' }).click();

    await expect(page.getByText('Set a target allocation')).toBeVisible();
    await expect(page.getByTestId('drift-band-chart')).toHaveCount(0);
    await expect(page.getByTestId('drift-band')).toHaveCount(0);
    await expect(page.getByTestId('drift-table')).toHaveCount(0);
    await expect(page.getByTestId('drift-row-US_EQUITY')).toHaveCount(0);

    // Suppressed, not invented — and the moment a target exists the band is
    // drawn, which is what makes the absence above meaningful.
    await page.getByRole('button', { name: 'Use an example target' }).click();
    await expect(page.getByTestId('drift-band')).toBeVisible();
    await expect(page.getByText('Rebalancing band: ±5.0000 percentage points')).toBeVisible();
    await expect(page.getByTestId('drift-row-CASH')).toContainText('inside band');
    await expect(page.getByTestId('drift-row-US_EQUITY')).toContainText('outside band');
    // URL state, so the target set is linkable (TanStack Router serialises an
    // array search param as JSON).
    expect(decodeURIComponent(page.url())).toContain('target=["US_EQUITY:0.6"');
  });

  test('the untouched dashboard is axe clean in dark mode now that the shared sidebar is fixed', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);

    await page.goto('/login');
    await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
    await page.getByLabel('6-digit authenticator code').fill('123456');
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await setTheme(page, 'dark');

    // The Dashboard is not this work package's screen, but its shell is on every screen:
    // an unfiltered document scan must find nothing (WP 9.8 — no element is excluded any more).
    await expectNoAxeViolations(page, 'dashboard (dark, control)');
  });

  test('every investments screen is axe clean in both themes', async ({ page, evidenceDir }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);

      await page.getByRole('tab', { name: 'Holdings' }).click();
      await expect(page.getByTestId('holdings-table')).toBeVisible();
      await page.getByTestId('holding-row-VTI').getByRole('button').first().click();
      await expect(page.getByTestId('holding-accounts-VTI')).toBeVisible();
      await expectNoAxeViolations(page, `investments holdings (${theme})`);
      await shoot(page, evidenceDir, `holdings-${theme}`);

      await page.getByRole('button', { name: 'Taxable brokerage' }).first().click();
      await expect(page.getByTestId('position-VTI')).toBeVisible();
      await expectNoAxeViolations(page, `investments account detail (${theme})`);
      await shoot(page, evidenceDir, `account-detail-${theme}`);
      await page.getByRole('button', { name: 'All accounts' }).click();

      await page.getByRole('tab', { name: 'Allocation' }).click();
      await expect(page.getByTestId('allocation-legend')).toBeVisible();
      await expectNoAxeViolations(page, `investments allocation (${theme})`);
      await shoot(page, evidenceDir, `allocation-${theme}`);

      await page.getByRole('radio', { name: 'Sector' }).click();
      await expect(page.getByTestId('allocation-slice-Diversified')).toBeVisible();
      await expectNoAxeViolations(page, `investments allocation by sector (${theme})`);
      await page.getByRole('radio', { name: 'Asset class' }).click();

      await page.getByRole('tab', { name: 'Drift' }).click();
      await expect(page.getByText('Set a target allocation')).toBeVisible();
      await expectNoAxeViolations(page, `investments drift empty state (${theme})`);
      await shoot(page, evidenceDir, `drift-empty-${theme}`);

      await page.getByRole('button', { name: 'Use an example target' }).click();
      await expect(page.getByTestId('drift-table')).toBeVisible();
      await expectNoAxeViolations(page, `investments drift with targets (${theme})`);
      await shoot(page, evidenceDir, `drift-${theme}`);
      await page.getByRole('button', { name: 'Clear target' }).click();

      await page.getByRole('tab', { name: 'Performance' }).click();
      await expect(page.getByTestId('twr-block')).toBeVisible();
      await expectNoAxeViolations(page, `investments performance (${theme})`);
      await shoot(page, evidenceDir, `performance-${theme}`);
    }
  });

  test('TWR and MWR are labeled and never share a row with a dollar gain', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    await page.getByRole('tab', { name: 'Performance' }).click();

    const twr = page.getByTestId('twr-block');
    const mwr = page.getByTestId('mwr-block');
    const gain = page.getByTestId('dollar-gain-block');

    await expect(twr).toContainText('Time-weighted return (TWR)');
    await expect(mwr).toContainText('Money-weighted return (MWR)');
    expect(await twr.innerText()).not.toContain('$');
    expect(await mwr.innerText()).not.toContain('$');
    expect(await gain.innerText()).not.toContain('%');

    // Geometrically separate too, not merely in different DOM nodes: the
    // dollar-gain block starts below the bottom of both rate blocks.
    const twrBox = await twr.boundingBox();
    const gainBox = await gain.boundingBox();
    expect(twrBox).not.toBeNull();
    expect(gainBox).not.toBeNull();
    expect(gainBox?.y ?? 0).toBeGreaterThan((twrBox?.y ?? 0) + (twrBox?.height ?? 0));
  });

  test('the basis-method election is step-up gated and reflects the API refusal', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const state = await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    await page.getByRole('button', { name: 'Taxable brokerage' }).first().click();
    const position = page.getByTestId('position-VTI');
    await expect(position).toBeVisible();

    // VTI is an `etf`: AVERAGE_COST is not offered at all.
    const select = position.getByLabel('Cost-basis method for VTI');
    await expect(select.getByRole('option')).toHaveCount(4);
    await expect(
      select.getByRole('option', { name: 'Average cost (mutual funds only)' }),
    ).toHaveCount(0);

    await select.selectOption('HIFO');
    await position.getByRole('button', { name: 'Save election' }).click();

    await expect
      .poll(() => state.lastBasisMethodBody)
      .toEqual({ accountId: 'acct-taxable', securityId: 'sec-vti', method: 'HIFO' });
    expect(state.basisMethodRequiredStepUp).toBe(true);
  });
});

/**
 * WP 10.3: the Activity tab, the health snapshot, and performance by who
 * manages each account. Its own `shoot`, so a deliberate evidence run
 * (`PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-10 … -g "WP 10.3"`) writes
 * only `wp10.3-*.png`.
 */
async function shoot103(page: Page, evidenceDir: string | undefined, name: string): Promise<void> {
  // The dev server's router devtools are not in a production build.
  await hideDevtools(page);
  await page.screenshot({
    path: `${screenshotDir(evidenceDir)}wp10.3-${name}.png`,
    fullPage: true,
  });
}

test.describe('investment activity and performance by management (WP 10.3)', () => {
  // The app scrolls inside its main pane, so `fullPage` stops at the viewport:
  // a tall one keeps the comparison tables in the evidence frame.
  test.use({ viewport: { width: 1280, height: 1900 } });

  test('Activity lists the fixture movements, filters by type, names the account still pending, and is axe clean in both themes', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const state = await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    await page.getByRole('tab', { name: 'Activity' }).click();
    const table = page.getByTestId('activity-table');
    await expect(table).toBeVisible();
    // Seven WP 10.3 movements and WP 10.4's contribution into an unidentified fund.
    await expect(page.getByTestId('activity-row')).toHaveCount(8);
    await expect(page.getByTestId('activity-pending')).toContainText(
      'Investment activity for Coinbase has not synced yet',
    );
    // The default window is the last twelve months.
    expect(state.activityQueries[0]).toContain('from=');
    expect(state.activityQueries[0]).toContain('to=');

    // Every numeric cell is set in tabular figures (WP 10.2's rule, confirmed in the browser).
    const numeric = await table
      .locator('tbody td.tabular-nums')
      .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).fontVariantNumeric));
    expect(numeric.length).toBe(8 * 3);
    for (const value of numeric) expect(value).toContain('tabular-nums');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expect(table).toBeVisible();
      await expectNoAxeViolations(page, `investments activity (${theme})`);
      await shoot103(page, evidenceDir, `activity-${theme}`);
    }

    await page.getByLabel('Type', { exact: true }).selectOption('dividend');
    await expect(page).toHaveURL(/activityKind=dividend/);
    await expect(page.getByTestId('activity-row')).toHaveCount(1);
    await expect(page.getByTestId('activity-row').first()).toContainText('Dividend');

    await page.getByLabel('Type', { exact: true }).selectOption('fee');
    await page.getByLabel('Account', { exact: true }).selectOption({ label: 'Traditional IRA' });
    await expect(
      page.getByRole('heading', { name: 'No investment activity in this period' }),
    ).toBeVisible();
    await expectNoAxeViolations(page, 'investments activity, empty period');
  });

  test('Performance by management compares TWRs in one table and keeps MWR and dollars apart; axe clean in both themes', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    await page.getByRole('tab', { name: 'Performance' }).click();
    await expect(page.getByTestId('health-dollars')).toContainText('Net contributions');
    expect(await page.getByTestId('health-dollars').innerText()).not.toMatch(/\d%/u);
    expect(await page.getByTestId('health-twr').innerText()).not.toContain('$');

    await page.getByRole('radio', { name: 'By management' }).check();
    await expect(page).toHaveURL(/scope=management/);
    const twrTable = page.getByTestId('management-twr-table');
    await expect(twrTable).toBeVisible();
    const rows = twrTable.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Advisor');
    await expect(rows.nth(1)).toContainText('Robo-advisor');
    await expect(rows.nth(2)).toContainText('Self-directed');
    for (const text of await rows.allInnerTexts()) expect(text).not.toContain('$');
    for (const text of await page
      .getByTestId('management-dollars-table')
      .locator('tbody tr')
      .allInnerTexts()) {
      expect(text).not.toMatch(/\d%/u);
    }

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expect(twrTable).toBeVisible();
      await expectNoAxeViolations(page, `investments performance by management (${theme})`);
      await shoot103(page, evidenceDir, `performance-by-management-${theme}`);
    }

    await page.getByRole('radio', { name: 'One account' }).check();
    await expect(page).toHaveURL(/scope=account/);
    await expect(page.getByTestId('health-dollars')).toContainText('Health snapshot · ');
    await expect(page.getByTestId('twr-block')).toBeVisible();
    await expectNoAxeViolations(page, 'investments performance, one account');
  });
});

/**
 * WP 10.4: a position whose security nobody could identify is a named row, and
 * its movements stay in Activity. Its own `shoot`, so a deliberate evidence run
 * (`PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-10 … -g "WP 10.4"`) writes only
 * `wp10.4-*.png`.
 */
async function shoot104(page: Page, evidenceDir: string | undefined, name: string): Promise<void> {
  await hideDevtools(page);
  await page.screenshot({
    path: `${screenshotDir(evidenceDir)}wp10.4-${name}.png`,
    fullPage: true,
  });
}

test.describe('unidentified securities are named rows (WP 10.4)', () => {
  test.use({ viewport: { width: 1280, height: 1900 } });

  test("the Holdings tab lists the IRA's unidentified fund by name with the marker and the institution's figure; its panel and Allocation name it; axe clean in both themes", async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    const row = page.getByTestId('unresolved-row-019a0000-0000-7000-8000-0000000000f1');
    await expect(row).toBeVisible();
    // Inside the holdings table, with its seven columns.
    await expect(
      page.getByTestId('holdings-table').locator('[data-testid^="unresolved-row-"]'),
    ).toHaveCount(1);
    await expect(row.getByRole('rowheader')).toContainText('VFIFX');
    await expect(row.getByRole('rowheader')).toContainText('Vanguard Target Retirement 2050 Fund');
    await expect(row.getByRole('rowheader')).toContainText('Traditional IRA');
    await expect(row.getByTestId('unresolved-marker')).toHaveText(
      'Could not identify this security',
    );
    await expect(row.getByRole('cell').first()).toHaveText('12.5');
    await expect(row.getByTestId('institution-figure')).toContainText('$2,140.33');
    await expect(row.getByTestId('institution-figure')).toContainText("(institution's figure)");
    // The reasons, in words, behind the disclosure.
    await row.getByText('Why it could not be identified').click();
    await expect(row.getByText(/A ticker alone can name more than one security/)).toBeVisible();
    await expect(page.getByTestId('unresolved-securities')).toContainText(
      '1 position could not be identified',
    );
    // The portfolio total is the server's, unchanged: the fund is outside it.
    await expect(visible(page, 'portfolio-total')).toHaveText('$176,499.60');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expect(row).toBeVisible();
      await expectNoAxeViolations(
        page,
        `investments holdings with an unidentified fund (${theme})`,
      );
      await shoot104(page, evidenceDir, `holdings-unresolved-${theme}`);
    }
    await setTheme(page, 'light');

    // The IRA's own panel: only its rows (the account route filters), as a card.
    await page
      .getByRole('navigation', { name: 'Investment accounts' })
      .getByRole('button', { name: 'Traditional IRA' })
      .click();
    const ira = page.getByTestId('unresolved-position-019a0000-0000-7000-8000-0000000000f1');
    await expect(ira).toBeVisible();
    await expect(ira).toContainText('Could not identify this security');
    await expect(ira).toContainText("(institution's figure)");
    await expectNoAxeViolations(page, 'investments IRA panel with an unidentified fund');
    await page.getByRole('button', { name: 'All accounts' }).click();
    await page
      .getByRole('navigation', { name: 'Investment accounts' })
      .getByRole('button', { name: 'Taxable brokerage' })
      .click();
    await expect(page.getByTestId('position-VTI')).toBeVisible();
    await expect(page.locator('[data-testid^="unresolved-position-"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'All accounts' }).click();

    // Allocation names it with words for `security_unresolved`, never the raw enum.
    await page.getByRole('tab', { name: 'Allocation' }).click();
    const excluded = page.getByTestId('allocation-excluded');
    await expect(excluded).toContainText('VFIFX — the security could not be identified');
    await expect(excluded).not.toContainText('security_unresolved');
  });

  test('Activity keeps the movement in the unidentified fund under its own name, with the marker; axe clean in both themes', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    await page.getByRole('tab', { name: 'Activity' }).click();
    const marked = page
      .getByTestId('activity-row')
      .filter({ has: page.getByTestId('unresolved-marker') });
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText('VFIFX');
    await expect(marked).toContainText('Vanguard Target Retirement 2050 Fund');
    await expect(marked).toContainText('Contribution / transfer in');
    await expect(marked).toContainText('Traditional IRA');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expect(marked).toBeVisible();
      await expectNoAxeViolations(
        page,
        `investments activity with an unidentified fund (${theme})`,
      );
      await shoot104(page, evidenceDir, `activity-unresolved-${theme}`);
    }
  });
});
