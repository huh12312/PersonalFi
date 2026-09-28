// SPDX-License-Identifier: MIT

import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { injectAxe } from './support/axe.ts';
import type { AxeViolation } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installNetworthMocks, SYNTHETIC_KEY_MARKER } from './support/mock-networth.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * C-16, O-3 (WP 4.12c closed it for `networth.spec.ts` and
 * `investments.spec.ts`; this file kept its own hardcoded evidence path and
 * rewrote four committed `wp3.12-*.png` on every run — the hole the Phase 5
 * planner noticed on 2026-09-28). Same mechanism as the other two specs: the
 * `evidenceDir` test option from `playwright.config.ts`, a gitignored output
 * directory by default, `PLAYWRIGHT_EVIDENCE_DIR` for a deliberate regeneration.
 */
interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

let currentEvidenceDir: string | undefined;
test.beforeEach(({ evidenceDir }) => {
  currentEvidenceDir = evidenceDir;
});

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(currentEvidenceDir)}wp3.12-${name}.png`,
    fullPage: true,
  });
}

/**
 * WP 3.12 exit tests (`docs/plan/03-phase-3-dispatch.md` §3): market-data
 * settings — the CoinGecko attribution and the "never a key value" property.
 * Against `support/mock-networth.ts` (this work package's own mock module).
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openMarketDataTab(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('tab', { name: 'Market data' }).click();
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
}

/**
 * Same known, not-owned-by-this-work-package shared-sidebar dark-mode
 * finding `networth.spec.ts` excludes — see that file's own comment. Uses
 * axe's own `exclude` **context** entry (the `a[aria-current="page"]`
 * element), the same mechanism WP 3.11's per-screen runs use — `exclude`
 * belongs on axe-core's `context` argument, not its `options` argument;
 * passing it as the second parameter to `axe.run()` silently excludes
 * nothing.
 */
async function expectAxeCleanExceptSharedSidebar(page: Page, screenName: string): Promise<void> {
  await injectAxe(page);
  const violations: AxeViolation[] = await page.evaluate(async () => {
    const result = await window.axe.run({
      include: [['#app-content']],
      exclude: [['a[aria-current="page"]']],
    });
    return result.violations;
  });
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `- [${v.impact}] ${v.id}: ${v.description}\n  ${v.nodes
            .map((n) => `${n.target.join(' ')} :: ${n.html}\n  ${n.failureSummary ?? ''}`)
            .join('\n  ')}`,
      )
      .join('\n');
    throw new Error(
      `axe found ${String(violations.length)} violation(s) on ${screenName}:\n${details}`,
    );
  }
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // See `networth.spec.ts`'s own copy of this comment: `--dur-fast` (160ms)
  // animates `color`/`background-color` on `transition-colors` elements
  // when a referenced custom property changes, so an axe color-contrast
  // scan immediately after the attribute flip can sample a genuinely
  // mid-transition frame. Outlasting the transition is a synchronization
  // fix, not a loosened assertion.
  await page.waitForTimeout(250);
}

test('the CoinGecko attribution is present on every screen showing a crypto price', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openMarketDataTab(page);

  // Screen 1: the provider list itself. CoinGecko's licence requires the
  // badge on the `settings` surface even before any price is fetched
  // (wp3.4-market-data.md §4: `surfaces: ['any_price', 'settings']`) — a
  // real assertion on the rendered attribution block, not a snapshot: the
  // exact text, a working hyperlink to coingecko.com, and a logo element.
  const providerAttribution = page.getByTestId('attribution-coingecko').first();
  await expect(providerAttribution).toBeVisible();
  await expect(providerAttribution.getByText('Data provided by CoinGecko')).toBeVisible();
  const providerLink = providerAttribution.getByRole('link');
  await expect(providerLink).toHaveAttribute('href', 'https://www.coingecko.com');
  // The logo is CoinGecko's own gecko mark, self-hosted (WP 4.12c, C-15 —
  // `public/icons/coingecko-symbol.png`); before 4.12c it was a generic
  // inline SVG glyph, which is what this line used to look for.
  await expect(providerLink.locator('img[src="/icons/coingecko-symbol.png"]')).toHaveCount(1);

  // Screen 2: the test-fetch result, which shows an actual crypto price
  // pulled live from CoinGecko. The attribution must travel with it.
  await page.getByLabel('Provider').selectOption('coingecko');
  await page.getByRole('button', { name: 'Run test fetch' }).click();
  await expect(page.getByText('64000.12')).toBeVisible();

  const resultAttribution = page.getByTestId('attribution-coingecko').nth(1);
  await expect(resultAttribution).toBeVisible();
  await expect(resultAttribution.getByText('Data provided by CoinGecko')).toBeVisible();
  await expect(resultAttribution.getByRole('link')).toHaveAttribute(
    'href',
    'https://www.coingecko.com',
  );
});

test('the settings screen never renders an API key value', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openMarketDataTab(page);

  // `{ exact: true }` — otherwise Playwright's substring match on
  // `getByText` also resolves "No key configured", a strict-mode violation
  // that has nothing to do with what this assertion is checking.
  await expect(page.getByText('Key configured', { exact: true })).toBeVisible();
  await expect(page.getByText('No key configured').first()).toBeVisible();
  await expect(page.getByText(SYNTHETIC_KEY_MARKER)).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(SYNTHETIC_KEY_MARKER);

  // Exercise every mutation this screen can make, and check again — a
  // synthetic key must stay absent after a priority save and a test fetch
  // too, not merely on first render.
  await page.getByRole('button', { name: "Move coingecko up in crypto's priority" }).click();
  // Two ladders ("crypto", "equity") each render their own "Save priority"
  // button; only the one this reorder made dirty is enabled. `disabled:
  // false` — not `.first()` — targets the one this action actually
  // affected, regardless of ladder order in the mock.
  await page.getByRole('button', { name: 'Save priority', disabled: false }).click();
  await page.getByLabel('Provider').selectOption('tiingo');
  await page.getByRole('button', { name: 'Run test fetch' }).click();
  await expect(page.getByText('skipped_no_key')).toBeVisible();

  expect(await page.locator('body').innerText()).not.toContain(SYNTHETIC_KEY_MARKER);
});

test('the market-data settings and crypto tabs are axe clean in both themes', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openMarketDataTab(page);

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectAxeCleanExceptSharedSidebar(page, `settings (market data tab, ${theme})`);
    await shoot(page, `market-data-settings-${theme}`);

    await page.getByRole('tab', { name: 'Crypto' }).click();
    await expect(page.getByRole('heading', { name: 'Coinbase (read-only)' })).toBeVisible();
    await expectAxeCleanExceptSharedSidebar(page, `settings (crypto tab, ${theme})`);
    await shoot(page, `crypto-tab-${theme}`);
    await page.getByRole('tab', { name: 'Market data' }).click();
  }
});

test('the crypto tab carries the never-ask-for-a-private-key line and the view-only warning', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openMarketDataTab(page);
  await page.getByRole('tab', { name: 'Crypto' }).click();

  await expect(
    page.getByText(/We will never ask for a private key or a seed phrase/),
  ).toBeVisible();
  await expect(page.getByText(/can_view/)).toBeVisible();
});
