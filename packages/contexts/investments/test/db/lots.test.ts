// SPDX-License-Identifier: MIT
/**
 * The lot tables against a real Postgres.
 *
 * `src/lots.test.ts` proves the engine's *rules*; this suite proves the
 * *schema* agrees — that each rule survives a write path that bypasses the
 * engine entirely. That distinction matters because the engine is not the only
 * thing that will ever write these tables: a migration, a repair script, a
 * future importer and a `psql` session all reach the same columns, and a rule
 * that lives only in TypeScript is a rule that lives only until somebody is in
 * a hurry.
 *
 * Every refusal below is asserted by **constraint name**, so a reader can check
 * it against `packages/db/migrations/0014_lots.sql` line by line, and a
 * renamed-away constraint fails loudly instead of passing for the wrong reason.
 */
import { DateOnly, Money, Quantity, fixedClock, newId, currency } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzleLotStore, type LotStore } from '../../src/lots-store.ts';
import { matchDisposal, openLot, type Lot } from '../../src/lots.ts';
import {
  EPOCH,
  NO_DATABASE,
  countRows,
  investmentsDatabase,
  pgFailureOf,
  type TestDatabase,
} from './harness.ts';

const USD = currency('USD');
const CLOCK = fixedClock(EPOCH);

const usd = (dollars: string): ReturnType<typeof Money.of> =>
  Money.of(BigInt(dollars.replace('.', '')), USD);

describe.skipIf(NO_DATABASE)('lots, against Postgres', () => {
  let database: TestDatabase;
  let store: LotStore;
  let accountId: string;
  let securityId: string;

  /** A `securities` row, because `cost_basis_lots.security_id` is a real FK. */
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

  function lotOf(overrides: Partial<Parameters<typeof openLot>[0]> = {}): Lot {
    return openLot({
      id: newId(),
      accountId,
      securityId,
      openDate: DateOnly.parse('2024-03-01'),
      quantity: Quantity.of('10'),
      basis: usd('1000.00'),
      currency: USD,
      basisSource: 'BROKER',
      acquisitionType: 'BUY',
      ...overrides,
    }).lot;
  }

  /** Write a lot row directly, bypassing the engine — the point of this suite. */
  function insertLot(row: Record<string, unknown>): Promise<unknown> {
    const values = {
      id: newId(),
      user_id: database.userId,
      account_id: accountId,
      security_id: securityId,
      open_date: '2024-03-01',
      holding_period_start_date: '2024-03-01',
      quantity: '10',
      quantity_remaining: '10',
      basis_minor: 100_000n,
      basis_consumed_minor: 0n,
      currency: USD,
      basis_source: 'BROKER',
      acquisition_type: 'BUY',
      basis_warning: null,
      wash_sale_adjustment_minor: 0n,
      ...row,
    };
    return database.db.execute(sql`
      INSERT INTO cost_basis_lots
        (id, user_id, account_id, security_id, open_date, holding_period_start_date,
         quantity, quantity_remaining, basis_minor, basis_consumed_minor, currency,
         basis_source, acquisition_type, basis_warning, wash_sale_adjustment_minor)
      VALUES (${values.id}::uuid, ${values.user_id}::uuid, ${values.account_id}::uuid,
              ${values.security_id}::uuid, ${values.open_date}::date,
              ${values.holding_period_start_date}::date,
              ${values.quantity}::numeric, ${values.quantity_remaining}::numeric,
              ${values.basis_minor}, ${values.basis_consumed_minor}, ${values.currency},
              ${values.basis_source}, ${values.acquisition_type}, ${values.basis_warning},
              ${values.wash_sale_adjustment_minor})
    `);
  }

  beforeAll(async () => {
    database = await investmentsDatabase('lots');
    store = drizzleLotStore(database.db, CLOCK);
    accountId = newId();
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql.raw(
        'TRUNCATE cost_basis_lots, basis_method_elections, holdings, holdings_snapshots, ' +
          'investment_transactions, securities RESTART IDENTITY CASCADE',
      ),
    );
    securityId = await seedSecurity('VTI');
  });

  // -------------------------------------------------------------------------
  // Round trips
  // -------------------------------------------------------------------------

  it('a lot round-trips through saveLots and listOpenLots unchanged', async () => {
    const lot = lotOf();
    await store.saveLots(database.userId, [lot]);
    const [read] = await store.listOpenLots(database.userId, accountId, securityId);

    expect(read?.id).toBe(lot.id);
    expect(Quantity.toDatabaseString(read?.quantity ?? Quantity.zero)).toBe(
      Quantity.toDatabaseString(lot.quantity),
    );
    expect(read?.basis).toEqual(lot.basis);
    expect(read?.basisSource).toBe('BROKER');
    expect(read?.openDate).toBe(lot.openDate);
    expect(read?.holdingPeriodStartDate).toBe(lot.holdingPeriodStartDate);
  });

  it('saveLots is idempotent: the same lot written twice is one row', async () => {
    const lot = lotOf();
    await store.saveLots(database.userId, [lot]);
    await store.saveLots(database.userId, [lot]);
    expect(await countRows(database, 'cost_basis_lots')).toBe(1);

    // And a consumed lot updates in place rather than opening a second one,
    // which is what makes re-delivering a sync event safe.
    const sale = matchDisposal([lot], {
      accountId,
      securityId,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('4'),
      proceeds: usd('600.00'),
    });
    await store.saveLots(database.userId, sale.lots);
    expect(await countRows(database, 'cost_basis_lots')).toBe(1);
    const [read] = await store.listOpenLots(database.userId, accountId, securityId);
    expect(Quantity.toDatabaseString(read?.quantityRemaining ?? Quantity.zero)).toBe(
      '6.000000000000000000',
    );
    expect(read?.basisConsumed).toEqual(usd('400.00'));
  });

  it('listLotsForSecurity crosses accounts, because the wash-sale scan has to', async () => {
    // 07 §4.4's trap: a scan that stopped at the account boundary would miss
    // the replacement bought inside the IRA.
    const otherAccount = newId();
    await store.saveLots(database.userId, [lotOf(), lotOf({ accountId: otherAccount })]);
    expect(await store.listLotsForSecurity(database.userId, securityId)).toHaveLength(2);
    expect(await store.listOpenLots(database.userId, accountId, securityId)).toHaveLength(1);
  });

  it('a closed lot is not an open lot, but it is still in the security', async () => {
    const lot = lotOf();
    const sale = matchDisposal([lot], {
      accountId,
      securityId,
      date: DateOnly.parse('2025-01-01'),
      quantity: Quantity.of('10'),
      proceeds: usd('1500.00'),
    });
    await store.saveLots(database.userId, sale.lots);
    expect(await store.listOpenLots(database.userId, accountId, securityId)).toEqual([]);
    expect(await store.listLotsForSecurity(database.userId, securityId)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The constraints, each by name
  // -------------------------------------------------------------------------

  it('quantity_remaining is never negative, as a property of Postgres', async () => {
    expect(await pgFailureOf(insertLot({ quantity_remaining: '-0.000000000000000001' }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_quantity_remaining_check',
    });
    // And never above the quantity: the CHECK bounds it from both sides, so a
    // repair script cannot leave a lot holding more than it was opened with.
    expect(await pgFailureOf(insertLot({ quantity_remaining: '11' }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_remaining_within_quantity',
    });
  });

  it('an unknown basis must declare ESTIMATED and carry a warning', async () => {
    // The never-zero-basis rule, said to every write path rather than only to
    // the engine. A `BROKER` lot with a NULL basis is a broker that reported
    // nothing being recorded as a broker that reported.
    expect(await pgFailureOf(insertLot({ basis_minor: null }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_unknown_basis_is_declared_estimated',
    });
    // ESTIMATED, but with no warning text for the UI to show — 07 §6.2 wants
    // the warning *visible*, so an empty one is refused here.
    expect(
      await pgFailureOf(
        insertLot({ basis_minor: null, basis_source: 'ESTIMATED', basis_warning: null }),
      ),
    ).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_estimated_basis_carries_a_warning',
    });
    // With both, it is accepted.
    await insertLot({
      basis_minor: null,
      basis_source: 'ESTIMATED',
      basis_warning: 'Cost basis is unknown for this lot.',
    });
    expect(await countRows(database, 'cost_basis_lots')).toBe(1);
  });

  it('a negative basis is refused, and so is consuming more than there is', async () => {
    expect(await pgFailureOf(insertLot({ basis_minor: -1n }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_basis_minor_check',
    });
    expect(await pgFailureOf(insertLot({ basis_consumed_minor: 100_001n }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_consumed_within_basis',
    });
  });

  it('a holding period starts no later than the lot opens — tacking moves it earlier', async () => {
    expect(await pgFailureOf(insertLot({ holding_period_start_date: '2024-03-02' }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_holding_period_starts_no_later_than_open',
    });
    // Earlier is exactly what a wash sale does, so it must be accepted.
    await insertLot({ holding_period_start_date: '2023-01-01' });
    expect(await countRows(database, 'cost_basis_lots')).toBe(1);
  });

  it('a wash-sale adjustment is never negative and never lands on an unknown basis', async () => {
    expect(await pgFailureOf(insertLot({ wash_sale_adjustment_minor: -1n }))).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_wash_sale_adjustment_minor_check',
    });
    expect(
      await pgFailureOf(
        insertLot({
          basis_minor: null,
          basis_source: 'ESTIMATED',
          basis_warning: 'unknown',
          wash_sale_adjustment_minor: 50_000n,
        }),
      ),
    ).toEqual({
      code: '23514',
      constraint: 'cost_basis_lots_wash_adjustment_needs_a_basis',
    });
  });

  // -------------------------------------------------------------------------
  // Elections
  // -------------------------------------------------------------------------

  it('AVERAGE_COST once elected cannot be switched, and the trigger says so', async () => {
    // The database half of `src/lots.test.ts`'s election test: the same rule,
    // enforced by a BEFORE UPDATE trigger so a UI bug, a repair script and a
    // `psql` session are all covered.
    const election = {
      id: newId(),
      userId: database.userId,
      accountId,
      securityId,
      electedOn: DateOnly.parse('2025-01-01'),
    };
    await store.electBasisMethod({ ...election, method: 'AVERAGE_COST' });
    expect(await store.basisMethodFor(database.userId, accountId, securityId)).toBe('AVERAGE_COST');

    await expect(store.electBasisMethod({ ...election, method: 'FIFO' })).rejects.toThrowError();
    expect(await store.basisMethodFor(database.userId, accountId, securityId)).toBe('AVERAGE_COST');

    // Bypassing the store entirely still fails, by constraint name.
    expect(
      await pgFailureOf(
        database.db.execute(sql`
          UPDATE basis_method_elections SET method = 'HIFO'
          WHERE user_id = ${database.userId}::uuid AND account_id = ${accountId}::uuid
        `),
      ),
    ).toMatchObject({ constraint: 'basis_method_elections_average_cost_is_sticky' });
  });

  it('an absent election is FIFO, which is the IRS default rather than a fallback', async () => {
    expect(await store.basisMethodFor(database.userId, accountId, securityId)).toBe('FIFO');
    expect(await countRows(database, 'basis_method_elections')).toBe(0);
  });

  it('an election is scoped per account and security', async () => {
    const otherSecurity = await seedSecurity('VTSAX');
    await store.electBasisMethod({
      id: newId(),
      userId: database.userId,
      accountId,
      securityId,
      method: 'HIFO',
      electedOn: DateOnly.parse('2025-01-01'),
    });
    expect(await store.basisMethodFor(database.userId, accountId, securityId)).toBe('HIFO');
    expect(await store.basisMethodFor(database.userId, accountId, otherSecurity)).toBe('FIFO');
    expect(await store.basisMethodFor(database.userId, newId(), securityId)).toBe('FIFO');
  });

  // -------------------------------------------------------------------------
  // Holdings and investment transactions
  // -------------------------------------------------------------------------

  it('a holding is one row per account x security, however often it is synced', async () => {
    const holding = {
      accountId,
      securityId,
      quantity: Quantity.of('12.5'),
      institutionValue: usd('2500.00'),
      costBasis: usd('2000.00'),
      asOfDate: DateOnly.parse('2026-06-15'),
    };
    await store.upsertHolding(database.userId, holding, { id: newId() });
    await store.upsertHolding(
      database.userId,
      { ...holding, quantity: Quantity.of('13') },
      { id: newId() },
    );
    expect(await countRows(database, 'holdings')).toBe(1);

    const rows = await database.db.execute<{ quantity: string; cost_basis_per_unit: string }>(
      sql`SELECT quantity, cost_basis_per_unit FROM holdings`,
    );
    expect(rows.rows[0]?.quantity).toBe('13.000000000000000000');
  });

  it('a user-supplied basis is never overwritten by a sync', async () => {
    // 04 §5.5, the one column a user corrects. A sync that clobbered it would
    // silently undo the correction and the user would have no way to tell.
    const holding = {
      accountId,
      securityId,
      quantity: Quantity.of('10'),
      institutionValue: usd('2500.00'),
      costBasis: usd('1111.11'),
      asOfDate: DateOnly.parse('2026-06-15'),
    };
    await store.upsertHolding(database.userId, holding, {
      id: newId(),
      costBasisSource: 'USER',
    });
    await database.db.execute(
      sql`UPDATE holdings SET cost_basis_is_user_supplied = TRUE, cost_basis_source = 'USER'`,
    );

    await store.upsertHolding(
      database.userId,
      { ...holding, costBasis: usd('9999.99') },
      { id: newId(), preserveUserSuppliedBasis: true, costBasisSource: 'BROKER' },
    );

    const rows = await database.db.execute<{ cost_basis_minor: bigint }>(
      sql`SELECT cost_basis_minor FROM holdings`,
    );
    expect(rows.rows[0]?.cost_basis_minor).toBe(111_111n);
  });

  it('a holdings snapshot is one row per calendar day', async () => {
    const holding = {
      accountId,
      securityId,
      quantity: Quantity.of('10'),
      institutionValue: usd('2500.00'),
      costBasis: usd('2000.00'),
      asOfDate: DateOnly.parse('2026-06-15'),
    };
    await store.recordHoldingSnapshot(database.userId, holding);
    await store.recordHoldingSnapshot(database.userId, holding);
    await store.recordHoldingSnapshot(database.userId, {
      ...holding,
      asOfDate: DateOnly.parse('2026-06-16'),
    });
    expect(await countRows(database, 'holdings_snapshots')).toBe(2);
  });

  it('an investment transaction is idempotent on the provider natural key', async () => {
    // 01 §5.5: there is no `/investments/transactions/sync`, so the connector
    // re-fetches a date window and the same fill arrives again on every run.
    // The upsert is what stops a monthly sync from tripling a year of trades.
    const transaction = {
      id: newId(),
      accountId,
      securityId,
      provider: 'plaid',
      providerTransactionId: 'itx-abc-123',
      type: 'BUY' as const,
      // The provider's own word, kept verbatim; the engine never switches on it.
      subtype: 'buy' as const,
      name: 'Buy VTI',
      quantity: Quantity.of('10'),
      price: Quantity.of('100.00'),
      amount: usd('1000.00'),
      fees: usd('1.00'),
      tradeDate: DateOnly.parse('2026-06-10'),
      settleDate: DateOnly.parse('2026-06-12'),
      source: 'BROKER' as const,
      fingerprint: null,
    };

    const first = await store.upsertInvestmentTransaction(database.userId, transaction);
    const second = await store.upsertInvestmentTransaction(database.userId, {
      ...transaction,
      id: newId(),
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    // The second write keeps the *first* row's id, so anything that recorded a
    // reference to it still resolves.
    expect(second.id).toBe(first.id);
    expect(await countRows(database, 'investment_transactions')).toBe(1);
  });

  it('the same provider id in two accounts is two transactions', async () => {
    // The natural key is (user, account, provider, provider id): two brokerages
    // may well both call a trade `1`.
    const transaction = {
      id: newId(),
      accountId,
      securityId,
      provider: 'plaid',
      providerTransactionId: '1',
      type: 'BUY' as const,
      subtype: null,
      name: null,
      quantity: Quantity.of('1'),
      price: Quantity.of('100.00'),
      amount: usd('100.00'),
      fees: usd('0.00'),
      tradeDate: DateOnly.parse('2026-06-10'),
      settleDate: null,
      source: 'BROKER' as const,
      fingerprint: null,
    };
    await store.upsertInvestmentTransaction(database.userId, transaction);
    await store.upsertInvestmentTransaction(database.userId, {
      ...transaction,
      id: newId(),
      accountId: newId(),
    });
    expect(await countRows(database, 'investment_transactions')).toBe(2);
  });
});
