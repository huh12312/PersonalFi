// SPDX-License-Identifier: MIT
/**
 * `/insights/*` and `/advisors/*` — WP 2.r's REST surface over `@ctx/insights`,
 * over a real database.
 *
 * The scene is set the way `phase2-wiring.test.ts` sets it for the same
 * built-in rule: a real manual account with a low balance, the scopes it
 * needs granted directly (no consent route exists yet —
 * `wp2.6-insights.md` §6's carried item), and `runAdvisor` called directly to
 * produce a real `pending_review` row — the claim under test is the *route*,
 * not the advisor pipeline WP 2.6/2.7 already proved.
 */
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import {
  createBuiltinRegistry,
  grantScopes,
  runAdvisor,
  type InsightsDependencies,
} from '@ctx/insights';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInsightsBudgetPort,
  createInsightsLedgerPort,
  createInsightsRecurringPort,
} from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CASH_ADVISOR_ID = 'builtin.cash.emergency_fund_short';

interface WireInsight {
  readonly id: string;
  readonly advisorId: string;
  readonly status: string;
}
interface WireAdvisor {
  readonly advisorId: string;
  readonly enabled: boolean;
}

function dependenciesOf(h: ApiHarness): InsightsDependencies {
  return {
    registry: createBuiltinRegistry(),
    ports: {
      ledger: createInsightsLedgerPort(h.database.db, systemClock),
      budget: createInsightsBudgetPort(h.database.db),
      recurring: createInsightsRecurringPort(h.database.db),
    },
    settings: {
      advisorsEnabled: true,
      moduleEnabled: true,
      timeZone: 'UTC',
      baseCurrency: 'USD',
      tokenSecret: 'wp-insights-test-secret',
    },
  };
}

describe.skipIf(NO_DATABASE)('/insights and /advisors (WP 2.r)', () => {
  let h: ApiHarness;
  let insightId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp-insights' });

    await linkManual(h, {
      providerConnectionId: 'wp-insights-conn',
      displayName: 'Insights Test Bank',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
      batch: {
        balances: [
          {
            providerAccountId: 'checking',
            current: money(12_000n, 'USD'),
            available: null,
            limit: null,
            asOf: systemClock.now(),
          },
        ],
        added: [
          manualTransaction({
            providerAccountId: 'checking',
            providerTransactionId: 'wp-insights-spend',
            amount: money(-6_000n, 'USD'),
            postedDate: DateOnly.addDays(
              DateOnly.parse(systemClock.now().toISOString().slice(0, 10)),
              -3,
            ),
            name: 'GROCERY WAREHOUSE',
          }),
        ],
      },
    });

    await grantScopes(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId() },
      CASH_ADVISOR_ID,
      ['cash.summary', 'cashflow.monthly'],
    );

    const result = await runAdvisor(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId(), causationId: null },
      dependenciesOf(h),
      { advisorId: CASH_ADVISOR_ID, trigger: 'manual' },
    );
    expect(result.status).toBe('completed');
    expect(result.proposed).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('refuses every insights/advisors route without a session, with 401', async () => {
    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    const someId = '00000000-0000-4000-8000-000000000000';
    const attempts = [
      { method: 'GET' as const, url: '/insights', session: noSession },
      { method: 'GET' as const, url: `/insights/${someId}`, session: noSession },
      {
        method: 'POST' as const,
        url: `/insights/${someId}/review`,
        session: noSession,
        body: { action: 'dismiss' },
      },
      { method: 'GET' as const, url: '/advisors', session: noSession },
      {
        method: 'POST' as const,
        url: `/advisors/${CASH_ADVISOR_ID}/enabled`,
        session: noSession,
        body: { enabled: true },
      },
      { method: 'POST' as const, url: '/advisors/run', session: noSession, body: {} },
    ];
    for (const attempt of attempts) {
      const response = await h.request(attempt);
      expect(response.statusCode).toBe(401);
      expect(problemOf(response)['code']).toBe('not_authenticated');
    }
  });

  it('lists the registered built-in advisors, seeded at boot', async () => {
    const response = await h.request({ method: 'GET', url: '/advisors', session: h.stale });
    expectStatus(response, 200);
    const { advisors } = response.json() as { advisors: WireAdvisor[] };
    expect(advisors.length).toBeGreaterThan(0);
    expect(advisors.some((a) => a.advisorId === CASH_ADVISOR_ID)).toBe(true);
  });

  it('GET /advisors carries no lazy repair (condition C-1, gate finding G2-1 closed)', async () => {
    // The Phase 2 gate's cold walk found zero advisors for a user bootstrapped
    // after the api's onReady hook ran — the D2-1 shape again (G2-1). That was
    // first patched with a lazy repair on this very route; condition C-1 in
    // the same gate called two lazy repairs for one root cause a defect in
    // its own right, and the root fix — `bootstrap-seed.ts`'s
    // `seedUserState`, called once at user creation
    // (`bin/bootstrap-user.ts`) — replaced it. A user inserted straight into
    // `users`, bypassing that call site entirely, now reads back an empty
    // catalogue rather than a lazily-repaired one.
    // `phase3-cold-install.test.ts` is what proves the real path (create the
    // user through `bootstrap-user`) has a full catalogue with no restart.
    const lateUserId = await h.database.createUser('Late Holder');
    const late = await h.issueSession({ userId: lateUserId, fresh: false });
    const response = await h.request({ method: 'GET', url: '/advisors', session: late });
    expectStatus(response, 200);
    const { advisors } = response.json() as { advisors: WireAdvisor[] };
    expect(advisors).toHaveLength(0);
  });

  it('the feed carries the real insight the advisor proposed, with its evidence panel', async () => {
    const feed = await h.request({ method: 'GET', url: '/insights', session: h.stale });
    expectStatus(feed, 200);
    const body = feed.json() as { dashboard: WireInsight[]; list: WireInsight[] };
    const found = [...body.dashboard, ...body.list].find((i) => i.advisorId === CASH_ADVISOR_ID);
    expect(found).toBeDefined();
    if (found === undefined) throw new Error('unreachable');
    insightId = found.id;

    const single = await h.request({
      method: 'GET',
      url: `/insights/${insightId}`,
      session: h.stale,
    });
    expectStatus(single, 200);
    const insight = (single.json() as { insight: { evidence: unknown[] } }).insight;
    expect(insight.evidence.length).toBeGreaterThan(0);
  });

  it('reviewing an insight starts its cooldown', async () => {
    const response = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/review`,
      session: h.stale,
      body: { action: 'dismiss', reason: 'not relevant right now' },
    });
    expectStatus(response, 200);
    const body = response.json() as {
      status: string;
      dismissCount: number;
      permanent: boolean;
      suppressedUntil: string | null;
    };
    expect(body.status).toBe('dismissed');
    expect(body.dismissCount).toBe(1);
    expect(body.permanent).toBe(false);
    expect(body.suppressedUntil).not.toBeNull();

    // The feed carries `pending_review` *and* reviewed insights (this route's
    // own contract), so the row is still there — now with `status:
    // 'dismissed'` rather than absent, which is what actually proves the
    // review was recorded rather than merely accepted and forgotten.
    const feed = await h.request({ method: 'GET', url: '/insights', session: h.stale });
    const body2 = feed.json() as { dashboard: WireInsight[]; list: WireInsight[] };
    const reviewed = [...body2.dashboard, ...body2.list].find((i) => i.id === insightId);
    expect(reviewed?.status).toBe('dismissed');
  });

  it('enabling an advisor needs a step-up assertion', async () => {
    const stale = await h.request({
      method: 'POST',
      url: `/advisors/${CASH_ADVISOR_ID}/enabled`,
      session: h.stale,
      body: { enabled: true },
    });
    expect(stale.statusCode).toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');

    const fresh = await h.request({
      method: 'POST',
      url: `/advisors/${CASH_ADVISOR_ID}/enabled`,
      session: h.fresh,
      body: { enabled: true },
    });
    expectStatus(fresh, 200);
  });

  /**
   * WP 2.12 sabotage finding: the test below (503 on a missing
   * advisor_token_secret) always drives `/advisors/run` with `h.fresh`, so no
   * test in this file ever drove it with a stale session. Replacing
   * `routes/insights.ts`'s `/advisors/run` handler's `requireFreshSession`
   * with plain `requireSession` — dropping the step-up guard dispatch §3
   * names for this exact route ("fresh for anything that changes what the
   * system does unattended") — left every test in this file green. This is
   * the missing case.
   */
  it('triggering a run needs a step-up assertion', async () => {
    const stale = await h.request({
      method: 'POST',
      url: '/advisors/run',
      session: h.stale,
      body: { advisorId: CASH_ADVISOR_ID },
    });
    expect(stale.statusCode).toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');
  });

  it('triggering a run without an advisor_token_secret configured fails closed with 503, not a 500', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/advisors/run',
      session: h.fresh,
      body: { advisorId: CASH_ADVISOR_ID },
    });
    expect(response.statusCode).toBe(503);
    expect(problemOf(response)['code']).toBe('insights.advisor_token_secret_unconfigured');
  });

  it('an insight belonging to one user is invisible and unreachable to another', async () => {
    const otherUserId = await h.database.createUser('Insights Second Holder');
    const otherSession = await h.issueSession({ userId: otherUserId, fresh: true });

    const theirs = await h.request({
      method: 'GET',
      url: `/insights/${insightId}`,
      session: otherSession,
    });
    expect(theirs.statusCode).toBe(404);

    const review = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/review`,
      session: otherSession,
      body: { action: 'accept' },
    });
    expect(review.statusCode).toBe(404);
  });
});
