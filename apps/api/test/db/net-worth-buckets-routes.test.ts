// SPDX-License-Identifier: MIT
/**
 * WP 10.13 (V6), over the route: `GET /net-worth/series?bucket=…` returns the stacked chart's buckets
 * beside the series it always returned, and the net of every bucket's segments is the series' own value
 * on the bucket's closing day — the dispatch's "the net of the segments must equal the existing net series
 * for every bucket", asserted on the wire for all three bucketings. Plus the milestone list and dismiss.
 *
 * The days are written straight into `net_worth_daily` in `net-worth.ts`'s shape against real ledger
 * accounts (so the ledger type decides crypto vs brokerage), because the point is the read, not the
 * snapshotter (which `@ctx/planning`'s own db test runs). Scratch database `personalfi_api_wp1013_nw_*`.
 */
import { fixedClock, newId } from '@core/kernel';
import { recordMilestoneCrossings } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface Money {
  readonly minor: string;
  readonly currency: string;
}

interface BucketBody {
  readonly start: string;
  readonly end: string;
  readonly asOfDate: string | null;
  readonly netWorth: Money | null;
  readonly segments: readonly { kind: string; amount: Money; accounts: number }[];
  readonly sealed: boolean;
  readonly source: string | null;
}

interface SeriesBody {
  readonly points: readonly { asOfDate: string; netWorth: Money | null }[];
  readonly bucketing: string | null;
  readonly buckets: readonly BucketBody[] | null;
}

const FROM = '2026-01-01';
const TO = '2026-06-30';

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(NO_DATABASE)('GET /net-worth/series?bucket= and the milestones (WP 10.13)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1013_nw_routes' });
    const linked = await linkManual(h, {
      providerConnectionId: 'wp1013-conn',
      displayName: 'Test Bank',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
        { providerAccountId: 'coins', name: 'Coins', type: 'crypto', currency: 'USD' },
        { providerAccountId: 'card', name: 'Card', type: 'credit', currency: 'USD' },
      ],
    });
    const [checking, coins, card] = linked.accountIds as [string, string, string];
    await h.database.db.execute(sql`DELETE FROM net_worth_daily WHERE user_id = ${h.userId}::uuid`);

    for (let i = 0; i < 181; i += 1) {
      const date = addDays(FROM, i);
      if (i % 11 === 5) continue; // scattered missing days
      const cash = 500_000n + BigInt((i * 7919) % 90_000);
      const crypto = 120_000n + BigInt((i * 104_729) % 40_000);
      const owed = -(80_000n + BigInt((i * 31) % 20_000));
      const breakdown = [
        [checking, 'cash', 'asset', cash],
        [coins, 'investment', 'asset', crypto],
        [card, 'credit', 'liability', owed],
      ].map(([accountId, kind, side, minor]) => ({
        accountId,
        currency: 'USD',
        nativeMinor: String(minor),
        baseMinor: String(minor),
        fxRate: '1',
        fxRateDate: date,
        onBudget: true,
        inNetWorth: true,
        isLiquid: false,
        isInvestable: false,
        side,
        kind,
        valuation: 'observed',
        stalePrice: false,
      }));
      const assets = cash + crypto;
      const liabilities = -owed;
      await h.database.db.execute(sql`
        INSERT INTO net_worth_daily (
          id, user_id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
          net_worth_minor, liquid_minor, investable_minor, on_budget_minor, breakdown, source,
          accounts_counted, accounts_unvalued, sealed_at
        ) VALUES (
          ${newId()}::uuid, ${h.userId}::uuid, ${date}::date, 1, 'USD',
          ${assets.toString()}::bigint, ${liabilities.toString()}::bigint,
          ${(assets - liabilities).toString()}::bigint, 0, 0, 0,
          ${JSON.stringify(breakdown)}::jsonb, 'observed', 3, 0,
          ${i === 180 ? null : `${date}T06:00:00Z`}::timestamptz
        )
      `);
    }
  }, 180_000);

  afterAll(async () => {
    await h.close();
  });

  async function series(query: string): Promise<SeriesBody> {
    const response = await h.request({
      method: 'GET',
      url: `/net-worth/series?${query}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    return response.json() as SeriesBody;
  }

  it('without `bucket` the response is the series it always was, with null buckets', async () => {
    const body = await series(`from=${FROM}&to=${TO}`);
    expect(body.bucketing).toBeNull();
    expect(body.buckets).toBeNull();
    expect(body.points).toHaveLength(181);
  });

  it.each(['day', 'week', 'month'])(
    'bucket=%s: Σ segments = netWorth = the series on the closing day, for every bucket',
    async (bucket) => {
      const body = await series(`from=${FROM}&to=${TO}&bucket=${bucket}`);
      expect(body.bucketing).toBe(bucket);
      const byDay = new Map(body.points.map((point) => [point.asOfDate, point.netWorth]));
      let checked = 0;
      for (const b of body.buckets ?? []) {
        if (b.asOfDate === null) {
          expect(b.netWorth).toBeNull();
          expect(b.segments).toEqual([]);
          continue;
        }
        const sum = b.segments.reduce((total, segment) => total + BigInt(segment.amount.minor), 0n);
        expect(String(sum), `Σ segments ${b.start}`).toBe(b.netWorth?.minor);
        expect(b.netWorth, `the series on ${b.asOfDate}`).toEqual(byDay.get(b.asOfDate));
        checked += 1;
      }
      expect(checked).toBe(bucket === 'day' ? 181 - 16 : bucket === 'week' ? 27 : 6);
    },
  );

  it('the ledger type decides the segment: crypto is crypto, the card is a negative liability', async () => {
    const body = await series(`from=2026-01-01&to=2026-01-01&bucket=day`);
    const [bucket] = body.buckets ?? [];
    expect(bucket?.segments.map((segment) => segment.kind)).toEqual([
      'cash',
      'crypto',
      'liabilities',
    ]);
    expect(BigInt(bucket!.segments[2]!.amount.minor) < 0n).toBe(true);
    expect(bucket?.sealed).toBe(true);
  });

  it('the last bucket closes on the live day, labelled unsealed', async () => {
    const body = await series(`from=${FROM}&to=${TO}&bucket=month`);
    const june = body.buckets?.at(-1);
    expect(june).toMatchObject({ start: '2026-06-01', end: '2026-06-30', asOfDate: '2026-06-30' });
    expect(june?.sealed).toBe(false);
  });

  it('an unknown bucketing is a 400', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/net-worth/series?from=${FROM}&to=${TO}&bucket=year`,
      session: h.stale,
    });
    expectStatus(response, 400);
  });

  it('milestones: listed newest first, dismissed once, never listed again', async () => {
    const clock = fixedClock(new Date('2026-07-01T16:00:00Z'));
    await recordMilestoneCrossings(
      h.database.db,
      { userId: h.userId, clock, correlationId: '01920000-0000-7000-8000-0000000000c8' },
      { asOfDate: '2026-07-01', baseCurrency: 'USD', netWorthMinor: 6_000_000n },
    );
    const listed = await h.request({
      method: 'GET',
      url: '/net-worth/milestones',
      session: h.stale,
    });
    expectStatus(listed, 200);
    const { milestones } = listed.json() as {
      milestones: { id: string; milestone: Money; direction: string; crossedOn: string }[];
    };
    // The previous day (June 30) stood near $5,4xx; $60,000 crosses $10k, $25k and $50k.
    expect(milestones.map((m) => m.milestone.minor)).toEqual(['5000000', '2500000', '1000000']);
    expect(milestones[0]).toMatchObject({ direction: 'up', crossedOn: '2026-07-01' });

    const dismissed = await h.request({
      method: 'POST',
      url: '/net-worth/milestones/dismiss',
      session: h.stale,
      body: { ids: milestones.map((m) => m.id) },
    });
    expectStatus(dismissed, 200);
    expect(dismissed.json()).toEqual({ dismissed: 3 });

    const after = await h.request({
      method: 'GET',
      url: '/net-worth/milestones',
      session: h.stale,
    });
    expect((after.json() as { milestones: unknown[] }).milestones).toEqual([]);
  });
});
