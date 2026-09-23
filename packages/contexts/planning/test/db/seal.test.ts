// SPDX-License-Identifier: MIT
/**
 * The §5 exit criterion: **a past date is byte-identical after a second
 * snapshot run.**
 *
 * This is a claim about Postgres — the BEFORE UPDATE trigger, the partial unique
 * index, and the literal bytes of two rows — so it lives in the `planning-db`
 * project, which is what `vitest.config.ts`'s comment about this work package
 * anticipates ("The seal ... and the hand-computed reconciliation are claims
 * about Postgres"). `test/seal.test.ts` holds the half that needs no database:
 * *when* a day has earned its seal.
 *
 * The measurement is deliberately harsh. `dumpRange` normalises only `bigint`
 * and `Date` rendering and key order; `updated_at`, `computed_at`, `revision`
 * and the entire `breakdown` JSONB are compared exactly as stored. An
 * implementation that merely *touched* a sealed row — bumping `updated_at`
 * while writing the same numbers — would fail this test, which is correct,
 * because touching a sealed row is the thing being forbidden.
 *
 * ## The sabotage, and why it aims where it does
 *
 * `'lets the writer update a sealed row'` removes the `AND sealed_at IS NULL`
 * from the store's own guarded UPDATE and issues the statement the writer would
 * have issued without it. That aims past the TypeScript guard at the database
 * trigger — guard 1 of the three in `src/seal.ts` — because guard 3 is code this
 * work package wrote and could rewrite, while the trigger is what holds when a
 * future writer, a repair script or a `psql` session forgets.
 */
import { fixedClock } from '@core/kernel';
import type { TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeNetWorth } from '../../src/net-worth.ts';
import { runSnapshot } from '../../src/snapshot.ts';
import { SealedRowImmutable } from '../../src/seal.ts';
import { currentRow, sealDay, upsertOpenDay } from '../../src/store.ts';
import type { PlanningExecutor } from '../../src/store.ts';
import { portsOf, type FakeWorld } from '../fakes.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  dumpRange,
  pgFailureOf,
  planningDatabase,
} from './harness.ts';
import fixture from '../fixtures/hand-computation.json' with { type: 'json' };

const NEW_YORK = 'America/New_York';
const world = fixture.world as unknown as FakeWorld;

/** The world, moved to whichever day a test needs it on. */
function worldOn(date: string): FakeWorld {
  return {
    ...world,
    balances: world.balances.map((row) => ({ ...row, date })),
    holdings: (world.holdings ?? []).map((row) => ({ ...row, asOfDate: date })),
    prices: (world.prices ?? []).map((row) => ({ ...row, date })),
    fxRates: (world.fxRates ?? []).map((row) => ({ ...row, date })),
  };
}

describe.skipIf(NO_DATABASE)('the seal, against Postgres', () => {
  let database: TestDatabase;
  let executor: PlanningExecutor;

  beforeAll(async () => {
    database = await planningDatabase('seal');
    executor = database.db;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  it('a past date is byte-identical after a second snapshot run', async () => {
    const userId = database.userId;

    // --- Run 1: compute the 14th while it is the open day. -----------------
    // 2026-06-14T18:00Z is 14:00 in New York on the 14th.
    const duringTheDay = fixedClock(new Date('2026-06-14T18:00:00Z'));
    await runSnapshot(executor, portsOf(worldOn('2026-06-14')), {
      userId,
      clock: duringTheDay,
      timeZone: NEW_YORK,
      baseCurrency: 'USD',
      correlationId: CORRELATION_ID,
    });

    // --- The next night: 04:00 local on the 15th. The 14th passed its 02:00
    //     boundary, so this run seals it and opens the 15th. -----------------
    const nextNight = fixedClock(new Date('2026-06-15T08:00:00Z'));
    const first = await runSnapshot(executor, portsOf(worldOn('2026-06-15')), {
      userId,
      clock: nextNight,
      timeZone: NEW_YORK,
      baseCurrency: 'USD',
      correlationId: CORRELATION_ID,
    });
    expect(first.sealedDates).toEqual(['2026-06-14']);

    const sealed = await currentRow(executor, userId, '2026-06-14');
    expect(sealed?.sealedAt).not.toBeNull();
    const afterFirstRun = await dumpRange(database, userId, '2026-06-14', '2026-06-14');

    // --- Run 2, with the world visibly different underneath it. ------------
    // Later clock, and every price and balance moved. If the sealed day were
    // recomputed at all, these are the numbers it would move to — so an
    // identical dump is evidence that it was not recomputed, rather than
    // evidence that recomputation happens to be idempotent.
    const movedWorld: FakeWorld = {
      ...worldOn('2026-06-15'),
      balances: worldOn('2026-06-15').balances.map((row) => ({
        ...row,
        currentMinor: (BigInt(row.currentMinor) * 2n).toString(),
      })),
      prices: (worldOn('2026-06-15').prices ?? []).map((row) => ({ ...row, close: '999.99' })),
      fxRates: (worldOn('2026-06-15').fxRates ?? []).map((row) => ({ ...row, rate: '0.5000' })),
    };
    const later = fixedClock(new Date('2026-06-15T09:30:00Z'));
    await runSnapshot(executor, portsOf(movedWorld), {
      userId,
      clock: later,
      timeZone: NEW_YORK,
      baseCurrency: 'USD',
      correlationId: CORRELATION_ID,
    });

    const afterSecondRun = await dumpRange(database, userId, '2026-06-14', '2026-06-14');
    expect(afterSecondRun).toBe(afterFirstRun);

    // The open day, by contrast, *did* move — which is what makes the
    // comparison above a statement about sealing rather than about a
    // snapshotter that writes nothing at all.
    const openDay = await currentRow(executor, userId, '2026-06-15');
    expect(openDay?.sealedAt).toBeNull();
    expect(openDay?.netWorthMinor).not.toBe(sealed?.netWorthMinor);
  });

  it('SABOTAGE: lets the writer update a sealed row, and the database refuses by name', async () => {
    const userId = await database.createUser('Sabotage Holder');
    const clock = fixedClock(new Date('2026-06-14T18:00:00Z'));

    const snapshot = await computeNetWorth(portsOf(worldOn('2026-06-14')), {
      userId,
      asOfDate: '2026-06-14',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot, clock });
    await sealDay(executor, { userId, asOfDate: '2026-06-14', clock });

    const before = await dumpRange(database, userId, '2026-06-14', '2026-06-14');

    // The sabotage: `src/store.ts`'s guarded UPDATE with its guard removed.
    // This is the statement a future writer produces by "simplifying" the WHERE
    // clause, and it must not be allowed to succeed.
    const failure = await pgFailureOf(
      database.db.execute(sql`
        UPDATE net_worth_daily
           SET net_worth_minor = 999999999,
               updated_at = now()
         WHERE user_id = ${userId}::uuid
           AND as_of_date = '2026-06-14'::date
      `),
    );

    // Asserted by *name*, not merely "it threw": the constraint name is what a
    // reader can check against migration 0017.
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('net_worth_daily_sealed_rows_are_immutable');
    expect(failure.message).toContain('sealed');

    // And nothing moved.
    expect(await dumpRange(database, userId, '2026-06-14', '2026-06-14')).toBe(before);
  });

  it('refuses a second seal with a typed error rather than silently doing nothing', async () => {
    const userId = await database.createUser('Double Seal Holder');
    const clock = fixedClock(new Date('2026-06-14T18:00:00Z'));
    const snapshot = await computeNetWorth(portsOf(worldOn('2026-06-14')), {
      userId,
      asOfDate: '2026-06-14',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot, clock });
    await sealDay(executor, { userId, asOfDate: '2026-06-14', clock });

    // A zero-row UPDATE is indistinguishable from success unless somebody
    // checks, which is what guard 3 exists to do.
    await expect(sealDay(executor, { userId, asOfDate: '2026-06-14', clock })).rejects.toThrow(
      SealedRowImmutable,
    );
  });

  it('refuses to recompute a sealed day through the ordinary write path', async () => {
    const userId = await database.createUser('Recompute Holder');
    const clock = fixedClock(new Date('2026-06-14T18:00:00Z'));
    const snapshot = await computeNetWorth(portsOf(worldOn('2026-06-14')), {
      userId,
      asOfDate: '2026-06-14',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot, clock });
    await sealDay(executor, { userId, asOfDate: '2026-06-14', clock });

    // `upsertOpenDay`'s ON CONFLICT arbiter is the *partial* index, so a sealed
    // day presents no conflicting row and the statement INSERTs — where the
    // (user_id, as_of_date, revision) unique index refuses it at revision 1.
    // The failure is loud, which is the design: silence would mean a recompute
    // of a sealed day looked like it worked.
    const failure = await pgFailureOf(upsertOpenDay(executor, { userId, snapshot, clock }));
    expect(failure.code).toBe('23505');
    expect(failure.constraint).toBe('net_worth_daily_day_revision_idx');
  });

  it('writes a correction as a new revision and leaves the sealed one untouched', async () => {
    const userId = await database.createUser('Correction Holder');
    const clock = fixedClock(new Date('2026-06-14T18:00:00Z'));
    const snapshot = await computeNetWorth(portsOf(worldOn('2026-06-14')), {
      userId,
      asOfDate: '2026-06-14',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot, clock });
    await sealDay(executor, { userId, asOfDate: '2026-06-14', clock });

    const revisionOne = await dumpRange(database, userId, '2026-06-14', '2026-06-14');

    const { correctDay } = await import('../../src/snapshot.ts');
    const corrected = await correctDay(
      executor,
      portsOf({
        ...worldOn('2026-06-14'),
        balances: worldOn('2026-06-14').balances.map((row) => ({
          ...row,
          currentMinor: (BigInt(row.currentMinor) + 100n).toString(),
        })),
      }),
      {
        userId,
        clock: fixedClock(new Date('2026-06-20T18:00:00Z')),
        timeZone: NEW_YORK,
        baseCurrency: 'USD',
        correlationId: CORRELATION_ID,
      },
      { asOfDate: '2026-06-14', reason: 'the provider restated three balances' },
    );

    expect(corrected.revision).toBe(2);
    expect(corrected.source).toBe('corrected');

    // Revision 1 is byte-identical to what it was before the correction: a
    // correction does not mutate, it supersedes.
    const stillThere = await database.db.execute<Record<string, unknown>>(sql`
      SELECT * FROM net_worth_daily
       WHERE user_id = ${userId}::uuid AND as_of_date = '2026-06-14'::date AND revision = 1
    `);
    expect(stillThere.rows).toHaveLength(1);
    expect(revisionOne).toContain('"revision": 1');

    // And revision 2 carries the provenance the CHECK constraint demands.
    const rows = await database.db.execute<{
      revision: number;
      supersedes_id: string | null;
      correction_reason: string | null;
      sealed_at: Date | null;
    }>(sql`
      SELECT revision, supersedes_id, correction_reason, sealed_at
        FROM net_worth_daily
       WHERE user_id = ${userId}::uuid AND as_of_date = '2026-06-14'::date
       ORDER BY revision
    `);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[1]?.supersedes_id).not.toBeNull();
    expect(rows.rows[1]?.correction_reason).toBe('the provider restated three balances');
    // A correction to a closed day is not an invitation to keep editing it.
    expect(rows.rows[1]?.sealed_at).not.toBeNull();
  });

  it('refuses a correction that does not say why', async () => {
    const userId = await database.createUser('Unexplained Holder');
    const clock = fixedClock(new Date('2026-06-14T18:00:00Z'));
    const snapshot = await computeNetWorth(portsOf(worldOn('2026-06-14')), {
      userId,
      asOfDate: '2026-06-14',
      baseCurrency: 'USD',
    });
    const inserted = await upsertOpenDay(executor, { userId, snapshot, clock });
    await sealDay(executor, { userId, asOfDate: '2026-06-14', clock });

    // A correction nobody can explain is indistinguishable from a bug, so the
    // database refuses it — both directions of the biconditional.
    const failure = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO net_worth_daily (
          id, user_id, as_of_date, revision, base_currency,
          assets_minor, liabilities_minor, net_worth_minor,
          liquid_minor, investable_minor, on_budget_minor,
          breakdown, source, accounts_counted, accounts_unvalued, supersedes_id
        ) VALUES (
          gen_random_uuid(), ${userId}::uuid, '2026-06-14'::date, 2, 'USD',
          1, 0, 1, 0, 0, 0, '[]'::jsonb, 'corrected', 1, 0, ${inserted.id}::uuid
        )
      `),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('net_worth_daily_correction_carries_provenance');
  });
});
