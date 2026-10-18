// SPDX-License-Identifier: MIT
/**
 * WP 10.13 (V6), against Postgres: net worth by account type, bucketed, in one read
 * (`readNetWorthBuckets`), and the milestone detector (`recordMilestoneCrossings`, wired into
 * `runSnapshot`).
 *
 * The rows are written straight into `net_worth_daily` in the exact shape `net-worth.ts` writes (and
 * `net_worth_breakdown_is_well_formed` polices), so each test controls its days precisely; one test runs
 * the real snapshotter over the hand-computation fixture so the segments are also checked against a
 * breakdown nobody hand-built. Scratch database `wp1013_nw_buckets`.
 */
import { fixedClock, newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bucketSpine,
  readNetWorthBuckets,
  type NetWorthBucket,
  type NetWorthBucketing,
  type SegmentAccountLookup,
} from '../../src/buckets.ts';
import {
  listUndismissedMilestones,
  dismissMilestones,
  recordMilestoneCrossings,
} from '../../src/milestones.ts';
import { runSnapshot } from '../../src/snapshot.ts';
import { readSeries, type PlanningExecutor } from '../../src/store.ts';
import { portsOf, type FakeWorld } from '../fakes.ts';
import { CORRELATION_ID, NO_DATABASE } from './harness.ts';
import fixture from '../fixtures/hand-computation.json' with { type: 'json' };

const K = 100_000n; // $1,000.00 in minor units
const NO_ACCOUNTS: SegmentAccountLookup = new Map();

interface Entry {
  readonly accountId: string;
  readonly kind: 'cash' | 'credit' | 'loan' | 'investment' | 'manual_asset' | 'other';
  readonly side: 'asset' | 'liability';
  readonly baseMinor: bigint;
  readonly inNetWorth?: boolean;
  readonly currency?: string;
}

/** One `net_worth_daily` row in `net-worth.ts`'s exact shape: assets/liabilities over `inNetWorth`, signed. */
async function insertDay(
  executor: PlanningExecutor,
  userId: string,
  date: string,
  entries: readonly Entry[],
  options: {
    readonly baseCurrency?: string;
    readonly revision?: number;
    readonly open?: boolean;
  } = {},
): Promise<bigint> {
  const counted = entries.filter((entry) => entry.inNetWorth !== false);
  const assets = counted
    .filter((entry) => entry.side === 'asset')
    .reduce((sum, entry) => sum + entry.baseMinor, 0n);
  const liabilities = -counted
    .filter((entry) => entry.side === 'liability')
    .reduce((sum, entry) => sum + entry.baseMinor, 0n);
  const net = assets - liabilities;
  const base = options.baseCurrency ?? 'USD';
  const breakdown = entries.map((entry) => ({
    accountId: entry.accountId,
    currency: entry.currency ?? base,
    nativeMinor: entry.baseMinor.toString(),
    baseMinor: entry.baseMinor.toString(),
    fxRate: '1',
    fxRateDate: date,
    onBudget: false,
    inNetWorth: entry.inNetWorth !== false,
    isLiquid: false,
    isInvestable: false,
    side: entry.side,
    kind: entry.kind,
    valuation: 'observed',
    stalePrice: false,
  }));
  const revision = options.revision ?? 1;
  await executor.execute(sql`
    INSERT INTO net_worth_daily (
      id, user_id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
      net_worth_minor, liquid_minor, investable_minor, on_budget_minor, breakdown, source,
      accounts_counted, accounts_unvalued, sealed_at, correction_reason, supersedes_id
    ) VALUES (
      ${newId()}::uuid, ${userId}::uuid, ${date}::date, ${revision}, ${base},
      ${assets.toString()}::bigint, ${liabilities.toString()}::bigint, ${net.toString()}::bigint,
      0, 0, 0, ${JSON.stringify(breakdown)}::jsonb, ${revision > 1 ? 'corrected' : 'observed'},
      ${entries.length}, 0,
      ${options.open === true ? null : `${date}T06:00:00Z`}::timestamptz,
      ${revision > 1 ? 'a test correction' : null},
      (SELECT id FROM net_worth_daily
        WHERE user_id = ${userId}::uuid AND as_of_date = ${date}::date AND revision = ${revision - 1})
    )
  `);
  return net;
}

/** A small, varied roster: every kind, a liability, an excluded account. */
function rosterOn(dayIndex: number): Entry[] {
  const wobble = BigInt((dayIndex * 7919) % 50_000);
  return [
    { accountId: 'a-checking', kind: 'cash', side: 'asset', baseMinor: 12n * K + wobble },
    {
      accountId: 'a-brokerage',
      kind: 'investment',
      side: 'asset',
      baseMinor: 80n * K + wobble * 3n,
    },
    { accountId: 'a-crypto', kind: 'investment', side: 'asset', baseMinor: 5n * K - wobble },
    { accountId: 'a-house', kind: 'manual_asset', side: 'asset', baseMinor: 400n * K },
    { accountId: 'a-card', kind: 'credit', side: 'liability', baseMinor: -(3n * K + wobble) },
    { accountId: 'a-mortgage', kind: 'loan', side: 'liability', baseMinor: -(300n * K) + wobble },
    // Liquid but not in net worth: never in a segment, never in the net.
    { accountId: 'a-side', kind: 'cash', side: 'asset', baseMinor: 9n * K, inNetWorth: false },
  ];
}

const LEDGER: SegmentAccountLookup = new Map([
  ['a-checking', { type: 'depository', subtype: 'checking' }],
  ['a-brokerage', { type: 'investment', subtype: 'brokerage' }],
  ['a-crypto', { type: 'crypto', subtype: null }],
  ['a-house', { type: 'manual', subtype: 'real_estate' }],
  ['a-card', { type: 'credit', subtype: 'credit_card' }],
  ['a-mortgage', { type: 'loan', subtype: 'mortgage' }],
  ['a-side', { type: 'depository', subtype: 'checking' }],
]);

function sumOf(bucket: NetWorthBucket): bigint {
  return bucket.segments.reduce((total, segment) => total + segment.amountMinor, 0n);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(NO_DATABASE)('net worth by account type, bucketed (WP 10.13)', () => {
  let database: TestDatabase;
  let executor: PlanningExecutor;
  /** A holder with 400 consecutive days, a gap week and one corrected day. */
  let dense: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp1013_nw_buckets');
    executor = database.db;
    dense = await database.createUser('Dense Holder');
    for (let i = 0; i < 400; i += 1) {
      const date = addDays('2025-09-01', i);
      // 2026-03-09 … 2026-03-15 (a whole Monday–Sunday week) has no snapshot at all.
      if (date >= '2026-03-09' && date <= '2026-03-15') continue;
      await insertDay(executor, dense, date, rosterOn(i));
    }
    // A corrected day: revision 2 replaces the house figure; the current revision must win.
    await insertDay(
      executor,
      dense,
      '2026-01-31',
      rosterOn(152).map((entry) =>
        entry.accountId === 'a-house' ? { ...entry, baseMinor: 410n * K } : entry,
      ),
      { revision: 2 },
    );
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  it.each(['day', 'week', 'month'] as const)(
    'Σ segments = the net series on the closing day, for every %s bucket',
    async (bucketing: NetWorthBucketing) => {
      const from = '2025-09-01';
      const to = '2026-10-05';
      const [buckets, series] = await Promise.all([
        readNetWorthBuckets(executor, { userId: dense, from, to, bucketing, accounts: LEDGER }),
        readSeries(executor, { userId: dense, from, to }),
      ]);
      const netByDay = new Map(series.map((point) => [point.asOfDate, point.netWorthMinor]));
      expect(buckets).toHaveLength(bucketSpine(from, to, bucketing).length);
      let checked = 0;
      for (const bucket of buckets) {
        if (bucket.asOfDate === null) continue;
        expect(bucket.netWorthMinor, bucket.start).toBe(netByDay.get(bucket.asOfDate));
        expect(sumOf(bucket), `Σ segments, ${bucket.start}`).toBe(bucket.netWorthMinor);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(bucketing === 'day' ? 380 : bucketing === 'week' ? 50 : 12);
    },
  );

  it('the closing day is the last snapshot in the bucket; the corrected revision is the one read', async () => {
    const buckets = await readNetWorthBuckets(executor, {
      userId: dense,
      from: '2026-01-01',
      to: '2026-02-28',
      bucketing: 'month',
      accounts: LEDGER,
    });
    expect(buckets.map((bucket) => [bucket.start, bucket.end, bucket.asOfDate])).toEqual([
      ['2026-01-01', '2026-01-31', '2026-01-31'],
      ['2026-02-01', '2026-02-28', '2026-02-28'],
    ]);
    const january = buckets[0]!;
    expect(january.segments.find((segment) => segment.kind === 'property')?.amountMinor).toBe(
      410n * K,
    );
  });

  it('weekly buckets run Monday to Sunday: a Sunday closes its own week, a Monday opens the next', async () => {
    // 2026-10-04 is a Sunday, 2026-10-05 a Monday. The window opens on Thursday 2026-10-01.
    const buckets = await readNetWorthBuckets(executor, {
      userId: dense,
      from: '2026-10-01',
      to: '2026-10-05',
      bucketing: 'week',
      accounts: LEDGER,
    });
    expect(buckets.map((bucket) => [bucket.start, bucket.end, bucket.asOfDate])).toEqual([
      ['2026-10-01', '2026-10-04', '2026-10-04'],
      ['2026-10-05', '2026-10-05', '2026-10-05'],
    ]);
  });

  it('a bucket with no snapshot is a gap — nulls and no segments, never a zero', async () => {
    const buckets = await readNetWorthBuckets(executor, {
      userId: dense,
      from: '2026-03-02',
      to: '2026-03-22',
      bucketing: 'week',
      accounts: LEDGER,
    });
    expect(buckets.map((bucket) => bucket.start)).toEqual([
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
    ]);
    expect(buckets[1]).toEqual({
      start: '2026-03-09',
      end: '2026-03-15',
      asOfDate: null,
      currency: null,
      netWorthMinor: null,
      segments: [],
    });
    expect(buckets[0]!.asOfDate).toBe('2026-03-08');
    expect(buckets[2]!.asOfDate).toBe('2026-03-22');
  });

  it('a window with no snapshots at all is every bucket a gap', async () => {
    const buckets = await readNetWorthBuckets(executor, {
      userId: dense,
      from: '2020-01-01',
      to: '2020-03-31',
      bucketing: 'month',
      accounts: LEDGER,
    });
    expect(buckets).toHaveLength(3);
    expect(
      buckets.every((bucket) => bucket.asOfDate === null && bucket.segments.length === 0),
    ).toBe(true);
  });

  it('segments by account type: side first, ledger type next; an excluded account is in none', async () => {
    const [bucket] = await readNetWorthBuckets(executor, {
      userId: dense,
      from: '2025-09-01',
      to: '2025-09-01',
      bucketing: 'day',
      accounts: LEDGER,
    });
    const roster = rosterOn(0);
    const of = (id: string) => roster.find((entry) => entry.accountId === id)!.baseMinor;
    expect(bucket!.segments).toEqual([
      { kind: 'cash', amountMinor: of('a-checking'), accounts: 1 },
      { kind: 'investments', amountMinor: of('a-brokerage'), accounts: 1 },
      { kind: 'crypto', amountMinor: of('a-crypto'), accounts: 1 },
      { kind: 'property', amountMinor: of('a-house'), accounts: 1 },
      { kind: 'liabilities', amountMinor: of('a-card') + of('a-mortgage'), accounts: 2 },
    ]);
    // Liabilities are negative: they are drawn below the zero line.
    expect(bucket!.segments.at(-1)!.amountMinor < 0n).toBe(true);

    // Without the ledger lookup (an account since deleted), the breakdown's own class decides.
    const [fallback] = await readNetWorthBuckets(executor, {
      userId: dense,
      from: '2025-09-01',
      to: '2025-09-01',
      bucketing: 'day',
      accounts: NO_ACCOUNTS,
    });
    expect(fallback!.segments.map((segment) => segment.kind)).toEqual([
      'cash',
      'investments',
      'other',
      'liabilities',
    ]);
    expect(sumOf(fallback!)).toBe(fallback!.netWorthMinor);
  });

  it('D4: a window across a base-currency change keeps each bucket in its own day’s currency, never summed', async () => {
    const holder = await database.createUser('Two Currencies');
    await insertDay(executor, holder, '2026-08-30', rosterOn(1));
    await insertDay(executor, holder, '2026-09-02', rosterOn(2), { baseCurrency: 'CAD' });
    await insertDay(executor, holder, '2026-09-05', rosterOn(3), { baseCurrency: 'CAD' });
    const buckets = await readNetWorthBuckets(executor, {
      userId: holder,
      from: '2026-08-24',
      to: '2026-09-06',
      bucketing: 'week',
      accounts: LEDGER,
    });
    // Week of Aug 24 closes on the 30th (USD); week of Aug 31 closes on Sep 5 (CAD) — the USD days in
    // that week are not mixed into it.
    expect(buckets.map((bucket) => [bucket.start, bucket.asOfDate, bucket.currency])).toEqual([
      ['2026-08-24', '2026-08-30', 'USD'],
      ['2026-08-31', '2026-09-05', 'CAD'],
    ]);
    for (const bucket of buckets) expect(sumOf(bucket)).toBe(bucket.netWorthMinor);
  });

  it('the real snapshotter’s breakdown (the hand-computation fixture) sums to its net', async () => {
    const holder = await database.createUser('Fixture Holder');
    const world = fixture.world as unknown as FakeWorld;
    await runSnapshot(executor, portsOf(world), {
      userId: holder,
      clock: fixedClock(new Date('2026-06-15T18:00:00Z')),
      timeZone: 'America/New_York',
      baseCurrency: 'USD',
      correlationId: CORRELATION_ID,
    });
    const [bucket] = await readNetWorthBuckets(executor, {
      userId: holder,
      from: '2026-06-15',
      to: '2026-06-15',
      bucketing: 'day',
      accounts: NO_ACCOUNTS,
    });
    expect(bucket!.netWorthMinor).toBe(BigInt(fixture.expected.netWorthMinor));
    expect(sumOf(bucket!)).toBe(BigInt(fixture.expected.netWorthMinor));
  });
});

describe.skipIf(NO_DATABASE)('net-worth milestones (WP 10.13)', () => {
  let database: TestDatabase;
  let executor: PlanningExecutor;
  const clock = fixedClock(new Date('2026-10-03T16:00:00Z'));

  beforeAll(async () => {
    database = await createTestDatabase('wp1013_nw_milestones');
    executor = database.db;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  function cashOf(minor: bigint): Entry[] {
    return [{ accountId: 'a-checking', kind: 'cash', side: 'asset', baseMinor: minor }];
  }

  async function eventsFor(userId: string) {
    const result = await executor.execute<{ payload: Record<string, string> }>(sql`
      SELECT payload FROM domain_events
       WHERE user_id = ${userId}::uuid AND event_type = 'planning.NetWorthMilestoneCrossed'
       ORDER BY seq
    `);
    return result.rows.map((row) => row.payload);
  }

  async function rowsFor(userId: string) {
    const result = await executor.execute<{ milestone_minor: string; direction: string }>(sql`
      SELECT milestone_minor::text AS milestone_minor, direction FROM net_worth_milestones
       WHERE user_id = ${userId}::uuid ORDER BY created_at, milestone_minor
    `);
    return result.rows.map((row) => `${row.direction} ${row.milestone_minor}`);
  }

  const ctx = (userId: string) => ({ userId, clock, correlationId: CORRELATION_ID });

  it('crossing up records one milestone and appends one event', async () => {
    const holder = await database.createUser('Up');
    await insertDay(executor, holder, '2026-10-02', cashOf(48n * K));
    const net = await insertDay(executor, holder, '2026-10-03', cashOf(51n * K), { open: true });
    const recorded = await recordMilestoneCrossings(executor, ctx(holder), {
      asOfDate: '2026-10-03',
      baseCurrency: 'USD',
      netWorthMinor: net,
    });
    expect(recorded.map((m) => m.milestoneMinor)).toEqual([50n * K]);
    expect(await rowsFor(holder)).toEqual([`up ${String(50n * K)}`]);
    const events = await eventsFor(holder);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      milestoneMinor: String(50n * K),
      direction: 'up',
      currency: 'USD',
      crossedOn: '2026-10-03',
      previousMinor: String(48n * K),
      latestMinor: String(51n * K),
    });
  });

  it('never twice: a recompute, a dip and a recovery all find the milestone taken', async () => {
    const holder = await database.createUser('Twice');
    await insertDay(executor, holder, '2026-10-02', cashOf(48n * K));
    for (const latest of [51n * K, 52n * K, 49n * K, 53n * K]) {
      await recordMilestoneCrossings(executor, ctx(holder), {
        asOfDate: '2026-10-03',
        baseCurrency: 'USD',
        netWorthMinor: latest,
      });
    }
    expect(await rowsFor(holder)).toEqual([`up ${String(50n * K)}`]);
    expect(await eventsFor(holder)).toHaveLength(1);
  });

  it('a jump across two milestones records and announces both', async () => {
    const holder = await database.createUser('Jump');
    await insertDay(executor, holder, '2026-10-02', cashOf(20n * K));
    const recorded = await recordMilestoneCrossings(executor, ctx(holder), {
      asOfDate: '2026-10-03',
      baseCurrency: 'USD',
      netWorthMinor: 60n * K,
    });
    expect(recorded.map((m) => m.milestoneMinor)).toEqual([25n * K, 50n * K]);
    expect(await eventsFor(holder)).toHaveLength(2);
  });

  it('crossing down through zero, then back up, are two milestones — once each', async () => {
    const holder = await database.createUser('Zero');
    await insertDay(executor, holder, '2026-10-01', cashOf(3n * K));
    await recordMilestoneCrossings(executor, ctx(holder), {
      asOfDate: '2026-10-02',
      baseCurrency: 'USD',
      netWorthMinor: -2n * K,
    });
    await insertDay(executor, holder, '2026-10-02', cashOf(-2n * K));
    await recordMilestoneCrossings(executor, ctx(holder), {
      asOfDate: '2026-10-03',
      baseCurrency: 'USD',
      netWorthMinor: 1n * K,
    });
    expect(await rowsFor(holder)).toEqual(['down 0', 'up 0']);
    expect((await eventsFor(holder)).map((event) => event['direction'])).toEqual(['down', 'up']);
  });

  it('no previous day, or a previous day in another base currency, is never a crossing', async () => {
    const first = await database.createUser('First');
    expect(
      await recordMilestoneCrossings(executor, ctx(first), {
        asOfDate: '2026-10-03',
        baseCurrency: 'USD',
        netWorthMinor: 60n * K,
      }),
    ).toEqual([]);
    const switched = await database.createUser('Switched');
    await insertDay(executor, switched, '2026-10-02', cashOf(20n * K), { baseCurrency: 'CAD' });
    expect(
      await recordMilestoneCrossings(executor, ctx(switched), {
        asOfDate: '2026-10-03',
        baseCurrency: 'USD',
        netWorthMinor: 60n * K,
      }),
    ).toEqual([]);
    expect(await eventsFor(first)).toHaveLength(0);
    expect(await eventsFor(switched)).toHaveLength(0);
  });

  it('runSnapshot detects it in the same transaction as the open day, and a second run says nothing', async () => {
    const holder = await database.createUser('Snapshotter');
    // The fixture's net worth is $152,080.17; yesterday stood at $95,000.
    await insertDay(executor, holder, '2026-06-14', cashOf(95n * K));
    const world = fixture.world as unknown as FakeWorld;
    const run = () =>
      database.db.transaction(async (tx) =>
        runSnapshot(tx, portsOf(world), {
          userId: holder,
          clock: fixedClock(new Date('2026-06-15T18:00:00Z')),
          timeZone: 'America/New_York',
          baseCurrency: 'USD',
          correlationId: CORRELATION_ID,
        }),
      );
    await run();
    await run();
    expect(await rowsFor(holder)).toEqual([`up ${String(100n * K)}`]);
    expect(await eventsFor(holder)).toHaveLength(1);
  });

  it('listing and dismissing: newest first; a dismissed milestone never lists again', async () => {
    const holder = await database.createUser('Dismiss');
    await insertDay(executor, holder, '2026-10-02', cashOf(20n * K));
    await recordMilestoneCrossings(executor, ctx(holder), {
      asOfDate: '2026-10-03',
      baseCurrency: 'USD',
      netWorthMinor: 60n * K,
    });
    const listed = await listUndismissedMilestones(executor, holder);
    expect(listed.map((m) => m.milestoneMinor)).toEqual([50n * K, 25n * K]);
    expect(
      await dismissMilestones(executor, { userId: holder, ids: listed.map((m) => m.id), clock }),
    ).toBe(2);
    expect(await listUndismissedMilestones(executor, holder)).toEqual([]);
    // Idempotent, and another holder's ids are never touched.
    expect(
      await dismissMilestones(executor, { userId: holder, ids: listed.map((m) => m.id), clock }),
    ).toBe(0);
  });
});
