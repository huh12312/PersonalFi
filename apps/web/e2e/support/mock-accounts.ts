// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * The account routes the account-settings screen reads, and the server's staleness rule for a stored
 * projection (WP 9.2), as a layerable mock: moved out of `accounts-overrides.spec.ts` by WP 9.8 so
 * `a11y-sweep.spec.ts` can visit `/accounts/$accountId`. Install it after `installPlanMocks`;
 * `route.fallback()` hands everything else down.
 *
 * The one behaviour worth a mock of its own is the server's: a stored projection computed before the holder
 * changed an account's settings comes back `stale`, naming the change, and nothing is recomputed until the
 * holder asks (`acceptAccountChanges`). `plan-routes` and `account-overrides-routes` in `apps/api/test/db/`
 * prove the real server does exactly that.
 */

export const IRA = 'acct_ira';
export const TYPED = 'acct_typed';

export interface OverrideState {
  taxTreatment: string | null;
  role: string | null;
  valuation: string | null;
}

export const NO_OVERRIDE: OverrideState = { taxTreatment: null, role: null, valuation: null };

export const usd = (minor: string) => ({ minor, currency: 'USD' });

export const BASE = {
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

export function overlayOf(override: OverrideState) {
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

export const TYPED_OVERLAY = {
  taxTreatment: {
    effective: 'TAXABLE',
    source: 'provider_fallback',
    override: null,
    providerDefault: 'TAXABLE',
  },
  role: { effective: null, source: 'none' },
  valuation: { effective: 'holdings', source: 'default' },
};

export const PERCENTILES = [0, 1, 2].map((index) => ({
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

export const RUN = {
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

export function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * The account routes this spec's screens read, and the server's staleness rule
 * for the projection. `computedWith` is the overlay the stored run was computed
 * from — the holder had set nothing.
 */
export async function installAccountMocks(page: Page) {
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
