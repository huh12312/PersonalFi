// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations, setTheme } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installNetworthMocks } from './support/mock-networth.ts';
import { installSweepMocks } from './support/mock-sweep.ts';
import { screenshotDir } from './support/screenshot-dir.ts';
import { hideDevtools, visit } from './support/sweep.ts';

/**
 * `evidenceDir` arrives as a test option set in `playwright.config.ts`'s
 * `chromium` project (the repo-wide `process.env` ban exempts the config,
 * not `e2e/` — `cold-start.spec.ts`'s own header states the same rule for
 * `coldStart`). C-16, O-3: a gitignored output directory by default;
 * `PLAYWRIGHT_EVIDENCE_DIR` names the real evidence directory
 * (`docs/evidence/phase-3/screenshots`) for a deliberate regeneration — see
 * `screenshot-dir.ts`'s header.
 */
interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

async function shoot(page: Page, evidenceDir: string | undefined, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(evidenceDir)}wp3.12-${name}.png`,
    fullPage: true,
  });
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

  // WP 10.13: at the default 3M the bars are weekly and the fixture's five days are one week that closes on a
  // USD day — the CAD day is left out *and named*. By day (1M) each currency is its own chart.
  await expect(dialog.getByTestId('net-worth-currency-note')).toContainText(
    'Not drawn at this scale: CAD',
  );
  await dialog.getByRole('button', { name: /^1M/ }).click();

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

  const dialog = page.getByRole('dialog', { name: 'Net worth over time' });
  await dialog.getByRole('button', { name: /^1Y/ }).click();
  await expect(page).toHaveURL(/netWorthRange=p1y/);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await openFullHistory(page);

  await expect(
    page.getByRole('dialog', { name: 'Net worth over time' }).getByRole('button', { name: /^1Y/ }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('the net-worth screens are axe clean in both themes', async ({ page, evidenceDir }) => {
  await installFakeWebAuthnAssertion(page);
  await installNetworthMocks(page);
  await login(page);

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectNoAxeViolations(page, `dashboard net-worth chart (${theme})`);
    await shoot(page, evidenceDir, `dashboard-chart-${theme}`);

    await openFullHistory(page);
    await expectNoAxeViolations(page, `net-worth full view (${theme})`);
    await shoot(page, evidenceDir, `full-view-${theme}`);
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

// ---------------------------------------------------------------------------
// WP 10.13 (V6): net worth stacked by account type, the scrub, the milestone notice
// ---------------------------------------------------------------------------

/**
 * Against the whole app's mocks with the stacked holder (`installSweepMocks`'s default net-worth layer: every
 * account type, two years of days up to today, today live, one undismissed $200,000 milestone). Arithmetic is
 * the unit tests'; these prove the screen: the chips switch the bucketing, the keyboard scrub drives the hero
 * and returns it, and the milestone notice stays dismissed across a reload.
 */
test.describe('WP 10.13 net worth stacked', () => {
  const widget = (page: Page) => page.locator('[data-widget="net-worth"]');

  async function openDashboard(page: Page) {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const mocks = await installSweepMocks(page);
    await visit(page, '/');
    await expect(widget(page).getByTestId('net-worth-slider')).toBeVisible();
    return mocks;
  }

  test('the period chips switch the bucketing, and the table says which', async ({ page }) => {
    await openDashboard(page);
    const card = widget(page);
    const caption = async () => {
      await card.getByRole('button', { name: /^View as table/ }).click();
      const name = (await card.locator('table caption').textContent()) ?? '';
      const rows = await card.getByRole('table').getByRole('row').count();
      await card.getByRole('button', { name: /^Hide table/ }).click();
      return { name, rows };
    };
    // 3M (the default): weekly bars, liabilities below the line.
    expect((await caption()).name).toMatch(/One bar per week \(Monday to Sunday\)/);
    await expect(card.locator('path[data-kind="liabilities"]').first()).toHaveAttribute(
      'data-side',
      'down',
    );
    await expect(card.locator('path[data-kind="property"]').first()).toHaveAttribute(
      'data-side',
      'up',
    );
    await card.getByRole('button', { name: /^1M/ }).click();
    const daily = await caption();
    expect(daily.name).toMatch(/One bar per day\./);
    expect(daily.rows).toBe(31); // header + 30 days
    await card.getByRole('button', { name: /^1Y/ }).click();
    const monthly = await caption();
    expect(monthly.name).toMatch(/One bar per month/);
    expect(monthly.rows).toBeGreaterThanOrEqual(13);
    // The legend names every account type present, with its total.
    for (const kind of ['Property', 'Cash', 'Crypto', 'Investments', 'Other', 'Liabilities']) {
      await expect(card.getByTestId('net-worth-legend')).toContainText(kind);
    }
  });

  test('scrub with the keyboard: the hero follows the selection and returns to the latest on release', async ({
    page,
  }) => {
    await openDashboard(page);
    const card = widget(page);
    const slider = card.getByTestId('net-worth-slider');
    const tile = card.locator('[data-stat-tile]').first();
    const latestHero = (await tile.textContent()) ?? '';
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    const selection = card.getByTestId('net-worth-hero-selection');
    await expect(selection).toBeVisible();
    const readoutNet = await card.getByTestId('net-worth-readout-net').innerText();
    await expect(tile).toContainText(readoutNet);
    await expect(tile).not.toHaveText(latestHero);
    await expect(card.getByTestId('net-worth-announcement')).toContainText('net worth');
    await expect(card.locator('g[data-dimmed="true"]').first()).toBeAttached();

    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuenow', '1');
    await expect(card.getByTestId('net-worth-readout-first')).toHaveCount(0);
    await page.keyboard.press('End');
    const last = await slider.getAttribute('aria-valuemax');
    await expect(slider).toHaveAttribute('aria-valuenow', last ?? '');

    await page.keyboard.press('Escape');
    await expect(selection).toHaveCount(0);
    await expect(tile).toHaveText(latestHero);
    await expect(tile).toContainText('live, may still change');

    // The pointer too: hovering selects, leaving releases.
    const surface = card.getByTestId('net-worth-scrub-surface');
    const box = await surface.boundingBox();
    await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 40);
    await expect(selection).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(selection).toHaveCount(0);
  });

  test('the full history draws the same chart, with its own hero following its own scrub', async ({
    page,
  }) => {
    await openDashboard(page);
    await page.getByRole('button', { name: 'View full history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Net worth over time' });
    await expect(dialog.getByTestId('net-worth-slider')).toBeVisible();
    await dialog.getByRole('button', { name: /^6M/ }).click();
    await expect(page).toHaveURL(/netWorthRange=p182d/);
    await dialog.getByTestId('net-worth-slider').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByTestId('net-worth-hero-selection')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog.getByTestId('net-worth-hero-selection')).toHaveCount(0);
  });

  test('the milestone notice appears once, and stays dismissed after a reload', async ({
    page,
  }) => {
    const mocks = await openDashboard(page);
    const notice = page.getByTestId('net-worth-milestone');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(/You crossed \$200,000 in net worth on [A-Z][a-z]{2} \d{1,2}/);
    await expect(notice).toHaveAttribute('role', 'status');
    await notice.getByRole('button', { name: /^Dismiss/ }).click();
    await expect(notice).toHaveCount(0);
    expect(mocks.networth.dismissedMilestones).toEqual(['01920000-0000-7000-8000-00000000d013']);
    await page.reload();
    await expect(widget(page).getByTestId('net-worth-slider')).toBeVisible();
    await expect(page.getByTestId('net-worth-milestone')).toHaveCount(0);
  });

  test('axe-clean in both themes with a bucket selected, on the dashboard and in the full history', async ({
    page,
  }) => {
    await openDashboard(page);
    await hideDevtools(page);
    await widget(page).getByTestId('net-worth-slider').focus();
    await page.keyboard.press('ArrowLeft');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `WP 10.13 dashboard, a bucket selected (${theme})`);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'View full history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Net worth over time' });
    await dialog.getByTestId('net-worth-slider').focus();
    await page.keyboard.press('ArrowLeft');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectNoAxeViolations(page, `WP 10.13 full history, a bucket selected (${theme})`);
    }
  });

  test('WP 10.13 evidence: the chart with a selection and the dashboard widget, light and dark, at 1280 and 390', async ({
    page,
    evidenceDir,
  }) => {
    test.setTimeout(180_000);
    for (const [width, height] of [
      [1280, 1100],
      [390, 2400],
    ] as const) {
      await page.setViewportSize({ width, height });
      await installSweepMocks(page);
      await visit(page, '/');
      await hideDevtools(page);
      const card = widget(page);
      await expect(card.getByTestId('net-worth-slider')).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await card.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.13-widget-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
      await page.getByRole('button', { name: 'View full history' }).click();
      const dialog = page.getByRole('dialog', { name: 'Net worth over time' });
      await dialog.getByTestId('net-worth-slider').focus();
      for (let n = 0; n < 4; n += 1) await page.keyboard.press('ArrowLeft');
      await expect(dialog.getByTestId('net-worth-hero-selection')).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.waitForTimeout(400);
        await dialog.screenshot({
          path: `${screenshotDir(evidenceDir)}wp10.13-chart-selected-${theme}-${String(width)}.png`,
          animations: 'disabled',
        });
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
  });
});
