// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, scanBothThemes, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';
import { installInvestmentsMocks } from './support/mock-investments.ts';
import { installNetworthMocks } from './support/mock-networth.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools } from './support/sweep.ts';

/**
 * WP 10.5: **Refresh prices** on Investments and in Settings › Market data, and the line a saved key now shows.
 *
 * `POST /api/market-data/refresh` is answered by `support/mock-market-data-keys.ts` (through both
 * `installInvestmentsMocks` and `installApiMocks`): 13 priceable holdings, 12 priced, BTC unpriced for want of a
 * CoinGecko key, one cash position no provider prices - then, as the api does inside ten minutes, `409
 * market_data.refresh_too_soon` for every call after the first.
 *
 * `evidenceDir` (C-16, O-3): a gitignored directory by default; `PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-10`
 * writes the committed `wp10.5-*.png` on purpose (run with `-g 'WP 10.5'` so no other spec's pictures move).
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

// The 409 names an instant in UTC; the page shows it in local time. Pin the zone so the words are exact.
test.use({ timezoneId: 'UTC' });

const FRESH_FRED_KEY = 'e2eFredKey0123456789abcdR5Tn'; // gitleaks:allow — synthetic canary, not a FRED key

const RESULT_WORDS =
  'Priced 12 of 13; 1 unpriced: no CoinGecko key. 1 cash or other holding is not priced by a provider.';
const TOO_SOON_WORDS = 'Prices were refreshed recently. Try again after 09:10.';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openInvestments(page: Page): Promise<void> {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Investments' })
    .click();
  await expect(page.getByRole('heading', { name: 'Investments' })).toBeVisible();
  await expect(page.getByTestId('portfolio-total')).toBeVisible();
}

async function openMarketData(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Market data' }).click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expect(page.getByTestId('market-data-key-openfigi')).toBeVisible();
}

test.describe('Refresh prices (WP 10.5)', () => {
  test('WP 10.5: Investments - Refresh prices says what was priced in words, lists the unpriced holding, reads the holdings again, and the second press is the 409', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    const state = await installInvestmentsMocks(page);
    let holdingsReads = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/holdings') holdingsReads += 1;
    });
    await openInvestments(page);
    const header = page.locator('header').filter({ hasText: 'Valuation basis' });
    const region = header.getByRole('status');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveText('');
    const readsBefore = holdingsReads;

    const refresh = header.getByRole('button', { name: 'Refresh prices' });
    await refresh.click();
    await expect(region).toHaveText(RESULT_WORDS);
    expect(state.marketDataRefresh.calls).toBe(1);
    // The holdings were read again so the new prices show.
    await expect.poll(() => holdingsReads).toBeGreaterThan(readsBefore);

    // Each unpriced holding, by symbol, with the reason in words and the api's detail.
    const disclosure = header.getByText('Which holdings were not priced (1)');
    await disclosure.click();
    await expect(header.getByRole('listitem')).toContainText(
      'BTC: no CoinGecko key — No CoinGecko key is set for this install, so no request was made.',
    );
    await hideDevtools(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `investments › Refresh prices result (${theme})`);
      await page.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.5-refresh-result-${theme}.png`,
        clip: { x: 0, y: 0, width: 1280, height: 400 },
        animations: 'disabled',
      });
    }
    await setTheme(page, 'light');

    // A second press inside ten minutes: the api says when to come back; it is not an error.
    await refresh.click();
    await expect(region).toHaveText(TOO_SOON_WORDS);
    await expect(header.getByRole('alert')).toHaveCount(0);
    await expect(refresh).toBeEnabled();
    expect(state.marketDataRefresh.calls).toBe(2);
  });

  test('WP 10.5: the button is disabled and busy while the refresh runs, and takes keyboard focus back after', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installFakeWebAuthnAssertion(page);
    const state = await installInvestmentsMocks(page);
    state.marketDataRefresh.delayMs = 1_500;
    await openInvestments(page);
    const refresh = page.getByRole('button', { name: 'Refresh prices' });
    await refresh.focus();
    await page.keyboard.press('Enter');

    const busy = page.getByRole('button', { name: 'Refreshing prices…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Refreshing prices…' })).toBeVisible();

    await expect(page.getByRole('status').filter({ hasText: 'Priced 12 of 13' })).toBeVisible();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toBeFocused();
    expect(state.marketDataRefresh.calls).toBe(1);
  });

  test('WP 10.5: Settings › Market data - a saved key says when it is used, and Refresh prices there answers in words, then with the 409', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(90_000);
    // The settings pane scrolls inside the app frame; a tall viewport keeps the cards and the result in frame.
    await page.setViewportSize({ width: 1280, height: 1900 });
    await installFakeWebAuthnAssertion(page);
    await installNetworthMocks(page);
    const api = await installApiMocks(page);
    await login(page);
    await openMarketData(page);

    const fred = page.getByTestId('market-data-key-fred');
    await expect(fred).not.toContainText('use Refresh prices to fetch now');
    await fred.getByLabel('FRED API key').fill(FRESH_FRED_KEY);
    await fred.getByRole('button', { name: 'Save with passkey' }).click();
    await expect(fred.getByRole('status')).toContainText('FRED accepted the key', {
      timeout: 15_000,
    });
    await expect(fred.getByRole('status')).toContainText(
      'Holdings sync and price refresh use this key from the next run; use Refresh prices to fetch now.',
    );

    const keys = page.getByTestId('market-data-keys');
    await keys.getByRole('button', { name: 'Refresh prices' }).click();
    await expect(keys.getByTestId('refresh-prices-result').getByRole('status')).toHaveText(
      RESULT_WORDS,
    );
    expect(api.marketDataRefresh.calls).toBe(1);
    await keys.getByText('Which holdings were not priced (1)').click();
    await expect(
      keys.getByRole('listitem').filter({ hasText: 'BTC: no CoinGecko key' }),
    ).toBeVisible();

    await hideDevtools(page);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(
        page,
        `settings › market data › key line and Refresh prices (${theme})`,
      );
      await page.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.5-settings-key-line-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await setTheme(page, 'light');

    await keys.getByRole('button', { name: 'Refresh prices' }).click();
    await expect(keys.getByTestId('refresh-prices-result').getByRole('status')).toHaveText(
      TOO_SOON_WORDS,
    );
    await expect(keys.getByRole('alert')).toHaveCount(0);
    await scanBothThemes(page, 'settings › market data › Refresh prices 409');
  });
});
