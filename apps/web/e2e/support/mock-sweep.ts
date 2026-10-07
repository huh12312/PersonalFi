// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

import { installAccountMocks } from './mock-accounts.ts';
import { installAdvisorMocks } from './mock-advisors.ts';
import { installApiMocks } from './mock-api.ts';
import { installBriefMocks } from './mock-brief.ts';
import { installBudgetMocks } from './mock-budget.ts';
import { installGoalsMocks } from './mock-goals.ts';
import { installInvestmentsMocks } from './mock-investments.ts';
import { installNetworthMocks } from './mock-networth.ts';
import { installPlanMocks } from './mock-plan.ts';
import { installRecurringInsightsMocks } from './mock-recurring-insights.ts';

/**
 * The whole app behind one page, for `a11y-sweep.spec.ts` and `a11y-keyboard.spec.ts` (WP 9.8). It is the
 * *existing* per-feature mocks, layered — nothing is re-written here, so a screen is scanned with the same
 * field-for-field bodies its own spec drives:
 *
 *   `page.route` handlers registered later run first, and each mock `route.fallback()`s what it does not
 *   answer, so the last layer that knows a path wins and an unknown path reaches the catch-all below.
 *
 * The catch-all (registered first, so it runs last) answers any `/api/**` path no layer knows with a 404
 * problem body and **records it**, so the sweep can print which calls its fixtures do not cover instead of
 * letting an unmocked call fall through to the Vite proxy (a refused connection, rendered as an error
 * state — a screen the sweep would then be scanning for the wrong reason).
 */
export interface SweepMocks {
  /** `METHOD /path` of every API call no layer answered. */
  readonly unmocked: string[];
}

export interface SweepOptions {
  /**
   * The account-settings fixture (`mock-accounts.ts`: an IRA and a typed brokerage, with their override overlays)
   * answers `/api/accounts` and `/api/transactions` instead of the general one. A screen for one account needs the
   * account it is about; the list screens need the general fixture. Default `false`.
   */
  readonly accountSettings?: boolean;
}

export async function installSweepMocks(
  page: Page,
  options: SweepOptions = {},
): Promise<SweepMocks> {
  const unmocked: string[] = [];

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    unmocked.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'sweep.unmocked',
        correlationId: 'corr_sweep',
      }),
    });
  });

  // Where two layers answer the same path, the later one wins: the general fixture goes last for the paths
  // every screen shares (`/api/accounts`, `/api/transactions`, `/api/connections`, the session), the
  // feature fixtures before it for the paths only they know.
  await installBudgetMocks(page);
  await installNetworthMocks(page);
  await installInvestmentsMocks(page);
  await installRecurringInsightsMocks(page);
  await installPlanMocks(page);
  await installGoalsMocks(page);
  const base = await installApiMocks(page);
  await installAdvisorMocks(page, base);
  await installBriefMocks(page, { standalone: false });
  if (options.accountSettings === true) await installAccountMocks(page);

  return { unmocked };
}

/** Signs the mocks in (they all accept the TOTP path), from a page already on the app origin. */
export async function signIn(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch('/api/auth/totp/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
  });
}
