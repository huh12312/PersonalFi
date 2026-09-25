// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { injectAxe } from './support/axe.ts';
import type { AxeViolation } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installNetworthMocks } from './support/mock-networth.ts';

/** Same location WP 3.11's `investments.spec.ts` writes its own evidence screenshots to. */
const SCREENSHOT_DIR = fileURLToPath(
  new URL('../../../docs/evidence/phase-3/screenshots/', import.meta.url),
);

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}wp3.12-${name}.png`, fullPage: true });
}

/**
 * WP 3.12 exit tests (`docs/plan/03-phase-3-dispatch.md` §3): the net-worth
 * chart's sealed/live and per-currency behaviour. Against
 * `support/mock-networth.ts` (this work package's own mock module —
 * `mock-api.ts`/`app-walkthrough.spec.ts` are off-limits to both UI agents
 * this wave).
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openFullHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'View full history' }).click();
  await expect(page.getByRole('heading', { name: 'Net worth over time' })).toBeVisible();
}

/** Reads `Money`'s visible (aria-hidden) formatted text, not its sr-only spoken form — `budget.spec.ts`'s own convention. */
function visibleValue(page: Page, asOfDate: string) {
  return page.getByTestId(`net-worth-value-${asOfDate}`).locator('[aria-hidden="true"]');
}

/**
 * `expectNoAxeViolations` scoped past the one already-identified, not-owned-
 * by-this-work-package defect: the shared sidebar's active nav link fails
 * `color-contrast` in dark mode (`Sidebar.tsx`, `--accent-text` on
 * `--accent-wash` measuring 4.28:1 against 4.5:1) — first found and recorded
 * by WP 3.11 (`docs/evidence/phase-3/wp3.11-investments-ui.md`), reproduced
 * here because it fires on every authenticated screen's active nav item, not
 * only on investments screens. Everything else, including `color-contrast`
 * on every element this work package actually renders, stays enabled.
 *
 * Excluded via axe's own `exclude` **context** entry (the
 * `a[aria-current="page"]` element itself), the same mechanism WP 3.11's
 * per-screen runs use (`e2e/investments.spec.ts`'s
 * `expectNoAxeViolationsOutsideSharedSidebar`) — not a post-hoc filter over
 * `violation.nodes[].target]` (this file's first draft did that, and
 * separately passed `exclude` as axe's *options* argument rather than as
 * part of its *context* argument — axe-core's `run(context, options)` only
 * reads `include`/`exclude` off `context`, so neither draft actually
 * excluded anything and every run under them failed).
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
  // `theme.css`'s `--dur-fast` (160ms) animates `color`/`background-color`
  // on every `transition-colors` element (the `Button` primitive among
  // them) whenever a referenced custom property's value changes — so a
  // color-contrast axe run immediately after the attribute flip can sample
  // a genuinely mid-transition frame and report a contrast ratio (e.g.
  // "#0b0b0b" light-mode text still animating toward white on a
  // dark-mode-already-switched background) that is real for one repaint and
  // gone by the next. Outlasting the transition before scanning is a
  // synchronization fix, not a loosened assertion — the assertion still
  // demands zero violations in the settled state.
  await page.waitForTimeout(250);
}

test('a past date on the chart is unchanged after a re-sync', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openFullHistory(page);

  const sealedDay = '2026-09-01';
  const liveDay = '2026-09-05';

  await expect(visibleValue(page, sealedDay)).toHaveText('$1,000.00');
  const liveBefore = await visibleValue(page, liveDay).innerText();

  const [seriesResponse] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/net-worth/series',
    ),
    page.getByRole('button', { name: 'Refresh' }).click(),
  ]);
  expect(seriesResponse.status()).toBe(200);

  // The sealed day is byte-identical after the re-sync — the whole point of
  // sealing. The live day changed, proving this was a real second fetch and
  // not a cached response that could not have told a broken seal apart from
  // a route that never re-fetches at all.
  await expect(visibleValue(page, sealedDay)).toHaveText('$1,000.00');
  const liveAfter = await visibleValue(page, liveDay).innerText();
  expect(liveAfter).not.toBe(liveBefore);
});

test('two currencies render as two series and never one sum', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openFullHistory(page);

  // Scoped to the open dialog: the dashboard's own compact chart sits
  // underneath it (Base UI leaves background content mounted, not
  // unmounted, behind a non-modal-removal backdrop) and, correctly, shows
  // the same two-currency labels — "never a silently-summed line" applies
  // there too. Scoping to the full view avoids a strict-mode double match
  // without weakening what either screen has to prove.
  const dialog = page.getByRole('dialog', { name: 'Net worth over time' });

  await expect(dialog.getByTestId('net-worth-series-label-USD')).toBeVisible();
  await expect(dialog.getByTestId('net-worth-series-label-CAD')).toBeVisible();
  await expect(dialog.getByText(/never summed into one total, because no FX rate/)).toBeVisible();

  await expect(visibleValue(page, '2026-09-01')).toHaveText('$1,000.00');
  await expect(visibleValue(page, '2026-09-03')).toHaveText('CA$8,000.00');

  // The forbidden blended figure (100000 + 800000 minor units, mismatched
  // currencies) must never appear anywhere on the page.
  await expect(page.getByText('$9,000.00')).toHaveCount(0);
  await expect(page.getByText('900,000.00')).toHaveCount(0);
});

test('the range control round-trips through the URL and survives a reload', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);
  await openFullHistory(page);

  await page.getByRole('button', { name: '1 year' }).click();
  await expect(page).toHaveURL(/netWorthRange=p1y/);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await openFullHistory(page);

  await expect(page.getByRole('button', { name: '1 year' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the net-worth screens are axe clean in both themes', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectAxeCleanExceptSharedSidebar(page, `dashboard net-worth chart (${theme})`);
    await shoot(page, `dashboard-chart-${theme}`);

    await openFullHistory(page);
    await expectAxeCleanExceptSharedSidebar(page, `net-worth full view (${theme})`);
    await shoot(page, `full-view-${theme}`);
    await page.keyboard.press('Escape');
  }
});

/**
 * `wp3.14-carryovers.md` item 2: `features/crypto/{CoinbaseKeyForm,
 * WalletWatchOnlyForm}.tsx` (WP 3.12) were never wired into
 * `AddConnectionDialog`'s `credential_form` branch
 * (`features/connections/AddConnectionDialog.tsx`) — this deployment's two
 * `credential_form` connectors, `coinbase` and `wallet_rpc`
 * (`mock-networth.ts`'s `COINBASE_CONNECTOR`/`WALLETRPC_CONNECTOR`), rendered
 * only a "needs a credential form this pass does not build yet" placeholder
 * from the real add-connection flow. This test drives the actual dialog on
 * `/accounts/connections`, not the standalone `CryptoConnectScreen` WP 3.12
 * built as a workaround, and exercises the same step-up gate
 * `investments.spec.ts`'s basis-method test exercises for `PUT
 * /investments/basis-method` — `POST /connections` refuses once with
 * `step_up_required` before `mock-networth.ts` accepts it.
 */
test('a watch-only wallet links from the add-connection dialog and the private-key warning is shown', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installNetworthMocks(page);
  await login(page);

  await page.goto('/accounts/connections');
  // Two "Add connection" buttons render when there are no connections yet
  // (the header action and the empty state's own) — either opens the same
  // dialog, so `.first()` is a stable choice, not an arbitrary one.
  await page.getByRole('button', { name: 'Add connection' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Add a connection' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('tab', { name: 'Bitcoin / Ethereum wallet (watch-only)' }).click();

  // The never-ask-for-a-private-key line, verbatim — the wallet form's own
  // warning, not a paraphrase of it.
  await expect(
    dialog.getByText('We will never ask for a private key or a seed phrase'),
  ).toBeVisible();
  await expect(dialog.getByText('watch-only', { exact: false }).first()).toBeVisible();

  const address = '0x0000000000000000000000000000000000dEaD';
  await dialog.getByLabel('Chain').selectOption('ethereum');
  await dialog.getByLabel('Address').fill(address);
  await dialog.getByRole('button', { name: 'Add wallet' }).click();

  // Linking succeeds only after the step-up ceremony — `installFakeWebAuthnAssertion`
  // answers the passkey prompt `useStepUpRetry` triggers on the first
  // `step_up_required` refusal, then the same submit is retried once.
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => state.lastConnectionBody)
    .toEqual({ provider: 'wallet_rpc', input: { chain: 'ethereum', value: address } });
  expect(state.connectionRequiredStepUp).toBe(true);
});
