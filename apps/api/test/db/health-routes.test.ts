// SPDX-License-Identifier: MIT
/**
 * `GET /insights/health-score` (05-phase-5-dispatch.md §3 WP 5.10/5.8), over
 * a real database.
 *
 * `computeAndStoreHealthScore` (`@ctx/insights`) is called directly to seed
 * each case — the Brief's own route suite inserts raw rows instead because
 * `publishWeeklyBrief` needs an engine port and a ranking pass that are
 * irrelevant to the route; the health score's store function needs only a
 * database and a snapshot, so calling it directly both seeds realistic rows
 * *and* is the same integration point the weekly job's fold will use.
 *
 * ## Cross-user scoping (dispatch §5 item 8)
 *
 * `routes/brief.ts`'s health-score handler has exactly one predicate —
 * `findLatestHealthScore`'s `WHERE user_id = caller` — proved by
 * `'a health score belonging to one holder is never served to another'`:
 * a second holder with no row of their own still 404s even though the first
 * holder's row exists.
 */
import { computeAndStoreHealthScore, type AdvisorSnapshot } from '@ctx/insights';
import { fixedClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const EPOCH = '2026-09-19T09:00:00.000Z';
const USD = 'USD';

function money(minor: string) {
  return { minor, currency: USD };
}

/** One computable component (`emergency_fund_months`); the rest fall out `excluded`. */
function snapshotWithMonths(months: number): AdvisorSnapshot {
  return {
    cash_summary: {
      as_of: '2026-09-19',
      total: money('1000000'),
      account_count: 1,
      blended_apy: 0.01,
      emergency_fund_months: months,
      accounts: [
        {
          account_ref: '01930000-0000-7000-8000-00000000e1a1',
          type: 'checking',
          balance: money('1000000'),
          apy: 0.01,
        },
      ],
    },
  };
}

describe.skipIf(NO_DATABASE)('/insights/health-score (WP 5.10/5.8)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp58-health-routes' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('401s without a session', async () => {
    const response = await h.request({ method: 'GET', url: '/insights/health-score' });
    expect(response.statusCode).toBe(401);
  });

  it('404s insights.health_score_not_computed before any score has been computed', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/insights/health-score',
      session: h.stale,
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('insights.health_score_not_computed');
  });

  describe('a computed score', () => {
    beforeAll(async () => {
      await computeAndStoreHealthScore(h.database.db, {
        userId: h.userId,
        isoWeek: '2026-W39',
        snapshot: snapshotWithMonths(0), // 0 months -> 'poor' (25)
        clock: fixedClock(EPOCH),
      });
      // The immediately following week — "current", and the one direction reads back from.
      await computeAndStoreHealthScore(h.database.db, {
        userId: h.userId,
        isoWeek: '2026-W40',
        snapshot: snapshotWithMonths(8), // 8 months -> 'excellent' (100)
        clock: fixedClock(EPOCH),
      });
    });

    it('serves the stored score with its breakdown and names excluded components', async () => {
      const response = await h.request({
        method: 'GET',
        url: '/insights/health-score',
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as {
        healthScore: {
          isoWeek: string;
          overall: number | null;
          components: readonly {
            component: string;
            value: unknown;
            band: string;
            weight: string;
            score: number;
            direction: string;
          }[];
          excluded: readonly { component: string; reason: string }[];
          computedAt: string;
        };
      };

      // "Current" is the latest computed week — W40, not W38.
      expect(body.healthScore.isoWeek).toBe('2026-W40');
      expect(typeof body.healthScore.computedAt).toBe('string');

      // Exactly one computable component (emergency_fund_months, 8 months -> 'excellent');
      // the other five are named in `excluded`, never silently dropped and never zero.
      expect(body.healthScore.components).toHaveLength(1);
      const emergency = body.healthScore.components[0];
      expect(emergency?.component).toBe('emergency_fund_months');
      expect(emergency?.band).toBe('excellent');
      expect(emergency?.score).toBe(100);
      expect(typeof emergency?.value).toBe('string'); // a decimal string, never a JSON number
      expect(typeof emergency?.weight).toBe('string');
      // Direction is against the previous *stored* week (W38, 2 months -> 'poor'),
      // not against today's snapshot or no data at all.
      expect(emergency?.direction).toBe('improved');

      expect(body.healthScore.excluded).toHaveLength(5);
      for (const excluded of body.healthScore.excluded) {
        expect(typeof excluded.reason).toBe('string');
        expect(excluded.reason.length).toBeGreaterThan(0);
      }
      expect(body.healthScore.excluded.map((e) => e.component).sort()).toEqual(
        [
          'debt_to_income',
          'diversification',
          'fee_drag',
          'savings_rate',
          'subscription_load',
        ].sort(),
      );

      // The weighted average over the one computable component is just its own score.
      expect(body.healthScore.overall).toBe(100);
    });

    it('a health score belonging to one holder is never served to another', async () => {
      const otherUserId = await h.database.createUser('Health Score Second Holder');
      const otherSession = await h.issueSession({ userId: otherUserId, fresh: false });

      const response = await h.request({
        method: 'GET',
        url: '/insights/health-score',
        session: otherSession,
      });
      expect(response.statusCode).toBe(404);
      expect(problemOf(response)['code']).toBe('insights.health_score_not_computed');
    });
  });
});
