// SPDX-License-Identifier: MIT
/**
 * 04 §5.4's calendar spine: *"Use `generate_series` for the calendar spine so
 * there are no gaps on days with no activity — a gapless series is what makes
 * charts and deltas trivial downstream."*
 *
 * The spine is a database function rather than a range built in TypeScript, and
 * that is the point of testing it here: "the series has no gaps" becomes a
 * property of Postgres that a test can assert directly, and a future reader
 * cannot accidentally reimplement it with a `WHERE` that drops a weekend or a
 * `JOIN` that drops a day with no row.
 *
 * The case that actually breaks naive implementations is the third one: a month
 * with real activity at both ends and **nothing in the middle**. An inner join
 * against `net_worth_daily` returns the two days and calls it a series; the
 * chart then draws a straight line between them and the delta arithmetic
 * silently divides by the wrong number of days.
 */
import { fixedClock } from '@core/kernel';
import type { TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeNetWorth } from '../../src/net-worth.ts';
import { readSeries, upsertOpenDay, sealDay, type PlanningExecutor } from '../../src/store.ts';
import { portsOf, type FakeWorld } from '../fakes.ts';
import { NO_DATABASE, planningDatabase } from './harness.ts';
import fixture from '../fixtures/hand-computation.json' with { type: 'json' };

const world = fixture.world as unknown as FakeWorld;

/**
 * The world, moved wholesale to another day.
 *
 * Every dated fact moves together — balances, holdings, prices **and the FX
 * rate**. Moving only the balances leaves the CAD account with no rate for the
 * new date, and `computeNetWorth` then refuses the day with `FxRateUnavailable`
 * exactly as it should. That is the engine being right and the fixture being
 * half-moved, which is how this helper came to exist.
 */
function worldOn(date: string): FakeWorld {
  return {
    ...world,
    balances: world.balances.map((row) => ({ ...row, date })),
    holdings: (world.holdings ?? []).map((row) => ({ ...row, asOfDate: date })),
    prices: (world.prices ?? []).map((row) => ({ ...row, date })),
    fxRates: (world.fxRates ?? []).map((row) => ({ ...row, date, rateDate: date })),
  };
}

describe.skipIf(NO_DATABASE)('the calendar spine', () => {
  let database: TestDatabase;
  let executor: PlanningExecutor;

  beforeAll(async () => {
    database = await planningDatabase('spine');
    executor = database.db;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  it('the calendar spine has no gaps', async () => {
    const result = await database.db.execute<{ as_of_date: string }>(sql`
      SELECT as_of_date FROM net_worth_calendar_spine('2026-01-28'::date, '2026-03-02'::date)
      ORDER BY as_of_date
    `);
    const days = result.rows.map((row) => String(row.as_of_date).slice(0, 10));

    // 2026 is not a leap year, so February has 28 days: 4 + 28 + 2 = 34.
    expect(days).toHaveLength(34);
    expect(days[0]).toBe('2026-01-28');
    expect(days.at(-1)).toBe('2026-03-02');

    // Every adjacent pair is exactly one day apart. This is the assertion that
    // a month boundary, a weekend or a February cannot slip past.
    for (let index = 1; index < days.length; index += 1) {
      const previous = new Date(`${days[index - 1] ?? ''}T00:00:00Z`).getTime();
      const current = new Date(`${days[index] ?? ''}T00:00:00Z`).getTime();
      expect(current - previous, `gap before ${days[index] ?? ''}`).toBe(86_400_000);
    }

    // No duplicates, which a naive `generate_series` over a timestamp rather
    // than a date produces twice a year at a DST boundary.
    expect(new Set(days).size).toBe(days.length);
  });

  it('spans a leap day, and is empty rather than wrong when the range is inverted', async () => {
    const leap = await database.db.execute<{ as_of_date: string }>(sql`
      SELECT as_of_date FROM net_worth_calendar_spine('2028-02-27'::date, '2028-03-01'::date)
    `);
    expect(leap.rows.map((row) => String(row.as_of_date).slice(0, 10))).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);

    // A single day is a range of one, not zero.
    const single = await database.db.execute(sql`
      SELECT as_of_date FROM net_worth_calendar_spine('2026-06-15'::date, '2026-06-15'::date)
    `);
    expect(single.rows).toHaveLength(1);

    // And `to < from` is empty, which is the documented answer rather than an
    // error or an infinite series.
    const inverted = await database.db.execute(sql`
      SELECT as_of_date FROM net_worth_calendar_spine('2026-06-15'::date, '2026-06-01'::date)
    `);
    expect(inverted.rows).toHaveLength(0);
  });

  it('returns a day with no row as null rather than omitting it', async () => {
    const userId = database.userId;
    const clock = fixedClock(new Date('2026-06-20T18:00:00Z'));

    // Two days of real data, ten days apart, and nothing in between.
    for (const date of ['2026-06-01', '2026-06-11']) {
      const snapshot = await computeNetWorth(portsOf(worldOn(date)), {
        userId,
        asOfDate: date,
        baseCurrency: 'USD',
      });
      await upsertOpenDay(executor, { userId, snapshot, clock });
      await sealDay(executor, { userId, asOfDate: date, clock });
    }

    const series = await readSeries(executor, {
      userId,
      from: '2026-06-01',
      to: '2026-06-11',
    });

    // Eleven days, not two. This is the assertion an INNER JOIN fails.
    expect(series).toHaveLength(11);
    expect(series.map((point) => point.asOfDate)).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
    ]);

    // The days with data have a number; the nine between them are `null` and
    // not zero. "We have no reading for the 5th" and "your net worth was zero
    // on the 5th" are different claims, and a chart must not draw the second
    // when it means the first.
    expect(series[0]?.netWorthMinor).not.toBeNull();
    expect(series[10]?.netWorthMinor).not.toBeNull();
    for (let index = 1; index <= 9; index += 1) {
      expect(series[index]?.netWorthMinor, `day ${index + 1}`).toBeNull();
    }
  });

  it('reads the highest revision of a corrected day, not the superseded one', async () => {
    const userId = await database.createUser('Series Holder');
    const clock = fixedClock(new Date('2026-07-05T18:00:00Z'));
    const date = '2026-07-01';

    const snapshot = await computeNetWorth(portsOf(worldOn(date)), {
      userId,
      asOfDate: date,
      baseCurrency: 'USD',
    });
    const first = await upsertOpenDay(executor, { userId, snapshot, clock });
    await sealDay(executor, { userId, asOfDate: date, clock });

    await database.db.execute(sql`
      INSERT INTO net_worth_daily (
        id, user_id, as_of_date, revision, base_currency,
        assets_minor, liabilities_minor, net_worth_minor,
        liquid_minor, investable_minor, on_budget_minor,
        breakdown, source, accounts_counted, accounts_unvalued,
        sealed_at, supersedes_id, correction_reason
      ) VALUES (
        gen_random_uuid(), ${userId}::uuid, ${date}::date, 2, 'USD',
        5000, 1000, 4000, 0, 0, 0, '[]'::jsonb, 'corrected', 1, 0,
        now(), ${first.id}::uuid, 'a restated balance'
      )
    `);

    const series = await readSeries(executor, { userId, from: date, to: date });
    expect(series[0]?.netWorthMinor).toBe(4000n);
    // And the superseded revision is still on disk, unchanged.
    const all = await database.db.execute(sql`
      SELECT revision FROM net_worth_daily
       WHERE user_id = ${userId}::uuid AND as_of_date = ${date}::date
    `);
    expect(all.rows).toHaveLength(2);
  });
});
