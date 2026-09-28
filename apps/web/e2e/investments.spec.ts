// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { injectAxe } from './support/axe.ts';
import type { AxeViolation } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installInvestmentsMocks } from './support/mock-investments.ts';

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

const SCREENSHOT_DIR = fileURLToPath(
  new URL('../../../docs/evidence/phase-3/screenshots/', import.meta.url),
);

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

/** `src/lib/theme.ts`'s own two effects: the stored preference and `data-theme` on `<html>`. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * The same real axe pass as `support/axe.ts`'s `expectNoAxeViolations`, with **one node
 * excluded**: the sidebar's active nav link, `a[aria-current="page"]`.
 *
 * That link is `src/app/shell/Sidebar.tsx`'s
 * `active && 'bg-accent-wash text-accent-text'`, a **shared shell file this
 * work package does not own**, and in dark mode `--accent-text` (#3987e5) on
 * `--accent-wash` (#132537) measures **4.28:1** against a 4.5:1 requirement.
 * It fires on whichever nav item is current, on every route, and is
 * reproduced on a screen this work package did not touch by
 * `'the one dark-mode axe violation is the shared sidebar, not this screen'`
 * below — which is why it is excluded here rather than treated as an
 * investments-screen defect. Recorded as a finding in
 * `docs/evidence/phase-3/wp3.11-investments-ui.md`.
 *
 * Everything else, including `color-contrast` on every element this work
 * package actually renders, stays enabled.
 */
async function expectNoAxeViolationsOutsideSharedSidebar(
  page: Page,
  screenName: string,
): Promise<void> {
  const violations: AxeViolation[] = await page.evaluate(async () => {
    const result = await window.axe.run({
      include: [['#app-content']],
      exclude: [['a[aria-current="page"]']],
    });
    return result.violations;
  });
  if (violations.length > 0) {
    throw new Error(
      `axe found ${String(violations.length)} violation(s) on ${screenName}:\n${JSON.stringify(
        violations,
        null,
        2,
      )}`,
    );
  }
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}wp3.11-${name}.png`, fullPage: true });
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
    await injectAxe(page);
    await expectNoAxeViolationsOutsideSharedSidebar(page, 'investments holdings attribution');

    // 2. Per-account detail — the crypto account specifically (a non-crypto
    // account's positions must not carry an obligation that isn't theirs).
    await page.getByRole('button', { name: 'Coinbase' }).first().click();
    await expect(page.getByTestId('position-BTC')).toBeVisible();
    await assertAttribution(page);
    await injectAxe(page);
    await expectNoAxeViolationsOutsideSharedSidebar(page, 'investments account detail attribution');
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
    await injectAxe(page);
    await expectNoAxeViolationsOutsideSharedSidebar(page, 'investments allocation attribution');

    // 4. Performance — TWR/MWR/dollar-gain are computed over the same priced
    // positions.
    await page.getByRole('tab', { name: 'Performance' }).click();
    await expect(page.getByTestId('twr-block')).toBeVisible();
    await assertAttribution(page);
    await injectAxe(page);
    await expectNoAxeViolationsOutsideSharedSidebar(page, 'investments performance attribution');
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

    // The Dashboard is not this work package's screen. When WP 3.11 wrote this
    // test an unfiltered axe run here, in dark mode, found exactly one thing —
    // the sidebar's active nav link at 4.28:1 — and this test pinned it so the
    // `expectNoAxeViolationsOutsideSharedSidebar` exclusion could be seen to
    // hide that one node and nothing else. WP 4.10 fixed the token pair
    // (15.58:1, wp4.10-plan-ui.md), so the pin flipped: the unfiltered run must
    // now find nothing at all, and the exclusion below is proven inert.
    await injectAxe(page);
    const violations: AxeViolation[] = await page.evaluate(
      async () => (await window.axe.run('#app-content')).violations,
    );
    expect(violations.map((violation) => violation.id)).toEqual([]);

    // And with the (now redundant) shared node excluded, the same answer.
    await expectNoAxeViolationsOutsideSharedSidebar(page, 'dashboard (dark, control)');
  });

  test('every investments screen is axe clean in both themes', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await loginAndReachInvestments(page);

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);

      await page.getByRole('tab', { name: 'Holdings' }).click();
      await expect(page.getByTestId('holdings-table')).toBeVisible();
      await page.getByTestId('holding-row-VTI').getByRole('button').first().click();
      await expect(page.getByTestId('holding-accounts-VTI')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(page, `investments holdings (${theme})`);
      await shoot(page, `holdings-${theme}`);

      await page.getByRole('button', { name: 'Taxable brokerage' }).first().click();
      await expect(page.getByTestId('position-VTI')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(
        page,
        `investments account detail (${theme})`,
      );
      await shoot(page, `account-detail-${theme}`);
      await page.getByRole('button', { name: 'All accounts' }).click();

      await page.getByRole('tab', { name: 'Allocation' }).click();
      await expect(page.getByTestId('allocation-legend')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(page, `investments allocation (${theme})`);
      await shoot(page, `allocation-${theme}`);

      await page.getByRole('radio', { name: 'Sector' }).click();
      await expect(page.getByTestId('allocation-slice-Diversified')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(
        page,
        `investments allocation by sector (${theme})`,
      );
      await page.getByRole('radio', { name: 'Asset class' }).click();

      await page.getByRole('tab', { name: 'Drift' }).click();
      await expect(page.getByText('Set a target allocation')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(
        page,
        `investments drift empty state (${theme})`,
      );
      await shoot(page, `drift-empty-${theme}`);

      await page.getByRole('button', { name: 'Use an example target' }).click();
      await expect(page.getByTestId('drift-table')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(
        page,
        `investments drift with targets (${theme})`,
      );
      await shoot(page, `drift-${theme}`);
      await page.getByRole('button', { name: 'Clear target' }).click();

      await page.getByRole('tab', { name: 'Performance' }).click();
      await expect(page.getByTestId('twr-block')).toBeVisible();
      await injectAxe(page);
      await expectNoAxeViolationsOutsideSharedSidebar(page, `investments performance (${theme})`);
      await shoot(page, `performance-${theme}`);
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
