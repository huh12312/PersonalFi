// SPDX-License-Identifier: MIT
/**
 * WP 10.4 — what the lot consumer does with a security nobody could identify,
 * against Postgres (migration 0043).
 *
 *   * the position becomes an `unresolved_holdings` row (name, ticker,
 *     quantity, the institution's own value, every abstention) instead of
 *     nothing;
 *   * a later run that resolves it clears the row (replace, not merge);
 *   * a movement in it is stored with `security_id` NULL, the provider's name
 *     and ticker, and `security_unresolved`, and opens no lot;
 *   * a movement that resolved before and fails to resolve now keeps the
 *     security it had.
 */
import { DateOnly, Money, currency, fixedClock, newId } from '@core/kernel';
import type { ProviderSecurityFact } from '@connector/port';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runLotSync,
  type InvestmentSyncPort,
  type ResolvedHoldingFact,
  type ResolvedTransactionFact,
  type UnresolvedHoldingFact,
} from '../../src/consumer.ts';
import { drizzleLotStore } from '../../src/lots-store.ts';
import { outboxOf } from '../../src/store.ts';
import {
  CORRELATION_ID,
  EPOCH,
  NO_DATABASE,
  countRows,
  investmentsDatabase,
  type TestDatabase,
} from './harness.ts';

const USD = currency('USD');
const CLOCK = fixedClock(EPOCH);
const AS_OF = DateOnly.parse('2026-10-01');
const usd = (minor: bigint): ReturnType<typeof Money.of> => Money.of(minor, USD);

function securityFact(id: string, ticker: string, name: string): ProviderSecurityFact {
  return {
    providerSecurityId: id,
    identifiers: [{ kind: 'ticker', value: ticker, chain: null, mic: null }],
    name,
    type: 'mutual fund',
    subtype: null,
    currency: 'USD',
    isCashEquivalent: false,
    closePrice: null,
    closePriceAsOf: null,
    raw: {},
    fingerprint: `fp-${id}`,
  };
}

const TARGET_2050 = securityFact('sec-vfifx', 'VFIFX', 'Vanguard Target Retirement 2050 Fund');
const BARE_TICKER_ABSTENTIONS = [
  { tier: 'figi', reason: 'absent', detail: null },
  { tier: 'isin', reason: 'absent', detail: null },
  { tier: 'cusip', reason: 'absent', detail: null },
  { tier: 'ticker', reason: 'unqualified_ticker', detail: 'VFIFX' },
] as const;

describe.skipIf(NO_DATABASE)('WP 10.4 — unresolved positions and movements', () => {
  let database: TestDatabase;
  let accountId: string;
  let securityId: string;

  function holdingFact(security: ProviderSecurityFact, quantity: string, valueMinor: bigint) {
    return {
      providerAccountId: 'provider-acct-1',
      security,
      quantity,
      costBasis: null,
      value: usd(valueMinor),
      asOf: new Date(EPOCH),
      raw: {},
    };
  }

  function contribution(id: string, security: ProviderSecurityFact) {
    return {
      providerAccountId: 'provider-acct-1',
      providerTransactionId: id,
      security,
      date: DateOnly.parse('2026-09-30'),
      name: 'Contribution',
      type: 'buy',
      subtype: 'contribution',
      quantity: '2.5',
      price: '171.2200000000',
      amount: usd(-42_805n),
      fees: usd(0n),
      raw: {},
      fingerprint: `fp-${id}`,
    };
  }

  function portFor(facts: {
    holdings?: readonly ResolvedHoldingFact[];
    transactions?: readonly ResolvedTransactionFact[];
    unresolvedHoldings?: readonly UnresolvedHoldingFact[];
  }): InvestmentSyncPort {
    return {
      async factsForRun() {
        return {
          provider: 'plaid',
          asOfDate: AS_OF,
          holdings: facts.holdings ?? [],
          transactions: facts.transactions ?? [],
          ...(facts.unresolvedHoldings === undefined
            ? {}
            : { unresolvedHoldings: facts.unresolvedHoldings }),
        };
      },
      async isRetirementAccount() {
        return true;
      },
      async isDigitalAsset() {
        return false;
      },
    };
  }

  async function sync(port: InvestmentSyncPort, runId = 'run-1'): Promise<void> {
    await runLotSync(
      {
        store: drizzleLotStore(database.db, CLOCK),
        port,
        clock: CLOCK,
        outbox: outboxOf(database.db),
      },
      { userId: database.userId, syncRunId: runId, correlationId: CORRELATION_ID },
    );
  }

  beforeAll(async () => {
    database = await investmentsDatabase('unresolved');
    accountId = newId();
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.db.execute(
      sql.raw(
        'TRUNCATE cost_basis_lots, holdings, holdings_snapshots, investment_transactions, ' +
          'unresolved_holdings, securities, domain_events RESTART IDENTITY CASCADE',
      ),
    );
    securityId = newId();
    await database.db.execute(sql`
      INSERT INTO securities
        (id, user_id, identity_kind, identity_key, ticker, name, type, currency,
         classification_source, is_cash_equivalent, asset_class, region, sector,
         classification_depth, classification_flagged)
      VALUES (${securityId}::uuid, ${database.userId}::uuid, 'ticker', 'ticker:VFIFX@XNAS',
              'VFIFX', 'Vanguard Target Retirement 2050 Fund', 'mutual_fund', 'USD',
              'LOCAL_SEED_TABLE', FALSE, 'US_EQUITY', 'US', 'UNKNOWN', 0, FALSE)
    `);
  });

  it('an unidentified position becomes a named row; its movement is kept with NULL security and opens no lot', async () => {
    await sync(
      portFor({
        unresolvedHoldings: [
          {
            accountId,
            fact: holdingFact(TARGET_2050, '12.5', 214_033n),
            abstentions: BARE_TICKER_ABSTENTIONS,
          },
        ],
        transactions: [
          {
            accountId,
            securityId: null,
            unresolved: { name: TARGET_2050.name ?? null, ticker: 'VFIFX' },
            source: 'BROKER',
            fact: contribution('itx-c-1', TARGET_2050),
          },
        ],
      }),
    );

    const rows = await database.db.execute<{
      account_id: string;
      provider: string;
      provider_security_id: string;
      name: string;
      ticker: string;
      quantity: string;
      institution_value_minor: string;
      currency: string;
      abstentions: unknown;
      sync_run_id: string;
    }>(sql`SELECT * FROM unresolved_holdings WHERE user_id = ${database.userId}::uuid`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row?.account_id).toBe(accountId);
    expect(row?.name).toBe('Vanguard Target Retirement 2050 Fund');
    expect(row?.ticker).toBe('VFIFX');
    expect(Number(row?.quantity)).toBe(12.5);
    expect(String(row?.institution_value_minor)).toBe('214033');
    expect(row?.currency).toBe('USD');
    expect(row?.provider_security_id).toBe('sec-vfifx');
    expect(row?.sync_run_id).toBe('run-1');
    expect(row?.abstentions).toEqual(BARE_TICKER_ABSTENTIONS);

    const movements = await database.db.execute<{
      security_id: string | null;
      security_unresolved: boolean;
      provider_security_name: string | null;
      provider_ticker: string | null;
      subtype: string | null;
    }>(sql`
      SELECT security_id, security_unresolved, provider_security_name, provider_ticker, subtype
        FROM investment_transactions WHERE user_id = ${database.userId}::uuid
    `);
    expect(movements.rows).toEqual([
      {
        security_id: null,
        security_unresolved: true,
        provider_security_name: 'Vanguard Target Retirement 2050 Fund',
        provider_ticker: 'VFIFX',
        subtype: 'contribution',
      },
    ]);
    expect(await countRows(database, 'cost_basis_lots'), 'no lot without a security').toBe(0);
    expect(await countRows(database, 'holdings'), 'never a holdings row').toBe(0);
  });

  it('a later run that resolves the position clears its row; one that still fails rewrites it', async () => {
    const unresolved = {
      accountId,
      fact: holdingFact(TARGET_2050, '12.5', 214_033n),
      abstentions: BARE_TICKER_ABSTENTIONS,
    };
    await sync(portFor({ unresolvedHoldings: [unresolved] }), 'run-1');
    // Still failing, a day later, a different quantity: rewritten, not duplicated.
    await sync(
      portFor({
        unresolvedHoldings: [{ ...unresolved, fact: holdingFact(TARGET_2050, '13', 222_000n) }],
      }),
      'run-2',
    );
    const rewritten = await database.db.execute<{ quantity: string; sync_run_id: string }>(
      sql`SELECT quantity, sync_run_id FROM unresolved_holdings`,
    );
    expect(rewritten.rows).toHaveLength(1);
    expect(Number(rewritten.rows[0]?.quantity)).toBe(13);
    expect(rewritten.rows[0]?.sync_run_id).toBe('run-2');

    // Resolved on run 3: a holding now, and nothing unresolved in the account.
    await sync(
      portFor({
        holdings: [{ accountId, securityId, fact: holdingFact(TARGET_2050, '13', 222_000n) }],
        unresolvedHoldings: [],
      }),
      'run-3',
    );
    expect(await countRows(database, 'unresolved_holdings'), 'the resolution cleared it').toBe(0);
    expect(await countRows(database, 'holdings')).toBe(1);
  });

  it('a port that does not report unresolved positions leaves the table alone', async () => {
    await sync(
      portFor({
        unresolvedHoldings: [
          { accountId, fact: holdingFact(TARGET_2050, '1', 100n), abstentions: [] },
        ],
      }),
    );
    await sync(portFor({ holdings: [] }), 'run-2');
    expect(await countRows(database, 'unresolved_holdings')).toBe(1);
  });

  it('a movement that resolved before keeps its security when a later run cannot resolve it', async () => {
    await sync(
      portFor({
        transactions: [
          { accountId, securityId, source: 'BROKER', fact: contribution('itx-c-2', TARGET_2050) },
        ],
      }),
    );
    await sync(
      portFor({
        transactions: [
          {
            accountId,
            securityId: null,
            unresolved: { name: 'Vanguard Target Retirement 2050 Fund', ticker: 'VFIFX' },
            source: 'BROKER',
            fact: contribution('itx-c-2', TARGET_2050),
          },
        ],
      }),
      'run-2',
    );
    const movement = await database.db.execute<{
      security_id: string | null;
      security_unresolved: boolean;
    }>(sql`SELECT security_id, security_unresolved FROM investment_transactions`);
    expect(movement.rows).toEqual([{ security_id: securityId, security_unresolved: false }]);
  });
});
