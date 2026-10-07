// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * The Brief and health-score routes (WP 5.11, extended by 9.6), as a layerable mock: moved out of
 * `brief.spec.ts` by WP 9.8 so `a11y-sweep.spec.ts` can visit `/brief` with the same bodies. By default it
 * stands alone (it answers login, the session and the sync pill's connection list, as the spec needs);
 * `standalone: false` makes it a pure layer over `installApiMocks`, answering only the Brief routes.
 */

export const SESSION = {
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

export function json(
  body: unknown,
  status = 200,
): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

export function problem(code: string, status: number): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Not Found',
    status,
    code,
    correlationId: 'corr_e2e',
  };
}

export const COMPUTED_EFFECT = {
  kind: 'computed',
  engineVersion: 'personalfi.deterministic/1',
  assumptionsVersion: 'sha256:abc',
  plannedRetirementAge: 65,
  baseline: { kind: 'earliest', age: 65, engineRuns: 3 },
  withAction: { kind: 'earliest', age: 63, engineRuns: 3 },
  yearsEarlier: 2,
  monthsOfSpending: {
    months: '9',
    atAge: 65,
    wealthDifference: { minor: '3222688', currency: 'USD' },
    firstYearSpending: { minor: '4000000', currency: 'USD' },
    derivation: 'two engine runs at the planned retirement age',
  },
  assumption: 'if the saving is invested in your plan',
};

export function briefItem(
  overrides: Record<string, unknown> & { id: string },
): Record<string, unknown> {
  return {
    section: 'ranked',
    position: 0,
    insightId: `insight_${overrides.id}`,
    advisorId: 'builtin.spending.fee_hunter',
    insightKey: `spending.fee_hunter.${overrides.id}`,
    insightType: 'spending.fee_hunter',
    severity: 'warning',
    title: 'Avoidable fees this year',
    summaryMd: 'You paid $720 in avoidable fees over the last twelve months.',
    confidence: 0.9,
    horizon: 'this_year',
    carried: false,
    annualizedImpact: { minor: '72000', currency: 'USD' },
    oneTimeImpact: null,
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'Avoidable fees, twelve months',
        value: '$720.00',
        sourceRef: 'snapshot:fees_summary.by_type[0].total',
        resolvedDisplay: '$720.00',
        href: null,
      },
    ],
    score: 50400,
    retirementEffect: COMPUTED_EFFECT,
    // WP 9.6 items 3 and 4: the two fields the response now carries on every item.
    primaryAction: null,
    narration: { status: 'none', aiAssisted: false, textShown: false, summaryMd: null },
    ...overrides,
  };
}

export function buildBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'brief_1',
    isoWeek: '2026-W40',
    currency: 'USD',
    nothingMaterial: false,
    coldStart: false,
    coldStartNote: null,
    inputDigest: 'sha256:digest',
    publishedAt: '2026-10-04T06:00:00.000Z',
    items: [briefItem({ id: '1' })],
    ...overrides,
  };
}

export const HEALTH_SCORE_RESULT = {
  isoWeek: '2026-W40',
  computedAt: '2026-10-04T06:00:00.000Z',
  overall: 72.5,
  components: [
    {
      component: 'emergency_fund_months',
      value: '4.50',
      band: 'good',
      weight: '0.230000',
      score: 75,
      direction: 'improved',
    },
    {
      component: 'savings_rate',
      value: '0.120000',
      band: 'fair',
      weight: '0.230000',
      score: 50,
      direction: 'worsened',
    },
    {
      component: 'debt_to_income',
      value: '0.180000',
      band: 'excellent',
      weight: '0.230000',
      score: 100,
      direction: 'unchanged',
    },
    {
      component: 'subscription_load',
      value: '0.070000',
      band: 'good',
      weight: '0.150000',
      score: 75,
      direction: 'no_previous_data',
    },
    {
      component: 'diversification',
      value: '0.080000',
      band: 'good',
      weight: '0.080000',
      score: 75,
      direction: 'improved',
    },
    {
      component: 'fee_drag',
      value: { minor: '12000', currency: 'USD' },
      band: 'poor',
      weight: '0.090000',
      score: 25,
      direction: 'worsened',
    },
  ],
  excluded: [],
};

export interface MockState {
  readonly reviewedBodies: unknown[];
}

export interface InstallBriefMocksOptions {
  readonly brief?: Record<string, unknown>;
  readonly briefStatus?: number;
  readonly briefProblemCode?: string;
  readonly healthScore?: unknown;
  readonly healthScoreStatus?: number;
  /** `false`: do not answer login, the session or the connection list — a layer over another mock. Default `true`. */
  readonly standalone?: boolean;
}

export async function installBriefMocks(
  page: Page,
  options: InstallBriefMocksOptions,
): Promise<MockState> {
  const state: MockState = { reviewedBodies: [] };
  let authenticated = false;

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    const standalone = options.standalone ?? true;
    if (standalone && path === '/api/auth/session') {
      if (!authenticated) {
        return route.fulfill(
          json({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
        );
      }
      return route.fulfill(json(SESSION));
    }
    if (standalone && path === '/api/auth/login/options' && method === 'POST') {
      return route.fulfill(json({ options: {} }));
    }
    if (standalone && path === '/api/auth/totp/verify' && method === 'POST') {
      authenticated = true;
      return route.fulfill(json({ ok: true }));
    }
    if (standalone && path === '/api/connections' && method === 'GET') {
      return route.fulfill(json({ connections: [] }));
    }
    if (standalone && (path === '/api/sync/stream' || path.endsWith('/events'))) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    if (path === '/api/insights/brief/current' && method === 'GET') {
      if (options.briefStatus !== undefined && options.briefStatus !== 200) {
        return route.fulfill(
          json(
            problem(options.briefProblemCode ?? 'insights.brief_not_found', options.briefStatus),
            options.briefStatus,
          ),
        );
      }
      return route.fulfill(json({ brief: options.brief ?? buildBrief() }));
    }

    if (path === '/api/insights/health-score' && method === 'GET') {
      if (options.healthScoreStatus !== undefined && options.healthScoreStatus !== 200) {
        return route.fulfill(
          json(
            problem('insights.health_score_not_computed', options.healthScoreStatus),
            options.healthScoreStatus,
          ),
        );
      }
      return route.fulfill(json({ healthScore: options.healthScore ?? HEALTH_SCORE_RESULT }));
    }

    const reviewMatch = /^\/api\/insights\/([^/]+)\/review$/.exec(path);
    if (reviewMatch !== null && method === 'POST') {
      const body = request.postDataJSON() as { action: string };
      state.reviewedBodies.push(body);
      return route.fulfill(
        json({
          insightId: reviewMatch[1],
          status: body.action === 'dismiss' ? 'dismissed' : 'accepted',
          dismissCount: body.action === 'dismiss' ? 1 : 0,
          permanent: false,
          suppressedUntil: body.action === 'dismiss' ? '2026-11-04T00:00:00.000Z' : null,
        }),
      );
    }

    return route.fallback();
  });

  return state;
}
