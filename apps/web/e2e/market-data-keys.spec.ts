// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { expectNoAxeViolations, scanBothThemes, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks, type MockApiState } from './support/mock-api.ts';
import type { MarketDataKeyProvider } from './support/mock-market-data-keys.ts';
import { installNetworthMocks } from './support/mock-networth.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools } from './support/sweep.ts';

/**
 * WP 10.4: a holder's own market-data keys, in Settings › Market data › API keys - the market-data twin of
 * `connections-plaid-setup.spec.ts` (WP 10.1).
 *
 * The credentials routes are `support/mock-market-data-keys.ts` (through `installApiMocks`), with real state:
 * Tiingo set by the operator's file, FRED not set, CoinGecko stored (ending in 9f2c), OpenFIGI not set and
 * anonymous. `GET /market-data/settings` is answered here from the same state, so the provider list's "Key
 * configured" moves when a key is saved - the proof that the settings query is refetched, not just the card.
 *
 * `evidenceDir` (C-16, O-3): a gitignored directory by default; `PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-10`
 * writes the committed `wp10.4-settings-market-data-{light,dark}.png` on purpose.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

const KEY = 'e2eFredKey0123456789abcdQ7Zk'; // gitleaks:allow — synthetic canary, not a FRED key
const REJECTED_KEY = 'e2eFredKey-rejected-0123456789'; // gitleaks:allow — synthetic canary

const COINGECKO_ATTRIBUTION = {
  provider: 'coingecko',
  required: true,
  text: 'Data provided by CoinGecko',
  linkUrl: 'https://www.coingecko.com',
  logoRequired: true,
  surfaces: ['any_price', 'settings'],
  clause:
    "CoinGecko Demo (free tier): 'Data provided by CoinGecko' with logo + hyperlink is a licence condition.",
  redistribution: 'permitted_with_attribution',
};

function quietAttribution(provider: string) {
  return {
    provider,
    required: false,
    text: '',
    linkUrl: null,
    logoRequired: false,
    surfaces: [],
    clause: `${provider}: no attribution required.`,
    redistribution: 'forbidden',
  };
}

const CAPABILITIES: Record<MarketDataKeyProvider, Record<string, boolean>> = {
  tiingo: { prices: true, fx: false, macro: false, search: false },
  fred: { prices: false, fx: true, macro: true, search: false },
  coingecko: { prices: true, fx: false, macro: false, search: false },
  openfigi: { prices: false, fx: false, macro: false, search: true },
};

/** `GET /market-data/settings` from the key mock's own state: `keyPresent`/`keySource` follow the cards. */
async function installSettingsFromKeys(page: Page, api: MockApiState): Promise<void> {
  await page.route('**/api/market-data/settings', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const providers = (['tiingo', 'fred', 'coingecko', 'openfigi'] as const).map((provider) => {
      const status = api.marketDataKeys.statuses[provider];
      return {
        provider,
        keyPresent: status.configured,
        keySource: status.source,
        registered: true,
        capabilities: CAPABILITIES[provider],
        budget: [{ label: 'requests/day', used: 3, limit: 500 }],
        attribution: provider === 'coingecko' ? COINGECKO_ATTRIBUTION : quietAttribution(provider),
      };
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers,
        ladders: [
          {
            securityKind: 'crypto',
            sources: [
              { source: 'user_override', rung: 1 },
              { source: 'coingecko', rung: 2 },
              { source: 'last_known', rung: 3 },
            ],
          },
        ],
        settingsAttributions: [COINGECKO_ATTRIBUTION],
        allowedHostsNarrowed: false,
      }),
    });
  });
}

async function setUp(page: Page): Promise<{ api: MockApiState; writes: string[] }> {
  await installFakeWebAuthnAssertion(page);
  // The networth mock answers the rest of the market-data screen (priority, test fetch); the general one,
  // registered after it, answers the session, the step-up and the key routes first.
  await installNetworthMocks(page);
  const api = await installApiMocks(page);
  await installSettingsFromKeys(page, api);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith('/api/') && !path.startsWith('/api/auth/'))
      writes.push(`${request.method()} ${path}`);
    if (path === '/api/auth/step-up/verify') writes.push(`${request.method()} ${path}`);
  });
  return { api, writes };
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openMarketData(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Market data' }).click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expect(page.getByTestId('market-data-key-openfigi')).toBeVisible();
}

const card = (page: Page, provider: MarketDataKeyProvider) =>
  page.getByTestId(`market-data-key-${provider}`);

test.describe('market-data API keys in Settings (WP 10.4)', () => {
  // The settings pane scrolls inside the app frame; a tall viewport keeps the cards and the provider list in frame.
  test.use({ viewport: { width: 1280, height: 1900 } });

  test('a holder saves a FRED key through the passkey step-up; the field is emptied, the key never comes back, and the provider list follows', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(90_000);
    const { api, writes } = await setUp(page);
    await login(page);
    await openMarketData(page);

    // Each state the cards draw, in words.
    await expect(card(page, 'tiingo')).toContainText("Set by the operator's secret file");
    await expect(card(page, 'fred')).toContainText('Not set.');
    await expect(card(page, 'coingecko')).toContainText('Stored in this install since');
    await expect(card(page, 'coingecko')).toContainText('ends in 9f2c');
    await expect(card(page, 'openfigi')).toContainText(
      'Not set — using OpenFIGI anonymously (10 per request)',
    );
    await expect(card(page, 'fred')).toContainText('Macro series and FX rates.');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `settings › market data › API keys (${theme})`);
      await hideDevtools(page);
      await page.screenshot({
        path: `${screenshotDir(evidenceDir)}wp10.4-settings-market-data-${theme}.png`,
        fullPage: true,
      });
    }
    await setTheme(page, 'light');

    const field = card(page, 'fred').getByLabel('FRED API key');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(KEY);
    await card(page, 'fred').getByRole('button', { name: 'Save with passkey' }).click();

    await expect(card(page, 'fred')).toContainText(`ends in ${KEY.slice(-4)}`, { timeout: 15_000 });
    await expect(card(page, 'fred').getByRole('status')).toContainText('FRED accepted the key');
    // Refused for want of a step-up, the ceremony, the retry - in that order, once each.
    expect(writes).toEqual([
      'PUT /api/market-data/providers/fred/credentials',
      'POST /api/auth/step-up/verify',
      'PUT /api/market-data/providers/fred/credentials',
    ]);
    expect(api.marketDataKeys.putBodies).toEqual([{ key: KEY }]);

    // Never echoed: not in the page, not in any field.
    await expect(field).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    expect(
      await page.evaluate(
        (key) =>
          [...document.querySelectorAll('input, textarea')].some(
            (el) => (el as HTMLInputElement).value === key,
          ),
        KEY,
      ),
    ).toBe(false);

    // `GET /market-data/settings` was refetched: FRED's row now says a stored key is in force.
    await expect(page.getByText('stored in this install', { exact: true })).toHaveCount(2);
    await scanBothThemes(page, 'settings › market data › API keys after a save');
  });

  test("a key the provider refuses shows the api's words, and the field is emptied anyway", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { api } = await setUp(page);
    await login(page);
    await openMarketData(page);

    const field = card(page, 'fred').getByLabel('FRED API key');
    await field.fill(REJECTED_KEY);
    await card(page, 'fred').getByRole('button', { name: 'Save with passkey' }).click();
    await expect(card(page, 'fred').getByRole('alert')).toContainText(
      'fred did not accept this key (HTTP 401)',
    );
    await expect(field).toHaveValue('');
    await expect(card(page, 'fred')).toContainText('Not set.');
    expect(api.marketDataKeys.statuses.fred.source).toBe('none');
    await expectNoAxeViolations(page, 'settings › market data › a refused key');
  });

  test("the operator's file is read-only, and a stored key is removed only through a confirmation and the step-up", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { writes } = await setUp(page);
    await login(page);
    await openMarketData(page);

    await expect(card(page, 'tiingo').getByRole('button')).toHaveCount(0);
    await expect(card(page, 'tiingo').getByRole('textbox')).toHaveCount(0);
    await expect(card(page, 'tiingo').locator('input')).toHaveCount(0);

    await card(page, 'coingecko').getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the stored CoinGecko key?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('This does not revoke the key at CoinGecko');
    expect(writes.filter((call) => call.startsWith('DELETE'))).toHaveLength(0);
    await scanBothThemes(page, 'settings › market data › confirm remove');

    await dialog.getByRole('button', { name: 'Remove key' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(card(page, 'coingecko')).toContainText('Not set.');
    expect(writes).toEqual([
      'DELETE /api/market-data/providers/coingecko/credentials',
      'POST /api/auth/step-up/verify',
      'DELETE /api/market-data/providers/coingecko/credentials',
    ]);
    await expect(card(page, 'coingecko').getByRole('button', { name: 'Remove' })).toHaveCount(0);
  });
});
