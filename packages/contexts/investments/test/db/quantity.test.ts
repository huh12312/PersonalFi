// SPDX-License-Identifier: MIT
/**
 * The `NUMERIC(38,18)` boundary, against a real Postgres.
 *
 * This file carries the dispatch's exit test verbatim — `'0.00000001 BTC
 * survives a database round trip'`, 04 §2.3 — and it lives in `test/db/`
 * rather than in `src/quantity.test.ts` because it is a claim about the
 * *database*: that the column's declared scale, the driver's type parser and
 * the kernel's decimal string agree end to end. The root `vitest.config.ts`
 * says it plainly — "unit projects must not need Postgres" — so the pure half
 * of the boundary is proved in `src/quantity.test.ts`, which runs in
 * milliseconds, and the round trip is proved here in `investments-db`.
 *
 * The failure this exists to prevent is not an exception. `node-postgres`
 * returns `NUMERIC` as a string by default and `@core/db`'s `installTypeParsers`
 * keeps it that way; the moment something helpfully parses it to a float,
 * 0.00000001 BTC still *reads* fine and only the eighteenth decimal of a large
 * position quietly disappears.
 */
import { DateOnly, Money, Quantity, fixedClock, newId, currency } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EPOCH, NO_DATABASE, investmentsDatabase, type TestDatabase } from './harness.ts';
import { drizzleLotStore, type LotStore } from '../../src/lots-store.ts';
import { openLot } from '../../src/lots.ts';

const USD = currency('USD');
const CLOCK = fixedClock(EPOCH);

/**
 * Quantities that each break a different naive implementation.
 *
 * `0.00000001` is the satoshi and the dispatch's named case. The 18-decimal
 * value is the scale limit — an ERC-20 token's smallest unit, and the digit a
 * float loses first. The 20-digit integer is the *other* end of
 * `NUMERIC(38,18)`: 38 total digits minus 18 of scale leaves 20, so this is the
 * largest whole number the column can hold, and a `number` would have gone
 * imprecise 15 digits earlier.
 */
const BOUNDARY_QUANTITIES = [
  '0.00000001',
  '0.000000000000000001',
  '0.123456789012345678',
  '1',
  '21000000',
  '12345678901234567890',
  '99999999999999999999.999999999999999999',
] as const;

describe.skipIf(NO_DATABASE)('quantity, against Postgres', () => {
  let database: TestDatabase;
  let store: LotStore;
  let accountId: string;
  let securityId: string;

  async function seedCrypto(ticker: string): Promise<string> {
    const id = newId();
    await database.db.execute(sql`
      INSERT INTO securities
        (id, user_id, identity_kind, identity_key, ticker, name, type, currency, chain,
         classification_source, is_cash_equivalent, asset_class, region, sector,
         classification_depth, classification_flagged)
      VALUES (${id}::uuid, ${database.userId}::uuid, 'ticker', ${`ticker:${ticker}`},
              ${ticker}, ${ticker}, 'crypto', 'USD', 'bitcoin', 'LOCAL_SEED_TABLE', FALSE,
              'CRYPTO', 'GLOBAL', 'UNKNOWN', 0, FALSE)
    `);
    return id;
  }

  beforeAll(async () => {
    database = await investmentsDatabase('quantity');
    store = drizzleLotStore(database.db, CLOCK);
    accountId = newId();
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql.raw(
        'TRUNCATE cost_basis_lots, holdings, holdings_snapshots, investment_transactions, ' +
          'securities RESTART IDENTITY CASCADE',
      ),
    );
    securityId = await seedCrypto('BTC');
  });

  it('0.00000001 BTC survives a database round trip', async () => {
    // 04 §2.3, verbatim. One satoshi, written through the lot store and read
    // back, with no float anywhere in the path.
    const satoshi = Quantity.of('0.00000001');
    const lot = openLot({
      id: newId(),
      accountId,
      securityId,
      openDate: DateOnly.parse('2024-02-01'),
      quantity: satoshi,
      basis: Money.of(63n, USD),
      currency: USD,
      basisSource: 'BROKER',
      acquisitionType: 'BUY',
    }).lot;

    await store.saveLots(database.userId, [lot]);
    const [read] = await store.listOpenLots(database.userId, accountId, securityId);

    // Equal as a `Quantity`, and equal as the exact 18-scale string the column
    // holds — not merely "close enough to print the same".
    expect(read?.quantity).toBe(satoshi);
    expect(Quantity.toDatabaseString(read?.quantity ?? Quantity.zero)).toBe('0.000000010000000000');
    expect(Quantity.isZero(read?.quantity ?? Quantity.zero)).toBe(false);

    // And the raw column, before any of this package's code touches it: still a
    // string, so the driver never turned it into a double.
    const raw = await database.db.execute<{ quantity: string }>(
      sql`SELECT quantity::text AS quantity FROM cost_basis_lots`,
    );
    expect(raw.rows[0]?.quantity).toBe('0.000000010000000000');
    expect(typeof raw.rows[0]?.quantity).toBe('string');
  });

  it('every NUMERIC(38,18) boundary value round-trips exactly', async () => {
    for (const value of BOUNDARY_QUANTITIES) {
      const quantity = Quantity.of(value);
      const lot = openLot({
        id: newId(),
        accountId,
        securityId,
        openDate: DateOnly.parse('2024-02-01'),
        quantity,
        basis: Money.of(1n, USD),
        currency: USD,
        basisSource: 'BROKER',
        acquisitionType: 'BUY',
      }).lot;
      await store.saveLots(database.userId, [lot]);

      const read = (await store.listOpenLots(database.userId, accountId, securityId)).find(
        (candidate) => candidate.id === lot.id,
      );
      expect(Quantity.toDatabaseString(read?.quantity ?? Quantity.zero), value).toBe(
        Quantity.toDatabaseString(quantity),
      );
    }
  });

  it('a holding quantity round-trips at full scale too', async () => {
    // `holdings.quantity` is the *other* NUMERIC(38,18) in 0014, and it is the
    // one the allocation chart reads. A satoshi lost here is a satoshi lost on
    // screen.
    await store.upsertHolding(
      database.userId,
      {
        accountId,
        securityId,
        quantity: Quantity.of('0.00000001'),
        institutionValue: Money.of(63n, USD),
        costBasis: Money.of(50n, USD),
        asOfDate: DateOnly.parse('2026-06-15'),
      },
      { id: newId() },
    );
    const raw = await database.db.execute<{ quantity: string }>(
      sql`SELECT quantity::text AS quantity FROM holdings`,
    );
    expect(raw.rows[0]?.quantity).toBe('0.000000010000000000');
  });

  it('the column refuses more scale than it declares rather than silently truncating', async () => {
    // A 19th decimal is not representable. Postgres rounds on INSERT rather
    // than erroring, which is exactly why the kernel fixes the scale at 18
    // before the value ever gets here — `Quantity.of` is the gate, and this
    // test records what the database does behind it.
    const raw = await database.db.execute<{ value: string }>(
      sql`SELECT (0.0000000000000000019::numeric(38,18))::text AS value`,
    );
    expect(raw.rows[0]?.value).toBe('0.000000000000000002');
  });
});
