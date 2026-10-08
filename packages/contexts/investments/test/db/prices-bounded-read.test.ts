// SPDX-License-Identifier: MIT
/**
 * WP 9.14 / P-6 (WP 9.9 `wp9.9-perf.md` §9): pricing a portfolio read every
 * `prices` row of every security, one security at a time, so `GET /holdings` and
 * `GET /investments/allocation` took ~2.0 s at 200 positions over five years of
 * daily closes (9.55 ms per security, linear in the history held).
 *
 * The ladder (07 §6.1) only ever uses two things: the rows dated exactly the date
 * asked for (any rung can match one) and the newest row *before* it (the
 * `last_known` rung). So the read is bounded to those, and a portfolio is priced
 * in a fixed number of round trips whatever it holds. These tests pin both
 * properties against the shipped Postgres store, and pin that the batched read
 * answers exactly what the per-security read answers.
 */
import { fixedClock, newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPriceReader,
  drizzlePriceStore,
  recordUserPriceOverride,
  type PriceReader,
} from '../../src/prices.ts';
import { EPOCH, NO_DATABASE, investmentsDatabase, type TestDatabase } from './harness.ts';

const CLOCK = fixedClock(EPOCH);
const ASOF = '2026-06-15';
const HISTORY_DAYS = 400;

describe.skipIf(NO_DATABASE)('the price read is bounded and batched, against Postgres', () => {
  let database: TestDatabase;
  const kinds = new Map<string, string>();
  let ids: {
    both: string; // history, tiingo + user_override on the date
    gap: string; // history ending days before the date (carry-forward)
    onlyFuture: string; // a row after the date only
    eur: string; // history in EUR only
    none: string; // no rows at all
    many: string[]; // 60 more securities with history
  };

  async function seedSecurity(ticker: string, kind: string): Promise<string> {
    const id = newId();
    await database.db.execute(sql`
      INSERT INTO securities
        (id, user_id, identity_kind, identity_key, ticker, name, type, currency,
         classification_source, is_cash_equivalent, asset_class, region, sector,
         classification_depth, classification_flagged)
      VALUES (${id}::uuid, ${database.userId}::uuid, 'ticker', ${`ticker:${ticker}`},
              ${ticker}, ${ticker}, ${kind}, 'USD', 'LOCAL_SEED_TABLE', FALSE,
              'US_EQUITY', 'US', 'UNKNOWN', 0, FALSE)
    `);
    kinds.set(id, kind);
    return id;
  }

  /**
   * Provider history written the way the market-data refresh writes it: one
   * `tiingo` close per day. (There is no route that writes 400 days at once; the
   * refresh job is the only writer and it is exercised by market-data's own
   * tests. This test is about how the rows are READ.)
   */
  async function seedHistory(
    securityId: string,
    endOffsetDays: number,
    quote = 'USD',
  ): Promise<void> {
    await database.db.execute(sql`
      INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
      SELECT gen_random_uuid(), ${database.userId}::uuid, ${securityId}::uuid,
             (${ASOF}::date - (${endOffsetDays}::int + n)), 'tiingo', 100 + n, ${quote}, false,
             (${ASOF}::date - (${endOffsetDays}::int + n))::timestamptz + interval '21 hours'
        FROM generate_series(0, ${HISTORY_DAYS - 1}) AS n
    `);
  }

  beforeAll(async () => {
    database = await investmentsDatabase('prices_bounded_read');
    ids = {
      both: await seedSecurity('BOTH', 'etf'),
      gap: await seedSecurity('GAP', 'etf'),
      onlyFuture: await seedSecurity('FUT', 'etf'),
      eur: await seedSecurity('EUR', 'etf'),
      none: await seedSecurity('NONE', 'etf'),
      many: [],
    };
    await seedHistory(ids.both, 0);
    await recordUserPriceOverride(
      database.db,
      database.userId,
      { securityId: ids.both, priceDate: ASOF, close: '999.00', currency: 'USD' },
      CLOCK,
    );
    await seedHistory(ids.gap, 3); // newest close is 3 days before the date
    await database.db.execute(sql`
      INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
      VALUES (gen_random_uuid(), ${database.userId}::uuid, ${ids.onlyFuture}::uuid,
              ${ASOF}::date + 2, 'tiingo', 50, 'USD', false, now())
    `);
    await seedHistory(ids.eur, 0, 'EUR');
    for (let index = 0; index < 60; index += 1) {
      const id = await seedSecurity(`M${String(index).padStart(2, '0')}`, 'etf');
      ids.many.push(id);
      await seedHistory(id, index % 5); // a mix of exact-date and carried-forward
    }
    await database.db.execute(sql`ANALYZE prices`);
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  function readerOver(db: TestDatabase['db']): PriceReader {
    return createPriceReader({
      store: drizzlePriceStore(db),
      userId: database.userId,
      kindOf: (securityId) => Promise.resolve(kinds.get(securityId) ?? 'other'),
      clock: CLOCK,
    });
  }

  it('reads the date and the newest earlier date, not the whole history', async () => {
    const store = drizzlePriceStore(database.db);
    const rows = await store.observationsForLadder(database.userId, ids.both, 'USD', ASOF);
    // 2 rows on the date (tiingo + user_override) + 1 on the day before: a
    // bound that does not grow with the 400 days held.
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(
      rows
        .filter((row) => row.priceDate === ASOF)
        .map((row) => row.source)
        .sort(),
    ).toEqual(['tiingo', 'user_override']);
    // The newest earlier row, which is the whole of what `last_known` needs.
    expect(rows.some((row) => row.priceDate < ASOF)).toBe(true);
  });

  it('a security whose newest close is days old still finds it (carry-forward)', async () => {
    const store = drizzlePriceStore(database.db);
    const rows = await store.observationsForLadder(database.userId, ids.gap, 'USD', ASOF);
    expect(rows.length).toBeLessThanOrEqual(2);
    const point = await readerOver(database.db).price(ids.gap, ASOF, 'USD');
    expect(point).toMatchObject({
      rung: 'last_known',
      carriedForward: true,
      close: '100.0000000000',
    });
  });

  it('priceMany answers exactly what price answers, security by security', async () => {
    const reader = readerOver(database.db);
    const all = [ids.both, ids.gap, ids.onlyFuture, ids.eur, ids.none, ...ids.many];
    const batched = await reader.priceMany(all, ASOF, 'USD');
    expect([...batched.keys()].sort()).toEqual([...all].sort());
    for (const securityId of all) {
      const single = await reader.price(securityId, ASOF, 'USD');
      expect(batched.get(securityId), securityId).toEqual(single);
    }
    // The shapes the comparison would be vacuous without.
    expect(batched.get(ids.both)).toMatchObject({ rung: 'user_override', close: '999.0000000000' });
    expect(batched.get(ids.onlyFuture)).toBeNull();
    expect(batched.get(ids.eur)).toBeNull();
    expect(batched.get(ids.none)).toBeNull();
    expect(batched.get(ids.many[0] ?? '')).toMatchObject({ carriedForward: false });
    expect(batched.get(ids.many[3] ?? '')).toMatchObject({ carriedForward: true });
  });

  it('prices sixty-five securities in a handful of round trips, not two hundred', async () => {
    let statements = 0;
    const counting = new Proxy(database.db, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if ((property === 'select' || property === 'execute') && typeof value === 'function') {
          return (...args: unknown[]) => {
            statements += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });
    const all = [ids.both, ids.gap, ids.onlyFuture, ids.eur, ids.none, ...ids.many];
    await readerOver(counting).priceMany(all, ASOF, 'USD');
    // One ladder per distinct kind (one here) and one observations read.
    expect(statements).toBeLessThanOrEqual(2);
  });
});
