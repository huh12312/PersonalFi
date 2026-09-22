// SPDX-License-Identifier: MIT
/**
 * WP 3.13 carry-over (03-phase-3-dispatch.md §2, wp2.11-inbox-ui.md §5):
 * "Inbox's third queue has no data source (`pending_review` has no
 * reader)." The dispatch plan flagged the claim as **stale as written** and
 * asked this work package to verify first: `apps/api/src/routes/insights.ts`
 * exists (WP 2.r, `28b81f1`), so what was missing, if anything, was a
 * `pending_review` *filter* on it, not the route itself.
 *
 * ## What this test found
 *
 * `GET /insights` already accepted a `statuses` querystring
 * (`z.array(z.enum(INSIGHT_STATUSES)).optional()`) before this work package
 * touched the file — the route's own default is every status
 * (`request.query.statuses ?? [...INSIGHT_STATUSES]`), which is why the
 * *default* response includes reviewed insights alongside the review queue
 * (`insights-routes.test.ts`'s own comment: "the feed carries `pending_review`
 * *and* reviewed insights"). The filter the inbox needs — "give me only the
 * queue, nothing already decided" — was already expressible as
 * `?statuses=pending_review`; nothing in the route needed to change. This
 * file is the proof that was missing, not a fix.
 *
 * `wp2.11-inbox-ui.md` §5's claim is deleted as stale by this work package;
 * see docs/evidence/phase-3/wp3.13-carry-overs.md item 8 for the disposition.
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
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CASH_ADVISOR_ID = 'builtin.cash.emergency_fund_short';

interface WireInsight {
  readonly id: string;
  readonly status: string;
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
      tokenSecret: 'wp-insights-pending-review-secret',
    },
  };
}

describe.skipIf(NO_DATABASE)(
  'GET /insights?statuses=pending_review returns exactly the inbox queue (WP 3.13, wp2.11-inbox-ui.md §5)',
  () => {
    let h: ApiHarness;
    let insightId: string;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp-insights-pending' });

      await linkManual(h, {
        providerConnectionId: 'wp-insights-pending-conn',
        displayName: 'Pending Review Test Bank',
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
              providerTransactionId: 'wp-insights-pending-spend',
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

      const feed = await h.request({ method: 'GET', url: '/insights', session: h.stale });
      const body = feed.json() as { dashboard: WireInsight[]; list: WireInsight[] };
      const found = [...body.dashboard, ...body.list].find((i) => i.status === 'pending_review');
      if (found === undefined) throw new Error('no pending_review insight seeded');
      insightId = found.id;
    }, 120_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it('the pending_review filter returns exactly the queue the inbox needs', async () => {
      interface Feed {
        readonly dashboard: WireInsight[];
        readonly list: WireInsight[];
        readonly overflow: WireInsight[];
        readonly belowFloor: WireInsight[];
      }
      // `list` is `dashboard`'s superset by design (`alert-budget.ts`'s
      // `applyAlertBudget`: both slices are taken from rank 0, `dashboard`
      // just stops sooner) — deduplicated by id here so this test's own
      // counting does not double a row the budget deliberately shows twice.
      const uniqueOf = (feed: Feed): WireInsight[] => {
        const byId = new Map<string, WireInsight>();
        for (const row of [...feed.dashboard, ...feed.list, ...feed.overflow, ...feed.belowFloor]) {
          byId.set(row.id, row);
        }
        return [...byId.values()];
      };

      // Before review: the filter and the unfiltered feed agree — one row,
      // pending_review.
      const before = await h.request({
        method: 'GET',
        url: '/insights?statuses=pending_review',
        session: h.stale,
      });
      expectStatus(before, 200);
      const beforeAll = uniqueOf(before.json() as Feed);
      expect(beforeAll.some((i) => i.id === insightId)).toBe(true);
      expect(beforeAll.every((i) => i.status === 'pending_review')).toBe(true);

      // Dismiss it — now it exists, but it is not in the queue any more.
      const reviewed = await h.request({
        method: 'POST',
        url: `/insights/${insightId}/review`,
        session: h.stale,
        body: { action: 'dismiss', reason: 'wp3.13 pending_review filter proof' },
      });
      expectStatus(reviewed, 200);

      // The queue the inbox reads: exactly zero of the insight this test
      // dismissed, and every row still returned is genuinely pending_review
      // — the sabotage this pins is a filter that only *narrows* by name but
      // still lets a reviewed row through.
      const after = await h.request({
        method: 'GET',
        url: '/insights?statuses=pending_review',
        session: h.stale,
      });
      expectStatus(after, 200);
      const afterAll = uniqueOf(after.json() as Feed);
      expect(afterAll.some((i) => i.id === insightId)).toBe(false);
      expect(afterAll.every((i) => i.status === 'pending_review')).toBe(true);

      // The unfiltered default still carries it, dismissed — proving the
      // filter's absence above is a query answer, not the row having
      // vanished (which `insights-routes.test.ts` already covers in detail).
      const unfiltered = await h.request({ method: 'GET', url: '/insights', session: h.stale });
      expectStatus(unfiltered, 200);
      const unfilteredBody = unfiltered.json() as { dashboard: WireInsight[]; list: WireInsight[] };
      const stillThere = [...unfilteredBody.dashboard, ...unfilteredBody.list].find(
        (i) => i.id === insightId,
      );
      expect(stillThere?.status).toBe('dismissed');

      // And filtering explicitly for `dismissed` finds exactly the row that
      // disappeared from the pending_review queue above.
      const dismissedOnly = await h.request({
        method: 'GET',
        url: '/insights?statuses=dismissed',
        session: h.stale,
      });
      expectStatus(dismissedOnly, 200);
      const dismissedAll = uniqueOf(dismissedOnly.json() as Feed);
      expect(dismissedAll.map((i) => i.id)).toEqual([insightId]);
    });
  },
);
