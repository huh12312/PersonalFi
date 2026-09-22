// SPDX-License-Identifier: MIT
/**
 * The securities master against a real Postgres.
 *
 * `src/resolver.test.ts` proves the merge *rule*; this suite proves the
 * *schema* agrees — that the unique index refuses a second row even when the
 * resolver is bypassed entirely, that `identity_kind`'s CHECK has no
 * `proprietary` member, and that a `NUMERIC(38,18)` really does return the
 * satoshi it was given.
 */
import { Quantity, fixedClock, newId } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { identifierKeyOf, identifierOf } from '../../src/identifiers.ts';
import {
  createSecurityResolver,
  type ResolveContext,
  type Resolution,
  type ResolvedSecurity,
  type SecurityResolver,
} from '../../src/resolver.ts';
import { drizzleSecurityStore, outboxOf, type SecurityStore } from '../../src/store.ts';
import {
  CORRELATION_ID,
  EPOCH,
  NO_DATABASE,
  countRows,
  investmentsDatabase,
  pgFailureOf,
  type TestDatabase,
} from './harness.ts';

const ETH_NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CLOCK = fixedClock(EPOCH);

function resolved(resolution: Resolution): ResolvedSecurity {
  if (resolution.outcome !== 'resolved') {
    throw new Error(
      `expected a resolution, got an abstain: ${resolution.abstentions
        .map((entry) => `${entry.tier}=${entry.reason}`)
        .join(', ')}`,
    );
  }
  return resolution;
}

describe.skipIf(NO_DATABASE)('securities, against Postgres', () => {
  let database: TestDatabase;
  let store: SecurityStore;
  let resolver: SecurityResolver;
  let context: ResolveContext;

  beforeAll(async () => {
    database = await investmentsDatabase('securities');
    store = drizzleSecurityStore(database.db);
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await database.truncate();
    resolver = createSecurityResolver({
      store,
      clock: CLOCK,
      // The production sink: the event lands in `domain_events` in the same
      // handle the rows were written through.
      events: {
        append: (event) => appendEvent(outboxOf(database.db), event).then(() => undefined),
      },
    });
    context = {
      userId: database.userId,
      provider: 'plaid',
      correlationId: CORRELATION_ID,
    };
  });

  it('ETH from Coinbase, a wallet contract address and Plaid ETHEREUM resolve to one security_id', async () => {
    // The §5 exit criterion, with all three identifiers shown. Each provider
    // names the same coin in the only vocabulary it has, and no two of those
    // vocabularies overlap.
    const coinbase = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('ticker', 'ETH')],
          providerSecurityId: 'ETH-USD',
          name: 'Ether',
          type: 'cryptocurrency',
          currency: 'USD',
        },
        { ...context, provider: 'coinbase' },
      ),
    );
    const wallet = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('chain_contract', ETH_NATIVE_SENTINEL, { chain: 'ETH' })],
          name: 'Ether',
          type: 'cryptocurrency',
        },
        { ...context, provider: 'walletrpc' },
      ),
    );
    const plaid = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('ticker', 'ETHEREUM')],
          providerSecurityId: 'sec-eth-0009',
          name: 'Ethereum',
          type: 'cryptocurrency',
        },
        { ...context, provider: 'plaid' },
      ),
    );

    expect(wallet.securityId).toBe(coinbase.securityId);
    expect(plaid.securityId).toBe(coinbase.securityId);
    expect(await countRows(database, 'securities')).toBe(1);

    const rows = await database.db.execute<{
      identity_kind: string;
      identity_key: string;
      chain: string;
      contract: string;
      asset_class: string;
      classification_source: string;
    }>(sql`SELECT identity_kind, identity_key, chain, contract, asset_class, classification_source
            FROM securities`);
    expect(rows.rows[0]?.identity_kind).toBe('chain_contract');
    expect(rows.rows[0]?.chain).toBe('ethereum');
    expect(rows.rows[0]?.contract).toBe('native');
    expect(rows.rows[0]?.asset_class).toBe('CRYPTO');
    expect(rows.rows[0]?.classification_source).toBe('PROVIDER');

    // Six names now point at that one row: three tickers as the providers
    // spelled them, the canonical chain_contract, and the two provider ids —
    // each attributed to its issuer and none of them an identity.
    const identifiers = await database.db.execute<{
      kind: string;
      value: string;
      provider: string | null;
    }>(sql`SELECT kind, value, provider FROM security_identifiers ORDER BY kind, value`);
    expect(identifiers.rows.map((row) => `${row.kind}:${row.value}`)).toEqual([
      'chain_contract:native',
      'proprietary:ETH-USD',
      'proprietary:sec-eth-0009',
      'ticker:ETH',
      'ticker:ETHEREUM',
    ]);
    for (const row of identifiers.rows) {
      if (row.kind === 'proprietary') expect(row.provider).not.toBeNull();
    }
  });

  it('two identifiers for one security never create two rows', async () => {
    // Resolved through the resolver first...
    const first = resolved(
      await resolver.resolve({ identifiers: [identifierOf('figi', 'BBG000BDTF76')] }, context),
    );
    const second = resolved(
      await resolver.resolve(
        {
          identifiers: [
            identifierOf('figi', 'BBG000BDTF76'),
            identifierOf('isin', 'US9229087690'),
            identifierOf('cusip', '922908769'),
            identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
          ],
        },
        { ...context, provider: 'brokerage' },
      ),
    );
    expect(second.securityId).toBe(first.securityId);
    expect(await countRows(database, 'securities')).toBe(1);

    // ...and then with the resolver bypassed entirely, because the claim is
    // about the schema and not about the code path. `security_identifiers`'
    // UNIQUE (user_id, identifier_key) is what makes a second row impossible
    // even if a future caller's lookup were wrong.
    const other = await store.insertSecurity({
      userId: database.userId,
      identityKind: 'isin',
      identityKey: identifierKeyOf({ kind: 'isin', value: 'US0378331005' }),
      ticker: null,
      mic: null,
      cusip: null,
      isin: 'US0378331005',
      figi: null,
      chain: null,
      contract: null,
      name: 'Apple Inc',
      type: 'equity',
      currency: 'USD',
      expenseRatio: null,
      isCashEquivalent: false,
      assetClass: 'US_EQUITY',
      region: 'US',
      sector: 'Information Technology',
      classificationSource: 'SIC_SECTOR_MAP',
      classificationDepth: 0,
      classificationResidual: null,
      classificationFlagged: false,
    });

    expect(
      await pgFailureOf(
        database.db.execute(sql`
          INSERT INTO security_identifiers
            (id, user_id, security_id, kind, value, chain, mic, identifier_key, provider, confidence)
          VALUES (
            ${newId()}::uuid, ${database.userId}::uuid, ${other.id}::uuid, 'figi',
            'BBG000BDTF76', NULL, NULL,
            ${identifierKeyOf({ kind: 'figi', value: 'BBG000BDTF76' })}, 'rogue', 1.0
          )
        `),
      ),
    ).toEqual({ code: '23505', constraint: 'security_identifiers_user_key_idx' });
  });

  it('refuses a security whose only name is a provider’s own id', async () => {
    // `securities.identity_kind`'s CHECK has no `proprietary` member, so the
    // D25 rule is a property of the database and not only of the resolver.
    // This is the database half of the sabotage in
    // docs/evidence/phase-3/wp3.1-securities.md §5.
    expect(
      await pgFailureOf(
        database.db.execute(sql`
          INSERT INTO securities
            (id, user_id, identity_kind, identity_key, type, classification_source,
             is_cash_equivalent, asset_class, region, sector, classification_depth,
             classification_flagged)
          VALUES (${newId()}::uuid, ${database.userId}::uuid, 'proprietary', 'proprietary:sec-1',
                  'other', 'UNCLASSIFIED', FALSE, 'UNCLASSIFIED', 'UNKNOWN', 'UNKNOWN', 0, FALSE)
        `),
      ),
    ).toEqual({ code: '23514', constraint: 'securities_identity_kind_check' });

    // And its sibling: an unattributed opaque string is not evidence either.
    const security = resolved(
      await resolver.resolve({ identifiers: [identifierOf('figi', 'BBG000BDTF76')] }, context),
    );
    expect(
      await pgFailureOf(
        database.db.execute(sql`
          INSERT INTO security_identifiers
            (id, user_id, security_id, kind, value, chain, mic, identifier_key, provider, confidence)
          VALUES (${newId()}::uuid, ${database.userId}::uuid, ${security.securityId}::uuid,
                  'proprietary', 'sec-1', NULL, NULL, 'proprietary:sec-1:', NULL, 0.2)
        `),
      ),
    ).toEqual({
      code: '23514',
      constraint: 'security_identifiers_proprietary_names_its_issuer',
    });
  });

  it('writes SecurityResolutionFailed to domain_events and no securities row', async () => {
    const outcome = await resolver.resolve(
      {
        identifiers: [identifierOf('ticker', 'SWEEP')],
        providerSecurityId: 'NWSWEEP',
        name: 'Northwind Cash Sweep',
        type: 'cash',
      },
      context,
    );
    expect(outcome.outcome).toBe('unresolved');
    expect(await countRows(database, 'securities')).toBe(0);
    expect(await countRows(database, 'security_identifiers')).toBe(0);

    const events = await database.db.execute<{ event_type: string; payload: unknown }>(
      sql`SELECT event_type, payload FROM domain_events ORDER BY seq`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.event_type).toBe('investments.SecurityResolutionFailed');
    const payload = events.rows[0]?.payload as {
      readonly abstentions: readonly { readonly tier: string; readonly reason: string }[];
      readonly providerSecurityId: string;
    };
    expect(payload.providerSecurityId).toBe('NWSWEEP');
    expect(payload.abstentions.find((entry) => entry.tier === 'proprietary')?.reason).toBe(
      'proprietary_is_not_an_identity',
    );
  });

  it('a merge re-points every identifier and leaves the loser followable', async () => {
    const byCusip = resolved(
      await resolver.resolve({ identifiers: [identifierOf('cusip', '922908769')] }, context),
    );
    const byFigi = resolved(
      await resolver.resolve(
        { identifiers: [identifierOf('figi', 'BBG000BDTF76')] },
        { ...context, provider: 'brokerage' },
      ),
    );
    expect(await countRows(database, 'securities')).toBe(2);

    const merged = resolved(
      await resolver.resolve(
        {
          identifiers: [identifierOf('figi', 'BBG000BDTF76'), identifierOf('cusip', '922908769')],
        },
        context,
      ),
    );
    expect(merged.securityId).toBe(byFigi.securityId);

    // Both rows survive — nothing is deleted — and the loser points forward.
    expect(await countRows(database, 'securities')).toBe(2);
    const rows = await database.db.execute<{ id: string; merged_into_id: string | null }>(
      sql`SELECT id::text AS id, merged_into_id::text AS merged_into_id FROM securities`,
    );
    const loser = rows.rows.find((row) => row.id === byCusip.securityId);
    expect(loser?.merged_into_id).toBe(byFigi.securityId);

    const owners = await database.db.execute<{ security_id: string }>(
      sql`SELECT DISTINCT security_id::text AS security_id FROM security_identifiers`,
    );
    expect(owners.rows.map((row) => row.security_id)).toEqual([byFigi.securityId]);
  });

  it('quantities round-trip 0.00000001 BTC', async () => {
    // 04 §2.3, and D3. `securities` holds no quantity — a security has no
    // amount, and `holdings.quantity NUMERIC(38,18)` arrives in 0014 (WP 3.2).
    // What this asserts is the chain that column will depend on and that
    // nothing else in this package can prove: `Quantity` → the driver → a
    // `NUMERIC(38,18)` column → the type parser → `Quantity`, with the satoshi
    // intact. A float loses it at the second step, and it is the *storage* leg
    // that a cast-only test would skip, which is why there is a table here.
    const satoshi = Quantity.of('0.00000001');
    await database.db.execute(
      sql.raw('CREATE TEMP TABLE quantity_round_trip (q NUMERIC(38,18) NOT NULL)'),
    );
    await database.db.execute(
      sql`INSERT INTO quantity_round_trip (q) VALUES (${Quantity.toDatabaseString(satoshi)})`,
    );
    const read = await database.db.execute<{ q: string }>(
      sql.raw('SELECT q FROM quantity_round_trip'),
    );

    expect(read.rows[0]?.q).toBe('0.000000010000000000');
    expect(Quantity.fromDatabaseString(read.rows[0]?.q ?? '')).toBe(satoshi);
    // And the 18-decimal end of the range, which is what the column is that
    // wide for: an ERC-20 wei balance.
    const wei = Quantity.of('0.000000000000000001');
    await database.db.execute(
      sql`INSERT INTO quantity_round_trip (q) VALUES (${Quantity.toDatabaseString(wei)})`,
    );
    const both = await database.db.execute<{ q: string }>(
      sql.raw('SELECT q FROM quantity_round_trip ORDER BY q'),
    );
    expect(both.rows.map((row) => Quantity.fromDatabaseString(row.q))).toEqual([wei, satoshi]);
    await database.db.execute(sql.raw('DROP TABLE quantity_round_trip'));
  });
});
