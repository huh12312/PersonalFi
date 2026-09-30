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
  registerAdvisor,
  revokeScopes,
  runAdvisor,
  type InsightsDependencies,
} from '@ctx/insights';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInsightsBudgetPort,
  createInsightsLedgerPort,
  createInsightsInvestmentsPort,
  createInsightsMarketDataPort,
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
      // WP 3.10a made `SnapshotPorts` five. The real ports, not fakes: this
      // suite has a real database, and a fake here would be a claim about a
      // fake. Both answer `null` for a holder with no portfolio, which is
      // this fixture, so no block is added and every assertion below is
      // unchanged.
      investments: createInsightsInvestmentsPort(h.database.db, systemClock),
      marketData: createInsightsMarketDataPort({ source: undefined }),
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

/**
 * WP 5.1 — kill level 1 on the on-demand path (Phase 4 gate C-7, finding
 * G4-9).
 *
 * The Phase 4 gate's probe (gate-security-review.md §2.6): with
 * `module.insights = false` stored for the holder, `POST /advisors/run`
 * answered 200 and ran 31 advisors, because `routes/insights.ts` built
 * `InsightsSettings` with `advisorsEnabled: true, moduleEnabled: true` as
 * literals. Registration honoured the flag (`resolveModules`, MF1); the button
 * did not. This suite needs an `advisor_token_secret` — without one the route
 * 503s before it reaches the switches, which is the suite above's claim.
 */
describe.skipIf(NO_DATABASE)('POST /advisors/run and kill level 1 (WP 5.1, C-7)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp51-level1',
      extraSecrets: { advisor_token_secret: 'wp51-level1-token-secret-0123456789abcdef' },
    });
    // Something that *would* run and write if the switch were ignored: the
    // cash advisor, enabled (it ships on) and granted its two scopes.
    await grantScopes(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId() },
      CASH_ADVISOR_ID,
      ['cash.summary', 'cashflow.monthly'],
    );
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('POST /advisors/run with module.insights off refuses and runs nothing', async () => {
    await h.database.pool.query(
      `INSERT INTO feature_flags (user_id, key, enabled) VALUES ($1, 'module.insights', false)
       ON CONFLICT (user_id, key) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [h.userId],
    );
    try {
      const response = await h.request({
        method: 'POST',
        url: '/advisors/run',
        session: h.fresh,
        body: {},
      });
      const single = await h.request({
        method: 'POST',
        url: '/advisors/run',
        session: h.fresh,
        body: { advisorId: CASH_ADVISOR_ID },
      });

      // Nothing ran: not one advisor_runs row got past the switches, and no
      // insight exists. Asserted before the status so a red names the damage.
      const ran = await h.database.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM advisor_runs
          WHERE user_id = $1 AND status <> 'refused'`,
        [h.userId],
      );
      const written = await h.database.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM insights WHERE user_id = $1`,
        [h.userId],
      );
      expect(ran.rows[0]?.n).toBe('0');
      expect(written.rows[0]?.n).toBe('0');

      // Refused, and named: the broadest level that applied.
      for (const answer of [response, single]) {
        expect(answer.statusCode).toBe(409);
        expect(problemOf(answer)['code']).toBe('insights.module_disabled');
      }
    } finally {
      await h.database.pool.query(
        `DELETE FROM feature_flags WHERE user_id = $1 AND key = 'module.insights'`,
        [h.userId],
      );
    }
  }, 60_000);

  /**
   * Phase 4 gate G4-17 (C-12, the grants half): `GET /advisors` answered
   * `grantedScopes` from the manifest's *request* (`read.ts:376`,
   * `row.requiresScopes`), so every scope every advisor asked for read as
   * granted and a revocation changed nothing; and `lastRunStatus` /
   * `lastRunRejected` were always null because `row_number()` arrives as a
   * `bigint` and `1n !== 1`.
   */
  it('GET /advisors reports the stored grants and the last run, not the manifest request (C-12, G4-17)', async () => {
    const run = await h.request({
      method: 'POST',
      url: '/advisors/run',
      session: h.fresh,
      body: { advisorId: CASH_ADVISOR_ID },
    });
    expectStatus(run, 200);

    const listed = async () => {
      const response = await h.request({ method: 'GET', url: '/advisors', session: h.stale });
      expectStatus(response, 200);
      return (
        response.json() as {
          advisors: {
            advisorId: string;
            grantedScopes: string[];
            lastRunStatus: string | null;
            lastRunRejected: number | null;
          }[];
        }
      ).advisors;
    };

    const before = await listed();
    const cash = before.find((a) => a.advisorId === CASH_ADVISOR_ID);
    expect(cash?.grantedScopes).toEqual(['cash.summary', 'cashflow.monthly']);
    expect(cash?.lastRunStatus).toBe('completed');
    expect(cash?.lastRunRejected).toBe(0);
    // Nobody granted the retirement advisor anything: it must not read as granted.
    const goalPace = before.find((a) => a.advisorId === 'builtin.retirement.goal_pace');
    expect(goalPace?.grantedScopes).toEqual([]);

    // A revocation is visible.
    await revokeScopes(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId() },
      CASH_ADVISOR_ID,
      ['cashflow.monthly'],
    );
    const after = await listed();
    expect(after.find((a) => a.advisorId === CASH_ADVISOR_ID)?.grantedScopes).toEqual([
      'cash.summary',
    ]);
  }, 60_000);

  /**
   * WP 5.1's lane, at the HTTP boundary: the api process has no local model
   * (it binds no `PromptRenderer` and registers no narrator) and must never
   * try — a `local_model` advisor asked for by the button is queued as
   * `insights.run_local` for the worker, and the answer says so.
   */
  it('POST /advisors/run queues a local_model advisor and never runs it inline', async () => {
    const localId = 'local.narrator.route_test';
    await registerAdvisor(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId() },
      {
        manifest: {
          advisor_id: localId,
          version: '1.0.0',
          contract_version: 1,
          kind: 'local_model',
          display_name: 'Route-test narrator',
          purpose: 'Stands in for the Phase 5 narrator at the route boundary.',
          requires_scopes: ['cash.summary'],
          triggers: [],
          capabilities: {
            deterministic: false,
            produces_impact: false,
            narrates_only: true,
            max_severity: 'notable',
          },
          limits: { timeout_ms: 180_000, max_insights: 5, max_response_bytes: 65_536 },
          egress_allowlist: [],
        },
        enabled: true,
      },
    );

    const response = await h.request({
      method: 'POST',
      url: '/advisors/run',
      session: h.fresh,
      body: { advisorId: localId },
    });
    expectStatus(response, 200);
    const { results } = response.json() as {
      results: { advisorId: string; status: string; runId: string | null; jobId: string | null }[];
    };
    expect(results).toEqual([
      expect.objectContaining({ advisorId: localId, status: 'queued', runId: null }),
    ]);

    const jobs = await h.database.pool.query<{ kind: string }>(
      `SELECT kind FROM jobs WHERE user_id = $1 AND payload->>'advisorId' = $2`,
      [h.userId, localId],
    );
    expect(jobs.rows).toEqual([{ kind: 'insights.run_local' }]);
    expect(results[0]?.jobId).toMatch(/^[0-9a-f-]{36}$/);
    const runs = await h.database.pool.query(
      `SELECT 1 FROM advisor_runs WHERE user_id = $1 AND advisor_id = $2`,
      [h.userId, localId],
    );
    expect(runs.rows).toEqual([]);
  }, 60_000);
});

/**
 * The review route's `reasonCode` field (WP 5.9): `DONT_CARE` reaching
 * `POST /advisors/{id}/enabled`'s own effect through a different door.
 * `test/feedback.test.ts` proves `decideFeedbackEffects`'s pure arithmetic;
 * this is the one end-to-end proof that the wire field the route now accepts
 * actually reaches it, through a real dismissal on a real insight.
 */
describe.skipIf(NO_DATABASE)('POST /insights/:id/review with reasonCode (WP 5.9)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp59-reasoncode' });

    await linkManual(h, {
      providerConnectionId: 'wp59-conn',
      displayName: 'WP 5.9 Test Bank',
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
            providerTransactionId: 'wp59-spend',
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

  async function enabledOf(): Promise<boolean | undefined> {
    const response = await h.request({ method: 'GET', url: '/advisors', session: h.stale });
    expectStatus(response, 200);
    const { advisors } = response.json() as { advisors: WireAdvisor[] };
    return advisors.find((a) => a.advisorId === CASH_ADVISOR_ID)?.enabled;
  }

  it('DONT_CARE turns the rule off, and a human can turn it back on', async () => {
    const feed = await h.request({ method: 'GET', url: '/insights', session: h.stale });
    expectStatus(feed, 200);
    const body = feed.json() as { dashboard: WireInsight[]; list: WireInsight[] };
    const found = [...body.dashboard, ...body.list].find((i) => i.advisorId === CASH_ADVISOR_ID);
    expect(found).toBeDefined();
    if (found === undefined) return;

    expect(await enabledOf()).toBe(true);

    const review = await h.request({
      method: 'POST',
      url: `/insights/${found.id}/review`,
      session: h.stale,
      body: { action: 'dismiss', reasonCode: 'DONT_CARE' },
    });
    expectStatus(review, 200);

    expect(await enabledOf()).toBe(false);

    // A human's own switch, over the pre-existing route, still wins.
    const humanOverride = await h.request({
      method: 'POST',
      url: `/advisors/${CASH_ADVISOR_ID}/enabled`,
      session: h.fresh,
      body: { enabled: true },
    });
    expectStatus(humanOverride, 200);
    expect(await enabledOf()).toBe(true);
  });
});
