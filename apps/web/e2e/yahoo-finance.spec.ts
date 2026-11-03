// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installInvestmentsMocks } from './support/mock-investments.ts';
import { installNetworthMocks } from './support/mock-networth.ts';
import { installYahooRoutes, MOCK_CONSENT_TEXT } from './support/mock-yahoo.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools } from './support/sweep.ts';

/**
 * WP 12.6: Yahoo Finance through yfinance, opt-in - Settings › Market data › Yahoo Finance, and the label on a
 * Yahoo-priced holding. Against `support/mock-yahoo.ts` (layered over the networth mock for Settings and the
 * investments mock for Investments). Synthetic data only: PFTEST, never a real quote.
 *
 * `evidenceDir` (C-16, O-3): a gitignored directory by default; `PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-12`
 * with `-g 'evidence screenshots'` writes the committed `wp12.6-yahoo-*.png` on purpose.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openMarketData(page: Page): Promise<Locator> {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Market data' }).click();
  const card = page.getByTestId('yahoo-card');
  await expect(card).toBeVisible();
  return card;
}

async function setUpSettings(
  page: Page,
  options: Parameters<typeof installYahooRoutes>[1],
): Promise<Awaited<ReturnType<typeof installYahooRoutes>>> {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  const yahoo = await installYahooRoutes(page, options);
  await login(page);
  return yahoo;
}

test.describe('Yahoo Finance in Settings (WP 12.6)', () => {
  test.use({ viewport: { width: 1280, height: 1900 } });

  test('the card names Yahoo unofficial; "Use this provider" stays disabled until the consent is ticked; ticking allows a placement; unticking removes it', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const yahoo = await setUpSettings(page, { operatorEnabled: true });
    const card = await openMarketData(page);

    await expect(card.getByRole('heading', { name: 'Yahoo Finance (unofficial)' })).toBeVisible();
    await expect(card.getByTestId('yahoo-operator')).toContainText('Enabled on this install');
    await expect(card.getByTestId('attribution-yfinance')).toContainText(
      'Yahoo Finance via yfinance — unofficial, best effort',
    );
    await expect(card.getByTestId('yahoo-placements-none')).toBeVisible();

    const use = card.getByRole('button', { name: 'Use this provider' });
    await expect(use).toBeDisabled();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `settings › market data › Yahoo card (${theme})`);
    }
    await setTheme(page, 'light');

    // Tick: the consent text is the api's, verbatim; the write needs the passkey (the fake assertion answers).
    await card.getByLabel(MOCK_CONSENT_TEXT).click();
    await expect(card.getByLabel(MOCK_CONSENT_TEXT)).toBeChecked();
    await expect(use).toBeEnabled();
    expect(yahoo.calls).toEqual(['PUT /api/market-data/providers/yfinance/consent']);

    await use.click();
    await expect(card.getByTestId('yahoo-placement-equity')).toContainText(
      'Equity: 4th of 5, after Tiingo',
    );

    // Untick: Yahoo leaves every ladder at once.
    await card.getByLabel(MOCK_CONSENT_TEXT).click();
    await expect(card.getByLabel(MOCK_CONSENT_TEXT)).not.toBeChecked();
    await expect(card.getByTestId('yahoo-placements-none')).toBeVisible();
    await expect(use).toBeDisabled();
    expect(yahoo.ladders['equity']).not.toContain('yfinance');
    expect(yahoo.calls).toContain('DELETE /api/market-data/providers/yfinance/consent');
  });

  test('a holder can take Yahoo out of one ladder', async ({ page }) => {
    const yahoo = await setUpSettings(page, {
      operatorEnabled: true,
      consented: true,
      placedEquity: true,
    });
    const card = await openMarketData(page);
    await expect(card.getByTestId('yahoo-placement-equity')).toBeVisible();
    await card.getByRole('button', { name: 'Remove Yahoo Finance from the equity ladder' }).click();
    await expect(card.getByTestId('yahoo-placements-none')).toBeVisible();
    expect(yahoo.ladders['equity']).not.toContain('yfinance');
  });

  test('operator half off: says how the operator turns it on', async ({ page }) => {
    await setUpSettings(page, { operatorEnabled: false });
    const card = await openMarketData(page);
    await expect(card.getByTestId('yahoo-operator')).toContainText('Not enabled on this install');
    await expect(card.getByTestId('yahoo-operator')).toContainText('YAHOO_FINANCE_ENABLED=true');
    await expect(card.getByRole('button', { name: 'Use this provider' })).toBeDisabled();
  });

  test('evidence screenshots: the card before consent, and consented and placed, in both themes at 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(120_000);
    const states = [
      { name: 'card', options: { operatorEnabled: true } },
      {
        name: 'consented',
        options: {
          operatorEnabled: true,
          consented: true,
          placedEquity: true,
          budgetUsed: 3,
          lastOutcome: {
            operation: 'price_refresh',
            outcome: 'ok',
            at: '2026-11-02T20:05:00.000Z',
            detail: '1 of 1 securities priced (synthetic).',
            refusalCode: null,
            retryAfterMs: null,
          },
        },
      },
    ] as const;
    for (const state of states) {
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: 1900 });
        await setUpSettings(page, state.options);
        const card = await openMarketData(page);
        await hideDevtools(page);
        // No horizontal overflow of the page or of the card at this width.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        const inner = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(inner).toBeLessThanOrEqual(0);
        for (const theme of ['light', 'dark'] as const) {
          await setTheme(page, theme);
          await card.screenshot({
            path: `${screenshotDir(evidenceDir)}wp12.6-yahoo-${state.name}-${theme}-${String(width)}.png`,
          });
        }
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    }
  });
});

test.describe('Yahoo Finance label on prices (WP 12.6)', () => {
  test('a Yahoo-priced holding carries the unofficial, best-effort label', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installInvestmentsMocks(page);
    await installYahooRoutes(page, { operatorEnabled: true, yahooHolding: true });
    await login(page);
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Investments' })
      .click();
    await expect(page.getByRole('heading', { name: 'Investments' })).toBeVisible();
    await expect(page.getByText('PFTEST', { exact: true }).first()).toBeVisible();

    const badge = page.getByTestId('attribution-yfinance');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Yahoo Finance via yfinance — unofficial, best effort');
    // CoinGecko's label is for CoinGecko-priced rows only.
    await expect(page.getByTestId('attribution-coingecko')).toHaveCount(0);

    for (const tab of ['Allocation', 'Performance']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByTestId('attribution-yfinance')).toBeVisible();
    }
  });
});
