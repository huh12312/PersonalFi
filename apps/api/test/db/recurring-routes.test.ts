// SPDX-License-Identifier: MIT
/**
 * `/recurring/*` — WP 2.r's REST surface over `@ctx/recurring`, over a real
 * database. Session-only throughout (`routes/recurring.ts`'s module comment).
 *
 * Candidates are produced the way `phase2-wiring.test.ts` produces one: two
 * perfectly regular monthly charges from one payee score `EARLY_DETECTION`
 * (capped at 0.70), above `CANDIDATE_CONFIDENCE` (0.55) and below
 * `AUTO_CONFIRM_CONFIDENCE` (0.8) — a real `recurring_candidates` row, driven
 * through the real `module.recurring` consumer (`createRecurringConsumer`),
 * not a raw insert.
 */
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { createRecurringLedgerPort } from '../../src/domain.ts';
import { createRecurringConsumer } from '@ctx/recurring';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCandidate {
  readonly candidateId: string;
  readonly merchantId: string;
}
interface WireSeries {
  readonly id: string;
  readonly merchantId: string;
  readonly userConfirmed: boolean;
  readonly state: string;
}

async function drainRecurring(h: ApiHarness): Promise<void> {
  const pump = createConsumerPump({
    pool: h.database.pool,
    db: platformExecutor(h.database.db),
    clock: systemClock,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    consumers: [
      createRecurringConsumer({
        database: h.database.db,
        port: createRecurringLedgerPort(h.database.db),
        options: { timeZone: 'UTC' },
      }),
    ],
  });
  await pump.drain();
}

describe.skipIf(NO_DATABASE)('/recurring (WP 2.r)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp-recurring' });
    const today = DateOnly.parse(systemClock.now().toISOString().slice(0, 10));
    const dates = [1, 0].map((monthsAgo) => DateOnly.addMonths(today, -monthsAgo));

    await linkManual(h, {
      providerConnectionId: 'wp-recurring-conn',
      displayName: 'Recurring Test Bank',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: dates.map((date, index) =>
          manualTransaction({
            providerAccountId: 'checking',
            providerTransactionId: `wp-recurring-${String(index)}`,
            amount: money(-1_599n, 'USD'),
            postedDate: date,
            name: 'NETFLIX.COM',
            merchantName: 'Netflix',
          }),
        ),
      },
    });
    await drainRecurring(h);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('refuses every recurring route without a session, with 401', async () => {
    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    const someId = '00000000-0000-4000-8000-000000000000';
    const attempts = [
      { method: 'GET' as const, url: '/recurring/series', session: noSession },
      { method: 'GET' as const, url: '/recurring/candidates', session: noSession },
      {
        method: 'POST' as const,
        url: `/recurring/candidates/${someId}/confirm`,
        session: noSession,
        body: {},
      },
      {
        method: 'POST' as const,
        url: `/recurring/candidates/${someId}/reject`,
        session: noSession,
        body: {},
      },
      {
        method: 'POST' as const,
        url: `/recurring/series/${someId}/merge`,
        session: noSession,
        body: { targetSeriesId: someId },
      },
      { method: 'GET' as const, url: '/recurring/upcoming', session: noSession },
      { method: 'GET' as const, url: '/recurring/forecast', session: noSession },
      { method: 'GET' as const, url: '/recurring/safe-to-spend', session: noSession },
    ];
    for (const attempt of attempts) {
      const response = await h.request(attempt);
      expect(response.statusCode).toBe(401);
      expect(problemOf(response)['code']).toBe('not_authenticated');
    }
  });

  it('lists the candidate the real detector proposed', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/recurring/candidates',
      session: h.stale,
    });
    expectStatus(response, 200);
    const { candidates } = response.json() as { candidates: WireCandidate[] };
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('confirming a candidate pins the series', async () => {
    const list = await h.request({ method: 'GET', url: '/recurring/candidates', session: h.stale });
    const candidate = (list.json() as { candidates: WireCandidate[] }).candidates[0];
    expect(candidate).toBeDefined();

    const confirmed = await h.request({
      method: 'POST',
      url: `/recurring/candidates/${candidate?.candidateId ?? ''}/confirm`,
      session: h.stale,
      body: {},
    });
    expectStatus(confirmed, 200);
    const { seriesId } = confirmed.json() as { seriesId: string };

    const series = await h.request({ method: 'GET', url: '/recurring/series', session: h.stale });
    expectStatus(series, 200);
    const row = (series.json() as { series: WireSeries[] }).series.find((s) => s.id === seriesId);
    expect(row?.userConfirmed).toBe(true);
    expect(row?.state).toBe('ACTIVE');

    // Confirming twice is a no-op that reports "not found" — the candidate
    // has already been decided (`confirmCandidate`'s own doc).
    const again = await h.request({
      method: 'POST',
      url: `/recurring/candidates/${candidate?.candidateId ?? ''}/confirm`,
      session: h.stale,
      body: {},
    });
    expect(again.statusCode).toBe(404);
  });

  it('projects the confirmed series into upcoming/forecast/safe-to-spend', async () => {
    const upcoming = await h.request({
      method: 'GET',
      url: '/recurring/upcoming',
      session: h.stale,
    });
    expectStatus(upcoming, 200);
    expect((upcoming.json() as { chargeCount: number }).chargeCount).toBeGreaterThan(0);

    const forecast = await h.request({
      method: 'GET',
      url: '/recurring/forecast',
      session: h.stale,
    });
    expectStatus(forecast, 200);
    expect((forecast.json() as { chargeCount: number }).chargeCount).toBeGreaterThan(0);

    const safeToSpend = await h.request({
      method: 'GET',
      url: '/recurring/safe-to-spend',
      session: h.stale,
    });
    expectStatus(safeToSpend, 200);
    expect((safeToSpend.json() as { committedCount: number }).committedCount).toBeGreaterThan(0);
  });

  it('a series belonging to one user is invisible and unreachable to another', async () => {
    const series = await h.request({ method: 'GET', url: '/recurring/series', session: h.stale });
    const mine = (series.json() as { series: WireSeries[] }).series[0];
    expect(mine).toBeDefined();

    const otherUserId = await h.database.createUser('Recurring Second Holder');
    const otherSession = await h.issueSession({ userId: otherUserId });

    const theirSeries = await h.request({
      method: 'GET',
      url: '/recurring/series',
      session: otherSession,
    });
    expectStatus(theirSeries, 200);
    expect((theirSeries.json() as { series: unknown[] }).series).toEqual([]);

    const merge = await h.request({
      method: 'POST',
      url: `/recurring/series/${mine?.id ?? ''}/merge`,
      session: otherSession,
      body: { targetSeriesId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(merge.statusCode).toBe(404);
  });
});
