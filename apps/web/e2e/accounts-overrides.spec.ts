// SPDX-License-Identifier: MIT
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installPlanMocks } from './support/mock-plan.ts';

/**
 * WP 9.2's e2e exit test (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.2"):
 * `'the holder sets an account's tax treatment by keyboard and the plan says its
 * projection is stale'`, axe-clean in both themes.
 *
 * ## The mocks are this file's own
 *
 * `support/mock-plan.ts` answers the session and every plan route; this file
 * layers the handful of account routes the new screens read on top of it
 * (`page.route` handlers registered later win, and `route.fallback()` hands
 * everything else down). Self-contained on purpose: the dispatch hands
 * `support/mock-api.ts` to the orchestrator, and a spec that needed edits there
 * could not run before them. `e2e/` carries the same handlers' shapes as
 * `docs/evidence/phase-9/wp9.2-real-data.md` §"Wiring" for the shared mock.
 *
 * The one behaviour worth a mock of its own is the server's: a stored
 * projection computed before the holder changed an account's settings comes
 * back `stale`, naming the change, and nothing is recomputed until the holder
 * asks (`acceptAccountChanges`). `plan-routes` and `account-overrides-routes`
 * in `apps/api/test/db/` prove the real server does exactly that.
 */

const IRA = 'acct_ira';
const TYPED = 'acct_typed';

interface OverrideState {
  taxTreatment: string | null;
  role: string | null;
  valuation: string | null;
}

const NO_OVERRIDE: OverrideState = { taxTreatment: null, role: null, valuation: null };

const usd = (minor: string) => ({ minor, currency: 'USD' });

const BASE = {
  connectionId: 'conn_1',
  provider: 'plaid',
  officialName: null,
  classification: 'asset',
  currency: 'USD',
  mask: null,
  closedAt: null,
  includeInNetWorth: true,
  balance: {
    current: usd('25000000'),
    available: null,
    limit: null,
    asOf: '2026-10-03T12:00:00.000Z',
    source: 'manual',
  },
};

function overlayOf(override: OverrideState) {
  return {
    taxTreatment: {
      effective: override.taxTreatment ?? 'TAX_DEFERRED',
      source: override.taxTreatment === null ? 'provider_subtype' : 'holder',
      override: override.taxTreatment,
      providerDefault: 'TAX_DEFERRED',
    },
    role: {
      effective: override.role,
      source: override.role === null ? 'none' : 'holder',
    },
    valuation: {
      effective: override.valuation ?? 'holdings',
      source: override.valuation === null ? 'default' : 'holder',
    },
  };
}

const TYPED_OVERLAY = {
  taxTreatment: {
    effective: 'TAXABLE',
    source: 'provider_fallback',
    override: null,
    providerDefault: 'TAXABLE',
  },
  role: { effective: null, source: 'none' },
  valuation: { effective: 'holdings', source: 'default' },
};

const PERCENTILES = [0, 1, 2].map((index) => ({
  index,
  age: 41 + index * 12,
  calendarYear: 2026 + index * 12,
  p5: usd(String(2_000_000 + index * 3_000_000)),
  p10: usd(String(2_500_000 + index * 3_500_000)),
  p25: usd(String(3_000_000 + index * 4_000_000)),
  p50: usd(String(4_000_000 + index * 5_000_000)),
  p75: usd(String(5_000_000 + index * 6_000_000)),
  p90: usd(String(6_000_000 + index * 7_000_000)),
  p95: usd(String(7_000_000 + index * 8_000_000)),
}));

const RUN = {
  id: 'run-baseline',
  scenarioId: 'scenario-baseline',
  scenarioKind: 'baseline',
  method: 'monte_carlo',
  seed: 'seed-baseline-1',
  paths: 10_000,
  engineVersion: 'engine-1',
  assumptionsVersion: 'assumptions-1',
  asOfDate: '2026-10-04',
  balancesSealed: true,
  currency: 'USD',
  successProbability: '0.82',
  durationMs: 412,
  createdAt: '2026-10-04T00:00:00.000Z',
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * The account routes this spec's screens read, and the server's staleness rule
 * for the projection. `computedWith` is the overlay the stored run was computed
 * from — the holder had set nothing.
 */
async function installAccountMocks(page: Page) {
  let current: OverrideState = { ...NO_OVERRIDE };
  let computedWith: OverrideState = { ...NO_OVERRIDE };
  const puts: unknown[] = [];

  const accountsBody = () => ({
    accounts: [
      {
        ...BASE,
        id: IRA,
        name: 'Rollover',
        type: 'investment',
        subtype: 'ira',
        overlay: overlayOf(current),
      },
      {
        ...BASE,
        id: TYPED,
        name: 'Typed brokerage',
        type: 'investment',
        subtype: 'brokerage',
        overlay: TYPED_OVERLAY,
        balance: { ...BASE.balance, current: usd('10000000') },
      },
    ],
  });

  const changes = () =>
    (['taxTreatment', 'role', 'valuation'] as const)
      .filter((field) => current[field] !== computedWith[field])
      .map((field) => ({
        accountId: IRA,
        field,
        from: computedWith[field],
        to: current[field],
      }));

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/accounts' && method === 'GET') {
      return route.fulfill(json(accountsBody()));
    }
    if (path === '/api/accounts/valuation' && method === 'GET') {
      return route.fulfill(
        json({
          asOfDate: '2026-10-06',
          unvalued: [
            { accountId: TYPED, name: 'Typed brokerage', reason: 'no_priced_holding' },
            ...(current.valuation === 'balance'
              ? []
              : [{ accountId: IRA, name: 'Rollover', reason: 'no_priced_holding' }]),
          ],
          byBalance: current.valuation === 'balance' ? [{ accountId: IRA, name: 'Rollover' }] : [],
        }),
      );
    }
    if (path === `/api/accounts/${IRA}/overrides` && method === 'PUT') {
      const body = request.postDataJSON() as Partial<OverrideState>;
      puts.push(body);
      current = {
        taxTreatment: body.taxTreatment ?? null,
        role: body.role ?? null,
        valuation: body.valuation ?? null,
      };
      return route.fulfill(json({ account: accountsBody().accounts[0], changed: true }));
    }
    if (path === `/api/accounts/${IRA}/overrides` && method === 'DELETE') {
      current = { ...NO_OVERRIDE };
      return route.fulfill(json({ account: accountsBody().accounts[0], changed: true }));
    }
    if (path === '/api/transactions' && method === 'GET') {
      return route.fulfill(json({ items: [], nextCursor: null, summary: null }));
    }

    const projection = /^\/api\/plan\/scenarios\/([^/]+)\/projections$/.exec(path);
    if (projection !== null && method === 'POST' && projection[1] === 'scenario-baseline') {
      const body = (request.postDataJSON() ?? {}) as { acceptAccountChanges?: boolean };
      const pending = changes();
      if (pending.length > 0 && body.acceptAccountChanges !== true) {
        // The server's rule: the stored run, as stored, stale, naming the change; nothing computed.
        return route.fulfill(
          json({
            status: 'stale',
            run: RUN,
            percentiles: PERCENTILES,
            staleness: { reason: 'account_overrides_changed', changes: pending },
          }),
        );
      }
      computedWith = { ...current };
      return route.fulfill(
        json({ status: 'computed', run: RUN, percentiles: PERCENTILES, staleness: null }),
      );
    }
    return route.fallback();
  });

  return { puts };
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // `theme.css`'s `--dur-fast` animates colours when a custom property changes, so a
  // contrast scan right after the flip can sample a mid-transition frame. Outlast it
  // (a synchronisation fix: the assertion still demands zero violations once settled).
  await page.waitForTimeout(400);
}

async function expectAxeCleanInBothThemes(page: Page, screenName: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await injectAxe(page);
    await expectNoAxeViolations(page, `${screenName} (${theme})`);
  }
  await setTheme(page, 'light');
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test.describe('account overrides (WP 9.2)', () => {
  test("the holder sets an account's tax treatment by keyboard and the plan says its projection is stale", async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const { puts } = await installAccountMocks(page);
    await login(page);

    // --- the account, as the provider describes it --------------------------------
    await page.goto(`/accounts/${IRA}`);
    await expect(page.getByRole('heading', { name: 'Rollover', level: 1 })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'How your plan treats this account' }),
    ).toBeVisible();
    // The effective value and where it came from: the provider's own subtype.
    await expect(page.getByText(/Now: Tax-deferred .* — from Plaid: ira/u)).toBeVisible();
    await expectAxeCleanInBothThemes(page, 'account settings');

    // --- set it by keyboard: focus, arrow, tab, enter ------------------------------
    const tax = page.getByLabel('Tax treatment');
    await tax.focus();
    await expect(tax).toBeFocused();
    // Options: provider default, Taxable, Tax-deferred, Roth, HSA — three steps down is Roth.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowDown');
    await expect(tax).toHaveValue('ROTH');
    // Role, Valued by, then Save.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('Tab');
    const save = page.getByRole('button', { name: 'Save settings' });
    await expect(save).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    expect(puts).toEqual([{ taxTreatment: 'ROTH', role: null, valuation: null }]);
    // Now it says the holder set it.
    await expect(page.getByText(/Now: Roth \(tax-free\) — set by you/u)).toBeVisible();

    // --- the plan says its projection is stale ------------------------------------
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plan' })
      .click();
    await expect(page).toHaveURL(/\/plan/);
    const stale = page.getByTestId('projection-stale-notice');
    await expect(stale).toBeVisible();
    await expect(stale).toContainText('This projection is out of date');
    await expect(stale).toContainText('Rollover: tax treatment was default, now Roth (tax-free)');
    // O-2: the plan also names every account it does not count — never as zero.
    const unvalued = page.getByTestId('unvalued-accounts-notice');
    await expect(unvalued).toContainText('Not counted:');
    await expect(unvalued).toContainText('Typed brokerage (no priced holdings)');
    await expect(unvalued).toContainText('not counted as zero');
    await expectAxeCleanInBothThemes(page, 'plan with a stale projection');

    // Nothing recomputed by itself: only the explicit ask clears it.
    await page.getByRole('button', { name: 'Recompute with my current settings' }).click();
    await expect(stale).toBeHidden();
  });
});
