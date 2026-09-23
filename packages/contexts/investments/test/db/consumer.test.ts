// SPDX-License-Identifier: MIT
/**
 * The lot consumer, end to end, against a real Postgres.
 *
 * `src/consumer.ts`'s header makes a specific promise — "Delivering the event
 * twice therefore produces the same rows and appends no second event —
 * `test/db/lots.test.ts` asserts exactly that, comparing whole rows and the
 * `domain_events` count" — and this file is where that promise is kept. It is
 * split out of `lots.test.ts` because it needs a different fixture (a whole
 * sync run's facts, not a single lot) and because a suite that both writes rows
 * directly *and* drives the consumer would make a failure ambiguous about which
 * path produced it.
 *
 * Idempotence matters more here than in most consumers because there is no
 * cursor to protect us. 01 §5.5: Plaid has no `/investments/transactions/sync`,
 * so the connector re-fetches a *date window* and the same fills arrive on
 * every run, forever. A consumer that opened a lot per delivery would triple a
 * year of trades in a quarter.
 *
 * The R6 seam is exercised here too: the same run carries an exact `BROKER`
 * fill and an `IMPORTED` CSV leg, which is what a Coinbase account actually
 * looks like (docs/evidence/phase-3/wp3.5-coinbase.md §1), and the engine has
 * to accept both without inventing a basis for the second.
 */
import { DateOnly, Money, fixedClock, newId, currency } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboxOf } from '../../src/store.ts';
import { drizzleLotStore } from '../../src/lots-store.ts';
import {
  runLotSync,
  type InvestmentSyncPort,
  type ResolvedHoldingFact,
  type ResolvedTransactionFact,
} from '../../src/consumer.ts';
import {
  CORRELATION_ID,
  EPOCH,
  NO_DATABASE,
  countRows,
  dumpTable,
  investmentsDatabase,
  type TestDatabase,
} from './harness.ts';

const USD = currency('USD');
const CLOCK = fixedClock(EPOCH);
const AS_OF = DateOnly.parse('2026-06-15');

const usd = (dollars: string): ReturnType<typeof Money.of> =>
  Money.of(BigInt(dollars.replace('.', '')), USD);

describe.skipIf(NO_DATABASE)('the lot consumer, against Postgres', () => {
  let database: TestDatabase;
  let accountId: string;
  let securityId: string;

  async function seedSecurity(ticker: string, type = 'etf'): Promise<string> {
    const id = newId();
    const chain = type === 'crypto' ? 'bitcoin' : null;
    await database.db.execute(sql`
      INSERT INTO securities
        (id, user_id, identity_kind, identity_key, ticker, name, type, currency, chain,
         classification_source, is_cash_equivalent, asset_class, region, sector,
         classification_depth, classification_flagged)
      VALUES (${id}::uuid, ${database.userId}::uuid, 'ticker', ${`ticker:${ticker}`},
              ${ticker}, ${ticker}, ${type}, 'USD', ${chain}, 'LOCAL_SEED_TABLE', FALSE,
              'US_EQUITY', 'US', 'UNKNOWN', 0, FALSE)
    `);
    return id;
  }

  /**
   * One buy, reported the way a provider reports it.
   *
   * `source` is the R6 seam: `BROKER` is an exact provider leg (a Coinbase v3
   * fill, a Plaid trade) and `IMPORTED` is a CSV one. The engine takes both
   * through the same path and never has to know which it is looking at.
   */
  function buy(
    providerTransactionId: string,
    quantity: string,
    amount: string,
    date = '2026-06-10',
    source: 'BROKER' | 'IMPORTED' | 'USER' = 'BROKER',
  ): ResolvedTransactionFact {
    return {
      accountId,
      securityId,
      source,
      fact: {
        providerAccountId: 'provider-acct-1',
        providerTransactionId,
        security: { kind: 'ticker', value: 'VTI', chain: null, mic: null },
        providerSecurityId: 'provider-sec-1',
        date: DateOnly.parse(date),
        name: 'Buy VTI',
        type: 'buy',
        subtype: 'buy',
        quantity,
        price: '100.0000000000',
        amount: usd(amount),
        fees: usd('0.00'),
        raw: {},
        fingerprint: `fp-${providerTransactionId}`,
      },
    };
  }

  function holdingFact(
    quantity: string,
    value: string,
    costBasis: string | null,
  ): ResolvedHoldingFact {
    return {
      accountId,
      securityId,
      fact: {
        providerAccountId: 'provider-acct-1',
        security: { kind: 'ticker', value: 'VTI', chain: null, mic: null },
        providerSecurityId: 'provider-sec-1',
        quantity,
        costBasis: costBasis === null ? null : usd(costBasis),
        value: usd(value),
        asOf: new Date(EPOCH),
        raw: {},
      },
    };
  }

  function portFor(
    holdings: readonly ResolvedHoldingFact[],
    transactions: readonly ResolvedTransactionFact[],
    options: { readonly digitalAsset?: boolean; readonly retirement?: boolean } = {},
  ): InvestmentSyncPort {
    return {
      async factsForRun() {
        return { provider: 'plaid', asOfDate: AS_OF, holdings, transactions };
      },
      async isRetirementAccount() {
        return options.retirement === true;
      },
      async isDigitalAsset() {
        return options.digitalAsset === true;
      },
    };
  }

  const syncInput = {
    userId: '',
    syncRunId: 'run-1',
    correlationId: CORRELATION_ID,
    causationId: null,
  };

  async function sync(port: InvestmentSyncPort): ReturnType<typeof runLotSync> {
    return runLotSync(
      {
        store: drizzleLotStore(database.db, CLOCK),
        port,
        clock: CLOCK,
        outbox: outboxOf(database.db),
      },
      { ...syncInput, userId: database.userId },
    );
  }

  beforeAll(async () => {
    database = await investmentsDatabase('consumer');
    accountId = newId();
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql.raw(
        'TRUNCATE cost_basis_lots, basis_method_elections, holdings, holdings_snapshots, ' +
          'investment_transactions, securities, domain_events RESTART IDENTITY CASCADE',
      ),
    );
    securityId = await seedSecurity('VTI');
  });

  it('a sync run opens lots, records the holding and emits LotsUpdated', async () => {
    const port = portFor(
      [holdingFact('15', '3000.00', '1500.00')],
      [buy('itx-1', '10', '-1000.00'), buy('itx-2', '5', '-500.00', '2026-06-11')],
    );
    const result = await sync(port);

    expect(await countRows(database, 'cost_basis_lots')).toBe(2);
    expect(await countRows(database, 'investment_transactions')).toBe(2);
    expect(await countRows(database, 'holdings')).toBe(1);
    expect(result.holdingsTouched).toBeGreaterThan(0);

    const events = await database.db.execute<{ event_type: string }>(
      sql`SELECT event_type FROM domain_events ORDER BY event_type`,
    );
    expect(events.rows.map((row) => row.event_type)).toContain('investments.LotsUpdated');
  });

  it('delivering the same run twice produces identical rows and no second event', async () => {
    // The promise `src/consumer.ts`'s header makes, kept: whole rows compared,
    // and the `domain_events` count held flat.
    const port = portFor(
      [holdingFact('15', '3000.00', '1500.00')],
      [buy('itx-1', '10', '-1000.00'), buy('itx-2', '5', '-500.00', '2026-06-11')],
    );

    await sync(port);
    const lotsAfterFirst = await dumpTable(database, 'cost_basis_lots');
    const transactionsAfterFirst = await dumpTable(database, 'investment_transactions');
    const holdingsAfterFirst = await dumpTable(database, 'holdings');
    const eventsAfterFirst = await countRows(database, 'domain_events');

    await sync(port);

    // `updated_at` is fixed by `fixedClock`, so whole-row equality is a real
    // comparison rather than one that had to exclude the interesting columns.
    expect(await dumpTable(database, 'cost_basis_lots')).toEqual(lotsAfterFirst);
    expect(await dumpTable(database, 'investment_transactions')).toEqual(transactionsAfterFirst);
    expect(await dumpTable(database, 'holdings')).toEqual(holdingsAfterFirst);

    // Not two lots per buy, and not a second LotsUpdated telling a downstream
    // consumer that something changed when nothing did.
    expect(await countRows(database, 'cost_basis_lots')).toBe(2);
    expect(await countRows(database, 'domain_events')).toBe(eventsAfterFirst);
  });

  it('a sale realises a gain, emits RealizedGainRecorded and leaves the remainder open', async () => {
    const sale: ResolvedTransactionFact = {
      accountId,
      securityId,
      source: 'BROKER',
      fact: {
        ...buy('itx-sale', '-4', '600.00', '2026-06-12').fact,
        type: 'sell',
        subtype: 'sell',
        name: 'Sell VTI',
        price: '150.0000000000',
      },
    };
    const port = portFor(
      [holdingFact('6', '900.00', '600.00')],
      [buy('itx-1', '10', '-1000.00'), sale],
    );
    await sync(port);

    const lots = await dumpTable(database, 'cost_basis_lots');
    expect(lots).toHaveLength(1);
    expect(lots[0]?.['quantity_remaining']).toBe('6.000000000000000000');

    const events = await database.db.execute<{ event_type: string }>(
      sql`SELECT event_type FROM domain_events`,
    );
    expect(events.rows.map((row) => row.event_type)).toContain('investments.RealizedGainRecorded');
  });

  it('accepts an exact BROKER fill and an IMPORTED leg in one run without inventing a basis', async () => {
    // The R6 seam. Coinbase v3 reports the fill; the deposit only exists in the
    // CSV export, and until the user uploads one its basis is unknown. The
    // engine must take both legs and must not average one into the other.
    const deposit: ResolvedTransactionFact = {
      accountId,
      securityId,
      // The CSV leg. v3 never reported it; the user's export did.
      source: 'IMPORTED',
      fact: {
        ...buy('itx-deposit', '2', '0.00', '2026-06-09').fact,
        type: 'transfer',
        subtype: 'transfer_in',
        name: 'Deposit VTI',
        price: '0.0000000000',
        amount: usd('0.00'),
      },
    };
    const port = portFor(
      [holdingFact('12', '2400.00', null)],
      [buy('itx-1', '10', '-1000.00'), deposit],
    );
    await sync(port);

    const lots = await dumpTable(database, 'cost_basis_lots', 'open_date');
    expect(lots).toHaveLength(2);

    // One exact basis, one honest unknown — and the unknown declares
    // `ESTIMATED` and carries the warning text the UI is obliged to show.
    const unknown = lots.find((row) => row['basis_minor'] === null);
    const known = lots.find((row) => row['basis_minor'] !== null);
    expect(known?.['basis_source']).toBe('BROKER');
    expect(known?.['basis_minor']).toBe('100000');
    expect(unknown).toBeDefined();
    expect(unknown?.['basis_source']).toBe('ESTIMATED');
    expect(String(unknown?.['basis_warning'] ?? '').length).toBeGreaterThan(0);
    // Not a zero standing in for "we do not know".
    expect(unknown?.['basis_minor']).not.toBe('0');
  });

  it('a holding whose provider reported no basis is stored as NULL, never as zero', async () => {
    const port = portFor([holdingFact('10', '2000.00', null)], []);
    await sync(port);
    const holdings = await dumpTable(database, 'holdings');
    expect(holdings[0]?.['cost_basis_minor']).toBeNull();
    expect(holdings[0]?.['cost_basis_is_user_supplied']).toBe(false);
  });

  it('a run with no investment facts is a checking account, not a failure', async () => {
    const result = await sync(portFor([], []));
    expect(result.holdingsTouched).toBe(0);
    expect(await countRows(database, 'cost_basis_lots')).toBe(0);
    expect(await countRows(database, 'domain_events')).toBe(0);
  });
});
