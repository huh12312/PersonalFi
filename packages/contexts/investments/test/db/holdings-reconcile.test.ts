// SPDX-License-Identifier: MIT
/**
 * Holdings reconcile to balances, over Postgres.
 *
 * `../holdings-reconcile.test.ts` proves the arithmetic in `reconcile.ts`
 * against hand-built fixtures; this suite proves the two real write paths
 * agree with it. A holding written by `drizzleLotStore.upsertHolding` (the
 * sync/import write path — `lots-store.ts` around line 330) and a price
 * written by `recordUserPriceOverride` (the rung-1 write path in
 * `prices.ts`), both read back exactly the way a route would —
 * `drizzlePriceStore` + `createPriceReader` for the price, a plain `SELECT`
 * for the holding, since `LotStore` exposes no holdings reader — and handed
 * to the same `reconcileHolding` the unit test exercises.
 */
import { DateOnly, Money, Quantity, currency, fixedClock, newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Holding } from '../../src/holdings.ts';
import { drizzleLotStore, type LotStore } from '../../src/lots-store.ts';
import { createPriceReader, drizzlePriceStore, recordUserPriceOverride } from '../../src/prices.ts';
import { reconcileHolding } from '../../src/reconcile.ts';
import { EPOCH, NO_DATABASE, investmentsDatabase, type TestDatabase } from './harness.ts';

const USD = currency('USD');
const CLOCK = fixedClock(EPOCH);
const PRICE_DATE = EPOCH.slice(0, 10); // '2026-06-15'

describe.skipIf(NO_DATABASE)('holdings reconcile to balances, against Postgres', () => {
  let database: TestDatabase;
  let lotStore: LotStore;
  let accountId: string;
  let securityId: string;

  /** A `securities` row, because `holdings.security_id` is a real FK. */
  async function seedSecurity(ticker: string): Promise<string> {
    const id = newId();
    await database.db.execute(sql`
      INSERT INTO securities
        (id, user_id, identity_kind, identity_key, ticker, name, type, currency,
         classification_source, is_cash_equivalent, asset_class, region, sector,
         classification_depth, classification_flagged)
      VALUES (${id}::uuid, ${database.userId}::uuid, 'ticker', ${`ticker:${ticker}`},
              ${ticker}, ${ticker}, 'etf', 'USD', 'LOCAL_SEED_TABLE', FALSE,
              'US_EQUITY', 'US', 'UNKNOWN', 0, FALSE)
    `);
    return id;
  }

  /** Read the one row this suite wrote, in the `Holding` shape `reconcile.ts` takes. */
  async function readHolding(): Promise<Holding> {
    const result = await database.db.execute<{
      quantity: string;
      institution_value_minor: string;
      currency: string;
      as_of_date: string;
    }>(sql`
      SELECT quantity, institution_value_minor::text AS institution_value_minor, currency,
             to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date
        FROM holdings
       WHERE user_id = ${database.userId}::uuid AND account_id = ${accountId}::uuid
         AND security_id = ${securityId}::uuid
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('readHolding: upsertHolding wrote no row to read back');
    return {
      accountId,
      securityId,
      quantity: Quantity.of(row.quantity),
      institutionValue: Money.of(
        BigInt(row.institution_value_minor),
        currency(row.currency.trim()),
      ),
      costBasis: null,
      asOfDate: DateOnly.parse(row.as_of_date),
    };
  }

  beforeAll(async () => {
    database = await investmentsDatabase('holdings_reconcile');
    lotStore = drizzleLotStore(database.db, CLOCK);
    accountId = newId();
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql.raw(
        'TRUNCATE cost_basis_lots, basis_method_elections, holdings, holdings_snapshots, ' +
          'investment_transactions, prices, price_source_priority, securities RESTART IDENTITY CASCADE',
      ),
    );
    securityId = await seedSecurity('VTI');
  });

  it('a holding from upsertHolding and a price from recordUserPriceOverride reconcile through the real read paths', async () => {
    await lotStore.upsertHolding(
      database.userId,
      {
        accountId,
        securityId,
        quantity: Quantity.of('10'),
        // $3,051.20 — the institution's own figure, matching 10 x $305.12 exactly.
        institutionValue: Money.of(305_120n, USD),
        costBasis: null,
        asOfDate: DateOnly.parse(PRICE_DATE),
      },
      { id: newId() },
    );
    await recordUserPriceOverride(
      database.db,
      database.userId,
      { securityId, priceDate: PRICE_DATE, close: '305.12', currency: 'USD' },
      CLOCK,
    );

    const holding = await readHolding();
    const reader = createPriceReader({
      store: drizzlePriceStore(database.db),
      userId: database.userId,
      kindOf: () => Promise.resolve('etf'),
      clock: CLOCK,
    });
    const point = await reader.price(securityId, PRICE_DATE, 'USD');
    expect(point, 'the rung-1 user_override price was written and must be found').not.toBeNull();
    if (point === null) throw new Error('unreachable: asserted not null above');

    const result = reconcileHolding(
      holding,
      { amount: Quantity.of(point.close), currency: currency(point.currency) },
      2,
    );
    expect(result.status).toBe('reconciled');
    expect(result.differenceMinor).toBe(0n);
  });

  it('a holding with no price row reconciles as no_price, never a silent pass', async () => {
    await lotStore.upsertHolding(
      database.userId,
      {
        accountId,
        securityId,
        quantity: Quantity.of('10'),
        institutionValue: Money.of(305_120n, USD),
        costBasis: null,
        asOfDate: DateOnly.parse(PRICE_DATE),
      },
      { id: newId() },
    );

    const holding = await readHolding();
    const reader = createPriceReader({
      store: drizzlePriceStore(database.db),
      userId: database.userId,
      kindOf: () => Promise.resolve('etf'),
      clock: CLOCK,
    });
    const point = await reader.price(securityId, PRICE_DATE, 'USD');
    expect(point, 'no price row was ever written for this security').toBeNull();

    const result = reconcileHolding(holding, null, 2);
    expect(result.status).toBe('no_price');
    expect(result.computedValue).toBeNull();
    expect(result.differenceMinor).toBeNull();
  });

  it('a holding whose institution value disagrees by more than rounding is a tolerance_breach', async () => {
    await lotStore.upsertHolding(
      database.userId,
      {
        accountId,
        securityId,
        quantity: Quantity.of('10'),
        // 10 x $305.12 = $3,051.20 -> 305120 minor. The institution says
        // 310000 — $48.80 off, far past what rounding can explain.
        institutionValue: Money.of(310_000n, USD),
        costBasis: null,
        asOfDate: DateOnly.parse(PRICE_DATE),
      },
      { id: newId() },
    );
    await recordUserPriceOverride(
      database.db,
      database.userId,
      { securityId, priceDate: PRICE_DATE, close: '305.12', currency: 'USD' },
      CLOCK,
    );

    const holding = await readHolding();
    const reader = createPriceReader({
      store: drizzlePriceStore(database.db),
      userId: database.userId,
      kindOf: () => Promise.resolve('etf'),
      clock: CLOCK,
    });
    const point = await reader.price(securityId, PRICE_DATE, 'USD');
    if (point === null) throw new Error('the price written above must be found');

    const result = reconcileHolding(
      holding,
      { amount: Quantity.of(point.close), currency: currency(point.currency) },
      2,
    );
    expect(result.status).toBe('tolerance_breach');
    expect(result.differenceMinor).toBe(-4_880n);
  });
});
