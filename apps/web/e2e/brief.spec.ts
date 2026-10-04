// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 5.11's own mock module, inlined in this spec (05-phase-5-dispatch.md
 * §3 WP 5.11 / §4: this work package may not touch `e2e/support/mock-api.ts`
 * or `app-walkthrough.spec.ts`, and "missing handlers go inside your own
 * spec and are listed for the orchestrator"). The `mock-plan.ts`/
 * `mock-networth.ts` pattern: one `page.route('**\/*')` handler, in-memory
 * state, no live `apps/api`, no database.
 *
 * Handlers needed beyond this work package's own routes: login
 * (`/api/auth/session`, `/api/auth/login/options`, `/api/auth/totp/verify`),
 * the sidebar's sync pill (`/api/connections`), and the SSE stream — the
 * same minimal set `mock-plan.ts`/`mock-networth.ts` each needed, listed
 * here for the orchestrator per the dispatch's instruction rather than
 * silently duplicated into `e2e/support/mock-api.ts`.
 */

interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

async function shoot(page: Page, evidenceDir: string | undefined, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(evidenceDir)}wp5.11-${name}.png`,
    fullPage: true,
  });
}

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

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function problem(code: string, status: number): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Not Found',
    status,
    code,
    correlationId: 'corr_e2e',
  };
}

const COMPUTED_EFFECT = {
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

function briefItem(overrides: Record<string, unknown> & { id: string }): Record<string, unknown> {
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
    ...overrides,
  };
}

function buildBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

const HEALTH_SCORE_RESULT = {
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

interface MockState {
  readonly reviewedBodies: unknown[];
}

interface InstallBriefMocksOptions {
  readonly brief?: Record<string, unknown>;
  readonly briefStatus?: number;
  readonly briefProblemCode?: string;
  readonly healthScore?: unknown;
  readonly healthScoreStatus?: number;
}

async function installBriefMocks(
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

    return route.continue();
  });

  return state;
}

async function loginAndReachBrief(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Brief' })
    .click();
  await expect(page).toHaveURL(/\/brief/);
  await expect(page.getByRole('heading', { name: "This week's Brief" })).toBeVisible();
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test.describe('Brief screen (WP 5.11)', () => {
  test('the Brief shows at most five actions, each with a dollar figure and a retirement effect or a stated reason it has none', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const items = Array.from({ length: 7 }, (_, index) =>
      briefItem({
        id: String(index),
        position: index,
        title: `Ranked action ${String(index)}`,
        annualizedImpact: { minor: String(100_00 - index), currency: 'USD' },
        retirementEffect:
          index === 6
            ? { kind: 'not_computable', reason: 'no baseline plan to project against' }
            : COMPUTED_EFFECT,
      }),
    );
    await installBriefMocks(page, { brief: buildBrief({ items }) });
    await loginAndReachBrief(page);

    const cards = page.getByTestId('brief-item-card');
    await expect(cards).toHaveCount(5);

    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      await expect(card.getByTestId('brief-item-impact')).toContainText('$');
      const effect = card.getByTestId('retirement-effect');
      await expect(effect).toBeVisible();
      const text = (await effect.textContent()) ?? '';
      expect(/Retire \d+ years? earlier|Not computable:/.test(text)).toBe(true);
    }

    await shoot(page, evidenceDir, 'five-cards');
  });

  test('a narrated item shows the AI-assisted badge and the template text is one click away', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const narrated = {
      ...briefItem({ id: '1' }),
      narration: { narratedSummaryMd: 'Fee hunter found $720 you could get back this year.' },
    };
    await installBriefMocks(page, { brief: buildBrief({ items: [narrated] }) });
    await loginAndReachBrief(page);

    await expect(
      page.getByText('Fee hunter found $720 you could get back this year.'),
    ).toBeVisible();
    await expect(page.getByText('AI-assisted wording')).toBeVisible();
    await expect(page.getByTestId('narration-template-text')).not.toBeVisible();

    await page.getByRole('button', { name: 'See the template wording' }).click();
    const template = page.getByTestId('narration-template-text');
    await expect(template).toBeVisible();
    await expect(template).toContainText(
      'You paid $720 in avoidable fees over the last twelve months.',
    );

    await shoot(page, evidenceDir, 'narration-badge');
  });

  test('a week with nothing material says so plainly', async ({ page, evidenceDir }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, { brief: buildBrief({ items: [], nothingMaterial: true }) });
    await loginAndReachBrief(page);

    await expect(page.getByText('Nothing material this week')).toBeVisible();
    await expect(page.getByTestId('brief-item-card')).toHaveCount(0);

    await shoot(page, evidenceDir, 'nothing-material');
  });

  test('every health component shows value, weight and direction in words', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, { healthScoreStatus: 200, healthScore: HEALTH_SCORE_RESULT });
    await loginAndReachBrief(page);

    const rows = page.getByTestId('health-component-row');
    await expect(rows).toHaveCount(6);

    const emergencyFund = page
      .getByTestId('health-component-row')
      .filter({ hasText: 'Emergency fund' });
    await expect(emergencyFund).toContainText('4.50 months');
    await expect(emergencyFund).toContainText('Weight: 23.0%');
    await expect(emergencyFund).toContainText('Improved');
    await expect(emergencyFund).toContainText('Good');

    const feeDrag = page.getByTestId('health-component-row').filter({ hasText: 'Fee drag' });
    await expect(feeDrag).toContainText('$120.00');
    await expect(feeDrag).toContainText('Poor');
    await expect(feeDrag).toContainText('Worsened');

    await expect(page.getByTestId('health-score-overall')).toContainText('72.5 / 100');

    await shoot(page, evidenceDir, 'health-score');
  });

  test('a health score not yet computed reads as "not computed yet", not as an error', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, { healthScoreStatus: 404 });
    await loginAndReachBrief(page);

    await expect(page.getByTestId('health-score-not-computed')).toContainText('Not computed yet');
  });

  test('dismissing asks for one of seven reasons and the code reaches the API', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    const mocks = await installBriefMocks(page, {
      brief: buildBrief({ items: [briefItem({ id: '1' })] }),
    });
    await loginAndReachBrief(page);

    await page.getByTestId('brief-item-card').getByRole('button', { name: 'Dismiss' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(7);

    await dialog.getByRole('radio', { name: "True, but I can't act on it" }).click();
    await dialog.getByRole('button', { name: 'Dismiss' }).click();

    await expect(dialog).not.toBeVisible();
    expect(mocks.reviewedBodies).toContainEqual({
      action: 'dismiss',
      reasonCode: 'NOT_ACTIONABLE',
      reason: null,
    });

    await shoot(page, evidenceDir, 'dismiss-reasons');
  });

  test('axe reports no violations on the Brief screen, in light and in dark', async ({
    page,
    evidenceDir,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installBriefMocks(page, {
      brief: buildBrief({
        items: [
          briefItem({ id: '1' }),
          briefItem({
            id: 'attn',
            section: 'attention',
            severity: 'urgent',
            title: 'A payment looks like it will be missed',
            annualizedImpact: null,
            oneTimeImpact: null,
            score: null,
            retirementEffect: { kind: 'not_computable', reason: 'no dollar figure' },
          }),
        ],
      }),
      healthScoreStatus: 200,
      healthScore: HEALTH_SCORE_RESULT,
    });
    await loginAndReachBrief(page);

    await setTheme(page, 'light');
    await injectAxe(page);
    await expectNoAxeViolations(page, 'Brief screen (light)');
    await shoot(page, evidenceDir, 'brief-light');

    await setTheme(page, 'dark');
    await injectAxe(page);
    await expectNoAxeViolations(page, 'Brief screen (dark)');
    await shoot(page, evidenceDir, 'brief-dark');
  });
});
