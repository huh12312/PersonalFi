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
import { createRecurringConsumer, upsertPriceChange } from '@ctx/recurring';
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
interface WirePriceChangeEvent {
  readonly id: string;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly effectiveDate: string;
  readonly fromAmount: { readonly minor: string; readonly currency: string };
  readonly toAmount: { readonly minor: string; readonly currency: string };
  readonly deltaAmount: { readonly minor: string; readonly currency: string };
  readonly annualImpact: { readonly minor: string; readonly currency: string };
  readonly confirmed: boolean;
}
interface WireSeries {
  readonly id: string;
  readonly merchantId: string;
  readonly userConfirmed: boolean;
  readonly state: string;
  readonly priceChangeEvents: readonly WirePriceChangeEvent[];
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

  // `wp3.14-carryovers.md` item 4 (`wp3.13-carryovers.md` §1 row 8b):
  // `GET /recurring/series` carries `priceChangeEvents` per series now.
  // Seeded through `upsertPriceChange` — the package's own real write
  // primitive, the same one `service.ts`'s detection pass calls — rather
  // than a raw `INSERT`, for the same "not a raw insert" reason this file's
  // header gives for its candidate. Runs after "confirming a candidate pins
  // the series" so a real, confirmed series already exists to attach the
  // event to.
  it('a series carries its price-change events', async () => {
    const before = await h.request({ method: 'GET', url: '/recurring/series', session: h.stale });
    expectStatus(before, 200);
    const mine = (before.json() as { series: WireSeries[] }).series[0];
    expect(mine).toBeDefined();
    const seriesId = mine?.id ?? '';
    expect(mine?.priceChangeEvents).toEqual([]);

    const effectiveDate = DateOnly.parse(systemClock.now().toISOString().slice(0, 10));
    await upsertPriceChange(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: 'wp-recurring-price-change-seed' },
      {
        seriesId,
        direction: 'INCREASE',
        effectiveDate,
        from: money(1_599n, 'USD'),
        to: money(1_799n, 'USD'),
        delta: money(200n, 'USD'),
        annualImpact: money(2_400n, 'USD'),
        confirmed: true,
        priorTransactionIds: [],
        recentTransactionIds: [],
      },
    );

    const after = await h.request({ method: 'GET', url: '/recurring/series', session: h.stale });
    expectStatus(after, 200);
    const row = (after.json() as { series: WireSeries[] }).series.find((s) => s.id === seriesId);
    expect(row?.priceChangeEvents).toHaveLength(1);

    const event = row?.priceChangeEvents[0];
    expect(event?.direction).toBe('INCREASE');
    expect(event?.effectiveDate).toBe(effectiveDate);
    expect(event?.fromAmount).toEqual({ minor: '1599', currency: 'USD' });
    expect(event?.toAmount).toEqual({ minor: '1799', currency: 'USD' });
    expect(event?.deltaAmount).toEqual({ minor: '200', currency: 'USD' });
    expect(event?.annualImpact).toEqual({ minor: '2400', currency: 'USD' });
    expect(event?.confirmed).toBe(true);

    // Another series (there is only this one) never carries someone else's
    // event — the per-series grouping in `listPriceChangeEventsBySeries`
    // is asserted structurally by there being exactly one event on the one
    // series that has one, not zero and not duplicated.
    for (const other of (after.json() as { series: WireSeries[] }).series) {
      if (other.id !== seriesId) expect(other.priceChangeEvents).toEqual([]);
    }
  });

  // The series was seeded from charges one month ago and today, so its next
  // occurrence is exactly one calendar month out. In a 30-day month that lands
  // on the default 30-day window's far edge (CI went red on 2026-09-24, green on
  // the 22nd), so the window is widened explicitly: what this test asserts is
  // that a confirmed series projects at all, not where the default edge falls.
  it('projects the confirmed series into upcoming/forecast/safe-to-spend', async () => {
    const upcoming = await h.request({
      method: 'GET',
      url: '/recurring/upcoming?days=45',
      session: h.stale,
    });
    expectStatus(upcoming, 200);
    expect((upcoming.json() as { chargeCount: number }).chargeCount).toBeGreaterThan(0);

    const forecast = await h.request({
      method: 'GET',
      url: '/recurring/forecast?days=45',
      session: h.stale,
    });
    expectStatus(forecast, 200);
    expect((forecast.json() as { chargeCount: number }).chargeCount).toBeGreaterThan(0);

    const safeToSpend = await h.request({
      method: 'GET',
      url: '/recurring/safe-to-spend?days=45',
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
