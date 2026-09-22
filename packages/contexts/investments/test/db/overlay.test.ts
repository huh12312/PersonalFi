// SPDX-License-Identifier: MIT
/**
 * 04 §2.2 applied to a security's metadata: provider facts are rewritten
 * freely, the user's intent is not, and the two live in different tables so
 * that the second sentence is a fact about the schema rather than a habit.
 */
import { fixedClock, newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectiveClassificationOf } from '../../src/classify.ts';
import { identifierOf } from '../../src/identifiers.ts';
import {
  createSecurityResolver,
  type ResolveContext,
  type Resolution,
  type ResolvedSecurity,
  type SecurityResolver,
} from '../../src/resolver.ts';
import { drizzleSecurityStore, type SecurityStore } from '../../src/store.ts';
import {
  CORRELATION_ID,
  EPOCH,
  NO_DATABASE,
  countRows,
  dumpTable,
  investmentsDatabase,
  pgFailureOf,
  type TestDatabase,
} from './harness.ts';

const CLOCK = fixedClock(EPOCH);

function resolved(resolution: Resolution): ResolvedSecurity {
  if (resolution.outcome !== 'resolved') throw new Error('expected a resolution');
  return resolution;
}

describe.skipIf(NO_DATABASE)('security_overlay', () => {
  let database: TestDatabase;
  let store: SecurityStore;
  let resolver: SecurityResolver;
  let context: ResolveContext;

  beforeAll(async () => {
    database = await investmentsDatabase('overlay');
    store = drizzleSecurityStore(database.db);
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await database.truncate();
    resolver = createSecurityResolver({ store, clock: CLOCK });
    context = { userId: database.userId, provider: 'plaid', correlationId: CORRELATION_ID };
  });

  it('a user asset-class override survives a provider re-sync', async () => {
    // 1. A first sync. The waterfall answers from the in-repo seed table.
    const first = resolved(
      await resolver.resolve(
        {
          identifiers: [
            identifierOf('figi', 'BBG000BDTF76'),
            identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
          ],
          providerSecurityId: 'sec-vti-0001',
          name: 'Vanguard Total Stock Market ETF',
          type: 'etf',
          currency: 'USD',
        },
        context,
      ),
    );
    const derived = await store.getSecurity(database.userId, first.securityId);
    expect(derived?.assetClass).toBe('US_EQUITY');
    expect(derived?.classificationSource).toBe('LOCAL_SEED_TABLE');

    // 2. The user disagrees. 04 §3.2: provider metadata for ETFs is thin, so
    //    "make it editable and remember the edit."
    await database.db.execute(sql`
      INSERT INTO security_overlay (id, user_id, security_id, asset_class, sector, locked_fields)
      VALUES (${newId()}::uuid, ${database.userId}::uuid, ${first.securityId}::uuid,
              'REAL_ESTATE', 'Real Estate', ARRAY['asset_class', 'sector']::TEXT[])
    `);
    const overlayBefore = await dumpTable(database, 'security_overlay');

    // 3. A re-sync. Same position, a provider that now reports it differently —
    //    the case that would overwrite a column-on-`securities` override.
    const again = resolved(
      await resolver.resolve(
        {
          identifiers: [
            identifierOf('figi', 'BBG000BDTF76'),
            identifierOf('ticker', 'VTI', { mic: 'XNYS' }),
            identifierOf('cusip', '922908769'),
          ],
          providerSecurityId: 'sec-vti-0001',
          name: 'VANGUARD TOTAL STOCK MKT ETF',
          type: 'etf',
          currency: 'USD',
        },
        { ...context, provider: 'brokerage' },
      ),
    );
    expect(again.securityId).toBe(first.securityId);
    expect(await countRows(database, 'securities')).toBe(1);

    // 4. The overlay is byte-identical: the re-sync could not reach it. This is
    //    the whole reason it is a separate table rather than two more columns.
    expect(await dumpTable(database, 'security_overlay')).toEqual(overlayBefore);

    // 5. And the effective answer is still the user's.
    const row = await store.getSecurity(database.userId, first.securityId);
    const overlay = await store.getOverlay(database.userId, first.securityId);
    expect(row).not.toBeNull();
    expect(overlay).not.toBeNull();
    const effective = effectiveClassificationOf(
      {
        assetClass: row?.assetClass ?? 'UNCLASSIFIED',
        region: row?.region ?? 'UNKNOWN',
        sector: row?.sector ?? 'UNKNOWN',
        expenseRatio: row?.expenseRatio ?? null,
        classificationSource: row?.classificationSource ?? 'UNCLASSIFIED',
      },
      overlay,
    );
    expect(effective.assetClass).toBe('REAL_ESTATE');
    expect(effective.sector).toBe('Real Estate');
    expect(effective.source).toBe('USER_OVERRIDE');
    // The derived value is still on the row, unchanged and still labelled with
    // the rung that produced it: an override hides a derivation, it does not
    // erase it, so "what did the data say before I corrected it?" stays
    // answerable.
    expect(row?.assetClass).toBe('US_EQUITY');
    expect(row?.classificationSource).toBe('LOCAL_SEED_TABLE');
    // A field the user did not lock still comes from the waterfall.
    expect(effective.region).toBe('US');
  });

  it('refuses an overlay that locks a field nobody can override', async () => {
    const security = resolved(
      await resolver.resolve(identifierOf('figi', 'BBG000BDTF76'), context),
    );
    expect(
      await pgFailureOf(
        database.db.execute(sql`
          INSERT INTO security_overlay (id, user_id, security_id, asset_class, locked_fields)
          VALUES (${newId()}::uuid, ${database.userId}::uuid, ${security.securityId}::uuid,
                  'CRYPTO', ARRAY['security_id']::TEXT[])
        `),
      ),
    ).toEqual({ code: '23514', constraint: 'security_overlay_locked_fields_are_known' });
  });

  it('refuses an asset class outside 07 §4.3’s taxonomy', async () => {
    const security = resolved(
      await resolver.resolve(identifierOf('figi', 'BBG000BDTF76'), context),
    );
    // The taxonomy is "kept small; expand later" (07 §4.3). Expanding it is a
    // migration, which is the point: a free-text asset class is a chart with
    // a bucket nobody can total.
    expect(
      (
        await pgFailureOf(
          database.db.execute(sql`
            INSERT INTO security_overlay (id, user_id, security_id, asset_class, locked_fields)
            VALUES (${newId()}::uuid, ${database.userId}::uuid, ${security.securityId}::uuid,
                    'MEME_STOCKS', ARRAY['asset_class']::TEXT[])
          `),
        )
      ).code,
    ).toBe('23514');
  });

  it('allows one overlay per security and refuses a second', async () => {
    const security = resolved(
      await resolver.resolve(identifierOf('figi', 'BBG000BDTF76'), context),
    );
    const insert = () =>
      database.db.execute(sql`
        INSERT INTO security_overlay (id, user_id, security_id, asset_class, locked_fields)
        VALUES (${newId()}::uuid, ${database.userId}::uuid, ${security.securityId}::uuid,
                'CRYPTO', ARRAY['asset_class']::TEXT[])
      `);
    await insert();
    // Two overlays for one security would make "what did the user say?" a
    // question with two answers.
    expect(await pgFailureOf(insert())).toEqual({
      code: '23505',
      constraint: 'security_overlay_user_security_idx',
    });
  });
});
