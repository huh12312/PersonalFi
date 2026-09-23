// SPDX-License-Identifier: MIT
/**
 * The hand computation, persisted and read back through SQL.
 *
 * `test/reconcile.test.ts` proves the *engine* agrees with the fixture. This
 * proves the **stored row** does — which is a different claim, and the one the
 * evidence document quotes. Between the two sit `JSON.stringify`, a JSONB cast,
 * six BIGINT columns and a `CHECK` that can reject the lot; a number that
 * reconciles in memory and arrives wrong in Postgres is exactly the class of bug
 * an in-memory test cannot see.
 *
 * Also here: the three sabotages of `net_worth_breakdown_is_well_formed`. That
 * function is migration 0017's structural statement of D4 and 07 §4.1 — a
 * breakdown entry must carry its `fxRate`/`fxRateDate` pair and all four
 * booleans, and its minor units must be JSON **strings**. A CHECK nobody has
 * ever seen reject anything is a CHECK nobody knows is wired up.
 */
import { fixedClock } from '@core/kernel';
import type { TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeNetWorth } from '../../src/net-worth.ts';
import { upsertOpenDay, type PlanningExecutor } from '../../src/store.ts';
import { portsOf, type FakeWorld } from '../fakes.ts';
import { NO_DATABASE, pgFailureOf, planningDatabase } from './harness.ts';
import fixture from '../fixtures/hand-computation.json' with { type: 'json' };

const world = fixture.world as unknown as FakeWorld;
const expected = fixture.expected;
const CLOCK = fixedClock(new Date('2026-06-15T18:00:00Z'));

/** A breakdown entry that satisfies the CHECK, for the sabotages to break. */
const WELL_FORMED = {
  accountId: 'a1000000-0000-4000-8000-000000000001',
  currency: 'USD',
  nativeMinor: '423517',
  baseMinor: '423517',
  fxRate: '1',
  fxRateDate: '2026-06-15',
  onBudget: true,
  inNetWorth: true,
  isLiquid: true,
  isInvestable: false,
};

describe.skipIf(NO_DATABASE)('the stored row, against Postgres', () => {
  let database: TestDatabase;
  let executor: PlanningExecutor;

  beforeAll(async () => {
    database = await planningDatabase('reconcile');
    executor = database.db;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  async function insertBreakdown(userId: string, breakdown: unknown): Promise<unknown> {
    return database.db.execute(sql`
      INSERT INTO net_worth_daily (
        id, user_id, as_of_date, revision, base_currency,
        assets_minor, liabilities_minor, net_worth_minor,
        liquid_minor, investable_minor, on_budget_minor,
        breakdown, source, accounts_counted, accounts_unvalued
      ) VALUES (
        gen_random_uuid(), ${userId}::uuid, '2026-06-15'::date, 1, 'USD',
        0, 0, 0, 0, 0, 0,
        ${JSON.stringify(breakdown)}::jsonb, 'observed', 1, 0
      )
    `);
  }

  it('the persisted row reconciles to the same hand computation, read back through SQL', async () => {
    const userId = database.userId;
    const snapshot = await computeNetWorth(portsOf(world), {
      userId,
      asOfDate: fixture.asOfDate,
      baseCurrency: fixture.baseCurrency,
    });
    await upsertOpenDay(executor, { userId, snapshot, clock: CLOCK });

    // Read back with a plain query — the shape a reporting caller would use —
    // rather than through the store, so the column values are what is asserted.
    const result = await database.db.execute<{
      assets_minor: bigint;
      liabilities_minor: bigint;
      net_worth_minor: bigint;
      liquid_minor: bigint;
      investable_minor: bigint;
      on_budget_minor: bigint;
      source: string;
      stale_price: boolean;
      accounts_counted: number;
      accounts_unvalued: number;
    }>(sql`
      SELECT assets_minor, liabilities_minor, net_worth_minor,
             liquid_minor, investable_minor, on_budget_minor,
             source, stale_price, accounts_counted, accounts_unvalued
        FROM net_worth_daily
       WHERE user_id = ${userId}::uuid AND as_of_date = ${fixture.asOfDate}::date
    `);

    const row = result.rows[0];
    expect(row, 'the day must exist').toBeDefined();
    expect(String(row?.assets_minor), expected.assetsWorkedByHand).toBe(expected.assetsMinor);
    expect(String(row?.liabilities_minor), expected.liabilitiesWorkedByHand).toBe(
      expected.liabilitiesMinor,
    );
    expect(String(row?.net_worth_minor), expected.netWorthWorkedByHand).toBe(
      expected.netWorthMinor,
    );
    expect(String(row?.liquid_minor), expected.liquidWorkedByHand).toBe(expected.liquidMinor);
    expect(String(row?.investable_minor), expected.investableWorkedByHand).toBe(
      expected.investableMinor,
    );
    expect(String(row?.on_budget_minor), expected.onBudgetWorkedByHand).toBe(
      expected.onBudgetMinor,
    );
    expect(row?.source).toBe(expected.source);
    expect(row?.stale_price).toBe(expected.stalePrice);
    expect(row?.accounts_counted).toBe(expected.accountsCounted);
    expect(row?.accounts_unvalued).toBe(expected.accountsUnvalued);
  });

  it('decomposes the stored breakdown back to the same totals in SQL alone', async () => {
    // The audit a reader will actually perform: sum the JSONB, compare to the
    // columns. If these ever disagree the totals cannot be traced to their
    // parts, which is the whole reason the breakdown is stored per account.
    const userId = database.userId;
    const result = await database.db.execute<{
      assets_from_breakdown: string;
      liabilities_from_breakdown: string;
      liquid_from_breakdown: string;
    }>(sql`
      SELECT
        sum((entry ->> 'baseMinor')::bigint)
          FILTER (WHERE (entry ->> 'inNetWorth')::boolean AND entry ->> 'side' = 'asset')
          ::text AS assets_from_breakdown,
        (-sum((entry ->> 'baseMinor')::bigint)
          FILTER (WHERE (entry ->> 'inNetWorth')::boolean AND entry ->> 'side' = 'liability'))
          ::text AS liabilities_from_breakdown,
        sum((entry ->> 'baseMinor')::bigint)
          FILTER (WHERE (entry ->> 'isLiquid')::boolean)
          ::text AS liquid_from_breakdown
      FROM net_worth_daily,
           LATERAL jsonb_array_elements(breakdown) AS entry
      WHERE user_id = ${userId}::uuid AND as_of_date = ${fixture.asOfDate}::date
    `);

    const row = result.rows[0];
    expect(row?.assets_from_breakdown).toBe(expected.assetsMinor);
    expect(row?.liabilities_from_breakdown).toBe(expected.liabilitiesMinor);
    expect(row?.liquid_from_breakdown).toBe(expected.liquidMinor);
  });

  it('refuses a row whose totals disagree with its own identity', async () => {
    // `net = assets - liabilities`, in the database rather than only in the
    // aggregate. A writer that summed the breakdown one way and the totals
    // another cannot persist the disagreement.
    const userId = await database.createUser('Identity Holder');
    const failure = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO net_worth_daily (
          id, user_id, as_of_date, revision, base_currency,
          assets_minor, liabilities_minor, net_worth_minor,
          liquid_minor, investable_minor, on_budget_minor,
          breakdown, source, accounts_counted, accounts_unvalued
        ) VALUES (
          gen_random_uuid(), ${userId}::uuid, '2026-06-15'::date, 1, 'USD',
          100, 40, 999, 0, 0, 0,
          ${JSON.stringify([WELL_FORMED])}::jsonb, 'observed', 1, 0
        )
      `),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('net_worth_daily_net_is_assets_minus_liabilities');
  });

  describe('net_worth_breakdown_is_well_formed', () => {
    it('accepts the shape the engine actually produces', async () => {
      const userId = await database.createUser('Well Formed Holder');
      await expect(insertBreakdown(userId, [WELL_FORMED])).resolves.toBeDefined();
    });

    it('SABOTAGE: drops fxRateDate, and the CHECK refuses the row', async () => {
      // D4 wants the rate *and* the date it was observed. A rate with no date is
      // a rate nobody can check, which is the same as no rate at all.
      const userId = await database.createUser('No Date Holder');
      const { fxRateDate: _dropped, ...withoutDate } = WELL_FORMED;
      const failure = await pgFailureOf(insertBreakdown(userId, [withoutDate]));
      expect(failure.code).toBe('23514');
      expect(failure.constraint).toBe('net_worth_daily_breakdown_is_well_formed');
    });

    it('SABOTAGE: stores the minor units as JSON numbers, and the CHECK refuses the row', async () => {
      // D3 at the serialisation boundary. A JSON number silently rounds a
      // BIGINT past 2^53, and this is the one place the amount leaves its
      // BIGINT column.
      const userId = await database.createUser('Number Holder');
      const failure = await pgFailureOf(
        insertBreakdown(userId, [{ ...WELL_FORMED, nativeMinor: 423517, baseMinor: 423517 }]),
      );
      expect(failure.code).toBe('23514');
      expect(failure.constraint).toBe('net_worth_daily_breakdown_is_well_formed');
    });

    it('SABOTAGE: omits one of the four booleans, and the CHECK refuses the row', async () => {
      // 07 §4.1's four are required *individually*. A missing flag would let a
      // denominator be guessed at read time, which is the conflation the
      // section warns about.
      const userId = await database.createUser('Three Booleans Holder');
      for (const flag of ['onBudget', 'inNetWorth', 'isLiquid', 'isInvestable'] as const) {
        const entry: Record<string, unknown> = { ...WELL_FORMED };
        delete entry[flag];
        const holder = await database.createUser(`Missing ${flag}`);
        const failure = await pgFailureOf(insertBreakdown(holder, [entry]));
        expect(failure.constraint, `omitting ${flag} must be refused`).toBe(
          'net_worth_daily_breakdown_is_well_formed',
        );
      }
      expect(userId).toBeDefined();
    });

    it('accepts an empty breakdown, which is a real state and not a malformed one', async () => {
      // An install with no accounts yet. The day is genuinely empty; refusing it
      // would make "no accounts" indistinguishable from "a bug in the writer".
      const userId = await database.createUser('Empty Holder');
      await expect(insertBreakdown(userId, [])).resolves.toBeDefined();
    });

    it('refuses a breakdown that is not an array at all', async () => {
      const userId = await database.createUser('Object Holder');
      const failure = await pgFailureOf(insertBreakdown(userId, WELL_FORMED));
      expect(failure.constraint).toBe('net_worth_daily_breakdown_is_well_formed');
    });
  });
});
