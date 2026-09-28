// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 4.11's own mock module for `e2e/plan-sliders.spec.ts` — the
 * `mock-plan.ts`/`mock-investments.ts` pattern: one `page.route('**\/*')`
 * handler, in-memory state, no live `apps/api`, no database. Not a shared
 * import of WP 4.10's `mock-plan.ts` (a *new* file only, per this WP's
 * ownership, and two concurrently-landing WPs editing the same support file
 * is exactly the collision this repo's own orchestration notes warn about) —
 * so the route set below is trimmed to what `/plan` actually needs to reach
 * a rendered screen with `GoalSliders` visible: login, the sidebar's sync
 * pill, scenarios, one projection, assumptions and life events. No
 * required-savings or compare routes — this suite never drives those UI
 * paths.
 */

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'totp',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function usd(minor: string) {
  return { minor, currency: 'USD' };
}

const BASELINE_SCENARIO = {
  kind: 'baseline' as const,
  id: 'scenario-baseline',
  name: 'Baseline',
  profile: {
    birthDate: '1985-04-12',
    retirementAge: 65,
    planEndAge: 95,
    currency: 'USD',
    glidepath: { kind: 'age_based' as const },
    contributionGrowth: 'wage' as const,
    annualSpending: null,
    withdrawalPolicy: 'guardrails' as const,
    spendingFloor: 'essential_spend' as const,
    taxDeferredRate: '0.22',
    socialSecurity: null,
    pensions: [],
    contributions: null,
  },
  seed: 'seed-baseline-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const PERCENTILES = [
  {
    index: 0,
    age: 41,
    calendarYear: 2026,
    p5: usd('2500000'),
    p10: usd('3000000'),
    p25: usd('3500000'),
    p50: usd('4000000'),
    p75: usd('4500000'),
    p90: usd('5000000'),
    p95: usd('5500000'),
  },
  {
    index: 1,
    age: 65,
    calendarYear: 2050,
    p5: usd('9000000'),
    p10: usd('12000000'),
    p25: usd('15000000'),
    p50: usd('18000000'),
    p75: usd('21000000'),
    p90: usd('24000000'),
    p95: usd('27000000'),
  },
];

function projectionRun(scenarioId: string) {
  return {
    status: 'computed' as const,
    run: {
      id: `run-${scenarioId}`,
      scenarioId,
      scenarioKind: 'baseline' as const,
      method: 'monte_carlo' as const,
      seed: 'seed-baseline-1',
      paths: 10_000,
      engineVersion: 'engine-1',
      assumptionsVersion: 'assumptions-1',
      asOfDate: '2026-09-23',
      balancesSealed: true,
      currency: 'USD',
      successProbability: '0.82',
      durationMs: 412,
      createdAt: '2026-09-23T00:00:00.000Z',
    },
    percentiles: PERCENTILES,
    staleness: null,
  };
}

const ASSUMPTIONS_FILE = {
  capitalMarket: {
    usEquity: {
      expectedReturn: {
        value: '0.065',
        kind: 'nominal',
        basis: null,
        source: '07 Appendix A §5.5',
        asOf: '2026-01-01',
        note: null,
      },
    },
  },
};

export interface MockPlanSlidersState {
  /** Every request path+method seen after `page.route` installs, for assertions the spec makes directly. */
  requests: Array<{ path: string; method: string }>;
}

export async function installPlanSlidersMocks(page: Page): Promise<MockPlanSlidersState> {
  const state: MockPlanSlidersState = { requests: [] };
  let authenticated = false;

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.startsWith('/api/')) state.requests.push({ path, method });

    if (path === '/api/auth/session') {
      if (!authenticated) {
        return route.fulfill(
          json({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
        );
      }
      return route.fulfill(json(SESSION));
    }

    if (path === '/api/auth/login/options' && method === 'POST') {
      return route.fulfill(json({ options: {} }));
    }

    if (path === '/api/auth/totp/verify' && method === 'POST') {
      authenticated = true;
      return route.fulfill(json({ ok: true }));
    }

    if (path === '/api/connections' && method === 'GET') {
      return route.fulfill(json({ connections: [] }));
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    if (path === '/api/plan/scenarios' && method === 'GET') {
      return route.fulfill(json({ scenarios: [BASELINE_SCENARIO] }));
    }

    const projectionMatch = /^\/api\/plan\/scenarios\/([^/]+)\/projections$/.exec(path);
    if (projectionMatch !== null && method === 'POST') {
      const scenarioId = projectionMatch[1] ?? '';
      return route.fulfill(json(projectionRun(scenarioId)));
    }

    if (path === '/api/assumptions' && method === 'GET') {
      return route.fulfill(
        json({
          version: 'assumptions-1',
          file: ASSUMPTIONS_FILE,
          overrides: [],
          overridablePaths: [],
        }),
      );
    }

    if (path === '/api/plan/life-events' && method === 'GET') {
      return route.fulfill(json({ lifeEvents: [] }));
    }

    return route.continue();
  });

  return state;
}
