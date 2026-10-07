// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 4.10's own mock module for `e2e/plan.spec.ts`, entirely separate from
 * `e2e/support/mock-api.ts` and `app-walkthrough.spec.ts` (both off-limits to
 * this work package, per `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10") —
 * the `mock-investments.ts`/`mock-networth.ts` pattern: one
 * `page.route('**\/*')` handler, in-memory state, no live `apps/api`, no
 * database.
 *
 * Covers login, the sidebar's sync pill (`GET /connections`), and every
 * `/plan`, `/goals`-adjacent (unused by this screen) and `/assumptions`
 * route `PlanScreen.tsx` calls: scenarios (list/create/project), assumptions
 * (read/override), life events (list/create/patch/delete), compare, and the
 * required-savings solver.
 *
 * The required-savings solver's behaviour is driven by the request body, not
 * a call counter: a target at or above `UNREACHABLE_TARGET_MINOR_THRESHOLD`
 * answers `unreachable` with a named `monthly_ceiling` constraint; anything
 * below answers `required` with a monthly figure — so the same route can
 * prove both of `plan.spec.ts`'s halves of `'clicking the dotted gap line
 * renders a required monthly saving, and an unreachable gap names its
 * constraint instead'` without any client-visible state.
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

const FORK_SCENARIO = {
  kind: 'fork' as const,
  id: 'scenario-fork-retire-early',
  baselineId: 'scenario-baseline',
  name: 'Retire at 62',
  levers: { retireAge: 62 },
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

/** Six checkpoints, present day (2026, age 41) through age 65 (2050) — a deliberately wide p5/p95 band so the fan reads at a glance. */
const PERCENTILES = [
  {
    index: 0,
    age: 41,
    calendarYear: 2026,
    minor: [25_000_00, 30_000_00, 35_000_00, 40_000_00, 45_000_00, 50_000_00, 55_000_00],
  },
  {
    index: 1,
    age: 46,
    calendarYear: 2031,
    minor: [35_000_00, 42_000_00, 50_000_00, 60_000_00, 70_000_00, 80_000_00, 90_000_00],
  },
  {
    index: 2,
    age: 51,
    calendarYear: 2036,
    minor: [55_000_00, 65_000_00, 75_000_00, 90_000_00, 105_000_00, 120_000_00, 135_000_00],
  },
  {
    index: 3,
    age: 56,
    calendarYear: 2041,
    minor: [70_000_00, 90_000_00, 110_000_00, 135_000_00, 160_000_00, 185_000_00, 210_000_00],
  },
  {
    index: 4,
    age: 61,
    calendarYear: 2046,
    minor: [80_000_00, 105_000_00, 130_000_00, 160_000_00, 195_000_00, 230_000_00, 265_000_00],
  },
  {
    index: 5,
    age: 65,
    calendarYear: 2050,
    minor: [90_000_00, 120_000_00, 150_000_00, 180_000_00, 210_000_00, 240_000_00, 270_000_00],
  },
].map((row) => ({
  index: row.index,
  age: row.age,
  calendarYear: row.calendarYear,
  p5: usd(String(row.minor[0])),
  p10: usd(String(row.minor[1])),
  p25: usd(String(row.minor[2])),
  p50: usd(String(row.minor[3])),
  p75: usd(String(row.minor[4])),
  p90: usd(String(row.minor[5])),
  p95: usd(String(row.minor[6])),
}));

function projectionRun(
  scenarioId: string,
  scenarioKind: 'baseline' | 'fork',
  successProbability: string,
) {
  return {
    status: 'computed' as const,
    run: {
      id: `run-${scenarioId}`,
      scenarioId,
      scenarioKind,
      method: 'monte_carlo' as const,
      seed: 'seed-baseline-1',
      paths: 10_000,
      engineVersion: 'engine-1',
      assumptionsVersion: 'assumptions-1',
      asOfDate: '2026-09-23',
      balancesSealed: true,
      currency: 'USD',
      successProbability,
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
  usTax2026: {
    socialSecurity: {
      wageBase: {
        value: '184500',
        kind: 'limit',
        basis: null,
        source: 'SSA 2026 COLA notice',
        asOf: '2025-10-15',
        note: null,
      },
    },
  },
};

/** A target at or above $5,000,000 (minor units) is answered `unreachable`. */
const UNREACHABLE_TARGET_MINOR_THRESHOLD = 500_000_000;

export interface MockPlanState {
  overrides: Record<string, string>;
  lifeEvents: Array<{
    id: string;
    kind: string;
    name: string;
    occursOn: string;
    amount: { minor: string; currency: string };
    createdAt: string;
    updatedAt: string;
  }>;
  scenarios: Array<typeof BASELINE_SCENARIO | typeof FORK_SCENARIO>;
  /** Every `POST /plan/required-savings` body received, in order — for assertions on what the UI actually sent. */
  requiredSavingsRequests: unknown[];
  /** Every `PATCH /plan/life-events/{id}` body received, in order. */
  lifeEventPatches: unknown[];
}

export async function installPlanMocks(page: Page): Promise<MockPlanState> {
  const state: MockPlanState = {
    overrides: {},
    lifeEvents: [
      {
        id: 'life-event-1',
        kind: 'windfall',
        name: 'Signing bonus',
        occursOn: '2031-06-01',
        amount: usd('50000000'),
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    scenarios: [BASELINE_SCENARIO, FORK_SCENARIO],
    requiredSavingsRequests: [],
    lifeEventPatches: [],
  };
  let authenticated = false;

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

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
      return route.fulfill(json({ scenarios: state.scenarios }));
    }

    if (path === '/api/plan/scenarios' && method === 'POST') {
      const body = request.postDataJSON() as { kind: string; name: string };
      if (body.kind === 'baseline') {
        return route.fulfill(json(BASELINE_SCENARIO, 201));
      }
      return route.fulfill(json(FORK_SCENARIO, 201));
    }

    const projectionMatch = /^\/api\/plan\/scenarios\/([^/]+)\/projections$/.exec(path);
    if (projectionMatch !== null && method === 'POST') {
      const scenarioId = projectionMatch[1] ?? '';
      const kind = scenarioId === FORK_SCENARIO.id ? 'fork' : 'baseline';
      const successProbability = kind === 'fork' ? '0.74' : '0.82';
      return route.fulfill(json(projectionRun(scenarioId, kind, successProbability)));
    }

    if (path === '/api/assumptions' && method === 'GET') {
      const overrides = Object.entries(state.overrides).map(([overridePath, value]) => ({
        path: overridePath,
        value,
        default: '0.065',
      }));
      return route.fulfill(
        json({
          version: 'assumptions-1',
          file: ASSUMPTIONS_FILE,
          overrides,
          overridablePaths: ['capitalMarket.usEquity.expectedReturn'],
        }),
      );
    }

    if (path === '/api/assumptions/overrides' && method === 'PUT') {
      const body = request.postDataJSON() as { overrides: Record<string, string> };
      state.overrides = body.overrides;
      return route.fulfill(json({ ok: true }));
    }

    if (path === '/api/plan/life-events' && method === 'GET') {
      return route.fulfill(json({ lifeEvents: state.lifeEvents }));
    }

    if (path === '/api/plan/life-events' && method === 'POST') {
      const body = request.postDataJSON() as {
        kind: string;
        name: string;
        occursOn: string;
        amount: { minor: string; currency: string };
      };
      const created = {
        id: `life-event-${String(state.lifeEvents.length + 1)}`,
        ...body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.lifeEvents.push(created);
      return route.fulfill(json(created, 201));
    }

    const lifeEventMatch = /^\/api\/plan\/life-events\/([^/]+)$/.exec(path);
    if (lifeEventMatch !== null && method === 'PATCH') {
      const lifeEventId = lifeEventMatch[1] ?? '';
      const body = request.postDataJSON() as { occursOn?: string; name?: string; amount?: unknown };
      state.lifeEventPatches.push(body);
      const existing = state.lifeEvents.find((e) => e.id === lifeEventId);
      if (existing === undefined) {
        return route.fulfill(json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404));
      }
      Object.assign(existing, body);
      return route.fulfill(json(existing));
    }
    if (lifeEventMatch !== null && method === 'DELETE') {
      const lifeEventId = lifeEventMatch[1] ?? '';
      state.lifeEvents = state.lifeEvents.filter((e) => e.id !== lifeEventId);
      return route.fulfill({ status: 204 });
    }

    if (path === '/api/plan/compare' && method === 'GET') {
      const a = projectionRun('scenario-baseline', 'baseline', '0.82');
      const b = projectionRun('scenario-fork-retire-early', 'fork', '0.74');
      return route.fulfill(
        json({
          a,
          b,
          seed: 'seed-baseline-1',
          successProbabilityDelta: '-0.08',
          retirementDate: { a: '2050-04-12', b: '2047-04-12' },
          retirementDeltaMonths: -36,
        }),
      );
    }

    if (path === '/api/plan/required-savings' && method === 'POST') {
      const body = request.postDataJSON() as {
        objective?: { kind: string; target?: { minor: string; currency: string } };
      };
      state.requiredSavingsRequests.push(body);
      const targetMinor = Number(body.objective?.target?.minor ?? '0');
      if (targetMinor >= UNREACHABLE_TARGET_MINOR_THRESHOLD) {
        return route.fulfill(
          json({
            kind: 'unreachable',
            constraint: {
              name: 'monthly_ceiling',
              detail:
                'Even saving the full monthly ceiling falls short of this target by the target date.',
              ceiling: usd('200000'),
              gapAtCeiling: usd('410000000'),
            },
          }),
        );
      }
      return route.fulfill(
        json({ kind: 'required', monthly: usd('75000'), iterations: 6, verified: true }),
      );
    }

    return route.fallback();
  });

  return state;
}
